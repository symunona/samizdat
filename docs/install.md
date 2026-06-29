# Install (systemd service)

`just install` installs **this checkout** as its own systemd service so multiple
checkouts can run side by side on different ports.

## How it works
- Service name: **`samizdat-<dir>`** (instance = the repo directory's basename, e.g.
  `samizdat-sam`, `samizdat-sam2`). Override with `INSTANCE=<name> just install`.
- The unit runs **this repo's own binary by absolute path** with **this repo's
  `config.toml`** (`ExecStart=<repo>/server/bin/samizdat serve --config <repo>/config.toml --webdir <repo>/app/dist`).
  Port + `data_dir` come from that `config.toml`, so each instance is isolated.
- Because the service points at the repo's binary (not the shared
  `/usr/local/bin/samizdat` symlink), installing one checkout **cannot hijack**
  another's running service. The `sam`/`samizdat` symlinks are CLI convenience only.

## Running two at once
Give each checkout a distinct `port` (and `data_dir`) in its `config.toml`, then
`just install` from each:

```toml
# ~/dev/sam/config.toml      → samizdat-sam   on :8765
[server]
port = 8765

# ~/dev/sam2/config.toml     → samizdat-sam2  on :8766
data_dir = "/home/you/.samizdat/sam2"
db_path  = "/home/you/.samizdat/sam2/app.db"
[server]
port = 8766
```

```bash
cd ~/dev/sam  && just install   # → samizdat-sam   (:8765)
cd ~/dev/sam2 && just install   # → samizdat-sam2  (:8766)
```

## Conflict prompt (legacy global service)
If the old single `samizdat.service` exists and is owned by a different checkout,
`just install` offers:
- **[t]** take over that legacy service with this checkout,
- **[s]** install this checkout as a separate `samizdat-<dir>` service (run both),
- **[a]** abort.

`FORCE=1` skips the prompt and picks **[s]** (safe — doesn't disturb the other).
`DRY_RUN=1` prints the generated unit and the chosen mode without touching anything.

## Manage
```bash
just service-logs                       # tail (legacy name)
journalctl -u samizdat-<dir> -f         # tail an instance
sudo systemctl restart samizdat-<dir>
sudo systemctl stop    samizdat-<dir>
```
