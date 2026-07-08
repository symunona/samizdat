# Samizdat task runner — https://github.com/casey/just
# Run `just` to list recipes grouped by component.

set shell := ["bash", "-uc"]

# Port + config path read from repo-local config.toml if present, else global ~/.samizdat/config.toml
_dev_port := `if [ -f config.toml ]; then grep -E '^\s*port\s*=' config.toml | grep -oE '[0-9]+' | head -1; else echo 8765; fi`
_config_flag := if path_exists("config.toml") == "true" { "--config " + justfile_directory() + "/config.toml" } else { "" }
# Per-instance service name (multi-checkout installs): samizdat-<repo dir name>
_instance := file_name(justfile_directory())

# List available recipes
default:
    @just --list

# ── Setup ─────────────────────────────────────────────────────────────────────

[group('setup')]
[doc('Install dev environment from a git clone (needs Go 1.22+)')]
install-dev: _check-go _check-just setup-cli setup-server setup-app setup-tooling
    @echo ""
    @echo "Dev env ready."
    @echo "  Build:      just build"
    @echo "  Run server: just dev"
    @echo ""
    @echo "Tip — enable just tab completion (pick your shell):"
    @echo "  bash:  just --completions bash >> ~/.bash_completion"
    @echo "  zsh:   just --completions zsh > ~/.zfunc/_just && echo 'fpath=(~/.zfunc \$fpath)' >> ~/.zshrc"
    @echo "  fish:  just --completions fish > ~/.config/fish/completions/just.fish"
    @echo ""
    @echo "Or let sam do it: sam setup"

[group('setup')]
[doc('Install deps for every component (run after cloning)')]
setup: setup-server setup-cli setup-app setup-clipper setup-tooling

[group('setup')]
setup-server:
    cd server && go mod download 2>/dev/null || echo "server/ not initialized yet (go mod init)"
    @echo "→ Installing Playwright browsers (Chromium)..."
    cd server && go run github.com/playwright-community/playwright-go/cmd/playwright install chromium
    @echo "  Playwright browsers ready. (On a fresh Linux install, also run: npx playwright install-deps chromium)"

[group('setup')]
setup-cli:
    cd cli && go mod download 2>/dev/null || echo "cli/ not initialized yet (go mod init)"

[group('setup')]
setup-app:
    cd app && pnpm install

[group('setup')]
setup-clipper:
    cd clipper && npm install 2>/dev/null || echo "clipper/ not initialized yet"

[group('setup')]
setup-tooling:
    cd tooling && go mod download 2>/dev/null || echo "tooling/ not initialized yet"

_check-go:
    @command -v go >/dev/null 2>&1 || (echo "error: Go not installed — https://go.dev/dl/"; exit 1)
    @go version | grep -qE "go1\.(2[2-9]|[3-9][0-9])\." || (echo "error: Go 1.22+ required ($(go version))"; exit 1)

_check-just:
    @command -v just >/dev/null 2>&1 || (echo "error: just not installed — https://just.systems/"; exit 1)

# Checks configured port: stops our service automatically; kills unknown process with notice.
_check-no-service:
    @PORT={{_dev_port}}; \
    if ss -tlnp 2>/dev/null | grep -q ":$PORT"; then \
        if systemctl --user is-active --quiet samizdat-{{_instance}} 2>/dev/null; then \
            echo "samizdat-{{_instance}} user service running — stopping for dev mode..."; \
            systemctl --user stop samizdat-{{_instance}} && echo "Service stopped."; \
        elif systemctl is-active --quiet samizdat 2>/dev/null; then \
            echo "samizdat service running — stopping for dev mode..."; \
            sudo systemctl stop samizdat && echo "Service stopped."; \
        elif systemctl is-active --quiet samizdat-{{_instance}} 2>/dev/null; then \
            echo "samizdat-{{_instance}} service running — stopping for dev mode..."; \
            sudo systemctl stop samizdat-{{_instance}} && echo "Service stopped."; \
        else \
            PID=$(ss -tlnp | grep ":$PORT" | grep -oP 'pid=\K[0-9]+' | head -1); \
            if [ -n "$PID" ]; then \
                echo "Port $PORT in use by PID $PID ($(ps -p $PID -o comm= 2>/dev/null || echo unknown)) — killing..."; \
                kill $PID && sleep 0.5 && echo "Process killed."; \
            else \
                echo "Port $PORT in use — could not identify PID, trying fuser..."; \
                fuser -k ${PORT}/tcp && sleep 0.5 && echo "Port freed."; \
            fi; \
        fi; \
    fi

# Fails if configured port is occupied by a non-service process (i.e. a dev server is running).
# Our own service (legacy `samizdat` or per-instance `samizdat-<dir>`) is fine — install restarts it.
_check-no-dev:
    @PORT={{_dev_port}}; \
    if ss -tlnp 2>/dev/null | grep -q ":$PORT" \
        && ! systemctl --user is-active --quiet samizdat-{{_instance}} 2>/dev/null \
        && ! systemctl is-active --quiet samizdat 2>/dev/null \
        && ! systemctl is-active --quiet samizdat-{{_instance}} 2>/dev/null; then \
        echo "ERROR: dev server already running on :$PORT — stop it before installing the service"; \
        exit 1; \
    fi

