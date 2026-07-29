---
created: 2026-07-29
topic: PDF tables — why the text is ugly, how to parse them properly, and what to do this week
excerpt: The PDF figure work (1f022ca) renders tables as images, which the owner likes, but the same table also lands in the markdown as a flat blob of numbers with the rows glued together. This is not a table-parsing bug — there is no table parser; it is the generic prose path applied to glyphs that were never prose. MuPDF (already linked) has fz_table_hunt; go-fitz does not expose it. Near-term: keep the text, move it out of the prose stream, and frame the picture.
status: cheap-win-server-done
---

## Status log
- 2026-07-29 — research written (below).
- 2026-07-29 — **§5 "cheap win now" step 1 (server) DONE.** `takeInterior` /
  `interiorBlock` in `server/internal/worker/pdf.go`: figure-box interior text is
  lifted out of the prose stream and re-attached under the image as a collapsed
  `<details><pre>` block, one printed row per `<br>`, HTML-escaped. Guards: a box
  absorbing >60% of a page's fragments is ignored (mis-detection), fewer than 3
  interior lines are left in place. `reflowParagraphs` skips the block by its
  `<details>` prefix. Verified against the real paper (`arxiv.org/pdf/2604.21751`):
  Table 1 and Table 10 now read as rows, and the torn-off `Div Ent` columns land
  inside their own table's block instead of after an unrelated paragraph.
  Deviation from the plan: **column x-padding was not implemented** (a `pdfFrag`
  carries no font size, so there is no honest points→characters scale; row
  separation alone removes the unreadability). **The duplicated caption was NOT
  dropped** — `captionFor` captures only the caption's FIRST line (the `alt` in
  the DB is visibly truncated mid-sentence), so removing the inline copy would
  lose the continuation. Consequently step 2's `<figcaption>` is also skipped:
  it would render the truncated caption a second time, right above the full one.
- 2026-07-29 — **step 2 (app) DONE.** `document-viewer.ts` `BASE_CSS`: figures get a
  blockquote-like frame (border + inset background + padding), the `<details>` block
  gets an aside rule + uppercase muted summary with a ▸/▾ marker and a tabular-numerals
  `<pre>`, and `table`/`th`/`td` get collapsed borders + `overflow-x:auto` — the viewer
  had **zero** table CSS before, so a GFM table rendered borderless with no cell padding
  under the `*{margin:0;padding:0}` reset. Page-mode caps added to match `pre`/`img`
  (`html.pg table`, `html.pg details`), with the inner `pre` cap released so the block
  scrolls once, not twice.
  Verified: 4 new checks in `e2e/integration.js` (`runFigureRendering`, seeded
  `FIGURE_DOC`) asserting **computed** style — `just e2e-int` 43/43; figure frame checked
  live on the arXiv document (`tmp/screenshots/figure-frame.png`); the collapsed block
  and table rendered from the real `BASE_CSS`
  (`tmp/screenshots/figure-css-{collapsed,open}.png`). `just e2e` and `just lint` green.
  Test gotcha worth keeping: `innerText` reads **empty** inside a collapsed `<details>`
  (no layout) — assert on `textContent`, or the check fails on working code.
- **Still open** (unchanged by this work): the duplicated caption, and a real
  `| a | b |` table (the go-fitz fork, §3a).

# PDF tables: current mechanism, options, recommendation

## 1. The actual output

Document `6de6f09d-2260-54bf-acff-84385268afa0` — *"Why are all LLMs Obsessed with Japanese
Culture?"*, `https://arxiv.org/pdf/2604.21751`, 88,629 chars of markdown, 22 figure images.
Eleven of the 22 are `Table N`.

Around **Table 1** the markdown reads (verbatim, DB `documents.markdown`):

