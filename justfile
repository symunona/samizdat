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
    cd app && npm install 2>/dev/null || echo "app/ not initialized yet (expo create)"

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

# ── Dev ───────────────────────────────────────────────────────────────────────

[group('dev')]
[doc('Run the server (dev mode)')]
dev:
    cd server && go run ./... 2>/dev/null || echo "server/ not initialized yet"

[group('dev')]
[doc('Run the Expo app')]
app:
    cd app && npx expo start 2>/dev/null || echo "app/ not initialized yet"

[group('dev')]
[doc('Run the Expo app in the browser (RN Web)')]
app-web:
    cd app && npx expo start --web 2>/dev/null || echo "app/ not initialized yet"

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
    cd server && CGO_ENABLED=0 go build -o bin/samizdat ./... 2>/dev/null || echo "server/ not initialized yet"

[group('build')]
[doc('Build the sam CLI')]
build-cli:
    cd cli && CGO_ENABLED=0 go build -o bin/sam ./... 2>/dev/null || echo "cli/ not initialized yet"

[group('build')]
[doc('Export the Expo web build (served by the server)')]
build-app-web:
    cd app && npx expo export --platform web 2>/dev/null || echo "app/ not initialized yet"

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
[doc('Quick go vet (use tooling-lint for full golangci-lint)')]
lint:
    cd server && go vet ./... 2>/dev/null || true
    cd cli && go vet ./... 2>/dev/null || true

# ── Deploy ────────────────────────────────────────────────────────────────────

[group('deploy')]
[doc('Configure public HTTPS reachability (domain or sslip.io)')]
setup-public:
    bash scripts/setup-public.sh

[group('deploy')]
[doc('Install & start the systemd service (run just build-server first)')]
install-service:
    bash scripts/install-service.sh

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
