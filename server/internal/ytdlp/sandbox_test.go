package ytdlp

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The sandbox re-executes the running binary; under `go test` that is the test
// binary, so it has to answer SandboxCommand the way the server does.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == SandboxCommand {
		fmt.Fprintln(os.Stderr, SandboxMain(os.Args[2:]))
		os.Exit(126)
	}
	os.Exit(m.Run())
}

func sandboxed(t *testing.T) (*Tool, string) {
	t.Helper()
	media := filepath.Join(t.TempDir(), "media")
	return New(Options{Sandbox: true, DataDir: t.TempDir(), MediaDir: media}), media
}

func sh(t *testing.T, tool *Tool, script string) (string, error) {
	t.Helper()
	out, err := tool.command(context.Background(), "/bin/sh", "-c", script).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// The point of the sandbox: a file the server user can read is out of reach.
func TestSandboxHidesFilesOutsideItsDirs(t *testing.T) {
	tool, media := sandboxed(t)
	secret := filepath.Join(t.TempDir(), "id_ed25519")
	if err := os.WriteFile(secret, []byte("PRIVATE"), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := sh(t, tool, "cat "+secret); err == nil || strings.Contains(out, "PRIVATE") {
		t.Fatalf("read a file outside the sandbox: %q", out)
	}
	if out, err := sh(t, tool, "echo x > "+secret); err == nil {
		t.Fatalf("wrote a file outside the sandbox: %q", out)
	}
	if out, err := sh(t, tool, "echo ok > "+media+"/a.m4a && cat "+media+"/a.m4a"); err != nil || out != "ok" {
		t.Fatalf("media dir must stay writable: %q %v", out, err)
	}
}

// The server's environment holds the LLM keys; none of it may be inherited.
func TestSandboxDropsEnvironment(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-secret")
	tool, _ := sandboxed(t)
	out, err := sh(t, tool, "env")
	if err != nil || strings.Contains(out, "sk-secret") {
		t.Fatalf("environment leaked into the sandbox: %v\n%s", err, out)
	}
}

// Another process of the same user is readable through /proc unless Landlock's
// ptrace rule holds — and the server's environ is where the keys are.
func TestSandboxCannotReadParentEnviron(t *testing.T) {
	tool, _ := sandboxed(t)
	if out, err := sh(t, tool, fmt.Sprintf("cat /proc/%d/environ", os.Getpid())); err == nil {
		t.Fatalf("read the parent's environ: %q", out)
	}
}

// Landlock does not see unix sockets here, and the systemd user bus is one.
func TestSandboxBlocksUnixSockets(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("no python3")
	}
	tool, _ := sandboxed(t)
	script := "import socket\nsocket.socket(socket.AF_INET).close()\ntry:\n socket.socket(socket.AF_UNIX)\n print('open')\nexcept PermissionError:\n print('blocked')"
	out, err := tool.command(context.Background(), py, "-c", script).CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "blocked" {
		t.Fatalf("AF_UNIX socket: %q %v", out, err)
	}
}

// A missing binary must stay the ordinary exec error the worker stops on.
func TestMissingBinaryIsExecError(t *testing.T) {
	tool, _ := sandboxed(t)
	err := tool.command(context.Background(), "definitely-not-a-real-binary-xyz").Run()
	if _, ok := err.(*exec.Error); !ok {
		t.Fatalf("err = %T %v, want *exec.Error", err, err)
	}
}
