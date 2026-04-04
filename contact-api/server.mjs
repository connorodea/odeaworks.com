import http from 'node:http';
import { Resend } from 'resend';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = 3050;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = 'connor@odeaworks.com';
const FROM_EMAIL = 'Odea Works <contact@odeaworks.com>';
const ALLOWED_ORIGINS = [
  'https://odeaworks.com',
  'https://www.odeaworks.com',
];

if (!RESEND_API_KEY) {
  console.error('FATAL: RESEND_API_KEY environment variable is not set');
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

// ---------------------------------------------------------------------------
// Rate limiting — simple in-memory store (IP -> [timestamps])
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  let timestamps = rateLimitMap.get(ip) || [];
  // Remove expired entries
  timestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitMap.set(ip, timestamps);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}

// Periodic cleanup every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap) {
    const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (valid.length === 0) {
      rateLimitMap.delete(ip);
    } else {
      rateLimitMap.set(ip, valid);
    }
  }
}, 10 * 60 * 1000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getClientIP(req) {
  // Trust X-Forwarded-For from nginx
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function setCorsHeaders(res, origin) {
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEmailHtml({ name, email, company, budget, projectType, message }) {
  const budgetLabels = {
    'under-10k': 'Under $10K',
    '10k-25k': '$10K - $25K',
    '25k-50k': '$25K - $50K',
    '50k-100k': '$50K - $100K',
    '100k-plus': '$100K+',
  };

  const budgetDisplay = budgetLabels[budget] || budget || 'Not specified';
  const companyDisplay = company || 'Not specified';
  const projectTypeDisplay = projectType || 'Not specified';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#0a0a0a; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a; padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#111111; border-radius:8px; overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 24px; border-bottom:1px solid #222;">
              <h1 style="margin:0; color:#ffffff; font-size:20px; font-weight:600;">New Contact Form Submission</h1>
              <p style="margin:8px 0 0; color:#888; font-size:14px;">odeaworks.com</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:12px 0; border-bottom:1px solid #1a1a1a;">
                    <p style="margin:0 0 4px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Name</p>
                    <p style="margin:0; color:#ffffff; font-size:16px;">${escapeHtml(name)}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 0; border-bottom:1px solid #1a1a1a;">
                    <p style="margin:0 0 4px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Email</p>
                    <p style="margin:0;"><a href="mailto:${escapeHtml(email)}" style="color:#4da6ff; font-size:16px; text-decoration:none;">${escapeHtml(email)}</a></p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 0; border-bottom:1px solid #1a1a1a;">
                    <p style="margin:0 0 4px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Company</p>
                    <p style="margin:0; color:#ffffff; font-size:16px;">${escapeHtml(companyDisplay)}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 0; border-bottom:1px solid #1a1a1a;">
                    <p style="margin:0 0 4px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Budget</p>
                    <p style="margin:0; color:#ffffff; font-size:16px;">${escapeHtml(budgetDisplay)}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 0; border-bottom:1px solid #1a1a1a;">
                    <p style="margin:0 0 4px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Project Type</p>
                    <p style="margin:0; color:#ffffff; font-size:16px;">${escapeHtml(projectTypeDisplay)}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 0;">
                    <p style="margin:0 0 4px; color:#666; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Message</p>
                    <p style="margin:0; color:#ffffff; font-size:16px; line-height:1.6; white-space:pre-wrap;">${escapeHtml(message)}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px; border-top:1px solid #222; text-align:center;">
              <p style="margin:0; color:#555; font-size:12px;">Sent from odeaworks.com contact form</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  setCorsHeaders(res, origin);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Only handle POST /api/contact
  if (req.method !== 'POST' || req.url !== '/api/contact') {
    return jsonResponse(res, 404, { error: 'Not found' });
  }

  // Rate limit check
  const clientIP = getClientIP(req);
  if (isRateLimited(clientIP)) {
    return jsonResponse(res, 429, { error: 'Too many requests. Please try again later.' });
  }

  // Parse JSON body
  let body = '';
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        body += chunk;
        // Guard against oversized payloads (50KB)
        if (body.length > 50_000) {
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', resolve);
      req.on('error', reject);
    });
  } catch {
    return jsonResponse(res, 413, { error: 'Payload too large' });
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }

  // Honeypot check — reject silently (return success to fool bots)
  if (data._honey) {
    return jsonResponse(res, 200, { success: true });
  }

  // Validate required fields
  const { name, email, message } = data;
  if (!name || !name.trim()) {
    return jsonResponse(res, 400, { error: 'Name is required' });
  }
  if (!email || !email.trim()) {
    return jsonResponse(res, 400, { error: 'Email is required' });
  }
  if (!message || !message.trim()) {
    return jsonResponse(res, 400, { error: 'Message is required' });
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return jsonResponse(res, 400, { error: 'Invalid email address' });
  }

  // Send email via Resend
  try {
    const companyTag = data.company ? ` (${data.company.trim()})` : '';
    await resend.emails.send({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      replyTo: email.trim(),
      subject: `New inquiry from ${name.trim()}${companyTag}`,
      html: buildEmailHtml({
        name: name.trim(),
        email: email.trim(),
        company: (data.company || '').trim(),
        budget: (data.budget || '').trim(),
        projectType: (data.projectType || '').trim(),
        message: message.trim(),
      }),
    });

    console.log(`[${new Date().toISOString()}] Email sent — from: ${email.trim()}, name: ${name.trim()}, ip: ${clientIP}`);
    return jsonResponse(res, 200, { success: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Resend error:`, err);
    return jsonResponse(res, 500, { error: 'Failed to send message. Please try again later.' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[odeaworks-contact-api] Listening on 127.0.0.1:${PORT}`);
});