```
![Table 1: Frontier Model outputs for 24 languages. Own counts references to countries in which the language is an](/api/v1/media/a9a84629-a681-5e13-9d3e-36e92addcce4)

Model Own (%) NA

GPT 24,763 (.78) 1,136 811 944 451 237 Gemini 20,172 (.64) 1,853 1,493 1,493 673 473 Claude 20,585 (.65) 2,063 1,601 1,200 510 560 Llama 20,775 (.66) 887 2,701 1,074 453 524 Command-r 13,707 (.43) 4,815 936 2,064 567 512 Magistral 23,040 (.73) 2,485 1,754 1,254 496 560 Qwen 22,572 (.71) 1,502 1,861 483 249 434 DeepSeek 21,907 (.69) 877 2,104 1,006 541 608 Table 1: Frontier Model outputs for 24 languages. Own counts references to countries in which the language is an official language. NA denotes missing responses. …

[…a paragraph of unrelated body prose…]

Div Ent

289 265 128 150 134 234 53 87 82 0.40 439 344 310 271 164 125 75 240 113 0.50 210 218 138 172 340 349 122 141 95 0.48 587 265 190 173 75 222 61 132 102 0.49 504 389 515 309 209 259 113 142 120 0.59 632 392 264 390 315 339 163 211 88 0.47 191 170 60 158 222 67 58 60 79 0.40
```

Table 10 is the same shape:

```
![Table 10: Diversity scores by language for different](/api/v1/media/7cbe8a3f-b38e-5f6b-ab58-d6906c3abad6)

Language AVG

en 160 171 159 135 170 145 152 165 157 zh 127 165 125 157 188 137 98 143 142 hi 33 69 18 58 52 60 47 107 56
```

Three distinct defects are visible here, and only one of them is "we don't parse tables":

1. **Rows are glued into one paragraph.** `GPT … Gemini … Claude …` was eight printed lines.
2. **Column groups are torn apart and re-ordered.** The header `Model Own (%) NA` is missing
   its rotated country columns; the right-hand `Div Ent` block and its numbers land *after* an
   unrelated paragraph, because the two-column gutter logic sorted them into the "right column".
3. **The caption is duplicated** — once as invisible image `alt`, once inline in the blob.

## 2. Current mechanism, exactly

There is **no table code anywhere in the pipeline.** Tables are detected only incidentally
(they are ruled drawings, so `figureBoxes` picks them up), and their text goes through the
same path as body prose.

### Text: glyphs → lines → fragments → reflowed paragraphs

| Step | Location |
|---|---|
| Read PDF, per-page loop | `server/internal/worker/pdf.go:218` `extractPDF` |
| Glyphs → baseline-grouped lines | `pdf.go:621` `groupLines` |
| Document-wide two-column gutter x | `pdf.go:514` `documentGutter` (median of gap votes) |
| Line split at the gutter, tagged with `x`,`y` | `pdf.go:580` `pageFragments` → `pdf.go:673` `splitAtGutter` |
| Fragments emitted left-column-first, then right | `pdf.go:594-602` |
| **Wrapped lines glued back into paragraphs** | `pdf.go:350` `reflowParagraphs` |
| Joined per page into the markdown | `pdf.go:260-269` |

`reflowParagraphs` is the direct cause of defect (1). Its heuristic is *"a line that reaches
(4/5 of) the modal column width was wrapped, so glue it to the next"* (`pdf.go:391`,
`fullLineWidth` at `pdf.go:438`). A table row of numbers spans the full column width, so every
row reads as a wrapped line and eight rows become one paragraph. The comment at `pdf.go:433`
even names tables as a known distorter of the width statistic — the guard is on the *mode*, not
on tables themselves.

Defect (2) is `splitAtGutter` + the left-then-right ordering at `pdf.go:594-602`: a wide table
straddles the gutter, its right-hand columns get classified as "right column" text and are
emitted after everything in the left column.

### Figures: content-stream boxes → MuPDF raster crop

