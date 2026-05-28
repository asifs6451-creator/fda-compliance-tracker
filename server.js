require('dotenv').config({ path: '.env' });

const express      = require('express');
const session      = require('express-session');
const MemoryStore  = require('memorystore')(session);
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const bcrypt       = require('bcryptjs');
const db           = require('./database');
const { requireAuth, requireRole, warehouseFilter } = require('./auth');
const { initCron, sendReminders, sendSummary, buildSnapshot, getConfig } = require('./alerts');

const app     = express();
const PORT    = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

/* ── Cloudinary (optional) ── */
let cloudinary;
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log('[Storage] Cloudinary enabled');
}

/* ── Upload ── */
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g,'_')}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_, file, cb) =>
    /image\/(jpeg|png|gif|webp)|application\/pdf/.test(file.mimetype)
      ? cb(null, true) : cb(new Error('Images/PDFs only'))
});

/* ── Middleware ── */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', requireAuth, express.static(uploadsDir));

app.use(session({
  secret: process.env.SESSION_SECRET || 'fda-tracker-secret-2024',
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({ checkPeriod: 86400000 }),
  cookie: { maxAge: 86400000, secure: IS_PROD, httpOnly: true, sameSite: 'lax' },
}));

/* ── Helpers ── */
function todayIST() {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().split('T')[0];
}

async function saveToCloud(localPath, publicId) {
  if (!cloudinary) return null;
  try {
    const result = await cloudinary.uploader.upload(localPath, {
      folder: 'fda-compliance',
      public_id: publicId,
      resource_type: 'auto',
    });
    fs.unlink(localPath, () => {});
    return { url: result.secure_url, public_id: result.public_id };
  } catch (e) {
    console.error('[Cloudinary]', e.message);
    return null;
  }
}

