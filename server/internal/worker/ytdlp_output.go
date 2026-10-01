package worker

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"

	"github.com/symunona/samizdat/server/internal/progress"
)

// ytdlpPercentRe matches a download progress line ("[download]  42.5% of …").
var ytdlpPercentRe = regexp.MustCompile(`^\[download\]\s+([0-9.]+)%`)

// ytdlpPostProcessors are the yt-dlp stages that run after the bytes are in:
// ffmpeg re-encoding or merging, which on a long video is most of the wait.
var ytdlpPostProcessors = []string{"[ExtractAudio]", "[Merger]", "[VideoConvertor]", "[VideoRemuxer]", "[Fixup"}

// ytdlpOutput is where a download run's stdout+stderr go. It keeps what the
// failure classifier reads and turns the rest into job progress: percent lines
// are reported and dropped (thousands on a long download, and none of them is
// an error), a post-processor line moves the job to the convert phase.
type ytdlpOutput struct {
	rep  *progress.Reporter
	kept bytes.Buffer
	line []byte
	// subs is true while the file being downloaded is a subtitle track: those
	// print the same percent lines and would run the bar to 100% before the
	// media starts.
	subs bool
}

func (o *ytdlpOutput) Write(p []byte) (int, error) {
	for _, b := range p {
		if b != '\n' && b != '\r' {
			o.line = append(o.line, b)
			continue
		}
		o.take(string(o.line))
		o.line = o.line[:0]
	}
	return len(p), nil
}

func (o *ytdlpOutput) take(line string) {
	if m := ytdlpPercentRe.FindStringSubmatch(line); m != nil {
		if pct, err := strconv.ParseFloat(m[1], 64); err == nil && !o.subs {
			o.rep.Percent(pct)
		}
		return
	}
	if line == "" {
		return
	}
	o.kept.WriteString(line + "\n")
	if dest, ok := strings.CutPrefix(line, "[download] Destination: "); ok {
		o.subs = strings.HasSuffix(dest, ".vtt")
		return
	}
	for _, pp := range ytdlpPostProcessors {
		if strings.HasPrefix(line, pp) {
			o.rep.Update(func(s *progress.State) { s.Phase = progress.PhaseConvert })
			return
		}
	}
}

// bytes is everything kept, including a final line yt-dlp did not terminate.
func (o *ytdlpOutput) bytes() []byte {
	o.take(string(o.line))
	o.line = nil
	return o.kept.Bytes()
}
