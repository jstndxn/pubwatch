/**
 * PHD METRICS COLLECTOR — Crossref edition
 *
 * Replaces the OpenAlex version. Reachability test of 4 Sep 2026:
 *   OpenAlex   429,429  — hard-blocked from Google's shared egress IPs
 *   Crossref   200,200  — clean
 * No amount of pacing fixed OpenAlex, so the source changed rather than the
 * retry logic.
 *
 * WHY IT QUERIES ADVISORS, NOT STUDENTS
 * Crossref has no author IDs and its affiliation data is sparse — only 3 of 17
 * matched records carried any affiliation for one test student. So "is this
 * the right person?" cannot be answered from a student-name search. A search
 * for one student returned 49 name matches of which only 4 were theirs; the rest
 * are a Singapore politics author.
 *
 * The reliable signal is co-authorship with the advisor. So the crawl walks
 * each advisor's publication list once and finds their students inside it.
 * That is both cheaper (~35 requests instead of 68) and self-verifying.
 *
 * WHAT THIS MEASURES, PRECISELY
 * Work co-authored with the student's listed advisor, 2020 onward. A student's
 * independent paper without their advisor is NOT counted in the verified
 * figures — it appears separately as `unverified_namematch` so the gap is
 * visible rather than silent.
 *
 * SETUP
 *   1. Replace the contents of Metrics.gs with this file.
 *   2. Run `runFullCrawl` once by hand.
 *   3. Run `installNightlyTrigger` once.
 */

var CFG = {
  FOLDER_ID: CONFIG.FOLDER_ID,
  WINDOW_START: 2020,
  MAILTO: CONFIG.MAILTO,
  PARTIAL: '_phdmetrics-partial.json',
  OVERRIDES: 'phdmetrics-overrides.json',
  REVIEW: 'phdmetrics-review.json',
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,
  ROWS: 1000,          // one relevance-ranked page; see crossrefAuthorWorks_
  PACE_MS: 250,
  MEGA_AUTHORS: 20     // above this, a paper is consortium work; see metricsFrom_
};

/**
 * Students who publish under a different name than the directory records.
 *
 * Found while verifying ORCIDs, and it matters: without these the matcher
 * cannot place the student in the author list, so author position and
 * first-author counts come back as zero even though the ORCID correctly
 * returns their papers.
 *
 *   a short first name on the roster vs the full legal name in the byline
 *   a middle name used as the published first name
 *   a FORMER SURNAME, which defeats both the ORCID and the name search
 *   a surname the roster and the publisher spell differently
 *
 * Add to this map whenever an ORCID returns work the matcher cannot place.
 */
var ALIASES = {
  // 'Roster Name': ['Published Name', 'Another Form'],
  //
  // Real examples encountered, anonymised:
  //   a student recorded by a short form publishes under their full legal
  //     first name, e.g. "Izzy X" publishes as "Isabella X"
  //   a student publishes under a middle name, e.g. "Jerome Y" is printed as
  //     "Simon Jerome Y"
  //   a student publishes under a FORMER SURNAME, so neither their ORCID nor
  //     any search on the roster name finds anything
  //   the roster and the publisher disagree on a surname spelling, and one of
  //     them is simply wrong
  //
  // Symptom that you need an entry here: an identifier lookup returns the
  // right papers but pubs_position_unknown is above zero, meaning the matcher
  // could not place the person in the byline.
};

/** Every name form a person might be published under, canonical first. */
function nameForms_(person) {
  var extra = ALIASES[person] || [];
  return [person].concat(extra);
}

/** Directory shorthand -> the fuller form Crossref indexes. */
var FORMAL = {
  // 'Directory Shorthand': 'Form Crossref Indexes',
  //
  // Departmental directories record nicknames; bibliographic databases record
  // the published form. Without this map, advisor resolution fails outright:
  // a search for the short form returned 12 works where the full form
  // returned 49, and the student matching built on top of it found nothing.
  //
  // e.g. 'Mike Frank': 'Michael Frank', 'Russ Poldrack': 'Russell Poldrack'
};

/* ============================ entry points ============================ */

var TRIGGER_DAY_OF_MONTH = 1;   // run on the 1st
var TRIGGER_HOUR = 3;           // at ~3am local

/**
 * Installs the monthly crawl. Safe to run repeatedly — it removes any existing
 * trigger for this script first, so you cannot end up with two.
 *
 * Monthly suits the data: citation counts and publication records move slowly,
 * and the whole crawl is ~35 Crossref requests, so there is nothing to gain
 * from checking more often.
 */
function installMonthlyTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'runScheduledCrawl' || h === 'runNightly' || h === 'runFullCrawl') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  ScriptApp.newTrigger('runScheduledCrawl')
    .timeBased()
    .onMonthDay(TRIGGER_DAY_OF_MONTH)
    .atHour(TRIGGER_HOUR)
    .create();
  Logger.log('Monthly crawl installed: day ' + TRIGGER_DAY_OF_MONTH + ' of each month, ~' +
    TRIGGER_HOUR + ':00 local.' + (removed ? ' Removed ' + removed + ' previous trigger(s).' : ''));
}

/** Kept so the older instructions still do the right thing. */
function installNightlyTrigger() {
  Logger.log('Note: the schedule is monthly now, not nightly. Installing the monthly trigger.');
  installMonthlyTrigger();
}

