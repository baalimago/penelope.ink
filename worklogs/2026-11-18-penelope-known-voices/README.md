# Penelope knows the people in the meeting

## Goal

Penelope's transcripts name the people the user meets again and again, using clai's known-voices
library (`known-voices`, components/clai/worklogs/2026-11-18-known-voices). Before recording, the user ticks
who is in the meeting from the people the library knows. Afterwards, a speaker the library named shows
its name, and a voice the agent learned on its own asks to be kept. Correcting a name teaches the
library which clips to trust.

What must stay true: P1 (the browser is the library's home), P2 (clip audio stays in the tab), P3
(unchanged without voices), P5 (only a failed run puts up a note), and that parallel runs lose nothing
(L1.2) and claim only what they learned themselves (Flow "Record with known people").

## Glossary

| Term           | Meaning                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Library        | clai's `voices/` directory, in the `known-voices:store` format: per person `voice.json`, clips, events   |
| Kept library   | the browser's copy of the library's files, in IndexedDB                                                  |
| Attendees      | the people ticked under New recording, passed to the run as `-voices` and named in the query             |
| Library name   | a speaker name a library clip gave, carried with its provenance on the segment (`known-voices` root)    |
| Learned clip   | an unconfirmed clip a run's `audio_remember_voice` added, known from that run's own tool results          |
| Keep           | confirming a learned clip (`voices list <person> <clip> confirm`)                                        |
| Overrule       | renaming a library-named speaker (`voices list <person> <clip> overrule`, the clip that named it)       |
| Kept segments  | a meeting's `audio_transcribe` JSON segments and naming report, kept in the browser by its summary path  |
| Choice         | what the voice review hands the root: keep a clip, overrule a clip with a new name, remember a speaker   |

## Flows

### Record with known people

```text
┌──────┐                 ┌────────┐   ┌─────────────┐  ┌─────────┐  ┌───────────────┐
│ user │                 │ record │   │ VoiceKeeper │  │ Minutes │  │ SegmentKeeper │
└───┬──┘                 └────┬───┘   └──────┬──────┘  └────┬────┘  └───────┬───────┘
    │                         │              │              │               │
    │── tick people; Start ──▶│              │              │               │
    │                         │              │              │               │
    │                         │─── put() ───▶│              │               │
    │                         │              │              │               │
    │                         │─── runAgent(… -voices …) ──▶│               │
    │                         │              │              │               │
    │                         │◀─────── its records ────────│               │
    │                         │              │              │               │
    │                         │── take() ───▶│              │               │
    │                         │              │              │               │
    │                         │─── keep(path, segments, naming, learned) ──▶│
    │                         │              │              │               │
    │                         │── writeTranscript(names) ──▶│               │
    │                         │              │              │               │
```

The user ticks the attendees (Lorentz, Christoph) and starts recording. The run is
`clai … -voices 'Lorentz,Christoph' query '… People: Lorentz, Christoph'`. Its records give the last
`audio_transcribe` result, `{segments, naming}`, and each `audio_remember_voice` result
`<name>: clip <id> added (unconfirmed)`: these are the run's learned clips. The transcript is written
with the names as the segments give them.

### Open a meeting

```text
┌──────┐             ┌────────┐                    ┌───────────────┐  ┌─────────────┐ ┌────────┐
│ user │             │ record │                    │ SegmentKeeper │  │ VoiceKeeper │ │ review │
└───┬──┘             └────┬───┘                    └───────┬───────┘  └──────┬──────┘ └────┬───┘
    │                     │                                │                 │             │
    │── open a meeting ──▶│                                │                 │             │
    │                     │                                │                 │             │
    │                     │────────── get(path) ──────────▶│                 │             │
    │                     │                                │                 │             │
    │                     │◀─ segments, naming, learned ───│                 │             │
    │                     │                                │                 │             │
    │                     │─────────────────── people() ────────────────────▶│             │
    │                     │                                │                 │             │
    │                     │◀────────────── people, statuses ─────────────────│             │
    │                     │                                │                 │             │
    │                     │─────────────────────────── show(…) ───────────────────────────▶│
    │                     │                                │                 │             │
```

`get` returns nothing for a meeting filed in another browser. `people()` returns each person's clips and
their statuses.

### Keep a learned clip

```text
┌──────┐   ┌────────┐         ┌────────┐  ┌─────────────┐ ┌────────────┐
│ user │   │ review │         │ record │  │ VoiceKeeper │ │ voices CLI │
└───┬──┘   └────┬───┘         └────┬───┘  └──────┬──────┘ └──────┬─────┘
    │           │                  │             │               │
    │── Keep ──▶│                  │             │               │
    │           │                  │             │               │
    │           │── keep <clip> ──▶│             │               │
    │           │                  │             │               │
    │           │                  │─── put() ──▶│               │
    │           │                  │             │               │
    │           │                  │─── … <p> <clip> confirm ───▶│
    │           │                  │             │               │
    │           │                  │◀─── "confirmed" | error ────│
    │           │                  │             │               │
    │           │                  │── take() ──▶│               │
    │           │                  │             │               │
```

Keep in "Who is speaking?" chooses, for example, `christoph/4be07c19a2f1`, and the run is
`clai audio voices list christoph 4be07c19a2f1 confirm` (known-voices voices CLI; amended 2026-11-19,
clai A04: the voices CLI is `clai audio voices`). It answers
`confirmed` or a typed error.

### Correct a library name in the review

```text
┌──────┐               ┌────────┐             ┌────────┐   ┌─────────────┐ ┌────────────┐  ┌───────────┐  ┌─────────┐
│ user │               │ review │             │ record │   │ VoiceKeeper │ │ voices CLI │  │ proofread │  │ Minutes │
└───┬──┘               └────┬───┘             └────┬───┘   └──────┬──────┘ └──────┬─────┘  └─────┬─────┘  └────┬────┘
    │                       │                      │              │               │              │             │
    │── Not Lorentz: Ada ──▶│                      │              │               │              │             │
    │                       │                      │              │               │              │             │
    │                       │── overrule as Ada ──▶│              │               │              │             │
    │                       │                      │              │               │              │             │
    │                       │                      │─── put() ───▶│               │              │             │
    │                       │                      │              │               │              │             │
    │                       │                      │─── … <p> <clip> overrule ───▶│              │             │
    │                       │                      │              │               │              │             │
    │                       │                      │◀─── "overruled" | error ─────│              │             │
    │                       │                      │              │               │              │             │
    │                       │                      │── take() ───▶│               │              │             │
    │                       │                      │              │               │              │             │
    │                       │                      │─────────── named(text, old, new) ──────────▶│             │
    │                       │                      │              │               │              │             │
    │                       │                      │─────────────────────── saveFixes() ──────────────────────▶│
    │                       │                      │              │               │              │             │
```

The user answers "Not Lorentz?" with Ada in "Who is speaking?". The choice overrules
`lorentz/e81d5530c6a9` as Ada, and the run is `clai audio voices list lorentz e81d5530c6a9
overrule` (amended 2026-11-19), which answers `overruled` or a typed error. `named(file text, "Lorentz", "Ada")` (proofread.js)
then renames the speaker in the summary and the transcript, and `saveFixes()` (Minutes) files both.

### Remember a speaker the user named

```text
┌──────┐              ┌────────┐                     ┌────────┐            ┌─────────┐  ┌─────────────┐ ┌────────────┐
│ user │              │ review │                     │ record │            │ Minutes │  │ VoiceKeeper │ │ voices CLI │
└───┬──┘              └────┬───┘                     └────┬───┘            └────┬────┘  └──────┬──────┘ └──────┬─────┘
    │                      │                              │                     │              │               │
    │── Remember voices ──▶│                              │                     │              │               │
    │                      │                              │                     │              │               │
    │                      │── remember B as Christoph ──▶│                     │              │               │
    │                      │                              │                     │              │               │
    │                      │                              │── putRecording() ──▶│              │               │
    │                      │                              │                     │              │               │
    │                      │                              │────────────── put() ──────────────▶│               │
    │                      │                              │                     │              │               │
    │                      │                              │─────────────── voices add <wav> … ────────────────▶│
    │                      │                              │                     │              │               │
    │                      │                              │◀─────────── "clip <id> added" | error ─────────────│
    │                      │                              │                     │              │               │
    │                      │                              │───────────── take() ──────────────▶│               │
    │                      │                              │                     │              │               │
```

The user names the speakers with "Remember these voices" ticked. The choice remembers Speaker B as
Christoph from 61.2 to 69.0 s. `putRecording(meeting)` puts the meeting's recording on the machine, and the
run is `clai audio voices add <wav> -from 61.2 -to 69 -name Christoph` (amended 2026-11-19). It answers
`Christoph: clip <id> added (confirmed)` or a typed error.

## Status board

**Line:** waiting on human: root

| #   | Node                        | Parent | Class       | Interface                                                                                 | Status      |
| --- | --------------------------- | ------ | ----------- | ----------------------------------------------------------------------------------------- | ----------- |
| 1   | Voice keeper                | root   | contract    | `VoiceKeeper` (`put`, `take`, `people`; `web/www/voicekeeper.js`)                         | Complete |
| 2   | Segment keeper              | root   | contract    | `SegmentKeeper` (`keep`, `get`; `web/www/segmentkeeper.js`)                               | Complete |
| 3   | Attendee picker             | root   | contract    | UI `pick`: New recording's people row (`#people`, `web/www/people.js`)                    | Complete |
| 4   | Voice review                | root   | contract    | UI `review`: "Who is speaking?" library names and choices (`#speakers`, `web/www/review.js`) | Complete |
| 5   | Meeting-transcriber profile | root   | contract    | data contract `instruct`: `web/profiles/meeting-transcriber.json` tools and prompt         | Complete |
| 6   | Known people in Penelope    | root   | composition | root: UI `record`, Minutes' runs and meeting view with the library                        | Complete |

### Imports

| Member                                                                                                          | Kind                      | Used by phases |
| --------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------- |
| `known-voices:store` (phase 1): `voices/<slug>/voice.json`, `<id>.flac`, `events.jsonl`; F10 (union is merge, `.`-files skipped, complete lines) | other worklog, data | 1 |
| `known-voices:` voices CLI (phase 7): `add`, `list <person> <clip> confirm\|overrule` (The voices menu, by example) | other worklog, CLI | 6 |
| `known-voices:` root: `-voices` on `query` and `chat` (F11), segment `voice` field, json `{segments, naming}`   | other worklog, CLI/schema | 2, 4, 6        |
| `known-voices:audio_remember_voice` (phase 8): the tool, and its result `<name>: clip <id> added (unconfirmed)` | other worklog, tool       | 5, 6           |
| `Minutes.run`, `/run/page/out` topics                                                                           | repository app seams      | 1, 6           |
| `Minutes.runAgent` (its `onRecord`), `Minutes.putRecording`, `Minutes.writeTranscript`, `Minutes.saveFixes`     | repository app seams      | 6              |
| `Minutes.meetings` (the filed meetings, by `parseList`), `Minutes.readMeeting`                                  | repository app seams      | 3, 6           |
| `Recordings` (its storage convention: built over `indexedDB`, empty answers without storage), `toBase64` (`recordings.js`) | repository app seams | 1, 2 |
| `transcriptRows`, `isLabel` (`proofread.js`)                                                                    | repository app functions  | 3              |
| `transcriptRows`, `transcriptLines` (`proofread.js`)                                                            | repository app functions  | 4, 6           |
| `Proofreader.playSpan`                                                                                          | repository app functions  | 4              |
| `named` (`proofread.js`)                                                                                        | repository app functions  | 6              |

## Scope

Out of scope, and no phase builds it:

- Anything inside clai: the library, naming, the CLI and the tool are the `known-voices` worklog.
- Sharing the library between browsers or with the desktop clai (`clai cloud` sync, export or import).
  Each browser keeps its own, as it does the Linear sign-in.
- Asking the people in a meeting for consent; the user does.
- Recording a voice outside a meeting; clips come from meetings this browser kept.
- Publishing the profile to the hub is the maintainer's command (Human checks).

## Root facts

**P1 — The browser is the library's home.** Before every agent run (Start recording, Send, Try again,
Transcribe again, Penelope) and every `voices` command, the root puts the kept library on the machine;
after it, the root takes back what the run or command wrote. A reload loses nothing that was taken back.
Binds `VoiceKeeper.put`, `VoiceKeeper.take`, the root.

