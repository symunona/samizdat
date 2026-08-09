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
    cd server && go run github.com/mxschmitt/playwright-go/cmd/playwright install chromium
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

[group('setup')]
[doc('Register + provision a remote Android build node (dest = ssh alias|ip|user@host): JDK17, SDK cmdline-tools, isolated gradle home, deps. Saves config/build-node.env → build-android then builds there')]
setup-build-node dest ws="":
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    DEST="{{dest}}"
    ssh -o BatchMode=yes -o ConnectTimeout=8 "$DEST" true 2>/dev/null || {
      echo "✗ cannot ssh to ${DEST} — needs a reachable host and a key that logs in without a password"; exit 1; }
    WS="{{ws}}"
    [ -n "$WS" ] || WS=$(ssh "$DEST" 'echo $HOME/build/sam')
    GRADLE_HOME="$(dirname "$WS")/gradle-sam"
    # Pin the node's JDK to taskbot's so both hosts compile with one toolchain.
    JDK_VER="jdk-17.0.19+10"
    echo "── provisioning ${DEST} (workspace ${WS}) ──"
    ssh "$DEST" bash -s -- "$WS" "$GRADLE_HOME" "$JDK_VER" <<'REMOTE'
    set -euo pipefail
    WS=$1; GRADLE_HOME=$2; JDK_VER=$3
    export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"   # non-login ssh shell
    missing=""
    for t in git node pnpm just unzip rsync curl; do command -v "$t" >/dev/null || missing="$missing $t"; done
    [ -z "$missing" ] || { echo "✗ build node is missing:$missing"; exit 1; }

    # JDK 17 — RN 0.85's gradle plugin needs 17, and auto-provisioning stays OFF
    # because RN pins foojay-resolver 0.5.0, which crashes on Gradle 9.
    JDK="$HOME/.jdks/$JDK_VER"
    if [ ! -x "$JDK/bin/javac" ]; then
      echo "→ installing $JDK_VER"
      mkdir -p "$HOME/.jdks"
      curl -fsSL "https://api.adoptium.net/v3/binary/version/${JDK_VER/+/%2B}/linux/x64/jdk/hotspot/normal/eclipse" \
        | tar xz -C "$HOME/.jdks"
      [ -x "$JDK/bin/javac" ] || { echo "✗ $JDK_VER did not unpack to $JDK"; exit 1; }
    fi

    # Android SDK — reuse an existing one (Android Studio's), else start a fresh one.
    SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
    mkdir -p "$SDK"
    if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
      echo "→ installing SDK command-line tools into $SDK"
      tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
      curl -fsSL -o "$tmp/clt.zip" https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
      unzip -q "$tmp/clt.zip" -d "$tmp"
      mkdir -p "$SDK/cmdline-tools/latest"
      mv "$tmp"/cmdline-tools/* "$SDK/cmdline-tools/latest/"
    fi
    export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK" JAVA_HOME="$JDK"
    export PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$PATH"
    # Accepted licenses are what let AGP auto-download whatever the build asks for, so
    # the explicit installs below are only a warm-up — a version drift in app/android
    # resolves itself on the first build instead of failing setup.
    yes | sdkmanager --licenses >/dev/null 2>&1 || true
    sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0" >/dev/null 2>&1 || \
      echo "  ⚠ SDK warm-up install failed — AGP will fetch what it needs on the first build"

    # Gradle home: cache AND memory tuning, isolated from the node's own ~/.gradle
    # (which may belong to other toolchains). Sized from the node's real hardware —
    # the inverse of taskbot's one-small-JVM survival config.
    mkdir -p "$GRADLE_HOME"
    cores=$(nproc); memgb=$(awk '/MemTotal/{printf "%d", $2/1048576}' /proc/meminfo)
    workers=$(( cores - 2 )); [ "$workers" -ge 1 ] || workers=1; [ "$workers" -le 8 ] || workers=8
    heap=$(( memgb / 4 )); [ "$heap" -ge 2 ] || heap=2; [ "$heap" -le 8 ] || heap=8
    cat > "$GRADLE_HOME/gradle.properties" <<EOF
    # Written by 'just setup-build-node' — sized for ${cores} cores / ${memgb}GB.
    org.gradle.java.installations.auto-download=false
    org.gradle.java.installations.paths=$JDK
    org.gradle.daemon=true
    org.gradle.parallel=true
    org.gradle.workers.max=$workers
    org.gradle.caching=true
    org.gradle.jvmargs=-Xmx${heap}g -XX:MaxMetaspaceSize=2g
    kotlin.compiler.execution.strategy=daemon
    kotlin.incremental=true
    # The node is somebody's desktop — don't sit on ${heap}GB for gradle's default 3h.
    org.gradle.daemon.idletimeout=1800000
    EOF

    # Receiving repo. HEAD stays on 'main' while builds push to 'build', so the pushed
    # ref is never the checked-out branch → no receive.denyCurrentBranch refusal, and no
    # dependence on updateInstead (which balks whenever the node's tree is dirty).
    mkdir -p "$WS/secrets"
    [ -d "$WS/.git" ] || git -C "$WS" init -q -b main
    echo "  jdk    : $JDK"
    echo "  sdk    : $SDK"
    echo "  gradle : $GRADLE_HOME (${workers} workers, -Xmx${heap}g)"
    echo "  space  : $(df -h --output=avail "$WS" | tail -1 | tr -d ' ') free at $WS"
    REMOTE
    # The keystore is gitignored, so it can only get there out-of-band. Without it the
    # node mints its own and the APK silently won't install over an existing one.
    just _apk-keystore >/dev/null
    rsync -q secrets/debug.keystore "${DEST}:${WS}/secrets/debug.keystore"
    git remote remove build-node 2>/dev/null || true
    git remote add build-node "${DEST}:${WS}"
    echo "── seeding the workspace ──"
    git push -q --force build-node HEAD:refs/heads/build
    LOCK=$(sha256sum app/pnpm-lock.yaml | cut -d' ' -f1)
    ssh "$DEST" bash -s -- "$WS" "$GRADLE_HOME" "$LOCK" <<'REMOTE'
    set -euo pipefail
    WS=$1; GRADLE_HOME=$2; LOCK=$3
    export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
    cd "$WS"
    git reset -q --hard build
    echo "→ pnpm install (app, ~4GB — one time)"
    (cd app && pnpm install --frozen-lockfile)
    printf '%s' "$LOCK" > "$GRADLE_HOME/.pnpm-lock.stamp"
    # icongen carries its own node_modules (sharp) — the Expo tree can't install it.
    echo "→ npm install (tools/icongen)"
    (cd tools/icongen && npm install --no-audit --no-fund >/dev/null)
    REMOTE
    mkdir -p config
    cat > config/build-node.env <<EOF
    # Written by 'just setup-build-node ${DEST}'. Gitignored (machine-local).
    BUILD_NODE_DEST=${DEST}
    BUILD_NODE_WS=${WS}
    BUILD_NODE_GRADLE_HOME=${GRADLE_HOME}
    BUILD_NODE_ANDROID_HOME=$(ssh "$DEST" 'echo ${ANDROID_HOME:-$HOME/Android/Sdk}')
    BUILD_NODE_JDK=$(ssh "$DEST" "echo \$HOME/.jdks/${JDK_VER}")
    EOF
    echo ""
    echo "✓ build node ${DEST} ready — 'just build-android' now builds there."
    echo "  config: config/build-node.env   fallback: just build-android-local"

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
    # No --apk flag: the APK's location comes from config.toml [server] apk_path
    # (default dist/samizdat.apk) so dev and the systemd service cannot disagree —
    # a flag only dev passed is what left prod serving no /download/samizdat.apk.
    nohup server/bin/samizdat serve {{_config_flag}} --webdir app/dist --extension-zip clipper/dist/sam-chrome.zip > /tmp/samizdat-${PORT}.log 2>&1 &
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
    if [ -f config/build-node.env ]; then
      source config/build-node.env
      if ssh -o BatchMode=yes -o ConnectTimeout=3 "$BUILD_NODE_DEST" true 2>/dev/null; then bn="reachable"; else bn="UNREACHABLE — 'just build-android-local'"; fi
      echo "  build node : ${BUILD_NODE_DEST} (${bn}) $(node tools/build-times.mjs estimate build-android-remote | sed 's/^⏱ //')"
    else
      echo "  build node : none — 'just setup-build-node <ssh-dest>' (APKs build here, ~35 min)"
    fi
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
[doc('Probe every LLM provider (LAN/local Ollama, Anthropic, OpenRouter): reachable? key good? out of credits? Pass --shallow to spend no tokens')]
check-llm *args: build-cli
    ./cli/bin/sam {{_config_flag}} llm check {{args}}

[group('dev')]
[doc('List the models each LLM provider serves (what the app model picker offers)')]
list-models *args: build-cli
    ./cli/bin/sam {{_config_flag}} llm models {{args}}

[group('dev')]
[doc('Run the Expo app (native/Expo Go)')]
app: sync-wasm
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
    # cgo is REQUIRED: worker/pdfrender.go links MuPDF for PDF figure extraction.
    # CGO_ENABLED=0 still compiles — go-fitz silently swaps in a purego path that
    # dlopens a libmupdf.so this box does not have — and then panics at scrape time.
    CGO_ENABLED=1 go build -ldflags "-X ${pkg}.version=${ver} -X ${pkg}.commit=${commit} -X ${pkg}.buildTime=${built}" -o bin/samizdat .

[group('build')]
[doc('Build the sam CLI')]
build-cli:
    cd cli && CGO_ENABLED=0 go build -o bin/sam .

[group('build')]
[doc('Copy the wa-sqlite wasm into app/public/wasm — the web SQLite engine, served as a plain same-origin static asset (Metro does not bundle .wasm; no COOP/COEP header is involved)')]
sync-wasm:
    #!/usr/bin/env bash
    set -euo pipefail
    # Copied from node_modules on every build rather than committed, so the binary can
    # never drift from the @journeyapps/wa-sqlite version that is actually installed.
    src="{{justfile_directory()}}/app/node_modules/@journeyapps/wa-sqlite/dist/wa-sqlite-async.wasm"
    dst="{{justfile_directory()}}/app/public/wasm"
    mkdir -p "$dst"
    cp "$src" "$dst/"

[group('build')]
[doc('Export the Expo web build (served by the server)')]
build-app-web: sync-wasm
    #!/usr/bin/env bash
    set -euo pipefail
    # Expo content-hashes the entry bundle (index-<hash>.js); an open web tab detects
    # a redeploy by comparing its own hash to the served index.html (see
    # useWebReloadAvailable). No commit stamp needed — the hash IS the identity, and
    # it's independent of the server binary's build commit.
    cd "{{justfile_directory()}}/app"
    pnpm expo export --platform web --output-dir dist --clear

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

# THE resolver for the APK's location: config.toml [server] apk_path (default
# dist/samizdat.apk, resolved against the config file's directory). It asks the
# server binary, i.e. the exact code that serves the file — so a build can never
# write where the server isn't looking. Every recipe and script that needs the
# path calls this; none spells it out.
_apk-path:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    [ -x server/bin/samizdat ] || just build-server >&2
    server/bin/samizdat {{_config_flag}} config apk-path

[group('build')]
[doc('Build the Android APK — on the configured build node (~4 min) if one is set, else says so (level=patch|minor|major)')]
build-android level="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    # Remote by DEFAULT: this box has 4GB, so the local build runs throttled to one
    # small JVM and takes ~35 min. Never silently fall back to it — a 35-minute
    # "why is this slow" is worse than an error naming the recipe you actually want.
    [ -f config/build-node.env ] || {
      echo "✗ no build node configured."
      echo "  set one up:  just setup-build-node <ssh-dest> [workspace]"
      echo "  or build here (throttled, ~35 min):  just build-android-local"
      exit 1
    }
    just build-android-remote {{level}}

[group('build')]
[doc('Build the APK on the configured build node, fetch it back, verify + deploy (level=patch|minor|major)')]
build-android-remote level="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    [ -f config/build-node.env ] || { echo "✗ no build node — run 'just setup-build-node <ssh-dest>'"; exit 1; }
    source config/build-node.env
    ssh -o BatchMode=yes -o ConnectTimeout=5 "$BUILD_NODE_DEST" true 2>/dev/null || {
      echo "✗ build node ${BUILD_NODE_DEST} unreachable — wake it, or 'just build-android-local' (~35 min)"; exit 1; }
    # Source travels as a git push over the ssh path that already works (diff-only, no
    # GitHub key needed on the node) — so the node builds HEAD, and an uncommitted change
    # would silently not be in the APK.
    git diff --quiet HEAD -- || {
      echo "✗ uncommitted tracked changes — the node builds HEAD, so commit first:"; git status --short -uno; exit 1; }
    # taskbot stays the ONLY version bumper: versionCode is wall-clock monotonic and
    # extra.buildEpoch is stamped here. The bump is committed because the node can only
    # see committed work — and because an uncommitted bump regresses versionCode on the
    # next read (see CLAUDE.md § Versioning).
    node tools/bump-version.mjs {{level}}
    VER=$(node -e 'const a=require("./app/app.json").expo;process.stdout.write(a.version)')
    CODE=$(node -e 'const a=require("./app/app.json").expo;process.stdout.write(String(a.android.versionCode))')
    git commit -q -m "chore(app): bump version to ${VER}" -- app/app.json
    node tools/build-times.mjs estimate build-android-remote
    echo "→ ${VER} (code ${CODE}) on ${BUILD_NODE_DEST}:${BUILD_NODE_WS}"
    t0=$SECONDS
    git push -q --force build-node HEAD:refs/heads/build
    # secrets/ is gitignored → the keystore never travels with the source. Re-sync it
    # every build: a node that mints its own signs an APK the phone refuses to install
    # over (verify-apk.sh catches it, but not before the build is spent).
    ssh "$BUILD_NODE_DEST" "mkdir -p ${BUILD_NODE_WS}/secrets"
    rsync -q secrets/debug.keystore "${BUILD_NODE_DEST}:${BUILD_NODE_WS}/secrets/debug.keystore"
    LOCK=$(sha256sum app/pnpm-lock.yaml | cut -d' ' -f1)
    ssh "$BUILD_NODE_DEST" bash -s -- "$BUILD_NODE_WS" "$BUILD_NODE_GRADLE_HOME" "$BUILD_NODE_ANDROID_HOME" "$BUILD_NODE_JDK" "$LOCK" <<'REMOTE'
    set -euo pipefail
    WS=$1; GRADLE_HOME=$2; SDK=$3; JDK=$4; LOCK=$5
    export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"   # non-login ssh shell
    cd "$WS"
    git reset -q --hard build
    # -fd, NEVER -fdx: ignored paths (node_modules, android/, secrets/) must survive,
    # else every build pays a 4GB reinstall and a cold gradle cache.
    git clean -qfd
    # The lock stamp lives in GRADLE_USER_HOME, outside the repo — inside it, the very
    # `git clean` above would delete it every build.
    if [ "$(cat "$GRADLE_HOME/.pnpm-lock.stamp" 2>/dev/null || true)" != "$LOCK" ]; then
      echo "→ pnpm install (lockfile changed)"
      (cd app && pnpm install --frozen-lockfile)
      printf '%s' "$LOCK" > "$GRADLE_HOME/.pnpm-lock.stamp"
    fi
    export GRADLE_USER_HOME="$GRADLE_HOME" ANDROID_HOME="$SDK" JAVA_HOME="$JDK"
    export NODE_OPTIONS=--max-old-space-size=6144   # the node has RAM; let Metro use it
    just _apk-gradle
    REMOTE
    just _apk-collect "${BUILD_NODE_DEST}:${BUILD_NODE_WS}/app/android/app/build/outputs/apk/release/app-release.apk"
    node tools/build-times.mjs log build-android-remote "$((SECONDS-t0))" "$BUILD_NODE_DEST"
    echo "built in $((SECONDS-t0))s"
    just deploy-android
    # A daemon holding ~8GB on someone's desktop is worth naming out loud.
    daemons=$(ssh "$BUILD_NODE_DEST" 'pgrep -c -f GradleDaemon || true')
    [ "${daemons:-0}" = "0" ] || echo "ℹ ${daemons} gradle daemon(s) resident on ${BUILD_NODE_DEST} (idle-timeout will reap them)"

[group('build')]
[doc('Build the APK on THIS box — throttled for 4GB, ~35 min (+ NDK re-download). Offline fallback for build-android (level=patch|minor|major)')]
build-android-local level="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    # The NDK was reclaimed from this 4GB/75G box once xayah became the build node
    # (it is ~2GB and only a local build needs it). AGP re-fetches it — the accepted
    # licenses in Sdk/licenses are what allow that — but say so before the wait starts.
    [ -d "${ANDROID_HOME:-$HOME/Android/Sdk}/ndk" ] || \
      echo "ℹ no local NDK — AGP will download ~2GB first (kept off this box; see CLAUDE.md)"
    # Auto-bump the version FIRST so prebuild stamps the new version/versionCode
    # into the native manifest. Default patch; `just build-android-local minor|major`
    # for the bigger bumps. See tools/bump-version.mjs + CLAUDE.md.
    node tools/bump-version.mjs {{level}}
    node tools/build-times.mjs estimate build-android-local
    t0=$SECONDS
    # Memory caps live in ~/.gradle/gradle.properties (one JVM, in-process Kotlin,
    # small heap) — this VPS has 4GB RAM and also serves live sites.
    NODE_OPTIONS="--max-old-space-size=1536" just _apk-gradle
    just _apk-collect app/android/app/build/outputs/apk/release/app-release.apk
    node tools/build-times.mjs log build-android-local "$((SECONDS-t0))" local
    echo "built in $((SECONDS-t0))s"
    # Auto-deploy so the fresh build is what the live server (and in-app updater) sees.
    just deploy-android

# Take the freshly built APK (src = a local path or an rsync host:path), rotate the
# outgoing one aside as the verify baseline, write the sidecar, verify. Shared by
# the local and remote build paths so neither can drift — and the destination is
# whatever `_apk-path` resolves, never a literal dist/samizdat.apk.
_apk-collect src:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    APK="$(just _apk-path)"
    mkdir -p "$(dirname "$APK")"
    if [ -f "$APK" ]; then
      cp "$APK" "${APK}.prev"
      [ -f "${APK}.json" ] && cp "${APK}.json" "${APK}.prev.json" || true
    fi
    rsync -q "{{src}}" "$APK"
    # Sidecar is written HERE from the local app.json — nothing about the version comes
    # back from a build host, so the served metadata can't drift from the repo.
    node tools/write-apk-sidecar.mjs "$APK"
    echo "APK → ${APK} ($(du -h "$APK" | cut -f1))"
    tools/verify-apk.sh "$APK"

# Shared APK build steps, so the local and remote paths cannot drift. Everything
# host-specific comes from the environment: ANDROID_HOME, JAVA_HOME, GRADLE_USER_HOME
# (which is also where each host's memory tuning lives), NODE_OPTIONS.
_apk-gradle:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
    export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"   # cap Metro's node heap
    # Pre-accept SDK licenses so gradle can auto-download compileSdk/build-tools.
    yes | sdkmanager --licenses >/dev/null 2>&1 || true
    # src/webview/document-viewer-bundle.ts is GENERATED and gitignored: a build host
    # that never ran `just dev` has none at all, and this box would otherwise bundle
    # whatever stale copy is on disk — shipping an APK whose document viewer predates
    # the source. Regenerate every APK build.
    just webview-build
    # Rasterize the logo SVG → app/assets/*.png before prebuild reads them, so a
    # fresh assets/samizdat.svg always flows into the launcher icon.
    just gen-icons
    # Generate the native android/ project from managed config (idempotent).
    cd app
    npx expo prebuild --platform android --no-install
    # Install the canonical debug keystore AFTER prebuild, overwriting anything it
    # minted: that key is the APK's install-over identity (see _apk-keystore).
    just _apk-keystore
    cd android
    # Phase 1 — JS bundle + Hermes bytecode ONLY. Runs Metro (node) while the
    # gradle JVM is idle, so node never coexists with the Kotlin/dex compile.
    # --rerun-tasks + a metro cache wipe force a FRESH bundle every build: gradle's
    # up-to-date check does NOT track app.json, so a version bump (or any source
    # change it misses) would otherwise ship a stale Hermes bundle — leaving the
    # in-app APP_VERSION_CODE behind the native manifest and the served sidecar,
    # which makes the updater offer an "update" to the version already installed.
    rm -rf "${TMPDIR:-/tmp}"/metro-* "${TMPDIR:-/tmp}"/haste-map-* ../node_modules/.cache 2>/dev/null || true
    nice -n 10 ./gradlew :app:createBundleReleaseJsAndAssets --rerun-tasks
    # Phase 2 — compile + dex + package. The bundle above is up-to-date and gets
    # skipped, so no node here. Release is debug-signed + not minified (see
    # android/app/build.gradle) → a standalone, installable test APK. Skip
    # lintVitalRelease — it's class-heavy (blows metaspace) and pointless for a
    # local test build. reactNativeArchitectures=arm64-v8a ships ONE ABI (real
    # phones) instead of the default four (armeabi-v7a/arm64/x86/x86_64) — the
    # x86* pair is emulator-only and ~55MB of dead weight. Cuts the APK ~123M→~49M.
    nice -n 10 ./gradlew assembleRelease -x lintVitalRelease -PreactNativeArchitectures=arm64-v8a

# Install secrets/debug.keystore into the generated android/ tree. The keystore is the
# app's INSTALL-OVER IDENTITY: an APK signed by a different one cannot update an
# installed build (Android refuses; the phone just shows nothing). app/android is
# gitignored, so the keystore lives outside it — and outside git entirely.
_apk-keystore:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    KS=secrets/debug.keystore
    if [ ! -f "$KS" ]; then
      mkdir -p secrets
      if [ -f app/android/app/debug.keystore ]; then
        install -m 600 app/android/app/debug.keystore "$KS"
        echo "→ adopted app/android/app/debug.keystore as ${KS} (canonical from now on)"
      else
        kt=$(command -v keytool || ls "$HOME"/.jdks/*/bin/keytool 2>/dev/null | head -1 || true)
        [ -n "$kt" ] || { echo "✗ no keytool — install a JDK, or restore ${KS} from backup"; exit 1; }
        "$kt" -genkeypair -keystore "$KS" -storepass android -keypass android \
          -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10950 \
          -dname "CN=Android Debug,O=Android,C=US" >/dev/null
        chmod 600 "$KS"
        echo "⚠ minted a NEW ${KS} — a NEW install-over identity."
        echo "  Phones running an APK signed by the previous key must uninstall before updating."
        echo "  Back this file up outside the repo (it is gitignored)."
      fi
    fi
    # No generated tree yet (fresh clone / setup-build-node): ensuring the canonical
    # keystore exists is the whole job — _apk-gradle installs it right after prebuild.
    [ -d app/android/app ] && install -m 600 "$KS" app/android/app/debug.keystore || true

