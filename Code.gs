/* ═══════════════════════════════════════════════════════════
   FDA Compliance Tracker v3 — Google Apps Script Backend
   Deploy as Web App: Execute as Me, Anyone can access
   ═══════════════════════════════════════════════════════════ */

const TOKEN_HOURS  = 24;
const DRIVE_FOLDER = 'FDA Compliance Evidence';

// ── ENTRY POINTS ─────────────────────────────────────────────

function doPost(e) {
  try {
    return respond(route(JSON.parse(e.postData.contents)));
  } catch (err) { return respond({ error: err.message }); }
}

function doGet(e) {
  try {
    return respond(route(e.parameter));
  } catch (err) { return respond({ error: err.message }); }
}

function respond(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── ROUTER ───────────────────────────────────────────────────

function route(b) {
  if (b.path === 'login') return login(b.username, b.password);
  if (b.path === 'setup') return firstTimeSetup();

  const user = requireAuth(b.token);
  switch (b.path) {
    case 'me':              return { user };
    case 'logout':          return logout(b.token);
    case 'getWarehouses':   return getWarehouses(user);
    case 'getDashboard':    return getDashboard(b.date, user);
    case 'getChecklist':    return getChecklist();
    case 'getCompliance':   return getCompliance(+b.warehouseId, b.date, user);
    case 'saveCompliance':  return saveCompliance(b, user);
    case 'uploadImage':     return uploadImage(b, user);
    case 'getImages':       return getImages(+b.warehouseId, +b.itemId, b.date, user);
    case 'deleteImage':     return deleteImage(+b.uploadId, user);
    case 'getPending':      return getPending(user);
    case 'reviewCount':     return reviewCount(user);
    case 'reviewImage':     return reviewImage(+b.uploadId, b.action, b.notes, user);
    case 'getUsers':        return getUsers(user);
    case 'createUser':      return createUser(b, user);
    case 'updateUser':      return updateUser(b, user);
    case 'deleteUser':      return deleteUser(+b.id, user);
    case 'getAlertConfig':  return getAlertConfig(user);
    case 'saveAlertConfig': return saveAlertConfig(b, user);
    case 'testAlert':       return testAlert(b.alertType, user);
    case 'getHistory':      return getHistory(+b.warehouseId, user);
    case 'getActivity':     return getActivity(user);
    default: throw new Error('Unknown path: ' + b.path);
  }
}

// ── SHEET HELPERS ────────────────────────────────────────────

function ss()     { return SpreadsheetApp.getActiveSpreadsheet(); }
function sh(name) { return ss().getSheetByName(name); }

function rows(name) {
  const s = sh(name);
  if (!s) return [];
  const data = s.getDataRange().getValues();
  if (data.length < 2) return [];
  const hdrs = data[0];
  return data.slice(1).map(r => {
    const o = {};
    hdrs.forEach((h, i) => { o[h] = (r[i] === '' || r[i] === null) ? null : r[i]; });
    return o;
  });
}

function findOne(name, fn)   { return rows(name).find(fn) || null; }
function filterAll(name, fn) { return rows(name).filter(fn); }

function nextId(name) {
  const s = sh(name);
  const last = s.getLastRow();
  if (last < 2) return 1;
  return (Number(s.getRange(last, 1).getValue()) || 0) + 1;
}

function appendObj(name, obj) {
  const s = sh(name);
  const hdrs = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  s.appendRow(hdrs.map(h => (obj.hasOwnProperty(h) ? obj[h] : '')));
}

function updateObj(name, matchFn, updates) {
  const s = sh(name);
  const data = s.getDataRange().getValues();
  if (data.length < 2) return;
  const hdrs = data[0];
  for (let i = 1; i < data.length; i++) {
    const row = {};
    hdrs.forEach((h, j) => { row[h] = data[i][j]; });
    if (matchFn(row)) {
      Object.keys(updates).forEach(k => {
        const col = hdrs.indexOf(k);
        if (col >= 0) s.getRange(i + 1, col + 1).setValue(updates[k]);
      });
    }
  }
}

function deleteObj(name, matchFn) {
  const s = sh(name);
  const data = s.getDataRange().getValues();
  if (data.length < 2) return;
  const hdrs = data[0];
  for (let i = data.length - 1; i >= 1; i--) {
    const row = {};
    hdrs.forEach((h, j) => { row[h] = data[i][j]; });
    if (matchFn(row)) s.deleteRow(i + 1);
  }
}

function nowStr() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', "yyyy-MM-dd'T'HH:mm:ss");
}