**P2 — Clip audio stays in the tab.** Clip audio lives only in IndexedDB and in the tab's machine. It
never goes into localStorage, the notebook, a log line or a note. Binds `VoiceKeeper`, `SegmentKeeper`,
the root.

**P3 — Unchanged without voices.** With an empty kept library and nobody ticked, a run's command line,
query and filed transcript are exactly today's, and no file is put on the machine. Binds
`VoiceKeeper.put`, the `pick` UI, the root.

**P4 — Corrections teach the library.** Renaming a library-named speaker in the review overrules the
clip that named it, and a Keep confirms the clip it names, before the rename is saved. Reassigning one
line's speaker in the transcript, and Penelope's corrections, change those lines only and overrule
nothing. Binds the `review` UI, the root.

**P5 — Only a failed run puts up a note.** Naming reports, a clip the library refused, and a failed
`voices` command show in the meeting view or the peek's terminal, never as a note. Binds the `review`
UI, the root.

**P7 — Each run names its meeting's people.** Start recording passes the attendees ticked; Send and Try
again pass the attendees their meeting started with, kept with its run; Transcribe again passes the
people ticked in its note, whose row is pre-ticked with the people the meeting's kept segments named
(amended 2026-11-22). Binds the root.

## Phase-local facts

L1.1 and L1.2 live in `phase-1-voice-keeper.md`, Local facts; L3.1 in `phase-3-attendee-picker.md`,
Local facts; L4.1 in `phase-4-voice-review.md`, Local facts.

