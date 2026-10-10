---
created: 2026-10-10
topic: Digests — diff a new release against earlier Highlights
excerpt: A DigestQuestion can be marked `history`. Each topic it finds is then compared with older Highlights of the same model family, from before the window, and gains a "vs <previous release>" line plus the earlier bullets it rests on. AI Weekly gets a fourth question, "Frontier releases", using it.
status: in-progress
---

# Digest history diff

## Why

A Digest sees only the Highlights since its last issue. "Claude Opus 5.5 shipped"
is in the window; what Opus 5 was — the thing that makes 5.5 news — is two months
back and never reaches the prompt. The issue can say a model shipped, not what
changed.

## Decision: a per-question lookback, in two passes

Rejected:

- **Feed past DigestTopics as context.** Topics hold a model-written `title` and
  `why` plus refs. Diffing against text a model wrote is the `map→reduce` trap
  (`docs/decisions.md`): the second pass never saw the source. And AI Weekly has
  three issues; the Highlights go back to June.
- **One call, history appended to the window.** Which history? Family-matching
  every window Highlight (tools, ideas, summaries) against 900 rows pulls far more
  than the budget holds, and the model would be diffing things nobody asked about.

Chosen: `DigestQuestion.history` (bool, JSON inside `digests.questions` — **no
schema change**).

1. **Pass 1 is the question as it runs today**, over the window. It decides which
   releases are news. Unchanged code path.
2. **Per topic, the server picks earlier Highlights** — in-scope Feeds, created
   before `window_start`, no lower bound. Selection is deterministic: the words of
   the topic's title (letters only, ≥3, minus a short stoplist; version numbers
   fall away) against the words of each Highlight **title**. Ranked by shared
   words, then newest; at most `maxHistory` (12) Highlights. "Claude Opus 5.5" →
   `claude`,`opus` → "Claude Opus 5" ranks above "Kimi K3 ~ Opus 4.8". No match →
   no call, the topic stays as pass 1 wrote it.
3. **Pass 2, one call per topic with history**: the topic's own cited lines as
   NEW, the history as EARLIER, each earlier line dated (`[h3] 2026-07-26 · feed ·
   title — text`). The model returns `previous` (the earlier release's name),
   `diff` (one or two sentences) and the earlier refs it used.

The model's title is used as a search key only, never shown as a fact it did not
already show.

### What keeps the diff honest

A diff is synthesis, so "the model writes only title and why" cannot hold
literally. What holds instead:

- A diff is kept only with a `previous`, a `diff` and **at least one earlier ref
  that resolves** to a line that was sent. Otherwise it is dropped and counted
  (`dropped_diffs`).
- The earlier refs are stored on the topic (`history: true`, at most 3) and shown
  under it with their date — the reader sees the stored bullets the claim rests on.
- The prompt says: earlier coverage of the same release is not a previous release;
  no previous release of this line in the items → return none. The Haiku 5.5 case
  (no earlier Haiku on record) must come back with no diff.
- Rule 5 gates the history rows' `canonical_url`s like the window's.

### Budget

Pass 2 uses the same `window()`. The NEW lines must fit; history is clamped to
what is left, most relevant first. No room for one earlier line → no diff, counted.

## Shapes

```
Question  + history  bool
Topic     + previous string, diff string
Ref       + history  bool            (stored)
          + date     string          (resolved: the Highlight's created_at)
QuestionMeta + diffs, dropped_diffs  (tokens of pass 2 summed into tokens_in/out)
```

All JSON inside existing columns. `GetDigestRef` gains `created_at`.

## App

- Editor: a per-question switch "Compare with earlier Highlights".
- Issue view: under `why`, `vs <previous>: <diff>`; earlier refs after the new
  ones, each led by its date.
- Vault note: the same line, earlier bullets marked with their date.

## Self-test (decided before starting)

Go, at the Runner with the stub box:
- A `history` question; window holds "Opus 5.5", history holds "Claude Opus 5"
  (2 months old) and an unrelated tool. Pass 2's prompt carries the Opus 5 line
  dated, under EARLIER, and nothing of the tool. The topic ends with `previous`,
  `diff` and one `history` ref resolving to the old Highlight.
- The model invents a diff with no earlier ref → dropped, counted, topic kept.
- No title match in history → exactly one call.
- A question without `history` → exactly one call (today's behaviour).
- An out-of-scope Feed's history never reaches the prompt.
- `historyTerms` / ranking table test.

e2e (`just e2e-int`): toggle the switch in the editor, save, reload → still on.
Seeded issue with a diff + earlier ref → the issue page shows the `vs` line and
the earlier bullet with its date.

Real run: a copy of AI Weekly (cloned config, one `history` question, not
enabled, deleted after) over real history with `last_run_at` set so the window
holds Opus 5.5 / GPT-6.1 Sol; quote the diff.

Not verifiable headless: nothing native-only; the phone needs a new APK to show
the switch and the `vs` line (an old app ignores the new fields).

## Then

Add question 4 "Frontier releases" to the prod AI Weekly (PATCH the full
questions array, the other three verbatim).

## Open

- Title-only matching misses history that lives in a summary bullet or under
  another release's title ("~ Opus 4.8" comparisons). Body matching pulls in every
  Highlight that name-drops Opus; revisit if a real diff comes back thin.