function todayIST() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
}

// ── AUTH ─────────────────────────────────────────────────────

function hashPass(p) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p);
  return d.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function safeUser(u) {
  return {
    id:           Number(u.id),
    username:     String(u.username),
    full_name:    u.full_name  || '',
    role:         u.role       || 'pharmacist',
    email:        u.email      || '',
    warehouse_id: u.warehouse_id ? Number(u.warehouse_id) : null
  };
}

function login(username, password) {
  if (!username || !password) throw new Error('Credentials required');
  const user = findOne('Users', u => String(u.username) === String(username) && u.is_active == 1);
  if (!user || user.password_hash !== hashPass(password)) throw new Error('Invalid credentials');
  const token   = Utilities.getUuid();
  const expires = new Date(Date.now() + TOKEN_HOURS * 3600000).toISOString();
  appendObj('Sessions', { token, user_id: user.id, created_at: nowStr(), expires_at: expires });
  return { token, user: safeUser(user) };
}

function requireAuth(token) {
  if (!token) throw new Error('Not authenticated');
  const sess = findOne('Sessions', s => s.token === token && new Date(s.expires_at) > new Date());
  if (!sess) throw new Error('Not authenticated');
  const user = findOne('Users', u => u.id == sess.user_id && u.is_active == 1);
  if (!user) throw new Error('User not found');
  return safeUser(user);
}

function requireRole(user) {
  const roles = Array.prototype.slice.call(arguments, 1);
  if (!roles.includes(user.role)) throw new Error('Access denied');
}

function logout(token) {
  deleteObj('Sessions', s => s.token === token);
  return { ok: true };
}

// ── USERS ────────────────────────────────────────────────────

function getUsers(user) {
  requireRole(user, 'admin', 'manager');
  return rows('Users').map(u => ({
    id: Number(u.id), username: u.username, full_name: u.full_name,
    role: u.role, email: u.email,
    warehouse_id: u.warehouse_id ? Number(u.warehouse_id) : null,
    is_active: Number(u.is_active)
  }));
}

function createUser(b, user) {
  requireRole(user, 'admin');
  if (!b.username || !b.password) throw new Error('Username and password required');
  if (findOne('Users', u => u.username === b.username)) throw new Error('Username already exists');
  const id = nextId('Users');
  appendObj('Users', {
    id, username: b.username.trim(), password_hash: hashPass(b.password),
    full_name: b.full_name || '', role: b.role || 'pharmacist',
    email: b.email || '', warehouse_id: b.warehouse_id || '',
    is_active: 1, created_at: nowStr()
  });
  return { id };
}

function updateUser(b, user) {
  requireRole(user, 'admin');
  const updates = {
    full_name: b.full_name || '', role: b.role || 'pharmacist',
    email: b.email || '', warehouse_id: b.warehouse_id || '',
    is_active: b.is_active !== undefined ? Number(b.is_active) : 1
  };
  if (b.password) updates.password_hash = hashPass(b.password);
  updateObj('Users', u => u.id == b.id, updates);
  return { ok: true };
}

function deleteUser(id, user) {
  requireRole(user, 'admin');
  if (id === user.id) throw new Error("Can't delete yourself");
  deleteObj('Users', u => u.id == id);
  return { ok: true };
}

// ── WAREHOUSES ───────────────────────────────────────────────

function getWarehouses(user) {
  const wh = rows('Warehouses').map(w => ({ ...w, id: Number(w.id) }));
  if (user.role === 'pharmacist' && user.warehouse_id) {
    return wh.filter(w => w.id === user.warehouse_id);
  }
  return wh;
}

