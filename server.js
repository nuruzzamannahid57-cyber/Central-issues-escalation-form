require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { createClient } = require('@libsql/client');
const { registerParcelJourney } = require('./parcel-journey');

const {
  TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN,
  SETUP_KEY,      // required header value to create new login users via /api/auth/register
  AD_TEAM_SERVICE_KEY, // shared secret the AD Team Issues Dashboard sends as x-service-key ("Send to ISF")
  PORT = 3000,
  SMTP_HOST,
  SMTP_PORT = 587,
  SMTP_SECURE = 'false',
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM,
  IR_TEAM_EMAIL = 'issue.resolution@carrybee.com',
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
  GMAIL_USER,
  DAILY_REPORT_CRON = '59 23 * * *',
  DAILY_REPORT_TZ = 'Asia/Dhaka',
  DAILY_REPORT_ENABLED = 'true'
} = process.env;

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in environment.');
  process.exit(1);
}

const db = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN
});

const path = require('path');

const app = express();
app.use(cors());
// Raised from the default 100kb so photo/audio attachments (sent as base64
// data URLs in the issue payload) fit. 20mb of base64 ~= 14-15mb of real
// file data, comfortably above what a phone photo or a short voice note needs.
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// ---------- in-memory session store ----------
// Simple bearer tokens, held in memory only. They reset if the server restarts
// (e.g. Render free-tier spin-down), which just means users log in again.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map(); // token -> { email, expires }

function issueToken(email) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { email, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) {
    if (session) sessions.delete(token);
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  req.user = session.email;
  next();
}