## Validation policy

### Gates

```sh
cd web && node --test units.test.mjs
cd web && node check.mjs
```

The golden `web/goldens/run-lines.json` is regenerated by `cd web && UPDATE_GOLDENS=1 node check.mjs`.

### Human checks

| Node | Command                                                                                                                                       | Certified by                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 5    | `clai config publish profile meeting-transcriber` from `web/profiles/`, then `clai config trust profile -check cchub:baalimago/meeting-transcriber` | the hub serves the new version and the app asks to trust it                  |
| 5    | on the deployed site, record a meeting in which someone says their name ("I am Christoph")                                                    | the agent remembers that voice (an unconfirmed clip, Keep shows)             |
| root | `make deploy`; on the deployed site, record meeting 1 with two people, name both under Who is speaking? with Remember these voices; then record meeting 2 with the same two ticked | meeting 2 names both; a third person stays a label; Keep and rename persist across a reload |

## Findings

| ID  | Severity | Node | Owner | Status | Summary |
| --- | -------- | ---- | ----- | ------ | ------- |
| V1-01 | blocker | root | plan | Closed c4a4f9d+wip | check 1 · status board, phases 1–5: no phase file exists (README-only draft) · write phases 1–5 after the README sign-off |
| V1-02 | major | root | plan | Closed c4a4f9d+wip | check 3 · Imports row 2, `voices/<slug>/voice.json`: known-voices declares only "files under `voices/`" and never names `voice.json` or its shape (people, clip status, counters) · cite only what known-voices declares, or have it declare the file layout and `voice.json` shape first |
| V1-03 | major | root | plan | Closed c4a4f9d+wip | check 3 · Imports row 3 and Flow 1 (`clai … -voices 'Lorentz,Christoph' query`): known-voices declares `-voices` with no command or list syntax and uses it only as `audio transcribe <file> -voices <people>` · have known-voices declare `-voices` on agent runs (`query`, `chat continue`) with its list syntax and cite that, or pass attendees by a declared route |
| V1-04 | major | root | fix | Closed c4a4f9d+wip | check 5 · Root facts P4 (Binds phase 3): renames also happen by the transcript row's speaker click and Penelope's corrections, which phase 3 does not own · narrow P4 to phase 3's renames and move it to phase 3's Local facts, or keep it at root and name the root in Binds |
| V1-05 | major | root | fix | Closed c4a4f9d+wip | check 5 · Root facts parameters: `bytes per run carrying clips` binds only VoiceKeeper (phase 1), `pre-ticked attendees` only the picker (phase 2) · move each to its phase's Local facts |
| V1-06 | minor | 2 | plan | Closed c4a4f9d+wip | check 7 · status board row 2: two interfaces in one phase, a UI row and the run's `-voices`/query fragment (code, also claimed by the root's "Minutes' runs"), at phase 1's path `web/www/voices.js` · one interface of one kind, named by its verb, at its own path |
| V1-07 | minor | 3 | plan | Closed c4a4f9d+wip | check 7 · status board row 3: the UI interface has no verb or -er name and no path · name it by its main verb and give its path |
| V1-08 | minor | 4 | plan | Closed c4a4f9d+wip | check 7 · status board row 4: a clai profile (tools and prompt) is no kind in worklog-plan's Interfaces table, and it is named by a file path · express it as a listed kind or have the maintainer add a profile kind; name it by its verb |
| V1-09 | minor | 5 | plan | Closed c4a4f9d+wip | check 7 · status board row 5: the root's interface ("Minutes' runs and meeting view with the library") states no kind and no verb · state the exported interface as one kind (UI: route table plus `Element or state \| Shown when`) named by its verb |
| V1-10 | major | root | plan | Closed c4a4f9d+wip | check 8 · Flow 1, `keep segments beside the recording; file the transcript with the names──▶ notebook`: `notebook` is no declared or imported member, kept segments live in the browser (Glossary), and no member keeps them · split it into a call to a member that keeps segments and a call to the imported filing path |
| V1-11 | major | root | plan | Closed c4a4f9d+wip | check 8 · Flow 2: three triggers in one diagram; no put(kept library) before `voices confirm`, `overrule`, `add` though the machine keeps nothing past a reload and P1 covers agent runs only; `rename in both files` has no target or imported member · one flow per trigger, each put → command → take, the rename a call to an imported member |
| V1-12 | blocker | 3 | plan | Closed c4a4f9d+wip | check 9 · phase 3: library names, their clip id and status, float segment times, and the clips a run learned come from kept segments that no phase below 3 or import provides (`transcriptLines` drops `voice`; `unknownSpeakers` lists labels only; times floored) · declare a member below phase 3, or an import, that keeps a meeting's segments and learned clips, and consume it |
| V1-13 | major | 3 | plan | Closed c4a4f9d+wip | check 9 · phase 3: Keep, overrule and Remember run `clai audio transcribe voices …` on the machine and save the rename (P4), and Remember needs the WAV back on the machine, but phase 3 consumes no `Minutes.run`, `Recordings`/`putRecording` or save path · consume them, or make phase 3 emit the choice and move the commands (and P4) to the root |
| V1-14 | major | 2 | plan | Closed c4a4f9d+wip | check 9 · phase 2: the pre-tick default "people of the last filed meeting with the same title" has no provider; nothing records a meeting's attendees and phase 2 consumes no read of filed meetings · name the member that provides it, or change the default |
| V1-15 | major | root | plan | Closed c4a4f9d+wip | check 9 · P1 and the root's runs: agent runs run side by side (`background: true`), so another run's put rewrites `voices/` under a run in flight and its take reads back a library without that run's learned clip or counters; no clause of VoiceKeeper or known-voices covers it · give concurrent runs a stated rule and owner (serialize, merge on read-back, or a per-run library) |
| V2-01 | major | root | fix | Closed c4a4f9d+wip | check 5 · Root facts P6 ("Binds `VoiceKeeper.put`, `VoiceKeeper.take`"): both members are phase 1's, so its lowest node is phase 1, not the root · move P6 to the Phase-local facts as phase 1's L1.2, or name in its Binds the root step it also needs |
| V2-02 | major | root | plan | Closed c4a4f9d+wip | check 8 · Flow 3 ("rename Lorentz to Ada (any rename path)──▶ review", "named(text, …) on both files, then save──▶ Minutes"): three triggers (P4's Name the speakers, a row's speaker, Penelope's corrections) in one diagram, all drawn through `review`, though a row's speaker is reassigned in the Proofreader and Penelope's corrections come back as fixes; `named` on both files renames every line where one line was reassigned · one flow per rename path, each from where the rename is made, through the overrule, to the save that path already uses |
| V2-03 | major | root | plan | Closed c4a4f9d+wip | check 9 · Flow 1 (`take() ◀── learned clips`, then `keep(summary path, segments, report, learned)`) with P6's take adding only what the kept library lacks: with two runs in flight, the first to end takes the other's `audio_remember_voice` clip and keeps it as its own meeting's, the other meeting never asks, and a take after a `voices` command (Flows 2–4) keeps it under no meeting · take a run's learned clips from its own records (the `audio_remember_voice` results it printed), or give a member a clause that ties a learned clip to the run that wrote it |
| R1-01 | major | 6 | fix | Closed c4a4f9d+wip | record.5 · `minutes.js` `answer()`/`keepSegments` · a Send that transcribes a filed meeting again keeps the old segments (`held` reads only the job's `kept`, nulled when the first run filed); count the recording held when one is kept under `filed.path`; add the step (both reviewers) |
| R1-02 | major | 6 | fix | Closed c4a4f9d+wip | record.6 · `minutes.js` Answer job `path: before?.path` · a Send that learns a voice but neither links nor writes the summary keeps the clip under no meeting; take `before?.path ?? before?.filed`; add the unlinked-reply step (both reviewers) |
| R1-03 | major | 6 | fix | Closed c4a4f9d+wip | record.4, P4 · `proofread.js` `speakerOf`, `review.js` `lineSpeaker` · a library name of one or two capitals or digits (TJ, JP) is written as `Speaker TJ` and shown as a label; a segment that carries `voice` keeps its speaker as it is; add the case (both reviewers) |
| R1-04 | minor | 6 | fix | Closed c4a4f9d+wip | record.10, P4 · `minutes.js` `choose` · a row with two clips saves the rename when one overrule succeeds and the other fails; save a row's rename only when every overrule of that row succeeded, and say which failed |
| R1-05 | minor | 6 | fix | Closed c4a4f9d+wip | record.13, P4 · `minutes.js` `choose` · a command ending after the user opened another meeting reports there and drops a successful overrule's rename silently; report only to the meeting the choice was made on, and say when an overrule ran but its rename was not saved |
| R1-06 | minor | 1, 6 | fix | Closed c4a4f9d+wip | VoiceKeeper.2, P2 · `hood.js` process row `title` · a put run's argv (clip base64) is in the process tooltip; cut long arguments there and extend `checkVoiceKeeper › audio stays` to the process rows |
| R1-07 | minor | 1 | fix | Closed c4a4f9d+wip | people.2, known-voices store.1 `SlugOf` · `voicekeeper.js` `slugOf` uses `toLowerCase`, clai lower-cases per rune (`unicode.ToLower`): `İbrahim` is not listed; lower-case per code point as clai does; add a name with `İ` |
| R1-08 | minor | 6 | fix | Closed c4a4f9d+wip | record.3, known-voices Flag.4 · `penelope-app.md`, `index.html` people legend · say that ticking narrows the naming to those people and that with nobody ticked clai tries every confirmed voice in the library |
| R1-09 | minor | root | maintainer | Open | Human checks · journal · none of the three human checks is recorded; they run after the clai root and the measurement (Q16) |

## Session journal

- 2026-11-18 · plan · README drafted; imports `known-voices`, whose sign-off comes first
- 2026-11-18 · validate · V1 Not ready · inspection: 12 of 14 imported members confirmed, 2 not declared as cited (V1-02, V1-03); no Interface block to type-check · notes: 12
- 2026-11-18 · plan · README amended: Status board (phase 2 Segment keeper added, old 2–5 now 3–6, one interface per phase named by its verb), Imports (cite known-voices `store`, voices CLI, root `-voices`/F11, tool), Flows (one per trigger, put → command → take, filing and rename through imported members), Root facts (P4 at root over every rename path, P6 parallel runs), Phase-local facts section (V1-02, V1-03, V1-06–V1-15)
- 2026-11-18 · fix · V1-04, V1-05 closed · gates not run: README text only, no code changed
- 2026-11-18 · validate · V2 Not ready · inspection: 26 cited imported members (14 in the known-voices README, 12 in web/www), 25 confirmed, `events.jsonl` not declared by known-voices (V1-02 regressed); no Interface block to type-check · notes: 13
- 2026-11-18 · plan · README amended: Flows (learned clips from the run's own `audio_remember_voice` results; Open a meeting; Correct a library name in the review, through `named` and `saveFixes`), Imports (known-voices phase numbers and file names, `Minutes.meetings`, used-by columns), Root facts (P4 narrowed to the review's rename, P7 people per run), P6 moved to L1.2, L4.1 cites known-voices' clip length (V1-02, V1-14, V2-02, V2-03; notes 2–5, 8–10)
- 2026-11-18 · fix · V2-01 closed (P6 is L1.2) · gates not run: README text only, no code changed
- 2026-11-18 · plan · README amended: L3.1 (pre-ticked attendees) decided by the maintainer: pre-tick the people of the last filed meeting with the same title
- 2026-11-18 · plan · README amended: Keep and Overrule run `voices list <person> <clip> confirm|overrule`; Imports cite known-voices' voices CLI as phase 7 and `audio_remember_voice` as phase 8, after known-voices added its Menu phase
- 2026-11-18 · maintainer · README signed
- 2026-11-18 · maintainer · decisions for execution: build everything now and measure in parallel, the root's go-live waits on the measurement note (Q16); interfaces count as signed once worklog-validate gives Ready (Q17, pre-authorized); phases on disjoint files run as parallel agents in waves along the dependency graph, agents run only their own packages' tests, and the orchestrator owns the status board, the journal and one full gate run per wave, departing from the one-agent-per-worklog rule (Q18)
- 2026-11-18 · plan · README amended: Flows redrawn as sequence diagrams with the detail below each; same participants, calls and replies
- 2026-11-18 · plan · phases 1–2 written (voice keeper, segment keeper)
- 2026-11-18 · plan · README amended: Status board row 2 names `keep`, `get`; Imports (`Recordings` storage convention, `toBase64`); Phase-local facts L1.1–L1.2 moved to phase 1, from the phases 1–2 planner's report
- 2026-11-18 · plan · phases 3–6 written (attendee picker, voice review, profile, root)
- 2026-11-18 · plan · README amended: Phase-local facts (L3.1, L4.1 moved to their phases), Validation policy (golden command), Imports (used-by columns; `transcriptLines`; phase 6 uses only `add`, `confirm`, `overrule` of the voices CLI), from the phases 3–6 planner's report
- 2026-11-18 · validate · V3 Ready · inspection: every consumed member of phases 1–6 against its provider (phases 1–2, known-voices README and phases 1, 4, 5, 7, 8, 9, web/www); `cd web && node --test units.test.mjs`: 140 pass · notes: 16
- 2026-11-18 · maintainer · interfaces 1–6 signed (pre-authorized on 2026-11-18 as Q17: the interfaces count as signed once worklog-validate gives Ready); this frontend worklog gets one validation pass and is then built and corrected by feel
- 2026-11-18 · work · phase 1 Complete · `cd web && node --test units.test.mjs`: 141 pass ×2; `cd web && node check.mjs`: ok ×2 (voice keeper 10/10)
- 2026-11-18 · work · phase 2 Complete · `node --test --test-randomize units.test.mjs`: 142 pass ×2; `node check.mjs`: ok ×2 (segment keeper 6/6)
- 2026-11-18 · work · phase 3 Complete · `node --test --test-randomize units.test.mjs`: 144 pass ×2; `node check.mjs`: ok ×2 (people row 5/5)
- 2026-11-18 · work · phase 4 Complete · `node --test --test-randomize units.test.mjs`: 147 pass ×2; `node check.mjs`: ok ×2 (voice review 6/6)
- 2026-11-18 · work · phase 5 Complete · `node --test --test-randomize units.test.mjs`: 149 pass ×2; `node check.mjs`: ok ×2 (it runs clai's examples copy of the profile, so only the two unit tests cover this edit)
- 2026-11-18 · work · phase 6 Complete · `node --test --test-randomize units.test.mjs`: 154 pass ×2; `node check.mjs`: ok ×2 (known people 7/7, run lines as the golden)
- 2026-11-18 · review · root round 1 Not clean · two reviewers: `node --test --test-randomize units.test.mjs` 154 pass ×4; `node check.mjs` ok ×2 · R1-01..R1-09 filed (three majors found by both); phase 6 Reopened (review 1)
- 2026-11-18 · fix · R1-01..R1-08 closed (phase 6: R1-01–R1-05, R1-06 with phase 1, R1-08; phase 1: R1-07); phase 6 Complete · `node --test --test-randomize units.test.mjs` 155 pass ×2; `node check.mjs` ok ×2, 0 FAIL
- 2026-11-19 · orchestrate · fixes verified in the tree (each R1 finding's code and step present) · wave gate: `node --test --test-randomize units.test.mjs` 155 pass; `node check.mjs` exit 0, 0 FAIL
- 2026-11-19 · review · root round 2 Ready · `node --test --test-randomize units.test.mjs`: 155 pass ×2 (seeds 1773553765, 2332736009); `node check.mjs`: ok ×2, 0 FAIL · R1-01..R1-08 verified resolved, no regression, no new finding; R1-09 stays Open (maintainer), so the line waits on the human checks
- 2026-11-19 · maintainer · a person on the "People:" line whom naming did not find is reported in the words "failed to find a match for <name>, were they in the meeting?" (decided for clai's plain command; the profile says the same) · phase 5 instruct.3 section text amended in `phase-5-meeting-transcriber-profile.md`, `web/profiles/meeting-transcriber.json` and its unit pin · `node --test --test-randomize units.test.mjs`: 155 pass; `node check.mjs` not affected (it runs clai's examples copy)
- 2026-11-19 · maintainer · clai's voices CLI moves from `clai audio transcribe voices` to `clai audio voices` (clai A04); Penelope's calls (`web/www/minutes.js`), its stand-in (`web/voices-standin.mjs`), `web/check.mjs` and phase 6 follow
- 2026-11-19 · orchestrate · clai A04 followed in code: `web/www/minutes.js` runs `clai audio voices`, `web/voices-standin.mjs` recognises `audio voices` (its voices branch reads each argument one place earlier), `web/check.mjs` expects the new command lines · `node --test --test-randomize units.test.mjs`: 155 pass; `node check.mjs`: exit 0, 0 FAIL
- 2026-11-19 · orchestrate · deployed from the working trees (`make -o submodules deploy`, clai at 1550dec+wip, wasmer at fd8ffd8; `wasmer deploy --owner baalimago` after the rebuilt app.yaml lost its owner) · `DIST_URL=https://clai-minutes.wasmer.app node check-dist.mjs`: ok · profile published as cchub:baalimago/meeting-transcriber@17 (adds audio_remember_voice) · node 5 trust check and the root meetings are the maintainer's
- 2026-11-22 · maintainer · README amended: P7 · Transcribe again asks who is in the meeting: its note holds the people row (`#again-people`, `People.tick`), pre-ticked with whom the kept segments named, and the run names those ticked (Lorentz: "I didnt get chance to select voices when I transcribe again") · `web/www/{index.html,people.js,minutes.js,main.js}`, `web/check.mjs`