// ── CHECKLIST ────────────────────────────────────────────────

function getChecklist() {
  return rows('ChecklistItems').map(i => ({
    ...i, id: Number(i.id), sr_no: Number(i.sr_no)
  }));
}

// ── COMPLIANCE ───────────────────────────────────────────────

function whFilter(user) {
  return (user.role === 'pharmacist' && user.warehouse_id) ? Number(user.warehouse_id) : null;
}

function getCompliance(warehouseId, date, user) {
  const allowed = whFilter(user);
  if (allowed && allowed !== warehouseId) throw new Error('Access denied');
  const items   = rows('ChecklistItems');
  const records = filterAll('DailyCompliance', r => r.warehouse_id == warehouseId && r.compliance_date === date);
  const uploads = filterAll('EvidenceUploads', u => {
    return records.some(r => r.id == u.compliance_id);
  });

  return {
    rows: items.map(item => {
      const rec = records.find(r => r.item_id == item.id);
      const imgs = rec ? uploads.filter(u => u.compliance_id == rec.id) : [];
      return {
        item_id:     Number(item.id),
        sr_no:       Number(item.sr_no),
        title:       item.title,
        item_type:   item.item_type,
        id:          rec ? Number(rec.id) : null,
        status:      rec ? rec.status : 'pending',
        checked_by:  rec ? rec.checked_by : '',
        notes:       rec ? rec.notes : '',
        image_count: imgs.length
      };
    })
  };
}

function saveCompliance(b, user) {
  const allowed = whFilter(user);
  const wId = Number(b.warehouse_id), iId = Number(b.item_id);
  if (allowed && allowed !== wId) throw new Error('Access denied');

  const existing = findOne('DailyCompliance',
    r => r.warehouse_id == wId && r.item_id == iId && r.compliance_date === b.compliance_date);
  const by = b.checked_by || user.full_name || user.username;

  if (existing) {
    updateObj('DailyCompliance', r => r.id == existing.id,
      { status: b.status, checked_by: by, notes: b.notes || '', updated_at: nowStr() });
    return { updated: true, id: Number(existing.id) };
  }
  const id = nextId('DailyCompliance');
  appendObj('DailyCompliance', {
    id, warehouse_id: wId, item_id: iId, compliance_date: b.compliance_date,
    status: b.status, checked_by: by, notes: b.notes || '',
    created_at: nowStr(), updated_at: nowStr()
  });
  const wh   = findOne('Warehouses', w => w.id == wId);
  const item = findOne('ChecklistItems', i => i.id == iId);
  appendObj('ActivityLog', {
    id: nextId('ActivityLog'), warehouse_id: wId,
    warehouse_name: wh ? wh.name : '', item_title: item ? item.title : '',
    compliance_date: b.compliance_date, old_status: 'pending', new_status: b.status,
    changed_by: by, created_at: nowStr()
  });
  return { id };
}

// ── DASHBOARD ────────────────────────────────────────────────

function getDashboard(date, user) {
  const allWh  = rows('Warehouses').filter(w => w.is_active == 1);
  const allowed = whFilter(user);
  const warehouses = allowed ? allWh.filter(w => w.id == allowed) : allWh;
  const totalItems = rows('ChecklistItems').length;
  const records    = filterAll('DailyCompliance', r => r.compliance_date === date);

  const result = warehouses.map(wh => {
    const whRecs  = records.filter(r => r.warehouse_id == wh.id);
    const answered = whRecs.filter(r => r.status && r.status !== 'pending');
    const hasNo    = whRecs.some(r => r.status === 'no');
    return {
      id: Number(wh.id), name: wh.name, location_code: wh.location_code,
      pharmacist_count: Number(wh.pharmacist_count),
      total: totalItems, filled: answered.length,
      yes_count: whRecs.filter(r => r.status === 'yes').length,
      no_count:  whRecs.filter(r => r.status === 'no').length,
      na_count:  whRecs.filter(r => r.status === 'na').length,
      status: answered.length === totalItems && !hasNo ? 'complete'
            : hasNo                                    ? 'has-no'
            : answered.length > 0                      ? 'partial' : 'notstart'
    };
  });

  const activity = filterAll('ActivityLog', a => a.compliance_date === date)
    .sort((a, b) => (b.created_at > a.created_at ? 1 : -1)).slice(0, 20);

  return { warehouses: result, activity };
}

