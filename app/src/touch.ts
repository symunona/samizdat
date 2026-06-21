import { Platform } from 'react-native'

// "web vs mobile" = touch vs non-touch, NOT Platform.OS (see app/CLAUDE.md).
// Native builds are always touch; on web, branch on pointer capability.
// Pointer capability does not change at runtime, so a plain function is fine.
export function isTouchDevice(): boolean {
  if (Platform.OS !== 'web') return true
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
}