// The AD Team Issues Dashboard ("Send to ISF") is a server-less page, so it
// can't hold a user session. It sends a shared secret in `x-service-key`
// instead. That key is deliberately limited to three things: create an issue,
// read one issue back (status + remarks) and read the hub list. It can't list
// issues, edit them or touch ops/admin routes.
function serviceKeyMatches(req) {
  const sent = req.headers['x-service-key'];
  if (!AD_TEAM_SERVICE_KEY || typeof sent !== 'string' || !sent) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(AD_TEAM_SERVICE_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAuthOrService(req, res, next) {
  if (req.headers['x-service-key'] !== undefined) {
    if (!serviceKeyMatches(req)) return res.status(401).json({ error: 'Invalid service key.' });
    req.user = 'ad-team-dashboard';
    req.isService = true;
    return next();
  }
  return requireAuth(req, res, next);
}

// ---------- table setup (runs on boot, safe to re-run) ----------
async function ensureTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Add `name` to a users table created before this column existed.
  // SQLite/libSQL has no "ADD COLUMN IF NOT EXISTS", so we try and
  // swallow the "duplicate column" error on databases that already have it.
  try {
    await db.execute('ALTER TABLE users ADD COLUMN name TEXT');
  } catch (err) {
    if (!String(err.message || '').includes('duplicate column')) throw err;
  }
  // Which app this login is allowed to use: 'main' (Central Issues Log +
  // Escalation Dashboard) or 'ops' (Ops Console). NULL is treated as 'main'
  // for accounts created before this column existed.
  try {
    await db.execute('ALTER TABLE users ADD COLUMN app_access TEXT');
  } catch (err) {
    if (!String(err.message || '').includes('duplicate column')) throw err;
  }
  await db.execute(`
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      consignment TEXT,
      channel TEXT,
      zone TEXT,
      hub TEXT,
      status TEXT,
      category TEXT,
      subcategory TEXT,
      details TEXT,
      logged_by TEXT
    )
  `);
  // Ops/Regional/Cluster remarks + last-updated tracking on existing issues tables.
  for (const stmt of [
    'ALTER TABLE issues ADD COLUMN remarks TEXT',
    'ALTER TABLE issues ADD COLUMN remarks_by TEXT',
    'ALTER TABLE issues ADD COLUMN updated_at TEXT',
    'ALTER TABLE issues ADD COLUMN media TEXT',
    'ALTER TABLE issues ADD COLUMN social_source TEXT',
    // Time-based escalation ladder: L3 (Hub) -> L2 (Cluster/Regional) -> L1 (Ops Manager).
    "ALTER TABLE issues ADD COLUMN escalation_level TEXT DEFAULT 'L3'",
    "ALTER TABLE issues ADD COLUMN response_status TEXT DEFAULT 'Regular'",
    'ALTER TABLE issues ADD COLUMN level_started_at TEXT',
    'ALTER TABLE issues ADD COLUMN merchant_notified_at TEXT',
    // KAM-side close (separate from the Ops-side status field): did the KAM
    // confirm the merchant was told before closing, and who/when.
    'ALTER TABLE issues ADD COLUMN merchant_informed TEXT',
    'ALTER TABLE issues ADD COLUMN closed_by TEXT',
    'ALTER TABLE issues ADD COLUMN closed_at TEXT',
    // JSON array of { type: 'photo'|'audio', filename, mimeType, dataUrl }.
    // Stored inline as base64 data URLs — fine at this volume, and it means
    // no separate object-storage bucket/credentials to set up. If the volume
    // of attachments grows a lot, swap this for real object storage (S3/R2/
    // Cloudinary) and store just the URL here instead — same column, just
    // shorter values.
    'ALTER TABLE issues ADD COLUMN attachments TEXT',
    // Snapshot of the parcel's tracking milestones at the moment the issue
    // was raised/last refreshed, so the detail view has something to show
    // even if the tracking source is temporarily unreachable later. JSON
    // array of { status, location, ts }.
    'ALTER TABLE issues ADD COLUMN parcel_journey TEXT'
  ]) {
    try {
      await db.execute(stmt);
    } catch (err) {
      if (!String(err.message || '').includes('duplicate column')) throw err;
    }
  }
  // Issues created before level_started_at existed have it as NULL, and the
  // escalation sweep skips any row with no level_started_at — without this,
  // every pre-existing open issue would sit outside the ladder forever.
  await db.execute(`UPDATE issues SET level_started_at = ts WHERE level_started_at IS NULL`);

  // Step-by-step history of every issue (logged, escalated, Ops reply, closed).
  // The Parcel Journey code also writes 'logged' rows here when the columns
  // issue_id/ts/type/actor exist, so this shape stays compatible with it.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS issue_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      actor TEXT,
      detail TEXT
    )
  `);
  try {
    await db.execute('ALTER TABLE issue_events ADD COLUMN detail TEXT');
  } catch (err) {
    if (!String(err.message || '').includes('duplicate column')) throw err;
  }
  await db.execute('CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events (issue_id, ts)');

  await db.execute(`
    CREATE TABLE IF NOT EXISTS hub_assignments (
      hub_name TEXT PRIMARY KEY,
      division TEXT,
      hub_email TEXT,
      ops_manager_name TEXT,
      ops_manager_email TEXT,
      regional_manager_name TEXT,
      regional_manager_email TEXT,
      cluster_lead_name TEXT,
      cluster_lead_email TEXT
    )
  `);
  // Add `hub_email` to a hub_assignments table created before this column
  // existed (the hub's own login — sees only its own hub, below Cluster Lead).
  try {
    await db.execute('ALTER TABLE hub_assignments ADD COLUMN hub_email TEXT');
  } catch (err) {
    if (!String(err.message || '').includes('duplicate column')) throw err;
  }
}

// Best-effort history write: a failure here must never break the action itself.
async function logEvent(issueId, type, actor, detail, ts) {
  try {
    await db.execute({
      sql: 'INSERT INTO issue_events (issue_id, ts, type, actor, detail) VALUES (?, ?, ?, ?, ?)',
      args: [issueId, ts || new Date().toISOString(), type, actor || null, detail ? JSON.stringify(detail) : null]
    });
  } catch (err) {
    console.error('logEvent failed:', err.message);
  }
}

// Given a signed-in email, find every hub they're allowed to see —
// as the Hub's own login, Cluster Lead, Regional Manager, or Ops Manager —
// plus which role(s) gave them access to each. Returns [] if unassigned.
async function resolveOpsScope(email) {
  const result = await db.execute({
    sql: `
      SELECT hub_name,
             CASE WHEN hub_email = ?1 THEN 1 ELSE 0 END AS is_hub,
             CASE WHEN ops_manager_email = ?1 THEN 1 ELSE 0 END AS is_ops_manager,
             CASE WHEN regional_manager_email = ?1 THEN 1 ELSE 0 END AS is_regional_manager,
             CASE WHEN cluster_lead_email = ?1 THEN 1 ELSE 0 END AS is_cluster_lead
      FROM hub_assignments
      WHERE hub_email = ?1 OR ops_manager_email = ?1 OR regional_manager_email = ?1 OR cluster_lead_email = ?1
    `,
    args: [email]
  });
  const roles = new Set();
  const hubs = [];
  for (const row of result.rows) {
    hubs.push(row.hub_name);
    if (row.is_hub) roles.add('hub');
    if (row.is_ops_manager) roles.add('ops_manager');
    if (row.is_regional_manager) roles.add('regional_manager');
    if (row.is_cluster_lead) roles.add('cluster_lead');
  }
  return { roles: [...roles], hubs };
}

// ---------- auth routes ----------

// One-time bootstrap route to create a login. Protected by SETUP_KEY so a
// stranger with the URL can't create accounts. Call it once per person, then
// you're done — nothing else needs this header.
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, app: appAccess } = req.body || {};
  if (req.headers['x-setup-key'] !== SETUP_KEY) {
    return res.status(403).json({ error: 'Invalid setup key.' });
  }
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }
  try {
    await db.execute({
      sql: 'INSERT INTO users (email, password, name, app_access) VALUES (?, ?, ?, ?)',
      args: [email.trim().toLowerCase(), password, name ? name.trim() : null, appAccess === 'ops' ? 'ops' : 'main']
    });
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'That email is already registered.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not create user.' });
  }
});

// One-time helper to set/update the display name on an account that was
// registered before the `name` field existed. Protected by SETUP_KEY, same
// as /api/auth/register.
app.post('/api/auth/set-name', async (req, res) => {
  const { email, name } = req.body || {};
  if (req.headers['x-setup-key'] !== SETUP_KEY) {
    return res.status(403).json({ error: 'Invalid setup key.' });
  }
  if (!email || !name) {
    return res.status(400).json({ error: 'email and name are required.' });
  }
  try {
    const result = await db.execute({
      sql: 'UPDATE users SET name = ? WHERE email = ?',
      args: [name.trim(), email.trim().toLowerCase()]
    });
    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'No user with that email.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update name.' });
  }
});

// Bulk-create Ops Console logins in one call. Protected by SETUP_KEY. Body:
// { rows: [ { email, name }, ... ], password?, app? }. Defaults: password
// '0000', app 'ops'. Skips any email that's already registered — safe to
// re-run without clobbering a password someone has since changed.
app.post('/api/admin/bulk-register', async (req, res) => {
  if (req.headers['x-setup-key'] !== SETUP_KEY) {
    return res.status(403).json({ error: 'Invalid setup key.' });
  }
  const { rows, password, app: appAccess } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'rows must be a non-empty array.' });
  }
  const pw = password || '0000';
  const appVal = appAccess === 'main' ? 'main' : 'ops';
  let created = 0, skipped = 0;
  try {
    for (const r of rows) {
      if (!r.email) continue;
      const result = await db.execute({
        sql: `INSERT INTO users (email, password, name, app_access)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(email) DO NOTHING`,
        args: [r.email.trim().toLowerCase(), pw, r.name ? r.name.trim() : null, appVal]
      });
      if (result.rowsAffected > 0) created++; else skipped++;
    }
    res.json({ ok: true, created, skipped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk register failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password, app: appAccess } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }
  try {
    const result = await db.execute({
      sql: 'SELECT email, password, name, app_access FROM users WHERE email = ?',
      args: [email.trim().toLowerCase()]
    });
    const row = result.rows[0];
    if (!row || row.password !== password) {
      return res.status(401).json({ error: 'Wrong email or password.' });
    }
    const effectiveApp = row.app_access || 'main';
    const requestedApp = appAccess === 'ops' ? 'ops' : 'main';
    if (effectiveApp !== requestedApp) {
      return res.status(403).json({ error: 'This login is not authorized for this dashboard.' });
    }
    const token = issueToken(row.email);
    res.json({ token, email: row.email, name: row.name || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// ---------- issue routes ----------

// Sends the initial "your issue has been escalated" message to the merchant.
// STUB: no merchant contact field exists on `issues` yet and no SMS/WhatsApp/
// email gateway is wired up, so this only records that the attempt happened.
// Once there's a merchant phone/email source (a new field at raise-time, or a
// lookup by consignment ID against another system), replace the body of this
// function with the real send and it'll be called from the same place.
async function notifyMerchant(issue) {
  console.log(`[merchant-notify] would message merchant for consignment ${issue.consignment} (issue ${issue.id}) — no gateway configured yet.`);
  return true;
}

// Ground truth for which zone a hub belongs to — same mapping the raise-issue
// form's cascading zone/hub dropdown uses (form/index.html HUB_MAP), kept
// here too so it's enforced no matter which client posts an issue (the
// manual form, or an automated feed like the AD-team dashboard). Without
// this, a caller could send a hub with a zone that doesn't match it — that's
// exactly what was happening before this was added.
const HUB_MAP = {"ISD": ["Uttara", "Diabari", "Khilkhet", "Mohakhali", "Badda-Nadda", "Pallabi", "60 Feet", "Mohammadpur", "Kolabagan", "Lalbagh", "Kamrangirchar", "Badda", "Jatrabari", "Khilgaon", "Dhonia", "Demra"], "SUB": ["Gazipur-Joydebpur", "Gazipur-Kapasiya", "Gazipur-Mawna", "Gazipur-Mouchak", "Gazipur-Boardbazar", "Gazipur-Kaliganj", "Savar", "Savar-Baipail", "Savar-Dhamrai", "Narayanganj", "Sonargaon", "Narayanganj-Bandar", "Narayanganj-Araihazar", "Rupganj", "Bhulta-Gawsia", "Dohar-Nawabganj", "Keraniganj-Ati Bazar", "Siddhirganj", "Keraniganj"], "OSD": ["Jhenaidah-Sadar", "Jhenaidah-Maheshpur", "Satkhira-Sadar", "Meherpur-Sadar", "Kushtia-Sadar", "Kushtia-Daulatpur", "Kushtia-Bheramara", "Jessore-Sadar", "Jessore-Sharsha", "Jessore-Manirampur", "Khulna-Sadar", "Jessore-Abhaynagar", "Bagerhat-Sadar", "Khulna-Paikgacha", "Khulna-Dumuria", "Satkhira-Kaliganj", "Bagerhat-Mongla", "Bagerhat-Morrelganj", "Chuadanga-Sadar", "Magura-Sadar", "Narail-Sadar", "Barishal-Sadar", "Barisal-Gournadi", "Barisal-Bakerganj", "Bhola-Charfassion", "Bhola-Sadar", "Pirojpur-Sadar", "Pirojpur-Mathbaria", "Barisal-Muladi", "Jhalokathi-Sadar", "Barguna-Sadar", "Patuakhali-Sadar", "Patuakhali-Galachipa", "Patuakhali-Kalapara", "Shariatpur-Sadar", "Gopalganj-Sadar", "Madaripur-Shibchar", "Madaripur-Sadar", "Faridpur-Sadar", "Gopalganj-Muksudpur", "Shariatpur-Damudya", "Munshiganj-Sirajdikhan", "Tangail-Sakhipur", "Manikganj-Sadar", "Manikganj-Singair", "Munshiganj-Sreenagar", "Tangail-Mirzapur", "Munshiganj-Sadar", "Tangail-Sadar", "Tangail-Ghatail", "Faridpur-Bhanga", "Rajbari-Sadar", "Faridpur-Boalmari", "Sylhet-Golapganj", "Sylhet-Beanibazar", "Sylhet-Sadar", "Sylhet-Jaintiapur", "Sylhet-Kanaighat", "Sylhet-Gowainghat", "Sylhet-Bishwanath", "Sylhet-Osmaninagar", "Sylhet-Fenchuganj", "Sylhet-Dakshin Surma", "Habiganj-Sadar", "Habiganj-Chunarughat", "Habiganj-Madhabpur", "Habiganj-Nabiganj", "Moulvibazar-Barlekha", "Moulvibazar-Kulaura", "Maulvibazar-Sadar", "Moulvibazar-Rajnagar", "Moulvibazar-Sreemangal", "Moulvibazar-Kamalganj", "Sunamganj-Sadar", "Sunamganj-Chhatak", "Sunamganj-Jagannathpur", "Sunamganj-Derai", "Netrokona-Sadar", "Netrakona-Mohonganj", "Jamalpur-Dewanganj", "Sherpur-Sadar", "Mymensingh-Phulpur", "Mymensingh-Bhaluka", "Mymensingh-Gaffargaon", "Mymensingh-Trishal", "Mymensingh-Sadar", "Jamalpur-Sadar", "Joypurhat-Sadar", "Bogra-Sadar", "Bogra-Sherpur", "Bogra-Dhupchanchia", "Sirajganj-Sadar", "Naogaon-Sadar", "Pabna-Bhangura", "Natore-Sadar", "Pabna-Ishwardi", "Pabna-Sadar", "Sirajganj-Shahjadpur", "Chapainawabganj-Shibganj", "Chapainawabganj-Sadar", "Sirajganj-Ullapara", "Naogaon-Patnitala", "Rajshahi-Puthia", "Rajshahi-Sadar", "Gaibandha-Sadar", "Rangpur-Sadar", "Nilphamari-Sadar", "Kurigram-Sadar", "Thakurgaon-Sadar", "Lalmonirhat-Sadar", "Rangpur-Mithapukur", "Nilphamari-Saidpur", "Gaibandha-Gobindaganj", "Panchagarh-Sadar", "Dinajpur-Nawabganj", "Nilphamari-Joldhaka", "Dinajpur-Birganj", "Dinajpur-Sadar", "Narsingdi-Sadar", "Narsingdi-Roypura", "Narsingdi-Shibpur", "Kishoreganj-Mithamain", "Kishoreganj-Pakundia", "Kishoreganj-Sadar", "Kishoreganj-Bhairab", "B.Baria-Sadar", "B.Baria-Kasba", "B.Baria-Nabinagar", "B.Baria-Bancharampur", "B.Baria-Nasirnagar", "B.Baria-Akhaura", "Comilla-Laksam", "Comilla-Sadar", "Comilla-Muradnagar", "Comilla-Chandina", "Comilla-Chauddagram", "Comilla-Daudkandi", "Comilla-Burichang", "Comilla-Nangalkot", "Comilla-Brahmanpara", "Comilla-Barura", "Comilla-Debidwar", "Chandpur-Sadar", "Chandpur-Faridganj", "Chandpur-Hajiganj", "Chandpur-Kachua", "Chandpur-Shahrasti", "Chandpur-Matlab Dakshin", "Noakhali-Senbagh", "Noakhali-Companiganj", "Noakhali-Sadar", "Noakhali-Chatkhil", "Noakhali-Subarnachar", "Noakhali-Begumganj", "Lakshmipur-Kamalnagar", "Lakshmipur-Ramganj", "Lakshmipur-Raipur", "Lakshmipur-Sadar", "Cox's Bazar-Chakaria", "Cox's Bazar-Maheshkhali", "Cox's Bazar-Ramu", "Cox's Bazar-Sadar", "Cox's Bazar-Teknaf", "Cox's Bazar-Ukhia", "CTG-Halishahar", "CTG-Nasirabad", "CTG-Patenga", "CTG-Patiya", "CTG-Fatikchari", "CTG-Raozan", "CTG-Satkania", "CTG-Sitakunda", "Feni-Chhagalnaiya", "Feni-Daganbhuya", "Feni-Sadar", "Feni-Sonagazi", "Khagrachari-Sadar", "Rangamati-Sadar", "Bandarban-Sadar", "CTG-Anwara", "CTG-Banshkhali", "CTG-Rangunia", "CTG-Hathazari", "CTG-Mirsarai"], "Central Sort": ["Central Sort"]};
const HUB_TO_ZONE = {};
for (const [zone, hubs] of Object.entries(HUB_MAP)) {
  for (const hub of hubs) HUB_TO_ZONE[hub] = zone;
}
// hub-info.json (the Hub Info list) knows a few hubs HUB_MAP doesn't (Vatara,
// 3PL, the Sub Sorts, ...). Add them, but never override HUB_MAP.
try {
  for (const h of require('./hub-info.json')) {
    if (h && h.name && h.region && !HUB_TO_ZONE[h.name]) HUB_TO_ZONE[h.name] = h.region;
  }
} catch (err) {
  console.warn('hub-info.json not loaded into HUB_TO_ZONE:', err.message);
}
const HUB_LOWER = new Map(Object.keys(HUB_TO_ZONE).map(name => [name.toLowerCase(), name]));
// Exact or case/space-insensitive match -> { name, zone }, or null when the
// hub is not one we know.
function resolveHub(input) {
  const key = String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const name = HUB_LOWER.get(key);
  return name ? { name, zone: HUB_TO_ZONE[name] } : null;
}

app.post('/api/issues', requireAuthOrService, async (req, res) => {
  const i = req.body || {};
  const required = ['consignment', 'channel', 'zone', 'hub', 'status', 'category', 'subcategory', 'details'];
  if (['Social Media', 'Inbound'].includes(i.channel)) {
    required.push('media');
  }
  if (i.channel === 'Social Media') {
    required.push('socialSource');
  }
  const missing = required.filter(k => !i[k]);
  if (missing.length) {
    return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
  }
  // The hub is ground truth for zone — always derive zone from it rather
  // than trusting whatever the caller sent, so a mismatched pair (like a
  // Diabari/ISD hub tagged with zone "Central Sort" by an automated feed)
  // can't get written to the DB. If the hub isn't recognized, fall back to
  // whatever zone was sent rather than rejecting the whole submission.
  const knownHub = resolveHub(i.hub);
  // Anything sent by the AD dashboard must name a real hub: that hub decides
  // whether the issue lands with ISD, OSD, SUB or Central Sort ops, so an
  // unknown name is rejected instead of being silently dropped into Central.
  if (req.isService && !knownHub) {
    return res.status(400).json({ error: `Unknown hub "${i.hub}". Pick a hub from the list.` });
  }
  if (knownHub) i.hub = knownHub.name;
  const correctedZone = knownHub ? knownHub.zone : i.zone;
  if (knownHub && knownHub.zone !== i.zone) {
    console.warn(`[zone-correction] hub "${i.hub}" sent with zone "${i.zone}" by ${req.user} — corrected to "${correctedZone}"`);
  }
  // Who to record as the logger: the AD dashboard passes the signed-in AD
  // user's email as `loggedBy`; falls back to the service identity.
  const loggedBy = req.isService
    ? (String(i.loggedBy || '').trim().toLowerCase() || req.user)
    : req.user;
  // Attachments come in as [{ type: 'photo'|'audio', filename, mimeType, dataUrl }].
  // Validated loosely here — the point is to reject obvious garbage, not to
  // be a full MIME sniffer.
  let attachments = null;
  if (Array.isArray(i.attachments) && i.attachments.length) {
    const cleaned = i.attachments
      .filter(a => a && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:') && ['photo', 'audio'].includes(a.type))
      .map(a => ({ type: a.type, filename: a.filename || null, mimeType: a.mimeType || null, dataUrl: a.dataUrl }));
    if (cleaned.length) attachments = JSON.stringify(cleaned);
  }
  const id = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const ts = new Date().toISOString();
  try {
    await db.execute({
      sql: `INSERT INTO issues
              (id, ts, consignment, channel, media, social_source, zone, hub, status, category, subcategory, details, logged_by,
               escalation_level, response_status, level_started_at, attachments)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'L3', 'Regular', ?, ?)`,
      args: [id, ts, i.consignment, i.channel, i.media || null, i.socialSource || null, correctedZone, i.hub, i.status, i.category, i.subcategory, i.details, loggedBy, ts, attachments]
    });
    notifyMerchant({ id, consignment: i.consignment }).then(async ok => {
      if (ok) {
        await db.execute({ sql: 'UPDATE issues SET merchant_notified_at = ? WHERE id = ?', args: [new Date().toISOString(), id] });
      }
    }).catch(err => console.error('notifyMerchant failed:', err));
    await logEvent(id, 'logged', loggedBy, { hub: i.hub, zone: correctedZone, category: i.category, subcategory: i.subcategory, channel: i.channel }, ts);
    // Tell the caller whether any Ops Console will actually see this hub
    // (hubs nobody is assigned to in hub_assignments get the issue but no queue).
    let assigned = null;
    try {
      const a = await db.execute({ sql: 'SELECT 1 FROM hub_assignments WHERE hub_name = ? LIMIT 1', args: [i.hub] });
      assigned = a.rows.length > 0;
    } catch (err) { /* informational only */ }
    res.json({ ok: true, id, ts, zone: correctedZone, hub: i.hub, assigned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save issue.' });
  }
});

app.get('/api/issues', requireAuth, async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT issues.*, COALESCE(users.name, issues.logged_by) AS logged_by_name
      FROM issues
      LEFT JOIN users ON users.email = issues.logged_by
      ORDER BY issues.ts DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch issues.' });
  }
});

// One issue's live state, for the AD dashboard to show Ops remarks. Returns
// only what that dashboard displays — not attachments or the logger's identity.
app.get('/api/issues/:id', requireAuthOrService, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT id, ts, consignment, zone, hub, status, category, subcategory,
                   remarks, remarks_by, updated_at, escalation_level, response_status, level_started_at
            FROM issues WHERE id = ?`,
      args: [req.params.id]
    });
    if (!result.rows[0]) return res.status(404).json({ error: 'Issue not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch issue.' });
  }
});