/* ════════════════════════════════════
   AUTH
════════════════════════════════════ */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  const user = db.prepare('SELECT * FROM users WHERE username=? AND is_active=1').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.user = {
    id: user.id, username: user.username, full_name: user.full_name,
    role: user.role, email: user.email, warehouse_id: user.warehouse_id
  };
  res.json({ user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

/* ════════════════════════════════════
   USERS (admin only)
════════════════════════════════════ */
app.get('/api/users', requireAuth, requireRole('admin','manager'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.role, u.email, u.warehouse_id,
           u.is_active, u.created_at, w.name as warehouse_name
    FROM users u LEFT JOIN warehouses w ON w.id=u.warehouse_id
    ORDER BY u.role, u.full_name
  `).all();
  res.json(rows);
});

app.post('/api/users', requireAuth, requireRole('admin'), (req, res) => {
  const { username, password, full_name, role, email, warehouse_id } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare(`
      INSERT INTO users (username,password,full_name,role,email,warehouse_id) VALUES (?,?,?,?,?,?)
    `).run(username.trim(), hash, full_name||'', role||'pharmacist', email||'', warehouse_id||null);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Username already exists' : e.message });
  }
});

app.put('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const { full_name, role, email, warehouse_id, is_active, password } = req.body;
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`UPDATE users SET password=? WHERE id=?`).run(hash, req.params.id);
  }
  db.prepare(`UPDATE users SET full_name=?,role=?,email=?,warehouse_id=?,is_active=? WHERE id=?`)
    .run(full_name, role, email||'', warehouse_id||null, is_active, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (req.session.user.id == req.params.id) return res.status(400).json({ error: "Can't delete yourself" });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ════════════════════════════════════
   WAREHOUSES
════════════════════════════════════ */
app.get('/api/warehouses', requireAuth, (req, res) => {
  const wf = warehouseFilter(req);
  const sql = wf
    ? 'SELECT * FROM warehouses WHERE id=? ORDER BY name'
    : 'SELECT * FROM warehouses ORDER BY is_active DESC, name';
  res.json(wf ? db.prepare(sql).all(wf) : db.prepare(sql).all());
});

/* ════════════════════════════════════
   CHECKLIST
════════════════════════════════════ */
app.get('/api/checklist', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM checklist_items ORDER BY sr_no').all());
});

/* ════════════════════════════════════
   COMPLIANCE
════════════════════════════════════ */
app.get('/api/compliance/:warehouseId', requireAuth, (req, res) => {
  const wf = warehouseFilter(req);
  const whId = parseInt(req.params.warehouseId);
  if (wf && wf !== whId) return res.status(403).json({ error: 'Access denied' });

  const date = req.query.date || todayIST();
  const rows = db.prepare(`
    SELECT ci.id as item_id, ci.sr_no, ci.title, ci.item_type,
           dc.id, dc.status, dc.checked_by, dc.notes, dc.updated_at,
           w.pharmacist_count,
           COUNT(eu.id) as image_count
    FROM checklist_items ci
    LEFT JOIN daily_compliance dc
      ON dc.warehouse_id=? AND dc.item_id=ci.id AND dc.compliance_date=?
    LEFT JOIN warehouses w ON w.id=?
    LEFT JOIN evidence_uploads eu ON eu.compliance_id=dc.id
    GROUP BY ci.id ORDER BY ci.sr_no
  `).all(whId, date, whId);
  res.json({ date, rows });
});

app.post('/api/compliance', requireAuth, (req, res) => {
  const { warehouse_id, item_id, compliance_date, status, checked_by, notes } = req.body;
  if (!warehouse_id || !item_id || !compliance_date) return res.status(400).json({ error: 'Missing fields' });

  const wf = warehouseFilter(req);
  if (wf && wf !== parseInt(warehouse_id)) return res.status(403).json({ error: 'Access denied' });

  const existing = db.prepare(
    'SELECT id,status FROM daily_compliance WHERE warehouse_id=? AND item_id=? AND compliance_date=?'
  ).get(warehouse_id, item_id, compliance_date);

  const wh = db.prepare('SELECT name FROM warehouses WHERE id=?').get(warehouse_id);
  const ci = db.prepare('SELECT title FROM checklist_items WHERE id=?').get(item_id);
  const user = checked_by || req.session.user.full_name || req.session.user.username;

  if (existing) {
    db.prepare(`UPDATE daily_compliance SET status=?,checked_by=?,notes=?,updated_at=datetime('now')
      WHERE warehouse_id=? AND item_id=? AND compliance_date=?`)
      .run(status, user, notes||null, warehouse_id, item_id, compliance_date);
    if (existing.status !== status) {
      db.prepare(`INSERT INTO activity_log (warehouse_id,warehouse_name,item_title,compliance_date,old_status,new_status,changed_by)
        VALUES(?,?,?,?,?,?,?)`)
        .run(warehouse_id, wh?.name, ci?.title, compliance_date, existing.status, status, user);
    }
    return res.json({ id: existing.id, updated: true });
  }

  const r = db.prepare(`INSERT INTO daily_compliance (warehouse_id,item_id,compliance_date,status,checked_by,notes)
    VALUES(?,?,?,?,?,?)`)
    .run(warehouse_id, item_id, compliance_date, status, user, notes||null);
  db.prepare(`INSERT INTO activity_log (warehouse_id,warehouse_name,item_title,compliance_date,old_status,new_status,changed_by)
    VALUES(?,?,?,?,?,?,?)`)
    .run(warehouse_id, wh?.name, ci?.title, compliance_date, 'pending', status, user);

  res.json({ id: Number(r.lastInsertRowid), updated: false });
});

/* ════════════════════════════════════
   FILE UPLOAD
════════════════════════════════════ */
app.post('/api/upload', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { warehouse_id, item_id, compliance_date } = req.body;
  const user = req.session.user.full_name || req.session.user.username;
  const wf = warehouseFilter(req);
  if (wf && wf !== parseInt(warehouse_id)) return res.status(403).json({ error: 'Access denied' });

  let dcId;
  const existing = db.prepare(
    'SELECT id FROM daily_compliance WHERE warehouse_id=? AND item_id=? AND compliance_date=?'
  ).get(warehouse_id, item_id, compliance_date);

  if (existing) {
    dcId = existing.id;
  } else {
    const r = db.prepare(`INSERT INTO daily_compliance (warehouse_id,item_id,compliance_date,status,checked_by)
      VALUES(?,?,?,'yes',?)`).run(warehouse_id, item_id, compliance_date, user);
    dcId = Number(r.lastInsertRowid);
  }

  // Try Cloudinary if configured
  let cloudUrl = null, cloudPublicId = null;
  if (cloudinary) {
    const cloud = await saveToCloud(req.file.path, `${dcId}-${req.file.filename}`);
    if (cloud) { cloudUrl = cloud.url; cloudPublicId = cloud.public_id; }
  }

  const r = db.prepare(`INSERT INTO evidence_uploads
    (compliance_id,filename,cloud_url,cloud_public_id,original_name,uploaded_by)
    VALUES(?,?,?,?,?,?)`)
    .run(dcId, req.file.filename, cloudUrl, cloudPublicId, req.file.originalname, user);

  res.json({
    id: Number(r.lastInsertRowid),
    compliance_id: dcId,
    filename: req.file.filename,
    url: cloudUrl || `/uploads/${req.file.filename}`,
    review_status: 'pending',
  });
});

/* ════════════════════════════════════
   IMAGES
════════════════════════════════════ */
app.get('/api/images/:warehouseId/:itemId', requireAuth, (req, res) => {
  const date = req.query.date || todayIST();
  const dc = db.prepare(
    'SELECT id FROM daily_compliance WHERE warehouse_id=? AND item_id=? AND compliance_date=?'
  ).get(req.params.warehouseId, req.params.itemId, date);
  if (!dc) return res.json([]);
  const imgs = db.prepare(`SELECT * FROM evidence_uploads WHERE compliance_id=? ORDER BY uploaded_at DESC`).all(dc.id);
  res.json(imgs.map(i => ({
    ...i, url: i.cloud_url || `/uploads/${i.filename}`
  })));
});

app.delete('/api/images/:uploadId', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM evidence_uploads WHERE id=?').get(req.params.uploadId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.cloud_public_id && cloudinary) {
    cloudinary.uploader.destroy(row.cloud_public_id).catch(console.error);
  } else {
    const fp = path.join(uploadsDir, row.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM evidence_uploads WHERE id=?').run(req.params.uploadId);
  res.json({ ok: true });
});

/* ════════════════════════════════════
   IMAGE REVIEW (manager/admin)
════════════════════════════════════ */
app.get('/api/review/pending', requireAuth, requireRole('admin','manager'), (req, res) => {
  const rows = db.prepare(`
    SELECT eu.id, eu.filename, eu.cloud_url, eu.original_name, eu.review_status,
           eu.reviewed_by, eu.review_notes, eu.reviewed_at, eu.uploaded_by, eu.uploaded_at,
           dc.compliance_date, dc.warehouse_id, dc.item_id,
           w.name as warehouse_name, ci.title as item_title
    FROM evidence_uploads eu
    JOIN daily_compliance dc ON dc.id=eu.compliance_id
    JOIN warehouses w ON w.id=dc.warehouse_id
    JOIN checklist_items ci ON ci.id=dc.item_id
    WHERE eu.review_status='pending'
    ORDER BY eu.uploaded_at DESC
    LIMIT 100
  `).all().map(r => ({ ...r, url: r.cloud_url || `/uploads/${r.filename}` }));
  res.json(rows);
});

app.get('/api/review/count', requireAuth, (req, res) => {
  if (!['admin','manager'].includes(req.session.user.role)) return res.json({ count: 0 });
  const { count } = db.prepare(`SELECT COUNT(*) as count FROM evidence_uploads WHERE review_status='pending'`).get();
  res.json({ count });
});

app.post('/api/review/:uploadId', requireAuth, requireRole('admin','manager'), (req, res) => {
  const { action, notes } = req.body; // action: 'approved' | 'rejected'
  if (!['approved','rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const reviewer = req.session.user.full_name || req.session.user.username;
  db.prepare(`UPDATE evidence_uploads
    SET review_status=?, reviewed_by=?, review_notes=?, reviewed_at=datetime('now')
    WHERE id=?`).run(action, reviewer, notes||null, req.params.uploadId);
  res.json({ ok: true });
});

/* ════════════════════════════════════
   DASHBOARD
════════════════════════════════════ */
app.get('/api/dashboard', requireAuth, (req, res) => {
  const date = req.query.date || todayIST();
  const today = todayIST();
  const totalItems = db.prepare('SELECT COUNT(*) as c FROM checklist_items').get().c;
  const wf = warehouseFilter(req);

  const whSql = wf
    ? 'SELECT * FROM warehouses WHERE id=? ORDER BY name'
    : 'SELECT * FROM warehouses ORDER BY is_active DESC, name';
  const warehouses = wf ? db.prepare(whSql).all(wf) : db.prepare(whSql).all();

  const result = warehouses.map(w => {
    const s = db.prepare(`
      SELECT
        COUNT(dc.id)                                        as filled,
        SUM(CASE WHEN dc.status='yes' THEN 1 ELSE 0 END)   as yes_count,
        SUM(CASE WHEN dc.status='no'  THEN 1 ELSE 0 END)   as no_count,
        SUM(CASE WHEN dc.status='na'  THEN 1 ELSE 0 END)   as na_count,
        MAX(dc.updated_at)                                  as last_updated,
        MAX(dc.checked_by)                                  as last_by
      FROM daily_compliance dc WHERE dc.warehouse_id=? AND dc.compliance_date=?
    `).get(w.id, date);
    return {
      ...w, date, total_items: totalItems, is_today: date === today,
      filled: s.filled||0, yes_count: s.yes_count||0,
      no_count: s.no_count||0, na_count: s.na_count||0,
      last_updated: s.last_updated, last_by: s.last_by,
    };
  });
  res.json({ date, today, warehouses: result });
});

/* ════════════════════════════════════
   HISTORY
════════════════════════════════════ */
app.get('/api/history/:warehouseId', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT compliance_date,
      COUNT(DISTINCT dc.id) as filled,
      SUM(CASE WHEN dc.status='yes' THEN 1 ELSE 0 END) as yes_count,
      SUM(CASE WHEN dc.status='no'  THEN 1 ELSE 0 END) as no_count,
      (SELECT COUNT(*) FROM checklist_items)            as total
    FROM daily_compliance dc WHERE dc.warehouse_id=?
    GROUP BY compliance_date ORDER BY compliance_date DESC LIMIT 30
  `).all(req.params.warehouseId);
  res.json(rows);
});

/* ════════════════════════════════════
   ACTIVITY
════════════════════════════════════ */
app.get('/api/activity', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 40;
  const wf = warehouseFilter(req);
  const sql = wf
    ? 'SELECT * FROM activity_log WHERE warehouse_id=? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?';
  res.json(wf ? db.prepare(sql).all(wf, limit) : db.prepare(sql).all(limit));
});

