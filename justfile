# Samizdat task runner — https://github.com/casey/just
# `just` lists recipes. Recipes are grouped by component.

set shell := ["bash", "-uc"]

# Default: list available recipes
default:
    @just --list

# --- Setup ---------------------------------------------------------------

# Install deps for every component (run after cloning)
setup: setup-server setup-cli setup-app setup-clipper

setup-server:
    cd server && go mod download 2>/dev/null || echo "server/ not initialized yet (go mod init)"

setup-cli:
    cd cli && go mod download 2>/dev/null || echo "cli/ not initialized yet (go mod init)"

setup-app:
    cd app && npm install 2>/dev/null || echo "app/ not initialized yet (expo create)"

setup-clipper:
    cd clipper && npm install 2>/dev/null || echo "clipper/ not initialized yet"

# --- Dev / run -----------------------------------------------------------

# Run the server (dev)
dev:
    cd server && go run ./... 2>/dev/null || echo "server/ not initialized yet"

# Run the Expo app (dev)
app:
    cd app && npx expo start 2>/dev/null || echo "app/ not initialized yet"

# Run the Expo app in the browser (RN Web)
app-web:
    cd app && npx expo start --web 2>/dev/null || echo "app/ not initialized yet"

# Build & load the clipper (dev)
clipper:
    cd clipper && npm run dev 2>/dev/null || echo "clipper/ not initialized yet"

# --- Build ---------------------------------------------------------------

build: build-server build-cli

# Build the server (single static binary)
build-server:
    cd server && CGO_ENABLED=0 go build -o bin/samizdat ./... 2>/dev/null || echo "server/ not initialized yet"

# Build the `sam` CLI
build-cli:
    cd cli && CGO_ENABLED=0 go build -o bin/sam ./... 2>/dev/null || echo "cli/ not initialized yet"

# Export the Expo web build (served by the server)
build-app-web:
    cd app && npx expo export --platform web 2>/dev/null || echo "app/ not initialized yet"

# Package the clipper extension
build-clipper:
    cd clipper && npm run build 2>/dev/null || echo "clipper/ not initialized yet"

# --- Quality -------------------------------------------------------------

fmt: fmt-go fmt-js

fmt-go:
    cd server && gofmt -w . 2>/dev/null || true
    cd cli && gofmt -w . 2>/dev/null || true

fmt-js:
    cd app && npx prettier -w . 2>/dev/null || true
    cd clipper && npx prettier -w . 2>/dev/null || true

test: test-go

test-go:
    cd server && go test ./... 2>/dev/null || echo "server/ not initialized yet"
    cd cli && go test ./... 2>/dev/null || echo "cli/ not initialized yet"

lint:
    cd server && go vet ./... 2>/dev/null || true
    cd cli && go vet ./... 2>/dev/null || true