// Full hub -> zone list (ISD / OSD / SUB / Central Sort) so callers pick from
// the same names this server accepts instead of a hand-copied snapshot.
app.get('/api/hubs', requireAuthOrService, (req, res) => {
  res.json(Object.keys(HUB_TO_ZONE).sort((a, b) => a.localeCompare(b)).map(name => ({ name, zone: HUB_TO_ZONE[name] })));
});

// Full step-by-step history of one issue, oldest first. Issues raised before
// history was recorded have no rows, so a best-effort timeline is rebuilt from
// the columns on the issue itself (marked approximate: true).
app.get('/api/issues/:id/events', requireAuth, async (req, res) => {
  try {
    const issueRes = await db.execute({
      sql: `SELECT issues.*, COALESCE(users.name, issues.logged_by) AS logged_by_name
            FROM issues LEFT JOIN users ON users.email = issues.logged_by WHERE issues.id = ?`,
      args: [req.params.id]
    });
    const issue = issueRes.rows[0];
    if (!issue) return res.status(404).json({ error: 'Issue not found.' });
    const evRes = await db.execute({
      sql: 'SELECT ts, type, actor, detail FROM issue_events WHERE issue_id = ? ORDER BY ts ASC, id ASC',
      args: [req.params.id]
    });
    const events = evRes.rows.map(r => {
      let detail = null;
      try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { detail = null; }
      return { ts: r.ts, type: r.type, actor: r.actor, detail };
    });
    let approximate = false;
    if (!events.some(e => e.type === 'logged')) {
      approximate = true;
      events.unshift({ ts: issue.ts, type: 'logged', actor: issue.logged_by_name || issue.logged_by,
        detail: { hub: issue.hub, zone: issue.zone, category: issue.category, subcategory: issue.subcategory, channel: issue.channel } });
    }
    if (approximate) {
      if (issue.remarks && issue.updated_at) {
        events.push({ ts: issue.updated_at, type: issue.status === 'Resolved' ? 'resolved' : 'ops_update', actor: issue.remarks_by,
          detail: { status: issue.status, remarks: issue.remarks } });
      }
      if (issue.closed_at) events.push({ ts: issue.closed_at, type: 'closed', actor: issue.closed_by, detail: { merchantInformed: issue.merchant_informed } });
      events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    }
    // Show people by name instead of email where the users table knows them.
    const emails = [...new Set(events.map(e => e.actor).filter(a => a && String(a).includes('@')))];
    if (emails.length) {
      const nameRes = await db.execute({
        sql: `SELECT email, name FROM users WHERE email IN (${emails.map(() => '?').join(',')})`,
        args: emails
      });
      const names = new Map(nameRes.rows.filter(r => r.name).map(r => [String(r.email).toLowerCase(), r.name]));
      events.forEach(e => { e.actor_name = (e.actor && names.get(String(e.actor).toLowerCase())) || e.actor || null; });
    } else {
      events.forEach(e => { e.actor_name = e.actor || null; });
    }
    res.json({ events, approximate, issue: { id: issue.id, ts: issue.ts, status: issue.status,
      escalation_level: issue.escalation_level, response_status: issue.response_status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch history.' });
  }
});

// KAM-side close: only the KAM who originally logged the issue can close it
// (not anyone else's), only once Ops/Hub has actually left a remark (nothing
// to confirm yet otherwise), and only with an explicit answer on whether the
// merchant was told. This is the KAM's own confirmation that the issue is
// truly closed, separate from (and available even after) Ops marking status
// Resolved on their side — a KAM can only confirm once (closed_by guards
// that), but Ops resolving first doesn't block it.
app.patch('/api/issues/:id/close', requireAuth, async (req, res) => {
  try {
    const { merchantInformed } = req.body || {};
    if (merchantInformed !== 'Yes' && merchantInformed !== 'No') {
      return res.status(400).json({ error: 'merchantInformed must be "Yes" or "No".' });
    }
    const existing = await db.execute({ sql: 'SELECT * FROM issues WHERE id = ?', args: [req.params.id] });
    const issue = existing.rows[0];
    if (!issue) return res.status(404).json({ error: 'Issue not found.' });
    if ((issue.logged_by || '').toLowerCase() !== req.user.toLowerCase()) {
      return res.status(403).json({ error: 'You can only close issues you logged yourself.' });
    }
    if (issue.closed_by) {
      return res.status(400).json({ error: 'You already confirmed this issue as closed.' });
    }
    if (!issue.remarks) {
      return res.status(400).json({ error: 'No response on this issue yet — nothing to close.' });
    }
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE issues
            SET status = 'Resolved', response_status = 'Resolved', merchant_informed = ?, closed_by = ?, closed_at = ?, updated_at = ?
            WHERE id = ?`,
      args: [merchantInformed, req.user, now, now, req.params.id]
    });
    await logEvent(req.params.id, 'closed', req.user, { merchantInformed }, now);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not close issue.' });
  }
});

// KAM-side Re-process: the KAM isn't satisfied with the hub's answer, so the
// issue goes back to the hub as a fresh L3 / Regular / Open item with a new
// escalation clock. Same ownership rule as close (only the KAM who logged it),
// and it needs a hub response to push back on. The reason is appended to the
// issue details so the hub sees why it is back; the hub's previous remark is
// cleared from the live row (a reprocessed issue must wait for a NEW reply
// before it can be closed) but is kept in the history event so nothing is lost.
app.patch('/api/issues/:id/reprocess', requireAuth, async (req, res) => {
  try {
    const reason = String((req.body || {}).reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Tell the hub why this is being re-processed.' });
    if (reason.length > 500) return res.status(400).json({ error: 'Reason is too long (max 500 characters).' });
    const existing = await db.execute({ sql: 'SELECT * FROM issues WHERE id = ?', args: [req.params.id] });
    const issue = existing.rows[0];
    if (!issue) return res.status(404).json({ error: 'Issue not found.' });
    if ((issue.logged_by || '').toLowerCase() !== req.user.toLowerCase()) {
      return res.status(403).json({ error: 'You can only re-process issues you logged yourself.' });
    }
    if (!issue.remarks) {
      return res.status(400).json({ error: 'The hub has not replied yet, so there is nothing to re-process.' });
    }
    const who = await db.execute({ sql: 'SELECT name FROM users WHERE email = ?', args: [req.user] });
    const name = (who.rows[0] && who.rows[0].name) || req.user;
    const now = new Date().toISOString();
    const when = new Date(now).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const details = `${issue.details || ''}\n\n[Re-processed by ${name}, ${when}] ${reason}`;
    await db.execute({
      sql: `UPDATE issues
            SET status = 'Open', response_status = 'Regular', escalation_level = 'L3', level_started_at = ?,
                remarks = NULL, remarks_by = NULL, updated_at = ?,
                closed_by = NULL, closed_at = NULL, merchant_informed = NULL, details = ?
            WHERE id = ?`,
      args: [now, now, details, req.params.id]
    });
    await logEvent(req.params.id, 'reprocessed', req.user, {
      reason, hub: issue.hub, previousStatus: issue.status, previousRemarks: issue.remarks,
      previousRemarksBy: issue.remarks_by || null, wasClosed: !!issue.closed_by
    }, now);
    res.json({ ok: true, hub: issue.hub });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not re-process issue.' });
  }
});

// "Send to IR": the KAM writes a note and it is emailed to the IR (Issue
// Resolution) team with the issue's key facts attached. Gmail/SMTP will not
// let a server send AS another person's address, so the mail goes out from the
// configured SMTP account with the KAM's display name, and Reply-To is the
// KAM's login email: IR just hits Reply and it goes straight to the KAM.
// Same ownership rule as Close / Re-process (only the KAM who logged it).
function irEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
app.post('/api/issues/:id/send-to-ir', requireAuth, async (req, res) => {
  try {
    const note = String((req.body || {}).details || '').trim();
    const subjectIn = String((req.body || {}).subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (note.length < 3) return res.status(400).json({ error: 'Write the details to send to the IR team.' });
    if (note.length > 3000) return res.status(400).json({ error: 'Details are too long (max 3000 characters).' });
    const existing = await db.execute({ sql: 'SELECT * FROM issues WHERE id = ?', args: [req.params.id] });
    const issue = existing.rows[0];
    if (!issue) return res.status(404).json({ error: 'Issue not found.' });
    if ((issue.logged_by || '').toLowerCase() !== req.user.toLowerCase()) {
      return res.status(403).json({ error: 'You can only send issues you logged yourself to IR.' });
    }
    const transport = getMailer();
    if (!transport) return res.status(503).json({ error: 'Email is not configured on the server. Add the GMAIL_* settings (or SMTP_* on a paid Render plan) in Render > Environment.' });

    const who = await db.execute({ sql: 'SELECT name FROM users WHERE email = ?', args: [req.user] });
    const name = (who.rows[0] && who.rows[0].name) || req.user;
    const now = new Date().toISOString();
    const ref = issue.consignment || issue.id;
    const rows = [
      ['Consignment', issue.consignment], ['Hub', issue.hub], ['Zone', issue.zone],
      ['Category', [issue.category, issue.subcategory].filter(Boolean).join(' / ')],
      ['Status', issue.status], ['Logged by', `${name} (${req.user})`],
      ['Original details', issue.details], ['Hub / OPS remark', issue.remarks]
    ].filter(r => r[1]);
    const html = `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:640px;">
        <p style="margin:0 0 6px;"><b>${irEsc(name)}</b> (${irEsc(req.user)}) sent an issue to the IR team.</p>
        <div style="margin:12px 0;padding:12px 14px;background:#FFF8D6;border-left:4px solid #FFCC00;white-space:pre-wrap;">${irEsc(note)}</div>
        <table style="border-collapse:collapse;width:100%;font-size:13px;">
          ${rows.map(r => `<tr><td style="padding:6px 8px;border:1px solid #ddd;background:#f6f6f6;width:150px;"><b>${irEsc(r[0])}</b></td><td style="padding:6px 8px;border:1px solid #ddd;white-space:pre-wrap;">${irEsc(r[1])}</td></tr>`).join('')}
        </table>
        <p style="color:#888;font-size:12px;margin-top:14px;">Reply to this email to reach ${irEsc(name)} directly.</p>
      </div>`;
    const text = `${name} (${req.user}) sent an issue to the IR team.\n\n${note}\n\n` + rows.map(r => `${r[0]}: ${r[1]}`).join('\n');

    await transport.sendMail({
      from: `"${String(name).replace(/"/g, '')} via Carrybee" <${GMAIL_USER || SMTP_USER || 'no-reply@carrybee.com'}>`,
      replyTo: `"${String(name).replace(/"/g, '')}" <${req.user}>`,
      to: IR_TEAM_EMAIL,
      subject: subjectIn || `[IR] ${ref}${issue.hub ? ' · ' + issue.hub : ''}`,
      text, html
    });
    await logEvent(req.params.id, 'sent_to_ir', req.user, { note, subject: subjectIn || null, to: IR_TEAM_EMAIL }, now);
    res.json({ ok: true, to: IR_TEAM_EMAIL });
  } catch (err) {
    console.error('send-to-ir failed:', err);
    res.status(500).json({ error: 'Could not send the email: ' + String(err.message || err).slice(0, 160) });
  }
});

