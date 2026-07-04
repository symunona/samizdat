// Package credstore persists per-domain scraper login credentials in a 0600
// TOML file (data_dir/credentials.toml). It is deliberately separate from the
// hand-edited config.toml: these secrets are written programmatically by
// `sam login --save` and read back for unattended session refresh. The file is
// gitignored and never committed.
//
// Layout — one table per domain:
//
//	["444.hu"]
//	username = "me@example.com"
//	password = "…"
package credstore

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/BurntSushi/toml"
)

// Creds is a single domain's login pair.
type Creds struct {
	Username string `toml:"username"`
	Password string `toml:"password"`
}

// Store is a concurrency-safe view over data_dir/credentials.toml.
type Store struct {
	path string
	mu   sync.Mutex
}

// New returns a store backed by <dataDir>/credentials.toml. The file need not
// exist yet — Get returns (_, false) until something is saved.
func New(dataDir string) *Store {
	return &Store{path: filepath.Join(dataDir, "credentials.toml")}
}

// load reads the file into a domain→Creds map. A missing file is not an error.
func (s *Store) load() (map[string]Creds, error) {
	m := make(map[string]Creds)
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return m, nil
		}
		return nil, fmt.Errorf("read %q: %w", s.path, err)
	}
	if err := toml.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse %q: %w", s.path, err)
	}
	return m, nil
}

// Get returns the stored credentials for domain, or (_, false) when absent.
func (s *Store) Get(domain string) (Creds, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.load()
	if err != nil {
		return Creds{}, false
	}
	c, ok := m[domain]
	if !ok || c.Username == "" || c.Password == "" {
		return Creds{}, false
	}
	return c, true
}

// Set upserts domain's credentials and rewrites the file with 0600 perms.
func (s *Store) Set(domain string, c Creds) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.load()
	if err != nil {
		return err
	}
	m[domain] = c

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("mkdir cred dir: %w", err)
	}
	// Write to a temp file then rename so a crash can't truncate the store.
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open %q: %w", tmp, err)
	}
	if err := toml.NewEncoder(f).Encode(m); err != nil {
		_ = f.Close()
		return fmt.Errorf("encode creds: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close %q: %w", tmp, err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("rename %q: %w", s.path, err)
	}
	return nil
}
