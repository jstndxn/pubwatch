/**
 * PUBWATCH WEB APP — public read-only page, Google Apps Script
 *
 * Serves the PubWatch page at a stable public URL, with data read live from
 * the PubWatch folder in the configured Drive folder. Every page load reflects whatever the
 * daily scheduled task has written, so new publications appear without anyone
 * touching this script.
 *
 * WHAT IS EXPOSED: publications (author name, title, venue, date, author
 * position) plus aggregate counts by role and area. The roster name list is
 * deliberately NOT exposed — only its totals.
 *
 * Deploy: Deploy > New deployment > Web app
 *   Execute as: Me
 *   Who has access: Anyone
 */

var FOLDER_ID = CONFIG.FOLDER_ID;
var AREAS = ['Affective Science', 'Cognition', 'Developmental', 'Neuroscience', 'Social Psychology'];
var ROLES = ['Faculty', 'Postdoc', 'Research Staff', 'PhD Student'];
var CACHE_SECONDS = 600; // 10 minutes — keeps Drive reads cheap

/** Serves the page. ALLOWALL is required for the Google Sites embed. */
function doGet(e) {
  // ?format=json returns the raw data instead of the page, handy for debugging
  // and if you ever want to feed something else from the same URL.
  if (e && e.parameter && e.parameter.format === 'json') {
    var out = ContentService.createTextOutput(JSON.stringify(buildData()));
    return out.setMimeType(ContentService.MimeType.JSON);
  }

  var t = HtmlService.createTemplateFromFile('Index');
  // Escaping "<" keeps a stray "</script>" inside any title from breaking the
  // page. Still valid JSON, so JSON.parse on the client is unaffected.
  t.payload = JSON.stringify(buildData()).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle(CONFIG.PAGE_TITLE || 'PubWatch Index')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Clears the cache so the next load re-reads Drive. Run manually if needed. */
function flushCache() {
  CacheService.getScriptCache().remove('pubwatch-payload');
}

function buildData() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('pubwatch-payload');
  if (hit) return JSON.parse(hit);

  var data = readDrive();

  // Cache in chunks if it ever outgrows the 100KB per-key cache limit.
  try {
    cache.put('pubwatch-payload', JSON.stringify(data), CACHE_SECONDS);
  } catch (err) {
    // Payload too large to cache. Serving uncached is fine, just slower.
  }
  return data;
}

function readDrive() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFiles();

  var rosterRaw = null;
  var batchFiles = [];

  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName();
    if (/roster/i.test(name)) {
      rosterRaw = f;
    } else if (/^pubwatch-\d{4}-\d{2}-\d{2}/.test(name)) {
      batchFiles.push({ name: name, file: f });
    }
  }

  // Chronological, so the oldest sighting of a publication wins on dedupe.
  batchFiles.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

  // ---- roster: used for aggregates and to attach role/area to each author ----
  var byName = {};
  var byRole = {};
  var byArea = {};
  var byDay = [];
  var rosterTotal = 0;

  ROLES.forEach(function (r) { byRole[r] = 0; });
  AREAS.forEach(function (a) { byArea[a] = 0; });
  byArea['Unassigned'] = 0;

  if (rosterRaw) {
    var roster = safeParse(rosterRaw);
    var people = (roster && roster.people) || [];
    rosterTotal = people.length;

    people.forEach(function (p) {
      byName[p.name] = { role: p.role || '', area: p.area || '', day: p.day || 0 };
      if (byRole[p.role] !== undefined) byRole[p.role]++;
      if (byArea[p.area] !== undefined) byArea[p.area]++; else byArea['Unassigned']++;
    });

    AREAS.forEach(function (area, i) {
      var day = i + 1;
      byDay.push({
        day: day,
        weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][i],
        area: area,
        count: people.filter(function (p) { return p.day === day; }).length
      });
    });
  }

  // ---- batches: publications and coverage ----
  var pubs = [];
  var runs = [];
  var checked = {};
  var checkedCount = 0;

  batchFiles.forEach(function (b) {
    var batch = safeParse(b.file);
    if (!batch) return;

    var when = batch.run_date || b.name.substring(9, 19);
    runs.push(when);

    (batch.people_checked || []).forEach(function (n) {
      if (!checked[n]) { checked[n] = true; checkedCount++; }
    });

    (batch.publications || []).forEach(function (p) {
      var info = byName[p.person] || {};
      if (!checked[p.person]) { checked[p.person] = true; checkedCount++; }
      pubs.push({
        person: p.person || '',
        role: info.role || p.role || '',
        area: info.area || p.area || '',
        title: p.title || '',
        venue: p.venue || '',
        date: p.date || '',
        type: p.type || '',
        position: p.position || null,
        authors_total: p.authors_total || null,
        coauthors: p.coauthors || '',
        url: p.url || '',
        first_seen: when
      });
    });
  });

  // Dedupe on author + normalised title.
  var seen = {};
  pubs = pubs.filter(function (p) {
    var k = p.person + '|' + String(p.title).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });

  return {
    generated: new Date().toISOString(),
    roster_total: rosterTotal,
    checked_count: checkedCount,
    by_role: byRole,
    by_area: byArea,
    by_day: byDay,
    runs: runs,
    last_run: runs.length ? runs[runs.length - 1] : '',
    publications: pubs
    // Note: no roster name list here, by design.
  };
}

/**
 * Reads a Drive file as JSON. Handles both the plain .json files the daily task
 * writes and, defensively, Google Docs conversions.
 */
function safeParse(file) {
  try {
    var text;
    var mime = file.getMimeType();
    if (mime === MimeType.GOOGLE_DOCS) {
      text = DocumentApp.openById(file.getId()).getBody().getText();
    } else {
      text = file.getBlob().getDataAsString('UTF-8');
    }
    // Strip markdown escaping if the file was ever round-tripped through an
    // extractor that adds it. Harmless on clean files.
    text = text.replace(/\\([_\[\]&~*#`>|+.!(){}=-])/g, '$1');
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}
