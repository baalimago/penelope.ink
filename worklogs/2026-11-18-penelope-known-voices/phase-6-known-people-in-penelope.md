# Phase 6 — Known people in Penelope

**Parent:** root · **Class:** composition · [README](README.md)

## Goal

Minutes' runs carry the voice library and the meeting's people, and the meeting view lets the user keep,
correct and remember voices, as the README's five Flows draw them.

## Interface

The root's interface, the UI `record`. The app has one page, `/`, and no route is added. The exported
functions are written to `web/www/minutes.js`; the two forms are in `web/www/index.html`; the keepers,
the picker and the review are built in `web/www/main.js` and handed to `Minutes`, which exposes them as
`minutes.voices`, `minutes.segments`, `minutes.people` and `minutes.review`. The look and the styles
(`web/www/pad.css`) are the implementer's.

| Element or state | Shown when |
| ---------------- | ---------- |
| `#people`, in `#record-form` after `#details` | New recording is shown and the kept library holds a person (phase 3) |
| `#speakers`, "Who is speaking?" | a meeting is open, no run of it is under way, and the review has a row or something to say (phase 4) |
| `#speakers-said` | the open meeting's naming report has something to say, or a clip was refused or a `voices` command failed (P5) |

What each trigger runs. "Around it" is P1: `VoiceKeeper.put()` resolves before the line starts, and
`VoiceKeeper.take()` after it ends.

| Trigger | Line | People it names (P7) | Around it |
| ------- | ---- | -------------------- | --------- |
| Start recording | today's agent line, with `voicesFlag(names)` beside `-af json` and `peopleLine(names)` as the query's last paragraph | `People.ticked()`, kept on the run as `voices` | put, take |
| Send | today's `chat continue` line with `voicesFlag(names)`; the answer is sent as typed | the `voices` of the run it answers | put, take |
| Try again | today's line, with the flag and the paragraph | the `voices` of the run it tries again | put, take |
| Transcribe again | today's line, with the flag and the paragraph | `namedIn(kept segments)` of the open meeting | put, take |
| Ask Penelope | today's line | none | put, take |
| Keep | `clai audio voices list <slug> <id> confirm` (amended 2026-11-19, clai A04) | | put, take |
| "Not `<name>`?" with a name | `clai audio voices list <slug> <id> overrule` (amended 2026-11-19), then the rename is saved | | put, take |
| Name the speakers with "Remember these voices" | `Minutes.putRecording`, then `clai audio voices add <wav> -from <s> -to <s> -name <name>` (amended 2026-11-19), then the names are saved | | put, take |

