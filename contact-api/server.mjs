import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resend } from 'resend';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ---------------------------------------------------------------------------
// CRM webhook — forwards leads to odeaworks-crm running on :3120
// Fire-and-forget: never fails the main request if CRM is unavailable
// ---------------------------------------------------------------------------
const CRM_WEBHOOK_URL = 'http://127.0.0.1:3120/api/leads';
const CRM_WEBHOOK_SECRET = 'odeaworks-crm-secret-2024';

async function forwardToCRM(payload) {
  try {
    const body = JSON.stringify(payload);
    await new Promise((resolve, reject) => {
      const req = http.request(
        CRM_WEBHOOK_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-Crm-Secret': CRM_WEBHOOK_SECRET,
          },
        },
        (res) => {
          res.resume(); // drain body
          resolve();
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('CRM webhook timeout')); });
      req.write(body);
      req.end();
    });
  } catch (err) {
    // Non-critical — log and continue
    console.error(`[${new Date().toISOString()}] CRM webhook error:`, err.message);
  }
}

if (!RESEND_API_KEY) {
  console.error('FATAL: RESEND_API_KEY environment variable is not set');
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

// ---------------------------------------------------------------------------
// Subscribers file path
// ---------------------------------------------------------------------------
const SUBSCRIBERS_FILE = path.join(__dirname, 'subscribers.json');

// Ensure subscribers file exists
if (!fs.existsSync(SUBSCRIBERS_FILE)) {
  fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([], null, 2));
}

// ---------------------------------------------------------------------------
// Bookings file path
// ---------------------------------------------------------------------------
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

// Ensure bookings file exists
if (!fs.existsSync(BOOKINGS_FILE)) {
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify([], null, 2));
}

// ---------------------------------------------------------------------------
// Rate limiting — simple in-memory store (IP -> [timestamps])
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rateLimitMap = new Map();

// Separate rate limiter for subscribe endpoint (more generous)
const SUBSCRIBE_RATE_LIMIT_MAX = 5;
const subscribeRateLimitMap = new Map();

// Separate rate limiter for booking endpoint (3 per hour)
const BOOKING_RATE_LIMIT_MAX = 3;
const bookingRateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  let timestamps = rateLimitMap.get(ip) || [];
  timestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitMap.set(ip, timestamps);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}

