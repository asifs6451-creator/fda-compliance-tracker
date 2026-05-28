const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'compliance.db'));
db.exec(`PRAGMA journal_mode = WAL`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT,
    role     TEXT DEFAULT 'pharmacist',
    email    TEXT,
    warehouse_id INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS warehouses (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    location_code    TEXT UNIQUE,
    pharmacist_count INTEGER DEFAULT 1,
    is_active        INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS checklist_items (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sr_no     INTEGER,
    title     TEXT NOT NULL,
    item_type TEXT DEFAULT 'yesno'
  );

  CREATE TABLE IF NOT EXISTS daily_compliance (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse_id     INTEGER REFERENCES warehouses(id),
    item_id          INTEGER REFERENCES checklist_items(id),
    compliance_date  TEXT NOT NULL,
    status           TEXT DEFAULT 'pending',
    checked_by       TEXT,
    notes            TEXT,
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now')),
    UNIQUE(warehouse_id, item_id, compliance_date)
  );

  CREATE TABLE IF NOT EXISTS evidence_uploads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    compliance_id   INTEGER REFERENCES daily_compliance(id),
    filename        TEXT NOT NULL,
    cloud_url       TEXT,
    cloud_public_id TEXT,
    original_name   TEXT,
    review_status   TEXT DEFAULT 'pending',
    reviewed_by     TEXT,
    review_notes    TEXT,
    reviewed_at     TEXT,
    uploaded_by     TEXT,
    uploaded_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse_id   INTEGER,
    warehouse_name TEXT,
    item_title     TEXT,
    compliance_date TEXT,
    old_status     TEXT,
    new_status     TEXT,
    changed_by     TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS alert_config (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_type  TEXT UNIQUE,
    send_time   TEXT,
    recipients  TEXT,
    is_active   INTEGER DEFAULT 1,
    last_sent   TEXT
  );
`);

function seed() {
  const bcrypt = require('bcryptjs');

  /* users */
  if (db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0) {
    const hash = bcrypt.hashSync('Admin@123', 10);
    db.prepare(`INSERT INTO users (username,password,full_name,role,email,warehouse_id)
                VALUES (?,?,?,?,?,?)`)
      .run('admin', hash, 'Administrator', 'admin', '', null);
  }

  /* warehouses */
  if (db.prepare('SELECT COUNT(*) as c FROM warehouses').get().c === 0) {
    const ins = db.prepare(
      'INSERT INTO warehouses (name, location_code, pharmacist_count, is_active) VALUES (?,?,?,?)'
    );
    [
      ['Bhiwandi 1 (SL RX)',     'BHW1', 2, 1],
      ['Bhiwandi 2 (SL MM)',     'BHW2', 2, 1],
      ['Bhiwandi 3 Global',      'BHW3', 2, 0],
      ['Parasanath (Wholesale)', 'PARA', 1, 1],
      ['NCR Emiza',              'NCRE', 1, 0],
      ['NCR Beyond',             'NCRB', 1, 1],
      ['BLR (Bangalore)',        'BLR',  1, 1],
      ['HYD (Hyderabad)',        'HYD',  1, 1],
      ['GWHT',                   'GWHT', 1, 1],
      ['AHD (Ahmedabad)',        'AHD',  1, 1],
      ['KOL (Kolkata)',          'KOL',  1, 1],
    ].forEach(r => ins.run(...r));
  }

  /* checklist items */
  if (db.prepare('SELECT COUNT(*) as c FROM checklist_items').get().c === 0) {
    const ins = db.prepare('INSERT INTO checklist_items (sr_no, title, item_type) VALUES (?,?,?)');
    [
      [1,  'Pharmacist Available',                                                       'yesno'],
      [2,  'All stocks kept at Licensed area',                                           'yesno'],
      [3,  'Drug License copy displayed prominently in shop / warehouse',                'yesno'],
      [4,  'Expired / Damaged products kept in separate area with board',                'yesno'],
      [5,  'Inspection book maintained',                                                 'yesno'],
      [6,  'Inward register maintained',                                                 'yesno'],
      [7,  'Name board displayed with Retailer and Wholesaler name',                     'yesno'],
      [8,  'Night Shift Pharmacist available',                                           'yesno'],
      [9,  'Physical sample invoices (20 nos.) getting signed at location',              'yesno'],
      [10, 'Purchase invoices in chronological order (series numbers assigned)',         'yesno'],
      [11, 'Refrigerator available and in working condition',                            'yesno'],
      [12, '"Supplied by" stamp available',                                              'yesno'],
      [13, 'Total pharmacist count as per license (confirm number)',                     'number'],
    ].forEach(r => ins.run(...r));
  }

  /* default alert config */
  if (db.prepare('SELECT COUNT(*) as c FROM alert_config').get().c === 0) {
    const ins = db.prepare(
      'INSERT INTO alert_config (alert_type, send_time, recipients, is_active) VALUES (?,?,?,?)'
    );
    ins.run('reminder', '17:00', '[]', 1);
    ins.run('summary',  '21:00', '[]', 1);
  }
}

// Migrate: add columns that may be missing from older DB versions
const migrations = [
  `ALTER TABLE evidence_uploads ADD COLUMN cloud_url       TEXT`,
  `ALTER TABLE evidence_uploads ADD COLUMN cloud_public_id TEXT`,
  `ALTER TABLE evidence_uploads ADD COLUMN review_status   TEXT DEFAULT 'pending'`,
  `ALTER TABLE evidence_uploads ADD COLUMN reviewed_by     TEXT`,
  `ALTER TABLE evidence_uploads ADD COLUMN review_notes    TEXT`,
  `ALTER TABLE evidence_uploads ADD COLUMN reviewed_at     TEXT`,
  `ALTER TABLE evidence_uploads ADD COLUMN uploaded_by     TEXT`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists — ignore */ }
}

seed();
module.exports = db;