```js
/** @typedef {import("./segmentkeeper.js").Segment} Segment */
/** @typedef {import("./segmentkeeper.js").NamingReport} NamingReport */
/** @typedef {import("./segmentkeeper.js").LearnedClip} LearnedClip */
/** @typedef {import("./review.js").Choice} Choice */

/**
 * The run flag that names a meeting's people.
 *
 * - voicesFlag.1 — "" for no name. (P3)
 * - voicesFlag.2 — Otherwise `-voices <names> `, the names joined by commas
 *   and quoted for the shell as one word: `-voices 'Lorentz,Christoph' `.
 *   (known-voices:Flag.1, Flag.3)
 *
 * @param {string[]} names
 * @returns {string}
 */
export function voicesFlag(names) {}

/**
 * The query's paragraph that names a meeting's people.
 *
 * - peopleLine.1 — "" for no name (P3); otherwise `People: ` and the names
 *   joined by ", ": `People: Lorentz, Christoph`.
 *
 * @param {string[]} names
 * @returns {string}
 */
export function peopleLine(names) {}

/**
 * What an `audio_transcribe` result holds, read from its json output.
 *
 * - heardOf.1 — For `{"segments": […], "naming": {…}}` it is
 *   `{segments, naming}`, the segments and the report as parsed.
 *   (known-voices:Output.1, Output.2)
 * - heardOf.2 — For the bare array of segments it is
 *   `{segments, naming: null}`. (known-voices:Output.4)
 * - heardOf.3 — For anything else (text that is no JSON, another shape) it
 *   is null.
 *
 * @param {string} output
 * @returns {{segments: Segment[], naming: NamingReport|null}|null}
 */
export function heardOf(output) {}

/**
 * The clip a record of a run says the run learned.
 *
 * - learnedOf.1 — For a `tool_result` record named `audio_remember_voice`
 *   that did not fail and whose output's first line is
 *   `<name>: clip <id> added (unconfirmed)`, `<id>` 12 lower-case hex
 *   digits, it is `{name, clip: id}`; a second line changes nothing.
 *   (known-voices:audio_remember_voice CallWithContext.11, .12)
 * - learnedOf.2 — For every other record it is null: a failed call, another
 *   tool, another line.
 *
 * @param {object} record  one of clai's -json records
 * @returns {LearnedClip|null}
 */
export function learnedOf(record) {}

/**
 * The people a meeting's kept segments named.
 *
 * - namedIn.1 — The distinct `speaker` of the segments that carry a
 *   `voice`, in order of first appearance; [] for none. (P7)
 *
 * @param {Segment[]} segments
 * @returns {string[]}
 */
export function namedIn(segments) {}

/**
 * The arguments after `clai audio voices` that carry out a choice. (amended
 * 2026-11-19, clai A04: it was `clai audio transcribe voices`)
 *
 * - voicesCommand.1 — Keep: `["list", <slug>, <id>, "confirm"]`, from its
 *   clip "<slug>/<id>". (known-voices:confirm.1, list.7)
 * - voicesCommand.2 — Overrule: `["list", <slug>, <id>, "overrule"]`.
 *   (known-voices:overrule.1, list.7)
 * - voicesCommand.3 — Remember: `["add", wav, "-from", <start>, "-to",
 *   <end>, "-name", <name>]`, the times as JavaScript writes the numbers
 *   (61.2, 69). (known-voices:add.1, voices.5)
 *
 * @param {Choice} choice
 * @param {string} [wav]  the recording's path on the machine, for Remember
 * @returns {string[]}
 */
export function voicesCommand(choice, wav) {}
```

`transcriptLines` (`web/www/proofread.js`) also takes the object `heardOf.1` reads and gives the lines of
its `segments`; for every other output it gives what it gives today. `Minutes.agentLine(query, chat,
profile, voices = [])` takes the names as its last argument.

Clauses:

- record.1 — Before each agent run (Start recording, Send, Try again, Transcribe again, Ask Penelope)
  and each `voices` command, `VoiceKeeper.put()` has resolved; after it ends, `VoiceKeeper.take()` has
  resolved before the run counts as done or the review is drawn again. (P1)
- record.2 — With an empty kept library and nobody ticked, the line, the query and the filed transcript
  of every run are today's bytes, `put` makes no run, and no `voices/` directory appears on the machine.
  (P3, `put.1`)
- record.3 — Each run names its meeting's people as the table says. A run with no name has no `-voices`
  and no People paragraph, so clai's own default applies. (P7, `known-voices:F11`)
- record.4 — The transcript a run files has one line per segment of its last `audio_transcribe` result,
  the speaker as the segment gives it: a library name as the plain name, a label as today. (Flow "Record
  with known people", `known-voices:Output.2`)
- record.5 — When a run that transcribed has filed its meeting and its recording is kept under the
  meeting's summary path, `SegmentKeeper.keep(path, segments, naming, learned)` is called once with that
  path, the `heardOf` of the result the transcript was filed from, and `learned`: the `learnedOf` of this
  run's own records, in their order. The keeper adds them to the clips the path held (`keep.4`). (Flow
  "Record with known people")
- record.6 — A run that learned a clip and transcribed nothing (a Send on a filed meeting) keeps, under
  the meeting it was about, the segments and naming `SegmentKeeper.get` gives for it (`[]` and null when
  it gives null) with `learned` as in record.5. A run that filed no meeting, or that neither transcribed nor learned, keeps nothing.
- record.7 — A run's `learned` holds only clips its own records name: a clip another run added, which
  the same `take` brought back, is not among them. (README Goal, V2-03)
