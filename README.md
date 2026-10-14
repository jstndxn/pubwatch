# PubWatch

Tracks publications for an academic department from Crossref, using Google Apps Script and Google Drive. No server, no database, no API keys.

It does two things: watches for new publications by people on a roster, and assembles per-person publication metrics over a rolling window.

**The honest summary: author name matching does not work, and this repository is mostly a record of how it fails.** The code is usable, but the [methodology notes](docs/METHODOLOGY.md) are the part worth your time.

---

## Why this exists

Bibliographic APIs are built to answer "who wrote this paper?" They are poor at answering "what did this person write?" — which is the question any departmental tracker actually asks.

In a pilot across 68 PhD students in one psychology department, **every single student checked by hand had publications the automated matching had missed.** Three for three. Not edge cases — one had six published papers, including a first-authored article in *Communications Biology* and a paper in *Nature Human Behaviour*, and the system reported zero.

If you are building something like this, the useful finding is that a zero means *unmeasured*, not *unproductive*, and no amount of matching cleverness fixes that. Only explicit identifiers do.

## What went wrong, in order of how much it cost

| Failure | What happened |
|---|---|
| **Search recall** | Crossref `query.author` is a relevance ranking, not a filter. A student's 146-citation *Nature Human Behaviour* paper, with their name printed plainly in the byline, was never returned across 300 scanned records. It is in Crossref. The search just didn't rank it. |
| **Name changes** | One student publishes under a former surname. Her ORCID returned nothing and every name search failed. |
| **Wrong advisor on file** | A student listed under one faculty member publishes almost entirely with another. The advisor-corpus pass searched the wrong lab and correctly found nothing. |
| **Namesakes** | A supplied ORCID for one student resolved to a gamma-ray astrophysicist with 878 citations. Entering it would have put a first-year at the top of the ranking. |
| **Partial-name matching** | Three separate bugs, each fixed in isolation before the next appeared: surname-only advisor matching, hyphenated surnames, and surname-only roster corroboration. If your code compares names anywhere, assume it is wrong until tested. |
| **Rate limiting as data** | An early version recorded throttled requests as "not found," silently turning API failures into claims about productivity. |

## Design consequences

Everything below follows from the failures above.

- **Three resolution passes, in priority order.** Explicit identifier (ORCID or DOI list) → co-authorship with the recorded advisor → name search with corroboration. Only the first is trustworthy.
- **Confidence is a first-class field,** and `unknown` is distinct from `none`. A failed request is never written as a zero.
- **Uncorroborated name matches produce `null`, not `0`.** The system declines to claim a number it cannot support.
- **Human decisions are append-only and carry their reasoning.** Each override records why it was accepted, so a reader in six months can audit the judgement.
- **Consortium papers are reported separately.** One contributor out of 258 on a megastudy should not silently dominate a citation column.

## What it does not measure

Teaching, mentoring, service, methods and tooling work, replication and open-science contributions, data collection, grant success, and anything unpublished. Conference proceedings are largely absent because most are not DOI-registered, which systematically undercounts some subfields relative to others.

Crossref citation counts run roughly half of Google Scholar's, because Crossref counts only references its member publishers deposit. Internally consistent; not comparable to Scholar figures.

---

## Repository layout

```
src/
  Metrics.gs          metrics collector: identifier, advisor-corpus, name-search passes
  WebApp.gs           serves a public read-only page, data injected server-side
  Config.example.gs   copy to Config.gs and fill in
web/
  dashboard.html      metrics table with cohort and area normalisation
  review.html         click-to-confirm identity review
data/
  *.example.json      shapes for roster, cohorts, overrides
docs/
  METHODOLOGY.md      the failure modes in detail
  SETUP.md            deployment
```

## Setup

1. Create a Google Drive folder for the data files.
2. Create an Apps Script project, add `src/Metrics.gs` and `src/WebApp.gs`.
3. Copy `src/Config.example.gs` to `Config.gs` and set your folder ID and contact email. `Config.gs` is gitignored.
4. Build a roster from `data/roster.example.json`.
5. Run `runFullCrawl` once by hand, then `installMonthlyTrigger`.

Full detail in [docs/SETUP.md](docs/SETUP.md).

## A word on using this

This produces per-person productivity figures for named people, usually without their involvement. That is worth being deliberate about.

The figures are a floor of unknown depth. Treat a low number as a question, not an answer, and check it against the person's own record before it informs anything that affects them. The review queue is not cleanup around the edges — in the pilot it was where a large share of the real data turned out to live.

Nothing in `data/` is committed. The `.gitignore` is deliberately broad, and if you find yourself force-adding past it, consider whose name is in the file.

## Requirements

A Google account with Apps Script and Drive. [Crossref](https://api.crossref.org) needs no key; supply a contact email to use the polite pool.

Note that **OpenAlex is unusable from Apps Script**: it returns HTTP 429 to Google's shared egress IPs regardless of pacing. Verified across 350 requests at three different rates. Crossref works fine from the same place.

## License

MIT. See [LICENSE](LICENSE).
