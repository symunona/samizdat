package ytdlp

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Why sandbox. yt-dlp is stranger code. Must update often, so nobody reads it.
// Runs as server user. Server user owns SSH key, API keys, vault. Bad release
// = attacker owns all. So: yt-dlp sees system dirs read-only, writes media dir
// and own scratch home, nothing else. Bad release then steals nothing.
//
// Why here, not bwrap/docker. One binary rule. No sudo on box. Unprivileged
// user namespaces blocked by AppArmor. Landlock + seccomp need neither: a
// process may always confine ITSELF. Go cannot run code between fork and exec,
// so the server re-runs its own binary as SandboxCommand; that process confines
// its own thread, then execs yt-dlp. Confinement survives exec, covers every
// child (python, ffmpeg, deno), cannot be undone.
//
// Why seccomp too. Landlock on kernels before 6.12 does not see unix sockets.
// The systemd user bus is a unix socket and runs any command for the same uid
// = way out of the sandbox. So: no AF_UNIX sockets, and no io_uring (it opens
// sockets behind seccomp's back).
//
// Not covered: network. yt-dlp needs it. A bad release can still talk out, but
// only about what it can read.

// SandboxCommand is the hidden server subcommand that confines and execs.
const SandboxCommand = "ytdlp-sandbox"

// selfExe re-executes the running binary. Not os.Executable(): after a rebuild
// replaces the file, that path reads "... (deleted)" and every run would fail.
const selfExe = "/proc/self/exe"

// systemPaths is what an interpreter needs to start: binaries, libraries,
// certificates, resolver config. Read-only. Missing entries are skipped.
var systemPaths = []string{"/usr", "/lib", "/lib32", "/lib64", "/bin", "/sbin", "/etc", "/proc", "/dev/urandom", "/dev/random", "/dev/zero"}

const (
	landlockFileRead  = unix.LANDLOCK_ACCESS_FS_EXECUTE | unix.LANDLOCK_ACCESS_FS_READ_FILE
	landlockRead      = landlockFileRead | unix.LANDLOCK_ACCESS_FS_READ_DIR
	landlockFileWrite = landlockFileRead | unix.LANDLOCK_ACCESS_FS_WRITE_FILE | unix.LANDLOCK_ACCESS_FS_TRUNCATE | unix.LANDLOCK_ACCESS_FS_IOCTL_DEV
)

// landlockRights is every filesystem right the given ABI can restrict. All of
// them are handled, so anything without an explicit rule is denied.
func landlockRights(abi int) uint64 {
	rights := uint64(unix.LANDLOCK_ACCESS_FS_EXECUTE | unix.LANDLOCK_ACCESS_FS_WRITE_FILE |
		unix.LANDLOCK_ACCESS_FS_READ_FILE | unix.LANDLOCK_ACCESS_FS_READ_DIR |
		unix.LANDLOCK_ACCESS_FS_REMOVE_DIR | unix.LANDLOCK_ACCESS_FS_REMOVE_FILE |
		unix.LANDLOCK_ACCESS_FS_MAKE_CHAR | unix.LANDLOCK_ACCESS_FS_MAKE_DIR |
		unix.LANDLOCK_ACCESS_FS_MAKE_REG | unix.LANDLOCK_ACCESS_FS_MAKE_SOCK |
		unix.LANDLOCK_ACCESS_FS_MAKE_FIFO | unix.LANDLOCK_ACCESS_FS_MAKE_BLOCK |
		unix.LANDLOCK_ACCESS_FS_MAKE_SYM)
	if abi >= 2 {
		rights |= unix.LANDLOCK_ACCESS_FS_REFER
	}
	if abi >= 3 {
		rights |= unix.LANDLOCK_ACCESS_FS_TRUNCATE
	}
	if abi >= 5 {
		rights |= unix.LANDLOCK_ACCESS_FS_IOCTL_DEV
	}
	return rights
}

// SandboxMain is the body of SandboxCommand: `--rw <path>`… `--ro <path>`…
// `-- <argv>`. It confines the calling thread and replaces the process with
// argv, so it only returns on failure.
func SandboxMain(args []string) error {
	var rw, ro []string
	for len(args) >= 2 && args[0] != "--" {
		switch args[0] {
		case "--rw":
			rw = append(rw, args[1])
		case "--ro":
			ro = append(ro, args[1])
		default:
			return fmt.Errorf("sandbox: unknown flag %q", args[0])
		}
		args = args[2:]
	}
	if len(args) < 2 || args[0] != "--" {
		return errors.New("sandbox: usage: [--rw path]… [--ro path]… -- argv…")
	}
	argv := args[1:]

	// Landlock and seccomp bind the calling thread; exec must leave from the
	// same one or the new program starts unconfined.
	runtime.LockOSThread()
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("sandbox: no_new_privs: %w", err)
	}
	if err := restrictFiles(rw, append(append(ro, systemPaths...), resolverPaths()...)); err != nil {
		return err
	}
	if err := restrictSyscalls(); err != nil {
		return err
	}
	if err := syscall.Exec(argv[0], argv, os.Environ()); err != nil {
		return fmt.Errorf("sandbox: exec %s: %w", argv[0], err)
	}
	return nil
}

