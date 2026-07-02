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