/** Lists what is actually scheduled, so you can confirm rather than assume. */
function showTriggers() {
  var ts = ScriptApp.getProjectTriggers();
  if (!ts.length) { Logger.log('No triggers installed.'); return; }
  ts.forEach(function (t) {
    Logger.log(t.getHandlerFunction() + ' — ' + t.getEventType() +
      ' (' + t.getTriggerSource() + ')');
  });
}

/** What the schedule calls. The full crawl is cheap enough to just redo. */
function runScheduledCrawl() { runFullCrawl(); }

/** Older alias. */
function runNightly() { runFullCrawl(); }

function resetCrawl() {
  var f = fileByName_(CFG.PARTIAL);
  if (f) f.setTrashed(true);
  Logger.log('Progress cleared.');
}

function showProgress() {
  var f = fileByName_(CFG.PARTIAL);
  if (!f) { Logger.log('No partial file. Next run starts from the first advisor.'); return; }
  try {
    var st = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
    Logger.log('Advisor ' + st.cursor + ' of ' + st.advisors.length +
      '; ' + Object.keys(st.byStudent).length + ' students have data so far.');
  } catch (e) {
    Logger.log('Partial file unreadable: ' + e);
  }
}

function resumeCrawl() { runFullCrawl(); }

/* ============================ the crawl ============================ */

function runFullCrawl() {
  var t0 = Date.now();
  var state = loadState_();

  // Pass 0 — anyone with a hand-supplied ORCID. Definitive; skips the guesswork.
  orcidPass_(state);

  // Pass 1 — walk each advisor's corpus. High confidence by construction.
  while (state.cursor < state.advisors.length) {
    if (Date.now() - t0 > CFG.MAX_RUNTIME_MS) {
      saveState_(state);
      scheduleContinuation_();
      Logger.log('Paused at advisor ' + state.cursor + '/' + state.advisors.length + '; continuing shortly.');
      return;
    }
    var advisor = state.advisors[state.cursor];
    try {
      processAdvisor_(advisor, state);
    } catch (err) {
      Logger.log('advisor ' + advisor + ' failed: ' + err);
      state.failedAdvisors.push(advisor);
    }
    state.cursor++;
  }

  // Pass 2 — students with nothing from their advisor. Spot-checking found real
  // journal papers being missed this way: one student had a PNAS paper and
  // another four articles, none with their advisor. Advisor-only
  // coverage was silently discarding genuine output, so search by student name
  // and hold the results separately for confirmation rather than counting them.
  if (!state.namePass) state.namePass = { cursor: 0, todo: null };
  if (!state.namePass.todo) {
    state.namePass.todo = state.students
      .filter(function (s) { return !state.byStudent[s.name]; })
      .map(function (s) { return s.name; });
    Logger.log('Pass 2: name search for ' + state.namePass.todo.length + ' students with no advisor work.');
  }

  while (state.namePass.cursor < state.namePass.todo.length) {
    if (Date.now() - t0 > CFG.MAX_RUNTIME_MS) {
      saveState_(state);
      scheduleContinuation_();
      Logger.log('Paused in pass 2 at ' + state.namePass.cursor + '/' + state.namePass.todo.length);
      return;
    }
    var nm = state.namePass.todo[state.namePass.cursor];
    try {
      nameSearchStudent_(nm, state);
    } catch (err) {
      Logger.log('name search ' + nm + ' failed: ' + err);
    }
    state.namePass.cursor++;
  }

  finalize_(state);
}

/**
 * Fetches one advisor's 2020+ corpus and credits every roster student found
 * inside it. One request per advisor, occasionally two for very prolific labs.
 */
function processAdvisor_(advisorLabel, state) {
  var t1 = Date.now();
  var query = FORMAL[advisorLabel] || advisorLabel;
  var items = crossrefAuthorWorks_(query);

  if (items.__failed) {
    state.failedAdvisors.push(advisorLabel);
    Logger.log('advisor ' + advisorLabel + ' — request failed, will retry next run');
    return;
  }

  // Keep only works the advisor is genuinely on.
  //
  // Surname alone is nowhere near enough. Matching just "Wagner" against a
  // relevance-ranked query returned 948 works — every paper by any Wagner in
  // the corpus. Require the given name to agree too, using the same rule as
  // student matching (exact, initial, or prefix).
  var advFull = FORMAL[advisorLabel] || advisorLabel;
  var advLast = lastName_(advisorLabel);
  var corpus = items.filter(function (it) {
    return authorSlot_(it.author || [], advFull) !== -1;
  });

  var students = state.students.filter(function (s) {
    return (s.advisor || '').split(',').some(function (a) {
      return lastName_(a) === advLast;
    });
  });

  students.forEach(function (s) {
    // An ORCID result is complete and definitive; do not dilute it.
    if (state.orcidResolved && state.orcidResolved[s.name]) return;

    var rows = [];
    corpus.forEach(function (it) {
      var slot = authorSlot_(it.author || [], s.name);
      if (slot === -1) return;
      rows.push({ it: it, slot: slot, n: (it.author || []).length });
    });
    if (!rows.length) return;

    var m = metricsFrom_(rows);
    m.name = s.name;
    m.confidence = 'high';
    m.resolution = 'advisor-corpus';
    m.source = 'crossref';
    m.notes = rows.length + ' work(s) co-authored with ' + advisorLabel + '.';
    m.measured_at = new Date().toISOString();

    // A student with two advisors gets both labs merged.
    var prior = state.byStudent[s.name];
    state.byStudent[s.name] = prior ? mergeMetrics_(prior, m) : m;
  });

  Logger.log('advisor ' + (state.cursor + 1) + '/' + state.advisors.length + ' ' + advisorLabel +
    ' — ' + corpus.length + ' of ' + items.length + ' scanned are genuinely theirs, ' +
    students.length + ' students, ' + Math.round((Date.now() - t1) / 1000) + 's');
}

