// A bash `clai` with known voices, for check.mjs's checkKnownPeople (worklogs/2026-11-18-penelope-known-voices,
// phase 6), put first on the machine's PATH through minutes.env. The real clai cannot stand here: its mock
// model calls audio_remember_voice with no arguments, and `voices add` inspects real speech.
//
// Every call appends to /tmp/standin/calls, NUL-separated: `call`, then `arg <arg>` per argument, `voices
// <slug/file …>` (what $(clai confdir)/voices/ held at that moment), for an `add` `wav <size of its wav>`,
// with /tmp/standin/transcript naming a file `sha <its sha256>`, and `end`. `confdir` and every command it
// does not know go to the real clai.
//
// A `query` or `chat` (an agent run) records 2 s of the page's microphone with ffmpeg when
// /tmp/standin/record exists, as audio_record would; runs /tmp/standin/run.sh in its working directory
// with VOICES set, which writes the notes and the clips, voice.json and event lines a real run would leave;
// and prints /tmp/standin/records, the -json records the scenario wrote. The voices CLI answers as
// known-voices' README "The voices menu, by example" 4 and 9 do: `list <person> <clip> confirm|overrule`
// appends the event line and prints its one line, and `add <wav> -from s -to s -name n` writes a clip, its
// voice.json and its `added` line and prints `<name>: clip <id> added (confirmed)`. With /tmp/standin/mode
// holding `fail`, a voices command says why on stderr, as example 6 or 7 does, and exits 1; a clip id listed in
// /tmp/standin/refuse fails that way alone, so one overrule of a row can fail while another succeeds.
// The machine's exec splits an argument at its newlines, so a multi-paragraph query arrives as several.
// String.raw keeps bash's backslashes; each "${" of bash is written "\\${" so that it is no substitution.
export const VOICES_STANDIN = String.raw`#!/bin/bash
S=/tmp/standin
real=/bin/clai
kind=
[ "$1 $2" = "audio voices" ] && kind=voices
if [ -z "$kind" ]; then for a in "$@"; do case $a in query|q|chat) kind=agent; break;; esac; done; fi
[ -n "$kind" ] || exec "$real" "$@"
shopt -s nullglob
dir=$("$real" confdir)/voices
{
  printf 'call\0'
  for a in "$@"; do printf 'arg\0%s\0' "$a"; done
  printf 'voices\0'
  if [ -d "$dir" ]; then (cd "$dir" && for f in */*; do printf '%s ' "$f"; done); fi
  printf '\0'
  if [ "$kind" = voices ] && [ "$3" = add ]; then printf 'wav\0%s\0' "$({ wc -c < "$4"; } 2>/dev/null || echo missing)"; fi
  t=$(cat "$S/transcript" 2>/dev/null) && t=\${t/#\~/$HOME} && [ -f "$t" ] && printf 'sha\0%s\0' "$(sha256sum < "$t" | cut -d' ' -f1)"
  printf 'end\0'
} >> "$S/calls"
if [ "$kind" = agent ]; then
  n=$(($(cat "$S/runs" 2>/dev/null || echo 0) + 1))
  echo "$n" > "$S/runs"
  if [ -f "$S/record" ]; then
    mkdir -p /tmp/recordings
    ffmpeg -hide_banner -nostdin -loglevel error -f pulse -i browser-mic -t 2 -ac 1 -ar 16000 -y "/tmp/recordings/standin-$n.wav"
  fi
  [ -f "$S/run.sh" ] && VOICES=$dir bash "$S/run.sh"
  cat "$S/records" 2>/dev/null
  exit 0
fi
if [ "$(cat "$S/mode" 2>/dev/null)" = fail ]; then
  if [ "$3" = add ]; then echo "clip too short: 1.5 s, a clip is 3–10 s" >&2; else echo "Lorentz has no clip ffff" >&2; fi
  exit 1
fi
hex() { printf '%04x' $RANDOM $RANDOM $RANDOM $RANDOM | head -c "$1"; }
event() {
  printf '{"id":"%s","at":"%s","event":"%s","clip":"%s"%s}\n' "$(hex 16)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "$3" "$4" >> "$dir/$1/events.jsonl"
}
tenths() { local i=\${1%%.*} f=0; [ "$1" != "$i" ] && f=\${1#*.}; echo $((i * 10 + \${f:0:1})); }
case $3 in
  list)
    slug=$(printf %s "$4" | tr A-Z a-z)
    name=$(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' "$dir/$slug/voice.json" 2>/dev/null)
    [ -n "$name" ] || { echo "no voice named \"$4\"" >&2; exit 1; }
    grep -qxF -- "$5" "$S/refuse" 2>/dev/null && { echo "$name has no clip $5" >&2; exit 1; }
    case $6 in
      confirm) event "$slug" confirmed "$5"; echo "$name/$5: confirmed";;
      overrule) event "$slug" overruled "$5"; echo "$name/$5: overruled (1 of 1 namings wrong)";;
      *) echo "no action \"$6\"" >&2; exit 1;;
    esac;;
  add)
    name=\${10}
    slug=$(printf %s "$name" | tr A-Z a-z | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//')
    [ -f "$4" ] || { echo "open $4: no such file or directory" >&2; exit 1; }
    id=$(hex 12)
    mkdir -p "$dir/$slug"
    [ -f "$dir/$slug/voice.json" ] || printf '{"name":"%s"}\n' "$name" > "$dir/$slug/voice.json"
    head -c 4000 "$4" > "$dir/$slug/.$id.flac.tmp" && mv "$dir/$slug/.$id.flac.tmp" "$dir/$slug/$id.flac"
    d=$(($(tenths "$8") - $(tenths "$6")))
    event "$slug" added "$id" ",\"status\":\"confirmed\",\"source\":\"voices add\",\"seconds\":$((d / 10)).$((d % 10))"
    echo "$name: clip $id added (confirmed)";;
  *) exec "$real" "$@";;
esac
`.replaceAll("\\${", "${");