[group('build')]
[doc('Show recorded build durations (local vs build node) — see build-android')]
build-times:
    @node "{{justfile_directory()}}/tools/build-times.mjs" show

[group('build')]
[doc('Deploy the built APK to the live server so the in-app updater sees it (auto-run by build-android)')]
deploy-android:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"
    APK="$(just _apk-path)"
    test -f "$APK" && test -f "${APK}.json" || { echo "✗ no APK at ${APK} — run 'just build-android' first"; exit 1; }
    # The server reads the APK + its sidecar per request, so a running instance serves
    # the fresh build with no copy step — the routes themselves are always registered.
    # Restart the service anyway so it also picks up a fresh binary in the same step.
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
    # Poll — a just-restarted service needs a moment to bind, and checking once made this
    # report "server isn't serving an apk" (with a bogus fix-your-config hint) on a
    # deploy that was in fact fine.
    want=$(node -e 'const a=require("./app/app.json").expo;process.stdout.write(a.version+" / code "+a.android.versionCode)')
    for _ in $(seq 15); do
      resp=$(curl -fsS "http://localhost:{{_dev_port}}/api/v1/app/android/version" 2>/dev/null || true)
      [ -z "$resp" ] || break
      sleep 1
    done
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
      echo "⚠ no answer from the server on :{{_dev_port}} — start it ('just restart' for the service, 'just dev' for dev)."
      echo "  It reads the APK from ${APK} (config.toml [server] apk_path)."
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

