//go:build !linux

package ytdlp

import "errors"

// SandboxCommand is the hidden server subcommand that confines and execs.
const SandboxCommand = "ytdlp-sandbox"

const selfExe = ""

// SandboxMain needs Landlock and seccomp, which only Linux has.
func SandboxMain([]string) error {
	return errors.New("sandbox: only supported on Linux (set [ytdlp] sandbox = false to run unconfined)")
}