| Step | Location |
|---|---|
| Walk content stream for drawings (`cm`/`Do`/path ops) | `server/internal/worker/pdffig.go:101` `pageDrawings` |
| Cluster boxes within 12 pt, drop < 60×40 pt | `pdffig.go:212` `clusterBoxes`, `pdffig.go:237` `figureBoxes` |
| Drop boxes repeating on > half the pages | `pdffig.go:250` `dropRepeating` |
| Caption = nearest `Figure/Table/…` line within 40 pt | `pdffig.go:287` `captionFor` (`pdffig.go:282` prefix list **includes `table`**) |
| Splice `![caption](sam-figure:N)` into the fragment stream at the box's `y` | `pdf.go:281` `spliceFigures` → `pdf.go:412` `pdfFigure.markdown()` |
| Render page at 150 dpi (MuPDF), crop per box, write PNG | `server/internal/worker/pdfrender.go:53` `renderPage`, `:137` `writeFigurePNG` |
| `media_assets` row, synthetic `pdf://<doc>/p<page>/fig<n>` URL | `pdfrender.go:112` |
| Placeholder → `/api/v1/media/<id>` | `pdfrender.go:127`, applied by `pdffig.go:423` `resolveFigures` |

Critically: **`spliceFigures` inserts the image but never removes the text that lives inside the
box.** `pdfFigure.box` is known, and every `pdfFrag` carries `x`/`y` (`pdf.go:570`) — the
geometry needed to tell "this line is inside Table 1" is already computed and simply not used.
`captionFor` at `pdffig.go:301` already applies exactly this test (`default: continue // inside
the figure`) for caption selection.

The behaviour is documented as deliberate — `server/CLAUDE.md`: *"Tables are detected too … you
get both the crop and the flattened table text. Deliberate: the column-flattened text of a table
is often unreadable, the picture is not."* The owner agrees with the picture half; the complaint
is that the unreadable half is sitting in the reading flow.

### Rendering: markdown → HTML → WebView

| Step | Location |
|---|---|
| `buildDocumentHtml` | `app/src/markdownToHtml.ts:31-39` |
| markdown → HTML (`marked` v18, `{breaks:true}`, GFM on, **no sanitizer**) | `markdownToHtml.ts:1,4,6-8` |
| Post-passes: `markDocumentLinks` → `absolutizeImgs` | `markdownToHtml.ts:14-20`, `:25-29`, composed at `:37` |
| Body wrapper `<div id="sam-article">` | `markdownToHtml.ts:69-85` `wrapViewerHtml` |
| CSS source of truth (`BASE_CSS`) | `app/src/webview/document-viewer.ts:74-160`; injected at `:162-167` |
| The **only** `img` rule | `document-viewer.ts:87` — `img{max-width:100%;border-radius:6px;margin-bottom:1em}` |
| Generated bundle (never hand-edit; `just webview-build`) | `app/src/webview/document-viewer-bundle.ts` |
| Both web (`<iframe srcDoc>`) and native (`<WebView>`) use the same HTML | `app/app/(drawer)/document/[id].tsx:546-566` |

Consequences for any near-term fix:

- **Raw HTML passes through.** No DOMPurify anywhere in `app/`; marked v18 dropped `sanitize`.
  A `<figure>`/`<figcaption>`/`<details>` block written into the markdown reaches the DOM intact.
  Caveat: marked's block-HTML rule terminates on a blank line — raw blocks must be contiguous.
- **GFM tables parse but are completely unstyled.** `grep -c table app/src/webview/document-viewer.ts`
  → **0**. With the `*{margin:0;padding:0}` reset at `document-viewer.ts:76`, a `<table>` renders
  with no borders, no cell padding, no collapse, and can overflow the 720 px body.
- **The `alt` text is invisible.** Every caption we already extract is thrown away visually.
- **A second, divergent image path exists** for feed cards: `app/src/MarkdownBody.tsx:20-23` →
  `app/src/ImageViewer.tsx` (its own absolutization at `:24`, tap-to-zoom Modal at `:41-60`).
  A `<figure>` change in the WebView path does **not** affect it.

## 3. Can tables actually be parsed? (options)

### 3a. MuPDF's own table detection — it is there, we already link it, it is not exposed

Verified against the MuPDF headers **vendored inside our own dependency**
(`gen2brain/go-fitz@v1.28.2`, `include/mupdf/fitz/structured-text.h`, `FzVersion = "1.28.0"`):

