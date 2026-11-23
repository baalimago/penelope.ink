# Phase 5 — Meeting-transcriber profile

**Parent:** root · **Class:** contract · [README](README.md)

## Goal

The meeting-transcriber profile lets the agent remember a voice and tells it how to work with the names
the voice library gives.

## Interface

Written to `web/profiles/meeting-transcriber.json`. A data contract: one JSON file, the profile clai
runs as `cchub:baalimago/meeting-transcriber` once the maintainer publishes it (README Human checks;
publishing is not a step of this phase). The frozen surface is the `tools` array and the `## Known
voices` section of `prompt`, below; every other key and every other line of the prompt is as the file
has it today.

```text
web/profiles/meeting-transcriber.json     one JSON object, two-space indent, ended by one newline

  tools    the six names the file holds today, in their order, then "audio_remember_voice"
  prompt   today's text, with the section below between the "## Transcription" section
           and "## Storage"; one blank line before "## Storage"
```

```markdown
## Known voices
The user keeps a library of voice clips of the people they meet often. audio_transcribe names a speaker whose voice it finds there, so a transcript can hold names beside labels such as Speaker-B.

- The message's "People:" line says who is in the meeting. The app has already told audio_transcribe to expect them: leave its voices argument out.
- Use a name the library gave as it is. In the json output such a segment carries voice {clip, status}; in text, a name from a clip the user has not confirmed yet is written "<name> (unconfirmed)". Write the plain name in the summary.
- When you are sure who a labelled speaker is, because they said their name or the user told you, remember their voice: call audio_remember_voice with the recording, the name, and the start and end of 3 to 10 seconds in which only that person speaks, taken from the json segments. Never remember a voice on a guess, and remember a person at most once per meeting.
- When the meeting makes clear that a name from the library is wrong, remember the right person the same way and pass overrules with that segment's voice.clip.
- A person on the "People:" line who was not found stays a label: tell the user "failed to find a match for <name>, were they in the meeting?" and ask about them as about any other speaker.
```

Clauses:

- instruct.1 — The file is one JSON object, written with a two-space indent and ended by one newline:
  parsing it and writing it again that way gives its bytes.
- instruct.2 — `tools` is exactly `audio_sources`, `audio_record`, `apply_patch`, `cp`, `date`,
  `audio_transcribe`, `audio_remember_voice`, in that order, and `use_tools` is true.
  (`known-voices:audio_remember_voice`)
- instruct.3 — `prompt` holds the `## Known voices` section above, character for character, once, after
  the `## Transcription` section and before `## Storage`.
- instruct.4 — Without that section, `prompt` is the prompt the file had before this phase, and
  `model`, `description`, `mcp_servers`, `use_skills`, `use_lookback` and `audio` are unchanged.
- instruct.5 — The section tells the agent to leave `audio_transcribe`'s `voices` argument out, so the
  run's `-voices` decides whom a meeting names. (P7, `known-voices:F11`)

Consumes:

- `known-voices:audio_remember_voice` (import): the tool's name, its arguments `file_path`, `start`,
  `end`, `name`, `overrules`, and that the clip it adds is unconfirmed
- `known-voices:` root (import): `audio_transcribe`'s `voices` argument and its precedence over
  `-voices` (`Tool.2`, F11); a named segment's `voice: {clip, status}` (`Output.2`); `<name>
  (unconfirmed)` in text (`Output.3`)

Documents: none. The profile's text is the document; what a user sees of it changes in phase 6.

## Acceptance criteria

| #   | Criterion | Proves | Proof |
| --- | --------- | ------ | ----- |
| 1   | The profile is canonical JSON that clai can load as before, with `audio_remember_voice` among its tools | `instruct.1`, `instruct.2` | `the meeting-transcriber profile lets the agent remember voices` |
| 2   | The prompt holds the Known voices section, in its place, and nothing else of the profile changed | `instruct.3`, `instruct.4`, `instruct.5` | `the meeting-transcriber profile tells the agent about known voices` |

## Test cases

Both tests are in `web/units.test.mjs` and read `web/profiles/meeting-transcriber.json` from disk. The
section's text is a constant of the test file, copied from this phase's Interface. "The prompt before
this phase" is the prompt with the section and the blank line after it taken out; its sha256 is
computed from the file as it stands before the phase's edit and written into the test as a constant.

| Test | Level | Proves | Given | Then | Must not |
| ---- | ----- | ------ | ----- | ---- | -------- |
| `the meeting-transcriber profile lets the agent remember voices` | unit | `instruct.1`, `instruct.2`, AC 1 | The file's text; `JSON.parse` of it | `JSON.stringify(profile, null, 2) + "\n"` equals the file's text; `tools` deep-equals the seven names in order; `use_tools` is true | Reorder or drop a tool; add `*` |
| `the meeting-transcriber profile tells the agent about known voices` | unit | `instruct.3`, `instruct.4`, `instruct.5`, AC 2 | The parsed profile; the section constant | `prompt` holds the section once; its index is after `## Transcription` and before `## Storage`; the prompt without it has the recorded sha256; the section holds `leave its voices argument out`; `model`, `description`, `mcp_servers`, `use_skills`, `use_lookback`, `audio` deep-equal the values recorded in the test | Change another line of the prompt or another key |

## Error management

None.

## Golden diff

None.

## Removes

None.

## Local facts

None.

## Human required

None.

## Implementation notes

| Run   | Commit      | Command                                                                     | Result                                     |
| ----- | ----------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| start | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs`   | 147 passed, 0 failed (seed 567817344); ok  |
| end   | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs`   | 149 passed, 0 failed (seed 1131057071); ok |
| end   | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs`   | 149 passed, 0 failed (seed 2321029241); ok |

Andon: none.
Surprises:
- `check.mjs` runs `components/clai/examples/profiles/meeting-transcriber.json`, not `web/profiles/`, so its gate does not exercise this edit.

## Review findings

None.