# ── WebView bundle ────────────────────────────────────────────────────────────

[group('build')]
[doc('Compile document-viewer.ts → document-viewer-bundle.ts via esbuild')]
webview-build:
    @echo "Building document-viewer bundle..."
    cd app && node_modules/.bin/esbuild src/webview/document-viewer.ts --bundle --platform=browser --format=iife --outfile=/tmp/dvbuild.js --minify
    node scripts/wrap-webview-bundle.mjs

# ── Dev ───────────────────────────────────────────────────────────────────────

[group('dev')]
[doc('Build app + server, restart background server (dev mode, HTTP)')]
dev: _check-no-service webview-build build-server build-cli build-app-web build-clipper
    #!/usr/bin/env bash
    set -euo pipefail
    PORT={{_dev_port}}
    rm -rf /tmp/playwright_chromiumdev_profile-* /tmp/playwright-artifacts-* 2>/dev/null || true
    # Stop any dev server still holding the port BEFORE starting a new one. Without
    # this, a second `just dev` starts a process that fails to bind (port in use),
    # dies, and the readiness check below then "sees" the OLD process still on the
    # port and falsely reports success — the stale-binary trap. (_check-no-service
    # already handled the systemd service; this covers the orphaned dev nohup.)
    old=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    if [ -n "${old:-}" ]; then
      echo "stopping stale dev server (pid ${old}) on :${PORT}"
      kill "${old}" 2>/dev/null || true
      for i in $(seq 1 20); do ss -tlnp 2>/dev/null | grep -q ":${PORT} " || break; sleep 0.3; done
    fi
    nohup server/bin/samizdat serve {{_config_flag}} --webdir app/dist --extension-zip clipper/dist/sam-chrome.zip --apk dist/samizdat.apk > /tmp/samizdat-${PORT}.log 2>&1 &
    newpid=$!
    for i in $(seq 1 20); do ss -tlnp 2>/dev/null | grep -q ":${PORT} " && break || true; sleep 0.5; done
    # Verify OUR process is alive AND is the one bound — not a survivor on the port.
    if ! kill -0 "${newpid}" 2>/dev/null; then
      echo "✗ dev server (pid ${newpid}) exited on startup — last log lines:"; tail -8 "/tmp/samizdat-${PORT}.log"; exit 1
    fi
    lpid=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    if [ "${lpid:-}" != "${newpid}" ]; then
      echo "✗ :${PORT} is held by pid ${lpid:-none}, not our new server ${newpid} — a stale process survived; kill it and retry."; exit 1
    fi
    echo "✓ server started on :${PORT} (pid ${newpid}, commit $(git rev-parse --short HEAD 2>/dev/null || echo '?')), log: /tmp/samizdat-${PORT}.log"
    ./cli/bin/sam {{_config_flag}} connect

