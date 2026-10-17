// Keys that turn the page in page mode, as a page delta. Dependency-free so the
// WebView bundle can inline it: the viewer handles them when focus is inside the
// frame, the document screen forwards them when focus is on the host around it.
export const PAGE_TURN_KEYS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -1, PageDown: 1 }