func restrictFiles(rw, ro []string) error {
	abi, _, errno := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, 0, 0, unix.LANDLOCK_CREATE_RULESET_VERSION)
	if errno != 0 {
		return fmt.Errorf("sandbox: this kernel has no Landlock (set [ytdlp] sandbox = false to run unconfined): %w", errno)
	}
	handled := landlockRights(int(abi))
	attr := unix.LandlockRulesetAttr{Access_fs: handled}
	// The struct grew with later ABIs; only the filesystem field is set, and
	// its size is the one every Landlock kernel accepts.
	fd, _, errno := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, uintptr(unsafe.Pointer(&attr)), unsafe.Sizeof(attr.Access_fs), 0)
	if errno != 0 {
		return fmt.Errorf("sandbox: landlock ruleset: %w", errno)
	}
	defer func() { _ = unix.Close(int(fd)) }()

	for _, p := range rw {
		if err := allowPath(int(fd), p, handled, landlockFileWrite&handled); err != nil {
			return err
		}
	}
	for _, p := range ro {
		if err := allowPath(int(fd), p, landlockRead, landlockFileRead); err != nil {
			return err
		}
	}
	if _, _, errno := unix.Syscall(unix.SYS_LANDLOCK_RESTRICT_SELF, fd, 0, 0); errno != 0 {
		return fmt.Errorf("sandbox: landlock restrict: %w", errno)
	}
	return nil
}

// allowPath grants dirRights beneath a directory, or fileRights on a single
// file (the kernel rejects directory-only rights on a file).
func allowPath(ruleset int, path string, dirRights, fileRights uint64) error {
	fd, err := unix.Open(path, unix.O_PATH|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("sandbox: open %s: %w", path, err)
	}
	defer func() { _ = unix.Close(fd) }()
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return fmt.Errorf("sandbox: stat %s: %w", path, err)
	}
	rule := unix.LandlockPathBeneathAttr{Allowed_access: fileRights, Parent_fd: int32(fd)}
	if st.Mode&unix.S_IFMT == unix.S_IFDIR {
		rule.Allowed_access = dirRights
	}
	if _, _, errno := unix.Syscall6(unix.SYS_LANDLOCK_ADD_RULE, uintptr(ruleset), unix.LANDLOCK_RULE_PATH_BENEATH, uintptr(unsafe.Pointer(&rule)), 0, 0, 0); errno != 0 {
		return fmt.Errorf("sandbox: landlock rule %s: %w", path, errno)
	}
	return nil
}

// auditArch is the seccomp architecture tag of the native syscall ABI.
var auditArch = map[string]uint32{"amd64": unix.AUDIT_ARCH_X86_64, "arm64": unix.AUDIT_ARCH_AARCH64}

const (
	seccompAllow = 0x7fff0000
	seccompErrno = 0x00050000
	seccompKill  = 0x80000000
	// x32Bit marks amd64's x32 syscall numbers: the same calls under different
	// numbers, which would otherwise walk straight past the filter.
	x32Bit = 0x40000000

	bpfLoad = unix.BPF_LD | unix.BPF_W | unix.BPF_ABS
	bpfJeq  = unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K
	bpfJge  = unix.BPF_JMP | unix.BPF_JGE | unix.BPF_K
	bpfRet  = unix.BPF_RET | unix.BPF_K

	// Offsets into the kernel's struct seccomp_data.
	seccompNr   = 0
	seccompArch = 4
	seccompArg0 = 16
)

func restrictSyscalls() error {
	arch, ok := auditArch[runtime.GOARCH]
	if !ok {
		return fmt.Errorf("sandbox: no seccomp filter for %s (set [ytdlp] sandbox = false to run unconfined)", runtime.GOARCH)
	}
	filter := []unix.SockFilter{
		{Code: bpfLoad, K: seccompArch},
		{Code: bpfJeq, K: arch, Jt: 1},
		{Code: bpfRet, K: seccompKill},
		{Code: bpfLoad, K: seccompNr},
		{Code: bpfJge, K: x32Bit, Jf: 1},
		{Code: bpfRet, K: seccompErrno | uint32(unix.ENOSYS)},
		{Code: bpfJeq, K: unix.SYS_IO_URING_SETUP, Jf: 1},
		{Code: bpfRet, K: seccompErrno | uint32(unix.ENOSYS)},
		{Code: bpfJeq, K: unix.SYS_SOCKET, Jf: 3},
		{Code: bpfLoad, K: seccompArg0},
		{Code: bpfJeq, K: unix.AF_UNIX, Jf: 1},
		{Code: bpfRet, K: seccompErrno | uint32(unix.EACCES)},
		{Code: bpfRet, K: seccompAllow},
	}
	prog := unix.SockFprog{Len: uint16(len(filter)), Filter: &filter[0]}
	if _, _, errno := unix.Syscall(unix.SYS_SECCOMP, unix.SECCOMP_SET_MODE_FILTER, 0, uintptr(unsafe.Pointer(&prog))); errno != 0 {
		return fmt.Errorf("sandbox: seccomp: %w", errno)
	}
	return nil
}

// resolverPaths is where /etc/resolv.conf really lives: on systemd hosts it is
// a symlink into /run, outside every system path.
func resolverPaths() []string {
	target, err := filepath.EvalSymlinks("/etc/resolv.conf")
	if err != nil || target == "/etc/resolv.conf" {
		return nil
	}
	return []string{target}
}
