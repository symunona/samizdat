---
created: 2026-07-28
topic: PDF figures — extract images AND vector figures from PDFs into Documents
excerpt: The PDF ingest path (2026-07-28-pdf-ingest) extracts text only; every figure is lost. Raster figures live as image XObjects, but most academic figures are vector drawings with nothing to extract. Adopt MuPDF (go-fitz, AGPL) to get cropped SVG per figure plus raster assets, spliced into the Document markdown at their real position.
status: draft — awaiting review
---

# PDF Figure Extraction

## The gap

`worker/pdf.go` produces text-only markdown. A paper's figures — often the
densest part of it — vanish silently. No error, no placeholder.

There are **two distinct problems** hiding behind "extract images", and this is
the finding that drives every decision below:

1. **Raster figures** — photos, exported PNG/JPEG charts. Stored as
   `/XObject /Image` streams. Extractable by parsing the PDF.
2. **Vector figures** — TikZ, matplotlib PDF output, pgfplots, Illustrator/EPS.
   Stored as drawing operators in the content stream. **There is no image to
   extract.** The only way to get one is to *render*.

Measured on real papers (probes under `tmp/` during research):

| paper | raster XObjects found | reality |
|---|---|---|
| `1706.03762` (Attention) | 3 (Fig 1 = 1520×2239 PNG) | figures genuinely are rasters |
| `2001.08361` (Scaling laws) | 9×193px colorbar strips only | real plots are vector |
| `1512.03385` (ResNet) | **0** | every figure vector |

An XObject-only solution therefore misses most of arXiv.

## Options considered (all measured on the VPS, not from docs)

| option | vector? | pure Go | cost |
|---|---|---|---|
| `pdfcpu` `ExtractImagesRaw` | ✗ | ✓ | 1.8s / 2.2MB PDF, ~200MB RSS. No placement. |
| `ledongthuc/pdf` (current dep) | ✗ | ✓ | Cannot decode images at all: `Value.Reader()` panics on `DCTDecode`, raw stream offset unexported. Placement only, via exported `pdf.Interpret` (`cm`/`Do` CTM). |
| `segfaultd/pdf-to-markdown` | ✗ | ✓ | Turnkey Go package = ledongthuc + pdfcpu. Same blind spot. |
| `ajroetker/pdf/render` | ✓ (claims) | ✓ | **Broken.** Rendered ResNet p2 with no text, solid black boxes, a curve as a blob. Unusable. |
| `klippa-app/go-pdfium` (wasm/wazero) | ✓ via raster | ✓ | 2.4s init, 149ms/page @150dpi, **292MB RSS**, +12MB binary. Works; PoC cropped ResNet Fig 2 correctly. No SVG output (pdfium has no SVG API). |
| **`gen2brain/go-fitz` (MuPDF)** | **✓ native SVG** | ✗ cgo | **31–96ms/page, 15MB RSS, 12MB binary.** AGPL-3.0. |

Python turnkey tools (pymupdf4llm, marker, docling, MinerU) all sit on MuPDF or
ML models — out of scope for a Go single-binary server, and pymupdf4llm is the
same AGPL engine anyway.

## Decision

**MuPDF via `gen2brain/go-fitz`.** It is 20× lighter in RAM than the pdfium-wasm
alternative and is the only engine that emits real SVG:

```
open 2.5ms  pages 12
SVG(page)   31ms   629 KB   184 paths          <- full vector page
HTML(page)  42ms    25 KB   rasters as base64  <- but DROPS vector graphics
binary 12MB, RSS 15MB
```

Consequences accepted by the owner:

- **AGPL-3.0.** MuPDF is AGPL (`COPYING` in go-fitz). Samizdat has **no LICENSE
  file today** → this plan adds `LICENSE` (AGPL-3.0) at the repo root. The server
  source is already published, so this changes nothing operationally.
- **cgo.** `justfile:233` builds the server `CGO_ENABLED=0`; this flips to `1`.
  go-fitz vendors static `libmupdf_linux_amd64.a` (~9MB), so no system package
  and no runtime dependency — but the binary links glibc dynamically. Still one
  binary, no Docker, no nginx; rule 6 survives in spirit, and the deploy target
  is this box. `cli/` and the Expo/APK build are untouched (`CGO_ENABLED=0`
  stays there — the CLI does not extract figures).
- Note the **`HTML()` mode is not usable** for this: it emits `position:absolute`
  divs and drops vector art. Only `SVG()` + the existing text extractor are used.

## Design

Extraction stays inside the existing `handlePDF` flow; no new job kind unless the
timing argues for it during implementation (a 12-page paper costs <1.5s total).

