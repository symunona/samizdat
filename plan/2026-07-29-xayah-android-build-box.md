---
created: 2026-07-29
topic: Offload the Android APK build from taskbot (4GB VPS) to a configured remote build node (xayah, 12c/30GB) over Tailscale
excerpt: Generic `just setup-build-node <ssh-dest>` saves the node to a config file; `just build-android` defaults to building there. Source travels by git push over ssh (no GitHub), APK + version come back by rsync, build durations are logged and shown as estimates.
status: implemented — xayah provisioned, first remote build running (see Outcome)
---

# Remote Android build node (`setup-build-node` / `build-android-remote`)

## Why

`just build-android` on taskbot is RAM-starved by design: `~/.gradle/gradle.properties`
kills the daemon, `workers.max=1`, in-process Kotlin, `-Xmx900m`, SerialGC — all to survive
4GB while the VPS serves live sites. ~30–40 min, box unusable meanwhile.

xayah is a 12-core / 30GB desktop that already carries a full Android SDK.

## Recon (verified 2026-07-29)

| | taskbot | xayah |
|---|---|---|
| CPU / RAM | — / 4GB | 12 cores / 30GB + 19GB swap |
| Disk | tight | `/` 65G free (86% used), **`/media/symunona/data` 373G free** |
| SDK platforms | 34, 36 | 23, 30, 31, 33, 34, **36** ✓ |
| build-tools | 34, 35, **36.0.0** | 30.0.3, 34, 35, 36.1.0 — **36.0.0 missing** → sdkmanager fetches |
| NDK | 27.0.12077973, 27.1 | **27.0.12077973** ✓ |
| gradle cache | small | 6.2G warm (flutter) |
| JDK | `~/.jdks/jdk-17.0.19+10` | 8, 11, 18 — **no 17** ✗ |
| node / npm | v22.22.0 | v22.21.1 / npm 10.9.4 |
| just | yes | **yes** (`~/.local/bin/just`) |
| ssh | — | `ssh xayah` passwordless, direct Tailscale path |
| GitHub ssh | key = symunona | **none** (`Permission denied (publickey)`) |
| other load | live sites | ollama (GPU), pizza-app + 33m2 services |

