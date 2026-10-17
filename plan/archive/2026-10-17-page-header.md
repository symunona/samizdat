---
created: 2026-10-17
topic: page-mode document header
excerpt: Page mode stops hiding the header on scroll; touch taps it, keyboard toggles with h.
status: shipped
---

# Page-mode header

The scroll-direction auto-hide read the page-index fraction in page mode, so every
forward turn hid the header and every back turn showed it.

- Header shrinks to a fixed 40px strip; the content area always sits below it, so
  hiding it never resizes the viewer (no repagination).
- Page mode only — flow keeps the scroll-driven hide.
- Touch (`pointer: coarse`, native): shown for 1.5s on open, then hidden; a plain tap
  (frame → host `tap_blank`, sent only when no link/mark/image/selection claimed it) toggles.
- Keyboard: pinned; `h` toggles (host listener + frame forward as `hotkey`), ignored in
  inputs and with modifiers. Bottom-right hint `h — hide header` until first use;
  `header_hotkey_used` is a device-local setting.
- E2E: `runPageMode` — header survives page turns, h/tap toggle, no viewer resize, hint
  gone after first h and after reload. Native tap-toggle is not verifiable headless.
