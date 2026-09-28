/* =====================================================================
   Parcel Journey tab, client side.

   Ported from the TQM V4 Parcel Journey, top to bottom:
     1. Data bar           which parcel file is loaded; upload a new one
     2. KPI strip          in process, terminal not invoiced, breached right
                           now, breach rate
     3. SLA targets        the hub matrix held in Turso; upload / view / download
     4. Journey right now  the nine stages in route order, breached counts
     5. Filters            region, cluster, hub (cascading), type, days, route
     6. Breakdown          paginated
     7. Breach boxes       breached parcels per stage. Each row, a ticked set,
                           or every breached parcel in the box at once opens
                           the issue form (the Log an Issue fields), and each
                           parcel's issue goes to the hub it is in now
     8. CID Journey        every parcel with the hours each stage took

   Relies on globals from the form page: API_BASE, authToken, CATEGORY_MAP,
   compressImage, fileToDataUrl, and the channel / status / social source
   options already on the form, so both stay in step.
   All clicks go through one delegated listener reading data-pj, so no CID,
   hub or merchant name is ever pasted into inline JavaScript.
   ===================================================================== */
(function () {
  'use strict';

  var PJ = {
    view: null,
    journey: null,
    journeySearch: '',
    options: { dimension: 'hub', idType: 'All', from: '', to: '', region: '', cluster: '', hub: '', route: '', search: '' },
    box: {},                 // per stage: { open, hub, noIssue, search, selected: {cid: true} }
    breakdownPage: 1,
    version: 0
  };
  var BREAKDOWN_PAGE_SIZE = 25;
  var SHEETJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  var PIPE_COLUMNS = [
    ['pickup'], ['pickup_fmh'], ['fmh_cw', 'fmh_subsort'],
    ['cw_lmh', 'subsort_lmh'], ['lmh_attempt', 'lmh_terminal'], ['terminal_invoice']
  ];
  var PARCEL_STATE_TAG = {
    process: '<span class="pj-tag warn">In process</span>',
    tni: '<span class="pj-tag info">Terminal, not invoiced</span>',
    closed: '<span class="pj-tag">Closed</span>'
  };
  var JOURNEY_MODES = [['all', 'All'], ['process', 'In process'], ['tni', 'Terminal, not invoiced'],
                       ['closed', 'Closed'], ['breached', 'Breached now']];

  /* ------------------------------------------------------------- helpers -- */

  function el(id) { return document.getElementById(id); }
  function root() { return el('pj-root'); }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function int(value) {
    if (value === null || value === undefined || value === '') return '—';
    return Math.round(Number(value)).toLocaleString('en-US');
  }
  function pct(value) {
    if (value === null || value === undefined || value === '') return '—';
    return Number(value).toFixed(1) + '%';
  }
  function fmtLate(hours) {
    if (hours === null || hours === undefined) return '—';
    if (Math.abs(hours) >= 48) return (hours / 24).toFixed(1) + ' d';
    return Number(hours).toFixed(1) + ' h';
  }
  function fmtHour(hour) {
    var whole = Math.floor(hour);
    var minutes = Math.round((hour - whole) * 60);
    return whole + ':' + (minutes < 10 ? '0' : '') + minutes;
  }
  function kpi(label, value, hint, tone) {
    return '<div class="pj-kpi' + (tone ? ' ' + tone : '') + '"><div class="pj-kpi-label">' + esc(label) +
      '</div><div class="pj-kpi-value">' + value + '</div>' +
      (hint ? '<div class="pj-kpi-hint">' + esc(hint) + '</div>' : '') + '</div>';
  }
  function say(id, message, tone) {
    var line = el(id);
    if (!line) return;
    line.className = 'pj-note' + (tone ? ' ' + tone : '');
    line.textContent = message;
  }

  function api(method, path, body) {
    return fetch(API_BASE + path, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (res.status === 401) {
        var out = el('btnLogout');
        if (out) out.click();
        throw new Error('Session expired — please sign in again.');
      }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ').');
        return data;
      });
    });
  }

  function saveText(fileName, textOut) {
    var blob = new Blob(['﻿' + textOut], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function loadSheetJs() {
    return new Promise(function (resolve, reject) {
      if (typeof XLSX !== 'undefined') { resolve(); return; }
      var tag = document.createElement('script');
      tag.src = SHEETJS_URL;
      tag.onload = function () { resolve(); };
      tag.onerror = function () { reject(new Error('The spreadsheet reader could not be loaded.')); };
      document.head.appendChild(tag);
    });
  }

  /** The first sheet, unless the workbook has one with the preferred name. */
  function readWorkbookRows(file, preferredSheet) {
    var isCsv = /\.csv$/i.test(file.name);
    return loadSheetJs().then(function () { return file.arrayBuffer(); }).then(function (buffer) {
      var book = XLSX.read(buffer, { type: 'array', raw: isCsv, cellDates: false });
      var name = book.SheetNames.filter(function (n) {
        return n.toLowerCase() === String(preferredSheet || '').toLowerCase();
      })[0] || book.SheetNames[0];
      var rows = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true, defval: '' });
      return rows.filter(function (row) {
        return row.some(function (cell) { return String(cell).trim() !== ''; });
      });
    });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** An Excel date cell as 'YYYY-MM-DD HH:MM:SS' (the export's own clock, Bangladesh time). */
  function excelDateText(value) {
    if (typeof value === 'number' && isFinite(value) && value > 0) {
      var p = XLSX.SSF.parse_date_code(value);
      if (!p) return String(value);
      return p.y + '-' + pad2(p.m) + '-' + pad2(p.d) + ' ' + pad2(p.H) + ':' + pad2(p.M) + ':' + pad2(Math.floor(p.S));
    }
    if (value instanceof Date) {
      return value.getFullYear() + '-' + pad2(value.getMonth() + 1) + '-' + pad2(value.getDate()) + ' ' +
        pad2(value.getHours()) + ':' + pad2(value.getMinutes()) + ':' + pad2(value.getSeconds());
    }
    return String(value === null || value === undefined ? '' : value).trim();
  }

  /* ---------------------------------------------------------- lifecycle -- */

  function show() {
    if (!root()) return;
    if (!PJ.view) load(true);
  }

  function reset() {
    PJ.view = null;
    PJ.journey = null;
    PJ.box = {};
    PJ.breakdownPage = 1;
    PJ.version++;
    closeModal();
    if (root()) root().innerHTML = '';
  }

  function load(spinner) {
    var version = ++PJ.version;
    if (spinner || !PJ.view) {
      root().innerHTML = '<div class="pj-panel pj-loading"><div class="pj-skeleton"></div>' +
        '<p class="pj-note">Loading the Parcel Journey… The first load after an upload or a server restart ' +
        'reads every parcel from the database and can take a few seconds.</p></div>';
    } else {
      var chip = el('pj-busy');
      if (chip) chip.hidden = false;
    }
    return api('POST', '/api/parcel/view', { options: PJ.options }).then(function (view) {
      if (version !== PJ.version) return;
      PJ.view = view;
      PJ.journey = view.journey || null;
      render();
    }).catch(function (error) {
      if (version !== PJ.version) return;
      root().innerHTML = '<div class="pj-panel"><h2>Something went wrong</h2><p class="pj-error">' +
        esc(error.message) + '</p><button type="button" class="primary" data-pj="reload">Retry</button></div>';
    });
  }

  function render() {
    var d = PJ.view;
    var html = dataBarHtml(d);
    if (d.empty) {
      html += '<div class="pj-panel pj-empty"><h2>No parcel data yet</h2><p>Upload the Parcel Journey export ' +
        '(the .xlsx or .csv with CID, Pickup Hub, Delivery Hub and the stage timestamps). It is stored in the ' +
        'database and every signed-in user sees the same file.' +
        (d.canUpload ? '' : ' Ask a Parcel Journey admin to upload it.') + '</p>' +
        (d.canUpload ? '<button type="button" class="primary" data-pj="upload-parcels">Upload parcel file</button>' : '') +
        '</div>';
      html += slaBarHtml(d);
      root().innerHTML = html;
      return;
    }
    html += summaryHtml(d);
    html += slaBarHtml(d);
    html += noticesHtml(d);
    html += pipelineHtml(d);
    html += filtersHtml(d);
    html += '<div id="pj-breakdown">' + breakdownHtml(d) + '</div>';
    html += '<div class="pj-section-title"><h2>Breached parcels by stage</h2>' +
      '<p class="pj-sub">Only parcels breached right now. Tick parcels, or use <b>Issue resolution for all</b> to raise ' +
      'every breached parcel in a box at once; each issue goes to the hub that parcel is in now. A box lists the worst ' +
      '150; Download and "for all" cover every one.</p></div>';
    d.stages.forEach(function (stage) { html += stageBoxHtml(stage); });
    html += journeyPanelHtml();
    root().innerHTML = html;
    wireStageBoxes(d);
  }

  /* ----------------------------------------------------------- data bar -- */

  function dataBarHtml(d) {
    var ds = d.dataset;
    return '<div class="pj-databar"><div><h2>Parcel Journey</h2><p class="pj-sub">' +
      (ds ? 'File <b>' + esc(ds.fileName) + '</b> · ' + int(ds.rows) + ' parcels · uploaded by ' +
            esc(ds.uploadedBy) + ', ' + esc(ds.uploadedAt)
          : 'No parcel file loaded.') + '</p></div>' +
      '<div class="pj-actions"><span class="pj-chip muted" id="pj-busy" hidden>Loading…</span>' +
      (ds ? '<button type="button" class="ghost" data-pj="reload">Refresh</button>' : '') +
      (d.canUpload ? '<button type="button" class="ghost" data-pj="upload-parcels">Upload parcel file</button>' : '') +
      '<input type="file" id="pj-parcel-file" accept=".xlsx,.xls,.csv" hidden></div></div>';
  }

  /* ---------------------------------------------------------- KPI strip -- */

  function summaryHtml(d) {
    var t = d.totals;
    return '<div class="pj-kpi-grid">' +
      kpi('In process', int(t.inProcess), 'parcels still moving') +
      kpi('Terminal, not invoiced', int(t.terminalNotInvoiced),
          t.invoiceFeedEmpty ? 'invoice date is blank on every row: not measurable'
                             : 'delivered or returned, invoice not generated', t.terminalNotInvoiced ? 'warn' : '') +
      kpi('Breached right now', int(t.breachedParcels), 'in process or not invoiced, with an open breach',
          t.breachedParcels ? 'bad' : 'good') +
      kpi('Breach rate', pct(t.breachRate), 'breached, over ' + int(t.active) + ' active parcels') +
      '</div><p class="pj-note">Snapshot <b>' + esc(d.snapshot) + '</b>, the latest event in the parcel file. Open times ' +
      'are measured to this moment. ' + int(t.closed) + ' parcels in view are terminal and invoiced: finished, so they ' +
      'appear only in the CID Journey.</p>';
  }

  /* ----------------------------------------------------------- SLA bar ---- */

  function slaBarHtml(d) {
    var m = d.matrix;
    var html = '<details class="pj-panel pj-sla"' + (m.hubCount ? '' : ' open') + '><summary><div><h2>SLA targets</h2>' +
      '<p class="pj-sub">' + (m.hubCount
        ? int(m.hubCount) + ' hubs configured' + (m.fileName ? ' from <b>' + esc(m.fileName) + '</b>' : '') +
          (m.uploadedBy ? ', uploaded by ' + esc(m.uploadedBy) : '') + '.'
        : 'No hub rows loaded. Every stage is on the network default.') +
      ' Pickup cutoff ' + esc(fmtHour(d.cutoffs.defaultHour)) + ' by default, ' + int(d.cutoffs.businessRows) +
      ' businesses on a custom cutoff.</p></div><span class="pj-chip ' + (m.hubCount ? 'good' : 'warn') + '">' +
      (m.hubCount ? 'Configured' : 'Needs upload') + '</span></summary>';

    if (m.hubsWithoutTarget && m.hubsWithoutTarget.length) {
      html += '<div class="pj-notice warn">' + int(m.hubsWithoutTarget.length) + ' hubs in the parcel file have no row ' +
        'in the matrix and run on the network default: ' + esc(m.hubsWithoutTarget.slice(0, 12).join(', ')) +
        (m.hubsWithoutTarget.length > 12 ? ' and more' : '') + '. Check the spelling against the hub list.</div>';
    }
    html += '<div class="pj-upload-row">';
    if (d.canUpload) {
      html += '<button type="button" class="pj-upload-drop" data-pj="upload-sla"><strong>Upload the SLA workbook</strong>' +
        '<span>SLA_upload.xlsx, or the same sheet saved as .csv, with hub names exactly as on the hub list. It replaces ' +
        'the whole matrix in the database, so send every hub each time. A hub left out falls back to the Network ' +
        'Default row.</span></button><input type="file" id="pj-sla-file" accept=".xlsx,.xls,.csv" hidden>';
    } else {
      html += '<p class="pj-note">Only a Parcel Journey admin can change the SLA matrix.</p>';
    }
    html += '<div class="pj-upload-side"><button type="button" class="ghost" data-pj="view-matrix">View current matrix</button>' +
      '<button type="button" class="ghost" data-pj="export-matrix">Download current matrix</button>' +
      '<div id="pj-sla-status" class="pj-note"></div></div></div>';

    html += '<div class="pj-table-wrap"><table class="pj-table"><thead><tr><th>Stage</th><th>Measured from</th>' +
      '<th>Measured to</th><th>Target owned by</th><th class="num">Network default</th></tr></thead><tbody>';
    d.stageDefs.forEach(function (stage) {
      html += '<tr><td>' + esc(stage.label) + '</td><td class="mono small">' + esc(stage.from) + '</td>' +
        '<td class="mono small">' + esc(stage.to) + '</td><td>' + (stage.hubSide === 'pickup' ? 'Pickup hub' : 'Delivery hub') +
        '</td><td class="num">' + (stage.isCutoff ? 'cutoff' : (stage.network ? stage.network + ' h' : '-')) + '</td></tr>';
    });
    return html + '</tbody></table></div></details>';
  }

  function noticesHtml(d) {
    var html = '';
    var t = d.totals;
    if (t.missingColumns && t.missingColumns.length) {
      html += '<div class="pj-notice warn">Not in the uploaded parcel file: ' + esc(t.missingColumns.join(', ')) +
        '. Stages that need them show as not reached rather than as clean.</div>';
    }
    if (t.emptyColumns && t.emptyColumns.length) {
      var blind = d.stages.filter(function (stage) { return stage.endFeedEmpty && !stage.feedGap; });
      html += '<div class="pj-notice warn">Blank on every row of the parcel file: ' + esc(t.emptyColumns.join(', ')) + '. ' +
        (blind.length ? 'These stages can start but can never be recorded as finished, so their breaches mean ' +
          '"not recorded": ' + esc(blind.map(function (s) { return s.short; }).join(', ')) + '. ' : '') +
        (t.invoiceFeedEmpty ? 'Terminal, not invoiced counts every terminal parcel, because no invoice date is ever filled. ' : '') +
        'Fix the export and these figures become real.</div>';
    }
    var gaps = d.stages.filter(function (stage) { return stage.feedGap; });
    if (gaps.length) {
      html += '<div class="pj-notice warn">No parcel has ever started these stages, so their start field is not being ' +
        'fed. That is a data gap, not a clean stage: ' + esc(gaps.map(function (s) { return s.short; }).join(', ')) + '.</div>';
    }
    return html;
  }

  /* ---------------------------------------------------------- pipeline ---- */

  function pipelineHtml(d) {
    var byKey = {}, max = 0;
    d.stages.forEach(function (stage) {
      byKey[stage.key] = stage;
      if (stage.openBreached > max) max = stage.openBreached;
    });
    var html = '<div class="pj-panel"><h2>Journey right now</h2><p class="pj-sub">Parcels in process or terminal and ' +
      'not invoiced, stuck past target at each stage, in route order. Stacked stages are alternative routes, or two ' +
      'measures from the same start. Click a stage to open its parcels.</p><div class="pj-pipe">';
    PIPE_COLUMNS.forEach(function (column, index) {
      if (index) html += '<div class="pj-pipe-arrow" aria-hidden="true"></div>';
      html += '<div class="pj-pipe-col">';
      column.forEach(function (key) {
        var stage = byKey[key];
        if (!stage) return;
        var share = max ? stage.openBreached / max : 0;
        var severity = stage.feedGap ? 'gap' : stage.openBreached === 0 ? 'zero'
          : share >= 0.5 ? 'hi' : share >= 0.15 ? 'mid' : 'lo';
        var sub = stage.feedGap ? 'not being fed'
          : stage.endFeedEmpty ? 'end never recorded'
          : stage.isCutoff ? int(stage.merchantSide) + ' merchant, ' + int(stage.carrybeeSide) + ' CarryBee'
          : int(stage.openWithin) + ' still inside target';
        html += '<button type="button" class="pj-pipe-node sev-' + severity + '" data-pj="stage" data-stage="' +
          esc(stage.key) + '" title="' + esc(stage.from + ' to ' + stage.to) + '">' +
          '<span class="pj-pipe-label">' + esc(stage.short) + '</span>' +
          '<span class="pj-pipe-count">' + int(stage.openBreached) + '</span>' +
          '<span class="pj-pipe-sub">' + esc(sub) + '</span>' +
          '<span class="pj-pipe-bar"><i style="width:' + Math.round(share * 100) + '%"></i></span></button>';
      });
      html += '</div>';
    });
    return html + '</div></div>';
  }

  /* ----------------------------------------------------------- filters ---- */

  function optionList(values, current, blank) {
    return '<option value="">' + esc(blank) + '</option>' + values.map(function (value) {
      return '<option' + (current === value ? ' selected' : '') + '>' + esc(value) + '</option>';
    }).join('');
  }
  function clusterOptions(o, region, current) {
    return '<option value="">All clusters</option>' + o.clusters.filter(function (c) {
      return !region || c.region === region;
    }).map(function (c) {
      return '<option' + (current === c.name ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('');
  }
  function hubOptions(o, region, cluster, current) {
    return '<option value="">All hubs</option>' + o.hubs.filter(function (h) {
      return (!region || h.region === region) && (!cluster || h.cluster === cluster);
    }).map(function (h) {
      return '<option' + (current === h.name ? ' selected' : '') + '>' + esc(h.name) + '</option>';
    }).join('');
  }

  function filtersHtml(d) {
    var o = d.filterOptions, f = d.filters;
    return '<div class="pj-panel pj-filters"><div class="pj-filter-row">' +
      '<label>Type<select id="pj-type">' + ['All', 'Forward', 'Reverse'].map(function (v) {
        return '<option' + (f.idType === v ? ' selected' : '') + '>' + v + '</option>';
      }).join('') + '</select></label>' +
      '<label>From<input type="date" id="pj-from" value="' + esc(f.from) + '" min="' + esc(o.minDay) + '" max="' + esc(o.maxDay) + '"></label>' +
      '<label>To<input type="date" id="pj-to" value="' + esc(f.to) + '" min="' + esc(o.minDay) + '" max="' + esc(o.maxDay) + '"></label>' +
      '<label>Region<select id="pj-region">' + optionList(o.regions, f.region, 'All regions') + '</select></label>' +
      '<label>Cluster<select id="pj-cluster">' + clusterOptions(o, f.region, f.cluster) + '</select></label>' +
      '<label>Hub (where the parcel is now)<select id="pj-hub">' + hubOptions(o, f.region, f.cluster, f.hub) + '</select></label>' +
      '<label>Route<select id="pj-route">' + optionList(o.routes, f.route, 'All routes') + '</select></label>' +
      '<label>Search<input type="text" id="pj-search" placeholder="CID or business" value="' + esc(f.search) + '"></label>' +
      '<div class="pj-filter-buttons"><button type="button" class="primary" data-pj="apply-filters">Apply</button>' +
      '<button type="button" class="ghost" data-pj="clear-filters">Clear</button></div></div></div>';
  }

  function cascadeFilters(changed) {
    var o = PJ.view.filterOptions;
    var region = el('pj-region').value;
    if (changed === 'region') {
      el('pj-cluster').innerHTML = clusterOptions(o, region, '');
      el('pj-hub').innerHTML = hubOptions(o, region, '', '');
    } else if (changed === 'cluster') {
      el('pj-hub').innerHTML = hubOptions(o, region, el('pj-cluster').value, '');
    }
  }

  function applyFilters() {
    var o = PJ.options;
    o.idType = el('pj-type').value;
    o.from = el('pj-from').value;
    o.to = el('pj-to').value;
    o.region = el('pj-region').value;
    o.cluster = el('pj-cluster').value;
    o.hub = el('pj-hub').value;
    o.route = el('pj-route').value;
    o.search = el('pj-search').value.trim();
    PJ.box = {};
    PJ.breakdownPage = 1;
    load(false);
  }

  /* --------------------------------------------------------- breakdown ---- */

  function breakdownHtml(d) {
    var label = 'Group';
    d.dimensions.forEach(function (dim) { if (dim.key === d.dimension) label = dim.label; });
    var peak = 0;
    d.breakdown.forEach(function (row) {
      var rate = row.active ? row.breachedParcels / row.active : 0;
      if (rate > peak) peak = rate;
    });
    var pages = Math.max(1, Math.ceil(d.breakdown.length / BREAKDOWN_PAGE_SIZE));
    var page = Math.min(Math.max(1, PJ.breakdownPage), pages);
    PJ.breakdownPage = page;
    var slice = d.breakdown.slice((page - 1) * BREAKDOWN_PAGE_SIZE, page * BREAKDOWN_PAGE_SIZE);

    var html = '<div class="pj-panel"><div class="pj-panel-head"><div><h2>Breakdown</h2><p class="pj-sub">Active parcels ' +
      'only: in process, or terminal and not invoiced. Breach rate is breached over active, so a large hub and a small ' +
      'hub compare fairly.</p></div><select id="pj-dimension">' + d.dimensions.map(function (dim) {
        return '<option value="' + esc(dim.key) + '"' + (dim.key === d.dimension ? ' selected' : '') + '>' + esc(dim.label) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="pj-table-wrap"><table class="pj-table"><thead><tr><th>' + esc(label) + '</th><th class="num">Active</th>' +
      '<th class="num">In process</th><th class="num">Terminal, not invoiced</th><th class="num">Breached</th>' +
      '<th class="pj-rate-col">Breach rate</th><th class="num">Open breaches</th></tr></thead><tbody>';
    slice.forEach(function (row) {
      var rate = row.active ? row.breachedParcels / row.active : null;
      var width = rate === null || !peak ? 0 : Math.round(rate / peak * 100);
      html += '<tr><td>' + esc(row.key) + '</td><td class="num">' + int(row.active) + '</td>' +
        '<td class="num">' + int(row.inProcess) + '</td><td class="num">' + int(row.tni) + '</td>' +
        '<td class="num">' + int(row.breachedParcels) + '</td>' +
        '<td class="pj-rate-col"><span class="pj-rate-bar"><i style="width:' + width + '%"></i></span>' +
        '<span class="pj-rate-val">' + pct(rate === null ? null : rate * 100) + '</span></td>' +
        '<td class="num">' + int(row.openBreached) + '</td></tr>';
    });
    if (!d.breakdown.length) html += '<tr><td colspan="7" class="pj-note">No active parcels in this view.</td></tr>';
    html += '</tbody></table></div>';
    html += pagerHtml('breakdown-page', page, pages, int(d.breakdown.length) + ' rows');
    return html + '</div>';
  }

  function pagerHtml(action, page, pages, label) {
    return '<div class="pj-pager"><button type="button" class="ghost mini" data-pj="' + action + '" data-page="' + (page - 1) + '"' +
      (page <= 1 ? ' disabled' : '') + '>← Previous</button><span>Page ' + int(page) + ' of ' + int(pages) +
      (label ? ', ' + label : '') + '</span><button type="button" class="ghost mini" data-pj="' + action + '" data-page="' +
      (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>Next →</button></div>';
  }

  /* -------------------------------------------------------- stage boxes --- */

  function stageByKey(key) {
    var found = null;
    (PJ.view && PJ.view.stages || []).forEach(function (stage) { if (stage.key === key) found = stage; });
    return found;
  }

  function boxState(key) {
    var state = PJ.box[key] = PJ.box[key] || {};
    state.selected = state.selected || {};
    return state;
  }

  function stageBoxHtml(stage) {
    var state = boxState(stage.key);
    var chips = '<span class="pj-chip ' + (stage.openBreached ? 'bad' : 'good') + '">' + int(stage.openBreached) + ' breached</span>';
    if (stage.openBreached) {
      chips += '<span class="pj-chip">avg ' + fmtLate(stage.avgLate) + ' late</span>' +
        '<span class="pj-chip">worst ' + fmtLate(stage.worstLate) + '</span>';
      if (stage.withIssue) chips += '<span class="pj-chip info">' + int(stage.withIssue) + ' with an open issue</span>';
    }
    if (stage.endFeedEmpty && !stage.feedGap) chips += '<span class="pj-chip warn">end field blank in the feed</span>';
    if (stage.isCutoff && stage.openBreached) {
      chips += '<span class="pj-chip">' + int(stage.merchantSide) + ' merchant</span>' +
        '<span class="pj-chip">' + int(stage.carrybeeSide) + ' CarryBee</span>';
    }
    return '<details class="pj-panel pj-stage-box" id="pj-box-' + esc(stage.key) + '" data-stage="' + esc(stage.key) + '"' +
      (state.open ? ' open' : '') + '><summary><div><h3>' + esc(stage.label) + '</h3>' +
      '<p class="pj-sub mono">' + esc(stage.from) + '  to  ' + esc(stage.to) + '</p></div>' +
      '<div class="pj-chip-row">' + chips + '<button type="button" class="ghost mini" data-pj="download" data-stage="' +
      esc(stage.key) + '"' + (stage.openBreached ? '' : ' disabled') + '>Download</button></div></summary>' +
      '<div class="pj-box-body" id="pj-body-' + esc(stage.key) + '"></div></details>';
  }

  function wireStageBoxes(d) {
    var anyOpen = d.stages.some(function (stage) { return PJ.box[stage.key] && PJ.box[stage.key].open; });
    if (!anyOpen) {
      var worst = null;
      d.stages.forEach(function (stage) { if (!worst || stage.openBreached > worst.openBreached) worst = stage; });
      if (worst && worst.openBreached) {
        boxState(worst.key).open = true;
        var element = el('pj-box-' + worst.key);
        if (element) element.open = true;
      }
    }
    d.stages.forEach(function (stage) {
      var element = el('pj-box-' + stage.key);
      if (!element) return;
      if (element.open) renderBoxBody(stage.key);
      element.addEventListener('toggle', function () {
        boxState(stage.key).open = element.open;
        if (element.open) renderBoxBody(stage.key);
      });
    });
  }

  function shownRows(stage, state) {
    var needle = (state.search || '').toLowerCase();
    return stage.rows.filter(function (row) {
      if (state.hub && row.hubNow !== state.hub) return false;
      if (state.noIssue && row.issue) return false;
      if (needle && row.cid.toLowerCase().indexOf(needle) < 0 && row.businessName.toLowerCase().indexOf(needle) < 0) return false;
      return true;
    });
  }

  function selectedCids(state) {
    return Object.keys(state.selected).filter(function (cid) { return state.selected[cid]; });
  }

  function renderBoxBody(stageKey) {
    var stage = stageByKey(stageKey);
    var body = el('pj-body-' + stageKey);
    if (!stage || !body) return;
    var state = boxState(stageKey);

    if (stage.feedGap) {
      body.innerHTML = '<div class="pj-notice warn">No parcel has ever started this stage. The start field is not being ' +
        'fed, so this is a data gap rather than a clean stage.</div>';
      return;
    }
    if (!stage.rows.length) {
      body.innerHTML = '<p class="pj-note">Nothing is breached at this stage in your view right now.</p>';
      return;
    }

    var shown = shownRows(stage, state);
    var hubs = stage.hubCounts || {};
    var chosen = selectedCids(state);
    var allCount = state.hub ? (hubs[state.hub] || 0) : stage.openBreached;
    var html = '<div class="pj-box-tools">' +
      '<select data-pj-role="box-hub" data-stage="' + esc(stageKey) + '"><option value="">All hubs (' + int(stage.openBreached) + ')</option>' +
      Object.keys(hubs).sort(function (a, b) { return hubs[b] - hubs[a]; }).map(function (hub) {
        return '<option value="' + esc(hub) + '"' + (state.hub === hub ? ' selected' : '') + '>' + esc(hub) + ' (' + hubs[hub] + ')</option>';
      }).join('') + '</select>' +
      '<label class="pj-check"><input type="checkbox" data-pj-role="box-noissue" data-stage="' + esc(stageKey) + '"' +
      (state.noIssue ? ' checked' : '') + '> No open issue only</label>' +
      '<input type="text" class="pj-inline-input" data-pj-role="box-search" data-stage="' + esc(stageKey) +
      '" placeholder="Find CID or business" value="' + esc(state.search || '') + '">' +
      '<span class="pj-note">' + int(shown.length) + ' shown</span></div>';

    html += '<div class="pj-bulkbar"><span class="pj-bulk-count">' + int(chosen.length) + ' selected</span>' +
      '<button type="button" class="ghost mini" data-pj="raise-selected" data-stage="' + esc(stageKey) + '"' +
      (chosen.length ? '' : ' disabled') + '>Issue resolution for selected</button>' +
      '<button type="button" class="primary mini" data-pj="raise-all" data-stage="' + esc(stageKey) + '"' +
      (allCount ? '' : ' disabled') + '>Issue resolution for all ' + int(allCount) +
      (state.hub ? ' in ' + esc(state.hub) : '') + (state.search ? ' matching' : '') + '</button>' +
      '<span class="pj-note">Parcels that already have an open issue for this stage are skipped.</span></div>';

    var selectable = shown.filter(function (row) { return !row.issue; });
    var allTicked = selectable.length && selectable.every(function (row) { return state.selected[row.cid]; });
    html += '<div class="pj-table-wrap"><table class="pj-table pj-box-table"><thead><tr>' +
      '<th class="pj-cb"><input type="checkbox" data-pj-role="box-all" data-stage="' + esc(stageKey) + '"' +
      (allTicked ? ' checked' : '') + (selectable.length ? '' : ' disabled') + ' title="Select every row shown"></th>' +
      '<th>CID</th><th>Business</th>' + (stage.isCutoff ? '<th>Side</th>' : '') +
      '<th>Late clock started</th><th>Measured to</th><th class="num">Elapsed</th><th class="num">Target</th>' +
      '<th class="num">Late by</th><th>Hub now</th><th>Issue</th></tr></thead><tbody>';
    shown.forEach(function (row) {
      var index = stage.rows.indexOf(row);
      var side = row.side === 'Merchant' ? '<span class="pj-tag warn">Merchant</span>'
        : row.side === 'CarryBee' ? '<span class="pj-tag bad">CarryBee</span>' : '';
      html += '<tr' + (state.selected[row.cid] ? ' class="pj-picked"' : '') + '>' +
        '<td class="pj-cb"><input type="checkbox" data-pj-role="box-row" data-stage="' + esc(stageKey) + '" data-cid="' +
        esc(row.cid) + '"' + (state.selected[row.cid] ? ' checked' : '') + (row.issue ? ' disabled' : '') + '></td>' +
        '<td class="mono"><a href="#" data-pj="trace" data-cid="' + esc(row.cid) + '">' + esc(row.cid) + '</a>' +
        '<div class="small">' + (PARCEL_STATE_TAG[row.state] || '') + '</div></td>' +
        '<td>' + esc(row.businessName) + '<div class="small dim">' + esc(row.businessId) + '</div></td>' +
        (stage.isCutoff ? '<td>' + side + '</td>' : '') +
        '<td class="small"><span class="dim">' + esc(row.fromLabel) + '</span><div class="mono">' + esc(row.fromAt) + '</div></td>' +
        '<td class="small"><span class="dim">' + esc(row.toLabel) + '</span><div class="mono">' + esc(row.toAt) + '</div></td>' +
        '<td class="num">' + (stage.isCutoff ? '—' : fmtLate(row.elapsedHours)) + '</td>' +
        '<td class="num">' + (row.targetHours === null ? 'cutoff' : fmtLate(row.targetHours)) + '</td>' +
        '<td class="num pj-late">' + fmtLate(row.lateBy) + '</td>' +
        '<td class="small">' + esc(row.hubNow) + '<div class="dim">' + esc(row.zoneNow) + '</div></td>' +
        '<td>' + issueCell(stageKey, row, index) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    if (stage.rowsCapped) {
      html += '<p class="pj-note">The ' + int(stage.rows.length) + ' worst of ' + int(stage.openBreached) +
        '. "Issue resolution for all" and Download cover every one.</p>';
    }
    body.innerHTML = html;
  }

  function issueCell(stageKey, row, index) {
    if (row.issue) {
      return '<span class="pj-state ' + (row.issue.flag && row.issue.flag !== 'Regular' ? 'bad' : 'info') + '">' +
        esc(row.issue.status || 'Open') + (row.issue.flag && row.issue.flag !== 'Regular' ? ' · ' + esc(row.issue.flag) : '') +
        '</span><div class="small dim">' + esc(row.issue.hub) + ', ' + esc(row.issue.level || 'L3') + ', ' + esc(row.issue.raisedAt) + '</div>';
    }
    return '<button type="button" class="ghost mini" data-pj="raise-one" data-stage="' + esc(stageKey) +
      '" data-index="' + index + '">Issue resolution</button>';
  }

  function openStage(stageKey) {
    var state = boxState(stageKey);
    state.open = true;
    state.hub = '';
    var element = el('pj-box-' + stageKey);
    if (!element) return;
    if (!element.open) element.open = true; else renderBoxBody(stageKey);
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function downloadStage(stageKey, button) {
    if (button) button.disabled = true;
    api('POST', '/api/parcel/download', { stageKey: stageKey, options: PJ.options }).then(function (res) {
      if (!res.rows) { window.alert('Nothing breached to download.'); return; }
      saveText(res.fileName, res.csv);
    }).catch(function (error) {
      window.alert(error.message);
    }).then(function () { if (button) button.disabled = false; });
  }

  /* ------------------------------------------------------------- modals --- */

  /**
   * Popups are a stack, as in TQM: Back returns to the popup underneath (or
   * the page), Close leaves all of them. A late async reply only lands on the
   * popup it was meant for.
   */
  var MODALS = [];
  var MODAL_SEQ = 0;

  function modalShell() {
    var overlay = el('pj-modal');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'pj-modal';
    overlay.className = 'pj-modal-overlay';
    overlay.hidden = true;
    overlay.innerHTML = '<div class="pj-modal-box" id="pj-modal-box" role="dialog" aria-modal="true">' +
      '<div class="pj-modal-bar"><button type="button" class="ghost mini" data-pj="modal-back" id="pj-modal-back">← Back</button>' +
      '<span class="pj-modal-crumb" id="pj-modal-crumb"></span>' +
      '<button type="button" class="ghost mini" data-pj="modal-close">Close</button></div>' +
      '<div id="pj-modal-body" class="pj-modal-body"></div></div>';
    overlay.addEventListener('mousedown', function (event) {
      if (event.target === overlay) modalBack();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function paintModal() {
    var overlay = modalShell();
    var top = MODALS[MODALS.length - 1];
    if (!top) {
      overlay.hidden = true;
      el('pj-modal-body').innerHTML = '';
      document.body.classList.remove('pj-modal-open');
      return;
    }
    el('pj-modal-body').innerHTML = top.html;
    el('pj-modal-box').className = 'pj-modal-box' + (top.wide ? ' wide' : '');
    el('pj-modal-back').textContent = MODALS.length > 1 ? '← Back' : '← Back to page';
    var below = MODALS[MODALS.length - 2];
    el('pj-modal-crumb').textContent = (below && below.title ? below.title + '  /  ' : '') + (top.title || '');
    overlay.hidden = false;
    document.body.classList.add('pj-modal-open');
    el('pj-modal-body').scrollTop = 0;
    if (typeof top.onShow === 'function') top.onShow();
  }

  function openModal(html, opts) {
    opts = opts || {};
    var id = ++MODAL_SEQ;
    MODALS.push({ id: id, html: html, title: opts.title || '', wide: !!opts.wide, onShow: opts.onShow || null });
    paintModal();
    return id;
  }

  function replaceModal(id, html, opts) {
    opts = opts || {};
    for (var i = 0; i < MODALS.length; i++) {
      if (MODALS[i].id !== id) continue;
      MODALS[i].html = html;
      if (opts.title !== undefined) MODALS[i].title = opts.title;
      if (opts.onShow !== undefined) MODALS[i].onShow = opts.onShow;
      if (i === MODALS.length - 1) paintModal();
      return true;
    }
    return false;
  }

  function modalIsOpen(id) { return MODALS.some(function (m) { return m.id === id; }); }
  function modalBack() { MODALS.pop(); paintModal(); }
  function closeModal() { MODALS = []; if (el('pj-modal')) paintModal(); }

  /* ------------------------------------------------- the issue form ------ */

  /** Channel, status and social source options, read from the Log an Issue form so both stay in step. */
  function formOptions() {
    var channels = [], statuses = [], social = [];
    Array.prototype.forEach.call(document.querySelectorAll('#f-channel option'), function (o) {
      if (!o.disabled && o.value) channels.push(o.value);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#f-status option'), function (o) {
      if (!o.disabled && o.value) statuses.push(o.value);
    });
    var group = null;
    Array.prototype.forEach.call(document.querySelectorAll('#field-social-source .checkbox-box > *'), function (node) {
      if (node.classList.contains('checkbox-group-title')) {
        group = { title: node.textContent.trim(), items: [] };
        social.push(group);
      } else {
        var input = node.querySelector('input');
        if (input && group) group.items.push(input.value);
      }
    });
    if (!channels.length) channels = ['KAM', 'Contact center', 'Social Media', 'Inbound', 'OPS', 'HUB', 'Merchant panel'];
    if (!statuses.length) statuses = ['Open', 'In Progress', 'Resolved'];
    return { channels: channels, statuses: statuses, social: social };
  }

  /**
   * ctx = { stage, selection, single: row|null }
   * Opens the issue form: parcels first (hub-wise), then the Log an Issue fields.
   */
  function openRaise(ctx) {
    var opts = formOptions();
    var stage = ctx.stage;
    var single = ctx.single;
    var html = '<h3>Issue resolution</h3>';
    if (single) {
      html += '<p class="pj-sub"><span class="mono">' + esc(single.cid) + '</span>, ' + esc(stage.label) + ', ' +
        esc(fmtLate(single.lateBy)) + ' late. ' + esc(single.businessName) + ', hub now ' + esc(single.hubNow) + '.</p>' +
        '<p class="small dim">' + esc(single.fromLabel) + ' ' + esc(single.fromAt) + ' to ' + esc(single.toLabel) + ' ' +
        esc(single.toAt) + '</p>';
    } else {
      html += '<p class="pj-sub">' + esc(stage.label) + ': one issue per parcel, each sent to the hub that parcel is in now.</p>';
    }
    html += '<div id="pj-raise-preview" class="pj-preview"><p class="pj-note">Checking the parcels…</p></div>';

    html += '<form id="pj-raise-form" class="pj-form" autocomplete="off"><div class="pj-form-grid">' +
      '<div class="pj-field full"><label>Consignment ID / Merchant Name</label>' +
      '<input type="text" id="pj-f-consignment" readonly value="' + esc(single ? single.cid + ' — ' + single.businessName : 'Filled per parcel (CID)') + '"></div>' +
      '<div class="pj-field full"><label>Channel <span class="req">*</span></label>' +
      '<div class="pj-slidebar" id="pj-f-channel" role="radiogroup" aria-label="Channel"><span class="pj-slide-thumb"></span>' +
      opts.channels.map(function (c) {
        return '<button type="button" class="pj-slide" role="radio" aria-checked="false" data-pj="channel" data-value="' +
          esc(c) + '">' + esc(c) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="pj-field" id="pj-field-media" hidden><label>Media <span class="req">*</span></label>' +
      '<select id="pj-f-media"><option value="" disabled selected>Choose</option><option>Customer</option><option>Merchant</option></select></div>' +
      '<div class="pj-field full" id="pj-field-social" hidden><label>Social Media Source <span class="req">*</span></label>' +
      '<div class="pj-checkbox-box">' + opts.social.map(function (group) {
        return '<div class="pj-checkbox-title">' + esc(group.title) + '</div>' + group.items.map(function (item) {
          return '<label class="pj-checkbox-item"><input type="checkbox" class="pj-social-opt" value="' + esc(item) + '"> ' + esc(item) + '</label>';
        }).join('');
      }).join('') + '</div></div>' +
      '<div class="pj-field"><label>Zone <span class="auto">auto</span></label>' +
      '<input type="text" id="pj-f-zone" readonly value="' + esc(single ? single.zoneNow : 'Per parcel') + '"></div>' +
      '<div class="pj-field"><label>Hub Name <span class="auto">auto</span></label>' +
      '<input type="text" id="pj-f-hub" readonly value="' + esc(single ? single.hubNow : 'Hub-wise, per parcel') + '"></div>' +
      '<div class="pj-field"><label>Issue Status <span class="req">*</span></label><select id="pj-f-status">' +
      '<option value="" disabled selected>Choose</option>' + opts.statuses.map(function (s) {
        return '<option>' + esc(s) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="pj-field"><label>Issue Category <span class="req">*</span></label><select id="pj-f-category">' +
      '<option value="" disabled selected>Choose</option>' + Object.keys(CATEGORY_MAP).map(function (c) {
        return '<option>' + esc(c) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="pj-field"><label>Issue Subcategory <span class="req">*</span></label>' +
      '<select id="pj-f-subcategory" disabled><option value="" selected>Choose category first</option></select></div>' +
      '<div class="pj-field full"><label>Issue Details <span class="req">*</span></label>' +
      '<textarea id="pj-f-details" rows="4" maxlength="3000" placeholder="What happened? Include any relevant context the assignee will need."></textarea>' +
      '<span class="pj-hint">The stage, how late, the breach window and the merchant are added to each issue automatically.</span></div>' +
      '<div class="pj-field full"><label>Attachments <span class="hint">Photo or voice note, optional</span></label>' +
      '<div class="pj-attach"><input type="file" id="pj-f-photo" accept="image/*" multiple hidden>' +
      '<input type="file" id="pj-f-audio" accept="audio/*" multiple hidden>' +
      '<button type="button" class="pj-attach-btn" data-pj="add-photo">📷 Add photo</button>' +
      '<button type="button" class="pj-attach-btn" data-pj="add-audio">🎙️ Add voice note</button></div>' +
      '<div id="pj-attach-list" class="pj-attach-list"></div>' +
      (single ? '' : '<span class="pj-hint">In a bulk submission every issue gets a copy of the attachments.</span>') +
      '</div></div>' +
      '<div class="pj-modal-actions"><button type="button" class="ghost" data-pj="modal-back">Cancel</button>' +
      '<button type="submit" class="primary" id="pj-raise-send" disabled>Log issue</button></div>' +
      '<div id="pj-raise-line" class="pj-note"></div></form>';

    var raise = { selection: ctx.selection, attachments: [], channel: '', count: 0, modalId: null };
    // onShow runs inside openModal, before its id is returned, so the form
    // reads raise.modalId when it is submitted, not when it is wired.
    var modalId = openModal(html, {
      title: single ? 'Raise ' + single.cid : stage.short + ': raise in bulk',
      wide: true,
      onShow: function () { wireRaiseForm(raise); }
    });
    raise.modalId = modalId;
    api('POST', '/api/parcel/issues/preview', { selection: ctx.selection }).then(function (preview) {
      if (!modalIsOpen(modalId)) return;
      raise.count = preview.count;
      raise.preview = preview;
      paintPreview(raise);
    }).catch(function (error) {
      if (!modalIsOpen(modalId)) return;
      var box = el('pj-raise-preview');
      if (box) box.innerHTML = '<p class="pj-error">' + esc(error.message) + '</p>';
    });
  }

  function paintPreview(raise) {
    var p = raise.preview;
    var box = el('pj-raise-preview');
    if (!box || !p) return;
    var html = '';
    if (!p.count) {
      html = '<div class="pj-notice warn">' + (p.alreadyOpen
        ? 'Every selected parcel already has an open issue for this stage. Nothing to send.'
        : 'None of the selected parcels is breached at this stage right now.') + '</div>';
    } else {
      html = '<div class="pj-preview-head"><b>' + int(p.count) + '</b> parcel' + (p.count === 1 ? '' : 's') + ' → <b>' +
        int(p.hubs.length) + '</b> hub' + (p.hubs.length === 1 ? '' : 's') +
        (p.alreadyOpen ? ' <span class="dim">· ' + int(p.alreadyOpen) + ' skipped, already open</span>' : '') +
        (p.notBreached ? ' <span class="dim">· ' + int(p.notBreached) + ' no longer breached</span>' : '') + '</div>';
      if (p.count > p.max) {
        html += '<div class="pj-notice bad">At most ' + int(p.max) + ' parcels can be sent at once. Narrow the filters or ' +
          'pick a hub in the box.</div>';
      }
      html += '<div class="pj-table-wrap pj-hub-table"><table class="pj-table"><thead><tr><th>Hub (where the parcel is now)</th>' +
        '<th>Zone</th><th>Cluster</th><th class="num">Parcels</th><th>Ops Console</th></tr></thead><tbody>' +
        p.hubs.map(function (h) {
          return '<tr><td>' + esc(h.hub) + '</td><td>' + esc(h.zone) + '</td><td class="small dim">' + esc(h.cluster) + '</td>' +
            '<td class="num">' + int(h.count) + '</td><td class="small">' +
            (h.assigned === false ? '<span class="pj-tag warn" title="No one is mapped to this hub in hub_assignments, so it will not show in anyone\'s Ops Console queue">not assigned</span>'
                                  : h.assigned ? '<span class="pj-tag good">assigned</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      var zones = {};
      p.hubs.forEach(function (h) { zones[h.zone] = 1; });
      if (el('pj-f-zone') && p.hubs.length > 1) el('pj-f-zone').value = 'Per parcel: ' + Object.keys(zones).join(', ');
      if (el('pj-f-hub') && p.hubs.length > 1) el('pj-f-hub').value = 'Hub-wise: ' + int(p.hubs.length) + ' hubs (listed above)';
    }
    box.innerHTML = html;
    var send = el('pj-raise-send');
    if (send) {
      send.disabled = !p.count || p.count > p.max;
      send.textContent = p.count > 1 ? 'Log ' + int(p.count) + ' issues' : 'Log issue';
    }
  }

  function moveThumb(bar) {
    var thumb = bar.querySelector('.pj-slide-thumb');
    var on = bar.querySelector('.pj-slide.on');
    if (!thumb) return;
    if (!on) { thumb.style.opacity = '0'; return; }
    thumb.style.opacity = '1';
    thumb.style.width = on.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + on.offsetLeft + 'px)';
    var left = on.offsetLeft - bar.scrollLeft;
    if (left < 0 || left + on.offsetWidth > bar.clientWidth) {
      bar.scrollTo({ left: on.offsetLeft - 16, behavior: 'smooth' });
    }
  }

  function renderRaiseAttachments(raise) {
    var list = el('pj-attach-list');
    if (!list) return;
    list.innerHTML = raise.attachments.map(function (a, index) {
      return '<div class="pj-attach-chip">' + (a.type === 'photo' ? '<img src="' + a.dataUrl + '" alt="">'
        : '<span class="pj-chip-audio">🎙️</span>') + '<span class="pj-chip-name">' + esc(a.filename || a.type) +
        '</span><button type="button" class="pj-chip-remove" data-pj="remove-attachment" data-index="' + index +
        '" title="Remove">✕</button></div>';
    }).join('');
  }

  function addRaiseFiles(raise, files, type) {
    var photoCap = typeof MAX_PHOTO_RAW_BYTES !== 'undefined' ? MAX_PHOTO_RAW_BYTES : 20 * 1024 * 1024;
    var audioCap = typeof MAX_AUDIO_BYTES !== 'undefined' ? MAX_AUDIO_BYTES : 4 * 1024 * 1024;
    var jobs = Array.prototype.slice.call(files).map(function (file) {
      var cap = type === 'photo' ? photoCap : audioCap;
      if (file.size > cap) {
        say('pj-raise-line', file.name + ' is too large (max ' + Math.round(cap / 1048576) + ' MB).', 'bad');
        return Promise.resolve();
      }
      var read = type === 'photo' ? compressImage(file, 1280) : fileToDataUrl(file);
      return read.then(function (dataUrl) {
        raise.attachments.push({ type: type, filename: file.name, mimeType: type === 'photo' ? 'image/jpeg' : file.type, dataUrl: dataUrl });
      }).catch(function () { say('pj-raise-line', 'Could not read ' + file.name + '.', 'bad'); });
    });
    Promise.all(jobs).then(function () { renderRaiseAttachments(raise); });
  }

  function wireRaiseForm(raise) {
    var form = el('pj-raise-form');
    if (!form) return;
    PJ.raise = raise;
    var bar = el('pj-f-channel');
    if (raise.channel) {
      Array.prototype.forEach.call(bar.querySelectorAll('.pj-slide'), function (b) {
        var on = b.getAttribute('data-value') === raise.channel;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    window.requestAnimationFrame(function () { moveThumb(bar); });
    renderRaiseAttachments(raise);
    paintPreview(raise);

    el('pj-f-category').onchange = function () {
      var sub = el('pj-f-subcategory');
      var subs = CATEGORY_MAP[this.value] || [];
      sub.disabled = !subs.length;
      sub.innerHTML = subs.length
        ? '<option value="" disabled selected>Choose</option>' + subs.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('')
        : '<option value="" selected>Choose category first</option>';
    };
    el('pj-f-photo').onchange = function () { addRaiseFiles(raise, this.files, 'photo'); this.value = ''; };
    el('pj-f-audio').onchange = function () { addRaiseFiles(raise, this.files, 'audio'); this.value = ''; };
    form.onsubmit = function (event) {
      event.preventDefault();
      submitRaise(raise.modalId, raise);
    };
  }

  function pickChannel(button) {
    var raise = PJ.raise;
    if (!raise) return;
    raise.channel = button.getAttribute('data-value');
    var bar = el('pj-f-channel');
    Array.prototype.forEach.call(bar.querySelectorAll('.pj-slide'), function (b) {
      b.classList.toggle('on', b === button);
      b.setAttribute('aria-checked', b === button ? 'true' : 'false');
    });
    moveThumb(bar);
    var needsMedia = raise.channel === 'Social Media' || raise.channel === 'Inbound';
    el('pj-field-media').hidden = !needsMedia;
    if (!needsMedia) el('pj-f-media').value = '';
    el('pj-field-social').hidden = raise.channel !== 'Social Media';
    if (raise.channel !== 'Social Media') {
      Array.prototype.forEach.call(document.querySelectorAll('.pj-social-opt'), function (cb) { cb.checked = false; });
    }
  }

  function submitRaise(modalId, raise) {
    var channel = raise.channel;
    var issue = {
      channel: channel,
      media: (channel === 'Social Media' || channel === 'Inbound') ? el('pj-f-media').value : '',
      socialSource: channel === 'Social Media'
        ? Array.prototype.filter.call(document.querySelectorAll('.pj-social-opt'), function (cb) { return cb.checked; })
            .map(function (cb) { return cb.value; }).join(', ')
        : '',
      status: el('pj-f-status').value,
      category: el('pj-f-category').value,
      subcategory: el('pj-f-subcategory').value,
      details: el('pj-f-details').value.trim(),
      attachments: raise.attachments
    };
    var missing = [];
    if (!issue.channel) missing.push('Channel');
    if ((channel === 'Social Media' || channel === 'Inbound') && !issue.media) missing.push('Media');
    if (channel === 'Social Media' && !issue.socialSource) missing.push('at least one Social Media source');
    if (!issue.status) missing.push('Issue Status');
    if (!issue.category) missing.push('Issue Category');
    if (!issue.subcategory) missing.push('Issue Subcategory');
    if (!issue.details) missing.push('Issue Details');
    if (missing.length) { say('pj-raise-line', 'Choose or fill: ' + missing.join(', ') + '.', 'bad'); return; }

    var send = el('pj-raise-send');
    send.disabled = true;
    say('pj-raise-line', raise.count > 1 ? 'Logging ' + int(raise.count) + ' issues…' : 'Logging the issue…');
    api('POST', '/api/parcel/issues', { selection: raise.selection, issue: issue }).then(function (res) {
      if (!modalIsOpen(modalId)) return;
      var unassigned = res.hubs.filter(function (h) { return h.assigned === false; });
      replaceModal(modalId, '<h3>' + (res.created === 1 ? 'Issue logged' : int(res.created) + ' issues logged') + '</h3>' +
        '<p class="pj-sub">Each one is on the escalation ladder at L3 with the hub the parcel is in now, and shows on the ' +
        'Escalation Dashboard and in that hub\'s Ops Console queue.</p>' +
        '<div class="pj-table-wrap pj-hub-table"><table class="pj-table"><thead><tr><th>Hub</th><th>Zone</th><th class="num">Issues</th></tr></thead><tbody>' +
        res.hubs.map(function (h) {
          return '<tr><td>' + esc(h.hub) + (h.assigned === false ? ' <span class="pj-tag warn">not assigned</span>' : '') +
            '</td><td>' + esc(h.zone) + '</td><td class="num">' + int(h.count) + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        (res.alreadyOpen ? '<p class="pj-note">' + int(res.alreadyOpen) + ' parcels were skipped: they already had an open issue for this stage.</p>' : '') +
        (unassigned.length ? '<div class="pj-notice warn">' + int(unassigned.length) + ' of these hubs have no one mapped in ' +
          'hub_assignments, so their issues will not appear in any Ops Console queue until someone is assigned.</div>' : '') +
        '<div class="pj-modal-actions"><button type="button" class="primary" data-pj="raise-done">Done</button></div>',
        { title: 'Logged', onShow: null });
      var state = boxState(raise.selection.stageKey);
      state.selected = {};
    }).catch(function (error) {
      if (!modalIsOpen(modalId)) return;
      send.disabled = false;
      say('pj-raise-line', error.message, 'bad');
    });
  }

  function raiseFromBox(stageKey, mode, index) {
    var stage = stageByKey(stageKey);
    if (!stage) return;
    var state = boxState(stageKey);
    var selection = { stageKey: stageKey, options: PJ.options };
    var single = null;
    if (mode === 'one') {
      single = stage.rows[index];
      if (!single) return;
      selection.cids = [single.cid];
    } else if (mode === 'selected') {
      selection.cids = selectedCids(state);
      if (!selection.cids.length) return;
    } else {
      selection.boxHub = state.hub || '';
      selection.boxSearch = state.search || '';
    }
    openRaise({ stage: stage, selection: selection, single: single });
  }

  /* ------------------------------------------------------ SLA uploads ---- */

  function handleSlaFile(file) {
    say('pj-sla-status', 'Reading ' + file.name);
    readWorkbookRows(file, 'SLA Hub Matrix').then(function (rows) {
      say('pj-sla-status', 'Uploading ' + (rows.length - 1) + ' hub rows. Every parcel is re-measured against the new targets.');
      return api('POST', '/api/parcel/sla-matrix', { fileName: file.name, rows: rows });
    }).then(function (res) {
      var parts = [res.hubs + ' hubs loaded'];
      if (res.skipped) parts.push(res.skipped + ' blank or duplicate rows skipped');
      if (res.invalidCount) parts.push(res.invalidCount + ' cells outside 0 to 720 h ignored');
      if (res.addedNetworkDefault) parts.push('a Network Default row was added');
      if (res.missingColumns && res.missingColumns.length) parts.push('missing columns: ' + res.missingColumns.join(', '));
      say('pj-sla-status', parts.join(', ') + '.', 'good');
      window.setTimeout(function () { load(false); }, 900);
    }).catch(function (error) {
      say('pj-sla-status', error.message, 'bad');
    });
  }

  function viewMatrix() {
    var modalId = openModal('<h3>SLA Hub Matrix</h3><p class="pj-sub">Loading</p>', { title: 'SLA Hub Matrix', wide: true });
    api('GET', '/api/parcel/sla-matrix').then(function (res) {
      var html = '<h3>SLA Hub Matrix</h3><p class="pj-sub">' + int(res.rows.length) + ' hubs, stored in the database. ' +
        'A dash means the hub uses the network default.</p><div class="pj-table-wrap tall"><table class="pj-table"><thead><tr><th>Hub</th>';
      res.stages.forEach(function (stage) { html += '<th class="num small">' + esc(stage.column) + '</th>'; });
      html += '</tr></thead><tbody><tr class="pj-network-row"><td>Network default</td>';
      res.stages.forEach(function (stage) { html += '<td class="num">' + esc(String(res.network[stage.key] || '-')) + '</td>'; });
      html += '</tr>';
      res.rows.forEach(function (row) {
        html += '<tr><td>' + esc(row.hub) + '</td>';
        res.stages.forEach(function (stage) {
          var value = row.hours[stage.key];
          html += '<td class="num' + (value ? '' : ' dim') + '">' + (value ? esc(String(value)) : '-') + '</td>';
        });
        html += '</tr>';
      });
      replaceModal(modalId, html + '</tbody></table></div>');
    }).catch(function (error) {
      replaceModal(modalId, '<h3>SLA Hub Matrix</h3><p class="pj-error">' + esc(error.message) + '</p>');
    });
  }

  function exportMatrix() {
    api('GET', '/api/parcel/sla-matrix').then(function (res) {
      var lines = [res.headers];
      lines.push(['Network Default'].concat(res.stages.map(function (stage) { return res.network[stage.key] || ''; })));
      res.rows.forEach(function (row) {
        lines.push([row.hub].concat(res.stages.map(function (stage) { return row.hours[stage.key] || ''; })));
      });
      saveText('SLA_upload_current.csv', lines.map(function (line) {
        return line.map(function (cell) {
          var value = String(cell);
          return /[",\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
        }).join(',');
      }).join('\n'));
    }).catch(function (error) { window.alert(error.message); });
  }

  /* ---------------------------------------------------- parcel upload ---- */

  function handleParcelFile(file) {
    var spec = PJ.view.uploadColumns;
    var modalId = openModal('<h3>Upload parcel file</h3><p class="pj-sub">' + esc(file.name) + '</p>' +
      '<div class="pj-progress"><i id="pj-up-bar" style="width:0%"></i></div><p id="pj-up-line" class="pj-note">Reading the file… ' +
      'A full export can take a little while in the browser.</p>', { title: 'Upload' });
    function progress(fraction, message, tone) {
      if (!modalIsOpen(modalId)) return;
      var bar = el('pj-up-bar');
      if (bar) bar.style.width = Math.round(fraction * 100) + '%';
      say('pj-up-line', message, tone);
    }

    readWorkbookRows(file, 'Parcel Journey').then(function (rows) {
      if (rows.length < 2) throw new Error('The file has a header row but no parcel rows.');
      var index = {};
      rows[0].forEach(function (header, position) {
        var name = String(header).replace(/\s+/g, ' ').trim().toLowerCase();
        if (name && index[name] === undefined) index[name] = position;
      });
      var positions = spec.map(function (col) { return index[col.header.toLowerCase()]; });
      var missing = spec.filter(function (col, k) { return positions[k] === undefined; }).map(function (col) { return col.header; });
      var body = rows.slice(1).map(function (row) {
        return spec.map(function (col, k) {
          var at = positions[k];
          if (at === undefined) return '';
          var value = row[at];
          if (col.time) return excelDateText(value);
          return typeof value === 'number' ? String(value) : String(value === null || value === undefined ? '' : value).trim();
        });
      }).filter(function (row) { return row[0]; });
      if (!body.length) throw new Error('No row has a CID.');
      progress(0.02, int(body.length) + ' parcels read' + (missing.length ? '; not in the file: ' + missing.join(', ') : '') + '. Uploading…');
      return api('POST', '/api/parcel/upload/start', { fileName: file.name, totalRows: body.length, missingColumns: missing })
        .then(function (start) {
          var size = Math.min(start.chunkRows || 2000, 2000);
          var sent = 0;
          function next() {
            if (sent >= body.length) return Promise.resolve();
            var chunk = body.slice(sent, sent + size);
            return api('POST', '/api/parcel/upload/chunk', { batchId: start.batchId, rows: chunk }).then(function () {
              sent += chunk.length;
              progress(0.02 + 0.9 * sent / body.length, int(sent) + ' of ' + int(body.length) + ' parcels stored…');
              return next();
            });
          }
          return next().then(function () {
            progress(0.95, 'Switching to the new file and measuring every parcel…');
            return api('POST', '/api/parcel/upload/finish', { batchId: start.batchId });
          });
        });
    }).then(function (res) {
      progress(1, int(res.parcels) + ' parcels loaded. Snapshot ' + res.snapshot + '.', 'good');
      if (modalIsOpen(modalId)) {
        replaceModal(modalId, '<h3>Parcel file loaded</h3><p class="pj-sub">' + int(res.parcels) + ' parcels are live for every ' +
          'user. Snapshot ' + esc(res.snapshot) + ', the latest event in the file.</p>' +
          '<div class="pj-modal-actions"><button type="button" class="primary" data-pj="modal-close">Done</button></div>');
      }
      PJ.box = {};
      PJ.breakdownPage = 1;
      load(true);
    }).catch(function (error) {
      progress(0, error.message + ' The previous file is still the live one.', 'bad');
    });
  }

  /* ------------------------------------------------------- CID Journey --- */

  function journeyPanelHtml() {
    return '<div class="pj-panel" id="pj-journey-panel"><div class="pj-panel-head"><div><h2>CID Journey</h2>' +
      '<p class="pj-sub">Every parcel in view, finished ones included, with the hours it spent in each stage. Red is over ' +
      'the hub target. Italic is still running. A dash is a stage not reached, blank is not on this route, and "check" ' +
      'is a timestamp problem in the source data. Click a CID for its full trace.</p></div>' +
      '<div class="pj-chip-row"><input type="text" id="pj-cid-lookup" class="pj-inline-input" placeholder="Trace any CID">' +
      '<button type="button" class="ghost mini" data-pj="trace-input">Trace</button></div></div>' +
      '<div id="pj-journey-body">' + journeyBodyHtml() + '</div></div>';
  }

  function journeyBodyHtml() {
    var d = PJ.view, page = PJ.journey;
    if (!d || !page) return '';
    var html = '<div class="pj-journey-tools"><div class="pj-segmented">' + JOURNEY_MODES.map(function (mode) {
      return '<button type="button" data-pj="journey-mode" data-mode="' + mode[0] + '"' + (page.mode === mode[0] ? ' class="on"' : '') +
        '>' + mode[1] + ' <b>' + int(page.counts[mode[0]]) + '</b></button>';
    }).join('') + '</div><input type="text" id="pj-journey-search" class="pj-inline-input" placeholder="Find CID or business" value="' +
      esc(PJ.journeySearch) + '"><button type="button" class="ghost mini" data-pj="journey-search">Find</button></div>';

    html += '<div class="pj-table-wrap tall"><table class="pj-table pj-journey"><thead><tr><th class="pj-sticky">CID</th>' +
      '<th>Business</th><th>Hub now</th><th>State</th>';
    d.stages.forEach(function (stage) {
      html += '<th class="pj-time" title="' + esc(stage.label + ': ' + stage.from + ' to ' + stage.to) + '">' + esc(stage.short) + '</th>';
    });
    html += '<th class="num">Breached</th><th class="num">Worst late</th></tr></thead><tbody>';
    page.rows.forEach(function (row) {
      html += '<tr><td class="mono pj-sticky"><a href="#" data-pj="trace" data-cid="' + esc(row.cid) + '">' + esc(row.cid) + '</a></td>' +
        '<td class="small">' + esc(row.b) + '</td><td class="small">' + esc(row.h) + '</td><td>' + (PARCEL_STATE_TAG[row.st] || '') + '</td>';
      d.stages.forEach(function (stage, s) { html += journeyCell(stage, row.s[s] || ['N']); });
      html += '<td class="num' + (row.o ? ' pj-late' : '') + '">' + (row.o ? int(row.o) : '') + '</td>' +
        '<td class="num' + (row.o ? ' pj-late' : '') + '">' + (row.o ? fmtLate(row.w) : '') + '</td></tr>';
    });
    if (!page.rows.length) html += '<tr><td colspan="' + (d.stages.length + 6) + '" class="pj-note">Nothing in this view.</td></tr>';
    html += '</tbody></table></div>';
    return html + pagerHtml('journey-page', page.page, page.pages, int(page.total) + ' parcels');
  }

  function journeyCell(stage, cell) {
    var code = cell[0], hours = cell[1], target = cell[2];
    if (code === 'N') return '<td class="pj-time na" title="Not on this route"></td>';
    if (code === 'P') return '<td class="pj-time pending" title="Not reached yet">–</td>';
    if (code === 'E') return '<td class="pj-time seq" title="Timestamp problem in the source data">check</td>';
    var breached = code === 'L' || code === 'B';
    var running = code === 'O' || code === 'B';
    var label, tip;
    if (stage.isCutoff) {
      label = breached ? '+' + fmtLate(Math.max(0, hours || 0)) : running ? 'open' : 'on time';
      tip = stage.short + (breached ? ': ' + fmtLate(hours) + ' after the cutoff' : running ? ': cutoff not reached yet' : ': before the cutoff');
    } else {
      label = hours === null || hours === undefined ? '—' : fmtLate(hours);
      tip = stage.short + ': ' + label + (target ? ' against a ' + target + ' h target' : '') + (running ? ', still running' : '');
    }
    return '<td class="pj-time' + (breached ? ' over' : '') + (running ? ' running' : '') + '" title="' + esc(tip) + '">' + esc(label) + '</td>';
  }

  function loadJourney(mode, page) {
    var body = el('pj-journey-body');
    if (body) body.classList.add('busy');
    api('POST', '/api/parcel/journey', { options: PJ.options, mode: mode, page: page, search: PJ.journeySearch })
      .then(function (res) {
        PJ.journey = res;
        var holder = el('pj-journey-body');
        if (holder) { holder.innerHTML = journeyBodyHtml(); holder.classList.remove('busy'); }
      }).catch(function (error) {
        if (body) body.classList.remove('busy');
        window.alert(error.message);
      });
  }

  /* ------------------------------------------------------------- trace ---- */

  /* Outcome wording for the step list and the click-to-open step detail. */
  var OUTCOME_TEXT = {
    closed_within: 'Done, within target', closed_late: 'Done, over target', open_within: 'Running, inside target',
    open_breached: 'Running, over target', pending: 'Not reached yet', sequence_error: 'Check the source data',
    not_applicable: 'Not on this route'
  };

  function stepWhen(step) {
    return { start: step.startAt || '', end: step.endAt || '' };
  }

  /* Every step of the journey in order, with its own start and end time. Not on this
     route steps are listed too (greyed) so the sequence reads end to end. */
  function timelineTableHtml(p, timeline) {
    var html = '<div class="pj-table-wrap"><table class="pj-table pj-steps-table"><thead><tr><th>#</th><th>Step</th>' +
      '<th>Started</th><th>Ended</th><th class="num">Time</th><th>Outcome</th></tr></thead><tbody>';
    html += '<tr><td>0</td><td>Parcel created</td><td class="mono">' + esc(p.createdAt || '—') + '</td><td></td><td></td><td></td></tr>';
    timeline.forEach(function (step, index) {
      var when = stepWhen(step);
      var na = step.outcome === 'not_applicable';
      var time = na || step.hours === null || step.hours === undefined ? '—' : (step.key === 'pickup' ? esc(fmtLate(step.hours)) + ' vs cutoff' : esc(fmtLate(step.hours)));
      html += '<tr' + (na ? ' class="dim"' : '') + '><td>' + (index + 1) + '</td><td>' + esc(step.short) +
        '<div class="small dim">' + esc(step.from) + ' to ' + esc(step.to) + '</div></td>' +
        '<td class="mono">' + esc(when.start || (na ? '' : 'not started')) + '</td>' +
        '<td class="mono">' + esc(when.end || (na ? '' : (step.outcome === 'open_within' || step.outcome === 'open_breached' ? 'still running' : ''))) + '</td>' +
        '<td class="num">' + time + '</td><td>' + esc(OUTCOME_TEXT[step.outcome] || step.outcome) + '</td></tr>';
    });
    html += '<tr><td></td><td>Last update in the file</td><td class="mono">' + esc(p.updatedAt || '—') + '</td><td></td><td></td><td></td></tr>';
    return html + '</tbody></table></div>';
  }

  /* The panel that opens under a bar when it is clicked: full timestamps and every fact about that step. */
  function stepDetailHtml(step) {
    var when = stepWhen(step);
    var rows = [
      ['From event', step.from], ['Started at', when.start || 'not started'],
      ['To event', step.to], ['Ended at', when.end || (step.outcome === 'open_within' || step.outcome === 'open_breached' ? 'still running' : 'not reached')]
    ];
    if (step.cutoffAt) rows.push(['Pickup cutoff', step.cutoffAt]);
    if (step.hours !== null && step.hours !== undefined) rows.push([step.key === 'pickup' ? 'Late by' : 'Time in stage', fmtLate(step.hours)]);
    if (step.target) rows.push(['Hub target', step.target + ' h' + (step.targetSource ? ' (' + step.targetSource + ')' : '')]);
    if (step.hub) rows.push(['Hub', step.hub]);
    if (step.side) rows.push(['Side', step.side]);
    rows.push(['Outcome', OUTCOME_TEXT[step.outcome] || step.outcome]);
    if (step.reason) rows.push(['Note', step.reason]);
    return '<dl class="pj-step-facts">' + rows.map(function (r) {
      return '<div><dt>' + esc(r[0]) + '</dt><dd class="mono">' + esc(r[1]) + '</dd></div>';
    }).join('') + '</dl>';
  }

  function toggleStep(target) {
    var row = target.closest('.pj-gantt-row');
    if (!row) return;
    var panel = row.nextElementSibling;
    if (!panel || !panel.classList.contains('pj-gantt-detail')) return;
    var open = panel.hasAttribute('hidden');
    if (open) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
    row.classList.toggle('open', open);
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function traceParcel(cid) {
    cid = String(cid || '').trim();
    if (!cid) return;
    var modalId = openModal('<h3>' + esc(cid) + '</h3><p class="pj-sub">Loading the journey</p>', { title: cid, wide: true });
    api('GET', '/api/parcel/trace/' + encodeURIComponent(cid)).then(function (res) {
      var p = res.parcel;
      var measured = res.timeline.filter(function (step) { return step.outcome !== 'not_applicable'; });
      var scale = 1;
      measured.forEach(function (step) {
        if (step.key === 'pickup') return;
        var size = Math.max(step.hours || 0, step.target || 0);
        if (size > scale) scale = size;
      });
      scale = Math.min(scale, 96);
      var html = '<h3>' + esc(p.cid) + ' ' + (PARCEL_STATE_TAG[p.state] || '') + '</h3>' +
        '<p class="pj-sub">' + esc(p.businessName) + ' (' + esc(p.businessId) + '), ' + esc(p.idType) + ', status ' + int(p.statusId) + '</p>' +
        '<div class="pj-kpi-grid dense">' + kpi('Operational day', esc(p.day)) + kpi('Pickup hub', esc(p.pickupHub)) +
        kpi('Delivery hub', esc(p.hub)) + kpi('Hub now', esc(p.hubNow), p.clusterNow + ', ' + p.regionNow) + '</div>' +
        '<p class="pj-note mono">' + esc(p.route) + '</p><div class="pj-gantt"><div class="pj-gantt-scale"><span>0 h</span><span>' +
        Math.round(scale / 2) + ' h</span><span>' + Math.round(scale) + ' h' + (scale >= 96 ? '+' : '') + '</span></div>';
      measured.forEach(function (step) {
        var breached = step.outcome === 'closed_late' || step.outcome === 'open_breached';
        var running = step.outcome === 'open_within' || step.outcome === 'open_breached';
        var width = step.hours !== null && step.hours > 0 ? Math.min(step.hours, scale) / scale * 100 : 0;
        var marker = step.target ? Math.min(step.target, scale) / scale * 100 : null;
        var figure;
        if (step.outcome === 'pending') figure = '<span class="dim">not reached</span>';
        else if (step.outcome === 'sequence_error') figure = '<span class="pj-warn-text">check the source data</span>';
        else if (step.key === 'pickup') {
          figure = (step.cutoffAt ? 'cutoff ' + esc(step.cutoffAt.slice(11)) + ', ' : '') +
            (breached ? '<span class="pj-bad-text">' + esc(fmtLate(step.hours)) + ' late</span>' : running ? 'cutoff not reached' : 'on time');
        } else {
          figure = '<span class="' + (breached ? 'pj-bad-text' : '') + (running ? ' running' : '') + '">' + esc(fmtLate(step.hours)) +
            '</span>' + (step.target ? ' <span class="dim">of ' + step.target + ' h</span>' : '') + (running ? ' <span class="dim">so far</span>' : '');
        }
        html += '<div class="pj-gantt-row pj-gantt-click" data-pj="step-toggle" role="button" tabindex="0" aria-expanded="false" title="Click for the timestamps of this step"><div class="pj-gantt-label">' + esc(step.short) + '</div><div class="pj-gantt-track">' +
          (step.key === 'pickup' ? '' : '<i class="pj-gantt-bar ' + (breached ? 'd-breach' : running ? 'd-open' : 'd-ok') +
            '" style="width:' + width.toFixed(1) + '%"></i>') +
          (marker !== null ? '<b class="pj-gantt-target" style="left:' + marker.toFixed(1) + '%"></b>' : '') +
          '</div><div class="pj-gantt-fig">' + figure + '</div></div><div class="pj-gantt-detail" hidden>' +
          stepDetailHtml(step) + '</div>';
      });
      html += '</div><p class="pj-note">Bars are hours spent in the stage; the tick is the hub target; red is over target. ' +
        'Click a bar to see its timestamps. Snapshot ' + esc(res.snapshot) + '.</p>' +
        '<h4 class="pj-steps-title">All steps with time</h4>' + timelineTableHtml(p, res.timeline);
      replaceModal(modalId, html);
    }).catch(function (error) {
      replaceModal(modalId, '<h3>' + esc(cid) + '</h3><p class="pj-error">' + esc(error.message) + '</p>');
    });
  }

  /* ------------------------------------------------- delegated events ---- */

  function inScope(node) {
    return node && ((root() && root().contains(node)) || (el('pj-modal') && el('pj-modal').contains(node)));
  }

  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-pj]');
    if (!target || !inScope(target)) return;
    var action = target.getAttribute('data-pj');
    if (action === 'trace' || action === 'download') event.preventDefault();
    if (action === 'download') event.stopPropagation();

    if (action === 'reload') load(false);
    else if (action === 'upload-parcels') el('pj-parcel-file').click();
    else if (action === 'upload-sla') el('pj-sla-file').click();
    else if (action === 'view-matrix') viewMatrix();
    else if (action === 'export-matrix') exportMatrix();
    else if (action === 'stage') openStage(target.getAttribute('data-stage'));
    else if (action === 'download') downloadStage(target.getAttribute('data-stage'), target);
    else if (action === 'apply-filters') applyFilters();
    else if (action === 'clear-filters') {
      PJ.options = { dimension: PJ.options.dimension || 'hub', idType: 'All', from: '', to: '', region: '', cluster: '',
                     hub: '', route: '', search: '' };
      PJ.box = {};
      PJ.breakdownPage = 1;
      load(false);
    }
    else if (action === 'breakdown-page') {
      PJ.breakdownPage = Number(target.getAttribute('data-page'));
      el('pj-breakdown').innerHTML = breakdownHtml(PJ.view);
    }
    else if (action === 'raise-one') raiseFromBox(target.getAttribute('data-stage'), 'one', Number(target.getAttribute('data-index')));
    else if (action === 'raise-selected') raiseFromBox(target.getAttribute('data-stage'), 'selected');
    else if (action === 'raise-all') raiseFromBox(target.getAttribute('data-stage'), 'all');
    else if (action === 'channel') pickChannel(target);
    else if (action === 'add-photo') el('pj-f-photo').click();
    else if (action === 'add-audio') el('pj-f-audio').click();
    else if (action === 'remove-attachment' && PJ.raise) {
      PJ.raise.attachments.splice(Number(target.getAttribute('data-index')), 1);
      renderRaiseAttachments(PJ.raise);
    }
    else if (action === 'raise-done') { closeModal(); load(false); }
    else if (action === 'step-toggle') toggleStep(target);
    else if (action === 'trace') traceParcel(target.getAttribute('data-cid'));
    else if (action === 'trace-input') traceParcel(el('pj-cid-lookup').value);
    else if (action === 'journey-mode') loadJourney(target.getAttribute('data-mode'), 1);
    else if (action === 'journey-page') loadJourney(PJ.journey.mode, Number(target.getAttribute('data-page')));
    else if (action === 'journey-search') {
      PJ.journeySearch = el('pj-journey-search').value.trim();
      loadJourney(PJ.journey.mode, 1);
    }
    else if (action === 'modal-back') modalBack();
    else if (action === 'modal-close') closeModal();
  });

  document.addEventListener('change', function (event) {
    var node = event.target;
    if (!inScope(node)) return;
    if (node.id === 'pj-parcel-file' && node.files && node.files[0]) { handleParcelFile(node.files[0]); node.value = ''; return; }
    if (node.id === 'pj-sla-file' && node.files && node.files[0]) { handleSlaFile(node.files[0]); node.value = ''; return; }
    if (node.id === 'pj-region') { cascadeFilters('region'); return; }
    if (node.id === 'pj-cluster') { cascadeFilters('cluster'); return; }
    if (node.id === 'pj-dimension') { PJ.options.dimension = node.value; PJ.breakdownPage = 1; load(false); return; }
    var role = node.getAttribute && node.getAttribute('data-pj-role');
    if (!role) return;
    var stageKey = node.getAttribute('data-stage');
    var state = boxState(stageKey);
    if (role === 'box-hub') { state.hub = node.value; state.selected = {}; }
    else if (role === 'box-noissue') state.noIssue = node.checked;
    else if (role === 'box-row') state.selected[node.getAttribute('data-cid')] = node.checked;
    else if (role === 'box-all') {
      shownRows(stageByKey(stageKey), state).forEach(function (row) {
        if (!row.issue) state.selected[row.cid] = node.checked;
      });
    }
    renderBoxBody(stageKey);
  });

  var searchTimer = null;
  document.addEventListener('input', function (event) {
    var node = event.target;
    if (!inScope(node) || !node.getAttribute || node.getAttribute('data-pj-role') !== 'box-search') return;
    var stageKey = node.getAttribute('data-stage');
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () {
      boxState(stageKey).search = node.value;
      renderBoxBody(stageKey);
      var again = document.querySelector('[data-pj-role="box-search"][data-stage="' + stageKey + '"]');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    }, 250);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && MODALS.length) { modalBack(); return; }
    var id = event.target && event.target.id;
    if ((event.key === 'Enter' || event.key === ' ') && event.target && event.target.classList &&
        event.target.classList.contains('pj-gantt-click')) { event.preventDefault(); toggleStep(event.target); return; }
    if (event.key === 'Enter' && id === 'pj-cid-lookup') traceParcel(event.target.value);
    if (event.key === 'Enter' && id === 'pj-journey-search') {
      PJ.journeySearch = event.target.value.trim();
      loadJourney(PJ.journey.mode, 1);
    }
    if (event.key === 'Enter' && id === 'pj-search') applyFilters();
  });

  window.addEventListener('resize', function () {
    var bar = el('pj-f-channel');
    if (bar) moveThumb(bar);
  });

  window.ParcelJourney = { show: show, reset: reset };
})();
