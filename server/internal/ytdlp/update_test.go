package ytdlp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
)

type memPersist map[string]string

func (m memPersist) Get(_ context.Context, key string) (string, error) { return m[key], nil }
func (m memPersist) Set(_ context.Context, key, value string) error    { m[key] = value; return nil }

// The pinned key must be the one yt-dlp publishes; a swapped file would make
// every signature check vouch for someone else.
func TestPinnedReleaseKey(t *testing.T) {
	keyring, err := openpgp.ReadArmoredKeyRing(bytes.NewReader(releaseKey))
	if err != nil || len(keyring) != 1 {
		t.Fatalf("release key: %v (%d keys)", err, len(keyring))
	}
	got := strings.ToUpper(hex.EncodeToString(keyring[0].PrimaryKey.Fingerprint))
	if got != "AC0CBBE6848D6A873464AF4E57CF65933B5A7581" {
		t.Fatalf("release key fingerprint = %s", got)
	}
}

// fakeRelease is a release host: one signed release whose binary is a stub
// printing binVersion.
type fakeRelease struct {
	tag        string
	binVersion string
	published  time.Time
	signer     *openpgp.Entity
	tamperSums bool // sums no longer match what was signed
	tamperBin  bool // binary no longer matches the signed sum
	hits       atomic.Int32
}

func (f *fakeRelease) serve(t *testing.T) {
	t.Helper()
	bin := []byte("#!/bin/sh\necho " + f.binVersion + "\n")
	sum := sha256.Sum256(bin)
	sums := []byte(hex.EncodeToString(sum[:]) + "  yt-dlp\n")
	var sig bytes.Buffer
	if err := openpgp.DetachSign(&sig, f.signer, bytes.NewReader(sums), nil); err != nil {
		t.Fatalf("sign: %v", err)
	}
	if f.tamperSums {
		sums = append(sums, "0000  yt-dlp_linux\n"...)
	}
	if f.tamperBin {
		bin = append(bin, "echo owned\n"...)
	}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		switch r.URL.Path {
		case "/latest":
			rel := map[string]any{"tag_name": f.tag, "published_at": f.published.Format(time.RFC3339), "assets": []map[string]string{
				{"name": "yt-dlp", "browser_download_url": srv.URL + "/bin"},
				{"name": "SHA2-256SUMS", "browser_download_url": srv.URL + "/sums"},
				{"name": "SHA2-256SUMS.sig", "browser_download_url": srv.URL + "/sig"},
			}}
			_ = json.NewEncoder(w).Encode(rel)
		case "/bin":
			_, _ = w.Write(bin)
		case "/sums":
			_, _ = w.Write(sums)
		case "/sig":
			_, _ = w.Write(sig.Bytes())
		}
	}))
	old := releaseURLs["stable"]
	releaseURLs["stable"] = srv.URL + "/latest"
	t.Cleanup(func() { releaseURLs["stable"] = old; srv.Close() })
}

// trustKey makes signer the release key for the test and returns it.
func trustKey(t *testing.T) *openpgp.Entity {
	t.Helper()
	signer, err := openpgp.NewEntity("test", "", "test@example.com", nil)
	if err != nil {
		t.Fatalf("new key: %v", err)
	}
	var pub bytes.Buffer
	w, err := armor.Encode(&pub, openpgp.PublicKeyType, nil)
	if err == nil {
		err = signer.Serialize(w)
	}
	if err == nil {
		err = w.Close()
	}
	if err != nil {
		t.Fatalf("export key: %v", err)
	}
	old := releaseKey
	releaseKey = pub.Bytes()
	t.Cleanup(func() { releaseKey = old })
	return signer
}

func managedTool(t *testing.T, now time.Time) (*Tool, memPersist) {
	t.Helper()
	persist := memPersist{}
	tool := New(Options{Path: fakeYTDLP(t, "2026.01.01"), AutoUpdate: true, DataDir: t.TempDir(), Persist: persist})
	tool.now = func() time.Time { return now }
	return tool, persist
}

func runVersion(t *testing.T, tool *Tool) string {
	t.Helper()
	out, err := tool.Command(context.Background(), "--version").Output()
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	return strings.TrimSpace(string(out))
}