/**
 * Pass 0: students with a hand-supplied ORCID in an overrides file.
 *
 * This is the only genuinely definitive identifier available. Crossref exposes
 * a hard `orcid:` filter, so the result is that person's work and nobody
 * else's — no advisor requirement, no namesake risk, and it picks up
 * independent papers the other two passes cannot see. In testing, one
 * student's ORCID returned exactly 11 works where a name search had returned
 * 100 unrankable candidates.
 *
 * Supply them in phdmetrics-overrides-*.json as:
 *   "confirmed": { "Roster Name": "0000-0000-0000-0000" }
 */
function orcidPass_(state) {
  var overrides = loadOverrides_();
  state.orcidResolved = state.orcidResolved || {};

  state.students.forEach(function (s) {
    var v = overrides[s.name];
    if (!v) return;
    if (state.byStudent[s.name]) return;

    var items, how, ident;

    // An explicit DOI list. The most reliable option after ORCID, and the only
    // fallback when neither works — see crossrefWorksByDois_ for why this
    // exists.
    if (v && typeof v === 'object' && v.dois && v.dois.length) {
      items = crossrefWorksByDois_(v.dois);
      how = 'doi-list';
      ident = v.dois.length + ' DOIs';
    } else if (typeof v === 'string') {
      var orcid = String(v).replace(/^https?:\/\/orcid\.org\//i, '').trim();
      if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(orcid)) return;  // 'accept' handled later
      items = crossrefWorksByOrcid_(orcid);
      how = 'orcid';
      ident = orcid;
    } else {
      return;
    }

    if (items.__failed) {
      Logger.log('  ' + how + ' ' + s.name + ' — lookup failed, will retry next run');
      return;
    }

    var rows = items.map(function (it) {
      return { it: it, slot: authorSlot_(it.author || [], s.name), n: (it.author || []).length };
    }).filter(function (r) { return r.slot !== -1; });

    // Trust the ORCID over the name match: if the byline spelling differs,
    // still count the work, just without a position.
    var missed = items.length - rows.length;

    var m = rows.length ? metricsFrom_(rows) : metricsFrom_([]);
    // The ORCID is authoritative on how many works exist. Positional counts
    // only cover the ones whose byline could be placed, so keep the two
    // separate rather than letting pubs_total quietly under-report.
    m.pubs_total = items.length;
    m.pubs_position_unknown = missed;
    m.name = s.name;
    m.confidence = 'confirmed';
    m.resolution = how;
    m.source = 'crossref';
    if (how === 'orcid') m.orcid = ident;
    m.notes = items.length + ' work(s) via ' + how + ' (' + ident + ')' +
      (missed ? '; ' + missed + ' had a byline this matcher could not place, so their author ' +
        'position is not counted' : '') + '. Explicit identifier — no namesake risk.';
    m.measured_at = new Date().toISOString();

    state.byStudent[s.name] = m;
    state.orcidResolved[s.name] = 1;
    Logger.log('  ' + how + ' ' + s.name + ' — ' + items.length + ' work(s), ' +
      m.pubs_first + ' first-author, ' + m.citations + ' cites');
  });

  var n = Object.keys(state.orcidResolved).length;
  if (n) Logger.log('Pass 0: ' + n + ' student(s) resolved by explicit identifier.');
}

/**
 * Fetches specific works by DOI. The fallback of last resort, and necessary.
 *
 * WHY THIS EXISTS: Crossref's query.author is a relevance ranking, and its
 * recall cannot be trusted. One student is second author on a Nature Human
 * Behaviour paper with 146 Crossref citations, their name printed plainly in
 * the byline. Searching that name and scanning 300 records never returned it.
 * The paper is in Crossref; the search simply did not rank it. So a name
 * search failing to find work is NOT evidence the work does not exist.
 *
 * Use when a student has no ORCID, or has one that Crossref holds no records
 * for. Supply DOIs in an overrides file as:
 *   "confirmed": { "Roster Name": { "dois": ["10.xxxx/journal.id"] } }
 */
function crossrefWorksByDois_(dois) {
  var out = [], failures = 0;
  for (var i = 0; i < dois.length; i++) {
    var doi = String(dois[i]).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
    var url = 'https://api.crossref.org/works/' + encodeURIComponent(doi) +
      '?mailto=' + CFG.MAILTO;
    var got = null;
    for (var a = 0; a < 3; a++) {
      Utilities.sleep(a === 0 ? CFG.PACE_MS : 700);
      try {
        var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        if (r.getResponseCode() === 404) { got = 'missing'; break; }
        if (r.getResponseCode() !== 200) continue;
        got = JSON.parse(r.getContentText()).message || null;
        break;
      } catch (e) { /* retry */ }
    }
    if (got === 'missing') {
      Logger.log('    DOI not in Crossref: ' + doi);
    } else if (got) {
      out.push(got);
    } else {
      failures++;
    }
  }
  if (!out.length && failures) return { __failed: true };
  return out;
}

