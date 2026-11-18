const Settings = require('../../models/settings');
const config = require('../../config');
const logger = require('../../logger');

/**
 * Alert email via Resend (https://resend.com/docs/api-reference/emails/send-email).
 *
 * Batching: alerts are queued and flushed FLUSH_DELAY_MS after the first one,
 * so a host running out of memory — which usually trips memory, swap, OOM and
 * a crash loop together — becomes one email, not four.
 *
 * Rate cap: at most MAX_EMAILS_PER_HOUR. Past the cap the queue is held (not
 * dropped) and goes out as a single digest once the window allows.
 *
 * Settings (dashboard → Health → Alert settings), env vars as fallback:
 *   monitor_email_enabled    'true' | 'false'
 *   monitor_email_to         comma-separated addresses   (ALERT_EMAIL_TO)
 *   monitor_email_from       verified Resend sender      (ALERT_EMAIL_FROM)
 *   resend_api_key           secret, masked in the API   (RESEND_API_KEY)
 *   monitor_email_min_severity 'warning' | 'critical'
 */

const FLUSH_DELAY_MS = 30_000;
const MAX_EMAILS_PER_HOUR = 12;
const RESEND_URL = 'https://api.resend.com/emails';

let queue = [];
let timer = null;
const sentAt = [];
const RANK = { warning: 1, critical: 2 };

async function getEmailConfig() {
  const s = await Settings.getAll();
  const to = (s.monitor_email_to || process.env.ALERT_EMAIL_TO || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  return {
    enabled: s.monitor_email_enabled === 'true',
    to,
    from: s.monitor_email_from || process.env.ALERT_EMAIL_FROM || '',
    apiKey: s.resend_api_key || process.env.RESEND_API_KEY || '',
    minSeverity: s.monitor_email_min_severity === 'critical' ? 'critical' : 'warning',
    instanceName: s.instance_name || config.domain || 'beachhead',
  };
}

function enqueue(item) {
  queue.push(item);
  if (!timer) {
    timer = setTimeout(() => { timer = null; flush().catch((e) => logger.error(`Monitor email flush failed: ${e.message}`)); }, FLUSH_DELAY_MS);
    timer.unref?.();
  }
}

async function flush() {
  if (!queue.length) return;
  const cfg = await getEmailConfig();
  if (!cfg.enabled || !cfg.apiKey || !cfg.from || !cfg.to.length) {
    queue = [];
    return;
  }

  const now = Date.now();
  while (sentAt.length && now - sentAt[0] > 3600_000) sentAt.shift();
  if (sentAt.length >= MAX_EMAILS_PER_HOUR) {
    // Hold the queue and try again when the oldest send ages out.
    const wait = 3600_000 - (now - sentAt[0]) + 1000;
    logger.warn(`Monitor email: hourly cap reached, holding ${queue.length} item(s) for ${Math.round(wait / 60000)} min`);
    if (!timer) { timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, wait); timer.unref?.(); }
    return;
  }

  const items = queue;
  queue = [];
  const min = RANK[cfg.minSeverity];
  const worthSending = items.filter((i) => {
    if (i.type === 'resolved') return Boolean(i.alert.notified_severity);
    return RANK[i.alert.severity] >= min;
  });
  if (!worthSending.length) return;

  const { subject, html, text } = render(cfg.instanceName, worthSending);
  try {
    await send(cfg, { subject, html, text });
    sentAt.push(Date.now());
    // Record what you were told, so a later resolve knows to tell you too.
    const Monitor = require('../../models/monitor');
    for (const i of worthSending) {
      if (i.type === 'resolved') continue;
      await Monitor.markNotified(i.alert.id, i.alert.severity);
      // Same object the alert manager holds in memory, so its later resolve
      // sees that this alert was emailed.
      i.alert.notified_severity = i.alert.severity;
    }
  } catch (err) {
    // Put them back: a Resend outage shouldn't lose the alert that matters.
    logger.error(`Monitor email send failed: ${err.message}`);
    queue = worthSending.concat(queue);
    if (!timer) { timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, 5 * 60_000); timer.unref?.(); }
  }
}

async function send(cfg, { subject, html, text }) {
  let res;
  try {
    res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: cfg.to, subject, html, text }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (cause) {
    // Network-level: DNS, no route out, timeout. Retryable, not a config error.
    const err = new Error(`Could not reach Resend (${cause.cause?.code || cause.name || cause.message})`);
    err.status = 502;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
    // 4xx is configuration (bad key, unverified sender) — say so plainly.
    err.status = res.status >= 400 && res.status < 500 ? 400 : 502;
    throw err;
  }
  return res.json().catch(() => ({}));
}

async function sendTest() {
  const cfg = await getEmailConfig();
  const missing = [];
  if (!cfg.apiKey) missing.push('Resend API key');
  if (!cfg.from) missing.push('from address');
  if (!cfg.to.length) missing.push('recipient');
  if (missing.length) {
    const err = new Error(`Email not configured: missing ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }
  return send(cfg, {
    subject: `[${cfg.instanceName}] Test alert from Beachhead`,
    text: `Alert email is working for ${cfg.instanceName}.`,
    html: `<p>Alert email is working for <strong>${esc(cfg.instanceName)}</strong>.</p>`,
  });
}

function render(instance, items) {
  const opened = items.filter((i) => i.type !== 'resolved');
  const resolved = items.filter((i) => i.type === 'resolved');
  const worst = opened.some((i) => i.alert.severity === 'critical') ? 'CRITICAL'
    : opened.length ? 'WARNING' : 'RESOLVED';
  const lead = (opened[0] || resolved[0]).alert.message;
  const more = items.length > 1 ? ` (+${items.length - 1} more)` : '';
  const subject = `[${instance}] ${worst}: ${lead}${more}`;

  const line = (i) => {
    const tag = i.type === 'resolved' ? 'RESOLVED' : i.type === 'escalated' ? `${i.alert.severity.toUpperCase()} (escalated)` : i.alert.severity.toUpperCase();
    return { tag, msg: i.alert.message, since: new Date(i.alert.opened_at).toLocaleString('en-US', { timeZone: process.env.TZ || 'America/Chicago' }) };
  };
  const rows = [...opened, ...resolved].map(line);
  const dash = config.domain ? `https://${config.domain}/monitor` : '';

  const text = rows.map((r) => `${r.tag}  ${r.msg}  (since ${r.since})`).join('\n') + (dash ? `\n\n${dash}` : '');
  const color = { CRITICAL: '#b91c1c', WARNING: '#b45309', RESOLVED: '#047857' };
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px">
<p style="margin:0 0 12px"><strong>${esc(instance)}</strong></p>
<table cellpadding="6" style="border-collapse:collapse">${rows.map((r) => {
    const c = color[r.tag.split(' ')[0]] || '#333';
    return `<tr><td style="color:${c};font-weight:600;white-space:nowrap">${esc(r.tag)}</td><td>${esc(r.msg)}</td><td style="color:#666;white-space:nowrap">since ${esc(r.since)}</td></tr>`;
  }).join('')}</table>
${dash ? `<p style="margin-top:16px"><a href="${dash}">Open the Health page</a></p>` : ''}</div>`;
  return { subject, html, text };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

module.exports = { enqueue, flush, sendTest, getEmailConfig, _render: render };
