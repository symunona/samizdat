# Samizdat task runner — https://github.com/casey/just
# Run `just` to list recipes grouped by component.

set shell := ["bash", "-uc"]

# List available recipes
default:
    @just --list

# ── Setup ─────────────────────────────────────────────────────────────────────

[group('setup')]
[doc('Install dev environment from a git clone (needs Go 1.22+)')]
install-dev: _check-go _check-just setup-cli setup-server setup-tooling
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

# Checks port 8765: stops our service automatically; errors on unknown process.
_check-no-service:
    @if ss -tlnp 2>/dev/null | grep -q ':8765'; then \
        if systemctl is-active --quiet samizdat 2>/dev/null; then \
            echo "samizdat service running — stopping for dev mode..."; \
            sudo systemctl stop samizdat && echo "Service stopped."; \
        else \
            echo "ERROR: port 8765 in use by unknown process:"; \
            ss -tlnp | grep ':8765'; \
            exit 1; \
        fi; \
    fi

# Fails if port 8765 is occupied by a non-service process (i.e. a dev server is running).
_check-no-dev:
    @if ss -tlnp 2>/dev/null | grep -q ':8765' && ! systemctl is-active --quiet samizdat 2>/dev/null; then \
        echo "ERROR: dev server already running on :8765 — stop it before installing the service"; \
        exit 1; \
    fi

# ── Dev ───────────────────────────────────────────────────────────────────────

[group('dev')]
[doc('Build app + server, run server (dev mode, HTTP) serving the web app')]
dev: _check-no-service build-server build-app-web
    cd server && ./bin/samizdat serve --webdir ../app/dist

[group('dev')]
[doc('Build + run the sam CLI with args (e.g. just sam connect)')]
sam *args: build-cli
    ./cli/bin/sam {{args}}

[group('dev')]
[doc('Run the Expo app (native/Expo Go)')]
app:
    cd app && npx expo start 2>/dev/null || echo "app/ not initialized yet"

[group('dev')]
[doc('Build & load the clipper extension (dev)')]
clipper:
    cd clipper && npm run dev 2>/dev/null || echo "clipper/ not initialized yet"

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
    cd app && pnpm expo export --platform web --output-dir dist

[group('build')]
[doc('Package the clipper extension')]
build-clipper:
    cd clipper && npm run build 2>/dev/null || echo "clipper/ not initialized yet"

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
[doc('Run all tests')]
test: test-go

[group('quality')]
test-go:
    cd server && go test ./... 2>/dev/null || echo "server/ not initialized yet"
    cd cli && go test ./... 2>/dev/null || echo "cli/ not initialized yet"

[group('quality')]
[doc('Lint all code (go vet + golangci-lint + eslint)')]
lint: lint-go lint-app

[group('quality')]
lint-go:
    cd server && go vet ./...
    cd cli && go vet ./...
    REPO_ROOT="{{justfile_directory()}}" ./tooling/bin/spec lint

[group('quality')]
lint-app:
    cd app && npx eslint .

# ── Deploy ────────────────────────────────────────────────────────────────────

[group('deploy')]
[doc('Build everything, symlink bins, install & start the service (needs sudo)')]
install: _check-no-dev install-bins
    @echo ""
    bash scripts/install-service.sh
    @echo ""
    @echo "sam     → $(readlink /usr/local/bin/sam)"
    @echo "samizdat → $(readlink /usr/local/bin/samizdat)"
    @echo ""
    @echo "Rebuild anytime: just build   (symlinks stay, service picks up on next restart)"
    @echo "Force restart:   sudo systemctl restart samizdat"

[group('deploy')]
[doc('Build + symlink sam and samizdat to /usr/local/bin (no service touch, needs sudo)')]
install-bins: build
    @echo "Symlinking binaries — may prompt for sudo password"
    sudo -v
    sudo ln -sf "{{justfile_directory()}}/cli/bin/sam" /usr/local/bin/sam
    sudo ln -sf "{{justfile_directory()}}/server/bin/samizdat" /usr/local/bin/samizdat
    @echo "  sam      -> $(readlink /usr/local/bin/sam)"
    @echo "  samizdat -> $(readlink /usr/local/bin/samizdat)"

[group('deploy')]
[doc('Configure public HTTPS reachability (domain or sslip.io)')]
setup-public:
    bash scripts/setup-public.sh

[group('deploy')]
[doc('Tail the service logs')]
service-logs:
    journalctl -u samizdat -f --no-pager

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