function crossrefWorksByOrcid_(orcid) {
  var url = 'https://api.crossref.org/works' +
    '?filter=orcid:' + encodeURIComponent(orcid) +
    ',from-pub-date:' + CFG.WINDOW_START + '-01-01' +
    '&rows=' + CFG.ROWS +
    '&select=title,author,issued,type,container-title,is-referenced-by-count,DOI' +
    '&mailto=' + CFG.MAILTO;
  for (var i = 0; i < 3; i++) {
    Utilities.sleep(i === 0 ? CFG.PACE_MS : 800);
    try {
      var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) continue;
      var msg = JSON.parse(r.getContentText()).message || {};
      return msg.items || [];
    } catch (e) { /* retry */ }
  }
  return { __failed: true };
}

/**
 * Pass 2: search Crossref by the student's own name.
 *
 * These results are NOT folded into the headline figures. Without author IDs a
 * name match is a hypothesis, not a fact: one student's name returned a
 * politics author in another country alongside the real person. So the works are recorded under
 * `namematch` for confirmation in the review tool, and graded by whether any
 * other roster member appears as a coauthor, which is a genuine institutional signal.
 */
function nameSearchStudent_(studentName, state) {
  var items = crossrefAuthorWorks_(studentName);
  if (items.__failed) return;

  var mine = [];
  items.forEach(function (it) {
    var slot = authorSlot_(it.author || [], studentName);
    if (slot === -1) return;
    mine.push({ it: it, slot: slot, n: (it.author || []).length });
  });
  if (!mine.length) return;

  // Does anyone else from the department appear alongside them? Requires a
  // full name match — see rosterIndex in loadState_ for why.
  var idx = state.rosterIndex || {};
  var myLast = lastName_(studentName);
  mine.forEach(function (r) {
    var who = null;
    (r.it.author || []).forEach(function (a, i) {
      if (who || i === r.slot) return;
      var l = lastName_(a.family);
      if (l === myLast || !idx[l]) return;
      var g = normalize_(a.given).split(' ')[0] || '';
      if (!g) return;
      var match = idx[l].some(function (fn) {
        return g === fn || (g.length === 1 && g.charAt(0) === fn.charAt(0)) ||
               fn.indexOf(g) === 0 || g.indexOf(fn) === 0;
      });
      if (match) who = (a.given || '') + ' ' + (a.family || '');
    });
    r.rosterCoauthor = who;
  });

  /**
   * Second corroboration signal: the home institution on the student's own
   * authorship entry.
   *
   * Measured coverage, 4 Sep 2026 — thin, and useless exactly where it is most
   * needed. Of the students with the worst name collisions, ZERO carry a
   * institution-tagged record. Across four students with the worst name
   * collisions the counts were 0 of 86 matches, 0 of 116, 0 of 119 and 0 of 52.
   * Crossref affiliations are publisher-supplied and usually missing.
   *
   * It also produces false positives. One student's single institution-tagged
   * record was a materials-science paper on perovskite lattice dynamics — a
   * different person of the same name at the same university.
   *
   * So this cannot be a filter. It is worth keeping as an extra signal because
   * it does recover real work: one student picked up 4 papers in their own
   * subfield this way, and scored zero without it. Both signals stay flagged for review
   * rather than being counted silently.
   */
  mine.forEach(function (r) {
    var me = (r.it.author || [])[r.slot] || {};
    r.institutionAffil = (me.affiliation || []).some(function (x) {
      return CONFIG.INSTITUTION_RE.test(x.name || '');
    });
  });

  var corroborated = mine.filter(function (r) { return r.rosterCoauthor || r.institutionAffil; });

  /**
   * Metrics are computed ONLY over corroborated works. Running them across
   * every name match produced nonsense: 306 papers attributed to one student.
   * The uncorroborated remainder is reported as a count for context and shown
   * in the review tool, but never as a number about this person.
   */
  var m = corroborated.length ? metricsFrom_(corroborated) : {
    pubs_total: null, pubs_first: null, pubs_second: null, pubs_third_of_three: null,
    preprints: null, peer_reviewed: null, citations: null, h_index: null, i10_index: null,
    coauthors_distinct: null, citations_basis: 'window', dois: []
  };

  m.name = studentName;
  m.confidence = corroborated.length ? 'medium' : 'low';
  m.resolution = 'name-search (unconfirmed)';
  m.source = 'crossref';
  m.unconfirmed = true;
  m.name_matches_total = mine.length;
  m.roster_coauthor_works = corroborated.filter(function (r) { return r.rosterCoauthor; }).length;
  m.institution_affiliated_works = corroborated.filter(function (r) { return r.institutionAffil; }).length;
  m.notes = corroborated.length
    ? corroborated.length + ' of ' + mine.length + ' name matches are corroborated (' +
      m.roster_coauthor_works + ' by a named roster coauthor, ' + m.institution_affiliated_works +
      ' by a home-institution affiliation in the record) and are counted here provisionally. ' +
      'Confirm before relying on them.'
    : mine.length + ' work(s) match this name, none corroborated by a roster coauthor or a ' +
      'institutional affiliation, so no figures are claimed. Could be theirs, could be a namesake — ' +
      'needs a human or an ORCID.';
  m.measured_at = new Date().toISOString();

  // Show corroborated works first; they are the ones worth judging.
  // Cap the sample. The review file reached 100KB with 12 works each, which
  // risks the same truncated-read failure the snapshot just hit. Six
  // corroboration-first examples are enough to make a judgement.
  var ordered = corroborated.concat(mine.filter(function (r) { return !r.rosterCoauthor; }));
  m.works_sample = ordered.slice(0, 6).map(function (r) {
    return {
      title: ((r.it.title || [])[0] || '').slice(0, 100),
      year: (((r.it.issued || {})['date-parts'] || [[]])[0] || [])[0] || null,
      venue: ((r.it['container-title'] || [])[0] || ''),
      position: r.slot + 1,
      of: r.n,
      cites: r.it['is-referenced-by-count'] || 0,
      doi: r.it.DOI,
      roster_coauthor: r.rosterCoauthor || null,
      authors: (r.it.author || []).slice(0, 6).map(function (a) {
        return ((a.given || '').charAt(0) ? a.given.charAt(0) + '. ' : '') + (a.family || '');
      }).join(', ')
    };
  });

  state.nameMatches[studentName] = m;
  var why = [];
  if (m.roster_coauthor_works) {
    var eg = corroborated.filter(function (r) { return r.rosterCoauthor; })[0];
    why.push(m.roster_coauthor_works + ' via coauthor, e.g. ' + eg.rosterCoauthor);
  }
  if (m.institution_affiliated_works) why.push(m.institution_affiliated_works + ' via institutional affiliation');
  Logger.log('  name search ' + studentName + ' — ' + mine.length + ' match(es), ' +
    corroborated.length + ' corroborated' + (why.length ? ' (' + why.join('; ') + ')' : ''));
}