Decisions: **native, not containerized** (Docker would duplicate ~8G of SDK+cache onto the
86%-full root partition and buy reproducibility a single-dev debug-signed APK doesn't need).
**Android APK only.** **Fail loud** when the node is unreachable. **Remote is the default.**

## Transport: git push taskbot → node, over ssh

`origin` is `https://github.com/symunona/samizdat.git` and xayah has no GitHub key, so a
"push to origin / pull there" loop needs a new deploy key or a PAT on xayah. Unnecessary —
taskbot→xayah ssh already works, and `git push` over it ships only the diff:

```
git push build-node HEAD:refs/heads/build          # taskbot → node, diff only
ssh <node> 'cd <ws> && git reset --hard build && git clean -fd'
```

- The node's checkout stays on a **detached HEAD**, and we push to `refs/heads/build`, which
  is therefore never the checked-out branch → no `receive.denyCurrentBranch` refusal, and no
  reliance on `updateInstead` magic (which *does* refuse when the remote tree is dirty — and
  a remote `just gen-icons` can dirty the tracked `app/assets/*.png`).
- `git clean -fd` **without `-x`** removes stray untracked files but keeps ignored ones —
  `node_modules`, `app/android/`, the gradle cache all survive. Never add `-x`.
- Consequence: **the build builds `HEAD`, so the tree must be committed.** Recipe asserts no
  modified/staged tracked files and dies with `✗ commit first — the node builds HEAD`.
  Untracked junk (`after.png`, `tmp/`) is fine. Pushing to `origin` is *not* required.

## Config file (written by setup, read by every build)

`config/build-node.env` — shell-sourceable so the justfile needs zero TOML parsing (matches
how the justfile already shells out); gitignored alongside `config/config.toml`.

```sh
BUILD_NODE_DEST=xayah                                     # ssh alias | ip | user@host
BUILD_NODE_WS=/media/symunona/data/build/sam               # checkout + node_modules
BUILD_NODE_GRADLE_HOME=/media/symunona/data/gradle-sam     # own cache, not flutter's
BUILD_NODE_ANDROID_HOME=/home/symunona/Android/Sdk
BUILD_NODE_JDK=/home/symunona/.jdks/jdk-17.0.19+10
BUILD_NODE_JOBS=6
```

One saved destination (single-dev; a nodes-registry only when a second node exists).
`just setup-build-node <dest> [workspace]` overwrites it. `git remote build-node` is set
locally to `<dest>:<ws>` by setup.

## `just setup-build-node <dest> [workspace]` — idempotent

1. Preflight `ssh -o BatchMode=yes -o ConnectTimeout=5 <dest> true`; require `git`, `node`,
   `just`, `unzip` on the node; warn if free space at `workspace` < 30G.
2. JDK 17 → `~/.jdks/` on the node if absent (Temurin **17.0.19+10**, same build as taskbot
   → identical toolchain, and RN 0.85's pinned foojay-resolver 0.5.0 crashes on Gradle 9 so
   auto-provisioning stays off).
3. `git init` the workspace, add taskbot as nothing (push-only), leave HEAD detached; first
   push happens in step 6.
4. Write `<gradle_home>/gradle.properties` — taskbot's caps **inverted**:
   ```properties
   org.gradle.java.installations.auto-download=false
   org.gradle.java.installations.paths=<jdk>
   org.gradle.daemon=true
   org.gradle.parallel=true
   org.gradle.workers.max=6
   org.gradle.caching=true
   org.gradle.jvmargs=-Xmx8g -XX:MaxMetaspaceSize=2g
   kotlin.compiler.execution.strategy=daemon
   kotlin.incremental=true
   ```
   Never touch the node's global `~/.gradle` — that's flutter's, 6.2G.
5. `yes | sdkmanager --licenses`; pre-install `build-tools;36.0.0` so build 1 doesn't stall
   on a download.
6. First push + `npm ci` (app, ~4G) + `tools/icongen` deps (sharp — fine on 30GB) so the
   first real build isn't paying setup costs.
7. **Ship `debug.keystore`** (see landmine 1) to `<ws>/../keystore/debug.keystore`.
8. Write `config/build-node.env`, set the `build-node` git remote, print a summary
   (dest, ws, JDK, SDK, free disk, node/npm versions).

## `just build-android` → remote by default

- `build-android [level]` — dispatch: config present **and** node reachable → remote;
  otherwise die with `✗ build node <dest> unreachable — 'just build-android-local' (~35 min)`.
- `build-android-remote [level]` — explicit.
- `build-android-local [level]` — today's recipe body, unchanged, the offline fallback.

Remote flow:

1. Preflight ssh + assert clean tracked tree.
2. **Bump locally** — `node tools/bump-version.mjs {{level}}`, then **commit** it
   (`chore(app): bump version to X.Y.Z`). taskbot stays the sole bumper: `versionCode` is
   wall-clock-monotonic and `extra.buildEpoch` is stamped here, and CLAUDE.md already
   warns an uncommitted bump regresses `versionCode` on the next read. Committing is
   mandatory anyway now that the node builds `HEAD` — the two constraints line up.
3. Print the estimate: `⏱ last remote build 4m12s (n=5, avg 4m30s) — see 'just build-times'`.
4. `git push build-node HEAD:refs/heads/build` → `git reset --hard build && git clean -fd`.
5. `npm ci` on the node **only if `sha256(app/package-lock.json)` differs** from a stamp
   file in the workspace.
6. Place the shipped keystore at `app/android/app/debug.keystore` **before** prebuild.
7. Build on the node (`just` is there, so this is a real recipe — `just _apk-build`, shared
   with the local path, parameterized by env):
   ```
   export GRADLE_USER_HOME=<gradle_home> ANDROID_HOME=<sdk> ANDROID_SDK_ROOT=<sdk>
   just gen-icons                     # sharp present; tracked PNGs regenerate identically
   npx expo prebuild --platform android --no-install
   rm -rf $TMPDIR/metro-* $TMPDIR/haste-map-* app/node_modules/.cache
   nice -n 10 ./gradlew :app:createBundleReleaseJsAndAssets --rerun-tasks
   nice -n 10 ./gradlew assembleRelease -x lintVitalRelease -PreactNativeArchitectures=arm64-v8a
   ```
   Two phases kept **not** for RAM but because `--rerun-tasks` on the bundle is what defeats
   gradle's up-to-date check missing `app.json` (stale Hermes bundle → in-app
   `APP_VERSION_CODE` behind the manifest → the updater offers the installed build to
   itself). `nice -n 10` keeps ollama responsive. Single ABI: 49M vs 123M.
