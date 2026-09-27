/**
 * Parcel Journey: hub-wise SLA engine, ported from the TQM V4 Apps Script
 * (Parcel.gs), backed by Turso instead of Google Sheets.
 *
 * What it answers: which parcels are stuck right now, at which stage, and in
 * which hub. From a breached parcel (or a whole stage of them at once) a user
 * raises an issue with the same fields as the Log an Issue form; each issue is
 * written to the same `issues` table the dashboards, the Ops Console and the
 * escalation ladder already read, routed to the hub the parcel is in NOW.
 *
 * Storage (all created on boot, safe to re-run):
 *   pj_parcels      the uploaded parcel export, the columns the engine needs,
 *                   tagged with the upload (batch) they came in with
 *   pj_uploads      one row per parcel upload; exactly one is 'active'
 *   sla_hub_matrix  the uploaded SLA Hub Matrix, one row per hub plus a
 *                   'Network Default' row
 *   sla_uploads     who uploaded which SLA file, when
 *   pickup_cutoff   optional per-business pickup cutoff ('*' = default)
 *
 * Rules kept from TQM:
 *   - targets are per hub. First mile stages use the pickup hub, last mile
 *     stages the delivery hub
 *   - Pickup is a wall clock cutoff, not a duration, and a miss is attributed
 *     to the merchant or to CarryBee
 *   - a parcel is in a stage's box only while that stage is OPEN and past
 *     target; it leaves when the stage closes or the parcel goes terminal
 *     (Terminal to Invoice excepted, since terminal is its start)
 *   - the snapshot is the latest thing that HAPPENED in the file; planned
 *     times (cutoffs, handover commitments) never move it
 *   - a stage with no end scan on a parcel that has moved past it is a data
 *     gap ("check"), not an open breach
 *
 * All naive timestamps in the export are Bangladesh time (UTC+6, no DST).
 * They are converted to epoch milliseconds on load, so the server's own time
 * zone (UTC on Render) never matters.
 */

const crypto = require('crypto');
const HUB_INFO = require('./hub-info.json');

/* ------------------------------------------------------------------ config */

const BD_OFFSET_MS = 6 * 3600000;
const OPERATIONAL_DAY_START_HOUR = 6;
const BOX_ROW_CAP = 150;                 // breached rows sent per stage box
const JOURNEY_PAGE_SIZE = 50;
const UPLOAD_CHUNK_MAX_ROWS = 5000;      // per /upload/chunk call
const INSERT_ROWS_PER_STATEMENT = 200;
const BULK_MAX_PARCELS = 2000;           // per issue submission
const BULK_ATTACHMENT_BUDGET = 30 * 1024 * 1024; // attachments are copied onto every issue
const DEFAULT_PICKUP_HOUR = 18;

/* ------------------------------------------------------------ stage model */

const SLA_STAGE_DEFS = [
  { key: 'pickup', label: 'Pickup SLA', short: 'Pickup', column: null, hub: 'pickup',
    from: 'Customized last pickup at', to: 'Pickup Picked at' },
  { key: 'pickup_fmh', label: 'Pickup to FMH SLA', short: 'Pickup to FMH',
    column: 'Pickup-FMH SLA', hub: 'pickup', from: 'Pickup Picked at', to: 'FMH Basket Created at' },
  { key: 'fmh_cw', label: 'FMH to CW SLA', short: 'FMH to CW',
    column: 'FMH-CW SLA', hub: 'pickup', from: 'FMH Basket Created at', to: 'Central Warehouse Reached at' },
  { key: 'fmh_subsort', label: 'FMH to Sub Sort SLA', short: 'FMH to Sub Sort',
    column: 'FMH-Sub Sort SLA', hub: 'pickup', from: 'FMH Basket Created at', to: 'Sub Sort Reached at' },
  { key: 'cw_lmh', label: 'CW to LMH SLA', short: 'CW to LMH',
    column: 'CW-LMH SLA', hub: 'delivery', from: 'Central Warehouse Reached at', to: 'Basket Reached LMH at' },
  { key: 'subsort_lmh', label: 'Sub Sort to LMH SLA', short: 'Sub Sort to LMH',
    column: 'SUB Sort- LMH SLA', hub: 'delivery', from: 'Sub Sort Reached at', to: 'Basket Reached LMH at' },
  { key: 'lmh_attempt', label: 'LMH to First Attempt SLA', short: 'LMH to 1st Attempt',
    column: 'LMH- 1st Attempt SLA', hub: 'delivery', from: 'Basket Reached LMH at', to: '1st Attempt at' },
  { key: 'lmh_terminal', label: 'LMH to Terminal SLA', short: 'LMH to Terminal',
    column: 'LMH-Terminal SLA', hub: 'delivery', from: 'Basket Reached LMH at', to: 'Terminal at' },
  { key: 'terminal_invoice', label: 'Terminal to Invoice SLA', short: 'Terminal to Invoice',
    column: 'Terminal-Invoice SLA', hub: 'delivery', from: 'Terminal at', to: 'Invoice Genarated at' }
];

const SLA_MATRIX_HEADERS = [
  'Hub Name', 'Pickup-FMH SLA', 'FMH-CW SLA', 'FMH-Sub Sort SLA',
  'CW-LMH SLA', 'SUB Sort- LMH SLA', 'LMH- 1st Attempt SLA',
  'LMH-Terminal SLA', 'Terminal-Invoice SLA'
];

const NETWORK_DEFAULT_ROW = 'Network Default';

const HARD_DEFAULT_HOURS = {
  pickup_fmh: 4, fmh_cw: 6, fmh_subsort: 5, cw_lmh: 12,
  subsort_lmh: 10, lmh_attempt: 14, lmh_terminal: 20, terminal_invoice: 8
};

const TERMINAL_STATUS_IDS = { 15: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 1, 22: 1, 32: 1 };

const PARCEL_DIMENSIONS = [
  { key: 'hub', label: 'Hub (where the parcel is now)' },
  { key: 'cluster', label: 'Cluster' },
  { key: 'region', label: 'Region' },
  { key: 'pickup', label: 'Pickup hub' },
  { key: 'delivery', label: 'Delivery hub' },
  { key: 'route', label: 'Route path' },
  { key: 'day', label: 'Operational day' },
  { key: 'merchant', label: 'Merchant' }
];

/**
 * The export columns kept in Turso: [db column, export header, time field key].
 * The browser sends upload rows in exactly this order. 'LMH at' is kept only
 * as a fallback for a blank 'Basket Reached LMH at'.
 */
const PARCEL_COLUMNS = [
  ['cid', 'CID'],
  ['id_type', 'ID Type'],
  ['business_id', 'Business ID'],
  ['business_name', 'Business Name'],
  ['status_id', 'Current Status ID'],
  ['pickup_hub', 'Pickup Hub'],
  ['delivery_hub', 'Delivery Hub'],
  ['sorted_day', 'Sorted Day (06:00-06:00)', 'day'],
  ['route_path', 'Route Path'],
  ['created_at', 'Created at', 'createdAt'],
  ['request_at', 'Pickup Request at', 'requestAt'],
  ['cutoff_at', 'Customized last pickup at', 'cutoffAt'],
  ['commitment_at', 'Parcel handover commitment at', 'commitmentAt'],
  ['reached_at', 'Pickup Reached at', 'reachedAt'],
  ['picked_at', 'Pickup Picked at', 'pickedAt'],
  ['fmh_at', 'FMH Basket Created at', 'fmhAt'],
  ['cw_at', 'Central Warehouse Reached at', 'cwAt'],
  ['subsort_at', 'Sub Sort Reached at', 'subSortAt'],
  ['lmh_at', 'Basket Reached LMH at', 'lmhAt'],
  ['lmh_fallback_at', 'LMH at', 'lmhFallback'],
  ['attempt_at', '1st Attempt at', 'attemptAt'],
  ['terminal_at', 'Terminal at', 'terminalAt'],
  ['invoice_at', 'Invoice Genarated at', 'invoiceAt'],
  ['updated_at', 'Transfer Status Updated at', 'updatedAt']
];

const TIME_KEYS = ['createdAt', 'requestAt', 'cutoffAt', 'commitmentAt', 'reachedAt', 'pickedAt',
                   'fmhAt', 'cwAt', 'subSortAt', 'lmhAt', 'attemptAt', 'terminalAt', 'invoiceAt', 'updatedAt'];
const TIME_KEY_HEADER = {};
PARCEL_COLUMNS.forEach(c => { if (c[2]) TIME_KEY_HEADER[c[2]] = c[1]; });
const PLANNED_FIELDS = { cutoffAt: true, commitmentAt: true };

