---
created: 2026-07-02
topic: Video player usability — pin player + tabs, maximize transcript, resume button
excerpt: Pin the video strip and tab bar to the top so they never scroll away; give the transcript the remaining space; add a floating "scroll to active segment" button when playback drifts off-screen.
status: done
---

# Video player usability

## Problem
In `VideoDocument`, the whole page (video + tabs + transcript) lives in one `ScrollView`.
To get back to the video you must scroll the transcript all the way up. The transcript also
shares the scroll with the video, so it never gets full height.

## Decision (user)
- **Pin the video strip to the top** (compact, always visible — no scroll-away).
- **Pin the tab bar too** (Transcript · Details · Excerpt · Notes).
- Transcript panel fills the remaining space and scrolls **internally**.
- **Floating top-right button** (scroll-down icon) shown only when the currently-playing
  transcript segment is NOT visible → tap scrolls to it and resumes auto-follow.

## Changes

### `app/src/VideoDocument.tsx`
- Drop the outer `ScrollView` + `panelH`/`winH` height hack. Screen becomes a flex column:
  header · banner · **player (pinned)** · audio-only btn · **tabBar (pinned)** · **tabContent (flex:1)** · footer.
- Compact, deterministic player size: `playerH = min(width*9/16, winH*0.32)`, `playerW = playerH*16/9`,
  centered. Bounds the pinned player so the transcript is maximized on both phone and desktop.
- `tabContent` is `flex:1, position:'relative'`; transcript panel + other tabs fill it; the
  resume button is an absolute overlay top-right.
- New state `activeSegVisible` fed by a `activeSegVisible` message from the webview. Show the
  resume button when `tab==='transcript' && !activeSegVisible`. Tap → `sendToWebView({type:'scrollToActive'})`.

### `app/src/webview/document-viewer.ts` (rebuild bundle after)
- Report active-seg visibility: `reportActiveVisibility()` posts `{type:'activeSegVisible', visible}`
  (deduped) from `setActiveSeg` and the scroll listener.
- New inbound `scrollToActive`: reset `_lastUserScroll = 0` (resume follow) + `scrollIntoView` the
  `.seg.active`.
- Run `just webview-build`.

## Test
- `just lint` (eslint + parity), `just build`, `just e2e`.
- agent-browser via `just robot-browser`: open a video doc, scroll transcript up while playing →
  button appears → tap → scrolls back to active segment; verify player + tabs stay pinned.
</content>
