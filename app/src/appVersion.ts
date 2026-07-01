// Single source of the running build's version, read from app.json at bundle
// time. The Settings screen compares APP_VERSION_CODE to the latest hosted APK's
// version_code to offer an update download.
import appJson from '../app.json'

export const APP_VERSION: string = appJson.expo.version
export const APP_VERSION_CODE: number = appJson.expo.android.versionCode
