---
created: 2026-10-15
topic: A Digest's topics land in the main feed, one card each
excerpt: Picking a Feed for a Digest holds its Highlights, so the feed shows nothing from those newsletters. Show each DigestTopic of the newest done issue of every enabled Digest as its own card among the Highlights, ordered by the issue's window_end. App-only, read from the replica; no schema or server change.
status: shipped
---

# Digest topics in the feed

## Why

"AI Weekly" holds Latent Space, Nate and cerebral-valley: their Highlights are archived
on arrival (`holdHighlights`), so the only place the AI news appears is the Digests
screen. The owner wants the digest run's output in the main feed, as separate items.

## What

Each `DigestTopic` of a Digest's issue is a card in the feed (`app/(drawer)/index.tsx`):

- `title`, `why`, the bullets the topic cites, the `DigestChip` of the Digest.
- Bullets are the topic's window refs (`history` refs and `missing` ones left out — the
  card is a preview; the issue keeps the full list), resolved by the SAME
  `selectDigestIssue` the issue screen reads offline. No second resolver.
- A press on the card or the chip opens `digestHref(digestId, issueId)`.
- A `DigestTopic` stays a `DigestTopic`: no Highlight rows are written.

### Which issues — and how a card leaves

**Only the newest `done` issue of each non-deleted, enabled Digest.** A card leaves the
feed when that Digest's next issue lands `done` (its topics replace these), or when the
Digest is disabled or deleted.

Why this and not a dismiss state:

- The feed's leave paths (swipe-archive, scroll-past auto-archive, Unread, delete) all
  write `highlights.archived_at` / `deleted_at` through `db.archiveHighlight` /
  `db.deleteHighlight`. A topic has no row there, and must not get one.
- The user-authored synced tables are `annotations`, `tags` and the tag junctions. None
  can carry "this topic is dismissed" without a new column or a new kind of row.
  Server settings are a typed struct (`api/settings.go`), so a dismiss list there is a
  server change too. → No dismiss state.
- Disabled is included in "leaves" because hold follows `enabled`: a disabled Digest no
  longer keeps its newsletters out of the feed, so its old topics would only repeat
  them. It is also the owner's one switch to take the cards away.

Known cost: with scroll-past auto-archive on, the Highlights clear and the topic cards
stay until the next issue (Tue/Fri). They sink below newer Highlights as those arrive.

### Order

By the issue's `window_end` — when its window closed, i.e. when the run read it —
merged into the Highlights' `created_at DESC`. A topic ties a Highlight on equal stamps
and goes first. Inside an issue: question order (`metadata.questions`), then `rank`.
The card prints that date (the feed's date is the sort key — `DateStamp`).

The online feed is the server's 200 newest Highlights; topics are merged into whichever
list is showing (network or replica), from the replica, so they render offline too. A
topic older than the last Highlight shown sits at the end.

### Swipe / archive

A topic card is not wrapped in `ReanimatedSwipeable` (archive/star mean nothing for it),
is skipped by the scroll-past archive queue (it has no Highlight id), and has no footer
actions. The empty state counts topic cards: a feed with only topics shows them.

## Code

- `src/db/hooks.ts`: pure `selectFeedDigestTopics` (index slices → cards) and
  `mergeFeedItems` (Highlights + cards → one list), `isFeedDigestTopic`, hook
  `useFeedDigestTopics` (raw slices + `useMemo`, never a mapping `useShallow`).
- `src/DigestTopicCard.tsx`: the card, Unistyles `useUnistyles` + `useMemo` pattern,
  styled after `HighlightCard`.
- `app/(drawer)/index.tsx`: FlatList data = merged list; renderItem branches.

## Test (decided before the code)

- **Unit** (`e2e/db-unit.mjs`, `just e2e-db`): newest done issue per Digest only;
  failed/empty/running/deleted issue skipped; deleted and disabled Digest skipped; refs
  resolved through `selectDigestIssue` (history + missing left out); topic order by
  question then rank; merge places topics by `window_end` against `created_at`, ties
  topic-first, older ones at the end, an empty Highlight list keeps the topics.
- **Interaction** (`e2e/integration.js`, `runDigests`): the issue there is produced
  through the API (Digest saved in the editor, "Run now" against the stub LLM box, Alpha
  held). On `/`, assert the VISIBLE topic card: its title, its why, Alpha's held
  Highlight bullet text (the cited bullet the feed otherwise hides), and the chip with
  the Digest's name; press the card and assert `/digest/<id>?issue=<issueId>` shows the
  topic.
- `just e2e` (smoke already visits `/` and seeds a done issue — the card renders there
  with a topic whose Highlight is gone), `just e2e-int`, `just build`, `just lint`.
- Not verifiable headless: native rendering of the card and native FlatList behaviour
  around it (maintainVisibleContentPosition with a non-swipeable row).