```c
enum { …, FZ_STEXT_SEGMENT = 4096, …, FZ_STEXT_TABLE_HUNT = 16384, … };
enum fz_stext_block_type { …, FZ_STEXT_BLOCK_GRID = 4 };

void fz_table_hunt(fz_context *ctx, fz_stext_page *page);
void fz_table_hunt_within_bounds(fz_context *ctx, fz_stext_page *page, fz_rect bounds);
fz_stext_block *fz_find_table_within_bounds(fz_context*, fz_stext_page*, fz_rect);
int fz_segment_stext_page(fz_context *ctx, fz_stext_page *page);
```

And MuPDF's own writers already serialise grids:
`source/fitz/stext-output.c:562` `fz_print_stext_table_as_xhtml` emits
`<table style="border-collapse: collapse;">` / `<tr>` / `<td>` with per-cell border flags
(reached from `fz_print_struct_as_xhtml` at `:820` when a struct block is `FZ_STRUCTURE_TABLE`);
the **XML** writer emits `<grid xpos="…" ypos="…">` with explicit column/row positions
(`stext-output.c:1075`) — the better target for programmatic use. `mutool draw`'s `-t` flag is
the CLI surface for the same thing.

**But go-fitz does not expose any of it.** Its full exported surface is
`New/NewFromMemory/NewFromReader`, `Bound`, `Close`, `HTML(page,header)`, `Image`, `ImageDPI`,
`ImagePNG`, `Links`, `Metadata`, `NumPage`, `SVG`, `Text`, `ToC` — no stext, no options, no
block enumeration. And it hard-codes the flags:

- `fitz_cgo.go:472` — `Text()`: `opts.flags = 0`
- `fitz_cgo.go:520` — `HTML()`: `opts.flags = C.FZ_STEXT_PRESERVE_IMAGES`
- `fitz_cgo.go:543` — emits **layout** HTML (`fz_print_stext_page_as_html`), not the XHTML
  writer that contains the table code.

So `Document.HTML()` will never produce a `<table>` no matter what we do at the call site.
The gap is ~40 lines of cgo in a fork: set `FZ_STEXT_SEGMENT | FZ_STEXT_TABLE_HUNT |
FZ_STEXT_COLLECT_STRUCTURE | FZ_STEXT_ACCURATE_BBOXES`, then call
`fz_print_stext_page_as_xml` (or `…_as_xhtml`) instead. The vendored static
`libmupdf_linux_amd64.a` is built from full MuPDF source, so `stext-table.c` is already inside
the archive we link — **no new system dependency, no new binary weight, no rule-6 change.**

There is repo precedent for exactly this pattern: `mxschmitt/playwright-go` (see root
`CLAUDE.md`). A `symunona/go-fitz` fork + a `replace` directive is the same move.

### 3b. Everything else

| Option | Vector/ruled tables | Pure Go / single binary | Verdict |
|---|---|---|---|
| **MuPDF `fz_table_hunt` via a go-fitz fork** | ✓ (both lattice and hunted) | cgo, but the *same* cgo we already have; no new deps | **Best ceiling.** Costs a fork to maintain. |
| **Hand-rolled lattice parser** (pdfplumber "lattice" mode) | ✓ where rules are drawn | ✓ pure Go, zero new deps | **Cheapest real parse.** We *already* collect every `re`/`m`/`l` segment in `pageDrawings` (`pdffig.go:155-171`) and every glyph with `X`,`Y`,`W`,`FontSize`. Cluster horizontal/vertical rules → grid; bucket glyphs into cells. ~300–400 lines. Fails on borderless "stream" tables (arXiv `booktabs` style has only 3 rules — top/mid/bottom — so it degrades to row detection, not column detection). |
| **pdfplumber "stream" mode** (x-position clustering, no rules) | ✓ | ✓ | Needed for `booktabs`. Doable — we have x per glyph — but this *is* the hard part of table extraction and is where accuracy goes to die. |
| **Camelot / Tabula** | ✓ | ✗ Python / Java sidecar | **Rejected — violates rule 6** (single binary, no sidecars) and rule "no Docker". Non-starter. |
| **`pdftotext -layout`** (poppler) | column *spacing* only, no structure | ✗ external binary | **Rejected** — sidecar, and it only preserves whitespace; we would still have to parse columns out of it, i.e. the same work with a worse input. |
| **LLM pass over text + figure PNG** | ✓ (best quality on messy tables) | ✓ — adapters already exist | **Viable but architecturally awkward.** See below. |