# Every e2e suite drives the SERVED web bundle, so it must depend on build-app-web
# as well as build-server. With only build-server, an app-only change is tested
# against whatever bundle was last left on disk — the suite passes on code it never
# ran, which is worse than no suite at all.

[group('quality')]
[doc('E2E smoke test: builds server + web app, starts on port 8766, pairs device, navigates all pages, checks for JS errors')]
e2e: build-server build-app-web
    @echo "Running smoke test (port 8766, fresh /tmp/samizdat-test DB)..."
    cd e2e && node smoke.js

[group('quality')]
[doc('E2E integration test: drives real interactions (select→annotate→highlight lifecycle + per-page)')]
e2e-int: build-server build-app-web
    @echo "Running integration test (port 8766, fresh /tmp/samizdat-test DB)..."
    cd e2e && node integration.js

[group('quality')]
[doc('E2E offline test: outbox unit tests + offline→reconnect→server-synced walkthrough')]
e2e-offline: build-server build-app-web
    @echo "Running outbox unit tests (pure, no network)..."
    node e2e/outbox-unit.mjs
    @echo "Running offline walkthrough (port 8766, fresh /tmp/samizdat-test DB)..."
    cd e2e && node offline.js

[group('quality')]
[doc('DB-layer unit tests: the SQLite replica (app/src/db) driven headlessly on node:sqlite')]
e2e-db:
    @echo "Running db-layer unit tests (node:sqlite, no server, no browser)..."
    node e2e/db-unit.mjs