/* ============================ Crossref ============================ */

/**
 * Fetches an author's 2020+ works: ONE relevance-ranked page, no cursor.
 *
 * Do not add `cursor=*` here. Crossref's cursor is deep-paging mode and it
 * discards relevance ranking, returning matches in index order instead. With
 * the cursor in place, "Anthony Wagner" yielded 3 genuine works out of 1000
 * scanned; without it, the same query and the same matching logic yield 63,
 * because the real author sorts to the top. The fuzzy author query has no
 * finite result set, so paging deeper only adds noise.
 */
function crossrefAuthorWorks_(authorName) {
  var url = 'https://api.crossref.org/works' +
    '?query.author=' + encodeURIComponent(authorName) +
    '&filter=from-pub-date:' + CFG.WINDOW_START + '-01-01' +
    '&rows=' + CFG.ROWS +
    '&select=title,author,issued,type,container-title,is-referenced-by-count,DOI' +
    '&mailto=' + CFG.MAILTO;

  for (var i = 0; i < 3; i++) {
    Utilities.sleep(i === 0 ? CFG.PACE_MS : 800);
    try {
      var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) continue;
      var msg = JSON.parse(r.getContentText()).message || {};
      return msg.items || [];
    } catch (e) { /* retry */ }
  }
  return { __failed: true };
}

/**
 * Position of a person in an author list, or -1.
 *
 * Surnames are compared on their FINAL token, not the whole string. Hyphenated
 * and multi-part surnames normalise to several words — "Smith-Jones" becomes
 * "smith jones" — and comparing that against the person's last token silently
 * matched nothing. One hyphenated advisor returned 2 works out of 1000 where
 * comparable advisors returned 20 to 200. The same bug hits every hyphenated
 * surname, every two-word surname, and every apostrophe.
 */
function authorSlot_(authors, personName) {
  var forms = nameForms_(personName);
  for (var f = 0; f < forms.length; f++) {
    var hit = slotForForm_(authors, forms[f]);
    if (hit !== -1) return hit;
  }
  return -1;
}

function slotForForm_(authors, personName) {
  var ln = lastName_(personName), fn = firstName_(personName);
  var lnFull = normalize_(surnamePart_(personName));

  for (var i = 0; i < authors.length; i++) {
    var famFull = normalize_(authors[i].family);
    var famLast = lastName_(authors[i].family);
    if (famLast !== ln && famFull !== lnFull) continue;

    // Given names may be "Simon Jerome" against a form of "Jerome", so check
    // every token, not just the first.
    var givens = normalize_(authors[i].given).split(' ').filter(Boolean);
    for (var g2 = 0; g2 < givens.length; g2++) {
      var g = givens[g2];
      if (g === fn || (g.length === 1 && g.charAt(0) === fn.charAt(0)) ||
          fn.indexOf(g) === 0 || g.indexOf(fn) === 0) return i;
    }
  }
  return -1;
}

/** Everything after the first token, i.e. the surname including any particles. */
function surnamePart_(fullName) {
  var p = nameParts_(fullName);
  return p.length > 1 ? p.slice(1).join(' ') : (p[0] || '');
}

