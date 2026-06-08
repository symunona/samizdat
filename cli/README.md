# cli/

`sam` — the headless control surface. Every server command is available from the CLI; it runs on the server box, so it's local-trust (no network auth).

- **Stack:** Go. Shares the engine packages with `server/`.
- **Commands (planned):** `sam init [--reconfigure]` · `config get/set` · `providers scan/list/set` · `pair new` · `device list/revoke` · `sub add/list/rm` · `scraper list` · `pipeline run <doc>` · `job list/retry` · `reindex` (rebuild `app.db` from `vault/`) · `digest build <tag>` · `serve`.

Not initialized yet. Bootstrap: `go mod init`. See `../ARCHITECTURE.md` and `../CLAUDE.md`.
