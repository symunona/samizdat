package ytdlp

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
)

// Why own updater, not `yt-dlp -U`. -U trusts a checksum that sits next to the
// download: whoever swaps the binary swaps the checksum too. Here the checksum
// list must carry a signature from the pinned yt-dlp release key, the binary
// must match the list, and it must report the expected version inside the
// sandbox before it replaces anything.
//
// Why cooldown. Signature proves who built it, not that it is good. A release
// that sits three days in public gets read, run and reported by others first.
//
// Why own copy. The server must not rewrite a binary the operator installed,
// and a versioned file is never changed under a download that is still running.

// UpdateKey is the server_settings key holding the update state as JSON.
const UpdateKey = "ytdlp_update"

const (
	// updateEvery is the minimum gap between update attempts, successful or not.
	updateEvery = 24 * time.Hour
	// Cooldown is how long a release must have been public before it is installed.
	Cooldown = 3 * 24 * time.Hour

	updateTimeout = 3 * time.Minute
	// assetName is the Python zipapp: small, and it runs on the interpreter the
	// operator's own yt-dlp already needed.
	assetName = "yt-dlp"
	sumsName  = "SHA2-256SUMS"
	maxBinary = 64 << 20
)

// releaseKey is the yt-dlp release signing key (public.key in their repo),
// fingerprint AC0C BBE6 848D 6A87 3464 AF4E 57CF 6593 3B5A 7581. A var so tests
// can sign with a throwaway key.
//
//go:embed release-key.asc
var releaseKey []byte

// releaseURLs maps a channel to its latest-release endpoint. A var so tests can
// point a channel at an httptest server.
var releaseURLs = map[string]string{
	"stable":  "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
	"nightly": "https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest",
}

type release struct {
	Tag         string    `json:"tag_name"`
	PublishedAt time.Time `json:"published_at"`
	Assets      []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func (r release) asset(name string) (string, error) {
	for _, a := range r.Assets {
		if a.Name == name {
			return a.URL, nil
		}
	}
	return "", fmt.Errorf("release %s has no %s", r.Tag, name)
}

// updateState is what survives a restart: when an update was last attempted,
// and which managed version is installed.
type updateState struct {
	AttemptedAt string `json:"attempted_at"`
	Version     string `json:"version"`
	Error       string `json:"error,omitempty"`
}

func (t *Tool) releaseURL() string {
	if u, ok := releaseURLs[t.opts.Channel]; ok {
		return u
	}
	return releaseURLs["stable"]
}

// load reads the persisted state once. Callers hold t.mu.
func (t *Tool) load(ctx context.Context) {
	if t.read || t.opts.Persist == nil {
		return
	}
	t.read = true
	if raw, err := t.opts.Persist.Get(ctx, UpdateKey); err == nil && raw != "" {
		_ = json.Unmarshal([]byte(raw), &t.state)
	}
}

// save persists the state. Callers hold t.mu.
func (t *Tool) save(ctx context.Context) {
	if t.opts.Persist == nil {
		return
	}
	raw, err := json.Marshal(t.state)
	if err == nil {
		err = t.opts.Persist.Set(ctx, UpdateKey, string(raw))
	}
	if err != nil {
		log.Errorf("persist update state: %v", err)
	}
}

// updateError is the last update attempt's failure, or "".
func (t *Tool) updateError() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.load(context.Background())
	return t.state.Error
}

// refresh attempts an update when the last attempt is more than updateEvery
// old. The attempt time is stored before any network I/O, so a release host
// that is down costs one try a day, not one per job.
func (t *Tool) refresh(ctx context.Context) {
	t.updating.Lock()
	defer t.updating.Unlock()

	t.mu.Lock()
	t.load(ctx)
	last, err := time.Parse(time.RFC3339, t.state.AttemptedAt)
	if err == nil && t.now().Sub(last) < updateEvery {
		t.mu.Unlock()
		return
	}
	t.state.AttemptedAt = t.now().UTC().Format(time.RFC3339)
	t.save(ctx)
	current := t.state.Version
	t.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, updateTimeout)
	defer cancel()
	version, err := t.update(ctx, current)

	t.mu.Lock()
	defer t.mu.Unlock()
	t.state.Version, t.state.Error = version, ""
	if err != nil {
		t.state.Error = err.Error()
		log.Errorf("update failed, keeping %s: %v", t.describe(version), err)
	}
	t.save(ctx)
}

// describe names the binary in use for a log line.
func (t *Tool) describe(version string) string {
	if version == "" {
		return t.opts.Path
	}
	return "yt-dlp " + version
}

