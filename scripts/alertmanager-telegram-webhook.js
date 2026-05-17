#!/usr/bin/env node
'use strict';

/**
 * Alertmanager → Telegram webhook bridge
 * Listens on localhost:9094/webhook, forwards to Telegram Bot API.
 * Zero external dependencies — uses built-in http/https modules only.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN   — required
 *   TELEGRAM_CHAT_ID     — required
 *   WEBHOOK_PORT         — default 9094
 *   WEBHOOK_SECRET       — optional bearer token for basic auth
 */

const http  = require('http');
const https = require('https');

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN  || '';
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID    || '';
const PORT       = parseInt(process.env.WEBHOOK_PORT || '9094', 10);
const SECRET     = process.env.WEBHOOK_SECRET       || '';

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('[telegram-webhook] FATAL: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
  process.exit(1);
}

// ── Telegram sender ───────────────────────────────────────────────────────────

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id:    CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`Telegram API ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Telegram request timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Message formatter ─────────────────────────────────────────────────────────

const SEVERITY_EMOJI = { critical: '🔴', warning: '🟡', info: 'ℹ️' };

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatAlert(payload) {
  const isFiring   = payload.status === 'firing';
  const statusIcon = isFiring ? '🔴 FIRING' : '🟢 RESOLVED';
  const alerts     = payload.alerts || [];

  const lines = [`<b>${statusIcon}</b> — ${escapeHTML(payload.commonLabels?.alertname || 'Alert')}`];

  const severity = payload.commonLabels?.severity || '';
  if (severity) {
    const sev = (SEVERITY_EMOJI[severity] || '') + ' ' + severity.toUpperCase();
    lines.push(`Severity: ${escapeHTML(sev)}`);
  }

  const team = payload.commonLabels?.team || '';
  if (team) lines.push(`Team: ${escapeHTML(team)}`);

  lines.push('');

  for (const alert of alerts.slice(0, 5)) {
    const inst    = alert.labels?.instance || '';
    const summary = alert.annotations?.summary || '';
    const desc    = alert.annotations?.description || '';

    if (inst)    lines.push(`<b>Instance:</b> ${escapeHTML(inst)}`);
    if (summary) lines.push(`📋 ${escapeHTML(summary)}`);
    if (desc)    lines.push(`   ${escapeHTML(desc)}`);
    if (alerts.length > 1) lines.push('');
  }

  if (alerts.length > 5) {
    lines.push(`<i>… y ${alerts.length - 5} alertas más</i>`);
  }

  return lines.join('\n');
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  if (SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${SECRET}`) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) { req.destroy(); }
  });

  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end('Bad JSON');
      return;
    }

    res.writeHead(200);
    res.end('OK');

    const text = formatAlert(payload);
    const alertname = payload.commonLabels?.alertname || 'unknown';
    const status    = payload.status || 'unknown';

    try {
      await sendTelegram(text);
      console.log(`[telegram-webhook] sent alert=${alertname} status=${status}`);
    } catch (err) {
      console.error(`[telegram-webhook] ERROR sending alert=${alertname}:`, err.message);
    }
  });

  req.on('error', (err) => {
    console.error('[telegram-webhook] request error:', err.message);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[telegram-webhook] listening on 127.0.0.1:${PORT}`);
  console.log(`[telegram-webhook] TELEGRAM_CHAT_ID=${CHAT_ID}`);
});

server.on('error', (err) => {
  console.error('[telegram-webhook] server error:', err.message);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[telegram-webhook] SIGTERM — shutting down');
  server.close(() => process.exit(0));
});