function metricsFrom_(rows) {
  var cites = rows.map(function (r) { return r.it['is-referenced-by-count'] || 0; })
    .sort(function (a, b) { return b - a; });
  var h = 0;
  cites.forEach(function (c, i) { if (c >= i + 1) h = i + 1; });

  var co = {}, venues = {};
  rows.forEach(function (r) {
    (r.it.author || []).forEach(function (a, i) {
      if (i === r.slot) return;
      var k = normalize_((a.given || '') + ' ' + (a.family || ''));
      if (k.trim()) co[k] = 1;
    });
    var v = (r.it['container-title'] || [])[0];
    if (v) venues[v] = (venues[v] || 0) + 1;
  });

  var preprints = rows.filter(function (r) {
    return r.it.type === 'posted-content';
  }).length;

  /**
   * Consortium papers are reported separately.
   *
   * One student is author 18 of 258 on a megastudy with 251 citations.
   * Counting those 251 the same way as a three-author paper's would put them
   * near the top of the citation column on a single consortium contribution. Big-team science is
   * real work and is not excluded — but the headline figure should not be
   * driven by it invisibly, so both totals are recorded.
   */
  var mega = rows.filter(function (r) { return r.n > CFG.MEGA_AUTHORS; });
  var solo = rows.filter(function (r) { return r.n <= CFG.MEGA_AUTHORS; });
  var soloCites = solo.map(function (r) { return r.it['is-referenced-by-count'] || 0; })
    .sort(function (a, b) { return b - a; });
  var hSolo = 0;
  soloCites.forEach(function (c, i) { if (c >= i + 1) hSolo = i + 1; });

  return {
    pubs_total: rows.length,
    mega_authored_works: mega.length,
    citations_excl_mega: solo.reduce(function (a, r) { return a + (r.it['is-referenced-by-count'] || 0); }, 0),
    h_index_excl_mega: hSolo,
    pubs_first: rows.filter(function (r) { return r.slot === 0; }).length,
    pubs_second: rows.filter(function (r) { return r.slot === 1; }).length,
    pubs_third_of_three: rows.filter(function (r) { return r.slot === 2 && r.n === 3; }).length,
    preprints: preprints,
    peer_reviewed: rows.length - preprints,
    citations: rows.reduce(function (a, r) { return a + (r.it['is-referenced-by-count'] || 0); }, 0),
    h_index: h,
    i10_index: cites.filter(function (c) { return c >= 10; }).length,
    coauthors_distinct: Object.keys(co).length,
    venues: Object.keys(venues).slice(0, 8),
    citations_basis: 'window',
    dois: rows.slice(0, 10).map(function (r) { return r.it.DOI; })
  };
}

/** Students with two advisors appear in two corpora; combine without double counting. */
function mergeMetrics_(a, b) {
  var seen = {}, dois = [];
  (a.dois || []).concat(b.dois || []).forEach(function (d) {
    if (d && !seen[d]) { seen[d] = 1; dois.push(d); }
  });
  return {
    name: a.name,
    pubs_total: a.pubs_total + b.pubs_total,
    pubs_first: a.pubs_first + b.pubs_first,
    pubs_second: a.pubs_second + b.pubs_second,
    pubs_third_of_three: a.pubs_third_of_three + b.pubs_third_of_three,
    preprints: a.preprints + b.preprints,
    peer_reviewed: a.peer_reviewed + b.peer_reviewed,
    citations: a.citations + b.citations,
    h_index: Math.max(a.h_index, b.h_index),
    i10_index: a.i10_index + b.i10_index,
    coauthors_distinct: Math.max(a.coauthors_distinct, b.coauthors_distinct),
    venues: (a.venues || []).concat(b.venues || []).slice(0, 10),
    citations_basis: 'window',
    dois: dois,
    confidence: 'high',
    resolution: 'advisor-corpus (multiple advisors)',
    source: 'crossref',
    notes: a.notes + ' ' + b.notes,
    measured_at: b.measured_at
  };
}

/* ============================ state ============================ */

function loadState_() {
  var f = fileByName_(CFG.PARTIAL);
  if (f) {
    try {
      var st = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
      Logger.log('Resuming at advisor ' + st.cursor + '/' + st.advisors.length);
      return st;
    } catch (e) {
      var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
      try { f.setName('_BROKEN-' + stamp + '-' + CFG.PARTIAL); } catch (e2) {}
      Logger.log('WARNING: progress file unreadable (' + e + '); starting fresh.');
    }
  }

  var cohorts = readJsonFile_('phdmetrics-cohorts');
  if (!cohorts) throw new Error('phdmetrics-cohorts.json not found.');
  var students = cohorts.students || [];

  // Distinct advisors across the roster.
  var seen = {}, advisors = [];
  students.forEach(function (s) {
    (s.advisor || '').split(',').forEach(function (a) {
      a = a.trim();
      if (!a || seen[a]) return;
      seen[a] = 1;
      advisors.push(a);
    });
  });

  /**
   * Index of everyone in the department: surname -> list of given names.
   *
   * Surname alone is useless as a corroboration signal. The roster contains
   * Chen, Lee, Liu, Wu, Kim, Han, Miller, Anderson, Shah and Gupta, so any
   * paper with any common surname on it looked corroborated: one student
   * scored 67 of 150 and another 49 of 306. Given names are required.
   */
  var rosterIndex = {};
  function addPerson(n) {
    var ln = lastName_(n), fn = firstName_(n);
    if (!ln || !fn) return;
    if (!rosterIndex[ln]) rosterIndex[ln] = [];
    if (rosterIndex[ln].indexOf(fn) === -1) rosterIndex[ln].push(fn);
  }
  students.forEach(function (s) { addPerson(s.name); });
  advisors.forEach(addPerson);
  var wider = readJsonFile_('pubwatch-roster');
  if (wider && wider.people) wider.people.forEach(function (p) { addPerson(p.name); });

  Logger.log('Starting crawl: ' + advisors.length + ' advisors covering ' + students.length +
    ' students; ' + Object.keys(rosterIndex).length + ' roster surnames indexed with given names.');
  return {
    started: new Date().toISOString(),
    students: students,
    advisors: advisors,
    rosterIndex: rosterIndex,
    cursor: 0,
    byStudent: {},
    nameMatches: {},
    namePass: null,
    failedAdvisors: []
  };
}