/**
 * Timestamps that prove a parcel has moved beyond a stage. A stage with no
 * end stamp is only OPEN if none of these exist; otherwise its end scan is
 * missing, which is a data gap, not a parcel stuck in the stage.
 */
const STAGE_DOWNSTREAM_FIELDS = {
  pickup: ['fmhAt', 'cwAt', 'subSortAt', 'lmhAt', 'attemptAt', 'terminalAt'],
  pickup_fmh: ['cwAt', 'subSortAt', 'lmhAt', 'attemptAt', 'terminalAt'],
  fmh_cw: ['lmhAt', 'attemptAt', 'terminalAt'],
  fmh_subsort: ['lmhAt', 'attemptAt', 'terminalAt'],
  cw_lmh: ['attemptAt', 'terminalAt'],
  subsort_lmh: ['attemptAt', 'terminalAt'],
  lmh_attempt: ['terminalAt'],
  lmh_terminal: ['invoiceAt'],
  terminal_invoice: []
};

const STAGE_START_FIELD = {
  pickup_fmh: 'pickedAt', fmh_cw: 'fmhAt', fmh_subsort: 'fmhAt',
  cw_lmh: 'cwAt', subsort_lmh: 'subSortAt', lmh_attempt: 'lmhAt',
  lmh_terminal: 'lmhAt', terminal_invoice: 'terminalAt'
};
const STAGE_END_FIELD = {
  pickup: 'pickedAt', pickup_fmh: 'fmhAt', fmh_cw: 'cwAt', fmh_subsort: 'subSortAt',
  cw_lmh: 'lmhAt', subsort_lmh: 'lmhAt', lmh_attempt: 'attemptAt',
  lmh_terminal: 'terminalAt', terminal_invoice: 'invoiceAt'
};

/** One letter per outcome; an open breach is M (merchant side), C (CarryBee side) or B. */
const OUTCOME_CODE = {
  closed_within: 'W', closed_late: 'L', open_within: 'O', open_breached: 'B',
  pending: 'P', sequence_error: 'E', not_applicable: 'N'
};

/* ------------------------------------------------------------- helpers --- */

function text(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
}

function num(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return isNaN(parsed) ? 0 : parsed;
}

function round2(value) {
  if (value === null || value === undefined || isNaN(value)) return null;
  return Math.round(value * 100) / 100;
}

function excelSerialToMs(serial) {
  return Math.round((serial - 25569) * 86400000) - BD_OFFSET_MS;
}

/**
 * A cell into epoch milliseconds, or null. Naive date-times are Bangladesh
 * time. Accepts 'YYYY-MM-DD HH:MM[:SS]', 'M/D/YYYY H:MM [AM|PM]', anything
 * with an explicit offset, and a bare Excel date serial.
 */
function parseTs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return isFinite(value) && value > 0 ? excelSerialToMs(value) : null;
  const t = String(value).trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    return n > 20000 && n < 90000 ? excelSerialToMs(n) : null;
  }
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    if (m[7]) {
      const parsed = Date.parse(t.replace(' ', 'T'));
      return isNaN(parsed) ? null : parsed;
    }
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - BD_OFFSET_MS;
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (m) {
    let hour = +(m[4] || 0);
    if (m[7]) {
      const pm = m[7].toUpperCase() === 'PM';
      if (hour === 12) hour = pm ? 12 : 0; else if (pm) hour += 12;
    }
    return Date.UTC(+m[3], +m[1] - 1, +m[2], hour, +(m[5] || 0), +(m[6] || 0)) - BD_OFFSET_MS;
  }
  const parsed = Date.parse(t);
  return isNaN(parsed) ? null : parsed;
}

/** Bangladesh calendar date of an instant. */
function bdYmd(ms) {
  return new Date(ms + BD_OFFSET_MS).toISOString().slice(0, 10);
}

/** The 06:00-06:00 Bangladesh operational day an instant belongs to. */
function operationalDay(ms) {
  return bdYmd(ms - OPERATIONAL_DAY_START_HOUR * 3600000);
}

