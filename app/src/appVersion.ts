// The running build's version + version code. On native we read them from the
// installed APK's manifest via expo-application (gradle stamps these from
// app.json at build time), so the in-app version can NEVER drift from the
// actual installed artifact — even if the JS bundle is stale. On web there is
// no native layer, so we fall back to app.json read at bundle time.
//
// The Settings screen compares APP_VERSION_CODE to the latest hosted APK's
// version_code (from the server's sidecar) to offer an update download.
import * as Application from 'expo-application'
import appJson from '../app.json'

export const APP_VERSION: string =
  Application.nativeApplicationVersion ?? appJson.expo.version

// nativeBuildVersion is the Android versionCode (a numeric string) / iOS build.
export const APP_VERSION_CODE: number = Application.nativeBuildVersion
  ? Number.parseInt(Application.nativeBuildVersion, 10)
  : appJson.expo.android.versionCode

// When this bundle was built (ms), stamped into app.json by tools/bump-version.mjs.
// Bundled into the JS at build time, so it travels inside the installed APK.
export const APP_BUILD_EPOCH: number = (appJson.expo as { extra?: { buildEpoch?: number } }).extra?.buildEpoch ?? 0

// Git commit baked into THIS web bundle at build time (justfile build-app-web sets
// EXPO_PUBLIC_BUILD_COMMIT to the same short-SHA the server stamps into /health).
// The web build has no APK to update; instead we compare this to the live server's
// /health commit — a mismatch means the tab is running a stale bundle → prompt reload.
export const WEB_BUILD_COMMIT: string = process.env.EXPO_PUBLIC_BUILD_COMMIT ?? ''

// Single source of truth for "is the hosted APK newer than what's installed?".
// versionCode is monotonic (see bump-version.mjs), so a higher code always means a
// newer build. The built_at fallback offers a rebuild even at an equal code — a
// belt-and-braces guard so a fresh build is never silently ignored.
export function isUpdateAvailable(build: { version_code: number; built_at?: string }): boolean {
  if (build.version_code > APP_VERSION_CODE) return true
  if (build.version_code === APP_VERSION_CODE && build.built_at) {
    return Date.parse(build.built_at) > APP_BUILD_EPOCH
  }
  return false
}
