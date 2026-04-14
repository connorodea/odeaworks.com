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
<title>Odea Works CRM</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    --bg: #0a0a0a;
    --surface: #111111;
    --surface2: #1a1a1a;
    --border: #222222;
    --border2: #2a2a2a;
    --text: #e8e8e8;
    --muted: #888888;
    --dim: #555555;
    --green: #10a37f;
    --green-dim: #0d7a60;
    --red: #e05252;
    --yellow: #d4a017;
    --blue: #4a9eff;
    --purple: #8b5cf6;
    --radius: 8px;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.5; }
  a { color: var(--green); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button { cursor: pointer; font-family: var(--font); }

  /* Layout */
  .app { display: flex; flex-direction: column; min-height: 100vh; }
  .topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 24px; display: flex; align-items: center; gap: 16px; }
  .topbar-title { font-size: 15px; font-weight: 600; color: var(--text); letter-spacing: -0.2px; }
  .topbar-sub { font-size: 12px; color: var(--muted); }
  .topbar-spacer { flex: 1; }
  .main { flex: 1; padding: 24px; max-width: 1400px; margin: 0 auto; width: 100%; }

  /* Stats bar */
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .stat-card .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--muted); margin-bottom: 6px; }
  .stat-card .value { font-size: 24px; font-weight: 700; color: var(--text); line-height: 1; }
  .stat-card .value.green { color: var(--green); }
  .stat-card .value.yellow { color: var(--yellow); }
  .stat-card .value.blue { color: var(--blue); }

  /* Toolbar */
  .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-group { display: flex; gap: 6px; }
  .filter-btn { background: var(--surface); border: 1px solid var(--border); color: var(--muted); padding: 6px 12px; border-radius: 6px; font-size: 12px; transition: all 0.15s; }
  .filter-btn:hover { border-color: var(--border2); color: var(--text); }
  .filter-btn.active { background: var(--green); border-color: var(--green); color: #fff; }
  .search-input { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 6px; font-size: 12px; font-family: var(--font); outline: none; width: 200px; }
  .search-input:focus { border-color: var(--green); }
  .search-input::placeholder { color: var(--dim); }
  .toolbar-spacer { flex: 1; }
  .refresh-btn { background: var(--surface); border: 1px solid var(--border); color: var(--muted); padding: 6px 12px; border-radius: 6px; font-size: 12px; }
  .refresh-btn:hover { color: var(--text); border-color: var(--border2); }

  /* Table */
  .leads-table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  table { width: 100%; border-collapse: collapse; }
  th { background: var(--surface2); padding: 10px 14px; text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); border-bottom: 1px solid var(--border); }
  td { padding: 12px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr.lead-row { cursor: pointer; transition: background 0.1s; }
  tr.lead-row:hover { background: var(--surface2); }

  .badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; white-space: nowrap; }
  .badge-new       { background: #1a2a1a; color: var(--green); border: 1px solid #1e3a1e; }
  .badge-contacted { background: #1a1a2a; color: var(--blue); border: 1px solid #1e2a3a; }
  .badge-qualified { background: #2a1a00; color: var(--yellow); border: 1px solid #3a2a00; }
  .badge-proposal  { background: #1e1030; color: var(--purple); border: 1px solid #2e1a40; }
  .badge-won       { background: #0a1a0a; color: #00d68f; border: 1px solid #0a2a1a; }
  .badge-lost      { background: #1a0a0a; color: var(--red); border: 1px solid #2a1010; }

  .type-badge { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 500; white-space: nowrap; }
  .type-contact   { background: #1a1a2a; color: var(--blue); }
  .type-booking   { background: #1e1030; color: var(--purple); }
  .type-subscribe { background: #1a2a1a; color: var(--green); }

  .name-cell { font-weight: 500; color: var(--text); }
  .email-cell { color: var(--muted); font-size: 12px; }
  .source-cell { color: var(--dim); font-size: 11px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .date-cell { color: var(--dim); font-size: 11px; white-space: nowrap; }
  .notes-cell { color: var(--dim); font-size: 11px; }

  /* Empty state */
  .empty-state { padding: 60px 24px; text-align: center; color: var(--muted); }
  .empty-state h3 { margin: 0 0 8px; font-size: 16px; color: var(--text); }
  .empty-state p { margin: 0; font-size: 13px; }

  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: flex-start; justify-content: flex-end; z-index: 100; }
  .modal-overlay.hidden { display: none; }
  .modal-panel { background: var(--surface); border-left: 1px solid var(--border); width: 480px; max-width: 100vw; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; }
  .modal-header { padding: 20px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; gap: 12px; }
  .modal-header-info { flex: 1; min-width: 0; }
  .modal-header-info h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; color: var(--text); }
  .modal-header-info .email { font-size: 12px; color: var(--muted); }
  .modal-close { background: none; border: none; color: var(--muted); font-size: 20px; padding: 0; line-height: 1; }
  .modal-close:hover { color: var(--text); }
  .modal-body { padding: 20px 24px; flex: 1; }
  .modal-section { margin-bottom: 24px; }
  .modal-section-title { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; color: var(--muted); margin-bottom: 10px; }

  .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .field-item label { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--dim); margin-bottom: 3px; }
  .field-item .val { font-size: 13px; color: var(--text); word-break: break-word; }
  .field-item .val.empty { color: var(--dim); font-style: italic; }
  .field-item.full { grid-column: 1 / -1; }

  /* Status selector */
  .status-selector { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .status-btn { background: var(--surface2); border: 1px solid var(--border); color: var(--muted); padding: 5px 10px; border-radius: 5px; font-size: 11px; transition: all 0.15s; }
  .status-btn:hover { border-color: var(--border2); color: var(--text); }
  .status-btn.active { font-weight: 600; }
  .status-btn[data-status="new"].active       { background: #1a2a1a; color: var(--green); border-color: var(--green); }
  .status-btn[data-status="contacted"].active { background: #1a1a2a; color: var(--blue); border-color: var(--blue); }
  .status-btn[data-status="qualified"].active { background: #2a1a00; color: var(--yellow); border-color: var(--yellow); }
  .status-btn[data-status="proposal"].active  { background: #1e1030; color: var(--purple); border-color: var(--purple); }
  .status-btn[data-status="closed-won"].active  { background: #0a1a0a; color: #00d68f; border-color: #00d68f; }
  .status-btn[data-status="closed-lost"].active { background: #1a0a0a; color: var(--red); border-color: var(--red); }

  /* Notes */
  .notes-list { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .note-item { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; position: relative; }
  .note-item .note-body { font-size: 13px; color: var(--text); white-space: pre-wrap; word-break: break-word; margin-bottom: 6px; }
  .note-item .note-meta { font-size: 10px; color: var(--dim); display: flex; align-items: center; justify-content: space-between; }
  .note-delete { background: none; border: none; color: var(--dim); font-size: 11px; padding: 0; }
  .note-delete:hover { color: var(--red); }
  .note-form { display: flex; flex-direction: column; gap: 8px; }
  .note-textarea { background: var(--surface2); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 10px 12px; font-family: var(--font); font-size: 13px; resize: vertical; min-height: 80px; outline: none; }
  .note-textarea:focus { border-color: var(--green); }
  .note-textarea::placeholder { color: var(--dim); }
  .btn-primary { background: var(--green); border: none; color: #fff; padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; align-self: flex-start; }
  .btn-primary:hover { background: var(--green-dim); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .delete-lead-btn { background: none; border: 1px solid var(--border); color: var(--dim); padding: 7px 14px; border-radius: 6px; font-size: 12px; width: 100%; margin-top: 8px; }
  .delete-lead-btn:hover { border-color: var(--red); color: var(--red); }

  /* Spinner */
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--green); border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Pagination */
  .pagination { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-top: 1px solid var(--border); }
  .page-info { font-size: 12px; color: var(--muted); }
  .page-btns { display: flex; gap: 6px; }
  .page-btn { background: var(--surface2); border: 1px solid var(--border); color: var(--muted); padding: 5px 10px; border-radius: 5px; font-size: 12px; }
  .page-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .page-btn:not(:disabled):hover { color: var(--text); border-color: var(--border2); }

  @media (max-width: 700px) {
    .main { padding: 14px; }
    .modal-panel { width: 100vw; }
    .field-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <div>
      <div class="topbar-title">Odea Works CRM</div>
      <div class="topbar-sub">Lead Management</div>
    </div>
    <div class="topbar-spacer"></div>
    <span id="loading-indicator" style="display:none"><span class="spinner"></span></span>
    <a href="/logout" style="color: #666; font-size: 12px; text-decoration: none; margin-left: 16px;">Sign out</a>
  </div>
  <div class="main">
    <!-- Stats -->
    <div class="stats-row" id="stats-row">
      <div class="stat-card"><div class="label">Total Leads</div><div class="value" id="stat-total">—</div></div>
      <div class="stat-card"><div class="label">New</div><div class="value green" id="stat-new">—</div></div>
      <div class="stat-card"><div class="label">This Week</div><div class="value blue" id="stat-week">—</div></div>
      <div class="stat-card"><div class="label">This Month</div><div class="value" id="stat-month">—</div></div>
      <div class="stat-card"><div class="label">Proposal</div><div class="value yellow" id="stat-proposal">—</div></div>
      <div class="stat-card"><div class="label">Closed Won</div><div class="value green" id="stat-won">—</div></div>
      <div class="stat-card"><div class="label">Contact Form</div><div class="value" id="stat-contact">—</div></div>
      <div class="stat-card"><div class="label">Bookings</div><div class="value" id="stat-booking">—</div></div>
      <div class="stat-card"><div class="label">Subscribers</div><div class="value" id="stat-subscribe">—</div></div>
    </div>

    <!-- Toolbar -->
    <div class="toolbar">
      <div class="filter-group" id="status-filters">
        <button class="filter-btn active" data-status="">All</button>
        <button class="filter-btn" data-status="new">New</button>
        <button class="filter-btn" data-status="contacted">Contacted</button>
        <button class="filter-btn" data-status="qualified">Qualified</button>
        <button class="filter-btn" data-status="proposal">Proposal</button>
        <button class="filter-btn" data-status="closed-won">Won</button>
        <button class="filter-btn" data-status="closed-lost">Lost</button>
      </div>
      <div class="filter-group" id="type-filters">
        <button class="filter-btn active" data-type="">All Types</button>
        <button class="filter-btn" data-type="contact">Contact</button>
        <button class="filter-btn" data-type="booking">Booking</button>
        <button class="filter-btn" data-type="subscribe">Subscribe</button>
      </div>
      <div class="toolbar-spacer"></div>
      <input class="search-input" id="search-input" type="search" placeholder="Search by name or email..." autocomplete="off">
      <button class="refresh-btn" id="refresh-btn">Refresh</button>
    </div>

    <!-- Table -->
    <div class="leads-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Status</th>
            <th>Source</th>
            <th>Company</th>
            <th>Notes</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody id="leads-tbody">
          <tr><td colspan="7" class="empty-state"><div class="spinner"></div></td></tr>
        </tbody>
      </table>
      <div class="pagination" id="pagination" style="display:none">
        <span class="page-info" id="page-info"></span>
        <div class="page-btns">
          <button class="page-btn" id="prev-btn">Prev</button>
          <button class="page-btn" id="next-btn">Next</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Lead detail modal -->
<div class="modal-overlay hidden" id="lead-modal">
  <div class="modal-panel" id="modal-panel">
    <div class="modal-header">
      <div class="modal-header-info">
        <h2 id="modal-name">—</h2>
        <div class="email" id="modal-email">—</div>
      </div>
      <button class="modal-close" id="modal-close">&times;</button>
    </div>
    <div class="modal-body" id="modal-body">
      <div style="text-align:center;padding:40px"><span class="spinner"></span></div>
    </div>
  </div>
</div>

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
  currentLeadId: null,
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

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
         ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function fmtDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function statusBadge(status) {
  const map = {
    'new': 'badge-new', 'contacted': 'badge-contacted', 'qualified': 'badge-qualified',
    'proposal': 'badge-proposal', 'closed-won': 'badge-won', 'closed-lost': 'badge-lost',
  };
  return '<span class="badge ' + (map[status] || 'badge-new') + '">' + esc(status) + '</span>';
}

function typeBadge(type) {
  const map = { contact: 'type-contact', booking: 'type-booking', subscribe: 'type-subscribe' };
  return '<span class="type-badge ' + (map[type] || '') + '">' + esc(type) + '</span>';
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fieldVal(v) {
  if (!v || v === '') return '<span class="val empty">—</span>';
  return '<span class="val">' + esc(v) + '</span>';
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
async function loadStats() {
  try {
    const s = await api('GET', '/api/stats');
    q('#stat-total').textContent    = s.total ?? 0;
    q('#stat-new').textContent      = s.new_count ?? 0;
    q('#stat-week').textContent     = s.this_week ?? 0;
    q('#stat-month').textContent    = s.this_month ?? 0;
    q('#stat-proposal').textContent = s.proposal_count ?? 0;
    q('#stat-won').textContent      = s.won_count ?? 0;
    q('#stat-contact').textContent  = s.contact_form_count ?? 0;
    q('#stat-booking').textContent  = s.booking_count ?? 0;
    q('#stat-subscribe').textContent = s.subscribe_count ?? 0;
  } catch(e) { console.error('Stats error:', e); }
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
    renderLeads();
    renderPagination();
  } catch(e) {
    q('#leads-tbody').innerHTML = '<tr><td colspan="7" class="empty-state"><div>Error loading leads: ' + esc(e.message) + '</div></td></tr>';
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
    (l.company || '').toLowerCase().includes(q2)
  );
}

function renderLeads() {
  const tbody = q('#leads-tbody');
  const leads = filteredLeads();
  if (leads.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><h3>No leads found</h3><p>Leads from your forms will appear here.</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = leads.map(l => '<tr class="lead-row" data-id="' + l.id + '">' +
    '<td><div class="name-cell">' + esc(l.name) + '</div><div class="email-cell">' + esc(l.email) + '</div></td>' +
    '<td>' + typeBadge(l.type) + '</td>' +
    '<td>' + statusBadge(l.status) + '</td>' +
    '<td><div class="source-cell" title="' + esc(l.source) + '">' + esc(l.source || '—') + '</div></td>' +
    '<td><div class="source-cell">' + esc(l.company || '—') + '</div></td>' +
    '<td><span class="notes-cell">' + (l.note_count > 0 ? l.note_count + ' note' + (l.note_count > 1 ? 's' : '') : '—') + '</span></td>' +
    '<td><span class="date-cell">' + fmtDateShort(l.created_at) + '</span></td>' +
    '</tr>'
  ).join('');

  // Bind row clicks
  qa('#leads-tbody .lead-row').forEach(row => {
    row.addEventListener('click', () => openLead(parseInt(row.dataset.id, 10)));
  });
}

function renderPagination() {
  const pag = q('#pagination');
  const info = q('#page-info');
  const prev = q('#prev-btn');
  const next = q('#next-btn');
  const filtered = filteredLeads().length;
  if (state.total <= state.limit && state.offset === 0) {
    pag.style.display = 'none';
    return;
  }
  pag.style.display = 'flex';
  const start = state.offset + 1;
  const end   = Math.min(state.offset + filtered, state.total);
  info.textContent = start + '–' + end + ' of ' + state.total;
  prev.disabled = state.offset === 0;
  next.disabled = state.offset + state.limit >= state.total;
}

// ---------------------------------------------------------------------------
// Lead detail modal
// ---------------------------------------------------------------------------
async function openLead(id) {
  state.currentLeadId = id;
  const modal = q('#lead-modal');
  modal.classList.remove('hidden');
  q('#modal-name').textContent = '...';
  q('#modal-email').textContent = '';
  q('#modal-body').innerHTML = '<div style="text-align:center;padding:40px"><span class="spinner"></span></div>';

  try {
    const lead = await api('GET', '/api/leads/' + id);
    q('#modal-name').textContent  = lead.name;
    q('#modal-email').textContent = lead.email;
    renderLeadDetail(lead);
  } catch(e) {
    q('#modal-body').innerHTML = '<p style="color:var(--red)">Error: ' + esc(e.message) + '</p>';
  }
}

function renderLeadDetail(lead) {
  const body = q('#modal-body');

  // Source label
  const sourceLabels = {
    'landing-ai-consulting': 'Landing: AI Consulting',
    'landing-software-development': 'Landing: Software Dev',
    'landing-ai-strategy': 'Landing: AI Strategy',
  };
  const sourceDisplay = sourceLabels[lead.source] || lead.source || '';

  const budgetLabels = {
    'under-10k': 'Under $10K', '10k-25k': '$10K - $25K',
    '25k-50k': '$25K - $50K', '50k-100k': '$50K - $100K', '100k-plus': '$100K+',
  };
  const budgetDisplay = budgetLabels[lead.budget] || lead.budget || '';

  const statusButtons = ['new','contacted','qualified','proposal','closed-won','closed-lost'].map(s =>
    '<button class="status-btn' + (lead.status === s ? ' active' : '') + '" data-status="' + s + '">' + s + '</button>'
  ).join('');

  const notesHtml = (lead.notes || []).map(n =>
    '<li class="note-item">' +
    '<div class="note-body">' + esc(n.body) + '</div>' +
    '<div class="note-meta"><span>' + fmtDate(n.created_at) + '</span>' +
    '<button class="note-delete" data-note-id="' + n.id + '">Delete</button></div>' +
    '</li>'
  ).join('');

  body.innerHTML = [
    '<div class="modal-section">',
    '  <div class="modal-section-title">Type & Status</div>',
    '  <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">',
    '    ' + typeBadge(lead.type) + ' ' + statusBadge(lead.status),
    '  </div>',
    '  <div class="status-selector">' + statusButtons + '</div>',
    '</div>',
    '<div class="modal-section">',
    '  <div class="modal-section-title">Lead Info</div>',
    '  <div class="field-grid">',
    '    <div class="field-item"><label>Name</label>' + fieldVal(lead.name) + '</div>',
    '    <div class="field-item"><label>Email</label><span class="val"><a href="mailto:' + esc(lead.email) + '">' + esc(lead.email) + '</a></span></div>',
    '    <div class="field-item"><label>Company</label>' + fieldVal(lead.company) + '</div>',
    '    <div class="field-item"><label>Budget</label>' + fieldVal(budgetDisplay) + '</div>',
    '    <div class="field-item"><label>Project Type</label>' + fieldVal(lead.project_type) + '</div>',
    '    <div class="field-item"><label>Source</label>' + fieldVal(sourceDisplay) + '</div>',
    lead.date ? '    <div class="field-item"><label>Preferred Date</label>' + fieldVal(lead.date) + '</div>' : '',
    lead.time_slot ? '    <div class="field-item"><label>Time Slot</label>' + fieldVal(lead.time_slot) + '</div>' : '',
    '  </div>',
    lead.message ? '  <div class="field-item full" style="margin-top:12px"><label>Message</label><span class="val" style="white-space:pre-wrap;line-height:1.6">' + esc(lead.message) + '</span></div>' : '',
    '</div>',
    '<div class="modal-section">',
    '  <div class="modal-section-title">Timestamps</div>',
    '  <div class="field-grid">',
    '    <div class="field-item"><label>Created</label><span class="val">' + fmtDate(lead.created_at) + '</span></div>',
    '    <div class="field-item"><label>Updated</label><span class="val">' + fmtDate(lead.updated_at) + '</span></div>',
    '  </div>',
    '</div>',
    '<div class="modal-section">',
    '  <div class="modal-section-title">Notes</div>',
    '  <ul class="notes-list" id="notes-list">' + (notesHtml || '') + '</ul>',
    '  <div class="note-form">',
    '    <textarea class="note-textarea" id="note-input" placeholder="Add a note..."></textarea>',
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
        // Update badge
        body.querySelector('.badge').outerHTML; // re-render inline badge
        renderLeads(); // refresh table row
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
    } catch(e) { alert('Error: ' + e.message); }
  });
}

function renderNotesList(notes, leadId) {
  const list = q('#notes-list');
  if (!list) return;
  list.innerHTML = (notes || []).map(n =>
    '<li class="note-item">' +
    '<div class="note-body">' + esc(n.body) + '</div>' +
    '<div class="note-meta"><span>' + fmtDate(n.created_at) + '</span>' +
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
  }, 200);
});

// Refresh
q('#refresh-btn').addEventListener('click', () => {
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