### 1. Figure regions — from the content stream, not from MuPDF

go-fitz exposes only whole-page output (`Image`/`ImageDPI`/`SVG`/`Text`/`HTML`/
`Links`/`Bound`) — there is **no page-object enumeration**, so the bbox pass that
the pdfium PoC used is not available here. Detection instead reuses the exported
`pdf.Interpret` from `ledongthuc/pdf`, already a dependency and already the basis
of `pageText`:

- track `q`/`Q`/`cm` for the CTM (the PoC's matrix code works as written);
- `Do` on an XObject with `/Subtype /Form` → box = its `/BBox` through the CTM.
  This is the common LaTeX case: a whole figure is one form. In the ResNet probe
  the page held exactly one non-text object and its bounds *were* Figure 2;
- `Do` on `/Subtype /Image` → box = the unit square through the CTM (verified
  against all three probe papers);
- inline path ops (`m`/`l`/`c`/`v`/`y`/`re`) → accumulate points in the CTM, for
  TikZ drawn directly on the page.

Merge boxes that overlap or sit within ~12pt. Drop boxes < 60×40pt (rules,
underlines, bullets) and boxes repeating at the same coordinates on most pages
(running header/logo).

### 2. One asset per figure — PNG crop in v1

Render the page once with `ImageDPI(page, 150)` and `SubImage` each figure box —
exactly the pipeline the pdfium PoC proved (it cropped ResNet Fig 2 pixel-clean
at box (98,638)-(231,712)pt). Encode through the existing thumbnail path so a
full-page figure does not land at full size.

**SVG is deferred, deliberately.** MuPDF emits a per-page SVG, but cropping it
means either rewriting the root `viewBox` (drags the whole page's 600KB into
every figure) or computing element bboxes to strip outsiders — which needs a path
parser, i.e. the same work as detection, twice. Plus native RN SVG rendering is
unproven here. Keep the renderer behind one function so SVG can replace PNG once
detection is trusted; PNG at 150dpi is legible in the reader today.

Write `media_assets` rows directly — the bytes are already local, so no
`fetch_assets` job. `original_url` is UNIQUE NOT NULL, so use a synthetic
`pdf://<document_id>/p<page>/fig<n>` key; that also makes re-scrape idempotent.
`kind` = `content` (matching articles) so existing consumers need no change.

### 3. Placement in the markdown

`pageText` already carries per-line baseline geometry. A figure becomes one more
y-positioned block in that stream, so it sorts into the reading order (and into
the correct column, via the existing gutter boundary) instead of being dumped at
a page boundary. Emitted as `![caption](/api/v1/media/<asset_id>)` — the same
relative form `step_llm_summarize.go` already uses, which the app absolutizes.

Caption: the nearest text line above/below the box starting `Figure N`/`Fig. N`/
`Table N` becomes the alt text; absent that, empty alt.

## Test plan (E2E, written before the work)

1. **Unit** — figure clustering: two overlapping boxes merge; a page rule
   (200×2pt) is dropped; a header logo repeating on 8 of 12 pages is dropped.
2. **Unit** — box math: a Form `/BBox` through a scaling+translating CTM lands where the PoC measured it; an inline `re` path contributes its corners.
3. **Golden** — ResNet `1512.03385` p2 → exactly one figure, box ≈ (98,638)-(231,712)pt.
   Attention `1706.03762` → 3 raster figures on pages 3–4.
4. **Live** — scrape both URLs through the real worker: job `done`, Document has
   `media_type='pdf'`, N `media_assets` rows, markdown contains N `![...](...)`
   at plausible offsets (not all at the end).
5. **UI (mandatory, `just robot-browser`)** — open the PDF Document in the
   reader, assert the figure `<img>` actually renders with non-zero natural
   dimensions (a broken src still returns HTTP 200 markdown, so asserting the
   row exists proves nothing). Check SVG renders on **native** too — relative
   `/api/v1/media/...` srcs are known to load 1×1 invisible in RN.
6. `just build` (with cgo), linter, `just e2e` green.

## Risks

- **Link step RAM.** Linking ~20MB of MuPDF archives on a 4GB box — watch for
  OOM during `just build`; if it bites, build with `-ldflags=-s -w` and no
  parallel test compile.
- **Binary size** 12MB → ~25MB total. Irrelevant for this deploy.
- **Scanned PDFs** still have no text layer; `DetectFalseParse` keeps flagging
  them. Figures would extract, but the false-parse guard fires first — leave that
  contract alone, revisit only if a scan-heavy source shows up.
- **Rescrape churn**: synthetic asset URLs are deterministic, so a re-scrape
  overwrites rather than duplicating. Verify with the dedup test.
