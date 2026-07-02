package logger

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// ANSI foreground colors for module differentiation.
var palette = []string{
	"\033[91m", // bright red
	"\033[93m", // bright yellow
	"\033[92m", // bright green
	"\033[96m", // bright cyan
	"\033[94m", // bright blue
	"\033[95m", // bright magenta
	"\033[33m", // yellow
	"\033[36m", // cyan
	"\033[32m", // green
	"\033[35m", // magenta
	"\033[37m", // white/gray
}

const reset = "\033[0m"

func hashColor(module string) string {
	h := 0
	for _, c := range module {
		h = (h*31 + int(c)) & 0x7fffffff
	}
	return palette[h%len(palette)]
}

var (
	mu      sync.Mutex
	enabled           = true
	out     io.Writer = os.Stderr
)

// SetEnabled turns all non-error/fatal logging on or off globally.
func SetEnabled(v bool) {
	mu.Lock()
	enabled = v
	mu.Unlock()
}

// Logger is a module-scoped colored logger.
type Logger struct {
	module string
	color  string
}

// New returns a Logger for the given module name.
// The module name is hashed to a consistent ANSI color.
func New(module string) *Logger {
	return &Logger{module: module, color: hashColor(module)}
}

func (l *Logger) emit(level, format string, args ...any) {
	mu.Lock()
	en := enabled
	mu.Unlock()
	if !en && level != "ERROR" && level != "FATAL" {
		return
	}
	t := time.Now()
	ts := fmt.Sprintf("%02d:%02d:%02d", t.Hour(), t.Minute(), t.Second())
	msg := fmt.Sprintf(format, args...)
	if level == "" {
		_, _ = fmt.Fprintf(out, "%s[%s] [%s]%s %s\n", l.color, ts, l.module, reset, msg)
	} else {
		_, _ = fmt.Fprintf(out, "%s[%s] [%s] [%s]%s %s\n", l.color, ts, l.module, level, reset, msg)
	}
}

// Printf logs at INFO level (format + args like fmt.Sprintf).
func (l *Logger) Printf(format string, args ...any) { l.emit("", format, args...) }

// Println logs a plain string at INFO level.
func (l *Logger) Println(msg string) { l.emit("", "%s", msg) }

// Warnf logs at WARN level.
func (l *Logger) Warnf(format string, args ...any) { l.emit("WARN", format, args...) }

// Errorf logs at ERROR level. Always shown regardless of SetEnabled.
func (l *Logger) Errorf(format string, args ...any) { l.emit("ERROR", format, args...) }

// Fatalf logs at FATAL level and calls os.Exit(1).
func (l *Logger) Fatalf(format string, args ...any) {
	l.emit("FATAL", format, args...)
	os.Exit(1)
}
