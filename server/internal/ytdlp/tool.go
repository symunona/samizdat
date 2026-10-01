package ytdlp

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/symunona/samizdat/server/internal/logger"
)

var log = logger.New("ytdlp")

// Options is how the server wants yt-dlp run.
type Options struct {
	Path       string // operator's binary: used until a managed copy exists, always when AutoUpdate is off
	Cookies    string // cookies.txt the caller passes via --cookies; yt-dlp rewrites it on exit
	AutoUpdate bool   // keep a verified copy under DataDir and run that
	Channel    string // release channel: "stable" (default) or "nightly"
	Sandbox    bool   // confine every run (see sandbox_linux.go)
	DataDir    string // server data dir; yt-dlp state lives in <DataDir>/ytdlp
	MediaDir   string // the one place downloads are written
	Persist    Persist
}

// Tool is the server's only door to yt-dlp. Callers ask for a command and get
// one that is fresh and confined; they never see the updater or the sandbox.
type Tool struct {
	opts Options
	now  func() time.Time

	updating sync.Mutex // one update attempt at a time
	mu       sync.Mutex // guards state and read
	state    updateState
	read     bool // state has been loaded from Persist
}

// New returns a Tool. It does no I/O; the first Command does.
func New(o Options) *Tool {
	if o.Path == "" {
		o.Path = "yt-dlp"
	}
	return &Tool{opts: o, now: time.Now}
}

// Command returns yt-dlp ready to run with args. If the last update attempt is
// more than a day old it attempts one first; a failed attempt is logged and the
// previous binary runs, so an update problem never becomes an ingest failure.
func (t *Tool) Command(ctx context.Context, args ...string) *exec.Cmd {
	if t.opts.AutoUpdate {
		t.refresh(ctx)
	}
	return t.command(ctx, t.bin(), args...)
}

// Version is what the binary in use reports. It never triggers an update.
func (t *Tool) Version(ctx context.Context) (string, error) {
	return t.version(ctx, t.bin())
}

func (t *Tool) version(ctx context.Context, bin string) (string, error) {
	out, err := t.command(ctx, bin, "--version").Output()
	if err != nil {
		return "", fmt.Errorf("yt-dlp --version failed: %w", err)
	}
	// First line only: yt-dlp prints one, but a wrapper script that prints a
	// banner would otherwise make the whole blob the "version".
	return strings.TrimSpace(strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)[0]), nil
}

// bin is the binary a run uses: the managed copy once one is installed, the
// operator's Path before that.
func (t *Tool) bin() string {
	if t.opts.AutoUpdate {
		t.mu.Lock()
		t.load(context.Background())
		v := t.state.Version
		t.mu.Unlock()
		if p := t.managedPath(v); v != "" && fileExists(p) {
			return p
		}
	}
	return t.opts.Path
}

func (t *Tool) dir() string { return filepath.Join(t.opts.DataDir, "ytdlp") }

func (t *Tool) managedPath(version string) string {
	return filepath.Join(t.dir(), "bin", "yt-dlp-"+version)
}

func (t *Tool) command(ctx context.Context, bin string, args ...string) *exec.Cmd {
	resolved, err := exec.LookPath(bin)
	if err != nil || !t.opts.Sandbox {
		// A missing binary is run as-is so the caller gets the ordinary
		// *exec.Error instead of a sandbox failure wrapped around it.
		return exec.CommandContext(ctx, bin, args...)
	}
	if abs, err := filepath.Abs(resolved); err == nil {
		resolved = abs
	}
	home := filepath.Join(t.dir(), "home")
	tmp := filepath.Join(home, "tmp")
	for _, d := range []string{tmp, t.opts.MediaDir} {
		if d == "" {
			continue
		}
		if err := os.MkdirAll(d, 0o755); err != nil {
			log.Errorf("sandbox dir %s: %v", d, err)
		}
	}

	sandbox := []string{SandboxCommand, "--rw", home, "--rw", "/dev/null", "--ro", resolved}
	for _, p := range []string{t.opts.MediaDir, t.opts.Cookies} {
		if p != "" {
			sandbox = append(sandbox, "--rw", p)
		}
	}
	cmd := exec.CommandContext(ctx, selfExe, append(append(sandbox, "--", resolved), args...)...)
	// Built from nothing: the server's own environment holds the LLM API keys.
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + home,
		"XDG_CACHE_HOME=" + filepath.Join(home, ".cache"),
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"TMPDIR=" + tmp,
		"LANG=C.UTF-8",
	}
	return cmd
}

func fileExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular()
}