[group('dev')]
[doc('What server is on the dev port, which mode (dev nohup / systemd), and is it running the latest built code?')]
status:
    #!/usr/bin/env bash
    set -uo pipefail
    PORT={{_dev_port}}
    echo "── samizdat runtime (:${PORT}) ──"
    lpid=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    if [ -z "${lpid:-}" ]; then
      echo "  listener   : none — nothing serving :${PORT}  (start: 'just dev')"
    else
      ppid=$(ps -o ppid= -p "${lpid}" 2>/dev/null | tr -d ' ' || true)
      started=$(ps -o lstart= -p "${lpid}" 2>/dev/null || true)
      svc_main=$(systemctl --user show -p MainPID --value samizdat-{{_instance}} 2>/dev/null || echo 0)
      if [ "${svc_main:-0}" = "${lpid}" ]; then mode="systemd service (samizdat-{{_instance}})";
      elif [ "${ppid:-}" = "1" ]; then mode="dev nohup (orphaned to init)";
      else mode="dev (parent pid ${ppid:-?})"; fi
      echo "  listener   : pid ${lpid}"
      echo "  mode       : ${mode}"
      echo "  started    : ${started:-?}"
    fi
    echo "  binary     : server/bin/samizdat (built $(stat -c '%y' server/bin/samizdat 2>/dev/null | cut -d. -f1 || echo '?'))"
    head=$(git rev-parse --short HEAD 2>/dev/null || echo '?')
    [ -z "$(git status --porcelain 2>/dev/null)" ] || head="${head}-dirty"
    echo "  git HEAD   : ${head}"
    resp=$(curl -fsS "http://localhost:${PORT}/api/v1/health" 2>/dev/null || true)
    if [ -z "${resp}" ]; then
      echo "  live /health: (unreachable)"
    else
      live=$(printf '%s' "${resp}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.commit||"?")+" | built "+(j.built_at||"?"))}catch{process.stdout.write("?")}})' 2>/dev/null || echo '?')
      lc=$(printf '%s' "${resp}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).commit||"")}catch{process.stdout.write("")}})' 2>/dev/null || echo '')
      echo "  live /health: ${live}"
      if [ -z "${lc}" ] || [ "${lc}" = "unknown" ]; then
        echo "  verdict    : ⚠ running server has NO build stamp (built before this feature) — restart with 'just dev'"
      elif [ "${lc}" = "${head}" ]; then
        echo "  verdict    : ✓ FRESH — running code matches git HEAD"
      else
        echo "  verdict    : ✗ STALE — running ${lc}, HEAD is ${head}. Restart: 'just dev' (dev) or 'just restart' (service)"
      fi
    fi

[group('dev')]
[doc('Build + run the sam CLI with args (e.g. just sam connect)')]
sam *args: build-cli
    ./cli/bin/sam {{_config_flag}} {{args}}

[group('dev')]
[doc('Run the Expo app (native/Expo Go)')]
app:
    cd app && npx expo start 2>/dev/null || echo "app/ not initialized yet"

[group('dev')]
[doc('Build the clipper extension, print the load-unpacked path')]
clipper: build-clipper
    @echo "Load unpacked in Chrome → chrome://extensions → 'Load unpacked' → $(pwd)/clipper/dist/unpacked"

[group('dev')]
[doc('Tail the live debug logs streamed by paired devices (see app Settings → Debug Log Streaming)')]
device-logs:
    #!/usr/bin/env bash
    mkdir -p tmp/device-logs
    echo "tailing tmp/device-logs/*.ndjson — open a paired device with debug streaming on…"
    tail -n +1 -F tmp/device-logs/*.ndjson 2>/dev/null || tail -F tmp/device-logs/

# ── Build ─────────────────────────────────────────────────────────────────────

[group('build')]
[doc('Build server + CLI')]
build: build-server build-cli

[group('build')]
[doc('Build the server static binary')]
build-server:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}/server"
    # Stamp version + commit + build time into the binary so a live server can
    # self-report which code it runs (GET /api/v1/health, /api/v1/me). version
    # tracks the single product version from app/app.json (bumped by `just bump`
    # / build-android) so server and app never diverge. `just status` compares
    # /health's commit to git HEAD to catch stale processes. `-dirty` = uncommitted.
    ver=$(python3 -c 'import json;print(json.load(open("{{justfile_directory()}}/app/app.json"))["expo"]["version"])' 2>/dev/null || echo 0.0.0-dev)
    commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
    [ -z "$(git status --porcelain 2>/dev/null)" ] || commit="${commit}-dirty"
    built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    pkg=github.com/symunona/samizdat/server/internal/api
    CGO_ENABLED=0 go build -ldflags "-X ${pkg}.version=${ver} -X ${pkg}.commit=${commit} -X ${pkg}.buildTime=${built}" -o bin/samizdat .

[group('build')]
[doc('Build the sam CLI')]
build-cli:
    cd cli && CGO_ENABLED=0 go build -o bin/sam .

[group('build')]
[doc('Export the Expo web build (served by the server)')]
build-app-web:
    #!/usr/bin/env bash
    set -euo pipefail
    # Bake the running commit into the bundle (same short-SHA the server stamps into
    # /health) so an open web tab can detect a redeploy and prompt a reload.
    commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
    [ -z "$(git status --porcelain 2>/dev/null)" ] || commit="${commit}-dirty"
    cd "{{justfile_directory()}}/app"
    EXPO_PUBLIC_BUILD_COMMIT="${commit}" pnpm expo export --platform web --output-dir dist --clear

[group('build')]
[doc('Package the clipper extension (dist/unpacked + dist/sam-chrome.zip)')]
build-clipper:
    cd clipper && npm run build

[group('build')]
[doc('Rasterize assets/samizdat.svg → app/assets icon PNG set (icon + adaptive fg/bg/monochrome)')]
gen-icons:
    #!/usr/bin/env bash
    set -euo pipefail
    # Isolated toolchain: the Expo app tree can't `npm i sharp` (arborist dedupe
    # crash on its linked deps), so icongen carries its own node_modules.
    cd "{{justfile_directory()}}/tools/icongen"
    [ -d node_modules ] || npm install --no-audit --no-fund
    node gen.mjs

[group('build')]
[doc('Bump app/app.json version (level=patch|minor|major) + versionCode +1')]
bump level="patch":
    node "{{justfile_directory()}}/tools/bump-version.mjs" {{level}}

[group('build')]
[doc('Build a standalone debug-signed Android APK locally, minimal RAM (JS bundled separately) → dist/samizdat.apk (+ .json). Auto-bumps version (level=patch|minor|major)')]
build-android level="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    # Auto-bump the version FIRST so prebuild stamps the new version/versionCode
    # into the native manifest. Default patch; `just build-android minor|major`
    # for the bigger bumps. See tools/bump-version.mjs + CLAUDE.md.
    node "{{justfile_directory()}}/tools/bump-version.mjs" {{level}}
    export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
    export NODE_OPTIONS="--max-old-space-size=1536"   # cap Metro's node heap
    # Pre-accept SDK licenses so gradle can auto-download compileSdk/build-tools.
    yes | sdkmanager --licenses >/dev/null 2>&1 || true
    # Rasterize the logo SVG → app/assets/*.png before prebuild reads them, so a
    # fresh assets/samizdat.svg always flows into the launcher icon.
    just gen-icons
    # Generate the native android/ project from managed config (idempotent).
    cd "{{justfile_directory()}}/app"
    npx expo prebuild --platform android --no-install
    cd android
    # Memory caps live in ~/.gradle/gradle.properties (one JVM, in-process Kotlin,
    # small heap) — this VPS has 4GB RAM and also serves live sites.
    # Phase 1 — JS bundle + Hermes bytecode ONLY. Runs Metro (node) while the
    # gradle JVM is idle, so node never coexists with the Kotlin/dex compile.
    # --rerun-tasks + a metro cache wipe force a FRESH bundle every build: gradle's
    # up-to-date check does NOT track app.json, so a version bump (or any source
    # change it misses) would otherwise ship a stale Hermes bundle — leaving the
    # in-app APP_VERSION_CODE behind the native manifest and the served sidecar,
    # which makes the updater offer an "update" to the version already installed.
    rm -rf "${TMPDIR:-/tmp}"/metro-* "${TMPDIR:-/tmp}"/haste-map-* app/node_modules/.cache 2>/dev/null || true
    ./gradlew :app:createBundleReleaseJsAndAssets --rerun-tasks
    # Phase 2 — compile + dex + package. The bundle above is up-to-date and gets
    # skipped, so no node here. Release is debug-signed + not minified (see
    # android/app/build.gradle) → a standalone, installable test APK. Skip
    # lintVitalRelease — it's class-heavy (blows metaspace) and pointless for a
    # local test build. reactNativeArchitectures=arm64-v8a ships ONE ABI (real
    # phones) instead of the default four (armeabi-v7a/arm64/x86/x86_64) — the
    # x86* pair is emulator-only and ~55MB of dead weight. Cuts the APK ~123M→~49M.
    ./gradlew assembleRelease -x lintVitalRelease -PreactNativeArchitectures=arm64-v8a
    cd "{{justfile_directory()}}"
    mkdir -p dist
    cp app/android/app/build/outputs/apk/release/app-release.apk dist/samizdat.apk
    # Sidecar manifest (version + versionCode from app.json), written atomically
    # with the copy so the served version never drifts from the served artifact.
    # built_at MUST derive from extra.buildEpoch (the value baked into the bundle as
    # APP_BUILD_EPOCH), NOT `new Date()`: the equal-versionCode fallback in
    # isUpdateAvailable compares built_at > APP_BUILD_EPOCH, and a fresh `new Date()`
    # (captured minutes after buildEpoch was stamped at build start) is ALWAYS later
    # than buildEpoch → the app would perpetually report an update against its own build.
    node -e 'const a=require("./app/app.json").expo,fs=require("fs");const st=fs.statSync("dist/samizdat.apk");const be=(a.extra&&a.extra.buildEpoch)||Date.now();fs.writeFileSync("dist/samizdat.apk.json",JSON.stringify({version:a.version,version_code:a.android.versionCode,size:st.size,built_at:new Date(be).toISOString()})+"\n")'
    echo "APK → dist/samizdat.apk ($(du -h dist/samizdat.apk | cut -f1))"
    # Auto-deploy so the fresh build is what the live server (and in-app updater) sees.
    just deploy-android

[group('build')]
[doc('Deploy dist/samizdat.apk to the live server so the in-app updater sees it (auto-run by build-android)')]
deploy-android:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    test -f dist/samizdat.apk && test -f dist/samizdat.apk.json || { echo "✗ no APK in dist/ — run 'just build-android' first"; exit 1; }
    # The server reads the APK + its sidecar per request, so a running instance serves
    # the fresh build with no copy step. The one thing that needs a restart is ROUTE
    # registration: the /download + version routes are only wired at startup when
    # apk_path is set — so restart the installed service if it's active to (re)register.
    if systemctl --user is-active --quiet samizdat-{{_instance}}; then
      systemctl --user restart samizdat-{{_instance}} && echo "↻ restarted samizdat-{{_instance}} service (re-registers /download routes)"
    elif ss -tlnp 2>/dev/null | grep -q ":{{_dev_port}} "; then
      # A DEV server (nohup) holds the port, not the systemd service — it won't
      # pick up new routes/code on its own. Warn loudly instead of silently skipping
      # (the old behaviour, which is what made "served old binary" keep happening).
      echo "⚠ a DEV server is running on :{{_dev_port}} (not the systemd service) — it will NOT pick up new routes/code."
      echo "  Restart it to serve this build:  just dev     (verify with: just status)"
    else
      echo "ℹ no server running on :{{_dev_port}} — start one with 'just dev' (dev) or 'just restart' (service)."
    fi
    # Verify: the live server should now advertise app.json's version to the updater.
    want=$(node -e 'const a=require("./app/app.json").expo;process.stdout.write(a.version+" / code "+a.android.versionCode)')
    resp=$(curl -fsS "http://localhost:{{_dev_port}}/api/v1/app/android/version" 2>/dev/null || true)
    if [ -n "$resp" ]; then
      got=$(node -e "const d=JSON.parse(process.argv[1]);process.stdout.write(d.version+' / code '+d.version_code)" "$resp" 2>/dev/null || echo "(unparseable /api/v1/app/android/version)")
    else
      got="(server not reachable on :{{_dev_port}})"
    fi
    echo "app.json : $want"
    echo "served   : $got"
    if [ "$want" = "$got" ]; then
      echo "✓ deployed — the in-app updater will offer $want"
    elif [ -n "$resp" ]; then
      echo "⚠ the server is serving an OLDER apk ($got) than app.json ($want) — rebuild: 'just build-android'."
    else
      echo "⚠ the server isn't serving an apk. Set apk_path in config.toml [server] (or run with --apk) and restart it (just dev)."
    fi

# ── Quality ───────────────────────────────────────────────────────────────────

[group('quality')]
[doc('Format all code')]
fmt: fmt-go fmt-js

[group('quality')]
fmt-go:
    cd server && gofmt -w . 2>/dev/null || true
    cd cli && gofmt -w . 2>/dev/null || true

[group('quality')]
fmt-js:
    cd app && npx prettier -w . 2>/dev/null || true
    cd clipper && npx prettier -w . 2>/dev/null || true

[group('quality')]
[doc('E2E smoke test: builds server, starts on port 8766, pairs device, navigates all pages, checks for JS errors')]
e2e: build-server
    @echo "Running smoke test (port 8766, fresh /tmp/samizdat-test DB)..."
    cd e2e && node smoke.js

[group('quality')]
[doc('E2E integration test: drives real interactions (select→annotate→highlight lifecycle + per-page)')]
e2e-int: build-server
    @echo "Running integration test (port 8766, fresh /tmp/samizdat-test DB)..."
    cd e2e && node integration.js

[group('quality')]
[doc('E2E offline test: outbox unit tests + offline→reconnect→server-synced walkthrough')]
e2e-offline: build-server
    @echo "Running chunked-storage unit tests (Android CursorWindow guard)..."
    node e2e/chunked-storage-unit.mjs
    @echo "Running outbox unit tests (pure, no network)..."
    node e2e/outbox-unit.mjs
    @echo "Running offline walkthrough (port 8766, fresh /tmp/samizdat-test DB)..."
    cd e2e && node offline.js

[group('quality')]
[doc('Run all tests')]
test: test-go

[group('quality')]
test-go:
    cd server && go test ./... 2>/dev/null || echo "server/ not initialized yet"
    cd cli && go test ./... 2>/dev/null || echo "cli/ not initialized yet"

[group('quality')]
[doc('Lint all code (go vet + golangci-lint + eslint)')]
lint: lint-go lint-app check-native-log check-safe-area check-modal-focus check-offline-screens lint-parity

[group('quality')]
[doc('Check paired-renderer files (Highlight card: RN feed vs WebView DOM) stay in sync vs main')]
lint-parity: tooling-build
    REPO_ROOT="{{justfile_directory()}}" ./tooling/bin/spec parity

[group('quality')]
lint-go:
    cd server && go vet ./...
    cd cli && go vet ./...
    REPO_ROOT="{{justfile_directory()}}" ./tooling/bin/spec lint

[group('quality')]
lint-app:
    cd app && npx eslint .
    cd app && npx knip

[group('quality')]
[doc('Fail if any Go file uses stdlib log package directly (use internal/logger instead)')]
check-native-log:
    #!/usr/bin/env bash
    set -euo pipefail
    hits=$(grep -rn '"log"' server/internal server/main.go --include='*.go' | grep -v 'internal/logger/logger.go' || true)
    if [ -n "$hits" ]; then
      echo "ERROR: raw stdlib log import found — use logger.New() instead:"
      echo "$hits"
      exit 1
    fi

[group('quality')]
[doc('Fail if a mobile document-viewer header drops the top safe-area inset (status bar/notch would cover the back button)')]
check-safe-area:
    #!/usr/bin/env bash
    set -euo pipefail
    # Both viewers render an absolute top:0 header — RN SafeAreaView is a no-op on
    # Android, so each MUST pad by useSafeAreaInsets().top or the notification bar
    # covers the back button. A refactor that drops it regresses silently; guard it.
    fail=0
    for f in "app/app/(drawer)/document/[id].tsx" "app/src/VideoDocument.tsx"; do
      if ! grep -q 'insets\.top' "$f"; then
        echo "ERROR: $f header lost its top safe-area inset (insets.top) — the status bar will cover the back button on mobile."
        fail=1
      fi
    done
    [ "$fail" -eq 0 ] || exit 1

[group('quality')]
[doc('Fail if a TextInput inside an animated Modal focuses on open without the native keyboard-raise pattern (bare autoFocus raises no soft keyboard on native — see d6fe391 / app/CLAUDE.md "UX RN Platform specifics")')]
check-modal-focus:
    #!/usr/bin/env bash
    set -euo pipefail
    # Regression guard for d6fe391. A bare `autoFocus` on a TextInput inside an
    # animated <Modal> focuses the input on native (cursor blinks) but the OS never
    # raises the soft keyboard — the Modal window is still animating in, so
    # showSoftInput never runs; a 2nd tap is needed. The established fix pattern
    # (see AnnotationPanel.tsx, the reference) is:
    #   autoFocus={Platform.OS === 'web'}                       (bare autoFocus only web)
    #   <Modal onShow={handleShow} …>                           (fires post-entrance)
    #   InteractionManager.runAfterInteractions(() => ref.current?.focus())  (native focus)
    # Modal-scoped on purpose: on a plain screen (e.g. documents.tsx) there's no
    # animated IME handshake, so bare autoFocus / a setTimeout focus is fine there.
    cd app
    fail=0
    # Every component file that renders a <Modal> (the only place the bug bites).
    modal_files=$(grep -rl '<Modal' --include='*.tsx' src app | grep -v node_modules || true)
    for f in $modal_files; do
      # (A) Bare/unconditional JSX `autoFocus` prop (matched, but not `autoFocus=…`,
      #     not a `//` comment, not a `\`autoFocus\`` prose mention).
      bare=$(grep -nE 'autoFocus([^=]|$)' "$f" | grep -vE '//|`autoFocus`|autoFocus=' || true)
      if [ -n "$bare" ]; then
        echo "ERROR: $f — bare autoFocus on a TextInput inside a <Modal>."
        echo "  On native the soft keyboard won't rise until a 2nd tap (regression of d6fe391)."
        echo "  Use autoFocus={Platform.OS === 'web'} + focus via a ref from the Modal's onShow"
        echo "  (deferred through InteractionManager). See AnnotationPanel.tsx."
        echo "$bare" | sed "s#^#    $f:#"
        fail=1
      fi
      # (B) A web-guarded autoFocus signals intent to focus-on-open — it MUST carry the
      #     full native focus path, or native never raises the keyboard at all.
      if grep -qE "autoFocus=\{Platform\.OS === 'web'\}" "$f"; then
        missing=""
        grep -q 'onShow='          "$f" || missing="$missing Modal-onShow"
        grep -q 'InteractionManager' "$f" || missing="$missing InteractionManager"
        grep -qE '\.focus\(\)'     "$f" || missing="$missing ref.focus()"
        if [ -n "$missing" ]; then
          echo "ERROR: $f — web-guarded autoFocus but missing the native focus path:$missing"
          echo "  A Modal TextInput meant to focus-on-open must focus via a ref from the Modal's"
          echo "  onShow, deferred through InteractionManager, so native raises the keyboard."
          echo "  See AnnotationPanel.tsx (reference) and app/CLAUDE.md."
          fail=1
        fi
      fi
    done
    [ "$fail" -eq 0 ] || exit 1
    echo "check-modal-focus: OK ($(echo "$modal_files" | grep -c . ) Modal files scanned)"

[group('quality')]
check-offline-screens:
    #!/usr/bin/env bash
    set -euo pipefail
    # Offline-first (app/CLAUDE.md): all reads come from the local SQLite replica; sync
    # runs in the background. These read screens MUST render from the synced store so
    # they work with no connection — a network-only load() (fetchX(activeUrl,...) with
    # no fallback) shows an error screen offline, which regresses silently. Each guarded
    # screen must reference a store read: useSyncStore / highlightsFromStore, or a store
    # hook (useDocuments / useAnnotations / useTagsWithCounts). See loadFromStore() in
    # index.tsx / document/[id].tsx for the fallback pattern.
    store_read='useSyncStore|highlightsFromStore|useDocuments|useAnnotations|useTagsWithCounts'
    declare -A screens=(
      ["app/app/(drawer)/index.tsx"]="feed"
      ["app/app/(drawer)/documents.tsx"]="documents"
      ["app/app/(drawer)/notes.tsx"]="annotations"
      ["app/app/(drawer)/archived.tsx"]="archived"
      ["app/app/(drawer)/starred.tsx"]="starred"
      ["app/app/(drawer)/tags.tsx"]="tags"
      ["app/app/(drawer)/document/[id].tsx"]="document viewer"
    )
    fail=0
    for f in "${!screens[@]}"; do
      if [ ! -f "$f" ]; then
        echo "ERROR: guarded screen missing: $f (${screens[$f]}) — update check-offline-screens."
        fail=1
        continue
      fi
      if ! grep -qE "$store_read" "$f"; then
        echo "ERROR: ${screens[$f]} screen ($f) has no local-store read ($store_read)."
        echo "  Offline-first: read screens must render from the synced replica, not network-only."
        echo "  Add a loadFromStore()/highlightsFromStore() fallback or a store hook."
        fail=1
      fi
    done
    [ "$fail" -eq 0 ] || exit 1
    echo "check-offline-screens: OK (${#screens[@]} read screens guarded)"

# ── Landing ───────────────────────────────────────────────────────────────────

[group('deploy')]
[doc('Copy landing/index.html → gh-pages branch root and push (updates GitHub Pages)')]
update-landing:
    #!/usr/bin/env bash
    set -euo pipefail
    CURRENT=$(git rev-parse --abbrev-ref HEAD)
    if [ -n "$(git status --porcelain)" ]; then
        echo "ERROR: uncommitted changes — stash or commit first"
        exit 1
    fi
    git checkout gh-pages
    git checkout main -- landing/index.html
    cp landing/index.html index.html
    git checkout -- landing/index.html
    git add index.html
    git commit -m "feat(landing): update index.html from main"
    git push origin gh-pages
    git checkout "$CURRENT"
    echo "Done — gh-pages updated and pushed."

# ── Deploy ────────────────────────────────────────────────────────────────────

[group('deploy')]
[doc('Build (server+cli+web+extension), symlink CLIs, install/start a per-instance user systemd service (CLI symlinks need sudo)')]
install: _check-no-dev build-app-web build-clipper install-bins
    @echo ""
    bash scripts/install-service.sh
    @echo ""
    @echo "CLI symlinks (shared; point at the most recently installed checkout):"
    @echo "  sam      → $(readlink /usr/local/bin/sam)"
    @echo "  samizdat → $(readlink /usr/local/bin/samizdat)"
    @echo ""
    @echo "Multiple checkouts run as separate user services (samizdat-<dir>) on their own ports."
    @echo "Rebuild anytime: just build   (then: systemctl --user restart samizdat-$(basename {{justfile_directory()}}))"

[group('deploy')]
[doc('Build + symlink the sam/samizdat CLIs to /usr/local/bin (no service, needs sudo)')]
install-bins: build
    @# CLI convenience symlinks only. The systemd service does NOT use these — it
    @# runs each checkout's binary by absolute path (see scripts/install-service.sh),
    @# so installing another checkout can't hijack a running service.
    @echo "Symlinking CLIs — may prompt for sudo password"
    sudo -v
    sudo ln -sf "{{justfile_directory()}}/cli/bin/sam" /usr/local/bin/sam
    sudo ln -sf "{{justfile_directory()}}/server/bin/samizdat" /usr/local/bin/samizdat
    @echo "  sam      -> $(readlink /usr/local/bin/sam)"
    @echo "  samizdat -> $(readlink /usr/local/bin/samizdat)"

[group('deploy')]
[doc('Restart the installed user service (no sudo) — picks up a fresh build/config')]
restart:
    systemctl --user restart samizdat-{{_instance}}
    systemctl --user --no-pager status samizdat-{{_instance}} | head -5

[group('deploy')]
[doc('Configure public HTTPS reachability (domain or sslip.io)')]
setup-public:
    bash scripts/setup-public.sh

[group('deploy')]
[doc('Follow the installed user service logs')]
service-logs:
    journalctl --user -u samizdat-{{_instance}} -f --no-pager

# ── Tooling ───────────────────────────────────────────────────────────────────

[group('tooling')]
[doc('Build the spec tool')]
tooling-build:
    cd tooling && CGO_ENABLED=0 go build -o bin/spec ./cmd/spec

[group('tooling')]
[doc('Run golangci-lint on all Go projects')]
tooling-lint: tooling-build
    REPO_ROOT="{{justfile_directory()}}" ./tooling/bin/spec lint

[group('tooling')]
[doc('Architecture diff-review (branch vs main) + optional CLAUDE.md updates')]
tooling-diff-review: tooling-build
    REPO_ROOT="{{justfile_directory()}}" ./tooling/bin/spec diff-review

[group('tooling')]
[doc('Detect + explain new Go libraries added vs main')]
tooling-lib-check: tooling-build
    REPO_ROOT="{{justfile_directory()}}" ./tooling/bin/spec lib-check

[group('tooling')]
[doc('Run all spec checks (lint + diff-review + lib-check)')]
tooling-all: tooling-build
    REPO_ROOT="{{justfile_directory()}}" ./tooling/bin/spec all

# ── Browser sessions ──────────────────────────────────────────────────────────

[group('debug')]
[doc('Open app in agent-browser with persisted debug session (auto-restores login state from tmp/debug-session/state.json)')]
debug-session:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "{{justfile_directory()}}/tmp/debug-session"
    STATE="{{justfile_directory()}}/tmp/debug-session/state.json"
    URL="${URL:-http://localhost:{{_dev_port}}}"
    export AGENT_BROWSER_ARGS="${AGENT_BROWSER_ARGS:---no-sandbox}"
    agent-browser close --all 2>/dev/null || true
    if [ -f "$STATE" ]; then
        echo "Restoring session from $STATE"
        agent-browser --state "$STATE" open "$URL"
    else
        echo "No saved state — opening fresh. After pairing, run: just save-debug-session"
        agent-browser open "$URL"
    fi

[group('debug')]
[doc('Save current agent-browser session state to tmp/debug-session/state.json')]
save-debug-session:
    #!/usr/bin/env bash
    mkdir -p "{{justfile_directory()}}/tmp/debug-session"
    STATE="{{justfile_directory()}}/tmp/debug-session/state.json"
    agent-browser state save "$STATE"
    echo "Session saved: $STATE"

[group('debug')]
[doc('Mint/reuse the single robot-automated-ui-tester device; cache token + agent-browser state for UI tests')]
test-device:
    #!/usr/bin/env bash
    set -euo pipefail
    PORT="{{_dev_port}}"
    URL="http://localhost:$PORT"
    OUT="{{justfile_directory()}}/tmp/sessions/robot-ui-tester.json"
    STATE="{{justfile_directory()}}/tmp/sessions/robot-ui-tester.state.json"
    mkdir -p "{{justfile_directory()}}/tmp/sessions"
    RESP=$(curl -fsS -X POST "$URL/api/v1/admin/test-device") || { echo "Is 'just dev' running on :$PORT?" >&2; exit 1; }
    echo "$RESP" > "$OUT"
    # Build a minimal agent-browser state preloading the robot token into localStorage,
    # so `just robot-browser` boots already connected — no pairing, no new device row.
    OUT="$OUT" STATE="$STATE" URL="$URL" python3 -c 'import json,os; resp=json.load(open(os.environ["OUT"])); url=os.environ["URL"]; conn={"token":resp["device_token"],"deviceId":resp["device_id"],"serverUrls":resp.get("server_urls") or [url]}; state={"cookies":[],"origins":[{"origin":url,"localStorage":[{"name":"samizdat_connection","value":json.dumps(conn)},{"name":"samizdat_last_url","value":url}]}]}; json.dump(state,open(os.environ["STATE"],"w"),indent=2); print("device_id =",resp["device_id"])'
    echo "Token cached: $OUT"
    echo "Browser state: $STATE  →  just robot-browser"

[group('debug')]
[doc('Open app in agent-browser as the robot-automated-ui-tester device (runs just test-device first)')]
robot-browser: test-device
    #!/usr/bin/env bash
    set -euo pipefail
    STATE="{{justfile_directory()}}/tmp/sessions/robot-ui-tester.state.json"
    URL="${URL:-http://localhost:{{_dev_port}}}"
    export AGENT_BROWSER_ARGS="${AGENT_BROWSER_ARGS:---no-sandbox}"
    agent-browser close --all 2>/dev/null || true
    agent-browser --state "$STATE" open "$URL"

[group('debug')]
[doc('Launch Chrome with a named session from tmp/sessions/<name>.json (creates tmp/ if missing)')]
browser-session name="default":
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "{{justfile_directory()}}/tmp/sessions"
    SESSION="{{justfile_directory()}}/tmp/sessions/{{name}}.json"
    PROFILE="{{justfile_directory()}}/tmp/chrome-profile-{{name}}"
    mkdir -p "$PROFILE"
    # Restore cookies/localStorage if session file exists
    if [ -f "$SESSION" ]; then
        echo "Loading session: $SESSION"
        cp "$SESSION" "$PROFILE/session-restore.json"
    fi
    URL="${URL:-http://localhost:{{_dev_port}}}"
    echo "Opening $URL with profile '${{name}}'"
    google-chrome \
        --user-data-dir="$PROFILE" \
        --no-first-run \
        --no-default-browser-check \
        --app="$URL" 2>/dev/null || \
    chromium-browser \
        --user-data-dir="$PROFILE" \
        --no-first-run \
        --no-default-browser-check \
        --app="$URL" 2>/dev/null || \
    xdg-open "$URL"

[group('debug')]
[doc('Kill all samizdat dev servers, agent-browser sessions, and leftover headless Chrome/Playwright processes')]
kill:
    #!/usr/bin/env bash
    killed=0

    _kill() {
        local label="$1"; shift
        local pids
        pids=$(pgrep -f "$1" 2>/dev/null) || true
        if [ -n "$pids" ]; then
            echo "  killing $label (PIDs: $pids)"
            kill -TERM $pids 2>/dev/null || true
            sleep 0.4
            kill -KILL $pids 2>/dev/null || true
            killed=$((killed + 1))
        fi
    }

    echo "=== just kill: cleaning up samizdat dev processes ==="
    _kill "samizdat dev server"   "bin/samizdat serve"
    _kill "e2e test server"       "bin/samizdat.*config-test"
    _kill "agent-browser"         "agent-browser-linux-x64"
    _kill "playwright-go driver"  "ms-playwright-go.*run-driver"
    _kill "chrome-headless-shell" "chrome-headless-shell-linux64/chrome-headless-shell"
    _kill "chromium (playwright)" "ms-playwright/chromium.*chrome-linux64/chrome[^-]"
    _kill "e2e smoke node"        "node.*smoke\\.js"

    # Wipe playwright tmp dirs left by unclean shutdowns
    rm -rf /tmp/playwright_chromiumdev_profile-* /tmp/playwright-artifacts-* /tmp/samizdat-test 2>/dev/null || true

    if [ $killed -eq 0 ]; then
        echo "  nothing to kill"
    else
        echo "  done"
    fi

[group('debug')]
[doc('Take a screenshot of the running app (saves to tmp/screenshots/)')]
screenshot name="app":
    #!/usr/bin/env bash
    mkdir -p "{{justfile_directory()}}/tmp/screenshots"
    OUT="{{justfile_directory()}}/tmp/screenshots/{{name}}-$(date +%Y%m%d-%H%M%S).png"
    URL="${URL:-http://localhost:{{_dev_port}}}"
    google-chrome --headless --screenshot="$OUT" --window-size=1280,900 "$URL" 2>/dev/null || \
    chromium-browser --headless --screenshot="$OUT" --window-size=1280,900 "$URL" 2>/dev/null
    echo "Screenshot saved: $OUT"