// ── IMAGES ───────────────────────────────────────────────────

function getDriveFolder() {
  const it = DriveApp.getFoldersByName(DRIVE_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_FOLDER);
}

function uploadImage(b, user) {
  const allowed = whFilter(user);
  const wId = Number(b.warehouse_id), iId = Number(b.item_id);
  if (allowed && allowed !== wId) throw new Error('Access denied');

  // Ensure a compliance record exists (auto-create as 'yes')
  let comp = findOne('DailyCompliance',
    r => r.warehouse_id == wId && r.item_id == iId && r.compliance_date === b.compliance_date);
  if (!comp) {
    const cid = nextId('DailyCompliance');
    const by = b.checked_by || user.full_name || user.username;
    appendObj('DailyCompliance', {
      id: cid, warehouse_id: wId, item_id: iId,
      compliance_date: b.compliance_date, status: 'yes',
      checked_by: by, notes: '', created_at: nowStr(), updated_at: nowStr()
    });
    comp = { id: cid };
  }

  const bytes = Utilities.base64Decode(b.data);
  const blob  = Utilities.newBlob(bytes, b.mimeType || 'image/jpeg', b.filename);
  const folder = getDriveFolder();
  const file   = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const driveUrl = 'https://drive.google.com/uc?export=view&id=' + file.getId();
  const id = nextId('EvidenceUploads');
  appendObj('EvidenceUploads', {
    id, compliance_id: Number(comp.id), drive_url: driveUrl,
    drive_file_id: file.getId(), original_name: b.filename,
    review_status: 'pending', reviewed_by: '', review_notes: '',
    reviewed_at: '', uploaded_by: user.full_name || user.username,
    uploaded_at: nowStr()
  });
  return { id, url: driveUrl, review_status: 'pending', compliance_id: Number(comp.id) };
}

function getImages(warehouseId, itemId, date, user) {
  const allowed = whFilter(user);
  if (allowed && allowed !== warehouseId) throw new Error('Access denied');
  const comp = findOne('DailyCompliance',
    r => r.warehouse_id == warehouseId && r.item_id == itemId && r.compliance_date === date);
  if (!comp) return [];
  return filterAll('EvidenceUploads', u => u.compliance_id == comp.id).map(u => ({
    id: Number(u.id), url: u.drive_url, original_name: u.original_name,
    review_status: u.review_status || 'pending',
    uploaded_by: u.uploaded_by, uploaded_at: u.uploaded_at
  }));
}

function deleteImage(uploadId, user) {
  const up = findOne('EvidenceUploads', u => u.id == uploadId);
  if (!up) throw new Error('Not found');
  try { DriveApp.getFileById(up.drive_file_id).setTrashed(true); } catch (e) {}
  deleteObj('EvidenceUploads', u => u.id == uploadId);
  return { ok: true };
}

// ── REVIEW ───────────────────────────────────────────────────

function getPending(user) {
  requireRole(user, 'admin', 'manager');
  return rows('EvidenceUploads').map(u => {
    const comp = findOne('DailyCompliance', c => c.id == u.compliance_id);
    if (!comp) return null;
    const wh   = findOne('Warehouses',     w => w.id == comp.warehouse_id);
    const item = findOne('ChecklistItems', i => i.id == comp.item_id);
    return {
      id: Number(u.id), url: u.drive_url, original_name: u.original_name,
      review_status: u.review_status || 'pending',
      review_notes:  u.review_notes  || '',
      reviewed_by:   u.reviewed_by   || '',
      warehouse_name: wh   ? wh.name   : '',
      item_title:     item ? item.title : '',
      compliance_date: comp.compliance_date,
      uploaded_by: u.uploaded_by || ''
    };
  }).filter(Boolean);
}

