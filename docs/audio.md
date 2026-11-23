# Recording and audio

How Penelope gets the browser's audio into the machine, records it with ffmpeg, and plays and
downloads files. The agent does the recording: Start recording runs clai, whose tools run ffmpeg
on the machine ([app.md](app.md)).

## Audio inputs

clai's `audio_sources`, `audio_record` and `audio_transcribe` tools, which the
[meeting-transcriber](https://www.clai.chat/hub/baalimago/meeting-transcriber/) profile uses,
find inputs with `ffmpeg -sources pulse`, record with `ffmpeg -f pulse -i NAME`, and stop ffmpeg
with SIGINT. In the page:

| Input | pulse name | What it records |
| --- | --- | --- |
| `/run/audio/mic` | `browser-mic` | The browser's default microphone |
| `/run/audio/tab` | `browser-tab.monitor` | The audio of the screen or tab shared from the checklist. Listed only while something is shared, so clai's `audio_sources` says `system_audio: unavailable` before |
| `/run/audio/devN` | `browser-devN`, or `browser-devN.monitor` | Each other audio input of the browser's. On Linux, PipeWire and PulseAudio offer each output's "Monitor of ..." as one, which holds what the computer plays, a meeting app's audio included: it is a sink's monitor here too, and the first is the default sink |

The page asks for the microphone when it loads, which is what lets the browser name its audio
inputs (if that was refused or dismissed, **Allow the mic** on the checklist asks again), and adds
each to `/run/audio`; `/run/audio/devices` lists them, a `name<TAB>label` line
each. clai's `audio_sources` then sees them all. In the app the query names the inputs the
checklist set up ([app.md](app.md), Start recording), so the agent records those; run from the
terminal, the agent picks which to record by the meeting, by default the default microphone and the
default sink's monitor, mixed into one recording.
A web page gets what the computer plays only from a screen or tab share, or from an input the
OS offers as a loopback: a monitor on Linux, Stereo Mix on Windows when it is enabled, a virtual
device such as BlackHole on macOS. Chrome and Chromium leave monitor sources out of their inputs on Linux, by design. A remapped copy of
the monitor, which is not one, is listed; named "Monitor of ...", it is a monitor here:

```sh
pactl load-module module-remap-source master="$(pactl get-default-sink).monitor" \
  source_name=meeting_audio source_properties='device.description="Monitor of System Audio"'
```

The page adds it when it appears, with no reload. Firefox lists monitors as they are.

## The computer's audio, by browser

The computer's audio, by browser (a monitor input, where there is one, is used instead and needs
no share). Firefox and Safari cannot run Penelope; their rows are here for completeness:

| Browser | Share the whole screen | Share a tab |
| --- | --- | --- |
| Chrome, Edge on Windows and ChromeOS | carries what the computer plays ("Also share system audio") | carries the tab's audio |
| Chrome on macOS | carries it from Chrome 141 on macOS 14.2 and later (reported, not in Chrome's notes); no audio before | carries the tab's audio |
| Chrome on Linux | depends on the version: when the picker offers no system audio, share the tab that plays, or add the monitor above | carries the tab's audio |
| Firefox | no audio | no audio; on Linux the monitor inputs carry it |
| Safari | no audio | no audio |

Browsers ask for a share each time and only from a click. For debugging, Chromium skips the
prompts with `--auto-select-desktop-capture-source="Entire screen"` (or
`--auto-select-tab-capture-source-by-title=YouTube`) and `--use-fake-ui-for-media-stream`, in a
throwaway profile (`--user-data-dir=$(mktemp -d)`); on Linux the monitor above needs only the
microphone's permission, which the browser keeps.

## ffmpeg on the machine

The page captures an input only while something has its file open (the wrapper, then ffmpeg), at 48 kHz on one `AudioContext`,
so a mic and tab recording stay in step. `/usr/local/bin/ffmpeg` (`audio/ffmpeg.sh`) answers
`-sources pulse` and `-sinks pulse` with those names and labels and turns `-f pulse -i NAME` into the raw
file. On SIGINT it writes to the input files, which ends them, so ffmpeg reads to the end and
finishes the WAV as it would on SIGINT: this ffmpeg is plain WASI and cannot catch signals.
A write ends an input only while something has its file open, and ffmpeg takes a second or more
to open its inputs, so the wrapper opens them before it starts ffmpeg, which inherits them: a
Stop in that second still ends the recording.

ffmpeg is 5.1.6 built with the wasi-sdk for wasm32-wasi, without threads and audio only (WAV, MP3,
AAC/M4A, Ogg/Opus/Vorbis, FLAC, Matroska in; WAV, FLAC and MP3 out, MP3 through LAME 3.100, which
clai uses for the pieces of a long recording it splits; the filters clai uses). The
registry's `wasmer/ffmpeg` is a threaded build of a 2023 development snapshot, which deadlocks on
the v2 kernel once its decoder threads start, and ffmpeg 6.0 and later need threads.

## play and download

`play /tmp/t.wav` plays a recording back: whatever is written to `/run/audio/play` goes, once the
file is closed, to a player in the page, and the browser decodes it.

`download ~/notebook/meetings/transcripts/<file>.md` saves a file of the machine on this computer,
in the browser's downloads, under its own name; it takes several files, and refuses a directory
(name its files instead, such as `DIR/*`). A message through `/run/page/out` holds 16 MiB, so the
file goes in parts of 15 MB and the page joins them. Chrome asks once before a page saves several files in a row.

## The meeting-transcriber agent from the terminal

The app runs the agent for you, but the terminal under the hood runs it as well. With an OpenAI
key for the transcription (the profile asks for `gpt-4o-transcribe-diarize`; `-am` overrides it):

```sh
export OPENAI_API_KEY=sk-...
mkdir -p ~/meetings
cd ~/meetings
clai -profile-path cchub:baalimago/meeting-transcriber -query-summary query "Daily sync"
```

clai asks you to trust the profile first (or `clai profiles trust cchub:baalimago/meeting-transcriber`),
starts slivingdoc and the filesystem server (on the directory you run it in) for the notes, and
Enter stops the recording. Run it in the app's terminal (**Peek under the hood**, then
**Terminal**): this clai is built for the page. The recording and the files clai writes on the
machine are gone when the tab reloads; notes last only once slivingdoc has them.

The profile's source is `web/profiles/meeting-transcriber.json`. A change to it goes to the Hub
as the next version with `clai profiles publish web/profiles/meeting-transcriber.json -name
meeting-transcriber -note '<what changed>'`, after `clai cloud login`; each browser then trusts
the new version once: the app checks the hub before each recording and asks again when the version
it trusted was replaced. Publish with a clai built on your computer, from the repository root:
`(cd components/clai && GOTOOLCHAIN=local ../go/bin/go build -o ../../.build/clai .)`, then
`.build/clai cloud login` and `.build/clai profiles publish …` as above; the page's terminal does
not see `web/profiles/`. The app runs
`cchub:baalimago/meeting-transcriber` (`profile` in `web/www/minutes.js`); a copy with its own agent
publishes under its own hub handle and changes that line.