function saveState_(state) {
  var body = JSON.stringify(state);
  try {
    var probe = JSON.parse(body);
    if (!probe.advisors || typeof probe.cursor !== 'number') throw new Error('shape');
  } catch (e) {
    Logger.log('WARNING: refusing to save an unparseable progress file.');
    return;
  }
  var tmp = CFG.PARTIAL + '.tmp';
  var old = fileByName_(tmp);
  if (old) old.setTrashed(true);
  folder_().createFile(tmp, body, MimeType.PLAIN_TEXT);
  var prev = fileByName_(CFG.PARTIAL);
  if (prev) prev.setTrashed(true);
  fileByName_(tmp).setName(CFG.PARTIAL);
}

function scheduleContinuation_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'continueCrawl') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('continueCrawl').timeBased().after(60 * 1000).create();
}

function continueCrawl() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'continueCrawl') ScriptApp.deleteTrigger(t);
  });
  runFullCrawl();
}

/* ============================ output ============================ */

function finalize_(state) {
  var overrides = loadOverrides_();
  var metrics = [], review = [];

  state.students.forEach(function (s) {
    var m = state.byStudent[s.name];

    if (m) {
      if (overrides.hasOwnProperty(s.name) && overrides[s.name] === null) {
        m.notes += ' Manually marked as having no record; kept measured data anyway.';
      }
      metrics.push(m);
      return;
    }

    var advisorFailed = (s.advisor || '').split(',').some(function (a) {
      return state.failedAdvisors.indexOf(a.trim()) > -1;
    });

    if (advisorFailed) {
      metrics.push({ name: s.name, confidence: 'unknown', source: 'crossref',
        notes: "Advisor's record could not be fetched this run. Not a finding.",
        measured_at: new Date().toISOString() });
      return;
    }

    // Pass 2 may have found work under the student's own name.
    var nm = state.nameMatches[s.name];

    if (nm) {
      // Has this been confirmed by hand in the review tool?
      var decision = overrides.hasOwnProperty(s.name) ? overrides[s.name] : undefined;

      if (decision === 'accept') {
        nm.confidence = 'confirmed';
        nm.unconfirmed = false;
        nm.resolution = 'name-search (confirmed by hand)';
        nm.notes = 'Manually confirmed as this student\'s work. ' + nm.notes;
        metrics.push(nm);
        return;
      }
      if (decision === null) {
        metrics.push({ name: s.name, confidence: 'confirmed-absent', source: 'crossref',
          pubs_total: 0, pubs_first: 0, pubs_second: 0, citations: 0, h_index: 0,
          notes: 'Name matches reviewed and rejected as belonging to someone else.',
          measured_at: new Date().toISOString() });
        return;
      }

      metrics.push(nm);   // unconfirmed; the dashboard shows it but will not rank it
      review.push({
        name: s.name, advisor: s.advisor || '', area: s.area || '',
        reason: nm.works_sample.length + ' work(s) found under this name, none co-authored with ' +
                (s.advisor || 'their advisor') + '. ' + nm.roster_coauthor_works +
                ' include another roster member. Confirm whether these are theirs.',
        works: nm.works_sample,
        candidates: []
      });
      return;
    }

    metrics.push({
      name: s.name, confidence: 'none', source: 'crossref',
      pubs_total: 0, pubs_first: 0, pubs_second: 0, pubs_third_of_three: 0,
      preprints: 0, peer_reviewed: 0, citations: 0, h_index: 0, i10_index: 0,
      coauthors_distinct: 0, citations_basis: 'window',
      notes: 'Nothing found in Crossref either with ' + (s.advisor || 'an advisor') +
             ' or under this name since ' + CFG.WINDOW_START + '.',
      measured_at: new Date().toISOString()
    });

    if (s.cohort && s.cohort <= 2023) {
      review.push({ name: s.name, advisor: s.advisor || '', area: s.area || '',
        reason: 'Cohort ' + s.cohort + ' with nothing found by either method. May publish in ' +
                'venues Crossref does not index, such as CogSci proceedings.',
        works: [], candidates: [] });
    }
  });

  /**
   * Strip candidate work lists out of the snapshot before writing.
   *
   * They belong in the review file, and carrying them in both places pushed
   * the snapshot from 42KB to 154KB — past the point where the dashboard could
   * read it back in one piece, which broke the artifact with a parse error.
   * The snapshot is the metrics; the review file is the evidence.
   */
  var lean = metrics.map(function (m) {
    if (!m.works_sample) return m;
    var copy = {};
    Object.keys(m).forEach(function (k) { if (k !== 'works_sample') copy[k] = m[k]; });
    copy.works_sample_count = m.works_sample.length;
    copy.works_sample_in = CFG.REVIEW;
    return copy;
  });

  writeSnapshot_(lean, review, 'apps-script/crossref advisor-corpus');

  var partial = fileByName_(CFG.PARTIAL);
  if (partial) partial.setTrashed(true);

  var counts = {};
  metrics.forEach(function (m) { counts[m.confidence] = (counts[m.confidence] || 0) + 1; });
  Logger.log('Crawl complete. ' + JSON.stringify(counts) +
    (state.failedAdvisors.length ? ' Failed advisors: ' + state.failedAdvisors.join(', ') : ''));
}