function reviewCount(user) {
  if (!['admin', 'manager'].includes(user.role)) return { count: 0 };
  return { count: filterAll('EvidenceUploads', u => u.review_status === 'pending').length };
}

function reviewImage(uploadId, action, notes, user) {
  requireRole(user, 'admin', 'manager');
  if (!['approved', 'rejected'].includes(action)) throw new Error('Invalid action');
  updateObj('EvidenceUploads', u => u.id == uploadId, {
    review_status: action,
    reviewed_by:   user.full_name || user.username,
    review_notes:  notes || '',
    reviewed_at:   nowStr()
  });
  return { ok: true };
}

// ── ALERT CONFIG ─────────────────────────────────────────────

function getAlertConfig(user) {
  requireRole(user, 'admin', 'manager');
  return rows('AlertConfig').map(r => ({
    id: Number(r.id), alert_type: r.alert_type, send_time: r.send_time,
    recipients: r.recipients ? JSON.parse(r.recipients) : [],
    is_active: Number(r.is_active), last_sent: r.last_sent || null
  }));
}

function saveAlertConfig(b, user) {
  requireRole(user, 'admin');
  updateObj('AlertConfig', r => r.alert_type === b.alert_type, {
    send_time:  b.send_time,
    recipients: JSON.stringify(b.recipients || []),
    is_active:  b.is_active ? 1 : 0
  });
  return { ok: true };
}

function testAlert(alertType, user) {
  requireRole(user, 'admin');
  const date = todayIST();
  if (alertType === 'summary') sendSummary(date);
  else sendReminders(date);
  return { ok: true };
}

// ── HISTORY & ACTIVITY ───────────────────────────────────────

function getHistory(warehouseId, user) {
  const allowed = whFilter(user);
  if (allowed && allowed !== warehouseId) throw new Error('Access denied');
  const records    = filterAll('DailyCompliance', r => r.warehouse_id == warehouseId);
  const totalItems = rows('ChecklistItems').length;
  const byDate = {};
  records.forEach(r => {
    if (!byDate[r.compliance_date]) byDate[r.compliance_date] = [];
    byDate[r.compliance_date].push(r);
  });
  return Object.keys(byDate).sort().reverse().slice(0, 30).map(d => {
    const recs     = byDate[d];
    const answered = recs.filter(r => r.status && r.status !== 'pending');
    const yes_count = recs.filter(r => r.status === 'yes').length;
    const no_count  = recs.filter(r => r.status === 'no').length;
    const hasNo     = no_count > 0;
    return {
      compliance_date: d, filled: answered.length, total: totalItems,
      yes_count, no_count,
      status: answered.length === totalItems && !hasNo ? 'complete'
            : hasNo ? 'has-no' : answered.length > 0 ? 'partial' : 'notstart'
    };
  });
}

function getActivity(user) {
  const allowed = whFilter(user);
  let logs = rows('ActivityLog').sort((a, b) => (b.created_at > a.created_at ? 1 : -1)).slice(0, 50);
  if (allowed) logs = logs.filter(l => l.warehouse_id == allowed);
  return logs.map(l => ({ ...l, warehouse_id: Number(l.warehouse_id) }));
}

// ── EMAIL ALERTS (time-based trigger calls this) ──────────────

function runAlerts() {
  const date    = todayIST();
  const istTime = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'HH:mm');
  const configs = rows('AlertConfig').filter(c => c.is_active == 1);
  configs.forEach(cfg => {
    if (cfg.send_time === istTime) {
      if (cfg.alert_type === 'reminder') sendReminders(date, cfg);
      if (cfg.alert_type === 'summary')  sendSummary(date, cfg);
      updateObj('AlertConfig', r => r.id == cfg.id, { last_sent: nowStr() });
    }
  });
}

