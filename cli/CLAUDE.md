# CLAUDE.md — cli/

`sam` binary. Cobra commands. Shares engine with server/ once engine package exists.

## Structure
```
cmd/          one file per command group (root.go, setup.go, …)
config/       Config struct + TOML load/save
setup/        Step interface + Runner (step.go)
setup/steps/  numbered step files: 01_data_dir.go, 02_llm.go, …
```

## Setup wizard pattern
Each onboarding step implements `setup.Step`:
- `Name() string` — short label shown in progress
- `ShouldSkip(*config.Config) bool` — idempotent re-run guard
- `Run(*config.Config) error` — mutates cfg in place; Runner saves after each success

Steps are numbered (01_, 02_, …). Order matters; Runner executes in slice order defined in `cmd/setup.go`.

## Config
- Format: TOML, `~/.samizdat/config.toml`, **0600 perms** (contains API keys)
- `config.Defaults()` fills missing fields — Load calls Defaults before decode
- Never add default secret values; leave api_key fields empty string
- Future: keychain integration for secrets; don't store in plaintext beyond config.toml

## Conventions
- `CGO_ENABLED=0` always — pure Go, no cgo
- Wrap all external errors: `fmt.Errorf("context: %w", err)`
- Steps are non-destructive by default: prompt before creating dirs or writing files
- `readLine()` / `expandHome()` helpers live in steps package (not exported — copy-paste is fine for now)

## Stack
- `github.com/spf13/cobra` — CLI dispatch
- `github.com/BurntSushi/toml` — config parse/encode
- No CGO (modernc sqlite will live in server/, not cli/)