function writeSnapshot_(metrics, review, engine) {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var counts = {};
  metrics.forEach(function (r) { counts[r.confidence || 'none'] = (counts[r.confidence || 'none'] || 0) + 1; });

  writeFile_('phdmetrics-' + today + '.json', JSON.stringify({
    schema: 'phdmetrics-snapshot/v1',
    measured: today,
    window: { from: CFG.WINDOW_START, to: new Date().getFullYear() },
    engine: engine,
    resolution_counts: counts,
    method: 'Counts work co-authored with the student\'s listed advisor, from Crossref, ' +
            CFG.WINDOW_START + ' onward. Crossref has no author identifiers and sparse ' +
            'affiliations, so advisor co-authorship is the only reliable way to tell a ' +
            'roster student from a namesake.',
    /**
     * No double quotes in any string written to these files.
     *
     * A literal quote gets JSON-escaped to \" on write, and Drive's text
     * extraction then escapes the backslash again on read, yielding \\" —
     * invalid JSON. The dashboard failed to parse a perfectly complete 60KB
     * file solely because this sentence had quotes around the word unknown.
     * Use single quotes or none.
     */
    caveat: 'These figures are a FLOOR, not a complete publication record. Three known gaps: ' +
            '(1) work published without the listed advisor is not counted; ' +
            '(2) CogSci and similar conference proceedings are largely not DOI-registered, so ' +
            'Crossref cannot see them, which materially undercounts Cognition and Developmental ' +
            'students; for example Martinez, Frank and Haber CogSci 2024 is missing; ' +
            '(3) a confidence of unknown means the advisor lookup failed and must never be ' +
            'read as zero.',
    known_gaps: ['no-advisor work', 'CogSci proceedings absent from Crossref'],
    metrics: metrics
  }, null, 1));

  if (review && review.length) {
    writeFile_(CFG.REVIEW, JSON.stringify({
      schema: 'phdmetrics-review/v1',
      generated: today,
      note: 'Students with no advisor-co-authored work found. For recent cohorts this is ' +
            'expected. For senior students it may mean they publish outside the advisor ' +
            'relationship, which this method cannot see.',
      queue: review
    }, null, 1));
  }
}

/* ============================ plumbing ============================ */

function loadOverrides_() {
  var files = [], it = folder_().getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf('phdmetrics-overrides') === 0) files.push(f);
  }
  files.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });
  var merged = {};
  files.forEach(function (f) {
    try {
      var t = f.getBlob().getDataAsString('UTF-8').replace(/\\([_\[\]&~*#`>|+.!(){}=-])/g, '$1');
      var j = JSON.parse(t), map = j.confirmed || j;
      Object.keys(map).forEach(function (k) {
        merged[k] = (map[k] === 'none' || map[k] === null) ? null : map[k];
      });
    } catch (e) {}
  });
  return merged;
}

function folder_() { return DriveApp.getFolderById(CFG.FOLDER_ID); }

function fileByName_(name) {
  var it = folder_().getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function writeFile_(name, body) {
  var f = fileByName_(name);
  if (f) f.setContent(body);
  else folder_().createFile(name, body, MimeType.PLAIN_TEXT);
}

function readJsonFile_(nameOrPrefix) {
  var f = fileByName_(nameOrPrefix) || fileByName_(nameOrPrefix + '.json');
  if (!f) {
    var it = folder_().getFiles();
    while (it.hasNext()) {
      var c = it.next();
      if (c.getName().indexOf(nameOrPrefix) === 0) { f = c; break; }
    }
  }
  if (!f) return null;
  try {
    var t = f.getBlob().getDataAsString('UTF-8').replace(/\\([_\[\]&~*#`>|+.!(){}=-])/g, '$1');
    return JSON.parse(t);
  } catch (e) { return null; }
}

function normalize_(s) {
  return (s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function nameParts_(s) { return normalize_(s).split(' ').filter(Boolean); }
function lastName_(s) { var p = nameParts_(s); return p[p.length - 1] || ''; }
function firstName_(s) { var p = nameParts_(s); return p[0] || ''; }
