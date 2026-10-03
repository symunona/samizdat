# CLAUDE.md — tooling/

Internal developer tools. Written in Go. Entry point: `spec` binary.

## Structure
```
cmd/spec/main.go        cobra entry point, repoRoot() detection
linting/
  lint.go               golangci-lint runner for all Go subprojects
  diff_review.go        git diff → Claude review → optional CLAUDE.md update
  lib_check.go          go.mod diff → new library detection → Claude explanation
  parity.go             paired-renderer files changed vs main → Claude in-sync check
internal/claude/        thin Anthropic HTTP client (no SDK)
internal/git/           git shell helpers (branch, diff)
```

## Commands
```
spec lint           run golangci-lint on server/, cli/, tooling/
spec diff-review    architecture review of branch vs main, per subproject
spec lib-check      list + explain new Go libraries added vs main
spec parity         paired-renderer files in sync vs main (Highlight card RN vs WebView)
spec all            run all four
```

## Diff-review behavior
- No-op on main branch
- Reads each changed subproject's CLAUDE.md for context
- Uses `claude-sonnet-4-6` (analysis tier)
- Shows proposed CLAUDE.md diff, asks Y/n before writing
- Non-destructive: never writes without confirmation

### It rewrites the WHOLE file — two guards keep that from destroying it
The prompt asks for the full updated CLAUDE.md and the result is `os.WriteFile`d over
the original, with a Y/n prompt that **defaults to yes**. Anything short of a complete
reply is therefore silent data loss. It already happened once: `max_tokens` was 4096
while `server/CLAUDE.md` alone is ~4k tokens, so the reply was cut mid-file and **67
lines of PDF and video notes were deleted**. Both guards must stay:
1. `claude.ErrTruncated` — the client now reads `stop_reason`; `max_tokens` is returned
   as an error and diff-review refuses to touch the file. Do not discard this error.
2. `shrinksTooMuch` — refuses a rewrite that drops more than `maxShrinkPct` (15%) of the
   file, independent of what the API reports. Unit-tested in `diff_review_test.go`.

`MaxTokens` is 16384 (`internal/claude/client.go`) because a full CLAUDE.md rewrite is
the largest response any tool here asks for. If a CLAUDE.md outgrows that, raise it —
but the guards, not the limit, are what make the tool safe.

## Parity behavior
- No-op on main branch (diffs `main...HEAD`, so it gates committed changes pre-merge — not the working tree)
- Concrete pairs only, declared in `parity.go` — NO generic registry. One pair today: the Highlight card (`app/src/HighlightCard.tsx` RN ↔ `app/src/webview/document-viewer.ts` WebView DOM). A new paired-renderer file group gets its own `parityPair` + check, not an abstraction.
- If a file in a pair changed vs main, sends both full sources + both diffs + the invariant to `claude-sonnet-4-6`; expects `IN_SYNC: yes|no` + notes
- Out of sync → non-zero exit (fails `just lint`); in sync → exit 0
- Graceful degrade: no `ANTHROPIC_API_KEY` → prints which file changed + a manual-check reminder, exits 0 (never blocks a branch on a missing key)
- Wired into `just lint` via the `lint-parity` recipe

### Highlight card parity invariants
The `highlightCardPair` invariant string encodes what Claude must check. Current invariants:

- **DIGEST CHIPS**: a Highlight cited by a DigestIssue shows one chip per Digest — the Digest's name on its palette colour, dark text — first in the same row as the tag chips, and a press opens the citing issue. RN renders `DigestChip` (`src/DigestChip.tsx`) and navigates itself; the WebView renders `.hl-digest-chip` buttons and posts `hl_digest`. Flag a chip present on one side only, or a differing fill/text colour.
- **ICON-BUTTON STYLE**: the footer action buttons (delete, tags, annotate) must look the same in both renderers — FLAT and BORDERLESS (transparent background, no border/box outline), with a fill-background hover. The RN side uses the `IconButton` component (`src/IconButton.tsx`); the WebView uses the `.hl-icon-btn` CSS class. Their geometry (padding, radius, glyph size, hover scale) is shared via `src/iconButtonSpec.ts` and must come from there in BOTH files — flag any re-introduction of a border/box on one side, a divergent hover treatment, or a hardcoded geometry value that bypasses `iconButtonSpec`.

## Lib-check behavior
- Parses `+require` lines from `git diff main...HEAD -- */go.mod`
- Uses `claude-haiku-4-5-20251001` (triage tier — fast + cheap)
- Gracefully degrades if `ANTHROPIC_API_KEY` not set (just lists libs)

## Claude client
- Plain `net/http` to `https://api.anthropic.com/v1/messages`
- No official Go SDK (none exists at time of writing)
- `ANTHROPIC_API_KEY` env var required for Claude-powered checks

## Conventions
- All tools exit 0 on success, non-zero on findings needing attention
- Tools are non-destructive by default — print and ask before writing
- `repoRoot()` walks up from cwd looking for `justfile`; override with `REPO_ROOT` env