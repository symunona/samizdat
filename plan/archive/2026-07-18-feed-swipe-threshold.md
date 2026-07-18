---
created: 2026-07-18
topic: Feed horizontal-swipe over-sensitive vs vertical scroll
excerpt: Widen ReanimatedSwipeable drag threshold so scroll is the default direction and left/right swipe needs deliberate horizontal travel.
status: done — SWIPE_DRAG_OFFSET=36 shipped; verified on web (transition at 36px, small/steep-small drags no longer swipe). Native/touch ratio feel = device check. Strict 1:5 slope not enforceable via this approach (no failOffsetY).
---

# Feed swipe too sensitive

## Problem
Feed cards (`app/(drawer)/index.tsx`) wrap `HighlightCard` in RNGH `ReanimatedSwipeable`
with no gesture tuning → library defaults: `activeOffsetX: [-10, 10]`, **no `failOffsetY`**.
A diagonal drag that crosses 10px horizontal hijacks into a left/right swipe even when the
user is mostly scrolling. User wants scroll as default; swipe should need dominant horizontal.

## Constraint
`ReanimatedSwipeable` hard-codes its pan and does NOT expose `failOffsetY` (checked v3.0.0
source). Only `dragOffsetFromLeft` / `dragOffsetFromRight` are exposed.

## Chosen fix (user pick: widen threshold)
Raise `dragOffsetFromLeft` / `dragOffsetFromRight` so the swipe needs deliberate horizontal
travel. On native + mobile-web (touch), the FlatList's native ScrollView claims a vertical
drag first (lower threshold) once the horizontal bar is high → scroll wins by default; swipe
only fires on a clearly horizontal pull. No true `failOffsetY` ratio lock (library blocks it).

- Constant `SWIPE_DRAG_OFFSET` in `index.tsx`, applied both directions.
- Start ~36px, tune by feel.

## Caveat
Desktop mouse cannot drag-scroll, so an agent-browser mouse-diagonal test only verifies the
horizontal threshold increased — the real scroll-vs-swipe arbitration is a touch behavior.

## Test
- agent-browser (web): mouse-down on a feed card, drag shallow-diagonal short → no swipe;
  drag clearly horizontal past threshold → swipe reveals action. Assert VISIBLE reveal.
- `just e2e` green.
- Touch ratio feel: verify on device after build (native-only arbitration).