[group('quality')]
[doc('Run all tests')]
test: test-go test-clipper

[group('quality')]
test-go:
    cd server && go test ./... 2>/dev/null || echo "server/ not initialized yet"
    cd cli && go test ./... 2>/dev/null || echo "cli/ not initialized yet"

# Zero-dep logic tests for the clipper popup (node built-in runner, no browser).
[group('quality')]
test-clipper:
    node --test clipper/test/*.test.mjs

[group('quality')]
[doc('Lint all code (go vet + golangci-lint + eslint)')]
lint: lint-go lint-app check-native-log check-safe-area check-modal-focus check-offline-screens check-db-layer lint-parity

[group('quality')]
[doc('Fail if anything outside app/src/db opens a database, writes SQL, or touches AsyncStorage')]
check-db-layer:
    node tooling/check-db-layer.mjs

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
        grep -qE 'InteractionManager|setTimeout' "$f" || missing="$missing deferred-focus(InteractionManager/setTimeout)"
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
    # runs in the background. These read screens MUST render from the replica so they
    # work with no connection — a network-only load() (fetchX(activeUrl,...) with no
    # fallback) shows an error screen offline, which regresses silently. Each guarded
    # screen must reference a src/db read hook. See loadFromStore() in index.tsx /
    # document/[id].tsx for the fallback pattern.
    store_read='useFeedHighlights|useStarredHighlights|useArchivedHighlights|useDocuments|useDocument|useAnnotations|useTagsWithCounts'
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
        echo "  Add a loadFromStore() fallback built on a src/db read hook."
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
restart: _free-port-for-service
    systemctl --user restart samizdat-{{_instance}}
    systemctl --user --no-pager status samizdat-{{_instance}} | head -5
    @sleep 2; just _assert-service-holds-port

# `just dev` takes the port from the service; this hands it back. Without it the
# dev nohup keeps :PORT, the service starts, FAILS TO BIND, and systemd still
# reports active — so `just restart` looks successful while the OLD dev binary
# serves every request. Same stale-binary trap `just dev` guards against in the
# other direction, and invisible unless you compare /health's commit stamp.
_free-port-for-service:
    @PORT={{_dev_port}}; \
    PID=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1); \
    if [ -n "${PID:-}" ]; then \
        MAIN=$(systemctl --user show samizdat-{{_instance}} -p MainPID --value 2>/dev/null); \
        if [ "$PID" = "${MAIN:-none}" ]; then \
            echo "service already holds :$PORT — restarting in place"; \
        else \
            echo "dev server (pid $PID) holds :$PORT — stopping so the service can bind..."; \
            kill "$PID" 2>/dev/null || true; \
            for i in $(seq 1 20); do ss -tlnp 2>/dev/null | grep -q ":$PORT " || break; sleep 0.3; done; \
        fi; \
    fi

# A service that cannot bind still reports "active". Verify it really owns the port.
_assert-service-holds-port:
    @PORT={{_dev_port}}; \
    MAIN=$(systemctl --user show samizdat-{{_instance}} -p MainPID --value 2>/dev/null); \
    HOLDER=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1); \
    if [ "${HOLDER:-none}" != "${MAIN:-none}" ]; then \
        echo "ERROR: samizdat-{{_instance}} (pid ${MAIN:-none}) is NOT serving :$PORT (pid ${HOLDER:-none} is)." >&2; \
        echo "       The service is 'active' but never bound. Run 'just kill', then 'just restart'." >&2; \
        exit 1; \
    fi; \
    echo "service (pid $MAIN) holds :$PORT"

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
