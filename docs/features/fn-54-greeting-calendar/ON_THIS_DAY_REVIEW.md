# FN-54 "Pada hari ini" review log

Every entry in `src/lib/content/on-this-day/entries.json` has exactly one line here, written by the person who
checked it (the owner, or an agent with web access under the owner's approval). A line records the date and year,
the two pages opened (their full `https` addresses, as in the entry), the day the check was done and who did it.
`src/lib/shared/on-this-day.test.ts` fails when an entry has no matching line.

Rules for an entry (PRD § D4): verifiable events only; no deaths, wars, disasters or violence; no party politics or
religion; nothing that reads as an investment tip, prediction or money lesson; our own words (facts are free, a
source's sentences are not); headline at most 60 characters, body at most 2 sentences and 180 characters, Indonesian
and English.

Status 2026-10-13: shipped empty (owner decision). Drafts go to the owner for review first; only approved entries are
added to the file, each with its line below.

| MM-DD | Year | Source 1 opened | Source 2 opened | Checked on | Checked by |
| ----- | ---- | --------------- | --------------- | ---------- | ---------- |
