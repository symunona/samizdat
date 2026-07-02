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
    @rm -rf /tmp/playwright_chromiumdev_profile-* /tmp/playwright-artifacts-* 2>/dev/null || true
    nohup server/bin/samizdat serve {{_config_flag}} --webdir app/dist --extension-zip clipper/dist/sam-chrome.zip --apk dist/samizdat.apk > /tmp/samizdat-{{_dev_port}}.log 2>&1 &
    @PORT={{_dev_port}}; for i in $(seq 1 20); do ss -tlnp | grep -q ":$PORT" && break; sleep 0.5; done && echo "server started on :{{_dev_port}}, log: /tmp/samizdat-{{_dev_port}}.log"
    @./cli/bin/sam {{_config_flag}} connect

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

# ── Build ─────────────────────────────────────────────────────────────────────

[group('build')]
[doc('Build server + CLI')]
build: build-server build-cli

[group('build')]
[doc('Build the server static binary')]
build-server:
    cd server && CGO_ENABLED=0 go build -o bin/samizdat .

[group('build')]
[doc('Build the sam CLI')]
build-cli:
    cd cli && CGO_ENABLED=0 go build -o bin/sam .

[group('build')]
[doc('Export the Expo web build (served by the server)')]
build-app-web:
    cd app && pnpm expo export --platform web --output-dir dist --clear

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
[doc('Build a standalone debug-signed Android APK locally, minimal RAM (JS bundled separately) → dist/samizdat.apk (+ .json)')]
build-android:
    #!/usr/bin/env bash
    set -euo pipefail
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
    node -e 'const a=require("./app/app.json").expo,fs=require("fs");const st=fs.statSync("dist/samizdat.apk");fs.writeFileSync("dist/samizdat.apk.json",JSON.stringify({version:a.version,version_code:a.android.versionCode,size:st.size,built_at:new Date().toISOString()})+"\n")'
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
    if systemctl --user is-active --quiet samizdat-sam; then
      systemctl --user restart samizdat-sam && echo "↻ restarted samizdat-sam service (re-registers /download routes)"
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
[doc('Run all tests')]
test: test-go

[group('quality')]
test-go:
    cd server && go test ./... 2>/dev/null || echo "server/ not initialized yet"
    cd cli && go test ./... 2>/dev/null || echo "cli/ not initialized yet"

[group('quality')]
[doc('Lint all code (go vet + golangci-lint + eslint)')]
lint: lint-go lint-app check-native-log lint-parity

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