8. **rsync back**: `app-release.apk` → `dist/samizdat.apk`, keeping the previous one as
   `dist/samizdat.apk.prev` for the signature check.
9. **Sidecar written locally** from the local `app/app.json` — `built_at` from
   `extra.buildEpoch`, never `new Date()` (CLAUDE.md). Nothing about the version travels
   back; the local repo is already authoritative. Version + APK both present locally = the
   stated goal.
10. `tools/verify-apk.sh dist/samizdat.apk --against dist/samizdat.apk.prev`.
11. `just deploy-android` (unchanged — restarts the service to re-register `/download`).
12. Append the duration to `config/build-times.json`.

## Build-duration log + estimates

`config/build-times.json` (gitignored), appended by both local and remote paths:

```json
[{"at":"2026-07-29T20:11:04Z","recipe":"build-android-remote","dest":"xayah","sec":252,"ok":true}]
```

- Printed at build start (step 3) as last / n / average — `just` `[doc(...)]` strings are
  static, so the doc line carries a coarse hint (`~4–5 min on a build node`) and points at
  `just build-times`.
- `just build-times` — table of the last N builds per recipe, with the local-vs-remote
  speedup.
- `just status` gains one line: `build node: xayah (reachable, last APK 4m12s)`.

## Landmines

1. **`debug.keystore` does not travel.** `app/.gitignore` ignores `/android` wholesale, so
   `app/android/app/debug.keystore` is untracked — git transport won't carry it and
   `expo prebuild` silently mints a *fresh* one when absent. Different debug key → Android
   refuses install-over on the phone, and the only symptom is "the update just doesn't
   install". Setup ships it; every build re-places it pre-prebuild; `verify-apk.sh` compares
   signer certs so this can never regress unnoticed.
2. **The keystore is one clean checkout from being lost forever** (untracked, in a
   gitignored tree). Move it to a stable gitignored path (`secrets/debug.keystore`, backed
   up to dropx) referenced by both build paths. Hardens local builds too.
3. **`git clean -x` would wipe `node_modules` + `app/android`** on the node → a 4G reinstall
   and a cold gradle build. `-fd` only.
4. **Node's global `~/.gradle` is flutter's** — inherit nothing from it; `GRADLE_USER_HOME`
   isolates cache *and* properties.
5. Node is a desktop: may be off/asleep → preflight, fail loud.
6. `build-tools;36.0.0` is absent on xayah (it has 36.1.0). Pre-install in setup.

## E2E self-test (write before implementing)

`tools/verify-apk.sh <apk> [--against <old-apk>]`, run at the end of both paths:

1. **Signer cert SHA-256 identical** to `--against` (`apksigner verify --print-certs`). The
   install-over guard; landmine 1 is invisible without it.
2. **versionCode** strictly greater than the previous sidecar's, equal to `app.json`'s.
3. **Bundle freshness** — `unzip -p assets/index.android.bundle` greps the new version /
   buildEpoch → proves phase 1 really re-bundled.
4. **Sidecar** — `built_at` parses to exactly `extra.buildEpoch`; `size` matches the file.
5. **Exactly one** `lib/arm64-v8a` ABI dir.
6. **Served** — after `deploy-android`, `curl /api/v1/app/android/version` reports the new
   version + code.
7. **Remote hygiene** — report any `GradleDaemon` left resident on the node (idle-timeout is
   fine, silently holding 8G is worth knowing).

Manual, once: install the node-built APK over the taskbot-built one on the phone. If it
installs without an uninstall, landmine 1 is genuinely handled.

## Steps

1. `tools/verify-apk.sh` + wire into the existing local build (proves the test catches
   nothing-yet-broken).
2. Stabilize the keystore path (landmine 2).
3. Extract shared pieces so local/remote can't drift: `tools/write-apk-sidecar.mjs`,
   `_apk-build` recipe (env-parameterized gradle phases), `_build-time-log`.
4. `just setup-build-node <dest> [ws]` + `config/build-node.env` + `.gitignore` entry.
5. `just build-android-remote`; rename current body → `build-android-local`; `build-android`
   dispatches remote-first.
6. `just build-times`, `just status` line.
7. Run both, compare wall clock, `verify-apk.sh --against`.
8. Manual install-over test on the phone.
9. `diff_review` → append `CLAUDE.md` (build node, git-push transport, keystore rule,
   commit-required, fail-loud, `-fd` not `-fdx`).