func TestUpdateInstallsSignedRelease(t *testing.T) {
	now := time.Now()
	rel := &fakeRelease{tag: "2026.08.19", binVersion: "2026.08.19", published: now.Add(-10 * 24 * time.Hour), signer: trustKey(t)}
	rel.serve(t)
	tool, persist := managedTool(t, now)

	if got := runVersion(t, tool); got != "2026.08.19" {
		t.Fatalf("ran %q, want the freshly installed release", got)
	}
	if !strings.Contains(persist[UpdateKey], `"version":"2026.08.19"`) {
		t.Fatalf("state = %s", persist[UpdateKey])
	}
	// The state survives a restart: a new Tool runs the managed copy at once.
	again := New(Options{Path: "definitely-not-a-real-binary-xyz", AutoUpdate: true, DataDir: tool.opts.DataDir, Persist: persist})
	again.now = tool.now
	if got := runVersion(t, again); got != "2026.08.19" {
		t.Fatalf("after restart ran %q", got)
	}
}

// One attempt a day: a second run inside the window must not touch the network.
func TestUpdateAttemptsOncePerDay(t *testing.T) {
	now := time.Now()
	rel := &fakeRelease{tag: "2026.08.19", binVersion: "2026.08.19", published: now.Add(-10 * 24 * time.Hour), signer: trustKey(t)}
	rel.serve(t)
	tool, _ := managedTool(t, now)

	runVersion(t, tool)
	hits := rel.hits.Load()
	runVersion(t, tool)
	if rel.hits.Load() != hits {
		t.Fatalf("second run inside a day hit the release host %d more times", rel.hits.Load()-hits)
	}
	tool.now = func() time.Time { return now.Add(25 * time.Hour) }
	runVersion(t, tool)
	if rel.hits.Load() == hits {
		t.Fatal("a run after a day must check again")
	}
}

// Every refusal keeps the operator's binary running and records why.
func TestUpdateRefusals(t *testing.T) {
	now := time.Now()
	old := now.Add(-10 * 24 * time.Hour)
	cases := []struct {
		name    string
		mutate  func(*fakeRelease)
		wantErr string // "" = a deliberate skip, not a failure
	}{
		{"inside the cooldown", func(f *fakeRelease) { f.published = now.Add(-time.Hour) }, ""},
		{"signed by another key", func(f *fakeRelease) {
			other, err := openpgp.NewEntity("evil", "", "evil@example.com", nil)
			if err != nil {
				t.Fatal(err)
			}
			f.signer = other
		}, "not signed by the yt-dlp release key"},
		{"sums changed after signing", func(f *fakeRelease) { f.tamperSums = true }, "not signed by the yt-dlp release key"},
		{"binary does not match the signed sum", func(f *fakeRelease) { f.tamperBin = true }, "checksum mismatch"},
		{"binary reports another version", func(f *fakeRelease) { f.binVersion = "2020.01.01" }, "reports version"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rel := &fakeRelease{tag: "2026.08.19", binVersion: "2026.08.19", published: old, signer: trustKey(t)}
			c.mutate(rel)
			rel.serve(t)
			tool, _ := managedTool(t, now)

			if got := runVersion(t, tool); got != "2026.01.01" {
				t.Fatalf("ran %q, want the operator's binary", got)
			}
			if got := tool.updateError(); !strings.Contains(got, c.wantErr) || (c.wantErr == "") != (got == "") {
				t.Fatalf("update error = %q, want %q", got, c.wantErr)
			}
			if left, _ := os.ReadDir(filepath.Join(tool.dir(), "bin")); len(left) != 0 {
				t.Fatalf("a refused release left files behind: %v", left)
			}
		})
	}
}

// A release still cooling down is not something the operator must act on.
func TestCheckerIgnoresCoolingRelease(t *testing.T) {
	now := time.Now()
	rel := &fakeRelease{tag: "2026.08.19", binVersion: "2026.08.19", published: now.Add(-time.Hour), signer: trustKey(t)}
	rel.serve(t)
	tool, _ := managedTool(t, now)
	info := NewChecker(tool).check(context.Background())
	if info.Stale || info.Latest != "2026.08.19" || !info.Managed {
		t.Fatalf("info = %+v, want latest seen, managed, not stale", info)
	}
	if got := info.Advice(); got != "" {
		t.Fatalf("advice = %q", got)
	}
}
