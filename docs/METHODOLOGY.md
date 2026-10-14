# Methodology: why author name matching does not work

Notes from building a publication tracker for a psychology department of 181 people, 68 of them PhD students. Every number below was measured, not estimated. Individuals are anonymised.

The short version: **we could not reliably determine what a given person had published.** Not because the data is missing — it is in Crossref — but because no query reliably retrieves one person's work. Everything else here follows from that.

---

## 1. Choosing a source

| Source | Result from Google Apps Script |
|---|---|
| OpenAlex | **HTTP 429 on every request.** Identical rate at 350ms, 1250ms and 2000ms pacing, across ~350 requests. This is a quota on Google's shared egress IPs, not a per-second limit. Unusable from Apps Script; works fine from a residential connection. |
| Semantic Scholar | **HTTP 200 with "Too Many Requests" in the body.** A status-code-only health check reports this as healthy. Needs a key. |
| OpenAIRE | Reachable, not evaluated further. |
| **Crossref** | **Works.** No key, generous limits, `mailto` polite pool. |

Two lessons. Cloud platforms share egress IPs, so an API that works from your laptop may be exhausted from Apps Script or Lambda — test from where the code will actually run. And check response *bodies*, not just status codes: our first reachability test called Semantic Scholar usable because it returned 200.

## 2. Crossref recall is unreliable

This is the finding that matters most, and the one we found last.

`query.author` is a **relevance ranking, not a filter**. It returns results indefinitely, each page less relevant, and it does not guarantee that a given author's work appears at all.

> A student is second author on a *Nature Human Behaviour* paper with 146 Crossref citations. Their name is printed plainly in the byline. Searching that name and scanning **300 records never returned it.** The paper is in Crossref. The search just didn't rank it.

A second student had **six published papers** — including a first-authored *Communications Biology* article and a *Nature Human Behaviour* paper — and a name search returned 22 candidates with zero corroborated. Seven of her coauthors were on our roster, so corroboration would have worked fine had the papers been returned at all.

**Consequence: a name search finding nothing is not evidence that nothing exists.** Treat every zero as unmeasured.

Also: do not reach for `cursor=*` to fix this. Cursor mode is deep paging and **discards relevance ranking**, returning matches in index order. With the cursor in place one prolific advisor yielded 3 genuine works out of 1000 scanned; without it, the same query yielded 63.

## 3. Name matching fails in layers

We hit the same class of bug three times. Each fix was verified in isolation, and the next layer had the identical flaw.

**Surname-only advisor matching.** Matching just the surname against a relevance query returned 948 works for one advisor — every paper by anyone with that surname. Requiring the given name to agree cut it to 63.

**Hyphenated and multi-part surnames.** Normalising "Smith-Jones" gives `smith jones`, which never equals the last token `jones`. One hyphenated advisor returned 2 works out of 1000 while comparable advisors returned 20–200. Silent, and it affects every hyphenated surname, every two-word surname, and every apostrophe.

**Surname-only corroboration.** We corroborated name matches by checking whether another roster member appeared as a coauthor — on surname alone. The roster contained Chen, Lee, Liu, Wu, Kim, Han, Miller, Anderson, Shah and Gupta, so any paper with any Chen on it looked corroborated. One student scored 67 "corroborations" out of 150 matches, another 49 of 306. Requiring given names dropped both to zero.

If your code compares names anywhere, assume it is wrong until you have written the test.

## 4. Four reasons a person reads as zero

None is a statement about productivity.

1. **Search recall failure** (above) — the work exists and is indexed, and the query doesn't return it.
2. **Name change.** One student publishes under a former surname. Her ORCID returned nothing, every search on her roster name returned nothing, and the record was found only via a Scholar profile.
3. **Wrong advisor on file.** A student listed under one faculty member publishes almost entirely with another. The advisor-corpus pass searched the wrong lab and correctly found nothing.
4. **Venue not indexed.** Conference proceedings, including the Cognitive Science Society, are largely not DOI-registered. This systematically undercounts some subfields relative to others, which shows up directly in any cross-area comparison.

In our pilot, **three of three** students checked by hand had publications the automation had missed.

## 5. Identifiers are the only fix

Ranked by reliability:

| Method | Reliability |
|---|---|
| **DOI list** | Exact. The fallback when an ORCID returns nothing. |
| **ORCID** | Definitive *when populated*. Crossref's `orcid:` filter is a hard filter. |
| Advisor co-authorship | Good precision, poor recall. Misses all independent work. |
| Name + corroboration | Poor. Use to propose candidates for review, never to produce figures. |
| Name alone | Unusable. |

Two cautions on ORCID. It depends on **publishers depositing it**: one student's valid ORCID matched zero Crossref records at any date, which says nothing about her output. And a supplied ORCID can simply be wrong — one resolved to a gamma-ray astrophysicist with 41 works and 878 citations. Entering it would have placed a first-year at the top of the ranking, looking entirely credible. **Verify every identifier against the person's subfield and coauthors before trusting it.**

## 6. Design rules we ended up with

- **`unknown` ≠ `none`.** A failed request must never be written as a zero. An early version recorded rate-limited requests as "not found," quietly converting API failures into claims about students.
- **Uncorroborated matches produce `null`, not `0`.** Decline to claim what you cannot support.
- **Compute metrics only over corroborated work.** Running them across all name matches attributed 306 papers to one student.
- **Separate consortium papers.** One author of 258 on a megastudy carried 251 citations; counting those like a three-author paper's would have dominated the citation column. Report `citations_excl_mega` alongside the raw figure.
- **Human decisions are append-only and carry their reasoning.** Six months on, nobody remembers why an attribution was accepted, and a wrong one is invisible without the note.
- **Name forms need an alias map.** Short names, middle names, former surnames, and roster/publisher spelling disagreements all require explicit mapping. The symptom is an identifier returning the right papers while author position comes back unknown.

## 7. Known distortions in the output

- Crossref citation counts run **roughly half of Google Scholar's**, because Crossref counts only references its member publishers deposit. Observed: 146 vs 290, and 32 vs 60, on the same papers. Internally consistent; not comparable to Scholar.
- Citation counts rise with time enrolled, so any cross-cohort ranking partly measures seniority.
- Citation velocity differs sharply by subfield.
- h-index is near zero for most students and cannot discriminate within recent cohorts.
- Author-position conventions differ by lab and subfield, so first-author counts are not perfectly comparable.
- **Nothing here measures** teaching, mentoring, service, methods and tooling work, replication and open-science contributions, data collection, grant success, or unpublished work.

## 8. If you build one of these

Collect ORCIDs first. Every weakness above traces back to not having stable identifiers, and no amount of matching cleverness substitutes for them.

Then treat the review queue as a primary data path rather than exception handling — in our pilot a large share of the real data was only ever going to arrive that way. And before any of it informs a decision about a person, check it against their own record. A number that is wrong in a spreadsheet is a bug; a number that is wrong in a review is something else.