### 3c. The LLM option, honestly assessed

We already have provider-agnostic adapters (`[llm]` in `config.toml`, Anthropic native +
OpenAI-compatible). Sending the rendered table PNG plus the flattened text to a vision model and
asking for GFM is by far the highest-accuracy path per unit of engineering effort.

**Cost.** A 150 dpi crop of a half-page table is roughly 1000×600 px ≈ **800 image tokens**
(~w·h/750), plus ~300 tokens of flattened text in, ~600 out. At **Haiku 4.5 ($1 / $5 per MTok)**
that is ~$0.004 per table — this 22-figure paper costs **under 5 cents**, and eleven of those
figures are tables. Sonnet 5 ($3 / $15) would be ~$0.012/table. Cheap in absolute terms; the
tier fits the existing "triage → cheap/local or Haiku" rule.

**The problem is not cost, it is rule 4.** `Scraper → Document` is defined as *shared,
opinion-free*, and `Pipeline → Highlight` must *never re-fetch*. A table transcription is
opinion-free and deterministic-ish, so it belongs on the Scraper side — but no Scraper today
calls an LLM, and doing so makes every PDF scrape depend on a network LLM and its failure modes.
Putting it in a Pipeline instead means a Pipeline mutates `Document.markdown`, which breaks the
phase split from the other direction.

Also **rule 5**: a credentialed/paywalled PDF must not be sent to a cloud LLM by default. That
means the table pass must be routed to a local provider (the `xayah` Ollama box on the tailnet,
per memory) whenever the source is gated — an extra branch, not a blocker.

**Verdict:** viable as an *opt-in enrichment job* (its own `Job` kind with cost metering, run
after the Document exists, provider chosen by whether the source was gated), not as part of the
scrape. It is the fallback for tables the deterministic parser gets wrong, not the primary path.

## 4. Rendering improvements available today

The user's stated minimum is *"at least circle around for the pic like blockquote or
something"*. That is one CSS rule and one regex pass, and there is a bigger free win sitting
next to it.

### 4a. Frame + caption the figure (`<figure>` / `<figcaption>`)

Every figure already carries a caption in `alt` — currently invisible. Add a post-pass beside
`absolutizeImgs`, composed into `buildDocumentHtml` at **`app/src/markdownToHtml.ts:37`**
(defined near `:25-29`), that rewrites `<img alt="…" src="…">` into
`<figure><img …><figcaption>…</figcaption></figure>`. Two ordering notes:

- Run it **after** `absolutizeImgs` so that pass still sees a bare `<img`.
- marked wraps a lone image in `<p>`; strip the enclosing `<p>` when it contains only the image,
  or the browser will unwrap the invalid nesting for you unpredictably.

Alternative, cleaner: a `marked.use({renderer: {image(token){…}}})` override next to
`markdownToHtml.ts:4` — it gets structured `href`/`text` instead of regex-over-HTML, but it also
applies to `mdToHtml` (highlight bodies at `[id].tsx:237`), which may or may not be wanted.

CSS goes next to the `img` rule at **`app/src/webview/document-viewer.ts:87`**, then
`just webview-build`. Something like a subtle border + inset background + small italic caption —
the "blockquote for pictures" the user asked for. **Add `table` CSS in the same edit** (there is
currently none) and wrap wide blocks in `overflow-x:auto`, so that GFM tables are ready when
they arrive.

If the intent is also to affect **feed cards**, that is a second edit in
`app/src/MarkdownBody.tsx` / `ImageViewer.tsx` — the two image paths do not share code.

### 4b. Move the table text out of the prose stream — the real cheap win

This is server-side and it is small, because the geometry already exists.

In `spliceFigures` (`server/internal/worker/pdf.go:281`), the `lines` slice built at
`pdf.go:286-289` already holds every fragment's `y`/`x`/`text`, and `b` is the figure box.
Partition the fragments: those whose baseline falls **inside** `b` are the figure's interior
text (table cells, axis labels, in-plot legends) — exactly the test `captionFor` already
performs at `pdffig.go:301`. Instead of leaving them in the reading stream:

1. Remove them from `frags` (so `reflowParagraphs` never sees them — this alone kills defect (1)
   *and* defect (2), since the torn-off `Div Ent` block is also inside the box).
2. Re-emit them, in `y`-then-`x` order, immediately after the figure, inside a collapsible:

```markdown
![Table 1: Frontier Model outputs for 24 languages…](/api/v1/media/a9a8…)

<details><summary>Table 1 — text</summary><pre>
Model      Own (%)        NA
GPT        24,763 (.78)   1,136  811  944  451  237
Gemini     20,172 (.64)   1,853  1,493 1,493 673 473
…
</pre></details>
```

`<details>` and `<pre>` both survive marked untouched (no sanitizer). The text stays in
`documents.markdown`, so it stays searchable, stays in the export vault, and stays available to
`DetectFalseParse` and the pipeline — it is only visually subordinate. Keep the block contiguous
(no blank lines inside) or marked's block-HTML rule will split it.

Because each fragment carries `x`, padding to columns in the `<pre>` is nearly free and turns
the blob into something a human can actually read — this is the pdfplumber "stream mode" idea in
its weakest, safest form: preserve alignment, do not claim to have parsed a grid.

3. Drop the duplicated caption line (the `Table 1: …` sentence currently appears both in `alt`
   and inline) once `<figcaption>` renders it.

Two guards worth writing tests for: a figure whose interior text is the *whole* page (a
mis-detected box) must not swallow the body — cap the fraction of a page's fragments a single
figure may absorb; and `DetectFalseParse` must still see the text (it does — it reads
`documents.markdown`, which still contains everything).

## 5. Recommendation

### Cheap win now (this week, no new dependencies)

1. **Server** — `pdf.go:281` `spliceFigures`: move box-interior fragments out of the prose
   stream and re-emit them under the figure as a `<details><pre>` block, x-padded to columns.
   Drop the now-duplicated caption line. Unit tests: interior-text partition; the whole-page
   guard; searchability (`markdown` still contains every number).
2. **App** — `markdownToHtml.ts:37` (+ helper near `:25-29`): `<figure>`/`<figcaption>` pass.
   `document-viewer.ts:87`: figure frame CSS, `figcaption` styling, `details`/`summary`/`pre`
   styling, **and** table CSS with `overflow-x:auto`. Then `just webview-build`.
3. Verify with `just robot-browser` on this exact document: assert the `<figure>` renders with a
   visible caption, the `<details>` is collapsed by default, and the numbers are still present in
   the DOM (searchable) — plus `just e2e` green and `just build` with cgo.

This delivers the user's stated minimum, removes all three observed defects, and costs nothing
architecturally. It does **not** produce a real table.

### Proper fix later (when a real `| a | b |` table is worth it)

Fork `gen2brain/go-fitz` (precedent: `mxschmitt/playwright-go`), add one method that builds an
`fz_stext_page` with `FZ_STEXT_SEGMENT | FZ_STEXT_TABLE_HUNT | FZ_STEXT_COLLECT_STRUCTURE` and
serialises via `fz_print_stext_page_as_xml`, then parse the `<grid>`/`<td>` output into GFM.
Match each detected grid's bbox against the figure boxes we already compute, so a table becomes
*image + real markdown table* and a chart stays *image + `<details>` text*. Everything needed is
in the archive we already link — no new system package, no sidecar, no rule violated.

Only if that proves too lossy on borderless `booktabs` tables, add the **LLM enrichment job**
(§3c) as a targeted fallback: its own `Job` kind with cost metering, ~$0.004/table on Haiku 4.5,
routed to the local provider whenever the source was gated (rule 5). Do **not** put it in the
scrape path — that would put a network LLM on the critical path of every PDF and blur rule 4.

**Not recommended at any point:** Camelot, Tabula, `pdftotext -layout`. All three are sidecars
and are ruled out by the single-binary rule; the first two would also drag Python or a JVM onto
a 4 GB box.