// update installs the channel's latest release if it is new and out of its
// cooldown, and returns the managed version now installed (current on a no-op
// or a failure).
func (t *Tool) update(ctx context.Context, current string) (string, error) {
	rel, err := fetchRelease(ctx, t.releaseURL())
	if err != nil {
		return current, err
	}
	if rel.Tag == current && fileExists(t.managedPath(current)) {
		return current, nil
	}
	if age := t.now().Sub(rel.PublishedAt); age < Cooldown {
		log.Printf("yt-dlp %s is %s old, inside the %s cooldown — not installed yet", rel.Tag, age.Round(time.Hour), Cooldown)
		return current, nil
	}

	want, err := signedSum(ctx, rel)
	if err != nil {
		return current, err
	}
	binDir := filepath.Dir(t.managedPath(rel.Tag))
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return current, fmt.Errorf("mkdir %s: %w", binDir, err)
	}
	tmp, err := downloadBinary(ctx, rel, binDir, want)
	if err != nil {
		return current, err
	}
	defer func() { _ = os.Remove(tmp) }()

	// Last gate: the file is a working yt-dlp of the version the release claims.
	got, err := t.version(ctx, tmp)
	if err != nil {
		return current, fmt.Errorf("downloaded %s does not run: %w", rel.Tag, err)
	}
	if got != rel.Tag {
		return current, fmt.Errorf("downloaded %s reports version %q", rel.Tag, got)
	}
	if err := os.Rename(tmp, t.managedPath(rel.Tag)); err != nil {
		return current, fmt.Errorf("install %s: %w", rel.Tag, err)
	}
	log.Printf("installed yt-dlp %s (was %s)", rel.Tag, t.describe(current))
	t.prune(binDir, rel.Tag, current)
	return rel.Tag, nil
}

// prune drops managed binaries older than the previous one. The previous stays:
// a download that started before the update is still running it.
func (t *Tool) prune(binDir string, keep ...string) {
	entries, err := os.ReadDir(binDir)
	if err != nil {
		return
	}
	kept := map[string]bool{}
	for _, v := range keep {
		kept[filepath.Base(t.managedPath(v))] = true
	}
	for _, e := range entries {
		if !kept[e.Name()] {
			_ = os.Remove(filepath.Join(binDir, e.Name()))
		}
	}
}

// signedSum returns the SHA-256 the release key vouches for.
func signedSum(ctx context.Context, rel release) (string, error) {
	sumsURL, err := rel.asset(sumsName)
	if err != nil {
		return "", err
	}
	sigURL, err := rel.asset(sumsName + ".sig")
	if err != nil {
		return "", err
	}
	sums, err := fetch(ctx, sumsURL, 1<<16)
	if err != nil {
		return "", err
	}
	sig, err := fetch(ctx, sigURL, 1<<16)
	if err != nil {
		return "", err
	}
	keyring, err := openpgp.ReadArmoredKeyRing(bytes.NewReader(releaseKey))
	if err != nil {
		return "", fmt.Errorf("read release key: %w", err)
	}
	if _, err := openpgp.CheckDetachedSignature(keyring, bytes.NewReader(sums), bytes.NewReader(sig), nil); err != nil {
		return "", fmt.Errorf("%s of %s is not signed by the yt-dlp release key: %w", sumsName, rel.Tag, err)
	}
	for _, line := range strings.Split(string(sums), "\n") {
		if f := strings.Fields(line); len(f) == 2 && f[1] == assetName {
			return strings.ToLower(f[0]), nil
		}
	}
	return "", fmt.Errorf("%s of %s lists no %s", sumsName, rel.Tag, assetName)
}

// downloadBinary fetches the release binary into dir and returns its path once
// its SHA-256 equals want.
func downloadBinary(ctx context.Context, rel release, dir, want string) (string, error) {
	url, err := rel.asset(assetName)
	if err != nil {
		return "", err
	}
	body, err := fetch(ctx, url, maxBinary)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	if got := hex.EncodeToString(sum[:]); got != want {
		return "", fmt.Errorf("yt-dlp %s checksum mismatch: got %s, signed %s", rel.Tag, got, want)
	}
	f, err := os.CreateTemp(dir, ".download-*")
	if err != nil {
		return "", fmt.Errorf("create download file: %w", err)
	}
	_, err = f.Write(body)
	if err == nil {
		err = f.Chmod(0o555)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(f.Name())
		return "", fmt.Errorf("write download file: %w", err)
	}
	return f.Name(), nil
}

func fetchRelease(ctx context.Context, url string) (release, error) {
	var rel release
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return rel, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
	if err != nil {
		return rel, fmt.Errorf("release check unreachable: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return rel, fmt.Errorf("release check http %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel); err != nil {
		return rel, fmt.Errorf("decode release: %w", err)
	}
	if rel.Tag == "" {
		return rel, errors.New("release check returned no tag")
	}
	return rel, nil
}

// fetch downloads url, refusing a body larger than limit.
func fetch(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: http %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", url, err)
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("download %s: larger than %d bytes", url, limit)
	}
	return body, nil
}
