---
created: 2026-07-01
topic: Local Android APK build + self-hosted distribution + in-app version checker
excerpt: Build a debug APK locally, serve it from the server like the clipper zip, expose a download + "update available" card in app Settings.
status: done
---

## Outcome (2026-07-01)
Shipped. `just build-android` produces a standalone debug-signed release APK
(`dist/samizdat.apk`, 123MB, `sam.tmpx.space` v0.0.1/vc1) + sidecar manifest.
Server serves it at `/download/samizdat.apk` + `/api/v1/app/android/version`.
Settings shows an "App Version" card: current version, "Update available" +
"Download update (.apk)" when the hosted version_code exceeds the build's, and a
plain download button on web. Verified end-to-end via robot-browser (both the
up-to-date and update-available states).

### Build gotchas on the 4GB VPS (Expo SDK 56 / RN 0.85 / Gradle 9.3.1)
- **OOM**: gradle spins multiple JVMs. Fixed via `~/.gradle/gradle.properties`:
  no daemon, `kotlin.compiler.execution.strategy=in-process` (no 2nd Kotlin
  daemon), `workers.max=1`, `parallel=false`, `-Xmx900m -XX:MaxMetaspaceSize=512m
  -XX:+UseSerialGC`. JS bundle is a separate `createBundleReleaseJsAndAssets`
  gradle invocation so Metro/node never coexists with the Kotlin/dex compile.
- **foojay crash**: RN 0.85 gradle-plugin pins foojay-resolver 0.5.0 →
  `JvmVendorSpec.IBM_SEMERU` removed in Gradle 9. Fix: `auto-download=false` +
  a user-local Temurin JDK 17 (`~/.jdks`, registered via `installations.paths`).
- **lint OOM**: skip `-x lintVitalRelease` (class-heavy, useless for a test APK).
- **missing deps/assets**: added `babel-preset-expo` devDep (pnpm didn't hoist
  it); `connect.tsx` referenced a nonexistent `favicon.png` → pointed native at
  `icon.png`.
- `ANDROID_HOME` persisted in `~/.bashrc`.

# Android APK build + hosting + version checker

## Goal
1. Build a **test/debug Android APK** locally (managed Expo → prebuild → gradle).
2. **Host the APK on the API** — mirror the existing clipper-extension serving
   (`/extension/sam-chrome.zip` + `/api/v1/extension/version`).
3. **Expose the APK on the webapp** — download link in Settings.
4. **Version checker** — Settings shows current app version; if a newer build is
   hosted, show "Update available → Download".

## Constraints
- 4GB RAM production VPS also serving live sites → **memory-capped** gradle build.
- applicationId = `sam.tmpx.space` (user choice).
- Expo SDK 56 / RN 0.85.3; SDK has android-34/build-tools 34 only → gradle
  auto-downloads sdk 36 + build-tools 36 via cmdline-tools/latest. No NDK (RN
  ships prebuilt native libs via Maven; Expo modules are Kotlin/Java).

## Design — mirror the extension pattern
Server already serves the clipper zip + a version endpoint that reads the
*served artifact* so the reported version can't drift. APKs can't be cheaply
introspected (versionCode lives in binary AndroidManifest), so the build writes
a sidecar `<apk>.json` manifest atomically next to the apk; the version handler
reads that file per request.

### Server (`server/`)
- `config.go`: add `APKPath string \`toml:"apk_path"\`` to `ServerSection`.
- `internal/api/appdownload.go` (new): mirror `extension.go`.
  - `appDownloadHandler(apkPath)` → `GET /download/samizdat.apk` (ServeFile + attachment).
  - `appVersionHandler(apkPath)` → `GET /api/v1/app/android/version` reads `apkPath+".json"`.
- `router.go`: `New(... apkPath string ...)`, register both when `apkPath != ""`.
- `main.go`: `--apk` flag + `c.Server.APKPath`, pass through.
- `config.example.toml`: document `apk_path`.

### App (`app/`)
- `app.json`: add `expo.android.package = "sam.tmpx.space"`, `expo.android.versionCode = 1`.
- `src/appVersion.ts` (new): export `APP_VERSION`, `APP_VERSION_CODE` from app.json (single source).
- `src/api.ts`: `AndroidBuild` type + `fetchLatestAndroidBuild(url,token)` + `androidApkUrl(url)`.
- `app/(drawer)/settings.tsx`: "App Version" card after Server Info.
  - Always show current version.
  - If `latest.version_code > APP_VERSION_CODE`: "Update available" + Download btn.
  - On web: always offer "Download Android APK" (sideload to phone).

### Build (`justfile`)
- `build-android` recipe: ANDROID_HOME=~/Android/Sdk, `expo prebuild -p android`,
  capped `./gradlew assembleDebug -Dorg.gradle.jvmargs=-Xmx1536m`, copy apk →
  `dist/samizdat.apk`, write `dist/samizdat.apk.json` manifest.
- `dev` recipe: add `--apk dist/samizdat.apk` flag.
- `config.toml`: set `apk_path`.

## Test
- `just build` green, `just lint` green.
- `just dev` restart (backend changed).
- `curl /api/v1/app/android/version` returns manifest; `/download/samizdat.apk` serves file.
- `just robot-browser` → Settings shows App Version card + download link.
