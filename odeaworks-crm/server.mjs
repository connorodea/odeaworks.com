import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = 3120;

// Internal webhook secret — contact-api sends this header to authenticate
// Set via environment variable; also allow callers that don't set it (LAN only)
const WEBHOOK_SECRET = process.env.CRM_WEBHOOK_SECRET || '';

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
const AUTH_USERNAME = 'admin';
const AUTH_PASSWORD_HASH = crypto.createHash('sha256').update('Sparky1822480!!').digest('hex');

// In-memory session store: Map<token, expiresAt>
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidSession(token) {
  if (!token || !sessions.has(token)) return false;
  const expiry = sessions.get(token);
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

// Clean up expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}, 10 * 60 * 1000);

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = {};
  cookieHeader.split(';').forEach(pair => {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  });
  return cookies;
}

function getSessionToken(req) {
  const cookies = parseCookies(req);
  return cookies.crm_session || null;
}

// ---------------------------------------------------------------------------
// SQLite setup via better-sqlite3 (CommonJS module, loaded via require)
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DB_PATH = process.env.CRM_DB_PATH || path.join(__dirname, 'data', 'crm.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL DEFAULT 'contact',
    status      TEXT NOT NULL DEFAULT 'new',
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    company     TEXT,
    source      TEXT,
    budget      TEXT,
    project_type TEXT,
    message     TEXT,
    -- booking-specific fields
    date        TEXT,
    time_slot   TEXT,
    -- subscribe-specific fields
    subscribed_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_type   ON leads(type);
  CREATE INDEX IF NOT EXISTS idx_leads_email  ON leads(email);
  CREATE INDEX IF NOT EXISTS idx_notes_lead   ON notes(lead_id);
`);

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------
const stmts = {
  insertLead: db.prepare(`
    INSERT INTO leads (type, status, name, email, company, source, budget, project_type, message, date, time_slot, subscribed_at)
    VALUES (@type, @status, @name, @email, @company, @source, @budget, @project_type, @message, @date, @time_slot, @subscribed_at)
  `),
  listLeads: db.prepare(`
    SELECT l.*,
           (SELECT COUNT(*) FROM notes n WHERE n.lead_id = l.id) AS note_count
    FROM leads l
    ORDER BY l.created_at DESC
  `),
  listLeadsFiltered: db.prepare(`
    SELECT l.*,
           (SELECT COUNT(*) FROM notes n WHERE n.lead_id = l.id) AS note_count
    FROM leads l
    WHERE (@status IS NULL OR l.status = @status)
      AND (@type IS NULL OR l.type = @type)
    ORDER BY l.created_at DESC
    LIMIT @limit OFFSET @offset
  `),
  countLeads: db.prepare(`
    SELECT COUNT(*) AS total FROM leads
    WHERE (@status IS NULL OR status = @status)
      AND (@type IS NULL OR type = @type)
  `),
  getLead: db.prepare(`SELECT * FROM leads WHERE id = ?`),
  updateLead: db.prepare(`
    UPDATE leads SET status = @status, updated_at = datetime('now') WHERE id = @id
  `),
  deleteLead: db.prepare(`DELETE FROM leads WHERE id = ?`),
  getNotes: db.prepare(`SELECT * FROM notes WHERE lead_id = ? ORDER BY created_at ASC`),
  insertNote: db.prepare(`INSERT INTO notes (lead_id, body) VALUES (?, ?)`),
  deleteNote: db.prepare(`DELETE FROM notes WHERE id = ? AND lead_id = ?`),
  stats: db.prepare(`
    SELECT
      COUNT(*)                                                     AS total,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END)             AS new_count,
      SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END)       AS contacted_count,
      SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END)       AS qualified_count,
      SUM(CASE WHEN status = 'proposal' THEN 1 ELSE 0 END)        AS proposal_count,
      SUM(CASE WHEN status = 'closed-won' THEN 1 ELSE 0 END)      AS won_count,
      SUM(CASE WHEN status = 'closed-lost' THEN 1 ELSE 0 END)     AS lost_count,
      SUM(CASE WHEN type = 'contact' THEN 1 ELSE 0 END)           AS contact_form_count,
      SUM(CASE WHEN type = 'booking' THEN 1 ELSE 0 END)           AS booking_count,
      SUM(CASE WHEN type = 'subscribe' THEN 1 ELSE 0 END)         AS subscribe_count,
      SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS this_week,
      SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS this_month
    FROM leads
  `),
};

// ---------------------------------------------------------------------------
// Valid statuses
// ---------------------------------------------------------------------------
const VALID_STATUSES = new Set([
  'new', 'contacted', 'qualified', 'proposal', 'closed-won', 'closed-lost',
]);

const VALID_TYPES = new Set(['contact', 'booking', 'subscribe']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes = 64_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) reject(new Error('Payload too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseQueryString(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}

// Validate webhook secret header when configured
function validateWebhookSecret(req) {
  if (!WEBHOOK_SECRET) return true; // no secret configured — accept all
  const provided = req.headers['x-crm-secret'] || '';
  return provided === WEBHOOK_SECRET;
}

// ---------------------------------------------------------------------------
// Login page HTML
// ---------------------------------------------------------------------------
function getLoginHtml(showError = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Odea Works CRM</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #000;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-container {
      width: 100%;
      max-width: 400px;
      padding: 0 24px;
    }
    .login-logo {
      text-align: center;
      margin-bottom: 48px;
    }
    .login-logo img {
      height: 24px;
      opacity: 0.8;
    }
    .login-title {
      font-size: 24px;
      font-weight: 600;
      text-align: center;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }
    .login-subtitle {
      font-size: 14px;
      color: #666;
      text-align: center;
      margin-bottom: 40px;
    }
    .form-group {
      margin-bottom: 24px;
    }
    .form-group label {
      display: block;
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    .form-group input {
      width: 100%;
      background: transparent;
      border: none;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      color: #fff;
      font-size: 16px;
      padding: 12px 0;
      outline: none;
      transition: border-color 0.2s;
    }
    .form-group input:focus {
      border-bottom-color: rgba(255,255,255,0.3);
    }
    .form-group input::placeholder {
      color: #444;
    }
    .login-btn {
      width: 100%;
      background: #fff;
      color: #000;
      border: none;
      border-radius: 9999px;
      padding: 14px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.2s;
      margin-top: 16px;
    }
    .login-btn:hover {
      opacity: 0.9;
    }
    .error-msg {
      color: #f85149;
      font-size: 13px;
      text-align: center;
      margin-bottom: 20px;
      display: none;
    }
    .error-msg.visible {
      display: block;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-logo">
      <img src="https://odeaworks.com/logos/ODeaWorks-v4-white-cropped.png" alt="Odea Works">
    </div>
    <h1 class="login-title">CRM</h1>
    <p class="login-subtitle">Sign in to manage leads</p>
    <div id="error" class="error-msg${showError ? ' visible' : ''}">Invalid credentials</div>
    <form method="POST" action="/login">
      <div class="form-group">
        <label>Username</label>
        <input type="text" name="username" placeholder="admin" required autofocus>
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" name="password" placeholder="\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022" required>
      </div>
      <button type="submit" class="login-btn">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------
async function router(req, res) {
  const urlPath = req.url.split('?')[0];
  const method = req.method;

  // Health check (no auth required)
  if (method === 'GET' && urlPath === '/health') {
    return jsonResponse(res, 200, { ok: true, ts: new Date().toISOString() });
  }

  // --- Login/Logout routes (no session required) ---

  // GET /login — serve login page
  if (method === 'GET' && urlPath === '/login') {
    const qs = parseQueryString(req.url);
    const html = getLoginHtml(qs.error === '1');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    return res.end(html);
  }

  // POST /login — validate credentials
  if (method === 'POST' && urlPath === '/login') {
    let raw;
    try { raw = await readBody(req); } catch { return jsonResponse(res, 413, { error: 'Payload too large' }); }

    const params = new URLSearchParams(raw);
    const username = (params.get('username') || '').trim();
    const password = params.get('password') || '';
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

    if (username === AUTH_USERNAME && passwordHash === AUTH_PASSWORD_HASH) {
      const token = createSession();
      res.writeHead(302, {
        'Location': '/',
        'Set-Cookie': `crm_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
      });
      return res.end();
    }

    // Invalid credentials — redirect back with error
    res.writeHead(302, { 'Location': '/login?error=1' });
    return res.end();
  }

  // GET /logout — destroy session
  if (method === 'GET' && urlPath === '/logout') {
    const token = getSessionToken(req);
    destroySession(token);
    res.writeHead(302, {
      'Location': '/login',
      'Set-Cookie': 'crm_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
    });
    return res.end();
  }

  // --- Webhook endpoint (uses X-Crm-Secret, not session auth) ---
  if (method === 'POST' && urlPath === '/api/leads') {
    if (!validateWebhookSecret(req)) {
      return jsonResponse(res, 401, { error: 'Unauthorized' });
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return jsonResponse(res, 413, { error: 'Payload too large' });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON' });
    }

    const { type } = data;
    if (!type || !VALID_TYPES.has(type)) {
      return jsonResponse(res, 400, { error: 'type must be one of: contact, booking, subscribe' });
    }
    if (!data.name && !data.email) {
      return jsonResponse(res, 400, { error: 'name and email are required' });
    }

    const lead = {
      type,
      status: 'new',
      name:         (data.name || '').trim() || 'Unknown',
      email:        (data.email || '').trim().toLowerCase(),
      company:      (data.company || '').trim() || null,
      source:       (data.source || '').trim() || null,
      budget:       (data.budget || '').trim() || null,
      project_type: (data.projectType || data.project_type || '').trim() || null,
      message:      (data.message || data.project || '').trim() || null,
      date:         (data.date || '').trim() || null,
      time_slot:    (data.timeSlot || data.time_slot || '').trim() || null,
      subscribed_at: type === 'subscribe' ? new Date().toISOString() : null,
    };

    const result = stmts.insertLead.run(lead);
    const created = stmts.getLead.get(result.lastInsertRowid);
    console.log(`[${new Date().toISOString()}] Lead created: id=${created.id} type=${type} email=${lead.email}`);
    return jsonResponse(res, 201, created);
  }

  // --- All remaining routes require a valid session ---
  const sessionToken = getSessionToken(req);
  if (!isValidSession(sessionToken)) {
    // For API requests, return 401 JSON; for HTML, redirect to login
    if (urlPath.startsWith('/api/')) {
      return jsonResponse(res, 401, { error: 'Unauthorized — please log in' });
    }
    res.writeHead(302, { 'Location': '/login' });
    return res.end();
  }

  // Stats
  if (method === 'GET' && urlPath === '/api/stats') {
    const row = stmts.stats.get();
    return jsonResponse(res, 200, row);
  }

  // List leads — GET /api/leads[?status=&type=&limit=&offset=]
  if (method === 'GET' && urlPath === '/api/leads') {
    const qs = parseQueryString(req.url);
    const status = VALID_STATUSES.has(qs.status) ? qs.status : null;
    const type   = VALID_TYPES.has(qs.type) ? qs.type : null;
    const limit  = Math.min(parseInt(qs.limit, 10) || 100, 500);
    const offset = parseInt(qs.offset, 10) || 0;

    const rows  = stmts.listLeadsFiltered.all({ status, type, limit, offset });
    const count = stmts.countLeads.get({ status, type });
    return jsonResponse(res, 200, { leads: rows, total: count.total, limit, offset });
  }

  // Get single lead — GET /api/leads/:id
  const leadDetailMatch = urlPath.match(/^\/api\/leads\/(\d+)$/);
  if (leadDetailMatch) {
    const id = parseInt(leadDetailMatch[1], 10);

    if (method === 'GET') {
      const lead = stmts.getLead.get(id);
      if (!lead) return jsonResponse(res, 404, { error: 'Lead not found' });
      const notes = stmts.getNotes.all(id);
      return jsonResponse(res, 200, { ...lead, notes });
    }

    // Update lead status — PATCH /api/leads/:id
    if (method === 'PATCH') {
      const lead = stmts.getLead.get(id);
      if (!lead) return jsonResponse(res, 404, { error: 'Lead not found' });

      let raw;
      try { raw = await readBody(req); } catch { return jsonResponse(res, 413, { error: 'Payload too large' }); }
      let data;
      try { data = JSON.parse(raw); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON' }); }

      if (data.status !== undefined) {
        if (!VALID_STATUSES.has(data.status)) {
          return jsonResponse(res, 400, { error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(', ')}` });
        }
        stmts.updateLead.run({ id, status: data.status });
      }

      const updated = stmts.getLead.get(id);
      const notes = stmts.getNotes.all(id);
      return jsonResponse(res, 200, { ...updated, notes });
    }

    // Delete lead — DELETE /api/leads/:id
    if (method === 'DELETE') {
      const lead = stmts.getLead.get(id);
      if (!lead) return jsonResponse(res, 404, { error: 'Lead not found' });
      stmts.deleteLead.run(id);
      console.log(`[${new Date().toISOString()}] Lead deleted: id=${id}`);
      return jsonResponse(res, 200, { ok: true });
    }
  }

  // Notes — POST /api/leads/:id/notes
  const notesMatch = urlPath.match(/^\/api\/leads\/(\d+)\/notes$/);
  if (notesMatch && method === 'POST') {
    const leadId = parseInt(notesMatch[1], 10);
    const lead = stmts.getLead.get(leadId);
    if (!lead) return jsonResponse(res, 404, { error: 'Lead not found' });

    let raw;
    try { raw = await readBody(req); } catch { return jsonResponse(res, 413, { error: 'Payload too large' }); }
    let data;
    try { data = JSON.parse(raw); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON' }); }

    const body = (data.body || '').trim();
    if (!body) return jsonResponse(res, 400, { error: 'Note body is required' });

    const result = stmts.insertNote.run(leadId, body);
    const notes = stmts.getNotes.all(leadId);
    return jsonResponse(res, 201, { id: result.lastInsertRowid, lead_id: leadId, body, notes });
  }

  // Delete note — DELETE /api/leads/:id/notes/:noteId
  const noteDeleteMatch = urlPath.match(/^\/api\/leads\/(\d+)\/notes\/(\d+)$/);
  if (noteDeleteMatch && method === 'DELETE') {
    const leadId  = parseInt(noteDeleteMatch[1], 10);
    const noteId  = parseInt(noteDeleteMatch[2], 10);
    stmts.deleteNote.run(noteId, leadId);
    return jsonResponse(res, 200, { ok: true });
  }

  // Dashboard HTML — GET /
  if (method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    const html = getDashboardHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    return res.end(html);
  }

  return jsonResponse(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// Dashboard HTML — single-file SPA, no build step
// ---------------------------------------------------------------------------
function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ODeaWorks CRM</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #000000;
    --surface: #0a0a0a;
    --surface2: #111111;
    --surface3: #161616;
    --border: rgba(255,255,255,0.06);
    --border2: rgba(255,255,255,0.10);
    --border3: rgba(255,255,255,0.15);
    --text: #f0f0f0;
    --text-secondary: #a0a0a0;
    --muted: #666666;
    --dim: #444444;
    --accent: #10a37f;
    --accent-hover: #0d8a6a;
    --accent-bg: rgba(16,163,127,0.08);
    --accent-border: rgba(16,163,127,0.2);
    --red: #ef4444;
    --red-bg: rgba(239,68,68,0.08);
    --red-border: rgba(239,68,68,0.2);
    --yellow: #eab308;
    --yellow-bg: rgba(234,179,8,0.08);
    --yellow-border: rgba(234,179,8,0.2);
    --blue: #3b82f6;
    --blue-bg: rgba(59,130,246,0.08);
    --blue-border: rgba(59,130,246,0.2);
    --purple: #8b5cf6;
    --purple-bg: rgba(139,92,246,0.08);
    --purple-border: rgba(139,92,246,0.2);
    --cyan: #06b6d4;
    --cyan-bg: rgba(6,182,212,0.08);
    --cyan-border: rgba(6,182,212,0.2);
    --orange: #f97316;
    --orange-bg: rgba(249,115,22,0.08);
    --orange-border: rgba(249,115,22,0.2);
    --gray-badge: #71717a;
    --gray-badge-bg: rgba(113,113,122,0.08);
    --gray-badge-border: rgba(113,113,122,0.2);
    --radius: 8px;
    --radius-lg: 12px;
    --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
    --shadow-lg: 0 8px 32px rgba(0,0,0,0.5);
    --transition: 0.15s ease;
  }

  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button { cursor: pointer; font-family: var(--font); }
  ::selection { background: var(--accent); color: #fff; }

  /* ── Layout ── */
  .app { display: flex; flex-direction: column; min-height: 100vh; }

  /* ── Header ── */
  .header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 0 32px;
    height: 56px;
    display: flex;
    align-items: center;
    gap: 16px;
    position: sticky;
    top: 0;
    z-index: 50;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
  .header-logo {
    display: flex;
    align-items: center;
    gap: 12px;
    text-decoration: none;
  }
  .header-logo:hover { text-decoration: none; }
  .header-logo img { height: 20px; opacity: 0.9; }
  .header-divider {
    width: 1px;
    height: 20px;
    background: var(--border2);
  }
  .header-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .header-spacer { flex: 1; }
  .header-status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .header-status .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse-dot 2s ease-in-out infinite;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .signout-link {
    color: var(--muted);
    font-size: 13px;
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    transition: all var(--transition);
    text-decoration: none;
  }
  .signout-link:hover {
    color: var(--text);
    border-color: var(--border2);
    text-decoration: none;
  }

  .main { flex: 1; padding: 32px; max-width: 1440px; margin: 0 auto; width: 100%; }

  /* ── Stats Cards ── */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 16px;
    margin-bottom: 32px;
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 24px;
    transition: border-color var(--transition);
    position: relative;
    overflow: hidden;
  }
  .stat-card:hover {
    border-color: var(--border2);
  }
  .stat-card .stat-icon {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    margin-bottom: 16px;
  }
  .stat-card .stat-value {
    font-size: 32px;
    font-weight: 800;
    line-height: 1;
    margin-bottom: 6px;
    letter-spacing: -0.02em;
  }
  .stat-card .stat-label {
    font-size: 12px;
    color: var(--muted);
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .stat-card .stat-delta {
    position: absolute;
    top: 24px;
    right: 24px;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 20px;
  }
  .stat-delta.up { color: var(--accent); background: var(--accent-bg); }
  .stat-delta.down { color: var(--red); background: var(--red-bg); }
  .stat-delta.neutral { color: var(--muted); background: rgba(255,255,255,0.04); }

  .stat-icon.green { background: var(--accent-bg); color: var(--accent); }
  .stat-icon.blue { background: var(--blue-bg); color: var(--blue); }
  .stat-icon.purple { background: var(--purple-bg); color: var(--purple); }
  .stat-icon.yellow { background: var(--yellow-bg); color: var(--yellow); }
  .stat-icon.cyan { background: var(--cyan-bg); color: var(--cyan); }

  .stat-value.green { color: var(--accent); }
  .stat-value.blue { color: var(--blue); }
  .stat-value.yellow { color: var(--yellow); }
  .stat-value.purple { color: var(--purple); }

  /* ── View Toggle + Toolbar ── */
  .toolbar-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-bottom: 20px;
  }
  .toolbar-top {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .view-tabs {
    display: flex;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .view-tab {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 13px;
    font-weight: 500;
    padding: 8px 20px;
    transition: all var(--transition);
    position: relative;
  }
  .view-tab:hover { color: var(--text); }
  .view-tab.active {
    background: var(--accent);
    color: #fff;
  }
  .view-tab + .view-tab {
    border-left: 1px solid var(--border);
  }

  .toolbar-spacer { flex: 1; }

  .search-input {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 8px 14px 8px 36px;
    border-radius: var(--radius);
    font-size: 13px;
    font-family: var(--font);
    outline: none;
    width: 260px;
    transition: border-color var(--transition);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%23666' viewBox='0 0 16 16'%3E%3Cpath d='M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: 12px center;
  }
  .search-input:focus { border-color: var(--accent); }
  .search-input::placeholder { color: var(--dim); }

  .refresh-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 8px 16px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all var(--transition);
  }
  .refresh-btn:hover { color: var(--text); border-color: var(--border2); }
  .refresh-btn svg { width: 14px; height: 14px; }

  .toolbar-bottom {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .filter-group {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .filter-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 5px 14px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 500;
    transition: all var(--transition);
    white-space: nowrap;
  }
  .filter-btn:hover { border-color: var(--border2); color: var(--text-secondary); }
  .filter-btn.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  .filter-separator {
    width: 1px;
    height: 24px;
    background: var(--border);
    margin: 0 8px;
  }

  /* ── Table View ── */
  .view-table { display: block; }
  .view-board { display: none; }
  .view-board.active { display: block; }
  .view-table.active { display: block; }

  .leads-table-wrap {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 800px; }
  th {
    background: var(--surface2);
    padding: 14px 18px;
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td {
    padding: 16px 18px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  tr:last-child td { border-bottom: none; }
  tr.lead-row {
    cursor: pointer;
    transition: background var(--transition);
    position: relative;
  }
  tr.lead-row:hover { background: var(--surface2); }

  .name-cell {
    font-weight: 600;
    color: var(--text);
    font-size: 14px;
    margin-bottom: 2px;
  }
  .email-cell {
    color: var(--muted);
    font-size: 12px;
  }
  .source-cell {
    color: var(--text-secondary);
    font-size: 12px;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .date-cell {
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .notes-cell { color: var(--muted); font-size: 12px; }

  /* Quick Actions on table rows */
  .row-actions {
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity var(--transition);
  }
  tr.lead-row:hover .row-actions { opacity: 1; }
  .row-action-btn {
    background: var(--surface3);
    border: 1px solid var(--border);
    color: var(--muted);
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    transition: all var(--transition);
    cursor: pointer;
    position: relative;
  }
  .row-action-btn:hover {
    color: var(--text);
    border-color: var(--border2);
    background: var(--surface2);
  }
  .row-action-btn .tooltip {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--surface3);
    color: var(--text);
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 4px;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity var(--transition);
    border: 1px solid var(--border2);
  }
  .row-action-btn:hover .tooltip { opacity: 1; }
  .copy-toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%) translateY(20px);
    background: var(--accent);
    color: #fff;
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    opacity: 0;
    transition: all 0.3s ease;
    z-index: 1000;
    pointer-events: none;
  }
  .copy-toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  /* Inline status dropdown on table row */
  .inline-status-dropdown {
    position: absolute;
    top: 100%;
    right: 18px;
    background: var(--surface2);
    border: 1px solid var(--border2);
    border-radius: var(--radius);
    padding: 4px;
    z-index: 60;
    box-shadow: var(--shadow-lg);
    display: none;
    min-width: 140px;
  }
  .inline-status-dropdown.open { display: block; }
  .inline-status-option {
    display: block;
    width: 100%;
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 500;
    padding: 8px 12px;
    text-align: left;
    border-radius: 4px;
    transition: background var(--transition);
    cursor: pointer;
  }
  .inline-status-option:hover { background: var(--surface3); color: var(--text); }
  .inline-status-option.current { color: var(--accent); }

  /* ── Badges ── */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    letter-spacing: 0.02em;
  }
  .badge-new       { background: var(--accent-bg); color: var(--accent); border: 1px solid var(--accent-border); }
  .badge-contacted { background: var(--blue-bg); color: var(--blue); border: 1px solid var(--blue-border); }
  .badge-qualified { background: var(--yellow-bg); color: var(--yellow); border: 1px solid var(--yellow-border); }
  .badge-proposal  { background: var(--purple-bg); color: var(--purple); border: 1px solid var(--purple-border); }
  .badge-won       { background: var(--accent-bg); color: #00d68f; border: 1px solid rgba(0,214,143,0.2); }
  .badge-lost      { background: var(--red-bg); color: var(--red); border: 1px solid var(--red-border); }

  .type-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .type-contact   { background: var(--blue-bg); color: var(--blue); }
  .type-booking   { background: var(--purple-bg); color: var(--purple); }
  .type-subscribe { background: var(--accent-bg); color: var(--accent); }

  /* Source badges */
  .source-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
  }
  .source-blue    { background: var(--blue-bg); color: var(--blue); border: 1px solid var(--blue-border); }
  .source-purple  { background: var(--purple-bg); color: var(--purple); border: 1px solid var(--purple-border); }
  .source-green   { background: var(--accent-bg); color: var(--accent); border: 1px solid var(--accent-border); }
  .source-orange  { background: var(--orange-bg); color: var(--orange); border: 1px solid var(--orange-border); }
  .source-cyan    { background: var(--cyan-bg); color: var(--cyan); border: 1px solid var(--cyan-border); }
  .source-gray    { background: var(--gray-badge-bg); color: var(--gray-badge); border: 1px solid var(--gray-badge-border); }

  /* ── Empty state ── */
  .empty-state {
    padding: 80px 32px;
    text-align: center;
    color: var(--muted);
  }
  .empty-state-icon {
    font-size: 48px;
    margin-bottom: 20px;
    opacity: 0.3;
  }
  .empty-state h3 {
    margin: 0 0 10px;
    font-size: 18px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .empty-state p {
    margin: 0;
    font-size: 14px;
    max-width: 400px;
    margin: 0 auto;
    line-height: 1.6;
  }

  /* ── Kanban Board ── */
  .kanban-board {
    display: flex;
    gap: 16px;
    overflow-x: auto;
    padding-bottom: 16px;
    -webkit-overflow-scrolling: touch;
  }
  .kanban-board::-webkit-scrollbar { height: 6px; }
  .kanban-board::-webkit-scrollbar-track { background: transparent; }
  .kanban-board::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }

  .kanban-column {
    min-width: 280px;
    width: 280px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 320px);
  }
  .kanban-column-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    border-bottom: 2px solid var(--border);
  }
  .kanban-column-header .col-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .kanban-column-header .col-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    flex: 1;
  }
  .kanban-column-header .col-count {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    background: var(--surface3);
    padding: 2px 8px;
    border-radius: 10px;
  }
  .col-dot.green { background: var(--accent); }
  .col-dot.blue { background: var(--blue); }
  .col-dot.yellow { background: var(--yellow); }
  .col-dot.purple { background: var(--purple); }
  .col-dot.emerald { background: #00d68f; }
  .col-dot.red { background: var(--red); }

  .kanban-column-body {
    flex: 1;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 var(--radius-lg) var(--radius-lg);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .kanban-column-body::-webkit-scrollbar { width: 4px; }
  .kanban-column-body::-webkit-scrollbar-track { background: transparent; }
  .kanban-column-body::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

  .kanban-card {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px;
    cursor: pointer;
    transition: all var(--transition);
  }
  .kanban-card:hover {
    border-color: var(--border2);
    background: var(--surface3);
    transform: translateY(-1px);
    box-shadow: var(--shadow-sm);
  }
  .kanban-card-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 4px;
    line-height: 1.3;
  }
  .kanban-card-company {
    font-size: 12px;
    color: var(--text-secondary);
    margin-bottom: 8px;
  }
  .kanban-card-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .kanban-card-date {
    font-size: 11px;
    color: var(--muted);
  }
  .kanban-card-status-select {
    background: var(--surface3);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 11px;
    font-family: var(--font);
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    outline: none;
    transition: border-color var(--transition);
    -webkit-appearance: none;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%23666' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
    padding-right: 20px;
  }
  .kanban-card-status-select:hover { border-color: var(--border2); }
  .kanban-card-status-select:focus { border-color: var(--accent); }

  .kanban-empty {
    text-align: center;
    padding: 24px 12px;
    font-size: 12px;
    color: var(--dim);
  }

  /* ── Modal / Detail Panel ── */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    z-index: 100;
    animation: fadeIn 0.15s ease;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .modal-overlay.hidden { display: none; }

  .modal-panel {
    background: var(--surface);
    border-left: 1px solid var(--border);
    width: 520px;
    max-width: 100vw;
    height: 100vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    animation: slideIn 0.2s ease;
  }
  @keyframes slideIn { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

  .modal-panel::-webkit-scrollbar { width: 4px; }
  .modal-panel::-webkit-scrollbar-track { background: transparent; }
  .modal-panel::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

  .modal-header {
    padding: 24px 28px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    gap: 16px;
  }
  .modal-header-info { flex: 1; min-width: 0; }
  .modal-header-info h2 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
  }
  .modal-header-info .email-link {
    font-size: 13px;
    color: var(--accent);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .modal-close {
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--muted);
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    transition: all var(--transition);
  }
  .modal-close:hover {
    color: var(--text);
    border-color: var(--border2);
  }

  .modal-body {
    padding: 24px 28px;
    flex: 1;
  }
  .modal-section {
    margin-bottom: 28px;
  }
  .modal-section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--muted);
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .modal-section-title::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .field-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .field-item label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--dim);
    margin-bottom: 4px;
  }
  .field-item .val {
    font-size: 14px;
    color: var(--text);
    word-break: break-word;
  }
  .field-item .val.empty {
    color: var(--dim);
    font-style: italic;
    font-size: 13px;
  }
  .field-item.full { grid-column: 1 / -1; }

  /* Status selector pills */
  .status-selector {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 12px;
  }
  .status-btn {
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 500;
    transition: all var(--transition);
    text-transform: capitalize;
  }
  .status-btn:hover { border-color: var(--border2); color: var(--text-secondary); }
  .status-btn.active { font-weight: 600; }
  .status-btn[data-status="new"].active       { background: var(--accent-bg); color: var(--accent); border-color: var(--accent); }
  .status-btn[data-status="contacted"].active { background: var(--blue-bg); color: var(--blue); border-color: var(--blue); }
  .status-btn[data-status="qualified"].active { background: var(--yellow-bg); color: var(--yellow); border-color: var(--yellow); }
  .status-btn[data-status="proposal"].active  { background: var(--purple-bg); color: var(--purple); border-color: var(--purple); }
  .status-btn[data-status="closed-won"].active  { background: rgba(0,214,143,0.08); color: #00d68f; border-color: #00d68f; }
  .status-btn[data-status="closed-lost"].active { background: var(--red-bg); color: var(--red); border-color: var(--red); }

  /* Send email button */
  .send-email-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    padding: 8px 16px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    transition: all var(--transition);
    text-decoration: none;
    margin-top: 12px;
  }
  .send-email-btn:hover {
    color: var(--text);
    border-color: var(--accent);
    text-decoration: none;
  }

  /* Message block */
  .message-block {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    margin-top: 12px;
    font-size: 14px;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.7;
  }

  /* Notes */
  .notes-list {
    list-style: none;
    margin: 0 0 16px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .note-item {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    position: relative;
    transition: border-color var(--transition);
  }
  .note-item:hover { border-color: var(--border2); }
  .note-item .note-body {
    font-size: 14px;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 8px;
    line-height: 1.6;
  }
  .note-item .note-meta {
    font-size: 11px;
    color: var(--dim);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .note-delete {
    background: none;
    border: none;
    color: var(--dim);
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
    transition: all var(--transition);
  }
  .note-delete:hover { color: var(--red); background: var(--red-bg); }

  .note-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .note-textarea {
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--radius);
    padding: 12px 14px;
    font-family: var(--font);
    font-size: 14px;
    resize: vertical;
    min-height: 90px;
    outline: none;
    transition: border-color var(--transition);
    line-height: 1.6;
  }
  .note-textarea:focus { border-color: var(--accent); }
  .note-textarea::placeholder { color: var(--dim); }

  .btn-primary {
    background: var(--accent);
    border: none;
    color: #fff;
    padding: 10px 20px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
    align-self: flex-start;
    transition: all var(--transition);
  }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .delete-lead-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--dim);
    padding: 10px 16px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    width: 100%;
    margin-top: 8px;
    transition: all var(--transition);
  }
  .delete-lead-btn:hover { border-color: var(--red); color: var(--red); }

  /* Spinner */
  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Pagination */
  .pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-top: 1px solid var(--border);
  }
  .page-info { font-size: 13px; color: var(--muted); }
  .page-btns { display: flex; gap: 8px; }
  .page-btn {
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    transition: all var(--transition);
  }
  .page-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .page-btn:not(:disabled):hover { color: var(--text); border-color: var(--border2); }

  /* ── Loading indicator ── */
  #loading-indicator {
    display: none;
  }

  /* ── Responsive ── */
  @media (max-width: 1100px) {
    .stats-grid { grid-template-columns: repeat(3, 1fr); }
  }
  @media (max-width: 768px) {
    .header { padding: 0 16px; }
    .main { padding: 16px; }
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .stat-card { padding: 16px; }
    .stat-card .stat-value { font-size: 24px; }
    .modal-panel { width: 100vw; }
    .field-grid { grid-template-columns: 1fr; }
    .toolbar-top { flex-wrap: wrap; }
    .search-input { width: 100%; order: 10; }
    .kanban-column { min-width: 260px; width: 260px; }
    .toolbar-bottom { overflow-x: auto; flex-wrap: nowrap; padding-bottom: 4px; }
    .filter-group { flex-wrap: nowrap; }
    tr.lead-row .row-actions { opacity: 1; }
  }
  @media (max-width: 480px) {
    .stats-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
    .header-label { display: none; }
    .header-divider { display: none; }
  }
</style>
</head>
<body>
<div class="app">
  <!-- Header -->
  <header class="header">
    <a href="https://odeaworks.com" class="header-logo" target="_blank">
      <img src="https://odeaworks.com/logos/ODeaWorks-v4-white-cropped.png" alt="ODeaWorks">
    </a>
    <div class="header-divider"></div>
    <span class="header-label">CRM</span>
    <div class="header-spacer"></div>
    <div class="header-status">
      <span class="dot"></span>
      <span>Live</span>
    </div>
    <span id="loading-indicator"><span class="spinner" style="width:14px;height:14px;border-width:1.5px"></span></span>
    <a href="/logout" class="signout-link">Sign out</a>
  </header>

  <div class="main">
    <!-- Stats Cards -->
    <div class="stats-grid" id="stats-grid">
      <div class="stat-card">
        <div class="stat-icon green">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </div>
        <div class="stat-value" id="stat-total">--</div>
        <div class="stat-label">Total Leads</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon blue">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
        </div>
        <div class="stat-value blue" id="stat-week">--</div>
        <div class="stat-label">New This Week</div>
        <div class="stat-delta neutral" id="stat-week-delta"></div>
      </div>
      <div class="stat-card">
        <div class="stat-icon purple">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="stat-value purple" id="stat-pipeline">--</div>
        <div class="stat-label">Open Pipeline</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon yellow">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
        </div>
        <div class="stat-value yellow" id="stat-conversion">--</div>
        <div class="stat-label">Conversion Rate</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon cyan">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <div class="stat-value" id="stat-revenue" style="color: var(--cyan)">--</div>
        <div class="stat-label">Revenue Pipeline</div>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="toolbar-container">
      <div class="toolbar-top">
        <div class="view-tabs" id="view-tabs">
          <button class="view-tab active" data-view="table">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="vertical-align:-2px;margin-right:5px"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>Table
          </button>
          <button class="view-tab" data-view="board">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="vertical-align:-2px;margin-right:5px"><rect x="3" y="3" width="6" height="18" rx="1"/><rect x="9" y="3" width="6" height="12" rx="1"/><rect x="15" y="3" width="6" height="15" rx="1"/></svg>Board
          </button>
        </div>
        <div class="toolbar-spacer"></div>
        <input class="search-input" id="search-input" type="search" placeholder="Search leads..." autocomplete="off">
        <button class="refresh-btn" id="refresh-btn">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Refresh
        </button>
      </div>
      <div class="toolbar-bottom">
        <div class="filter-group" id="status-filters">
          <button class="filter-btn active" data-status="">All</button>
          <button class="filter-btn" data-status="new">New</button>
          <button class="filter-btn" data-status="contacted">Contacted</button>
          <button class="filter-btn" data-status="qualified">Qualified</button>
          <button class="filter-btn" data-status="proposal">Proposal</button>
          <button class="filter-btn" data-status="closed-won">Won</button>
          <button class="filter-btn" data-status="closed-lost">Lost</button>
        </div>
        <div class="filter-separator"></div>
        <div class="filter-group" id="type-filters">
          <button class="filter-btn active" data-type="">All Types</button>
          <button class="filter-btn" data-type="contact">Contact</button>
          <button class="filter-btn" data-type="booking">Booking</button>
          <button class="filter-btn" data-type="subscribe">Subscribe</button>
        </div>
      </div>
    </div>

    <!-- Table View -->
    <div class="view-table active" id="view-table">
      <div class="leads-table-wrap">
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Lead</th>
                <th>Type</th>
                <th>Status</th>
                <th>Source</th>
                <th>Company</th>
                <th>Notes</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="leads-tbody">
              <tr><td colspan="8" style="text-align:center;padding:60px"><span class="spinner"></span></td></tr>
            </tbody>
          </table>
        </div>
        <div class="pagination" id="pagination" style="display:none">
          <span class="page-info" id="page-info"></span>
          <div class="page-btns">
            <button class="page-btn" id="prev-btn">Previous</button>
            <button class="page-btn" id="next-btn">Next</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Board View -->
    <div class="view-board" id="view-board">
      <div class="kanban-board" id="kanban-board"></div>
    </div>
  </div>
</div>

<!-- Lead detail modal -->
<div class="modal-overlay hidden" id="lead-modal">
  <div class="modal-panel" id="modal-panel">
    <div class="modal-header">
      <div class="modal-header-info">
        <h2 id="modal-name">--</h2>
        <div class="email-link" id="modal-email">--</div>
      </div>
      <button class="modal-close" id="modal-close">&times;</button>
    </div>
    <div class="modal-body" id="modal-body">
      <div style="text-align:center;padding:60px"><span class="spinner"></span></div>
    </div>
  </div>
</div>

<!-- Copy toast -->
<div class="copy-toast" id="copy-toast">Email copied to clipboard</div>

<script>
'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  statusFilter: '',
  typeFilter: '',
  search: '',
  offset: 0,
  limit: 50,
  total: 0,
  leads: [],
  allLeads: [],
  currentLeadId: null,
  currentView: 'table',
  stats: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function q(sel) { return document.querySelector(sel); }
function qa(sel) { return [...document.querySelectorAll(sel)]; }

function setLoading(on) {
  q('#loading-indicator').style.display = on ? 'inline-block' : 'none';
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Relative time formatting
function timeAgo(iso) {
  if (!iso) return '--';
  const date = new Date(iso + (iso.includes('Z') || iso.includes('+') ? '' : 'Z'));
  const now = new Date();
  const diffMs = now - date;
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  if (hours < 24) return hours + 'h ago';
  if (days < 7) return days + 'd ago';
  if (weeks < 4) return weeks + 'w ago';
  if (months < 12) return months + 'mo ago';
  return Math.floor(months / 12) + 'y ago';
}

function fmtDate(iso) {
  if (!iso) return '--';
  const d = new Date(iso + (iso.includes('Z') || iso.includes('+') ? '' : 'Z'));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
         ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function fmtDateFull(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.includes('Z') || iso.includes('+') ? '' : 'Z'));
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) +
         ' at ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function statusBadge(status) {
  const map = {
    'new': 'badge-new', 'contacted': 'badge-contacted', 'qualified': 'badge-qualified',
    'proposal': 'badge-proposal', 'closed-won': 'badge-won', 'closed-lost': 'badge-lost',
  };
  const labels = {
    'new': 'New', 'contacted': 'Contacted', 'qualified': 'Qualified',
    'proposal': 'Proposal', 'closed-won': 'Won', 'closed-lost': 'Lost',
  };
  return '<span class="badge ' + (map[status] || 'badge-new') + '">' + (labels[status] || esc(status)) + '</span>';
}

function typeBadge(type) {
  const map = { contact: 'type-contact', booking: 'type-booking', subscribe: 'type-subscribe' };
  const labels = { contact: 'Contact', booking: 'Booking', subscribe: 'Subscribe' };
  return '<span class="type-badge ' + (map[type] || '') + '">' + (labels[type] || esc(type)) + '</span>';
}

function sourceBadge(source) {
  if (!source) return '<span class="source-badge source-gray">--</span>';
  let cls = 'source-gray';
  if (source === 'contact-page') cls = 'source-blue';
  else if (source === 'landing-ai-consulting') cls = 'source-purple';
  else if (source === 'landing-software-development') cls = 'source-green';
  else if (source === 'landing-ai-strategy') cls = 'source-orange';
  else if (source === 'booking-form') cls = 'source-cyan';
  else if (source === 'homepage-subscribe') cls = 'source-gray';
  else if (source.startsWith('blog-')) cls = 'source-gray';

  const labels = {
    'contact-page': 'Contact Page',
    'landing-ai-consulting': 'AI Consulting',
    'landing-software-development': 'Software Dev',
    'landing-ai-strategy': 'AI Strategy',
    'booking-form': 'Booking Form',
    'homepage-subscribe': 'Subscribe',
  };
  const label = labels[source] || source;
  return '<span class="source-badge ' + cls + '">' + esc(label) + '</span>';
}

function fieldVal(v) {
  if (!v || v === '') return '<span class="val empty">--</span>';
  return '<span class="val">' + esc(v) + '</span>';
}

function showToast(msg) {
  const toast = q('#copy-toast');
  toast.textContent = msg || 'Copied!';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// Budget parsing
const budgetLabels = {
  'under-10k': 'Under $10K', '10k-25k': '$10K - $25K',
  '25k-50k': '$25K - $50K', '50k-100k': '$50K - $100K', '100k-plus': '$100K+',
};
const budgetEstimates = {
  'under-10k': 5000, '10k-25k': 17500, '25k-50k': 37500,
  '50k-100k': 75000, '100k-plus': 150000,
};

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
async function loadStats() {
  try {
    const s = await api('GET', '/api/stats');
    state.stats = s;

    q('#stat-total').textContent = s.total ?? 0;
    q('#stat-week').textContent = s.this_week ?? 0;

    // Open pipeline = total - won - lost
    const pipeline = (s.total || 0) - (s.won_count || 0) - (s.lost_count || 0);
    q('#stat-pipeline').textContent = pipeline;

    // Conversion rate
    const totalClosed = (s.won_count || 0) + (s.lost_count || 0);
    const convRate = totalClosed > 0 ? Math.round((s.won_count / totalClosed) * 100) : 0;
    q('#stat-conversion').textContent = totalClosed > 0 ? convRate + '%' : '--';

    // Week delta indicator
    const weekDelta = q('#stat-week-delta');
    const weekCount = s.this_week || 0;
    if (weekCount > 0) {
      weekDelta.textContent = '+' + weekCount;
      weekDelta.className = 'stat-delta up';
    } else {
      weekDelta.textContent = '0';
      weekDelta.className = 'stat-delta neutral';
    }

    // Revenue pipeline - we'll compute from loaded leads
    computeRevenuePipeline();
  } catch(e) { console.error('Stats error:', e); }
}

function computeRevenuePipeline() {
  let total = 0;
  const qualifiedStatuses = new Set(['qualified', 'proposal', 'closed-won']);
  for (const lead of state.allLeads) {
    if (qualifiedStatuses.has(lead.status) && lead.budget && budgetEstimates[lead.budget]) {
      total += budgetEstimates[lead.budget];
    }
  }
  const formatted = total >= 1000 ? '$' + Math.round(total / 1000) + 'K' : '$' + total;
  q('#stat-revenue').textContent = total > 0 ? formatted : '--';
}

// ---------------------------------------------------------------------------
// Leads list
// ---------------------------------------------------------------------------
async function loadLeads() {
  setLoading(true);
  try {
    const params = new URLSearchParams({ limit: state.limit, offset: state.offset });
    if (state.statusFilter) params.set('status', state.statusFilter);
    if (state.typeFilter)   params.set('type',   state.typeFilter);
    const data = await api('GET', '/api/leads?' + params);
    state.leads  = data.leads;
    state.total  = data.total;

    // Also load all leads for kanban (without pagination)
    if (state.allLeads.length === 0 || !state.statusFilter && !state.typeFilter) {
      const all = await api('GET', '/api/leads?limit=500&offset=0');
      state.allLeads = all.leads;
      computeRevenuePipeline();
    }

    renderLeads();
    renderPagination();
    if (state.currentView === 'board') renderKanban();
  } catch(e) {
    q('#leads-tbody').innerHTML = '<tr><td colspan="8"><div class="empty-state"><h3>Error loading leads</h3><p>' + esc(e.message) + '</p></div></td></tr>';
  } finally {
    setLoading(false);
  }
}

function filteredLeads() {
  const q2 = state.search.toLowerCase();
  if (!q2) return state.leads;
  return state.leads.filter(l =>
    (l.name || '').toLowerCase().includes(q2) ||
    (l.email || '').toLowerCase().includes(q2) ||
    (l.company || '').toLowerCase().includes(q2) ||
    (l.source || '').toLowerCase().includes(q2)
  );
}

function filteredAllLeads() {
  const q2 = state.search.toLowerCase();
  let leads = state.allLeads;
  if (state.statusFilter) leads = leads.filter(l => l.status === state.statusFilter);
  if (state.typeFilter) leads = leads.filter(l => l.type === state.typeFilter);
  if (q2) {
    leads = leads.filter(l =>
      (l.name || '').toLowerCase().includes(q2) ||
      (l.email || '').toLowerCase().includes(q2) ||
      (l.company || '').toLowerCase().includes(q2) ||
      (l.source || '').toLowerCase().includes(q2)
    );
  }
  return leads;
}

function renderLeads() {
  const tbody = q('#leads-tbody');
  const leads = filteredLeads();
  if (leads.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">' +
      '<div class="empty-state-icon">&#x1F4CB;</div>' +
      '<h3>No leads yet</h3>' +
      '<p>Leads from odeaworks.com forms will appear here automatically.</p>' +
      '</div></td></tr>';
    return;
  }
  tbody.innerHTML = leads.map(l => {
    const relTime = timeAgo(l.created_at);
    const fullDate = fmtDateFull(l.created_at);
    return '<tr class="lead-row" data-id="' + l.id + '" data-email="' + esc(l.email) + '">' +
      '<td><div class="name-cell">' + esc(l.name) + '</div><div class="email-cell">' + esc(l.email) + '</div></td>' +
      '<td>' + typeBadge(l.type) + '</td>' +
      '<td>' + statusBadge(l.status) + '</td>' +
      '<td>' + sourceBadge(l.source) + '</td>' +
      '<td><div class="source-cell">' + esc(l.company || '--') + '</div></td>' +
      '<td><span class="notes-cell">' + (l.note_count > 0 ? l.note_count + ' note' + (l.note_count > 1 ? 's' : '') : '--') + '</span></td>' +
      '<td><span class="date-cell" title="' + esc(fullDate) + '">' + esc(relTime) + '</span></td>' +
      '<td><div class="row-actions">' +
        '<a class="row-action-btn" href="mailto:' + esc(l.email) + '" onclick="event.stopPropagation()" title="Send email"><span class="tooltip">Email</span>&#x2709;</a>' +
        '<button class="row-action-btn copy-email-btn" data-email="' + esc(l.email) + '" onclick="event.stopPropagation();copyEmail(this)" title="Copy email"><span class="tooltip">Copy</span>&#x1F4CB;</button>' +
        '<button class="row-action-btn status-dropdown-btn" data-id="' + l.id + '" data-status="' + esc(l.status) + '" onclick="event.stopPropagation();toggleInlineStatus(this)" title="Change status"><span class="tooltip">Status</span>&#x270F;</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');

  // Bind row clicks
  qa('#leads-tbody .lead-row').forEach(row => {
    row.addEventListener('click', () => openLead(parseInt(row.dataset.id, 10)));
  });
}

// Copy email to clipboard
function copyEmail(btn) {
  const email = btn.dataset.email;
  navigator.clipboard.writeText(email).then(() => {
    showToast('Email copied: ' + email);
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = email;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Email copied: ' + email);
  });
}
window.copyEmail = copyEmail;

// Inline status dropdown
let activeDropdown = null;
function toggleInlineStatus(btn) {
  // Close any existing
  if (activeDropdown) {
    activeDropdown.remove();
    activeDropdown = null;
  }

  const row = btn.closest('tr');
  const leadId = parseInt(btn.dataset.id, 10);
  const currentStatus = btn.dataset.status;

  const dd = document.createElement('div');
  dd.className = 'inline-status-dropdown open';
  dd.innerHTML = ['new','contacted','qualified','proposal','closed-won','closed-lost'].map(s =>
    '<button class="inline-status-option' + (s === currentStatus ? ' current' : '') + '" data-status="' + s + '">' + s + '</button>'
  ).join('');

  row.style.position = 'relative';
  row.appendChild(dd);
  activeDropdown = dd;

  dd.addEventListener('click', async (e) => {
    const opt = e.target.closest('.inline-status-option');
    if (!opt) return;
    const newStatus = opt.dataset.status;
    try {
      await api('PATCH', '/api/leads/' + leadId, { status: newStatus });
      dd.remove();
      activeDropdown = null;
      loadLeads();
      loadStats();
    } catch(err) { alert('Error: ' + err.message); }
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!dd.contains(e.target)) {
        dd.remove();
        activeDropdown = null;
        document.removeEventListener('click', handler);
      }
    });
  }, 10);
}
window.toggleInlineStatus = toggleInlineStatus;

function renderPagination() {
  const pag = q('#pagination');
  const info = q('#page-info');
  const prev = q('#prev-btn');
  const next = q('#next-btn');
  if (state.total <= state.limit && state.offset === 0) {
    pag.style.display = 'none';
    return;
  }
  pag.style.display = 'flex';
  const start = state.offset + 1;
  const end   = Math.min(state.offset + state.limit, state.total);
  info.textContent = start + ' - ' + end + ' of ' + state.total + ' leads';
  prev.disabled = state.offset === 0;
  next.disabled = state.offset + state.limit >= state.total;
}

// ---------------------------------------------------------------------------
// Kanban Board
// ---------------------------------------------------------------------------
const kanbanColumns = [
  { key: 'new', label: 'New', dotClass: 'green' },
  { key: 'contacted', label: 'Contacted', dotClass: 'blue' },
  { key: 'qualified', label: 'Qualified', dotClass: 'yellow' },
  { key: 'proposal', label: 'Proposal', dotClass: 'purple' },
  { key: 'closed-won', label: 'Closed Won', dotClass: 'emerald' },
  { key: 'closed-lost', label: 'Closed Lost', dotClass: 'red' },
];

function renderKanban() {
  const board = q('#kanban-board');
  const leads = filteredAllLeads();

  // Group leads by status
  const grouped = {};
  kanbanColumns.forEach(c => grouped[c.key] = []);
  leads.forEach(l => {
    if (grouped[l.status]) grouped[l.status].push(l);
  });

  board.innerHTML = kanbanColumns.map(col => {
    const items = grouped[col.key];
    const cardsHtml = items.length > 0 ?
      items.map(l => {
        const relTime = timeAgo(l.created_at);
        const fullDate = fmtDateFull(l.created_at);
        return '<div class="kanban-card" data-id="' + l.id + '">' +
          '<div class="kanban-card-name">' + esc(l.name) + '</div>' +
          '<div class="kanban-card-company">' + (l.company ? esc(l.company) : esc(l.email)) + '</div>' +
          '<div class="kanban-card-meta">' +
            sourceBadge(l.source) +
            '<span class="kanban-card-date" title="' + esc(fullDate) + '">' + esc(relTime) + '</span>' +
          '</div>' +
          '<div style="margin-top:10px">' +
            '<select class="kanban-card-status-select" data-id="' + l.id + '" onchange="changeKanbanStatus(this)">' +
              ['new','contacted','qualified','proposal','closed-won','closed-lost'].map(s =>
                '<option value="' + s + '"' + (s === l.status ? ' selected' : '') + '>' + s + '</option>'
              ).join('') +
            '</select>' +
          '</div>' +
        '</div>';
      }).join('') :
      '<div class="kanban-empty">No leads</div>';

    return '<div class="kanban-column">' +
      '<div class="kanban-column-header">' +
        '<span class="col-dot ' + col.dotClass + '"></span>' +
        '<span class="col-title">' + col.label + '</span>' +
        '<span class="col-count">' + items.length + '</span>' +
      '</div>' +
      '<div class="kanban-column-body">' + cardsHtml + '</div>' +
    '</div>';
  }).join('');

  // Bind card clicks
  qa('.kanban-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
      openLead(parseInt(card.dataset.id, 10));
    });
  });
}

async function changeKanbanStatus(select) {
  const id = parseInt(select.dataset.id, 10);
  const newStatus = select.value;
  try {
    await api('PATCH', '/api/leads/' + id, { status: newStatus });
    // Update in allLeads
    const lead = state.allLeads.find(l => l.id === id);
    if (lead) lead.status = newStatus;
    const lead2 = state.leads.find(l => l.id === id);
    if (lead2) lead2.status = newStatus;
    renderKanban();
    renderLeads();
    loadStats();
  } catch(err) { alert('Error: ' + err.message); }
}
window.changeKanbanStatus = changeKanbanStatus;

// ---------------------------------------------------------------------------
// Lead detail modal
// ---------------------------------------------------------------------------
async function openLead(id) {
  state.currentLeadId = id;
  const modal = q('#lead-modal');
  modal.classList.remove('hidden');
  q('#modal-name').textContent = 'Loading...';
  q('#modal-email').innerHTML = '';
  q('#modal-body').innerHTML = '<div style="text-align:center;padding:60px"><span class="spinner"></span></div>';

  try {
    const lead = await api('GET', '/api/leads/' + id);
    q('#modal-name').textContent  = lead.name;
    q('#modal-email').innerHTML = '<a href="mailto:' + esc(lead.email) + '" style="color:var(--accent)">' + esc(lead.email) + '</a>';
    renderLeadDetail(lead);
  } catch(e) {
    q('#modal-body').innerHTML = '<p style="color:var(--red);padding:24px">Error: ' + esc(e.message) + '</p>';
  }
}

function renderLeadDetail(lead) {
  const body = q('#modal-body');

  const budgetDisplay = budgetLabels[lead.budget] || lead.budget || '';

  const sourceLabels = {
    'contact-page': 'Contact Page',
    'landing-ai-consulting': 'AI Consulting Landing',
    'landing-software-development': 'Software Dev Landing',
    'landing-ai-strategy': 'AI Strategy Landing',
    'booking-form': 'Booking Form',
    'homepage-subscribe': 'Homepage Subscribe',
  };
  const sourceDisplay = sourceLabels[lead.source] || lead.source || '';

  const statusButtons = ['new','contacted','qualified','proposal','closed-won','closed-lost'].map(s =>
    '<button class="status-btn' + (lead.status === s ? ' active' : '') + '" data-status="' + s + '">' + s + '</button>'
  ).join('');

  const notesHtml = (lead.notes || []).map(n =>
    '<li class="note-item">' +
    '<div class="note-body">' + esc(n.body) + '</div>' +
    '<div class="note-meta"><span title="' + esc(fmtDateFull(n.created_at)) + '">' + timeAgo(n.created_at) + '</span>' +
    '<button class="note-delete" data-note-id="' + n.id + '">Delete</button></div>' +
    '</li>'
  ).join('');

  body.innerHTML = [
    '<div class="modal-section">',
    '  <div class="modal-section-title">Status</div>',
    '  <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">',
    '    ' + typeBadge(lead.type) + ' ' + statusBadge(lead.status),
    '  </div>',
    '  <div class="status-selector">' + statusButtons + '</div>',
    '</div>',

    '<div class="modal-section">',
    '  <div class="modal-section-title">Contact Info</div>',
    '  <div class="field-grid">',
    '    <div class="field-item"><label>Name</label>' + fieldVal(lead.name) + '</div>',
    '    <div class="field-item"><label>Email</label><span class="val"><a href="mailto:' + esc(lead.email) + '" style="color:var(--accent)">' + esc(lead.email) + '</a></span></div>',
    '    <div class="field-item"><label>Company</label>' + fieldVal(lead.company) + '</div>',
    '    <div class="field-item"><label>Source</label><div style="margin-top:2px">' + sourceBadge(lead.source) + '</div></div>',
    '  </div>',
    '  <a href="mailto:' + esc(lead.email) + '" class="send-email-btn">',
    '    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
    '    Send email to ' + esc(lead.name),
    '  </a>',
    '</div>',

    '<div class="modal-section">',
    '  <div class="modal-section-title">Project Details</div>',
    '  <div class="field-grid">',
    '    <div class="field-item"><label>Type</label>' + fieldVal(lead.type) + '</div>',
    '    <div class="field-item"><label>Budget Range</label>' + fieldVal(budgetDisplay) + '</div>',
    '    <div class="field-item"><label>Project Type</label>' + fieldVal(lead.project_type) + '</div>',
    '    <div class="field-item"><label>Source Detail</label>' + fieldVal(sourceDisplay) + '</div>',
    lead.date ? '    <div class="field-item"><label>Booking Date</label>' + fieldVal(lead.date) + '</div>' : '',
    lead.time_slot ? '    <div class="field-item"><label>Time Slot</label>' + fieldVal(lead.time_slot) + '</div>' : '',
    '  </div>',
    lead.message ? '<div class="message-block">' + esc(lead.message) + '</div>' : '',
    '</div>',

    '<div class="modal-section">',
    '  <div class="modal-section-title">Timeline</div>',
    '  <div class="field-grid">',
    '    <div class="field-item"><label>Created</label><span class="val" title="' + esc(fmtDateFull(lead.created_at)) + '">' + timeAgo(lead.created_at) + ' <span style="color:var(--dim);font-size:12px">(' + fmtDate(lead.created_at) + ')</span></span></div>',
    '    <div class="field-item"><label>Updated</label><span class="val" title="' + esc(fmtDateFull(lead.updated_at)) + '">' + timeAgo(lead.updated_at) + ' <span style="color:var(--dim);font-size:12px">(' + fmtDate(lead.updated_at) + ')</span></span></div>',
    lead.subscribed_at ? '    <div class="field-item"><label>Subscribed</label><span class="val">' + fmtDate(lead.subscribed_at) + '</span></div>' : '',
    '  </div>',
    '</div>',

    '<div class="modal-section">',
    '  <div class="modal-section-title">Notes (' + (lead.notes || []).length + ')</div>',
    '  <ul class="notes-list" id="notes-list">' + (notesHtml || '') + '</ul>',
    '  <div class="note-form">',
    '    <textarea class="note-textarea" id="note-input" placeholder="Add a note... (Ctrl+Enter to save)"></textarea>',
    '    <button class="btn-primary" id="add-note-btn">Add Note</button>',
    '  </div>',
    '</div>',

    '<div class="modal-section">',
    '  <button class="delete-lead-btn" id="delete-lead-btn">Delete this lead</button>',
    '</div>',
  ].join('\\n');

  // Status buttons
  qa('.status-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newStatus = btn.dataset.status;
      try {
        const updated = await api('PATCH', '/api/leads/' + lead.id, { status: newStatus });
        lead.status = updated.status;
        qa('.status-btn').forEach(b => b.classList.toggle('active', b.dataset.status === updated.status));
        loadLeads();
        loadStats();
      } catch(e) { alert('Error: ' + e.message); }
    });
  });

  // Add note
  q('#add-note-btn').addEventListener('click', async () => {
    const ta = q('#note-input');
    const text = ta.value.trim();
    if (!text) return;
    const btn = q('#add-note-btn');
    btn.disabled = true;
    try {
      const result = await api('POST', '/api/leads/' + lead.id + '/notes', { body: text });
      ta.value = '';
      lead.notes = result.notes;
      renderNotesList(lead.notes, lead.id);
    } catch(e) { alert('Error: ' + e.message); }
    finally { btn.disabled = false; }
  });

  // Note enter key
  q('#note-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) q('#add-note-btn').click();
  });

  // Delete lead
  q('#delete-lead-btn').addEventListener('click', async () => {
    if (!confirm('Delete this lead? This cannot be undone.')) return;
    try {
      await api('DELETE', '/api/leads/' + lead.id);
      closeModal();
      loadLeads();
      loadStats();
    } catch(e) { alert('Error: ' + e.message); }
  });

  // Note delete delegation
  q('#notes-list').addEventListener('click', async e => {
    const btn = e.target.closest('.note-delete');
    if (!btn) return;
    if (!confirm('Delete this note?')) return;
    const noteId = parseInt(btn.dataset.noteId, 10);
    try {
      await api('DELETE', '/api/leads/' + lead.id + '/notes/' + noteId);
      lead.notes = lead.notes.filter(n => n.id !== noteId);
      renderNotesList(lead.notes, lead.id);
    } catch(e2) { alert('Error: ' + e2.message); }
  });
}

function renderNotesList(notes, leadId) {
  const list = q('#notes-list');
  if (!list) return;
  list.innerHTML = (notes || []).map(n =>
    '<li class="note-item">' +
    '<div class="note-body">' + esc(n.body) + '</div>' +
    '<div class="note-meta"><span title="' + esc(fmtDateFull(n.created_at)) + '">' + timeAgo(n.created_at) + '</span>' +
    '<button class="note-delete" data-note-id="' + n.id + '">Delete</button></div>' +
    '</li>'
  ).join('');
}

function closeModal() {
  q('#lead-modal').classList.add('hidden');
  state.currentLeadId = null;
}

// ---------------------------------------------------------------------------
// Event bindings
// ---------------------------------------------------------------------------
q('#modal-close').addEventListener('click', closeModal);
q('#lead-modal').addEventListener('click', e => {
  if (e.target === q('#lead-modal')) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

// View toggle
q('#view-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.view-tab');
  if (!tab) return;
  const view = tab.dataset.view;
  state.currentView = view;
  qa('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  q('#view-table').style.display = view === 'table' ? 'block' : 'none';
  q('#view-board').style.display = view === 'board' ? 'block' : 'none';
  if (view === 'board') renderKanban();
});

// Status filter
q('#status-filters').addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  qa('#status-filters .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.statusFilter = btn.dataset.status;
  state.offset = 0;
  loadLeads();
});

// Type filter
q('#type-filters').addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  qa('#type-filters .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.typeFilter = btn.dataset.type;
  state.offset = 0;
  loadLeads();
});

// Search
let searchTimer;
q('#search-input').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value;
    renderLeads();
    renderPagination();
    if (state.currentView === 'board') renderKanban();
  }, 200);
});

// Refresh
q('#refresh-btn').addEventListener('click', () => {
  state.allLeads = [];
  loadStats();
  loadLeads();
});

// Pagination
q('#prev-btn').addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - state.limit);
  loadLeads();
});
q('#next-btn').addEventListener('click', () => {
  state.offset += state.limit;
  loadLeads();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
loadStats();
loadLeads();

// Auto-refresh every 60 seconds
setInterval(() => { loadStats(); loadLeads(); }, 60_000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    await router(req, res);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Unhandled error:`, err);
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: 'Internal server error' });
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[odeaworks-crm] Listening on 127.0.0.1:${PORT}`);
  console.log(`[odeaworks-crm] Database: ${DB_PATH}`);
});

process.on('SIGTERM', () => {
  console.log('[odeaworks-crm] SIGTERM received — shutting down');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
