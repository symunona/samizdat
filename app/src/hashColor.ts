// Stable text → badge colour. FNV-1a hash → hue on the colour wheel; fixed
// saturation/lightness keeps every generated colour readable with white text.
export function hashColor(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const hue = (h >>> 0) % 360
  return `hsl(${hue}, 55%, 42%)`
}