/** 'YYYY-MM-DD HH:MM', Bangladesh time. */
function fmtTs(ms) {
  if (ms === null || ms === undefined || ms === '') return '';
  return new Date(Number(ms) + BD_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

function stageByKey(key) {
  return SLA_STAGE_DEFS.find(stage => stage.key === key) || null;
}

function isBreachLetter(letter) { return letter === 'B' || letter === 'M' || letter === 'C'; }

function headerIndex(headerRow) {
  const index = {};
  (headerRow || []).forEach((value, position) => {
    const name = text(value).toLowerCase();
    if (name && index[name] === undefined) index[name] = position;
  });
  return index;
}

const HUB_META = {};
HUB_INFO.forEach(h => {
  HUB_META[h.name.toLowerCase()] = { name: h.name, region: h.region || 'Unmapped', division: h.division || 'Unmapped' };
});

function hubMeta(name) {
  return HUB_META[String(name || '').toLowerCase()] || { name, region: 'Unmapped', division: 'Unmapped' };
}

/**
 * The form's Zone for a hub. Zone is the hub list's region (ISD / SUB / OSD);
 * Central Sort is its own zone on the Log an Issue form, so it stays one here.
 */
function zoneForHub(name) {
  if (String(name || '').toLowerCase() === 'central sort') return 'Central Sort';
  return hubMeta(name).region;
}

/* ------------------------------------------------------------ the module */

function registerParcelJourney(app, { db, requireAuth }) {
  const admins = String(process.env.PARCEL_ADMINS || '')
    .split(',').map(email => email.trim().toLowerCase()).filter(Boolean);

  /** Who may replace the parcel file or the SLA matrix. */
  function canUpload(email) {
    if (!admins.length) return true;           // not configured: every signed-in user
    return admins.includes(String(email || '').toLowerCase());
  }

  let issueEventsSupported = false;

  /* ------------------------------------------------------------- tables -- */

  async function ensureTables() {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS pj_parcels (
        batch_id INTEGER NOT NULL,
        ${PARCEL_COLUMNS.map(c => `${c[0]} TEXT`).join(',\n        ')}
      )
    `);
    await db.execute('CREATE INDEX IF NOT EXISTS pj_parcels_batch ON pj_parcels(batch_id)');
    await db.execute(`
      CREATE TABLE IF NOT EXISTS pj_uploads (
        batch_id INTEGER PRIMARY KEY,
        file_name TEXT,
        expected_rows INTEGER,
        received_rows INTEGER NOT NULL DEFAULT 0,
        missing_columns TEXT,
        uploaded_by TEXT,
        started_at TEXT,
        finished_at TEXT,
        status TEXT
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS sla_hub_matrix (
        hub_name TEXT PRIMARY KEY,
        ${SLA_STAGE_DEFS.filter(s => s.column).map(s => `${s.key} REAL`).join(',\n        ')},
        uploaded_by TEXT,
        uploaded_at TEXT
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS sla_uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_name TEXT,
        hubs INTEGER,
        uploaded_by TEXT,
        uploaded_at TEXT
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS pickup_cutoff (
        business_id TEXT PRIMARY KEY,
        business_name TEXT,
        last_pickup_time TEXT,
        note TEXT
      )
    `);
    // Which SLA stage an issue was raised from, and that it came from here.
    for (const stmt of [
      'ALTER TABLE issues ADD COLUMN sla_stage TEXT',
      'ALTER TABLE issues ADD COLUMN source TEXT'
    ]) {
      try {
        await db.execute(stmt);
      } catch (err) {
        if (!String(err.message || '').includes('duplicate column')) throw err;
      }
    }
    // Some deployments keep an issue_events audit trail. When it is there,
    // issues raised from here get the same 'logged' row as form submissions.
    try {
      const cols = (await db.execute('PRAGMA table_info(issue_events)')).rows.map(r => r.name);
      issueEventsSupported = ['issue_id', 'ts', 'type', 'actor'].every(c => cols.includes(c));
    } catch (err) {
      issueEventsSupported = false;
    }
  }

  /* ---------------------------------------------------- reference data -- */

  async function readSlaMatrix() {
    const out = { byHub: {}, network: {}, hubCount: 0, source: 'built in defaults',
                  uploadedBy: null, uploadedAt: null, fileName: null };
    SLA_STAGE_DEFS.forEach(stage => { if (stage.column) out.network[stage.key] = HARD_DEFAULT_HOURS[stage.key]; });
    const rows = (await db.execute('SELECT * FROM sla_hub_matrix')).rows;
    for (const row of rows) {
      const hours = {};
      SLA_STAGE_DEFS.forEach(stage => {
        if (!stage.column) return;
        const value = Number(row[stage.key]);
        if (value > 0) hours[stage.key] = value;
      });
      if (String(row.hub_name).toLowerCase() === NETWORK_DEFAULT_ROW.toLowerCase()) {
        Object.assign(out.network, hours);
      } else {
        out.byHub[String(row.hub_name).toLowerCase()] = { name: row.hub_name, hours };
        out.hubCount++;
      }
    }
    if (rows.length) out.source = out.hubCount ? 'sla_hub_matrix' : 'network default row only';
    const last = (await db.execute('SELECT * FROM sla_uploads ORDER BY id DESC LIMIT 1')).rows[0];
    if (last) {
      out.uploadedBy = last.uploaded_by;
      out.uploadedAt = last.uploaded_at;
      out.fileName = last.file_name;
    }
    return out;
  }

  function targetHours(matrix, stageKey, hubName) {
    const memo = matrix._memo || (matrix._memo = {});
    const memoKey = stageKey + '|' + hubName;
    if (memo[memoKey]) return memo[memoKey];
    const hub = matrix.byHub[String(hubName || '').toLowerCase()];
    let result;
    if (hub && hub.hours[stageKey]) result = { hours: hub.hours[stageKey], source: 'hub' };
    else if (matrix.network[stageKey]) result = { hours: matrix.network[stageKey], source: 'network' };
    else result = { hours: HARD_DEFAULT_HOURS[stageKey] || 0, source: 'built in' };
    memo[memoKey] = result;
    return result;
  }

  /** Accepts "18:00", 18, a sheet time fraction such as 0.75. */
  function parseCutoffHour(value) {
    const t = text(value);
    if (!t) return null;
    if (t.indexOf(':') >= 0) {
      const parts = t.split(':');
      const hour = parseInt(parts[0], 10);
      if (isNaN(hour)) return null;
      return hour + (parseInt(parts[1], 10) || 0) / 60;
    }
    const n = Number(t);
    if (isNaN(n)) return null;
    if (n > 0 && n < 1) return n * 24;
    if (n >= 0 && n <= 24) return n;
    return null;
  }

  async function readPickupCutoffs() {
    const out = { byBusiness: {}, defaultHour: DEFAULT_PICKUP_HOUR, rows: 0 };
    const rows = (await db.execute('SELECT business_id, last_pickup_time FROM pickup_cutoff')).rows;
    for (const row of rows) {
      const hour = parseCutoffHour(row.last_pickup_time);
      if (hour === null) continue;
      const id = text(row.business_id);
      if (id === '*') out.defaultHour = hour;
      else if (id) { out.byBusiness[id] = hour; out.rows++; }
    }
    return out;
  }

  /**
   * The cutoff for one parcel: the row's own column when it carries a value,
   * otherwise the NEXT occurrence of the business's cutoff hour (Bangladesh
   * time) at or after the request.
   */
  function pickupCutoffFor(row, cutoffs) {
    if (row.cutoffAt) return { at: row.cutoffAt, source: 'Customized last pickup at' };
    const reference = row.requestAt || row.createdAt;
    if (!reference) return { at: null, source: 'No request timestamp' };
    let hour = cutoffs.byBusiness[row.businessId];
    let source = 'Pickup cutoff table';
    if (hour === undefined) { hour = cutoffs.defaultHour; source = 'Network default'; }
    const local = new Date(reference + BD_OFFSET_MS);
    let at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
                      Math.floor(hour), Math.round((hour % 1) * 60), 0) - BD_OFFSET_MS;
    if (reference >= at) at += 86400000;
    return { at, source };
  }

  /* ------------------------------------------------------ stage outcomes -- */

  function movedPast(stageKey, row) {
    return (STAGE_DOWNSTREAM_FIELDS[stageKey] || []).some(field => row[field] !== null && row[field] !== undefined);
  }

  function evaluateStage(stage, row, matrix, cutoffs, snapshotMs) {
    if (stage.key === 'pickup') return evaluatePickup(row, cutoffs, snapshotMs);

    if (stage.key === 'fmh_cw' && row.firstSort !== 'cw') return { outcome: 'not_applicable' };
    if (stage.key === 'fmh_subsort' && row.firstSort !== 'subsort') return { outcome: 'not_applicable' };
    if (stage.key === 'cw_lmh' && row.lastSort !== 'cw') return { outcome: 'not_applicable' };
    if (stage.key === 'subsort_lmh' && row.lastSort !== 'subsort') return { outcome: 'not_applicable' };

    const start = row[STAGE_START_FIELD[stage.key]];
    const end = row[STAGE_END_FIELD[stage.key]];
    const hubName = stage.hub === 'pickup' ? row.pickupHub : row.hub;
    const target = targetHours(matrix, stage.key, hubName);

    if (start === null) {
      return { outcome: 'pending', targetHours: target.hours, targetSource: target.source, hub: hubName };
    }
    if (end !== null) {
      const elapsed = (end - start) / 3600000;
      if (elapsed < 0) {
        return { outcome: 'sequence_error', hours: elapsed, targetHours: target.hours,
                 targetSource: target.source, hub: hubName, startAt: start, endAt: end };
      }
      return { outcome: elapsed > target.hours ? 'closed_late' : 'closed_within',
               hours: elapsed, targetHours: target.hours, targetSource: target.source,
               hub: hubName, startAt: start, endAt: end };
    }
    if (movedPast(stage.key, row)) {
      return { outcome: 'sequence_error', hours: null, targetHours: target.hours,
               targetSource: target.source, hub: hubName, startAt: start, endAt: null,
               reason: stage.to + ' was never recorded, but the parcel has moved on' };
    }
    const openFor = (snapshotMs - start) / 3600000;
    return { outcome: openFor > target.hours ? 'open_breached' : 'open_within',
             hours: openFor, targetHours: target.hours, targetSource: target.source,
             hub: hubName, startAt: start, endAt: null, overBy: openFor - target.hours };
  }

  /**
   * Merchant side: the handover commitment (or the request, when there is no
   * commitment) is after the cutoff. CarryBee side: the merchant was inside
   * the cutoff but the agent arrived after it, or the cutoff passed with no
   * arrival.
   */
  function evaluatePickup(row, cutoffs, snapshotMs) {
    if (row.idType === 'Reverse') return { outcome: 'not_applicable' };
    const cutoff = pickupCutoffFor(row, cutoffs);
    if (!cutoff.at) return { outcome: 'pending', side: '', cutoffSource: cutoff.source };

    const cutoffMs = cutoff.at;
    const merchantMark = row.commitmentAt !== null ? row.commitmentAt : row.requestAt;
    const merchantLate = merchantMark !== null && merchantMark > cutoffMs;
    const base = { cutoffAt: cutoffMs, cutoffSource: cutoff.source, startAt: row.requestAt,
                   commitmentAt: row.commitmentAt, reachedAt: row.reachedAt,
                   hub: row.pickupHub, targetHours: null };

    if (row.pickedAt === null && movedPast('pickup', row)) {
      return Object.assign(base, { outcome: 'sequence_error', side: '', hours: null,
        reason: 'Pickup Picked at was never recorded, but the parcel has moved on' });
    }
    if (row.pickedAt !== null) {
      const mark = row.reachedAt !== null ? row.reachedAt : row.pickedAt;
      const lateBy = (mark - cutoffMs) / 3600000;
      if (merchantLate) return Object.assign(base, { outcome: 'closed_late', side: 'Merchant', hours: lateBy, endAt: row.pickedAt });
      if (mark > cutoffMs) return Object.assign(base, { outcome: 'closed_late', side: 'CarryBee', hours: lateBy, endAt: row.pickedAt });
      return Object.assign(base, { outcome: 'closed_within', side: '', hours: lateBy, endAt: row.pickedAt });
    }
    if (merchantLate) {
      const merchantOver = (merchantMark - cutoffMs) / 3600000;
      return Object.assign(base, { outcome: 'open_breached', side: 'Merchant', hours: merchantOver,
        overBy: merchantOver, reason: 'Handover commitment is after the cutoff',
        toLabel: row.commitmentAt !== null ? 'Handover commitment' : 'Pickup request', toAt: merchantMark });
    }
    if (row.reachedAt !== null && row.reachedAt > cutoffMs) {
      const reachOver = (row.reachedAt - cutoffMs) / 3600000;
      return Object.assign(base, { outcome: 'open_breached', side: 'CarryBee', hours: reachOver,
        overBy: reachOver, reason: 'Agent reached after the cutoff', toLabel: 'Pickup Reached at', toAt: row.reachedAt });
    }
    const overBy = (snapshotMs - cutoffMs) / 3600000;
    if (snapshotMs > cutoffMs) {
      return Object.assign(base, { outcome: 'open_breached', side: 'CarryBee', hours: overBy, overBy,
        reason: row.reachedAt !== null ? 'Reached but not collected, cutoff passed' : 'Cutoff passed with no agent arrival',
        toLabel: 'Now (snapshot)', toAt: snapshotMs });
    }
    return Object.assign(base, { outcome: 'open_within', side: '', hours: overBy });
  }

  /** Terminal to Invoice is the one stage a terminal parcel can still be stuck in. */
  function liveOutcome(stageKey, row, result) {
    if (stageKey !== 'terminal_invoice' && row.isTerminal) {
      if (result.outcome === 'open_breached') return 'closed_late';
      if (result.outcome === 'open_within') return 'closed_within';
    }
    return result.outcome;
  }

  function defaultReason(result) {
    if (result.targetHours === null || result.targetHours === undefined) return 'Past cutoff';
    return 'Open ' + round2(result.hours || 0) + ' h against a ' + result.targetHours +
           ' h target at ' + (result.hub || 'this hub');
  }

  function breachWindow(stage, result, snapshotMs) {
    if (stage.key === 'pickup') {
      return { fromLabel: 'Pickup cutoff (' + (result.cutoffSource || 'cutoff') + ')',
               fromAt: fmtTs(result.cutoffAt),
               toLabel: result.toLabel || 'Now (snapshot)',
               toAt: fmtTs(result.toAt || snapshotMs) };
    }
    return { fromLabel: stage.from, fromAt: fmtTs(result.startAt),
             toLabel: 'Now (snapshot)', toAt: fmtTs(snapshotMs) };
  }

  /* -------------------------------------------------------- the dataset -- */

  // Everything the views need, built once from Turso and kept in memory until
  // a new parcel file or SLA matrix is uploaded.
  let DATA = null;
  let BUILDING = null;

  function invalidate() { DATA = null; }

  async function activeUpload() {
    return (await db.execute(
      "SELECT * FROM pj_uploads WHERE status = 'active' ORDER BY batch_id DESC LIMIT 1")).rows[0] || null;
  }

  function assignSortBranch(row) {
    const routeLower = row.route.toLowerCase();
    const subPosition = routeLower.indexOf('sub sort');
    const cwPosition = routeLower.indexOf('central warehouse');
    if (row.cwAt !== null && row.subSortAt !== null) {
      const subFirst = row.subSortAt <= row.cwAt;
      row.firstSort = subFirst ? 'subsort' : 'cw';
      row.lastSort = subFirst ? 'cw' : 'subsort';
    } else if (row.cwAt !== null) {
      row.firstSort = 'cw'; row.lastSort = 'cw';
    } else if (row.subSortAt !== null) {
      row.firstSort = 'subsort'; row.lastSort = 'subsort';
    } else if (subPosition >= 0 && cwPosition >= 0) {
      row.firstSort = subPosition < cwPosition ? 'subsort' : 'cw';
      row.lastSort = subPosition < cwPosition ? 'cw' : 'subsort';
    } else if (subPosition >= 0) {
      row.firstSort = 'subsort'; row.lastSort = 'subsort';
    } else if (cwPosition >= 0) {
      row.firstSort = 'cw'; row.lastSort = 'cw';
    } else {
      row.firstSort = null; row.lastSort = null;
    }
  }

  async function buildData() {
    const upload = await activeUpload();
    const [matrix, cutoffs] = await Promise.all([readSlaMatrix(), readPickupCutoffs()]);
    const data = { upload, matrix, cutoffs, rows: [], snapshotAt: Date.now(), emptyFields: [],
                   missingColumns: [], feedGaps: {}, builtAt: Date.now() };
    if (!upload) return data;
    try { data.missingColumns = JSON.parse(upload.missing_columns || '[]'); } catch (e) { data.missingColumns = []; }

    const result = await db.execute({
      sql: `SELECT ${PARCEL_COLUMNS.map(c => c[0]).join(', ')} FROM pj_parcels WHERE batch_id = ?`,
      args: [upload.batch_id]
    });

    let latest = 0;
    const filled = {};
    data.rows = result.rows.map((r, i) => {
      const row = {
        i,
        cid: text(r.cid),
        idType: text(r.id_type) || 'Forward',
        businessId: text(r.business_id).replace(/\.0$/, ''),
        businessName: text(r.business_name),
        statusId: num(r.status_id),
        pickupHub: text(r.pickup_hub),
        hub: text(r.delivery_hub),
        route: text(r.route_path) || 'Unknown'
      };
      PARCEL_COLUMNS.forEach(col => {
        const key = col[2];
        if (!key || key === 'day') return;
        row[key] = parseTs(r[col[0]]);
      });
      if (row.lmhAt === null) row.lmhAt = row.lmhFallback;
      delete row.lmhFallback;
      TIME_KEYS.forEach(key => {
        const value = row[key];
        if (value === null) return;
        filled[key] = true;
        if (value > latest && !PLANNED_FIELDS[key]) latest = value;
      });

      row.isTerminal = !!(TERMINAL_STATUS_IDS[row.statusId] || row.terminalAt !== null);
      row.invoiced = row.invoiceAt !== null;
      row.state = !row.isTerminal ? 'process' : (row.invoiced ? 'closed' : 'tni');
      // Where the parcel is now: its pickup hub until it reaches a sort point,
      // then its delivery hub.
      const pastFirstMile = row.cwAt !== null || row.subSortAt !== null || row.lmhAt !== null || row.isTerminal;
      row.curHub = pastFirstMile ? row.hub : row.pickupHub;
      const meta = hubMeta(row.curHub);
      row.curRegion = meta.region;
      row.curCluster = meta.division;
      assignSortBranch(row);

      const sortedDay = text(r.sorted_day);
      if (/^\d{4}-\d{2}-\d{2}/.test(sortedDay)) row.day = sortedDay.slice(0, 10);
      else {
        const dayMs = parseTs(sortedDay);
        row.day = dayMs !== null ? bdYmd(dayMs) : (row.createdAt !== null ? operationalDay(row.createdAt) : '');
      }
      return row;
    });
    data.snapshotAt = latest || Date.now();
    data.emptyFields = data.rows.length
      ? TIME_KEYS.filter(key => !filled[key] && !data.missingColumns.includes(TIME_KEY_HEADER[key]))
      : [];

    // Every parcel is evaluated once here; a request only filters and tallies.
    const started = SLA_STAGE_DEFS.map(() => 0);
    for (const row of data.rows) {
      let codes = '';
      row.ov = {};
      SLA_STAGE_DEFS.forEach((stage, s) => {
        const res = evaluateStage(stage, row, matrix, cutoffs, data.snapshotAt);
        const outcome = liveOutcome(stage.key, row, res);
        if (outcome === 'open_breached') {
          codes += res.side === 'Merchant' ? 'M' : res.side === 'CarryBee' ? 'C' : 'B';
          row.ov[s] = round2(res.overBy !== undefined ? res.overBy : (res.hours || 0));
        } else {
          codes += OUTCOME_CODE[outcome];
        }
        if (outcome !== 'pending' && outcome !== 'not_applicable') started[s]++;
      });
      row.codes = codes;
    }
    SLA_STAGE_DEFS.forEach((stage, s) => {
      data.feedGaps[stage.key] = data.rows.length > 0 && started[s] === 0;
    });
    data.byCid = new Map(data.rows.map(row => [row.cid.toLowerCase(), row]));
    return data;
  }

  async function getData() {
    if (DATA) return DATA;
    if (!BUILDING) {
      BUILDING = buildData().then(built => { DATA = built; BUILDING = null; return built; },
                                  err => { BUILDING = null; throw err; });
    }
    return BUILDING;
  }

  /** Open issues raised from here, by CID and stage. */
  async function openIssueIndex() {
    const rows = (await db.execute(`
      SELECT id, consignment, sla_stage, hub, status, response_status, escalation_level, ts
      FROM issues
      WHERE sla_stage IS NOT NULL AND closed_by IS NULL AND COALESCE(status, '') != 'Resolved'
    `)).rows;
    const index = {};
    for (const r of rows) {
      index[String(r.consignment).toLowerCase() + '|' + r.sla_stage] = {
        id: r.id, hub: r.hub, status: r.status, flag: r.response_status,
        level: r.escalation_level, raisedAt: fmtTs(Date.parse(r.ts))
      };
    }
    return index;
  }

  /* ------------------------------------------------------------ filters -- */

  function parcelFilters(options) {
    options = options || {};
    return {
      idType: options.idType || 'All',
      fromDay: text(options.from), toDay: text(options.to),
      region: text(options.region), cluster: text(options.cluster),
      hub: text(options.hub), route: text(options.route),
      search: text(options.search).toLowerCase()
    };
  }

  function rowPasses(row, f) {
    if (f.idType !== 'All' && row.idType !== f.idType) return false;
    if (f.fromDay && row.day && row.day < f.fromDay) return false;
    if (f.toDay && row.day && row.day > f.toDay) return false;
    if (f.region && row.curRegion !== f.region) return false;
    if (f.cluster && row.curCluster !== f.cluster) return false;
    if (f.hub && row.curHub !== f.hub) return false;
    if (f.route && row.route !== f.route) return false;
    if (f.search && row.cid.toLowerCase().indexOf(f.search) < 0 &&
        row.businessName.toLowerCase().indexOf(f.search) < 0 &&
        row.businessId.toLowerCase().indexOf(f.search) < 0) return false;
    return true;
  }

  function breakdownKey(row, dimension) {
    if (dimension === 'cluster') return row.curCluster;
    if (dimension === 'region') return row.curRegion;
    if (dimension === 'pickup') return row.pickupHub || 'Unknown';
    if (dimension === 'delivery') return row.hub || 'Unknown';
    if (dimension === 'route') return row.route;
    if (dimension === 'day') return row.day || 'Unknown';
    if (dimension === 'merchant') return row.businessName || row.businessId || 'Unknown';
    return row.curHub || 'Unknown';
  }

  /** Region, cluster and hub options for the cascading filter, limited to hubs holding parcels. */
  function hubHierarchy(hubNames) {
    const regions = {}, clusters = {};
    const hubs = hubNames.filter(Boolean).sort().map(name => {
      const meta = hubMeta(name);
      regions[meta.region] = 1;
      clusters[meta.region + '|' + meta.division] = { name: meta.division, region: meta.region };
      return { name, region: meta.region, cluster: meta.division };
    });
    return {
      regions: Object.keys(regions).sort(),
      clusters: Object.keys(clusters).sort().map(key => clusters[key]),
      hubs
    };
  }

  /* -------------------------------------------------------------- views -- */

  function stageRowView(data, stage, s, row, issues) {
    const res = evaluateStage(stage, row, data.matrix, data.cutoffs, data.snapshotAt);
    const win = breachWindow(stage, res, data.snapshotAt);
    return {
      cid: row.cid, businessId: row.businessId, businessName: row.businessName,
      hubNow: row.curHub, zoneNow: zoneForHub(row.curHub), clusterNow: row.curCluster,
      pickupHub: row.pickupHub, deliveryHub: row.hub, day: row.day, state: row.state,
      side: res.side || '', reason: res.reason || defaultReason(res),
      fromLabel: win.fromLabel, fromAt: win.fromAt, toLabel: win.toLabel, toAt: win.toAt,
      elapsedHours: round2(res.hours || 0),
      targetHours: res.targetHours === null || res.targetHours === undefined ? null : round2(res.targetHours),
      targetSource: res.targetSource || res.cutoffSource || '',
      lateBy: round2(row.ov[s] || 0),
      issue: issues[row.cid.toLowerCase() + '|' + stage.key] || null
    };
  }

  async function buildView(user, options) {
    options = options || {};
    const data = await getData();
    const matrix = data.matrix;
    const base = {
      canUpload: canUpload(user),
      adminsConfigured: admins.length > 0,
      uploadColumns: PARCEL_COLUMNS.map(c => ({ header: c[1], time: !!c[2] })),
      slaHeaders: SLA_MATRIX_HEADERS,
      stageDefs: SLA_STAGE_DEFS.map(s => ({ key: s.key, label: s.label, short: s.short, from: s.from,
                                           to: s.to, hubSide: s.hub, isCutoff: s.key === 'pickup',
                                           network: s.column ? matrix.network[s.key] : null })),
      matrix: { source: matrix.source, hubCount: matrix.hubCount, network: matrix.network,
                uploadedBy: matrix.uploadedBy, uploadedAt: matrix.uploadedAt, fileName: matrix.fileName },
      cutoffs: { defaultHour: data.cutoffs.defaultHour, businessRows: data.cutoffs.rows },
      dataset: data.upload ? {
        fileName: data.upload.file_name, rows: data.rows.length,
        uploadedBy: data.upload.uploaded_by, uploadedAt: fmtTs(Date.parse(data.upload.finished_at))
      } : null
    };
    if (!data.upload) return Object.assign(base, { empty: true });

    const issues = await openIssueIndex();
    const f = parcelFilters(options);
    const dimension = options.dimension || 'hub';
    const counts = SLA_STAGE_DEFS.map(() => ({ open_breached: 0, open_within: 0, merchant: 0, carrybee: 0, overSum: 0 }));
    const candidates = SLA_STAGE_DEFS.map(() => []);
    const breakdownMap = {};
    const totals = { inView: 0, inProcess: 0, tni: 0, closed: 0, breachedParcels: 0 };
    const seenHubs = {}, routes = {}, days = {};

    for (const row of data.rows) {
      seenHubs[row.curHub] = 1;
      routes[row.route] = 1;
      if (row.day) days[row.day] = 1;
      if (!rowPasses(row, f)) continue;
      totals.inView++;
      // Terminal and invoiced parcels are finished: they count toward the
      // file and appear in the CID Journey, but in nothing live.
      if (row.state === 'closed') { totals.closed++; continue; }
      if (row.state === 'process') totals.inProcess++; else totals.tni++;

      const key = breakdownKey(row, dimension);
      const bucket = breakdownMap[key] || (breakdownMap[key] = { key, active: 0, inProcess: 0, tni: 0, breachedParcels: 0, openBreached: 0 });
      bucket.active++;
      if (row.state === 'process') bucket.inProcess++; else bucket.tni++;

      let openHere = 0;
      for (let s = 0; s < SLA_STAGE_DEFS.length; s++) {
        const letter = row.codes.charAt(s);
        if (letter === 'O') { counts[s].open_within++; continue; }
        if (!isBreachLetter(letter)) continue;
        const tally = counts[s];
        tally.open_breached++;
        openHere++;
        bucket.openBreached++;
        tally.overSum += row.ov[s] || 0;
        if (letter === 'M') tally.merchant++;
        else if (letter === 'C') tally.carrybee++;
        candidates[s].push(row);
      }
      if (openHere) { totals.breachedParcels++; bucket.breachedParcels++; }
    }

    const stages = SLA_STAGE_DEFS.map((stage, s) => {
      const tally = counts[s];
      const list = candidates[s].sort((a, b) => (b.ov[s] || 0) - (a.ov[s] || 0));
      const rows = list.slice(0, BOX_ROW_CAP).map(row => stageRowView(data, stage, s, row, issues));
      const hubCounts = {};
      let withIssue = 0;
      list.forEach(row => {
        hubCounts[row.curHub] = (hubCounts[row.curHub] || 0) + 1;
        if (issues[row.cid.toLowerCase() + '|' + stage.key]) withIssue++;
      });
      return {
        key: stage.key, label: stage.label, short: stage.short, from: stage.from, to: stage.to,
        isCutoff: stage.key === 'pickup', hubSide: stage.hub,
        network: stage.column ? matrix.network[stage.key] : null,
        openBreached: tally.open_breached, openWithin: tally.open_within,
        merchantSide: tally.merchant, carrybeeSide: tally.carrybee,
        avgLate: tally.open_breached ? round2(tally.overSum / tally.open_breached) : 0,
        worstLate: round2(list.length ? (list[0].ov[s] || 0) : 0),
        feedGap: !!data.feedGaps[stage.key],
        endFeedEmpty: data.emptyFields.includes(STAGE_END_FIELD[stage.key]),
        hubCounts, withIssue,
        rows, rowsCapped: tally.open_breached > rows.length
      };
    });

    const breakdown = Object.values(breakdownMap)
      .sort((a, b) => b.breachedParcels - a.breachedParcels || b.active - a.active);
    const dayList = Object.keys(days).sort();
    const active = totals.inProcess + totals.tni;

    // Hubs in the file with no row of their own run on the network default.
    // Said out loud, because a misspelt hub name looks exactly like a hub
    // with generous targets.
    const noTarget = {};
    data.rows.forEach(row => {
      [row.pickupHub, row.hub].forEach(hub => {
        if (hub && !matrix.byHub[hub.toLowerCase()]) noTarget[hub] = 1;
      });
    });

    const hierarchy = hubHierarchy(Object.keys(seenHubs));
    return Object.assign(base, {
      empty: false,
      snapshot: fmtTs(data.snapshotAt),
      totals: {
        parcelsInFile: data.rows.length, parcelsInView: totals.inView,
        inProcess: totals.inProcess, terminalNotInvoiced: totals.tni, closed: totals.closed,
        active, breachedParcels: totals.breachedParcels,
        breachRate: active ? round2(totals.breachedParcels / active * 100) : null,
        missingColumns: data.missingColumns,
        emptyColumns: data.emptyFields.map(key => TIME_KEY_HEADER[key] || key),
        invoiceFeedEmpty: data.emptyFields.includes('invoiceAt')
      },
      matrix: Object.assign(base.matrix, { hubsWithoutTarget: Object.keys(noTarget).sort() }),
      stages,
      dimension, dimensions: PARCEL_DIMENSIONS,
      breakdown,
      filters: { idType: f.idType, from: f.fromDay, to: f.toDay, region: f.region,
                 cluster: f.cluster, hub: f.hub, route: f.route, search: options.search || '' },
      filterOptions: Object.assign(hierarchy, { routes: Object.keys(routes).sort(),
                                                minDay: dayList[0] || '', maxDay: dayList[dayList.length - 1] || '' }),
      journey: journeyPage(data, options, { mode: 'all', page: 1 })
    });
  }

  const JOURNEY_STATE_ORDER = { process: 0, tni: 1, closed: 2 };

  /** One page of the CID Journey. mode: all | process | tni | closed | breached */
  function journeyPage(data, options, request) {
    request = request || {};
    const f = parcelFilters(options);
    const mode = request.mode || 'all';
    const needle = text(request.search).toLowerCase();
    const countsByMode = { all: 0, process: 0, tni: 0, closed: 0, breached: 0 };
    const refs = [];
    for (const row of data.rows) {
      if (!rowPasses(row, f)) continue;
      if (needle && row.cid.toLowerCase().indexOf(needle) < 0 &&
          row.businessName.toLowerCase().indexOf(needle) < 0) continue;
      let open = 0, late = 0, worst = 0;
      for (let s = 0; s < row.codes.length; s++) {
        const letter = row.codes.charAt(s);
        if (isBreachLetter(letter)) {
          open++;
          if ((row.ov[s] || 0) > worst) worst = row.ov[s] || 0;
        } else if (letter === 'L') late++;
      }
      countsByMode.all++;
      countsByMode[row.state]++;
      if (open) countsByMode.breached++;
      if (mode === 'breached' ? !open : (mode !== 'all' && row.state !== mode)) continue;
      refs.push({ row, o: open, l: late, w: worst });
    }
    refs.sort((a, b) => b.o - a.o || b.w - a.w ||
      JOURNEY_STATE_ORDER[a.row.state] - JOURNEY_STATE_ORDER[b.row.state] ||
      b.l - a.l || (a.row.cid < b.row.cid ? -1 : 1));
    const pages = Math.max(1, Math.ceil(refs.length / JOURNEY_PAGE_SIZE));
    const page = Math.min(Math.max(1, Number(request.page) || 1), pages);
    const rows = refs.slice((page - 1) * JOURNEY_PAGE_SIZE, page * JOURNEY_PAGE_SIZE).map(ref => {
      const row = ref.row;
      const cells = SLA_STAGE_DEFS.map((stage, s) => {
        const letter = row.codes.charAt(s);
        if (letter === 'N' || letter === 'P') return [letter];
        const res = evaluateStage(stage, row, data.matrix, data.cutoffs, data.snapshotAt);
        return [isBreachLetter(letter) ? 'B' : letter,
                res.hours === undefined || res.hours === null ? null : round2(res.hours),
                res.targetHours === undefined ? null : res.targetHours];
      });
      return { cid: row.cid, b: row.businessName, h: row.curHub, st: row.state,
               o: ref.o, w: round2(ref.w), s: cells };
    });
    return { mode, page, pages, pageSize: JOURNEY_PAGE_SIZE, total: refs.length,
             counts: countsByMode, rows, search: request.search || '' };
  }

  function traceParcel(data, cid) {
    const row = data.byCid.get(text(cid).toLowerCase());
    if (!row) return null;
    const timeline = SLA_STAGE_DEFS.map(stage => {
      const res = evaluateStage(stage, row, data.matrix, data.cutoffs, data.snapshotAt);
      return {
        key: stage.key, label: stage.label, short: stage.short, from: stage.from, to: stage.to,
        outcome: liveOutcome(stage.key, row, res), side: res.side || '',
        hours: round2(res.hours), target: res.targetHours === undefined ? null : res.targetHours,
        targetSource: res.targetSource || res.cutoffSource || '', hub: res.hub || '',
        startAt: fmtTs(res.startAt), endAt: fmtTs(res.endAt), cutoffAt: fmtTs(res.cutoffAt),
        reason: res.reason || ''
      };
    });
    return {
      parcel: { cid: row.cid, idType: row.idType, businessId: row.businessId, businessName: row.businessName,
                statusId: row.statusId, pickupHub: row.pickupHub, hub: row.hub, hubNow: row.curHub,
                clusterNow: row.curCluster, regionNow: row.curRegion, route: row.route, day: row.day,
                state: row.state, createdAt: fmtTs(row.createdAt), updatedAt: fmtTs(row.updatedAt) },
      timeline,
      snapshot: fmtTs(data.snapshotAt)
    };
  }

  function stageCsv(data, stage, options, issues) {
    const s = SLA_STAGE_DEFS.indexOf(stage);
    const f = parcelFilters(options);
    const lines = [['CID', 'ID Type', 'Business ID', 'Business Name', 'Operational Day',
                    'Pickup Hub', 'Delivery Hub', 'Hub Now', 'Cluster Now', 'Region Now', 'Route',
                    'Parcel State', 'Breach Side', 'Reason', 'Clock Started', 'Clock Started At',
                    'Measured To', 'Measured To At', 'Elapsed Hours', 'Target Hours', 'Late By Hours',
                    'Target Source', 'Open Issue', 'Issue Hub', 'Issue Status']];
    for (const row of data.rows) {
      if (!rowPasses(row, f) || !isBreachLetter(row.codes.charAt(s))) continue;
      const res = evaluateStage(stage, row, data.matrix, data.cutoffs, data.snapshotAt);
      const win = breachWindow(stage, res, data.snapshotAt);
      const issue = issues[row.cid.toLowerCase() + '|' + stage.key];
      lines.push([row.cid, row.idType, row.businessId, row.businessName, row.day, row.pickupHub, row.hub,
                  row.curHub, row.curCluster, row.curRegion, row.route,
                  row.state === 'process' ? 'In process' : 'Terminal, not invoiced',
                  res.side || '', res.reason || defaultReason(res),
                  win.fromLabel, win.fromAt, win.toLabel, win.toAt, round2(res.hours || 0),
                  res.targetHours === null || res.targetHours === undefined ? 'cutoff' : res.targetHours,
                  round2(row.ov[s] || 0), res.targetSource || res.cutoffSource || '',
                  issue ? issue.id : '', issue ? issue.hub : '', issue ? issue.status : '']);
    }
    const csv = lines.map(line => line.map(cell => {
      let value = cell === null || cell === undefined ? '' : String(cell);
      if (/^[=+\-@]/.test(value)) value = "'" + value;          // never a formula in Excel
      return /[",\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
    }).join(',')).join('\n');
    return { rows: lines.length - 1, csv };
  }

  /* ---------------------------------------------------- issue selection -- */

  /**
   * The parcels an issue submission is about.
   * selection = { stageKey, cids?: [...], options, boxHub, boxSearch }
   * Without cids it is every parcel breached at the stage under the page
   * filters and the box's own hub/search filter, not just the rows on screen.
   */
  async function resolveSelection(selection) {
    selection = selection || {};
    const stage = stageByKey(selection.stageKey);
    if (!stage) throw httpError(400, 'Unknown SLA stage.');
    const s = SLA_STAGE_DEFS.indexOf(stage);
    const data = await getData();
    if (!data.upload) throw httpError(400, 'No parcel data has been uploaded yet.');
    const issues = await openIssueIndex();
    const f = parcelFilters(selection.options);
    const wanted = Array.isArray(selection.cids) && selection.cids.length
      ? new Set(selection.cids.map(cid => text(cid).toLowerCase())) : null;
    const boxHub = text(selection.boxHub);
    const needle = text(selection.boxSearch).toLowerCase();

    const picked = [], alreadyOpen = [], notBreached = [];
    const seen = new Set();
    const pool = wanted ? [...wanted].map(cid => data.byCid.get(cid) || { missingCid: cid }) : data.rows;
    for (const row of pool) {
      if (row.missingCid) { notBreached.push(row.missingCid); continue; }
      if (seen.has(row.cid)) continue;
      seen.add(row.cid);
      if (!isBreachLetter(row.codes.charAt(s))) { if (wanted) notBreached.push(row.cid); continue; }
      if (!wanted) {
        if (!rowPasses(row, f)) continue;
        if (boxHub && row.curHub !== boxHub) continue;
        if (needle && row.cid.toLowerCase().indexOf(needle) < 0 &&
            row.businessName.toLowerCase().indexOf(needle) < 0) continue;
      }
      if (issues[row.cid.toLowerCase() + '|' + stage.key]) { alreadyOpen.push(row.cid); continue; }
      picked.push(row);
    }
    return { data, stage, s, picked, alreadyOpen, notBreached };
  }

  async function assignedHubs() {
    try {
      return new Set((await db.execute('SELECT hub_name FROM hub_assignments')).rows.map(r => r.hub_name));
    } catch (err) {
      return null;
    }
  }

  function hubGroups(picked, assigned) {
    const groups = {};
    picked.forEach(row => {
      const g = groups[row.curHub] || (groups[row.curHub] = {
        hub: row.curHub, zone: zoneForHub(row.curHub), cluster: row.curCluster, count: 0,
        assigned: assigned ? assigned.has(row.curHub) : null
      });
      g.count++;
    });
    return Object.values(groups).sort((a, b) => b.count - a.count || (a.hub < b.hub ? -1 : 1));
  }

  function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
  }

  /* ------------------------------------------------------------- routes -- */

  const wrap = fn => (req, res) => {
    Promise.resolve(fn(req, res)).catch(err => {
      if (!err.status) console.error('[parcel-journey]', err);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Parcel Journey request failed.' });
    });
  };

  function requireUploader(req) {
    if (!canUpload(req.user)) {
      throw httpError(403, 'Only a Parcel Journey admin can upload data. Ask for your email to be added to PARCEL_ADMINS.');
    }
  }

  app.post('/api/parcel/view', requireAuth, wrap(async (req, res) => {
    res.json(await buildView(req.user, (req.body || {}).options));
  }));

  app.post('/api/parcel/journey', requireAuth, wrap(async (req, res) => {
    const body = req.body || {};
    const data = await getData();
    if (!data.upload) throw httpError(400, 'No parcel data has been uploaded yet.');
    res.json(journeyPage(data, body.options, body));
  }));

  app.get('/api/parcel/trace/:cid', requireAuth, wrap(async (req, res) => {
    const data = await getData();
    const trace = traceParcel(data, req.params.cid);
    if (!trace) throw httpError(404, 'CID ' + req.params.cid + ' is not in the current parcel file.');
    res.json(trace);
  }));

  app.post('/api/parcel/download', requireAuth, wrap(async (req, res) => {
    const body = req.body || {};
    const stage = stageByKey(body.stageKey);
    if (!stage) throw httpError(400, 'Unknown SLA stage.');
    const data = await getData();
    const out = stageCsv(data, stage, body.options, await openIssueIndex());
    const stamp = fmtTs(Date.now()).replace(/[-: ]/g, '').replace(/^(\d{8})(\d{4})$/, '$1_$2');
    res.json({ rows: out.rows, csv: out.csv, fileName: 'CarryBee_' + stage.key + '_breaches_' + stamp + '.csv' });
  }));

  /* ---- SLA Hub Matrix ---- */

  app.get('/api/parcel/sla-matrix', requireAuth, wrap(async (req, res) => {
    const matrix = await readSlaMatrix();
    const rows = Object.values(matrix.byHub).map(h => ({ hub: h.name, hours: h.hours }))
      .sort((a, b) => (a.hub < b.hub ? -1 : a.hub > b.hub ? 1 : 0));
    res.json({
      rows, network: matrix.network, source: matrix.source, headers: SLA_MATRIX_HEADERS,
      stages: SLA_STAGE_DEFS.filter(s => s.column).map(s => ({ key: s.key, label: s.label, column: s.column }))
    });
  }));

  /** Replaces the whole matrix. body = { fileName, rows } with rows the first sheet as arrays. */
  app.post('/api/parcel/sla-matrix', requireAuth, wrap(async (req, res) => {
    requireUploader(req);
    const { fileName, rows: table } = req.body || {};
    if (!Array.isArray(table) || table.length < 2) throw httpError(400, 'The file needs a header row and at least one hub row.');
    if (table.length > 5000) throw httpError(400, 'The file has more than 5,000 rows.');
    const index = headerIndex(table[0]);
    if (index['hub name'] === undefined) {
      throw httpError(400, 'No "Hub Name" column found. The first row must be the header row of the SLA upload template.');
    }
    const stageCols = SLA_STAGE_DEFS.filter(s => s.column);
    const missing = stageCols.filter(s => index[s.column.toLowerCase()] === undefined).map(s => s.column);

    const out = [];
    const seen = {};
    const invalid = [];
    let skipped = 0;
    for (let r = 1; r < table.length; r++) {
      const hubName = text((table[r] || [])[index['hub name']]);
      if (!hubName || seen[hubName.toLowerCase()]) { skipped++; continue; }
      seen[hubName.toLowerCase()] = true;
      const hours = stageCols.map(stage => {
        const position = index[stage.column.toLowerCase()];
        const raw = position === undefined ? '' : table[r][position];
        if (raw === '' || raw === null || raw === undefined) return null;
        const value = num(raw);
        if (value < 0 || value > 720) { invalid.push(hubName + ' / ' + stage.column + ' = ' + raw); return null; }
        return value;
      });
      out.push([hubName].concat(hours));
    }
    if (!out.length) throw httpError(400, 'No usable hub rows were found in the file.');
    const hasDefault = out.some(row => row[0].toLowerCase() === NETWORK_DEFAULT_ROW.toLowerCase());
    if (!hasDefault) out.unshift([NETWORK_DEFAULT_ROW].concat(stageCols.map(stage => HARD_DEFAULT_HOURS[stage.key])));

    const now = new Date().toISOString();
    const statements = [{ sql: 'DELETE FROM sla_hub_matrix', args: [] }];
    const columns = ['hub_name'].concat(stageCols.map(s => s.key), ['uploaded_by', 'uploaded_at']);
    for (let i = 0; i < out.length; i += INSERT_ROWS_PER_STATEMENT) {
      const slice = out.slice(i, i + INSERT_ROWS_PER_STATEMENT);
      statements.push({
        sql: `INSERT INTO sla_hub_matrix (${columns.join(', ')}) VALUES ` +
             slice.map(() => '(' + columns.map(() => '?').join(', ') + ')').join(', '),
        args: [].concat(...slice.map(row => row.concat([req.user, now])))
      });
    }
    statements.push({ sql: 'INSERT INTO sla_uploads (file_name, hubs, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?)',
                      args: [text(fileName) || 'upload', out.length - 1, req.user, now] });
    await db.batch(statements, 'write');
    invalidate();
    res.json({ ok: true, hubs: out.length - 1, skipped, missingColumns: missing,
               invalidCells: invalid.slice(0, 20), invalidCount: invalid.length,
               addedNetworkDefault: !hasDefault });
  }));

  /* ---- parcel file upload, in chunks ---- */

  app.post('/api/parcel/upload/start', requireAuth, wrap(async (req, res) => {
    requireUploader(req);
    const { fileName, totalRows, missingColumns } = req.body || {};
    const total = Number(totalRows);
    if (!total || total < 1) throw httpError(400, 'The file has no parcel rows.');
    const required = ['CID', 'Pickup Hub', 'Delivery Hub'];
    const lacking = required.filter(h => (missingColumns || []).includes(h));
    if (lacking.length) throw httpError(400, 'The file is missing required columns: ' + lacking.join(', ') + '.');

    // Anything left 'loading' from an upload that never finished is dropped.
    const stale = (await db.execute("SELECT batch_id FROM pj_uploads WHERE status = 'loading'")).rows;
    for (const row of stale) {
      await db.execute({ sql: 'DELETE FROM pj_parcels WHERE batch_id = ?', args: [row.batch_id] });
      await db.execute({ sql: "UPDATE pj_uploads SET status = 'abandoned' WHERE batch_id = ?", args: [row.batch_id] });
    }
    const next = (await db.execute('SELECT COALESCE(MAX(batch_id), 0) + 1 AS id FROM pj_uploads')).rows[0].id;
    await db.execute({
      sql: `INSERT INTO pj_uploads (batch_id, file_name, expected_rows, received_rows, missing_columns, uploaded_by, started_at, status)
            VALUES (?, ?, ?, 0, ?, ?, ?, 'loading')`,
      args: [next, text(fileName) || 'upload', total, JSON.stringify(missingColumns || []), req.user, new Date().toISOString()]
    });
    res.json({ ok: true, batchId: Number(next), chunkRows: UPLOAD_CHUNK_MAX_ROWS,
               columns: PARCEL_COLUMNS.map(c => c[1]) });
  }));

  app.post('/api/parcel/upload/chunk', requireAuth, wrap(async (req, res) => {
    requireUploader(req);
    const { batchId, rows } = req.body || {};
    const upload = (await db.execute({ sql: 'SELECT * FROM pj_uploads WHERE batch_id = ?', args: [batchId] })).rows[0];
    if (!upload || upload.status !== 'loading') throw httpError(400, 'This upload is no longer open. Start it again.');
    if (upload.uploaded_by !== req.user) throw httpError(403, 'This upload was started by someone else.');
    if (!Array.isArray(rows) || !rows.length) throw httpError(400, 'Empty chunk.');
    if (rows.length > UPLOAD_CHUNK_MAX_ROWS) throw httpError(400, 'Too many rows in one chunk.');
    const width = PARCEL_COLUMNS.length;
    const clean = rows.filter(row => Array.isArray(row) && text(row[0]))
      .map(row => {
        const out = new Array(width);
        for (let i = 0; i < width; i++) {
          const value = row[i];
          out[i] = value === null || value === undefined || value === '' ? null : String(value).slice(0, 500);
        }
        return out;
      });
    const columns = ['batch_id'].concat(PARCEL_COLUMNS.map(c => c[0]));
    const statements = [];
    for (let i = 0; i < clean.length; i += INSERT_ROWS_PER_STATEMENT) {
      const slice = clean.slice(i, i + INSERT_ROWS_PER_STATEMENT);
      statements.push({
        sql: `INSERT INTO pj_parcels (${columns.join(', ')}) VALUES ` +
             slice.map(() => '(' + columns.map(() => '?').join(', ') + ')').join(', '),
        args: [].concat(...slice.map(row => [batchId].concat(row)))
      });
    }
    statements.push({ sql: 'UPDATE pj_uploads SET received_rows = received_rows + ? WHERE batch_id = ?',
                      args: [clean.length, batchId] });
    await db.batch(statements, 'write');
    res.json({ ok: true, stored: clean.length, skipped: rows.length - clean.length });
  }));

  app.post('/api/parcel/upload/finish', requireAuth, wrap(async (req, res) => {
    requireUploader(req);
    const { batchId } = req.body || {};
    const upload = (await db.execute({ sql: 'SELECT * FROM pj_uploads WHERE batch_id = ?', args: [batchId] })).rows[0];
    if (!upload || upload.status !== 'loading') throw httpError(400, 'This upload is no longer open. Start it again.');
    if (upload.uploaded_by !== req.user) throw httpError(403, 'This upload was started by someone else.');
    if (!upload.received_rows) throw httpError(400, 'No rows were stored. Nothing was replaced.');
    // Switch over in one transaction: the new file becomes the only one.
    await db.batch([
      { sql: "UPDATE pj_uploads SET status = 'replaced' WHERE status = 'active'", args: [] },
      { sql: "UPDATE pj_uploads SET status = 'active', finished_at = ? WHERE batch_id = ?",
        args: [new Date().toISOString(), batchId] },
      { sql: 'DELETE FROM pj_parcels WHERE batch_id != ?', args: [batchId] }
    ], 'write');
    invalidate();
    const data = await getData();
    res.json({ ok: true, rows: upload.received_rows, expected: upload.expected_rows,
               parcels: data.rows.length, snapshot: fmtTs(data.snapshotAt) });
  }));

  /* ---- issues from breached parcels ---- */

  app.post('/api/parcel/issues/preview', requireAuth, wrap(async (req, res) => {
    const sel = await resolveSelection((req.body || {}).selection);
    const assigned = await assignedHubs();
    const groups = hubGroups(sel.picked, assigned);
    res.json({
      stage: { key: sel.stage.key, label: sel.stage.label },
      count: sel.picked.length, max: BULK_MAX_PARCELS,
      hubs: groups,
      alreadyOpen: sel.alreadyOpen.length, notBreached: sel.notBreached.length,
      sample: sel.picked.slice(0, 5).map(row => ({ cid: row.cid, businessName: row.businessName,
                                                     hubNow: row.curHub, lateBy: round2(row.ov[sel.s] || 0) }))
    });
  }));

  /**
   * Creates one issue per parcel, each routed to the hub that parcel is in
   * now (zone from the hub list). Same columns and starting point on the
   * escalation ladder as a Log an Issue submission.
   * body = { selection, issue: { channel, media, socialSource, status, category,
   *                              subcategory, details, attachments } }
   */
  app.post('/api/parcel/issues', requireAuth, wrap(async (req, res) => {
    const body = req.body || {};
    const i = body.issue || {};
    const required = ['channel', 'status', 'category', 'subcategory', 'details'];
    if (['Social Media', 'Inbound'].includes(i.channel)) required.push('media');
    if (i.channel === 'Social Media') required.push('socialSource');
    const missing = required.filter(k => !text(i[k]));
    if (missing.length) throw httpError(400, 'Missing fields: ' + missing.join(', '));

    const sel = await resolveSelection(body.selection);
    if (!sel.picked.length) {
      throw httpError(400, sel.alreadyOpen.length
        ? 'Every selected parcel already has an open issue for this stage.'
        : 'None of the selected parcels is breached at this stage right now.');
    }
    if (sel.picked.length > BULK_MAX_PARCELS) {
      throw httpError(400, sel.picked.length + ' parcels selected. Send at most ' + BULK_MAX_PARCELS +
                           ' at once: narrow the filters or pick a hub in the box.');
    }

    let attachments = null;
    if (Array.isArray(i.attachments) && i.attachments.length) {
      const cleaned = i.attachments
        .filter(a => a && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:') && ['photo', 'audio'].includes(a.type))
        .map(a => ({ type: a.type, filename: a.filename || null, mimeType: a.mimeType || null, dataUrl: a.dataUrl }));
      if (cleaned.length) attachments = JSON.stringify(cleaned);
    }
    if (attachments && attachments.length * sel.picked.length > BULK_ATTACHMENT_BUDGET) {
      throw httpError(400, 'Attachments are copied onto every issue. With ' + sel.picked.length +
        ' parcels they come to more than ' + Math.round(BULK_ATTACHMENT_BUDGET / 1048576) +
        ' MB: remove them, or send fewer parcels at once.');
    }

    const ts = new Date().toISOString();
    const userDetails = text(i.details) ? String(i.details).trim() : '';
    const created = [];
    const statements = [];
    for (const row of sel.picked) {
      const id = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
      const view = stageRowView(sel.data, sel.stage, sel.s, row, {});
      const context = 'Parcel Journey: ' + sel.stage.label + ', ' + view.lateBy + ' h late' +
        (view.side ? ' (' + view.side + ' side)' : '') + '. ' + view.fromLabel + ' ' + view.fromAt +
        ' to ' + view.toLabel + ' ' + view.toAt + '. Merchant: ' + (row.businessName || '-') +
        (row.businessId ? ' (' + row.businessId + ')' : '') + '. Pickup hub ' + row.pickupHub +
        ', delivery hub ' + row.hub + '.';
      statements.push({
        sql: `INSERT INTO issues
                (id, ts, consignment, channel, media, social_source, zone, hub, status, category, subcategory, details, logged_by,
                 escalation_level, response_status, level_started_at, attachments, sla_stage, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'L3', 'Regular', ?, ?, ?, 'parcel_journey')`,
        args: [id, ts, row.cid, i.channel, i.media || null, i.socialSource || null, zoneForHub(row.curHub),
               row.curHub, i.status, i.category, i.subcategory, userDetails + '\n\n' + context, req.user,
               ts, attachments, sel.stage.key]
      });
      if (issueEventsSupported) {
        statements.push({ sql: "INSERT INTO issue_events (issue_id, ts, type, actor) VALUES (?, ?, 'logged', ?)",
                          args: [id, ts, req.user] });
      }
      created.push({ id, cid: row.cid, hub: row.curHub });
    }
    // Written in slices so one very large submission never becomes one
    // oversized request; each slice is its own transaction.
    const SLICE = 100;
    for (let k = 0; k < statements.length; k += SLICE) {
      await db.batch(statements.slice(k, k + SLICE), 'write');
    }
    const assigned = await assignedHubs();
    res.json({
      ok: true, created: created.length, ts,
      hubs: hubGroups(sel.picked, assigned),
      alreadyOpen: sel.alreadyOpen.length, notBreached: sel.notBreached.length
    });
  }));

  return { ensureTables, invalidate };
}

module.exports = { registerParcelJourney, SLA_STAGE_DEFS, parseTs, fmtTs, zoneForHub };