function isSubscribeRateLimited(ip) {
  const now = Date.now();
  let timestamps = subscribeRateLimitMap.get(ip) || [];
  timestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  subscribeRateLimitMap.set(ip, timestamps);

  if (timestamps.length >= SUBSCRIBE_RATE_LIMIT_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}

function isBookingRateLimited(ip) {
  const now = Date.now();
  let timestamps = bookingRateLimitMap.get(ip) || [];
  timestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  bookingRateLimitMap.set(ip, timestamps);

  if (timestamps.length >= BOOKING_RATE_LIMIT_MAX) {
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
  for (const [ip, timestamps] of subscribeRateLimitMap) {
    const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (valid.length === 0) {
      subscribeRateLimitMap.delete(ip);
    } else {
      subscribeRateLimitMap.set(ip, valid);
    }
  }
  for (const [ip, timestamps] of bookingRateLimitMap) {
    const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (valid.length === 0) {
      bookingRateLimitMap.delete(ip);
    } else {
      bookingRateLimitMap.set(ip, valid);
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

// ---------------------------------------------------------------------------
// Brand constants
// ---------------------------------------------------------------------------
const BRAND = {
  bg: '#000000',
  cardBg: '#0a0a0a',
  borderColor: '#1a1a1a',
  white: '#ffffff',
  gray: '#ababab',
  mutedGray: '#666666',
  dimGray: '#444444',
  green: '#10a37f',
  fontStack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

// ---------------------------------------------------------------------------
// Shared email layout wrapper
// ---------------------------------------------------------------------------
function emailLayout(bodyContent) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>Odea Works</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin:0; padding:0; background-color:${BRAND.bg}; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; font-family:${BRAND.fontStack};">
  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.bg};">
    <tr>
      <td align="center" style="padding:40px 16px 48px;">
        <!-- Inner card -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%;">
          <!-- Logo / Wordmark -->
          <tr>
            <td style="padding:0 0 40px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:18px; font-weight:700; color:${BRAND.white}; font-family:${BRAND.fontStack}; letter-spacing:-0.3px;">
                    Odea Works
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Content area -->
          <tr>
            <td style="background-color:${BRAND.cardBg}; border:1px solid ${BRAND.borderColor}; border-radius:12px;">
              ${bodyContent}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:32px 0 0 0; text-align:center;">
              <p style="margin:0 0 8px; font-size:12px; color:${BRAND.dimGray}; font-family:${BRAND.fontStack};">
                <a href="https://odeaworks.com" style="color:${BRAND.dimGray}; text-decoration:none;">odeaworks.com</a>
              </p>
              <p style="margin:0; font-size:11px; color:${BRAND.dimGray}; font-family:${BRAND.fontStack};">
                &copy; ${new Date().getFullYear()} Odea Works LLC. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Template: Contact Form Notification (to connor@odeaworks.com)
// ---------------------------------------------------------------------------
function buildContactNotificationHtml({ name, email, company, budget, projectType, message, source }) {
  const budgetLabels = {
    'under-10k': 'Under $10K',
    '10k-25k': '$10K \u2013 $25K',
    '25k-50k': '$25K \u2013 $50K',
    '50k-100k': '$50K \u2013 $100K',
    '100k-plus': '$100K+',
  };

  const sourceLabels = {
    'landing-ai-consulting': 'Landing Page: AI Consulting',
    'landing-software-development': 'Landing Page: Software Development',
    'landing-ai-strategy': 'Landing Page: AI Strategy',
  };

  const budgetDisplay = budgetLabels[budget] || budget || 'Not specified';
  const companyDisplay = company || 'Not provided';
  const projectTypeDisplay = projectType || 'Not specified';
  const sourceDisplay = sourceLabels[source] || source || 'Contact page';

  function fieldRow(label, value, opts = {}) {
    const valueColor = opts.color || BRAND.white;
    const isLink = opts.link;
    const valueHtml = isLink
      ? `<a href="mailto:${escapeHtml(value)}" style="color:${BRAND.green}; font-size:15px; text-decoration:none; font-family:${BRAND.fontStack};">${escapeHtml(value)}</a>`
      : `<span style="color:${valueColor}; font-size:15px; font-family:${BRAND.fontStack};">${escapeHtml(value)}</span>`;

    return `<tr>
      <td style="padding:14px 0; border-bottom:1px solid ${BRAND.borderColor};">
        <p style="margin:0 0 4px; color:${BRAND.mutedGray}; font-size:11px; text-transform:uppercase; letter-spacing:0.8px; font-family:${BRAND.fontStack};">${label}</p>
        ${valueHtml}
      </td>
    </tr>`;
  }

  const bodyContent = `
    <!-- Header -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:36px 40px 28px;">
          <h1 style="margin:0; font-size:22px; font-weight:600; color:${BRAND.white}; font-family:${BRAND.fontStack}; letter-spacing:-0.3px;">New Project Inquiry</h1>
        </td>
      </tr>
    </table>
    <!-- Fields -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:0 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${fieldRow('From', name)}
            ${fieldRow('Email', email, { link: true })}
            ${fieldRow('Company', companyDisplay)}
            ${fieldRow('Budget', budgetDisplay)}
            ${fieldRow('Project Type', projectTypeDisplay)}
            ${fieldRow('Source', sourceDisplay, { color: BRAND.green })}
            <tr>
              <td style="padding:14px 0 0;">
                <p style="margin:0 0 4px; color:${BRAND.mutedGray}; font-size:11px; text-transform:uppercase; letter-spacing:0.8px; font-family:${BRAND.fontStack};">Message</p>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 0 0;">
                <p style="margin:0; color:${BRAND.white}; font-size:15px; line-height:1.7; white-space:pre-wrap; font-family:${BRAND.fontStack};">${escapeHtml(message)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <!-- CTA -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:32px 40px 36px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="border-radius:8px; background-color:${BRAND.green};">
                <a href="mailto:${escapeHtml(email)}" style="display:inline-block; padding:12px 24px; color:${BRAND.white}; font-size:14px; font-weight:600; text-decoration:none; font-family:${BRAND.fontStack};">Reply to ${escapeHtml(name.split(' ')[0])}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  return emailLayout(bodyContent);
}

function buildContactNotificationText({ name, email, company, budget, projectType, message, source }) {
  const budgetLabels = {
    'under-10k': 'Under $10K',
    '10k-25k': '$10K - $25K',
    '25k-50k': '$25K - $50K',
    '50k-100k': '$50K - $100K',
    '100k-plus': '$100K+',
  };
  const sourceLabels = {
    'landing-ai-consulting': 'Landing Page: AI Consulting',
    'landing-software-development': 'Landing Page: Software Development',
    'landing-ai-strategy': 'Landing Page: AI Strategy',
  };

  return `NEW PROJECT INQUIRY
====================

From: ${name}
Email: ${email}
Company: ${company || 'Not provided'}
Budget: ${budgetLabels[budget] || budget || 'Not specified'}
Project Type: ${projectType || 'Not specified'}
Source: ${sourceLabels[source] || source || 'Contact page'}

Message:
${message}

---
Reply: mailto:${email}
Odea Works | odeaworks.com`;
}

// ---------------------------------------------------------------------------
// Template: Contact Form Auto-Reply (to the submitter)
// ---------------------------------------------------------------------------
function buildAutoReplyHtml({ name }) {
  const firstName = escapeHtml((name || '').split(' ')[0]);

  function linkRow(label, url) {
    return `<tr>
      <td style="padding:6px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="width:6px; font-size:15px; color:${BRAND.green}; font-family:${BRAND.fontStack}; vertical-align:top; padding-right:12px;">&rarr;</td>
            <td>
              <a href="${url}" style="color:${BRAND.green}; font-size:15px; text-decoration:none; font-family:${BRAND.fontStack};">${escapeHtml(label)}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }

  const bodyContent = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:40px 40px 0;">
          <h1 style="margin:0 0 24px; font-size:24px; font-weight:600; color:${BRAND.white}; font-family:${BRAND.fontStack}; letter-spacing:-0.3px;">Thanks for reaching out${firstName ? `, ${firstName}` : ''}.</h1>
          <p style="margin:0 0 20px; font-size:15px; line-height:1.7; color:${BRAND.gray}; font-family:${BRAND.fontStack};">We received your message and will get back to you within 24 hours.</p>
          <p style="margin:0 0 20px; font-size:15px; line-height:1.7; color:${BRAND.gray}; font-family:${BRAND.fontStack};">In the meantime, here are some things you might find useful:</p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:20px 0;">
            ${linkRow('View our recent work', 'https://odeaworks.com/work')}
            ${linkRow('Read our blog', 'https://odeaworks.com/blog')}
            ${linkRow('Learn about our services', 'https://odeaworks.com/services')}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 40px 40px;">
          <!-- Divider -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${BRAND.borderColor};">
            <tr>
              <td style="padding:24px 0 0;">
                <p style="margin:0; font-size:15px; line-height:1.7; color:${BRAND.gray}; font-family:${BRAND.fontStack};">Talk soon,</p>
                <p style="margin:8px 0 0; font-size:15px; font-weight:600; color:${BRAND.white}; font-family:${BRAND.fontStack};">Connor O'Dea</p>
                <p style="margin:2px 0 0; font-size:13px; color:${BRAND.mutedGray}; font-family:${BRAND.fontStack};">Founder, Odea Works</p>
                <p style="margin:12px 0 0;">
                  <a href="mailto:connor@odeaworks.com" style="color:${BRAND.green}; font-size:13px; text-decoration:none; font-family:${BRAND.fontStack};">connor@odeaworks.com</a>
                  <span style="color:${BRAND.dimGray}; font-size:13px; font-family:${BRAND.fontStack};">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>
                  <a href="https://odeaworks.com" style="color:${BRAND.green}; font-size:13px; text-decoration:none; font-family:${BRAND.fontStack};">odeaworks.com</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  return emailLayout(bodyContent);
}

function buildAutoReplyText({ name }) {
  const firstName = (name || '').split(' ')[0];
  return `Thanks for reaching out${firstName ? `, ${firstName}` : ''}.

We received your message and will get back to you within 24 hours.

In the meantime, here are some things you might find useful:

- View our recent work: https://odeaworks.com/work
- Read our blog: https://odeaworks.com/blog
- Learn about our services: https://odeaworks.com/services

Talk soon,
Connor O'Dea
Founder, Odea Works

connor@odeaworks.com
https://odeaworks.com`;
}

// ---------------------------------------------------------------------------
// Template: Subscriber Welcome Email (to new subscriber)
// ---------------------------------------------------------------------------
function buildSubscriberWelcomeHtml() {
  function bulletRow(text) {
    return `<tr>
      <td style="padding:5px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="width:6px; font-size:14px; color:${BRAND.green}; font-family:${BRAND.fontStack}; vertical-align:top; padding-right:12px;">&bull;</td>
            <td style="font-size:14px; line-height:1.6; color:${BRAND.gray}; font-family:${BRAND.fontStack};">${escapeHtml(text)}</td>
          </tr>
        </table>
      </td>
    </tr>`;
  }

  function linkRow(label, url) {
    return `<tr>
      <td style="padding:5px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="width:6px; font-size:14px; color:${BRAND.green}; font-family:${BRAND.fontStack}; vertical-align:top; padding-right:12px;">&rarr;</td>
            <td>
              <a href="${url}" style="color:${BRAND.green}; font-size:14px; text-decoration:none; font-family:${BRAND.fontStack};">${escapeHtml(label)}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }

  const bodyContent = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:40px 40px 0;">
          <h1 style="margin:0 0 24px; font-size:26px; font-weight:600; color:${BRAND.white}; font-family:${BRAND.fontStack}; letter-spacing:-0.3px;">Welcome.</h1>
          <p style="margin:0 0 24px; font-size:15px; line-height:1.7; color:${BRAND.gray}; font-family:${BRAND.fontStack};">Thanks for your interest in the AI Implementation Playbook.</p>
          <p style="margin:0 0 16px; font-size:15px; line-height:1.7; color:${BRAND.gray}; font-family:${BRAND.fontStack};">Here's what you'll find inside:</p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:4px 0 20px;">
            ${bulletRow('How to evaluate if AI is right for your business')}
            ${bulletRow('The 5-step implementation framework we use with clients')}
            ${bulletRow('Common pitfalls and how to avoid them')}
            ${bulletRow('When to build vs buy AI capabilities')}
          </table>
        </td>
      </tr>
      <!-- CTA Button -->
      <tr>
        <td style="padding:4px 40px 32px;" align="left">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="border-radius:8px; background-color:${BRAND.green};">
                <a href="https://odeaworks.com/blog" style="display:inline-block; padding:14px 28px; color:${BRAND.white}; font-size:14px; font-weight:600; text-decoration:none; font-family:${BRAND.fontStack};">Download the Playbook &rarr;</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <!-- Secondary links -->
      <tr>
        <td style="padding:0 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${BRAND.borderColor};">
            <tr>
              <td style="padding:24px 0 0;">
                <p style="margin:0 0 12px; font-size:14px; color:${BRAND.gray}; font-family:${BRAND.fontStack};">While you're here:</p>
              </td>
            </tr>
            ${linkRow('Read our latest insights', 'https://odeaworks.com/blog')}
            ${linkRow("See what we've built", 'https://odeaworks.com/work')}
          </table>
        </td>
      </tr>
      <!-- Sign-off -->
      <tr>
        <td style="padding:32px 40px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${BRAND.borderColor};">
            <tr>
              <td style="padding:24px 0 0;">
                <p style="margin:0; font-size:15px; font-weight:600; color:${BRAND.white}; font-family:${BRAND.fontStack};">Connor O'Dea</p>
                <p style="margin:2px 0 0; font-size:13px; color:${BRAND.mutedGray}; font-family:${BRAND.fontStack};">Founder, Odea Works</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  return emailLayout(bodyContent);
}

function buildSubscriberWelcomeText() {
  return `Welcome.

Thanks for your interest in the AI Implementation Playbook.

Here's what you'll find inside:

- How to evaluate if AI is right for your business
- The 5-step implementation framework we use with clients
- Common pitfalls and how to avoid them
- When to build vs buy AI capabilities

Download the Playbook: https://odeaworks.com/blog

While you're here:
- Read our latest insights: https://odeaworks.com/blog
- See what we've built: https://odeaworks.com/work

Connor O'Dea
Founder, Odea Works
https://odeaworks.com`;
}

// ---------------------------------------------------------------------------
// Template: New Subscriber Notification (to connor@odeaworks.com)
// ---------------------------------------------------------------------------
function buildSubscriberNotificationHtml({ email, source, timestamp, count }) {
  function fieldRow(label, value, opts = {}) {
    const valueColor = opts.color || BRAND.white;
    return `<tr>
      <td style="padding:12px 0; border-bottom:1px solid ${BRAND.borderColor};">
        <p style="margin:0 0 3px; color:${BRAND.mutedGray}; font-size:11px; text-transform:uppercase; letter-spacing:0.8px; font-family:${BRAND.fontStack};">${label}</p>
        <span style="color:${valueColor}; font-size:15px; font-family:${BRAND.fontStack};">${escapeHtml(String(value))}</span>
      </td>
    </tr>`;
  }

  const bodyContent = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:36px 40px 28px;">
          <h1 style="margin:0; font-size:22px; font-weight:600; color:${BRAND.white}; font-family:${BRAND.fontStack}; letter-spacing:-0.3px;">New Email Subscriber</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:0 40px 36px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${fieldRow('Email', email, { color: BRAND.green })}
            ${fieldRow('Source', source)}
            ${fieldRow('Time', timestamp)}
            <tr>
              <td style="padding:12px 0 0;">
                <p style="margin:0 0 3px; color:${BRAND.mutedGray}; font-size:11px; text-transform:uppercase; letter-spacing:0.8px; font-family:${BRAND.fontStack};">Total Subscribers</p>
                <span style="color:${BRAND.white}; font-size:20px; font-weight:600; font-family:${BRAND.fontStack};">${escapeHtml(String(count))}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  return emailLayout(bodyContent);
}

function buildSubscriberNotificationText({ email, source, timestamp, count }) {
  return `NEW EMAIL SUBSCRIBER
====================

Email: ${email}
Source: ${source}
Time: ${timestamp}
Total Subscribers: ${count}

---
Odea Works | odeaworks.com`;
}

// ---------------------------------------------------------------------------
// Subscribe handler
// ---------------------------------------------------------------------------
async function handleSubscribe(req, res) {
  const clientIP = getClientIP(req);

  // Rate limit check (5 per hour)
  if (isSubscribeRateLimited(clientIP)) {
    return jsonResponse(res, 429, { error: 'Too many requests. Please try again later.' });
  }

  // Parse JSON body
  let body = '';
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10_000) {
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

  // Honeypot check
  if (data._honey) {
    return jsonResponse(res, 200, { success: true });
  }

  const { email, source } = data;

  // Validate email
  if (!email || !email.trim()) {
    return jsonResponse(res, 400, { error: 'Email is required' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return jsonResponse(res, 400, { error: 'Invalid email address' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanSource = (source || 'unknown').trim();

  // Check for duplicate
  try {
    const existing = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8'));
    if (existing.some((s) => s.email === cleanEmail)) {
      // Already subscribed — return success silently (don't leak info)
      return jsonResponse(res, 200, { success: true });
    }
  } catch {
    // File read error — continue anyway
  }

  // Append to subscribers.json
  let subscriberCount = 0;
  try {
    let subscribers = [];
    try {
      subscribers = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8'));
    } catch {
      subscribers = [];
    }

    subscribers.push({
      email: cleanEmail,
      source: cleanSource,
      ip: clientIP,
      subscribedAt: new Date().toISOString(),
    });

    subscriberCount = subscribers.length;
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers, null, 2));
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to save subscriber:`, err);
    return jsonResponse(res, 500, { error: 'Failed to subscribe. Please try again later.' });
  }

  // Forward to CRM (fire-and-forget)
  forwardToCRM({ type: 'subscribe', name: cleanEmail.split('@')[0], email: cleanEmail, source: cleanSource });

  // Send welcome email via Resend
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: [cleanEmail],
      subject: 'Your AI Implementation Playbook \u2014 Odea Works',
      html: buildSubscriberWelcomeHtml(),
      text: buildSubscriberWelcomeText(),
    });

    console.log(`[${new Date().toISOString()}] Subscriber added + welcome email sent \u2014 email: ${cleanEmail}, source: ${cleanSource}, ip: ${clientIP}`);
  } catch (err) {
    // Log the error but don't fail — the subscription was saved
    console.error(`[${new Date().toISOString()}] Welcome email failed for ${cleanEmail}:`, err);
  }

  // Notify ourselves about new subscriber
  const now = new Date().toISOString();
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      subject: `New subscriber: ${cleanEmail}`,
      html: buildSubscriberNotificationHtml({
        email: cleanEmail,
        source: cleanSource,
        timestamp: now,
        count: subscriberCount,
      }),
      text: buildSubscriberNotificationText({
        email: cleanEmail,
        source: cleanSource,
        timestamp: now,
        count: subscriberCount,
      }),
    });
  } catch {
    // Non-critical — ignore
  }

  return jsonResponse(res, 200, { success: true });
}

// ---------------------------------------------------------------------------
// Unsubscribe Handler
// ---------------------------------------------------------------------------
async function handleUnsubscribe(req, res) {
  const clientIP = getClientIP(req);

  // Rate limit check (use subscribe rate limiter — same generosity)
  if (isSubscribeRateLimited(clientIP)) {
    return jsonResponse(res, 429, { error: 'Too many requests. Please try again later.' });
  }

  // Parse JSON body
  let body = '';
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10_000) {
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

  const { email } = data;

  // Validate email
  if (!email || !email.trim()) {
    return jsonResponse(res, 400, { error: 'Email is required', message: 'Please provide your email address.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return jsonResponse(res, 400, { error: 'Invalid email address', message: 'Please provide a valid email address.' });
  }

  const cleanEmail = email.trim().toLowerCase();

  // Remove from subscribers.json
  try {
    let subscribers = [];
    try {
      subscribers = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8'));
    } catch {
      subscribers = [];
    }

    const originalCount = subscribers.length;
    subscribers = subscribers.filter((s) => s.email !== cleanEmail);

    if (subscribers.length === originalCount) {
      // Email not found — return success anyway (don't leak info)
      console.log(`[${new Date().toISOString()}] Unsubscribe request for unknown email: ${cleanEmail}, ip: ${clientIP}`);
      return jsonResponse(res, 200, { success: true, message: 'You have been unsubscribed.' });
    }

    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers, null, 2));
    console.log(`[${new Date().toISOString()}] Unsubscribed: ${cleanEmail}, ip: ${clientIP}, remaining: ${subscribers.length}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to process unsubscribe:`, err);
    return jsonResponse(res, 500, { error: 'Failed to unsubscribe. Please try again later.', message: 'Something went wrong. Please try again or email connor@odeaworks.com.' });
  }

  // Notify ourselves
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      subject: `Unsubscribed: ${cleanEmail}`,
      text: `${cleanEmail} has unsubscribed from the newsletter.\n\nTimestamp: ${new Date().toISOString()}\nIP: ${clientIP}`,
    });
  } catch {
    // Non-critical
  }

  return jsonResponse(res, 200, { success: true, message: 'You have been unsubscribed.' });
}

// ---------------------------------------------------------------------------
// Template: Booking Confirmation (to the booker)
// ---------------------------------------------------------------------------
function buildBookingConfirmationHtml({ name, date, timeSlot }) {
  const firstName = escapeHtml((name || '').split(' ')[0]);

  function linkRow(label, url) {
    return `<tr>
      <td style="padding:6px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="width:6px; font-size:15px; color:${BRAND.green}; font-family:${BRAND.fontStack}; vertical-align:top; padding-right:12px;">&rarr;</td>
            <td>
              <a href="${url}" style="color:${BRAND.green}; font-size:15px; text-decoration:none; font-family:${BRAND.fontStack};">${escapeHtml(label)}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }

  const bodyContent = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:40px 40px 0;">
          <h1 style="margin:0 0 24px; font-size:24px; font-weight:600; color:${BRAND.white}; font-family:${BRAND.fontStack}; letter-spacing:-0.3px;">Your discovery call is confirmed.</h1>
          <p style="margin:0 0 20px; font-size:15px; line-height:1.7; color:${BRAND.gray}; font-family:${BRAND.fontStack};">Hi ${firstName},</p>
          <p style="margin:0 0 20px; font-size:15px; line-height:1.7; color:${BRAND.gray}; font-family:${BRAND.fontStack};">Your 30-minute discovery call is confirmed:</p>
        </td>
      </tr>
      <!-- Call details card -->
      <tr>
        <td style="padding:0 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.bg}; border:1px solid ${BRAND.borderColor}; border-radius:8px;">
            <tr>
              <td style="padding:20px 24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:0 0 12px;">
                      <p style="margin:0 0 3px; color:${BRAND.mutedGray}; font-size:11px; text-transform:uppercase; letter-spacing:0.8px; font-family:${BRAND.fontStack};">Date</p>
                      <span style="color:${BRAND.white}; font-size:16px; font-weight:600; font-family:${BRAND.fontStack};">${escapeHtml(date)}</span>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0;">
                      <p style="margin:0 0 3px; color:${BRAND.mutedGray}; font-size:11px; text-transform:uppercase; letter-spacing:0.8px; font-family:${BRAND.fontStack};">Time</p>
                      <span style="color:${BRAND.white}; font-size:16px; font-weight:600; font-family:${BRAND.fontStack};">${escapeHtml(timeSlot)}</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 40px 0;">
          <p style="margin:0 0 20px; font-size:15px; line-height:1.7; color:${BRAND.gray}; font-family:${BRAND.fontStack};">I'll send a Google Meet link before the call. If you need to reschedule, just reply to this email.</p>
          <p style="margin:0 0 12px; font-size:15px; line-height:1.7; color:${BRAND.gray}; font-family:${BRAND.fontStack};">In the meantime, you might find these useful:</p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:8px 0 20px;">
            ${linkRow('Our recent work', 'https://odeaworks.com/work')}
            ${linkRow('Our approach', 'https://odeaworks.com/about')}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:0 40px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${BRAND.borderColor};">
            <tr>
              <td style="padding:24px 0 0;">
                <p style="margin:0; font-size:15px; line-height:1.7; color:${BRAND.gray}; font-family:${BRAND.fontStack};">Looking forward to it.</p>
                <p style="margin:8px 0 0; font-size:15px; font-weight:600; color:${BRAND.white}; font-family:${BRAND.fontStack};">Connor O'Dea</p>
                <p style="margin:2px 0 0; font-size:13px; color:${BRAND.mutedGray}; font-family:${BRAND.fontStack};">Founder, Odea Works</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  return emailLayout(bodyContent);
}

function buildBookingConfirmationText({ name, date, timeSlot }) {
  const firstName = (name || '').split(' ')[0];
  return `Hi ${firstName},

Your 30-minute discovery call is confirmed:

Date: ${date}
Time: ${timeSlot}

I'll send a Google Meet link before the call. If you need to reschedule, just reply to this email.

In the meantime, you might find these useful:
- Our recent work: https://odeaworks.com/work
- Our approach: https://odeaworks.com/about

Looking forward to it.

Connor O'Dea
Founder, Odea Works`;
}

// ---------------------------------------------------------------------------
// Template: Booking Notification (to connor@odeaworks.com)
// ---------------------------------------------------------------------------
function buildBookingNotificationHtml({ name, email, company, date, timeSlot, project }) {
  const companyDisplay = company || 'Not provided';

  function fieldRow(label, value, opts = {}) {
    const valueColor = opts.color || BRAND.white;
    const isLink = opts.link;
    const valueHtml = isLink
      ? `<a href="mailto:${escapeHtml(value)}" style="color:${BRAND.green}; font-size:15px; text-decoration:none; font-family:${BRAND.fontStack};">${escapeHtml(value)}</a>`
      : `<span style="color:${valueColor}; font-size:15px; font-family:${BRAND.fontStack};">${escapeHtml(value)}</span>`;

    return `<tr>
      <td style="padding:14px 0; border-bottom:1px solid ${BRAND.borderColor};">
        <p style="margin:0 0 4px; color:${BRAND.mutedGray}; font-size:11px; text-transform:uppercase; letter-spacing:0.8px; font-family:${BRAND.fontStack};">${label}</p>
        ${valueHtml}
      </td>
    </tr>`;
  }

  const bodyContent = `
    <!-- Header -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:36px 40px 28px;">
          <h1 style="margin:0; font-size:22px; font-weight:600; color:${BRAND.white}; font-family:${BRAND.fontStack}; letter-spacing:-0.3px;">New Discovery Call Booked</h1>
        </td>
      </tr>
    </table>
    <!-- Fields -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:0 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${fieldRow('Name', name)}
            ${fieldRow('Email', email, { link: true })}
            ${fieldRow('Company', companyDisplay)}
            ${fieldRow('Date', date)}
            ${fieldRow('Time', timeSlot, { color: BRAND.green })}
            <tr>
              <td style="padding:14px 0 0;">
                <p style="margin:0 0 4px; color:${BRAND.mutedGray}; font-size:11px; text-transform:uppercase; letter-spacing:0.8px; font-family:${BRAND.fontStack};">Project</p>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 0 0;">
                <p style="margin:0; color:${BRAND.white}; font-size:15px; line-height:1.7; white-space:pre-wrap; font-family:${BRAND.fontStack};">${escapeHtml(project)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <!-- CTA -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:32px 40px 36px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="border-radius:8px; background-color:${BRAND.green};">
                <a href="mailto:${escapeHtml(email)}" style="display:inline-block; padding:12px 24px; color:${BRAND.white}; font-size:14px; font-weight:600; text-decoration:none; font-family:${BRAND.fontStack};">Reply to ${escapeHtml(name.split(' ')[0])}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  return emailLayout(bodyContent);
}

function buildBookingNotificationText({ name, email, company, date, timeSlot, project }) {
  return `NEW DISCOVERY CALL BOOKED
=========================

Name: ${name}
Email: ${email}
Company: ${company || 'Not provided'}
Date: ${date}
Time: ${timeSlot}

Project:
${project}

---
Reply: mailto:${email}
Odea Works | odeaworks.com`;
}

// ---------------------------------------------------------------------------
// Booking handler
// ---------------------------------------------------------------------------
async function handleBooking(req, res) {
  const clientIP = getClientIP(req);

  // Rate limit check (3 per hour)
  if (isBookingRateLimited(clientIP)) {
    return jsonResponse(res, 429, { error: 'Too many requests. Please try again later.' });
  }

  // Parse JSON body
  let body = '';
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        body += chunk;
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

  // Honeypot check
  if (data._honey) {
    return jsonResponse(res, 200, { success: true });
  }

  // Validate required fields
  const { name, email, project, date, timeSlot } = data;
  if (!name || !name.trim()) {
    return jsonResponse(res, 400, { error: 'Name is required' });
  }
  if (!email || !email.trim()) {
    return jsonResponse(res, 400, { error: 'Email is required' });
  }
  if (!project || !project.trim()) {
    return jsonResponse(res, 400, { error: 'Project description is required' });
  }
  if (!date || !date.trim()) {
    return jsonResponse(res, 400, { error: 'Preferred date is required' });
  }
  if (!timeSlot || !timeSlot.trim()) {
    return jsonResponse(res, 400, { error: 'Preferred time is required' });
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return jsonResponse(res, 400, { error: 'Invalid email address' });
  }

  // Build clean data
  const bookingData = {
    name: name.trim(),
    email: email.trim(),
    company: (data.company || '').trim(),
    project: project.trim(),
    date: date.trim(),
    timeSlot: timeSlot.trim(),
    ip: clientIP,
    bookedAt: new Date().toISOString(),
  };

  // Save booking to bookings.json
  try {
    let bookings = [];
    try {
      bookings = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8'));
    } catch {
      bookings = [];
    }

    bookings.push(bookingData);
    fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to save booking:`, err);
    return jsonResponse(res, 500, { error: 'Failed to save booking. Please try again later.' });
  }

  // Forward to CRM (fire-and-forget)
  forwardToCRM({
    type: 'booking',
    name: bookingData.name,
    email: bookingData.email,
    company: bookingData.company || '',
    source: 'booking-form',
    message: bookingData.project,
    date: bookingData.date,
    timeSlot: bookingData.timeSlot,
  });

  // Send confirmation email to the booker
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: [email.trim()],
      replyTo: TO_EMAIL,
      subject: 'Your discovery call is confirmed \u2014 Odea Works',
      html: buildBookingConfirmationHtml(bookingData),
      text: buildBookingConfirmationText(bookingData),
    });

    console.log(`[${new Date().toISOString()}] Booking confirmation sent to ${email.trim()}`);
  } catch (err) {
    // Non-critical — log but don't fail
    console.error(`[${new Date().toISOString()}] Booking confirmation email failed for ${email.trim()}:`, err);
  }

  // Send notification to Connor
  try {
    const companyTag = bookingData.company ? ` (${bookingData.company})` : '';
    await resend.emails.send({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      replyTo: email.trim(),
      subject: `New discovery call booked \u2014 ${bookingData.name}${companyTag}`,
      html: buildBookingNotificationHtml(bookingData),
      text: buildBookingNotificationText(bookingData),
    });

    console.log(`[${new Date().toISOString()}] Booking notification sent \u2014 from: ${email.trim()}, name: ${name.trim()}, date: ${date.trim()}, time: ${timeSlot.trim()}, ip: ${clientIP}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Booking notification email failed:`, err);
    // Still return success — the booking is saved even if notification fails
  }

  return jsonResponse(res, 200, { success: true });
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

  // Route: POST /api/subscribe
  if (req.method === 'POST' && req.url === '/api/subscribe') {
    return handleSubscribe(req, res);
  }

  // Route: POST /api/unsubscribe
  if (req.method === 'POST' && req.url === '/api/unsubscribe') {
    return handleUnsubscribe(req, res);
  }

  // Route: POST /api/book
  if (req.method === 'POST' && req.url === '/api/book') {
    return handleBooking(req, res);
  }

  // Route: POST /api/contact
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

  // Build template data
  const templateData = {
    name: name.trim(),
    email: email.trim(),
    company: (data.company || '').trim(),
    budget: (data.budget || '').trim(),
    projectType: (data.projectType || '').trim(),
    message: message.trim(),
    source: (data.source || '').trim(),
  };

  // Forward to CRM (fire-and-forget)
  forwardToCRM({
    type: 'contact',
    name: templateData.name,
    email: templateData.email,
    company: templateData.company,
    source: templateData.source,
    budget: templateData.budget,
    projectType: templateData.projectType,
    message: templateData.message,
  });

  // Send notification email to connor@odeaworks.com
  try {
    const companyTag = data.company ? ` (${data.company.trim()})` : '';
    const isLanding = data.source && data.source.startsWith('landing-');
    const subjectPrefix = isLanding ? '[Ad Lead] ' : '';

    await resend.emails.send({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      replyTo: email.trim(),
      subject: `${subjectPrefix}New inquiry from ${name.trim()}${companyTag}`,
      html: buildContactNotificationHtml(templateData),
      text: buildContactNotificationText(templateData),
    });

    const sourceTag = data.source ? ` [${data.source}]` : '';
    console.log(`[${new Date().toISOString()}] Contact notification sent \u2014 from: ${email.trim()}, name: ${name.trim()}, ip: ${clientIP}${sourceTag}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Resend error (notification):`, err);
    return jsonResponse(res, 500, { error: 'Failed to send message. Please try again later.' });
  }

  // Send auto-reply to the submitter
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: [email.trim()],
      subject: 'Thanks for reaching out \u2014 Odea Works',
      html: buildAutoReplyHtml({ name: name.trim() }),
      text: buildAutoReplyText({ name: name.trim() }),
    });

    console.log(`[${new Date().toISOString()}] Auto-reply sent to ${email.trim()}`);
  } catch (err) {
    // Auto-reply failure is non-critical — don't fail the whole request
    console.error(`[${new Date().toISOString()}] Auto-reply failed for ${email.trim()}:`, err);
  }

  return jsonResponse(res, 200, { success: true });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[odeaworks-contact-api] Listening on 127.0.0.1:${PORT}`);
});
