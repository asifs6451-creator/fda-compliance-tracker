const cron = require('node-cron');
const nodemailer = require('nodemailer');
const db = require('./database');

/* ── helpers ── */
function todayIST() {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().split('T')[0];
}

function getTransporter() {
  const { SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function getConfig(type) {
  const row = db.prepare('SELECT * FROM alert_config WHERE alert_type=?').get(type);
  if (!row) return null;
  try { return { ...row, recipients: JSON.parse(row.recipients || '[]') }; }
  catch { return { ...row, recipients: [] }; }
}

/* ── build dashboard snapshot ── */
function buildSnapshot(date) {
  const totalItems = db.prepare('SELECT COUNT(*) as c FROM checklist_items').get().c;
  return db.prepare('SELECT * FROM warehouses WHERE is_active=1 ORDER BY name').all().map(w => {
    const s = db.prepare(`
      SELECT
        COUNT(dc.id)                                         AS filled,
        SUM(CASE WHEN dc.status='yes' THEN 1 ELSE 0 END)    AS yes_c,
        SUM(CASE WHEN dc.status='no'  THEN 1 ELSE 0 END)    AS no_c,
        MAX(dc.checked_by)                                   AS by_whom
      FROM daily_compliance dc
      WHERE dc.warehouse_id=? AND dc.compliance_date=?
    `).get(w.id, date);
    return {
      name: w.name, code: w.location_code,
      total: totalItems,
      filled: s.filled || 0,
      yes: s.yes_c || 0,
      no: s.no_c || 0,
      by: s.by_whom || '—',
    };
  });
}

/* ── email templates ── */
function summaryHtml(date, rows) {
  const complete = rows.filter(r => r.filled === r.total && r.no === 0).length;
  const withIssue = rows.filter(r => r.no > 0).length;
  const notFilled = rows.filter(r => r.filled === 0).length;

  const rowsHtml = rows.map(r => {
    const pct = r.total ? Math.round(r.yes / r.total * 100) : 0;
    const badge = r.filled === 0 ? '🔴 Not filled'
      : r.no > 0 ? '⚠️ Has issues'
      : r.filled < r.total ? '🟡 Partial'
      : '✅ Complete';
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600">${r.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center">${r.filled}/${r.total}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:#16a34a">${r.yes}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:#dc2626">${r.no}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center">${pct}%</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${badge}</td>
    </tr>`;
  }).join('');

  return `
  <div style="font-family:Arial,sans-serif;max-width:700px;margin:auto">
    <div style="background:#1a2e4a;color:white;padding:20px 28px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">📊 FDA Compliance Daily Summary</h2>
      <p style="margin:4px 0 0;opacity:.8;font-size:13px">${date}</p>
    </div>
    <div style="background:#f8fafc;padding:16px 28px;border:1px solid #e5e7eb">
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        <div style="text-align:center;padding:12px 20px;background:white;border-radius:8px;border:1px solid #d1fae5">
          <div style="font-size:28px;font-weight:800;color:#16a34a">${complete}</div>
          <div style="font-size:12px;color:#64748b">Fully Compliant</div>
        </div>
        <div style="text-align:center;padding:12px 20px;background:white;border-radius:8px;border:1px solid #fef3c7">
          <div style="font-size:28px;font-weight:800;color:#d97706">${withIssue}</div>
          <div style="font-size:12px;color:#64748b">Has Issues</div>
        </div>
        <div style="text-align:center;padding:12px 20px;background:white;border-radius:8px;border:1px solid #fee2e2">
          <div style="font-size:28px;font-weight:800;color:#dc2626">${notFilled}</div>
          <div style="font-size:12px;color:#64748b">Not Filled</div>
        </div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;background:white;border:1px solid #e5e7eb;border-top:none">
      <thead>
        <tr style="background:#f1f5f9">
          <th style="padding:10px 12px;text-align:left;font-size:12px;color:#475569">LOCATION</th>
          <th style="padding:10px 12px;text-align:center;font-size:12px;color:#475569">FILLED</th>
          <th style="padding:10px 12px;text-align:center;font-size:12px;color:#16a34a">YES</th>
          <th style="padding:10px 12px;text-align:center;font-size:12px;color:#dc2626">NO</th>
          <th style="padding:10px 12px;text-align:center;font-size:12px;color:#475569">SCORE</th>
          <th style="padding:10px 12px;text-align:left;font-size:12px;color:#475569">STATUS</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div style="padding:12px 28px;background:#f8fafc;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;font-size:11px;color:#94a3b8;text-align:center">
      FDA Compliance Tracker · Auto-generated summary
    </div>
  </div>`;
}

function reminderHtml(warehouseName, date) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto">
    <div style="background:#dc2626;color:white;padding:20px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:16px">⚠️ FDA Checklist Not Filled</h2>
    </div>
    <div style="background:white;padding:20px 24px;border:1px solid #e5e7eb">
      <p style="margin:0 0 12px;font-size:14px;color:#1e293b">
        The FDA compliance checklist for <strong>${warehouseName}</strong> has <strong>not been filled</strong> for today.
      </p>
      <p style="margin:0 0 16px;font-size:13px;color:#64748b">Date: ${date}</p>
      <p style="margin:0;font-size:13px;color:#64748b">
        Please log in to the FDA Compliance Tracker and complete the daily checklist as soon as possible.
      </p>
    </div>
    <div style="background:#f8fafc;padding:10px 24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;font-size:11px;color:#94a3b8;text-align:center">
      FDA Compliance Tracker · Automated Reminder
    </div>
  </div>`;
}

/* ── send email ── */
async function sendMail({ to, subject, html }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[Alerts] Email not configured. Would have sent to: ${to} — ${subject}`);
    return;
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `FDA Compliance Tracker <${process.env.SMTP_USER}>`,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    html,
  });
  console.log(`[Alerts] Email sent → ${to}`);
}

/* ── send reminder to unfilled locations ── */
async function sendReminders() {
  const cfg = getConfig('reminder');
  if (!cfg?.is_active) return;
  const date = todayIST();
  const snapshot = buildSnapshot(date);
  const unfilled = snapshot.filter(r => r.filled === 0);
  console.log(`[Alerts] Reminder check: ${unfilled.length} locations not filled for ${date}`);

  for (const loc of unfilled) {
    // Find pharmacist emails for this location
    const wh = db.prepare('SELECT id FROM warehouses WHERE name=?').get(loc.name);
    const pharmacists = wh
      ? db.prepare(`SELECT email FROM users WHERE warehouse_id=? AND role='pharmacist' AND is_active=1 AND email!=''`).all(wh.id)
      : [];
    const emailList = [...pharmacists.map(p => p.email), ...cfg.recipients].filter(Boolean);
    if (!emailList.length) continue;
    await sendMail({
      to: emailList,
      subject: `⚠️ FDA Checklist Not Filled — ${loc.name} — ${date}`,
      html: reminderHtml(loc.name, date),
    });
  }
  db.prepare(`UPDATE alert_config SET last_sent=datetime('now') WHERE alert_type='reminder'`).run();
}

/* ── send daily summary ── */
async function sendSummary() {
  const cfg = getConfig('summary');
  if (!cfg?.is_active || !cfg.recipients.length) return;
  const date = todayIST();
  const snapshot = buildSnapshot(date);
  await sendMail({
    to: cfg.recipients,
    subject: `📊 FDA Daily Compliance Summary — ${date}`,
    html: summaryHtml(date, snapshot),
  });
  db.prepare(`UPDATE alert_config SET last_sent=datetime('now') WHERE alert_type='summary'`).run();
}

/* ── schedule cron jobs ── */
function initCron() {
  // Every minute: check if it's time for reminder or summary
  cron.schedule('* * * * *', () => {
    const now = new Date(Date.now() + 5.5 * 3600000); // IST
    const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    const remCfg = getConfig('reminder');
    const sumCfg = getConfig('summary');

    if (remCfg?.is_active && remCfg.send_time === hhmm) sendReminders().catch(console.error);
    if (sumCfg?.is_active && sumCfg.send_time === hhmm) sendSummary().catch(console.error);
  });
  console.log('[Alerts] Cron scheduler started');
}

module.exports = { initCron, sendReminders, sendSummary, buildSnapshot, getConfig };
