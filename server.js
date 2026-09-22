require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { createClient } = require('@libsql/client');

const {
  TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN,
  SETUP_KEY,      // required header value to create new login users via /api/auth/register
  PORT = 3000,
  SMTP_HOST,
  SMTP_PORT = 587,
  SMTP_SECURE = 'false',
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM,
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
app.use(express.json());
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
    'ALTER TABLE issues ADD COLUMN closed_at TEXT'
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

app.post('/api/issues', requireAuth, async (req, res) => {
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
  const id = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const ts = new Date().toISOString();
  try {
    await db.execute({
      sql: `INSERT INTO issues
              (id, ts, consignment, channel, media, social_source, zone, hub, status, category, subcategory, details, logged_by,
               escalation_level, response_status, level_started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'L3', 'Regular', ?)`,
      args: [id, ts, i.consignment, i.channel, i.media || null, i.socialSource || null, i.zone, i.hub, i.status, i.category, i.subcategory, i.details, req.user, ts]
    });
    notifyMerchant({ id, consignment: i.consignment }).then(async ok => {
      if (ok) {
        await db.execute({ sql: 'UPDATE issues SET merchant_notified_at = ? WHERE id = ?', args: [new Date().toISOString(), id] });
      }
    }).catch(err => console.error('notifyMerchant failed:', err));
    res.json({ ok: true, id, ts });
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
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not close issue.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

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

const PENDING_STATUSES = ['Open', 'In Progress', 'Escalated'];

let mailer = null;
function getMailer() {
  if (mailer) return mailer;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS }
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
      }
      if (!advanced) continue;
      await db.execute({
        sql: `UPDATE issues SET escalation_level = ?, response_status = ?, level_started_at = ? WHERE id = ?`,
        args: [level, status, new Date(started).toISOString(), issue.id]
      });
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
  .then(() => {
    app.listen(PORT, () => console.log(`Escalation backend listening on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to set up tables:', err);
    process.exit(1);
  });