// Parcel journey (tracking milestones) for the detail view. Currently just
// returns whatever was snapshotted onto the row at raise-time (parcel_journey
// column) or [] if none — there's no live tracking source wired up yet.
// TODO once we know which system holds the tracking timeline (CarryBee's own
// parcel-tracking DB/API, or a Google Sheet), replace the body of this route
// with a live lookup by `consignment`, keyed the same way merchant_phone/
// Assigned Group lookups already are elsewhere in this system.
app.get('/api/issues/:id/parcel-journey', requireAuth, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT parcel_journey FROM issues WHERE id = ?', args: [req.params.id] });
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Issue not found.' });
    let journey = [];
    if (row.parcel_journey) {
      try { journey = JSON.parse(row.parcel_journey); } catch { journey = []; }
    }
    res.json({ journey, source: 'stub' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch parcel journey.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- Parcel Journey tab (SLA engine, uploads, issues from breaches) ----------
// Lives in its own module; issues it raises land in the same `issues` table.
const parcelJourney = registerParcelJourney(app, { db, requireAuth });

// ---------- admin: seed the hub -> manager mapping ----------

// One-time (or re-run-anytime) bulk upsert of the Hub/Ops-Manager/Regional-
// Manager/Cluster-Lead mapping. Protected by SETUP_KEY, same convention as
// /api/auth/register. Body: { rows: [ { hub_name, division, ops_manager_name,
// ops_manager_email, regional_manager_name, regional_manager_email,
// cluster_lead_name, cluster_lead_email }, ... ] }
app.post('/api/admin/import-hubs', async (req, res) => {
  if (req.headers['x-setup-key'] !== SETUP_KEY) {
    return res.status(403).json({ error: 'Invalid setup key.' });
  }
  const rows = (req.body || {}).rows;
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'rows must be a non-empty array.' });
  }
  try {
    for (const r of rows) {
      await db.execute({
        sql: `INSERT INTO hub_assignments
                (hub_name, division, hub_email, ops_manager_name, ops_manager_email,
                 regional_manager_name, regional_manager_email,
                 cluster_lead_name, cluster_lead_email)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(hub_name) DO UPDATE SET
                division = COALESCE(excluded.division, hub_assignments.division),
                hub_email = COALESCE(excluded.hub_email, hub_assignments.hub_email),
                ops_manager_name = COALESCE(excluded.ops_manager_name, hub_assignments.ops_manager_name),
                ops_manager_email = COALESCE(excluded.ops_manager_email, hub_assignments.ops_manager_email),
                regional_manager_name = COALESCE(excluded.regional_manager_name, hub_assignments.regional_manager_name),
                regional_manager_email = COALESCE(excluded.regional_manager_email, hub_assignments.regional_manager_email),
                cluster_lead_name = COALESCE(excluded.cluster_lead_name, hub_assignments.cluster_lead_name),
                cluster_lead_email = COALESCE(excluded.cluster_lead_email, hub_assignments.cluster_lead_email)`,
        args: [
          r.hub_name, r.division || null, r.hub_email ? r.hub_email.toLowerCase() : null,
          r.ops_manager_name || null, r.ops_manager_email ? r.ops_manager_email.toLowerCase() : null,
          r.regional_manager_name || null, r.regional_manager_email ? r.regional_manager_email.toLowerCase() : null,
          r.cluster_lead_name || null, r.cluster_lead_email ? r.cluster_lead_email.toLowerCase() : null
        ]
      });
    }
    res.json({ ok: true, imported: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Import failed.' });
  }
});

// Read-only lookup used by the main dashboard: given a hub name, return the
// names (not emails) of whoever is assigned so a viewer can see who owns it.
app.get('/api/hub-assignments/:hub', requireAuth, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT hub_name, division, hub_email, ops_manager_name, regional_manager_name, cluster_lead_name
            FROM hub_assignments WHERE hub_name = ?`,
      args: [req.params.hub]
    });
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not look up hub.' });
  }
});

// ---------- ops sub-dashboard routes ----------
// Ops Manager / Regional Manager / Cluster Lead each see only the issues
// under the hub(s) hub_assignments says they're responsible for, and can
// update status + leave a remark, both of which land back in the same
// `issues` table the main dashboard reads from.

app.get('/api/ops/me', requireAuth, async (req, res) => {
  try {
    const scope = await resolveOpsScope(req.user);
    res.json({ email: req.user, ...scope });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not resolve access.' });
  }
});

app.get('/api/ops/issues', requireAuth, async (req, res) => {
  try {
    const scope = await resolveOpsScope(req.user);
    if (!scope.hubs.length) {
      return res.json([]);
    }
    const placeholders = scope.hubs.map(() => '?').join(',');
    const result = await db.execute({
      sql: `
        SELECT issues.*, COALESCE(users.name, issues.logged_by) AS logged_by_name
        FROM issues
        LEFT JOIN users ON users.email = issues.logged_by
        WHERE issues.hub IN (${placeholders})
        ORDER BY issues.ts DESC
      `,
      args: scope.hubs
    });
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch issues.' });
  }
});

app.patch('/api/ops/issues/:id', requireAuth, async (req, res) => {
  const { status, remarks } = req.body || {};
  if (!status) {
    return res.status(400).json({ error: 'status is required.' });
  }
  try {
    const scope = await resolveOpsScope(req.user);
    if (!scope.hubs.length) {
      return res.status(403).json({ error: 'You are not assigned to any hub.' });
    }
    const existing = await db.execute({
      sql: 'SELECT hub FROM issues WHERE id = ?',
      args: [req.params.id]
    });
    const issue = existing.rows[0];
    if (!issue) {
      return res.status(404).json({ error: 'Issue not found.' });
    }
    if (!scope.hubs.includes(issue.hub)) {
      return res.status(403).json({ error: 'This issue is outside your assigned hubs.' });
    }
    // Any response restarts this level's escalation clock. Resolving clears
    // the flag outright; otherwise leave response_status/escalation_level as
    // they are (a reply doesn't demote a Critical issue back to Regular —
    // only the ladder job below advances it, and only on silence).
    const responseStatus = status === 'Resolved' ? 'Resolved' : null;
    await db.execute({
      sql: `UPDATE issues SET status = ?, remarks = ?, remarks_by = ?, updated_at = ?, level_started_at = ?
            ${responseStatus ? ', response_status = ?' : ''}
            WHERE id = ?`,
      args: responseStatus
        ? [status, remarks || null, req.user, new Date().toISOString(), new Date().toISOString(), responseStatus, req.params.id]
        : [status, remarks || null, req.user, new Date().toISOString(), new Date().toISOString(), req.params.id]
    });
    await logEvent(req.params.id, status === 'Resolved' ? 'resolved' : 'ops_update', req.user, { status, remarks: remarks || null });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update issue.' });
  }
});

// ---------- daily pending-issues email report ----------
// Every day, Cluster Leads get the pending issues under their own hub,
// Regional Managers get pending issues across every hub under them, and
// Ops Managers get the company-wide pending total — all pulled straight
// from `hub_assignments`, the same mapping /api/ops/me already relies on.

const PENDING_STATUSES = ['Open', 'In Progress'];

let mailer = null;

// Two ways to send, picked by which env vars exist:
//  1) Gmail API over HTTPS (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN).
//     Use this on Render's free tier, which blocks SMTP ports 25/465/587.
//  2) Plain SMTP (SMTP_HOST / SMTP_USER / SMTP_PASS), for paid Render or local runs.
// Both expose the same sendMail(options) so callers don't care which is active.
let gmailToken = { value: null, exp: 0 };
async function getGmailAccessToken() {
  if (gmailToken.value && Date.now() < gmailToken.exp - 60000) return gmailToken.value;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token'
    })
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Gmail token refresh failed: ' + (j.error_description || j.error || r.status));
  gmailToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return gmailToken.value;
}
function getMailer() {
  if (mailer) return mailer;
  if (GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN) {
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const gmailFrom = GMAIL_USER || SMTP_USER;
    mailer = {
      async sendMail(opts) {
        // Gmail only sends as the authorised account, so force From to it
        // (keep the display name the caller chose).
        const m = String(opts.from || '').match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
        const from = gmailFrom ? (m && m[1] ? `"${m[1].trim()}" <${gmailFrom}>` : gmailFrom) : opts.from;
        const built = await builder.sendMail({ ...opts, from });
        const raw = built.message.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const token = await getGmailAccessToken();
        const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw })
        });
        if (!r.ok) {
          const t = await r.text();
          throw new Error('Gmail API send failed (' + r.status + '): ' + t.slice(0, 300));
        }
        return r.json();
      }
    };
    return mailer;
  }
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
  });
  return mailer;
}

async function fetchPendingIssues() {
  const placeholders = PENDING_STATUSES.map(() => '?').join(',');
  const result = await db.execute({
    sql: `SELECT id, consignment, hub, zone, status, ts FROM issues
          WHERE status IN (${placeholders})
          ORDER BY hub, ts DESC`,
    args: PENDING_STATUSES
  });
  return result.rows;
}

async function fetchHubAssignments() {
  const result = await db.execute('SELECT * FROM hub_assignments');
  return result.rows;
}

// Builds one digest per recipient: { email, name, roleLabel, scopeLabel, issues }
async function buildDailyDigests() {
  const [pending, hubRows] = await Promise.all([fetchPendingIssues(), fetchHubAssignments()]);

  const hubInfo = new Map();
  const hubLogins = new Map();        // email -> hub_name (a hub login only ever covers its own hub)
  const opsManagers = new Map();      // email -> name
  const regionalManagers = new Map(); // email -> { name, hubs:Set }
  const clusterLeads = new Map();     // email -> { name, hubs:Set }

  for (const r of hubRows) {
    hubInfo.set(r.hub_name, r);
    if (r.hub_email) hubLogins.set(r.hub_email, r.hub_name);
    if (r.ops_manager_email) opsManagers.set(r.ops_manager_email, r.ops_manager_name || r.ops_manager_email);
    if (r.regional_manager_email) {
      if (!regionalManagers.has(r.regional_manager_email)) {
        regionalManagers.set(r.regional_manager_email, { name: r.regional_manager_name || r.regional_manager_email, hubs: new Set() });
      }
      regionalManagers.get(r.regional_manager_email).hubs.add(r.hub_name);
    }
    if (r.cluster_lead_email) {
      if (!clusterLeads.has(r.cluster_lead_email)) {
        clusterLeads.set(r.cluster_lead_email, { name: r.cluster_lead_name || r.cluster_lead_email, hubs: new Set() });
      }
      clusterLeads.get(r.cluster_lead_email).hubs.add(r.hub_name);
    }
  }

  const hubIssues = new Map();           // email -> issues[] (that hub's own login)
  const clusterLeadIssues = new Map();   // email -> issues[]
  const regionalManagerIssues = new Map(); // email -> issues[]

  for (const issue of pending) {
    const info = hubInfo.get(issue.hub);
    if (!info) continue;
    if (info.hub_email) {
      if (!hubIssues.has(info.hub_email)) hubIssues.set(info.hub_email, []);
      hubIssues.get(info.hub_email).push(issue);
    }
    if (info.cluster_lead_email) {
      if (!clusterLeadIssues.has(info.cluster_lead_email)) clusterLeadIssues.set(info.cluster_lead_email, []);
      clusterLeadIssues.get(info.cluster_lead_email).push(issue);
    }
    if (info.regional_manager_email) {
      if (!regionalManagerIssues.has(info.regional_manager_email)) regionalManagerIssues.set(info.regional_manager_email, []);
      regionalManagerIssues.get(info.regional_manager_email).push(issue);
    }
  }

  const digests = [];

  for (const [email, hubName] of hubLogins) {
    digests.push({
      email, name: hubName, roleLabel: 'Hub',
      scopeLabel: hubName,
      issues: hubIssues.get(email) || []
    });
  }

  for (const [email, { name, hubs }] of clusterLeads) {
    digests.push({
      email, name, roleLabel: 'Cluster Lead',
      scopeLabel: [...hubs].join(', ') || 'your hub',
      issues: clusterLeadIssues.get(email) || []
    });
  }

  for (const [email, { name, hubs }] of regionalManagers) {
    digests.push({
      email, name, roleLabel: 'Regional Manager',
      scopeLabel: [...hubs].join(', ') || 'your hubs',
      issues: regionalManagerIssues.get(email) || []
    });
  }

  for (const [email, name] of opsManagers) {
    digests.push({
      email, name, roleLabel: 'Ops Manager',
      scopeLabel: 'All hubs (company-wide)',
      issues: pending // Ops Manager gets the overall, company-wide pending list
    });
  }

  return digests;
}

function fmtDhakaTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return iso;
  }
}

function escapeHtmlMail(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDigestHtml(digest, todayLabel) {
  const grouped = new Map();
  for (const i of digest.issues) {
    if (!grouped.has(i.hub)) grouped.set(i.hub, []);
    grouped.get(i.hub).push(i);
  }
  const hubSections = [...grouped.entries()].map(([hub, issues]) => `
    <p style="margin:18px 0 6px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#1C1B18;">${escapeHtmlMail(hub)} — ${issues.length} pending</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">
      <thead>
        <tr style="background:#f0efec;text-align:left;">
          <th style="padding:8px;border:1px solid #ddd;">Consignment ID</th>
          <th style="padding:8px;border:1px solid #ddd;">Status</th>
          <th style="padding:8px;border:1px solid #ddd;">Logged</th>
        </tr>
      </thead>
      <tbody>
        ${issues.map(i => `
          <tr>
            <td style="padding:8px;border:1px solid #ddd;">${escapeHtmlMail(i.consignment || i.id)}</td>
            <td style="padding:8px;border:1px solid #ddd;">${escapeHtmlMail(i.status)}</td>
            <td style="padding:8px;border:1px solid #ddd;">${fmtDhakaTime(i.ts)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `).join('');

  return `
    <div style="font-family:Arial,sans-serif;color:#1C1B18;max-width:640px;">
      <p>Dear ${escapeHtmlMail(digest.name)},</p>
      <p>Please find below the daily pending issues report for <b>${todayLabel}</b>.</p>
      <p><b>Role:</b> ${escapeHtmlMail(digest.roleLabel)}<br>
         <b>Scope:</b> ${escapeHtmlMail(digest.scopeLabel)}<br>
         <b>Total pending issues:</b> ${digest.issues.length}</p>
      ${digest.issues.length ? hubSections : '<p>There are currently no pending issues in your scope. Good work.</p>'}
      <p style="margin-top:22px;">Kindly review and take the necessary action at your earliest convenience.</p>
      <p>Regards,<br>Carrybee Ops Console (automated report)</p>
    </div>
  `;
}

function renderDigestText(digest, todayLabel) {
  const lines = [];
  lines.push(`Dear ${digest.name},`, '');
  lines.push(`Daily pending issues report for ${todayLabel}.`);
  lines.push(`Role: ${digest.roleLabel}`);
  lines.push(`Scope: ${digest.scopeLabel}`);
  lines.push(`Total pending issues: ${digest.issues.length}`, '');
  if (!digest.issues.length) {
    lines.push('There are currently no pending issues in your scope. Good work.');
  } else {
    const grouped = new Map();
    for (const i of digest.issues) {
      if (!grouped.has(i.hub)) grouped.set(i.hub, []);
      grouped.get(i.hub).push(i);
    }
    for (const [hub, issues] of grouped) {
      lines.push(`${hub} — ${issues.length} pending:`);
      for (const i of issues) lines.push(`  - ${i.consignment || i.id} (${i.status}, logged ${fmtDhakaTime(i.ts)})`);
      lines.push('');
    }
  }
  lines.push('Kindly review and take the necessary action at your earliest convenience.', '', 'Regards,', 'Carrybee Ops Console (automated report)');
  return lines.join('\n');
}

async function sendDailyReports() {
  const transport = getMailer();
  if (!transport) {
    console.warn('Daily report skipped: SMTP_HOST/SMTP_USER/SMTP_PASS are not configured.');
    return { sent: 0, skipped: true };
  }
  const todayLabel = new Date().toLocaleDateString('en-GB', { timeZone: DAILY_REPORT_TZ, day: '2-digit', month: 'long', year: 'numeric' });
  const digests = await buildDailyDigests();
  let sent = 0;
  for (const digest of digests) {
    try {
      await transport.sendMail({
        from: MAIL_FROM || SMTP_USER,
        to: digest.email,
        subject: `Daily Pending Issues Report – ${todayLabel} – ${digest.roleLabel} – ${digest.issues.length} pending`,
        text: renderDigestText(digest, todayLabel),
        html: renderDigestHtml(digest, todayLabel)
      });
      sent++;
    } catch (err) {
      console.error(`Failed to send daily report to ${digest.email}:`, err);
    }
  }
  console.log(`Daily pending-issues report: sent ${sent}/${digests.length}.`);
  return { sent, total: digests.length };
}

if (String(DAILY_REPORT_ENABLED).toLowerCase() === 'true') {
  cron.schedule(DAILY_REPORT_CRON, () => {
    sendDailyReports().catch(err => console.error('Daily report job failed:', err));
  }, { timezone: DAILY_REPORT_TZ });
  console.log(`Daily pending-issues report scheduled: "${DAILY_REPORT_CRON}" (${DAILY_REPORT_TZ}).`);
}

// ---------- time-based escalation ladder ----------
// L3 (Hub) -> 2h silence -> L2 (Cluster Lead / Regional Manager) -> 2h silence
// -> L1 (Ops Manager) -> 1h silence -> stays L1, flagged Very Critical.
// "Silence" = no PATCH to the issue since level_started_at, which every ops
// response resets (see /api/ops/issues/:id). Resolved issues are skipped.
const ESCALATION_RULES = [
  { level: 'L3', hours: 2, nextLevel: 'L2', nextStatus: 'Need attention' },
  { level: 'L2', hours: 2, nextLevel: 'L1', nextStatus: 'Critical' },
  { level: 'L1', hours: 1, nextLevel: 'L1', nextStatus: 'Very critical' }
];

async function runEscalationSweep() {
  const result = await db.execute({
    sql: `SELECT id, escalation_level, response_status, level_started_at
          FROM issues
          WHERE status != 'Resolved' AND (response_status IS NULL OR response_status != 'Very critical')`,
    args: []
  });
  const now = Date.now();
  let escalated = 0;
  const failures = [];
  for (const issue of result.rows) {
    try {
      let level = issue.escalation_level || 'L3';
      let status = issue.response_status || 'Regular';
      let started = issue.level_started_at ? new Date(issue.level_started_at).getTime() : null;
      if (!started || Number.isNaN(started)) continue;
      let advanced = false;
      const steps = [];
      // Walk every level this issue has actually earned in one pass — e.g. an
      // issue that's sat for 3 days should land on "Very critical" in a
      // single sweep, not crawl up one level per 10-minute run. Each step
      // consumes only its own window (started += rule.hours) rather than
      // resetting to "now", so the remaining backlog still counts toward the
      // next level.
      while (true) {
        const rule = ESCALATION_RULES.find(r => r.level === level);
        if (!rule) break;
        // L1's own rule can re-fire (Critical -> Very critical at the same
        // level); every other rule only fires once per level since nextLevel
        // differs from level, moving the row out of that rule's own match.
        if (rule.level === 'L1' && status === 'Very critical') break;
        const hoursSince = (now - started) / (60 * 60 * 1000);
        if (hoursSince < rule.hours) break;
        started += rule.hours * 60 * 60 * 1000;
        level = rule.nextLevel;
        status = rule.nextStatus;
        advanced = true;
        steps.push({ level, status, at: new Date(started).toISOString() });
      }
      if (!advanced) continue;
      await db.execute({
        sql: `UPDATE issues SET escalation_level = ?, response_status = ?, level_started_at = ? WHERE id = ?`,
        args: [level, status, new Date(started).toISOString(), issue.id]
      });
      for (const step of steps) await logEvent(issue.id, 'escalated', 'system', { level: step.level, status: step.status }, step.at);
      escalated++;
    } catch (err) {
      console.error(`Escalation sweep: issue ${issue.id} failed:`, err);
      failures.push({ id: issue.id, error: err.message });
    }
  }
  if (escalated) console.log(`Escalation sweep: advanced ${escalated} issue(s).`);
  if (failures.length) console.log(`Escalation sweep: ${failures.length} issue(s) failed.`);
  return { checked: result.rows.length, escalated, failures };
}

cron.schedule('*/10 * * * *', () => {
  runEscalationSweep().catch(err => console.error('Escalation sweep failed:', err));
});
console.log('Escalation ladder sweep scheduled: every 10 minutes.');

// Manual trigger, same reasoning as /api/admin/send-daily-report: lets an
// external cron service (Render Cron Job, cron-job.org) drive this instead
// of relying on node-cron staying resident if the service can spin down.
app.post('/api/admin/run-escalation-sweep', async (req, res) => {
  if (req.headers['x-setup-key'] !== SETUP_KEY) {
    return res.status(403).json({ error: 'Invalid setup key.' });
  }
  try {
    const result = await runEscalationSweep();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Escalation sweep failed.', detail: err.message });
  }
});

// ONE-TIME repair for the earlier single-step sweep bug: any open issue that
// has never actually been touched by a person (updated_at IS NULL) had its
// level_started_at reset to whatever moment the old buggy sweep happened to
// run, instead of reflecting how long it's genuinely been open. For any such
// issue, the true state is just a function of its original `ts`, so this
// resets it back to L3/Regular/ts and immediately re-runs the (now-fixed)
// cascading sweep to recompute where it actually belongs. Safe to run once;
// harmless to run again later since it only touches never-touched issues.
app.post('/api/admin/resync-escalation', async (req, res) => {
  if (req.headers['x-setup-key'] !== SETUP_KEY) {
    return res.status(403).json({ error: 'Invalid setup key.' });
  }
  try {
    const reset = await db.execute({
      sql: `UPDATE issues SET escalation_level = 'L3', response_status = 'Regular', level_started_at = ts
            WHERE status != 'Resolved' AND updated_at IS NULL`,
      args: []
    });
    const result = await runEscalationSweep();
    res.json({ ok: true, reset: reset.rowsAffected, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Resync failed.', detail: err.message });
  }
});

// Manual trigger for testing, or for an external cron service (e.g. a Render
// Cron Job, or cron-job.org) to hit instead of relying on node-cron staying
// resident — useful if this service can spin down on an inactivity timeout.
app.post('/api/admin/send-daily-report', async (req, res) => {
  if (req.headers['x-setup-key'] !== SETUP_KEY) {
    return res.status(403).json({ error: 'Invalid setup key.' });
  }
  try {
    const result = await sendDailyReports();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send daily report.' });
  }
});

ensureTables()
  .then(() => parcelJourney.ensureTables())
  .then(() => {
    app.listen(PORT, () => console.log(`Escalation backend listening on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to set up tables:', err);
    process.exit(1);
  });