- record.8 — Opening a meeting shows the review with `SegmentKeeper.get(path)` and
  `VoiceKeeper.people()`; it is drawn again after every `take`. (Flow "Open a meeting")
- record.9 — Keep runs its `voicesCommand`; on exit 0 the clip is confirmed in `people()` and its row
  is gone. (Flow "Keep a learned clip", P4)
- record.10 — An overrule runs its `voicesCommand` first. On exit 0, `named(text, from, to)` is applied
  to the summary and the transcript as corrections and `Minutes.saveFixes()` files them. On any other
  exit both files stay as they were. (Flow "Correct a library name in the review", P4)
- record.11 — A Remember puts the meeting's recording on the machine with `Minutes.putRecording`, then
  runs its `voicesCommand` with that file. The `names` of the same `choose` are put in both files and
  saved as today's Name the speakers does, whether or not a clip was added. (Flow "Remember a speaker
  the user named")
- record.12 — The choices of one `choose` are carried out one after the other, each between its own put
  and take, and the renames and names of all of them are saved together, once, after the last command.
- record.13 — A put or a take that resolves false, a `keep` that resolves false, a clip the library
  refused and a `voices` command that fails put up no note. The command's first line of output shows in
  `#speakers-said` (`Review.said`) and on the peek's terminal; a put that failed is a line on the
  terminal, and its run goes on. (P5)
- record.14 — Reassigning one line's speaker in the transcript, and Penelope's corrections, run no
  `voices` command. (P4)
- record.15 — No line, argument, note, status or stored value the root makes holds clip audio: commands
  carry names, clip ids and times. (P2)
- record.16 — The people row is drawn (`People.show`) when New recording is shown and after every take;
  a change of the meeting name pre-ticks it (`People.title`); Start recording passes `People.ticked()` as
  shown at the click and then resets it (`People.reset`). (L3.1, P7)

Consumes:

- `VoiceKeeper.put`, `VoiceKeeper.take`, `VoiceKeeper.people` (phase 1): `put()` and `take()` resolve
  true or false and never reject; `people()` resolves `Person[]`, `{name, slug, clips: [{id, status,
  source, seconds, added}]}`; built as `new VoiceKeeper({run, indexedDB})`
- `SegmentKeeper.keep`, `SegmentKeeper.get` (phase 2): `keep(path, segments, naming, learned)` resolves
  true or false, replacing the path's segments and naming and adding `learned` to the clips it held
  (`keep.4`); `get(path)` resolves `{segments, naming, learned}` or null; built as
  `new SegmentKeeper(indexedDB)`
- `People` (`show`, `title`, `ticked`, `reset`) (phase 3)
- `Review` (`show`, `said`), `Choice`, `ReviewState` (phase 4)
- `instruct` (phase 5): the profile's `audio_remember_voice` tool and its "People:" line, which
  `peopleLine` writes
- `known-voices:` voices CLI (import): `voices add <wav> -from s -to s -name n` and its line `<name>:
  clip <id> added (confirmed)` (`add.1`, `voices.5`); `voices list <person> <clip> confirm|overrule` run
  at once with one line (`list.7`, `confirm.1`, `overrule.1`); exit 0, 1, 2 (`voices.3`); failures on
  stderr
- `known-voices:` root (import): `-voices <names>` on `query` and `chat` (`Flag.1`, `Flag.3`, F11); the
  json output (`Output.1`, `Output.2`, `Output.4`)
- `known-voices:audio_remember_voice` (import): its result line (`CallWithContext.12`)
- `Minutes.run`, `/run/page/out` topics, `Minutes.runAgent` (its `onRecord`), `Minutes.putRecording`,
  `Minutes.writeTranscript`, `Minutes.saveFixes`, `Minutes.meetings`, `Minutes.readMeeting` (import)