function buildSnapshot(date) {
  const warehouses = rows('Warehouses').filter(w => w.is_active == 1);
  const records    = filterAll('DailyCompliance', r => r.compliance_date === date);
  const totalItems = rows('ChecklistItems').length;
  return warehouses.map(wh => {
    const answered = records.filter(r => r.warehouse_id == wh.id && r.status && r.status !== 'pending').length;
    return { id: Number(wh.id), name: wh.name, filled: answered, total: totalItems,
             pct: Math.round(answered / totalItems * 100) };
  });
}

function sendSummary(date, cfg) {
  if (!cfg) cfg = findOne('AlertConfig', c => c.alert_type === 'summary');
  if (!cfg) return;
  const to = JSON.parse(cfg.recipients || '[]');
  if (!to.length) return;
  const snap = buildSnapshot(date);
  const tableRows = snap.map(w =>
    `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${w.name}</td>
     <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center">${w.filled}/${w.total}</td>
     <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center">
       <span style="color:${w.pct===100?'#16a34a':w.pct>0?'#d97706':'#dc2626'};font-weight:600">${w.pct}%</span>
     </td></tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px">
    <div style="background:#1a2e4a;color:#fff;padding:20px;border-radius:8px 8px 0 0">
      <h2 style="margin:0">FDA Compliance Summary</h2><p style="margin:4px 0 0;opacity:.8">${date}</p></div>
    <table style="width:100%;border-collapse:collapse;background:#fff">
      <tr style="background:#f8fafc">
        <th style="padding:8px 12px;text-align:left">Location</th>
        <th style="padding:8px 12px;text-align:center">Items</th>
        <th style="padding:8px 12px;text-align:center">Completion</th></tr>
      ${tableRows}</table></div>`;
  GmailApp.sendEmail(to.join(','), `FDA Compliance Summary — ${date}`, '', { htmlBody: html });
}

function sendReminders(date, cfg) {
  if (!cfg) cfg = findOne('AlertConfig', c => c.alert_type === 'reminder');
  if (!cfg) return;
  const cc  = JSON.parse(cfg.recipients || '[]');
  const snap = buildSnapshot(date);
  snap.filter(w => w.filled < w.total).forEach(wh => {
    const pharmacists = filterAll('Users',
      u => u.warehouse_id == wh.id && u.role === 'pharmacist' && u.is_active == 1 && u.email);
    const emails = pharmacists.map(u => u.email).filter(Boolean);
    if (!emails.length) return;
    const html = `<div style="font-family:Arial,sans-serif;max-width:500px">
      <div style="background:#1a2e4a;color:#fff;padding:16px;border-radius:8px 8px 0 0">
        <h3 style="margin:0">⚠️ Compliance Checklist Pending</h3></div>
      <div style="background:#fff;padding:20px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
        <p>The FDA compliance checklist for <strong>${wh.name}</strong> is incomplete for <strong>${date}</strong>.</p>
        <p>Items filled: <strong>${wh.filled} / ${wh.total}</strong></p>
        <p>Please complete the checklist at your earliest.</p></div></div>`;
    GmailApp.sendEmail(emails.join(','), `Action Required: FDA Compliance Pending — ${wh.name}`, '',
      { htmlBody: html, ...(cc.length ? { cc: cc.join(',') } : {}) });
  });
}

// ── FIRST-TIME SETUP ─────────────────────────────────────────

function firstTimeSetup() {
  createSheets();
  seedData();
  return { ok: true, message: 'Setup complete! Login: admin / Admin@123' };
}

function createSheets() {
  const defs = {
    Users:           ['id','username','password_hash','full_name','role','email','warehouse_id','is_active','created_at'],
    Warehouses:      ['id','name','location_code','pharmacist_count','is_active'],
    ChecklistItems:  ['id','sr_no','title','item_type'],
    DailyCompliance: ['id','warehouse_id','item_id','compliance_date','status','checked_by','notes','created_at','updated_at'],
    EvidenceUploads: ['id','compliance_id','drive_url','drive_file_id','original_name','review_status','reviewed_by','review_notes','reviewed_at','uploaded_by','uploaded_at'],
    Sessions:        ['token','user_id','created_at','expires_at'],
    AlertConfig:     ['id','alert_type','send_time','recipients','is_active','last_sent'],
    ActivityLog:     ['id','warehouse_id','warehouse_name','item_title','compliance_date','old_status','new_status','changed_by','created_at']
  };
  const spreadsheet = ss();
  Object.entries(defs).forEach(([name, headers]) => {
    if (spreadsheet.getSheetByName(name)) return;
    const s = spreadsheet.insertSheet(name);
    s.getRange(1, 1, 1, headers.length).setValues([headers])
      .setBackground('#1a2e4a').setFontColor('#ffffff').setFontWeight('bold');
    s.setFrozenRows(1);
  });
  try {
    const s1 = spreadsheet.getSheetByName('Sheet1');
    if (s1 && s1.getLastRow() <= 1) spreadsheet.deleteSheet(s1);
  } catch (e) {}
}

function seedData() {
  if (!rows('Users').length) {
    appendObj('Users', {
      id: 1, username: 'admin', password_hash: hashPass('Admin@123'),
      full_name: 'Administrator', role: 'admin', email: '',
      warehouse_id: '', is_active: 1, created_at: nowStr()
    });
  }
  if (!rows('Warehouses').length) {
    [
      [1,'Bhiwandi 1 (SL RX)','BHW1',2,1], [2,'Bhiwandi 2 (SL MM)','BHW2',2,1],
      [3,'Bhiwandi 3 Global','BHW3',2,0],   [4,'Parasanath (Wholesale)','PARA',1,1],
      [5,'NCR Emiza','NCRE',1,0],            [6,'NCR Beyond','NCRB',1,1],
      [7,'BLR (Bangalore)','BLR',1,1],       [8,'HYD (Hyderabad)','HYD',1,1],
      [9,'GWHT','GWHT',1,1],                 [10,'AHD (Ahmedabad)','AHD',1,1],
      [11,'KOL (Kolkata)','KOL',1,1]
    ].forEach(([id,name,lc,pc,active]) =>
      appendObj('Warehouses', { id, name, location_code: lc, pharmacist_count: pc, is_active: active }));
  }
  if (!rows('ChecklistItems').length) {
    [
      [1,1,'Pharmacist Available','yesno'],
      [2,2,'All stocks kept at Licensed area','yesno'],
      [3,3,'Drug License copy displayed prominently in shop / warehouse','yesno'],
      [4,4,'Expired / Damaged products kept in separate area with board','yesno'],
      [5,5,'Inspection book maintained','yesno'],
      [6,6,'Inward register maintained','yesno'],
      [7,7,'Name board displayed with Retailer and Wholesaler name','yesno'],
      [8,8,'Night Shift Pharmacist available','yesno'],
      [9,9,'Physical sample invoices (20 nos.) getting signed at location','yesno'],
      [10,10,'Purchase invoices in chronological order (series numbers assigned)','yesno'],
      [11,11,'Refrigerator available and in working condition','yesno'],
      [12,12,'"Supplied by" stamp available','yesno'],
      [13,13,'Total pharmacist count as per license (confirm number)','number']
    ].forEach(([id,sr,title,type]) =>
      appendObj('ChecklistItems', { id, sr_no: sr, title, item_type: type }));
  }
  if (!rows('AlertConfig').length) {
    appendObj('AlertConfig', { id:1, alert_type:'reminder', send_time:'17:00', recipients:'[]', is_active:1, last_sent:'' });
    appendObj('AlertConfig', { id:2, alert_type:'summary',  send_time:'21:00', recipients:'[]', is_active:1, last_sent:'' });
  }
}

// ── INSTALL TRIGGER (run once from Apps Script editor) ────────

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runAlerts').timeBased().everyMinutes(1).create();
  Logger.log('Trigger installed: runAlerts every minute');
}
