# Setup

## 0. Before anything

This writes files about named people into a Drive folder. Two things to settle first:

- **Decide who may read that folder.** Default to just you.
- **Copy `src/Config.example.gs` to `Config.gs`** and set `FOLDER_ID`, `MAILTO` and `INSTITUTION_RE`. `Config.gs` is gitignored and must stay that way.


Add `Metrics.gs` to the same Apps Script project you made for the Google Sites page. It shares that project's Drive authorization, so there's nothing new to approve.

---

## 1. Install

1. Open the **PubWatch** project at script.google.com.
2. **+** next to Files → **Script**. Name it **`Metrics`**.
3. Paste in `Metrics.gs`. Save.

## 2. First run

1. Pick **`runFullCrawl`** from the function dropdown → **Run**.
2. Authorize if prompted.
3. Watch **Executions** in the left sidebar. The crawl paces itself at roughly 3 requests/second and pauses before Apps Script's 6-minute cap, scheduling itself to continue about a minute later. A full 68-student pass takes two or three executions.

When it finishes you'll have `phdmetrics-YYYY-MM-DD.json` in the PubWatch folder, and — if anything was ambiguous — `phdmetrics-review.json` alongside it.

## 3. Schedule it

Run **`installMonthlyTrigger`** once. It runs on the 1st of each month at about 3am, and it deletes any existing trigger first, so running it twice is safe.

Confirm with **`showTriggers`**, which prints what's actually installed rather than what you meant to install.

You can now disable any other scheduled job doing the same work. This collector supersedes it and doesn't need the desktop app open.

### Why monthly is the right cadence

The whole crawl is about 35 Crossref requests and finishes in one execution, so frequency isn't a cost problem — it's that there's nothing to see. Citation counts drift slowly, and a new paper appearing in Crossref is a monthly-scale event, not a daily one. Checking nightly would rewrite the same numbers thirty times to catch one change.

To change the timing, edit `TRIGGER_DAY_OF_MONTH` and `TRIGGER_HOUR` at the top of the file and re-run `installMonthlyTrigger`.

### The functions you'll actually use

| Function | What it does |
|---|---|
| `runFullCrawl` | All 68 students: ORCID pass, advisor corpora, then name search for the remainder. One execution, ~30 seconds. Run it by hand after adding ORCIDs or working the review queue. |
| `installMonthlyTrigger` | Puts `runScheduledCrawl` on the 1st of each month. |
| `showTriggers` | Lists what's scheduled. |
| `resetCrawl` | Clears saved progress so the next run starts clean. |
| `showProgress` | Says where a paused crawl stopped. |

`runNightly` still exists as an alias for the full crawl, and `installNightlyTrigger` now installs the monthly trigger and logs a note saying so — so older instructions can't silently give you a daily job.

## 4. The review loop

1. Open `web/review.html`.
2. For each queued student, pick the right OpenAlex author or choose **No OpenAlex record**.
3. **Save to Drive**. That writes `phdmetrics-overrides-<timestamp>.json`.
4. The next crawl reads every overrides file, newest last, and treats your decision as settled — it stops re-searching that person entirely.

Confirmations are append-only. Changing your mind later just writes a newer file that wins; the earlier one stays as a record of what was decided when.

---

## How resolution works

Three strategies, in priority order:

1. **Manual override** — an ID you confirmed. Always wins.
2. **Advisor-side** — looks for the student as a coauthor inside their advisor's own papers. This is the strongest signal available, because a namesake at another institution cannot appear in your advisor's author list.
3. **Name search** — falls back to searching the name, then grades the match by whether a roster coauthor or your institution's affiliation corroborates it. Candidates only — see METHODOLOGY.md on why this cannot be trusted for figures.

## What the confidence values mean

| Value | Meaning |
|---|---|
| `confirmed` | You picked this ID by hand |
| `high` | Found inside the advisor's publication set, or advisor on ≥40% of works |
| `medium` | Advisor on 20–39% of works |
| `low` | Advisor on <20%, or an implausible coauthor-per-work ratio. Queued for review |
| `unverifiable` | No advisor recorded in the directory, so no verification signal exists |
| `none` | Searched and genuinely found nothing |
| `unknown` | **OpenAlex did not answer.** Not a finding. Retried next run |
| `confirmed-absent` | You confirmed there is no record |

That `unknown` distinction is the point of rebuilding this. The browser run recorded failed requests as "not found," which quietly turned rate limiting into a claim about a student's productivity. This script never does that.

## Troubleshooting

**Crawl seems stuck.** Check Executions. If a run died mid-way, `_phdmetrics-partial.json` holds the progress and the next run resumes from it. To start clean, run `resetCrawl`.

**Want to force a fresh pass.** Run `resetCrawl`, then `runFullCrawl`.

**A student is still wrong after an override.** Check that the name in your override matches the roster spelling in `cohorts.json` exactly — matching is by name string.

**Nicknames.** The `FORMAL` map near the top translates directory shorthand to the form OpenAlex indexes (Mike Frank → Michael Frank, Izzy Aslarus → Isabel Aslarus). If a lookup fails for someone who goes by a short name, add them there.