/* ════════════════════════════════════
   ALERT CONFIG
════════════════════════════════════ */
app.get('/api/alerts/config', requireAuth, requireRole('admin','manager'), (req, res) => {
  res.json(db.prepare('SELECT * FROM alert_config').all().map(r => ({
    ...r, recipients: JSON.parse(r.recipients||'[]')
  })));
});

app.post('/api/alerts/config', requireAuth, requireRole('admin'), (req, res) => {
  const { alert_type, send_time, recipients, is_active } = req.body;
  db.prepare(`UPDATE alert_config SET send_time=?,recipients=?,is_active=? WHERE alert_type=?`)
    .run(send_time, JSON.stringify(recipients||[]), is_active?1:0, alert_type);
  res.json({ ok: true });
});

app.post('/api/alerts/test-reminder', requireAuth, requireRole('admin'), async (req, res) => {
  try { await sendReminders(); res.json({ ok: true, message: 'Reminder check triggered' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alerts/test-summary', requireAuth, requireRole('admin'), async (req, res) => {
  try { await sendSummary(); res.json({ ok: true, message: 'Summary sent' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/alerts/smtp-status', requireAuth, requireRole('admin','manager'), (req, res) => {
  res.json({ configured: !!(process.env.SMTP_USER && process.env.SMTP_PASS) });
});

/* ── Error handler ── */
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

/* ── Start ── */
initCron();
app.listen(PORT, () => {
  console.log(`\n  FDA Compliance Tracker v2`);
  console.log(`  ──────────────────────────`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Default login: admin / Admin@123`);
  console.log(`  Press Ctrl+C to stop\n`);
});