- `named`, `transcriptLines` (import, `web/www/proofread.js`); `Proofreader.playSpan` (import)
- Recorded fixture `web/voices-standin.mjs`: a bash `clai` the scenarios put first on the machine's
  `PATH`. Source: the examples of `known-voices` (README "The voices menu, by example" 4, 7 and 9;
  phase 9 "Output of a transcription"; phase 8 `CallWithContext.12`; phase 1's event examples). The real
  clai cannot stand here in the gates: its mock model gives `audio_remember_voice` no arguments, and
  `voices add` inspects real speech. The README's root Human check runs the real one.

Documents edited in this phase: `README.md`, the button table (Start recording, Send, Try again,
Transcribe again, Name the speakers, and rows for Keep and "Not `<name>`?") and the line on where the
voice library is kept; `web/www/penelope-app.md` (the people row under New recording; "Who is
speaking?").

## Acceptance criteria

| #   | Criterion | Proves | Proof |
| --- | --------- | ------ | ----- |
| 1   | With an empty library and nobody ticked, lines, query and filed transcript are today's, and nothing is put on the machine | P3, `record.2`, `voicesFlag.1`, `peopleLine.1`, golden row 1 | `checkRunLines`, `checkKnownPeople › unchanged without voices` |
| 2   | Start recording with people ticked runs with `-voices` and the People paragraph, on a machine that holds the library | Flow "Record with known people", P1, P7, `record.1`, `record.3`, `record.16` | `checkKnownPeople › record with known people` |
| 3   | The filed transcript names the speakers as the segments do, and the meeting keeps its segments, naming and its own run's learned clips | `record.4`, `record.5`, `record.7`, `heardOf.1`, `learnedOf.1` | `checkKnownPeople › record with known people`, `a transcription's output as kept segments`, `the clip a run learned` |
| 4   | What a run wrote in the library is in the browser after it, and survives a new machine | P1, `record.1` | `checkKnownPeople › record with known people` |
| 5   | Send and Try again name the people their meeting started with; Transcribe again names the people its kept segments named | P7, `record.3`, `namedIn.1` | `checkKnownPeople › each run names its people` |
| 6   | Opening the meeting shows the library's names and the learned clip; Keep confirms it | Flows "Open a meeting", "Keep a learned clip", `record.8`, `record.9`, `voicesCommand.1` | `checkKnownPeople › keep` |
| 7   | "Not `<name>`?" overrules the clip that named the speaker before the rename is saved in both files | Flow "Correct a library name in the review", P4, `record.10`, `voicesCommand.2` | `checkKnownPeople › overrule` |
| 8   | Remember these voices adds a confirmed clip from the meeting's recording, at the span given, and names the speaker | Flow "Remember a speaker the user named", `record.11`, `record.12`, `voicesCommand.3` | `checkKnownPeople › remember` |
| 9   | A refused clip and a failed command show in the meeting view and the terminal, never as a note, and a failed overrule saves no rename | P5, `record.10`, `record.13` | `checkKnownPeople › quiet failures` |
| 10  | A transcript row's speaker and Penelope's corrections overrule nothing | P4, `record.14` | `checkKnownPeople › other renames` |
| 11  | A Send that learns a voice keeps it under its meeting; a run that files nothing keeps nothing | `record.6` | `checkKnownPeople › each run names its people` |
| 12  | No clip audio leaves IndexedDB and the machine | P2, `record.15` | `checkKnownPeople › record with known people` |

## Test cases

The unit tests are in `web/units.test.mjs`. `checkRunLines(page)` and `checkKnownPeople(page)` are
scenarios of `web/check.mjs`, on the real page with the real keepers, picker and review. Each step of
the second fails as `FAIL: known people: <step>`.

The stand-in (`web/voices-standin.mjs`) is put first on the machine's `PATH` through `minutes.env`, as
the fake slivingdoc of the notebook's 2026-11-13 note is. It appends every call's arguments to
`/tmp/standin/calls`, with the names under `$(clai confdir)/voices/` at that moment, the size of the
`<wav>` of an `add`, and the sha256 of the open meeting's transcript file. `confdir` and every command
it does not know go to the real clai. A `query` or `chat` prints the records the scenario wrote to
`/tmp/standin/records` and writes the files the scenario listed: the notes, and the clips, `voice.json`
and event lines a real run would leave. `voices list <p> <c> confirm` and `overrule` append the event
line and print the line of menu example 4; `voices add` writes a clip and its `added` line and prints
`<name>: clip <id> added (confirmed)`. With `/tmp/standin/mode` holding `fail`, a `voices` command
writes `Lorentz has no clip ffff` or `clip too short: 1.5 s, a clip is 3–10 s` on stderr and exits 1.

The standing run: records for a meeting "Daily sync": an `audio_transcribe` result whose output is the
object of phase 9's "Output of a transcription" example (Lorentz named by `lorentz/9f3c2a1b0d4e`,
speaker `B` from 9 to 15.5), an `audio_remember_voice` result `Christoph: clip 4be07c19a2f1 added
(unconfirmed)` with that clip laid under `christoph/`, and a reply that links the summary it wrote. The
standing library, taken before the scenario's first run: Lorentz with the confirmed clip
`9f3c2a1b0d4e` and the unconfirmed clip `1a7d0f23c9b8`, which no run of the scenario learned.

| Test | Level | Proves | Given | Then | Must not |
| ---- | ----- | ------ | ----- | ---- | -------- |
| `the flag and the paragraph that name a meeting's people` | unit | `voicesFlag.1`, `voicesFlag.2`, `peopleLine.1`, AC 1 | `[]`; `["Lorentz", "Christoph"]`; `["O'Brien"]` | `""` and `""`; `-voices 'Lorentz,Christoph' ` and `People: Lorentz, Christoph`; a flag bash reads back as the one word `O'Brien` | Write a flag or a paragraph for nobody |
| `a transcription's output as kept segments` | unit | `heardOf.1`–`heardOf.3`, AC 3 | The example object; the bare array of two segments; `"mock transcription"`; `{"segments": 3}` | `{segments, naming}` with `start` 9 and `end` 15.5 as numbers and the first segment's `voice`; `{segments, naming: null}`; null; null | Throw; round a time |
| `the clip a run learned` | unit | `learnedOf.1`, `learnedOf.2`, AC 3 | Records: the standing `audio_remember_voice` result; the same with a second line `overrule of lorentz/ffffffffffff failed: …`; one with `ok: false`; an `audio_transcribe` result; a result `Christoph: clip 4be07c19a2f1 added (confirmed)`; a `tool_call` | `{name: "Christoph", clip: "4be07c19a2f1"}` for the first two; null for the rest | Read a clip from a failed call or another tool |
| `the people kept segments named` | unit | `namedIn.1`, AC 5 | Segments named Lorentz, B, Lorentz, Syrus (the first, third and fourth with `voice`); segments with no `voice` | `["Lorentz", "Syrus"]`; `[]` | Return a label; return a name twice |
| `the command a choice runs` | unit | `voicesCommand.1`–`.3`, AC 6, AC 7, AC 8 | A Keep of `christoph/4be07c19a2f1`; an Overrule of `lorentz/e81d5530c6a9`; a Remember of Speaker B as Christoph from 61.2 to 69 with `/tmp/recordings/again-x.wav` | `["list", "christoph", "4be07c19a2f1", "confirm"]`; `["list", "lorentz", "e81d5530c6a9", "overrule"]`; `["add", "/tmp/recordings/again-x.wav", "-from", "61.2", "-to", "69", "-name", "Christoph"]` | Put the new name of an overrule on the line; write `69.0` |
| `checkRunLines` | integration scenario | golden row 1, P3, `record.2`, AC 1 | The page as loaded, before a key or a login is set: `agentLine` for a new query and for `chat continue`, each with no names and with `["Lorentz", "Christoph"]`; `DEFAULTS.query` for a meeting, with and without `peopleLine`; `transcriptLines` of the bare array and of the example object | The JSON of those texts equals `web/goldens/run-lines.json` | Change an entry that has no names |
| `checkKnownPeople › unchanged without voices` | integration scenario | `record.2`, P3, AC 1 | No kept library, the real clai; New recording; a recording started and stopped as `checkRecording` does | `#people` is hidden; the run's line holds no `-voices` and its query no `People:`; `$(clai confdir)/voices` does not exist; the filed transcript is `MOCK_LINES` under its front matter; `minutes.segments.get(path)` has the two segments with `naming` null and `learned` `[]` | Create `voices/`; run a put line |
| `checkKnownPeople › record with known people` | integration scenario | `record.1`, `record.3`, `record.4`, `record.5`, `record.7`, `record.15`, `record.16`, AC 2, AC 3, AC 4, AC 12 | The standing library kept, `voices/` removed from the machine, the stand-in on `PATH` with the standing run; New recording; `Daily sync` typed; Lorentz ticked; Start; the run ends; then `voices/` removed and `minutes.voices.put()` | `#people` lists Lorentz; the call's arguments hold `-voices`, `Lorentz` and a query ending in `People: Lorentz`; `voices/lorentz/` was on the machine at that call; the transcript's lines are `[0:00] Lorentz: …` and `[0:09] Speaker B: …`; `get(path)` gives the example's segments and naming and `learned` `[{name: "Christoph", clip: "4be07c19a2f1"}]`; `people()` holds Christoph's clip, unconfirmed, New recording's row then lists Christoph with nothing ticked, and the put restores `christoph/4be07c19a2f1.flac`; `localStorage`, the notes and the hood's log hold no slice of a clip; no `.note` | Claim `1a7d0f23c9b8` as learned; write `Lorentz (unconfirmed)`; start clai before the put resolved |
| `checkKnownPeople › each run names its people` | integration scenario | `record.3`, `record.6`, `namedIn.1`, AC 5, AC 11 | After the standing run: a Send on its meeting whose records hold an `audio_remember_voice` result for Ada (clip laid) and no transcription; then Transcribe again; then a Start with nobody ticked whose records file no meeting | The Send's arguments hold `chat`, `continue` and `-voices` with `Lorentz`, and no `People:`; `get(path).learned` is then Christoph's clip and Ada's, the segments as before; Transcribe again's arguments hold `-voices` with `Lorentz` and a query with `People: Lorentz`; the last run's arguments hold no `-voices`, and the number of meetings kept in `minutes-segments` is unchanged by it | Drop Christoph's clip from `learned`; name the ticked people of another meeting |
| `checkKnownPeople › keep` | integration scenario | `record.8`, `record.9`, `voicesCommand.1`, AC 6 | The standing meeting opened; the rows of `#speakers`; Keep pressed on Christoph's row | A library row for Lorentz, a learned row for Christoph, a label row for Speaker B, and no row for `1a7d0f23c9b8`; the stand-in was called with `audio voices list christoph 4be07c19a2f1 confirm` (amended 2026-11-19), with `voices/christoph/` on the machine; afterwards `people()` has the clip confirmed and the learned row is gone; no `.note` | Run an agent; confirm any other clip |
| `checkKnownPeople › overrule` | integration scenario | `record.10`, `record.12`, `voicesCommand.2`, P4, AC 7 | The standing meeting open; "Not Lorentz?" pressed, `Ada` typed, the form submitted; the saved files read back | One call `… voices list lorentz 9f3c2a1b0d4e overrule`, made while the transcript's sha256 was still the unrenamed file's; then both files hold `Ada` where `Lorentz` stood whole, saved as corrections ("Saved"); the Lorentz row is gone; no agent ran | Save the rename before the command; put `Ada` on the command line |
| `checkKnownPeople › remember` | integration scenario | `record.11`, `record.12`, `voicesCommand.3`, AC 8 | The standing meeting open with its recording kept in this browser, the WAV not on the machine; `Syrus` typed for Speaker B, "Remember these voices" ticked, submitted | One call `… voices add <wav> -from 9 -to 15.5 -name Syrus`, the `<wav>` on the machine with the recording's size at that call; `people()` then holds Syrus with a confirmed clip; the transcript reads `[0:09] Syrus: …`, saved; no agent ran | Round a time; run `add` without the recording |
| `checkKnownPeople › quiet failures` | integration scenario | `record.10`, `record.13`, P5, AC 9 | `/tmp/standin/mode` `fail`; on a meeting like the standing one: "Not Lorentz?" with `Ada`; then a Remember of Speaker B as `Syrus`; then `minutes.voices.put` and `take` made to resolve false and `minutes.segments.keep` made to resolve false, and a Send that fails as `checkRecording`'s failed run does | After the overrule: `#speakers-said` holds `Lorentz has no clip ffff`, the terminal holds it, both files are unchanged, no `.note`. After the Remember: `#speakers-said` holds `clip too short`, the transcript reads `Syrus` and is saved, no `.note`. With the failing keepers: the Send's clai was started, `take` was called after it ended, the terminal has a line about the library, and the only `.note` is the failed run's own | Put up a note for a keeper or a command; save a rename whose overrule failed; stop a run for a failed put |
| `checkKnownPeople › other renames` | integration scenario | `record.14`, P4, AC 10 | The standing meeting open; a transcript row's speaker changed from Lorentz to Ada and saved; then a step of Penelope's corrections that renames a speaker, saved; `/tmp/standin/calls` | No `voices` call was made by either | Overrule on a row's rename |

## Error management

| Failure | Expected outcome | Test |
| ------- | ---------------- | ---- |
| `VoiceKeeper.put()` resolves false before a run or a command | a line on the peek's terminal; the run or command goes on; no note (`record.13`) | `checkKnownPeople › quiet failures` |
| `VoiceKeeper.take()` resolves false after a run or a command | no note; the next take adds the rest (`record.13`, `take.7`) | `checkKnownPeople › quiet failures` |
| A `voices … confirm` or `overrule` exits other than 0 | its first line in `#speakers-said` and on the terminal; for an overrule both files stay unrenamed; no note (`record.10`, `record.13`) | `checkKnownPeople › quiet failures` |
| `voices add` refuses the clip (exit 1) | its first line in `#speakers-said` and on the terminal; the names are still saved; no note (`record.11`, `record.13`) | `checkKnownPeople › quiet failures` |
| An `audio_transcribe` output that is neither form (`heardOf` null) | the transcript is filed as today and nothing is kept (`heardOf.3`, `record.6`) | `a transcription's output as kept segments` |
| `SegmentKeeper.keep` resolves false | no note; the meeting later opens with its label rows alone (`record.13`) | `checkKnownPeople › quiet failures` |
| The agent run itself fails | today's note, unchanged; `take()` still runs (`record.1`) | `checkKnownPeople › quiet failures` |

## Golden diff

`web/goldens/run-lines.json` is created by `UPDATE_GOLDENS=1 node check.mjs` from the code as it stands,
before any other change of this phase, with the entries that take no names; `checkRunLines` compares it
on every run of the gate.

| Golden | Change |
| ------ | ------ |
| `web/goldens/run-lines.json` | Its entries `start`, `continue`, `query` and `transcript` (no names, the bare array) are byte for byte as created (P3). It gains four entries: `start-voices` and `continue-voices`, each the entry above it with `-voices 'Lorentz,Christoph' ` beside `-af json`; `query-voices`, `query` followed by a blank line and `People: Lorentz, Christoph`; `transcript-voices`, `[0:00] Lorentz: …` and `[0:09] Speaker B: …` for the example object |

## Removes

None.

## Local facts

None.

## Human required

None.

## Implementation notes

| Run   | Commit      | Command                                                                  | Result                                   |
| ----- | ----------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| start | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | 149 passed, 0 failed; check.mjs ok        |
| end   | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | 154 passed, 0 failed; check.mjs ok, 0 FAIL |
| end   | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | 154 passed, 0 failed; check.mjs ok, 0 FAIL |
| fix-start | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | 154 passed, 0 failed; check.mjs ok, 0 FAIL |
| fix-end | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | 155 passed, 0 failed; check.mjs ok, 0 FAIL |
| fix-end | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | 155 passed, 0 failed; check.mjs ok, 0 FAIL |

Andon: none.
Surprises:
- The machine's exec splits an argument at its newlines, so every multi-paragraph query (People paragraph included) reaches clai as words clai joins with spaces; pre-existing; the stand-in logs the split words and `checkKnownPeople` rejoins them (notebook 2026-11-18T16-43-55Z).
- `checkRecording`'s "hearing a speaker" assertion now compares the ▸ times only: the review draws the rows and keeps each row's span itself, not in `data-start`/`data-end` (the declared change to the speaker rows).
- The page turn clones the sheet, `#speakers` included, so the scenario reads rows from the first `#speakers` only.
- Every agent run now ends with a take, one background `voices/` listing on the machine, and the meetings earlier scenarios file keep their bare segments (`heardOf.2`).
- R1-01 hid while the WAV stayed on the machine: `finish` read the recording back from `audioPath` on every Send, as `kept` was null; an Answer now carries the filed meeting as `kept` and `path`, and the scenario removes the WAV before its Send.
- A run that files another meeting than the one its recording is kept under copies the recording there; only an `unfiled:` key is removed after the move.
- `choose` finds its meeting by path, so a reopen of the same meeting still saves; `nameSpeakers` now resolves the pairs it did not put in, which `choose` tells.
- The two-clip step flaked twice: a page turn's clone held the earlier sheet's typed input and caught `page.$` and `fill`; the step now waits for no `.page-turn` (notebook 2026-11-18T18-22-21Z).
- The new steps fail on the old bodies (scratch mirror): R1-01, R1-02, R1-06, R1-07 FAIL; the old `choose` saved the half-overruled rename; the old reporting fails both R1-05 sub-steps.

## Review findings

### Review 1, 2026-11-18

Findings (README Findings table): R1-01, R1-02, R1-03 (majors), R1-04, R1-05, R1-06, R1-08 (minors).

Verified good:
- Gates green twice. Each README flow's scenario fails if its flow breaks.
- P1: put before and take after every run. P3: run lines match the golden by construction.
- P5 holds on every put, take, keep and `voices` failure path.
- Quoting is verbatim for `O'Brien`, `Zoë`, `$(…)` and backticks.
- `learnedOf` reads only this run's own `audio_remember_voice` lines. The old "Who is speaking?" wiring is fully removed.
- The stand-in speaks the real known-voices shapes.

Design observations for the maintainer (not findings; the code does what the signed flows say):
- `named(file, "Lorentz", "Ada")` renames every whole-word "Lorentz" in both files, a title "Lorentz 1:1"
  included.
- Learned clips of an earlier run of the same meeting (a run that ended on a question, a failed run before
  Try again) get no Keep row.
- Transcribe again passes `namedIn` of the kept segments, so after an overrule it still names the old
  person.


### Review 2, 2026-11-19

Root review, round 2. No new finding. Gates green twice (155 unit tests, `check.mjs` 0 FAIL).

Round-1 findings, verified resolved in the code and by their steps:
- R1-01: an Answer on a filed meeting carries `kept` and `path` from `filed`, so `finish` counts the recording held and `keepSegments` replaces the segments.
- R1-02: an Answer's `path` falls back to `filed`, so a Send that only learns a voice keeps the clip under its meeting.
- R1-03: `speakerOf` writes a segment that carries `voice` as its plain name; `lineSpeaker` goes through `transcriptLines`, so the review and the transcript agree (`TJ`, `J-P`, `JP`).
- R1-04: `choose` saves a row's rename only when every overrule of that row exited 0, and names the clips that failed.
- R1-05: `choose` reports only while the meeting it was made on is open (by path), and says when a rename was not saved.
- R1-06: the hood's process tooltip cuts every long argument but a shell's script (`argsShown`).
- R1-08: the people legend and `penelope-app.md` say what ticking and ticking nobody do.

Verified good:
- No regression from the fixes: a recording kept under another meeting is copied, and only an `unfiled:` key is removed after the move.
- Each README flow is carried out in the order drawn: put, command, take, then the save.
- A `voices` miss without a terminal exits 1 (known-voices `voices.3`), so a stale clip saves no rename.

R1-09 (human checks) stays Open with the maintainer. The three design observations of review 1 stand as observations.
