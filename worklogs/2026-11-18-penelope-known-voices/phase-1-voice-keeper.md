# Phase 1 — Voice keeper

**Parent:** root · **Class:** contract · [README](README.md)

## Goal

Keep the voice library in this browser and move it between the browser and the tab's machine, so that
every run finds the library the browser kept and nothing a run wrote is lost.

## Interface

Written to `web/www/voicekeeper.js`. A code interface: a JSDoc-typed class and the types it passes. The
class, its three members, the types, `VOICES_DB` and the clauses are the frozen surface; the lines it
runs on the machine and the layout inside its database are body.

```js
/**
 * The IndexedDB database of the kept library. No other module opens it, and
 * VoiceKeeper opens no other database: `minutes` stays Recordings' alone.
 */
export const VOICES_DB = "minutes-voices";

/**
 * Minutes.run, as VoiceKeeper calls it: runs `line` on the tab's machine and
 * resolves to its exit status and what it sent to the page under `topic`.
 *
 * @callback Run
 * @param {string} label
 * @param {string} line
 * @param {{topic?: string, followUp?: boolean, background?: boolean, args?: string[]}} options
 * @returns {Promise<{status: number, body: string|null}>}
 */

/**
 * Whether the user stands behind a clip (known-voices:store `Status`).
 * @typedef {"confirmed"|"unconfirmed"} ClipStatus
 */

/**
 * Which member enrolled a clip (known-voices:store `Source`).
 * @typedef {"voices add"|"audio_remember_voice"} ClipSource
 */

/**
 * One clip a person holds, as the kept library's events give it
 * (known-voices:ReadLibrary.4–.6).
 *
 * @typedef {object} Clip
 * @property {string} id       12 lower-case hex digits (known-voices:store.3)
 * @property {ClipStatus} status
 * @property {ClipSource} source
 * @property {number} seconds  its length, from its latest `added` event
 * @property {string} added    the `at` of its latest `added` event, as written
 */

/**
 * One person of the kept library. `<slug>/<clip id>` is the clip reference a
 * segment's `voice.clip` and the voices CLI use.
 *
 * @typedef {object} Person
 * @property {string} name   the name `voice.json` stores (known-voices:store.2)
 * @property {string} slug   the voice's directory name (known-voices:store.1)
 * @property {Clip[]} clips  at least one
 */

/**
 * The kept library: the browser's copy of the files of `known-voices:store`,
 * and the two ways it meets `$(clai confdir)/voices/` on the tab's machine.
 *
 * - VoiceKeeper.1 — The kept library lives in the IndexedDB database
 *   VOICES_DB and nowhere else in the browser. A second VoiceKeeper built
 *   over the same `indexedDB` holds everything the first one took. (P1)
 * - VoiceKeeper.2 — Clip audio is only in VOICES_DB and in the machine's
 *   files. No `label`, `line` or `hint` of a run holds a clip's bytes in any
 *   encoding; a put carries them to the machine only in a run's `args`. No
 *   put, take or people writes localStorage, the terminal or the notebook,
 *   and none puts clip audio into a line of the hood's log. (P2)
 * - VoiceKeeper.3 — No member puts up a note or a status and none rejects:
 *   the outcome of a call is its result. (P5)
 * - VoiceKeeper.4 — Every run a put or a take makes is a `followUp`,
 *   `background` run, so it runs beside an agent run and takes no turn at
 *   the console. Calls in flight at once each get their own answer from the
 *   machine. (L1.2)
 * - VoiceKeeper.5 — With no `indexedDB` (a private window, blocked site
 *   data), or one whose database cannot be opened, the kept library is
 *   empty and stays empty: `put` runs nothing and resolves true, `take` runs
 *   nothing and resolves false, `people` resolves []. (P3)
 */
export class VoiceKeeper {
  /**
   * @param {{run: Run, indexedDB: IDBFactory|undefined}} seams
   */
  constructor({ run, indexedDB }) {}

  /**
   * Puts the kept library on the machine, under `$(clai confdir)/voices/`.
   *
   * - put.1 — With an empty kept library it makes no run, and no file or
   *   directory appears on the machine; it resolves true. (P3)
   * - put.2 — After it resolves true, the machine holds every kept
   *   `<slug>/voice.json` and `<slug>/<id>.flac`, and each machine
   *   `<slug>/events.jsonl` holds every kept event line, whole and ended by
   *   a newline. A file the machine lacked has exactly the kept bytes.
   *   (P1, known-voices:store.1–.4)
   * - put.3 — A `voice.json` or `<id>.flac` the machine already holds keeps
   *   its bytes, whatever the kept copy says. An event line the machine
   *   already holds is not appended again, and the lines the machine holds
   *   keep their bytes and their order: new lines come after them. A put
   *   that follows a put with nothing new changes no file. (L1.2,
   *   known-voices:store.2, store.3, store.4)
   * - put.4 — It deletes nothing: a file, a line or a directory the machine
   *   holds and the kept library lacks is there afterwards, unchanged, names
   *   that start with `.` included. (L1.2, known-voices:F10)
   * - put.5 — The `line` and `args` of each run it makes hold under
   *   2 MiB (2 097 152 bytes) in all; a kept library that needs more is put
   *   in more runs. (L1.1)
   * - put.6 — A clip is on the machine under its name `<id>.flac` only
   *   whole: until its last byte is written it stands under a name that
   *   starts with `.`. (known-voices:F10, store.5)
   * - put.7 — When a run exits other than 0, it makes no further run and
   *   resolves false. What the machine held before the put is unchanged, and
   *   every `<id>.flac` there is whole; a later put writes what is still
   *   lacking. (L1.2)
   *
   * @returns {Promise<boolean>} true when the machine holds the kept library
   */
  async put() {}

  /**
   * Takes back into the kept library what the machine's
   * `$(clai confdir)/voices/` holds and the kept library lacks.
   *
   * - take.1 — With no `voices/` directory on the machine it adds nothing
   *   and resolves true. It never creates, changes or deletes a file on the
   *   machine. (known-voices:ReadLibrary.1, L1.2)
   * - take.2 — After it resolves true, the kept library holds, for every
   *   directory `voices/<slug>/`, its `voice.json`, each `<id>.flac`
   *   (`<id>` 12 lower-case hex digits) with the machine's bytes, and every
   *   complete line of its `events.jsonl`. No other entry is taken.
   *   (P1, known-voices:store.1, store.3, store.4)
   * - take.3 — A kept `voice.json` or `<id>.flac` is never replaced: the
   *   first one kept stays, whatever the machine holds later. A line the
   *   kept library already holds is not added again, and no kept line is
   *   removed. (L1.2, known-voices:store.2, store.3, store.7)
   * - take.4 — A last line of `events.jsonl` that does not end in a newline
   *   is not taken; a later take, once the line is complete, takes it.
   *   (L1.2, known-voices:store.4, F10)
   * - take.5 — A name that starts with `.` is skipped: as a directory under
   *   `voices/` and as a file in a voice's directory, so a clip being
   *   written (`.<id>.flac.tmp`) is never kept. (L1.2, known-voices:store.5)
   * - take.6 — After a take, the kept library holds no `<id>.flac` of a clip
   *   its kept events do not hold (a `removed` event at or after the clip's
   *   latest `added` event, known-voices:ReadLibrary.4), whether or not the
   *   machine still has the file. The clip's event lines stay. A clip added
   *   again after its removal is taken again. (L1.2)
   * - take.7 — When a run exits other than 0, or the machine does not
   *   answer, it resolves false. What it had added by then stays, each file
   *   whole, and a later take adds the rest. (L1.2)
   *
   * @returns {Promise<boolean>} true when the kept library holds what the machine held
   */
  async take() {}

  /**
   * The people of the kept library, with their clips and statuses.
   *
   * - people.1 — It reads the kept library only: it makes no run, and it
   *   resolves the same before and after a put.
   * - people.2 — One Person per kept voice that holds a clip: a directory
   *   whose `voice.json` is a record of known-voices:voice.schema.json, with
   *   `name` its name and `slug` the directory's name. A voice whose clips
   *   are all removed, and a directory with no such `voice.json`, are not
   *   listed. (known-voices:store.1, List.1)
   * - people.3 — A person's clips are the clips the kept events hold whose
   *   `<id>.flac` is kept. A clip is `confirmed` when its latest `added`
   *   event says so or a `confirmed` event follows it, else `unconfirmed`;
   *   `source`, `seconds` and `added` are those of its latest `added` event.
   *   (known-voices:store.6, ReadLibrary.4–.6)
   * - people.4 — The order of the kept lines does not matter, a line kept
   *   twice and events with one `id` count once, and a complete line that is
   *   not a record of known-voices:event.schema.json is skipped and hides no
   *   other line. (known-voices:ReadLibrary.3, ReadLibrary.7, store.7)
   * - people.5 — People come in name order, compared without case; a
   *   person's clips come oldest `added` first, then by id. An empty kept
   *   library is []. (known-voices:List.1 for the people; clip order is this
   *   member's own, since ranking is known-voices' Ranker)
   *
   * @returns {Promise<Person[]>}
   */
  async people() {}
}
```

Consumes:

- `Minutes.run` (import): `run(label, line, {topic, followUp, background, args})` resolving to
  `{status, body}`; `args` are the line's `$1`, `$2`…
- `/run/page/out` topics (import): a message whose first line is the topic `run` was given and whose
  rest is its body
- `Recordings` (import): its storage convention, an object built over `indexedDB` that resolves an empty
  answer when the browser keeps no storage; and `toBase64` of `web/www/recordings.js`
- `known-voices:store` (import): the layout `voices/<slug>/voice.json`, `<id>.flac`, `events.jsonl`,
  `voice.schema.json`, `event.schema.json`, `store.1`–`store.7`
- `known-voices:ReadLibrary` (import): the fold of the event lines, `ReadLibrary.1`, `.3`–`.7`
- `known-voices:F10` (import): union is merge, complete lines, `.`-names

Documents: this phase changes no behaviour a user sees, so the repository `README.md` button table is
not edited here; the phase that wires `put` and `take` into the runs (phase 6) edits it.

## Acceptance criteria

| #   | Criterion                                                                                                         | Proves                                   | Proof                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| 1   | A library a run wrote on the machine is back on a fresh machine after a take, a new VoiceKeeper and a put, byte for byte | P1, `VoiceKeeper.1`, `put.2`, `take.2` | `checkVoiceKeeper › round trip`                              |
| 2   | An empty kept library, and a browser with no storage, put nothing on the machine                                 | P3, `put.1`, `VoiceKeeper.5`             | `checkVoiceKeeper › empty`, `a voice keeper with no storage keeps nothing and runs nothing` |
| 3   | A put while another writer holds the library changes and deletes nothing that is there                           | L1.2, `put.3`, `put.4`                   | `checkVoiceKeeper › put adds only`                           |
| 4   | A take adds only what is lacking and complete, and skips `.`-names                                               | L1.2, `take.3`, `take.4`, `take.5`       | `checkVoiceKeeper › take adds only`                          |
| 5   | Two runs' clips and events are both kept, whichever take comes first                                             | L1.2, `VoiceKeeper.4`                    | `checkVoiceKeeper › two writers`                             |
| 6   | A removed clip's audio leaves the kept library and its events stay                                               | L1.2, `take.6`                           | `checkVoiceKeeper › removed`                                 |
| 7   | A library bigger than one run's arguments goes over in several runs, each under 2 MiB                            | L1.1, `put.5`, `put.6`                   | `checkVoiceKeeper › big library`                             |
| 8   | Clip audio is in `minutes-voices` and the machine's files only                                                   | P2, `VoiceKeeper.2`                      | `checkVoiceKeeper › audio stays`                             |
| 9   | `people` gives each person's clips and statuses as known-voices reads the same files                             | `people.1`–`people.5`                    | `checkVoiceKeeper › people`                                  |
| 10  | A failed run is a false result, never a note, and loses nothing                                                  | P5, `VoiceKeeper.3`, `put.7`, `take.7`   | `checkVoiceKeeper › failed run`                              |

## Test cases

`checkVoiceKeeper(page)` is one scenario of `web/check.mjs`, on the real page and machine. It imports
`./voicekeeper.js` in the page and builds a `VoiceKeeper` over the page's `indexedDB` and a `run` that
records each call's `label`, `line` and options and hands it to `window.minutes.run`. It lays files
under `$(clai confdir)/voices/` and reads them back (names, sizes, `sha256sum`) with lines of its own
through `window.minutes.run`. Clips are bytes the scenario makes up, named by any 12 hex digits: the
keeper never decodes one. A "fresh machine" is `rm -rf "$(clai confdir)/voices"` and a new `VoiceKeeper`
over the same `indexedDB`. The scenario starts from, and leaves, no `voices/` directory and no
`minutes-voices` database. Each step below fails as `FAIL: the voice keeper: <step>`.

The standing library: `lorentz/` with `voice.json` `{"name":"Lorentz"}`, clips `9f3c2a1b0d4e` (added
confirmed by `voices add`) and `1a7d0f23c9b8` (added unconfirmed by `audio_remember_voice`), and the
`added`, `placed` and `named` lines of known-voices' event examples; `christoph/` with `{"name":"christoph"}`
and one unconfirmed clip `4be07c19a2f1`.

| Test | Level | Proves | Given | Then | Must not |
| ---- | ----- | ------ | ----- | ---- | -------- |
| `checkVoiceKeeper › empty` | integration scenario | `put.1`, `people.5`, `take.1`, P3, AC 2 | No `minutes-voices` database, no `voices/` on the machine; `put()`, `people()`, `take()` | `put` true with no call of `run`; `people` `[]`; `take` true; `$(clai confdir)/voices` does not exist | Create `voices/`, or run a line for an empty library |
| `checkVoiceKeeper › round trip` | integration scenario | `VoiceKeeper.1`, `put.2`, `take.2`, `people.1`, P1, AC 1 | The standing library on the machine; `take()`; `people()`; a fresh machine; `people()`; `put()` | `take` true; after `put` true every file has the name and `sha256sum` it had, and each `events.jsonl` holds the same lines, each ended by a newline; `people` is equal before and after the put, and made no call of `run` | Keep the library in the instance; write any file but the three kinds of the layout |
| `checkVoiceKeeper › put adds only` | integration scenario | `put.3`, `put.4`, L1.2, AC 3 | Kept: the standing library. Machine: `lorentz/voice.json` as `{"name":"LORENTZ"}`, `lorentz/9f3c2a1b0d4e.flac` with other bytes, `lorentz/events.jsonl` holding one kept line and one line the kept library lacks, in that order, `lorentz/.aaaaaaaaaaaa.flac.tmp`, `syrus/` with a clip and events; `put()` twice | The four machine files that were there have their `sha256sum`; `events.jsonl` starts with its two lines, in order, followed by the kept lines it lacked, each once; `syrus/` and the `.tmp` are unchanged; `1a7d0f23c9b8.flac` and `christoph/` are added; the second put changes no file's size or hash | Rewrite `voice.json` or a clip; append a held line again; delete or truncate anything |
| `checkVoiceKeeper › take adds only` | integration scenario | `take.3`, `take.4`, `take.5`, L1.2, AC 4 | Kept: the standing library. Machine: the same with `lorentz/voice.json` as `{"name":"LORENTZ"}`, `9f3c2a1b0d4e.flac` with other bytes, a new clip `e81d5530c6a9.flac`, `.bbbbbbbbbbbb.flac.tmp`, a directory `.trash/` with a `voice.json` and a clip, a file `notes.txt`, and `events.jsonl` ending in the `added` line of `e81d5530c6a9` and then half a line without a newline; `take()`; a fresh machine; `put()`; then the half line completed on the machine and `take()` again | After the first put on the fresh machine: `voice.json` and `9f3c2a1b0d4e.flac` are the first kept bytes, `e81d5530c6a9.flac` is there, every kept line is there once, and there is no `.tmp`, no `.trash/`, no `notes.txt` and no half line; after the second take, `people()` reflects the completed line's event | Replace a kept file; keep a `.`-name or an unfinished line; drop a kept line |
| `checkVoiceKeeper › two writers` | integration scenario | `VoiceKeeper.4`, L1.2, AC 5 | Kept: the standing library, put on the machine. Writer A's files are laid (a new clip and its `added` line for `lorentz`), then `take()` and, without waiting for it, `put()`; then writer B's files (a new person `ada` with a clip and events, and a `confirmed` line for `4be07c19a2f1`), then `take()` and `take()` at once; every recorded `run` option | All four calls resolve true; `people()` lists A's clip, `ada`, and `4be07c19a2f1` as `confirmed`; a fresh machine after `put()` holds A's and B's files and lines; every recorded run had `followUp` and `background` true | Lose a clip or a line of either writer; hand one call another call's answer; run without `background` |
| `checkVoiceKeeper › removed` | integration scenario | `take.6`, L1.2, AC 6 | Kept: the standing library. On the machine a `removed` line for `1a7d0f23c9b8` is appended and its file is left in place; `take()`; a fresh machine; `put()`; then the clip's file and a later `added` line are laid again and `take()` | After the first take `people()` lists Lorentz without `1a7d0f23c9b8`; on the fresh machine after the put there is no `1a7d0f23c9b8.flac` and the `removed` line and the clip's earlier lines are there; after the last take the clip is listed again and a put restores its file | Keep the audio of a removed clip; drop its event lines |
| `checkVoiceKeeper › big library` | integration scenario | `put.5`, `put.6`, L1.1, AC 7 | Kept: six clips of 400 000 bytes for one person (taken from the machine), then a fresh machine and `put()`; the recorded runs; then the same on a fresh machine with a `run` that, from its second call on, lists `voices/<slug>/` before it forwards | `put` true in more than one run; for every run, the length of `line` plus the lengths of `args` is under 2 097 152; the six files have their `sha256sum`; in every listing each `<id>.flac` present has its full size and hash | Send one run of 2 MiB or more; show a part-written clip under its name |
| `checkVoiceKeeper › audio stays` | integration scenario | `VoiceKeeper.2`, P2, AC 8 | A snapshot of `localStorage` and of the notebook directory's file list; the standing library taken, a fresh machine, `put()`; the base64 of each clip's first 48 bytes, and that slice as text | No recorded `label`, `line` or `hint` holds a slice in either form; `localStorage`, the notebook's files, `window.terminalText()` and every `text` of `window.hoodModel.log` hold none and the first two are as snapshotted; the databases of the page are `minutes-voices` and those that were there, and `minutes` has the keys it had | Put clip bytes in a line, a log entry, localStorage or a Recordings key |
| `checkVoiceKeeper › people` | integration scenario | `people.2`, `people.3`, `people.4`, `people.5`, AC 9 | Machine: the standing library plus `ada/` with `{"name":"Ada"}` and a clip that is `added` unconfirmed and later `confirmed`; `empty/` with a `voice.json` and a clip added then removed; `nobody/` with a clip and events and no `voice.json`; `bad/` with `voice.json` `{"nom":"x"}`; in `lorentz/events.jsonl` the lines shuffled, one line twice, a blank line, a line `{"event":"added"}`, an `added` line for a clip with no file, a `confirmed` line for a clip never added; `take()`; `people()` | Exactly Ada (`ada`), christoph (`christoph`), Lorentz (`lorentz`), in that order; Ada's clip `confirmed`; Lorentz's clips `9f3c2a1b0d4e` `confirmed` `voices add` and `1a7d0f23c9b8` `unconfirmed` `audio_remember_voice`, oldest first, with the `seconds` and `added` of their `added` lines; no clip without a file and none never added | List a voice with no clip or no valid `voice.json`; count a repeated line twice; let a bad line hide another |
| `checkVoiceKeeper › failed run` | integration scenario | `put.7`, `take.7`, `VoiceKeeper.3`, P5, AC 10 | The big library kept and a fresh machine; a `run` that forwards its first two calls and answers `{status: 1, body: null}` from the third on without running; `put()`; the notes on the page; then the real `run` and `put()`; then, for take, the standing library on the machine, an empty kept library and a `run` that answers `{status: 1, body: null}` to every call; `take()`, then the real `run` and `take()` | The failing `put` and `take` resolve false, do not reject, call `run` no more after the first failing answer, and the page shows no note and no status text of theirs; every `<id>.flac` on the machine after the failed put has its full hash; the later put and take resolve true and the round trip holds | Reject; put up a note; leave a part-written clip under its name; start over by deleting |
| `a voice keeper with no storage keeps nothing and runs nothing` | unit | `VoiceKeeper.5`, `VoiceKeeper.3`, P3, AC 2 | `new VoiceKeeper({ run, indexedDB: undefined })` and one with an `indexedDB` whose `open` fires `onerror`, `run` counting its calls; `put()`, `take()`, `people()` | `put` true, `take` false, `people` `[]`; `run` was never called; nothing rejects | Throw on a missing `indexedDB`; run a line |

## Error management

| Failure | Expected outcome | Test |
| ------- | ---------------- | ---- |
| The browser keeps no storage, or `minutes-voices` cannot be opened | `put` resolves true and `take` false with no run, `people` resolves `[]`; no rejection, no note (`VoiceKeeper.5`) | `a voice keeper with no storage keeps nothing and runs nothing` |
| A run of a put exits other than 0 | `put` resolves false, makes no further run; the machine's earlier files unchanged, every clip there whole; no note (`put.7`, `VoiceKeeper.3`) | `checkVoiceKeeper › failed run` |
| A run of a take exits other than 0, or the machine sends no answer | `take` resolves false; what was added stays, whole; a later take adds the rest; no note (`take.7`, `VoiceKeeper.3`) | `checkVoiceKeeper › failed run` |
| The machine has no `voices/` directory | not a failure: `take` adds nothing and resolves true (`take.1`) | `checkVoiceKeeper › empty` |
| An unfinished last event line on the machine | not taken now, taken by a later take once complete (`take.4`) | `checkVoiceKeeper › take adds only` |
| A kept line that is not an event, a voice with no valid `voice.json`, an event for a clip with no file | skipped by `people`, never an error (`people.2`–`people.4`) | `checkVoiceKeeper › people` |

## Golden diff

None.

## Removes

None.

## Local facts

| Parameter                  | Default                                       | Decided by                                               |
| -------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| L1.1 arguments per put run | under 2 MiB in all; more files take more runs | the guest's argument limit, `minutes.js` RECORDING_PART |

**L1.2 — Parallel runs lose nothing.** `put` writes only the files and event lines the machine lacks and
never deletes or rewrites one; `take` adds to the kept library only the files and complete event lines it
lacks, skipping names that start with `.`, and drops from the kept library the audio of a clip whose
events end in `removed`. With `known-voices:F10`, a run that ends while another runs keeps both runs'
clips and events.

L1.2 binds `VoiceKeeper.put` and `VoiceKeeper.take`.

## Human required

None.

## Implementation notes

| Run   | Commit      | Command                                  | Result                         |
| ----- | ----------- | ---------------------------------------- | ------------------------------ |
| start | c4a4f9d+wip | `cd web && node --test units.test.mjs`   | 140 passed, 0 failed           |
| start | c4a4f9d+wip | `cd web && node check.mjs`               | ok, exit 0                     |
| end   | c4a4f9d+wip | `cd web && node --test units.test.mjs`   | 141 passed, 0 failed           |
| end   | c4a4f9d+wip | `cd web && node check.mjs`               | ok, exit 0; voice keeper 10/10 |
| end   | c4a4f9d+wip | `cd web && node --test units.test.mjs`   | 141 passed, 0 failed           |
| end   | c4a4f9d+wip | `cd web && node check.mjs`               | ok, exit 0; voice keeper 10/10 |
| fix-start | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs` | 154 passed, 0 failed |
| fix-start | c4a4f9d+wip | `cd web && node check.mjs`               | ok, exit 0                     |
| fix-end | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs` | 155 passed, 0 failed |
| fix-end | c4a4f9d+wip | `cd web && node check.mjs`               | ok, exit 0; voice keeper 10/10 |
| fix-end | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs` | 155 passed, 0 failed |
| fix-end | c4a4f9d+wip | `cd web && node check.mjs`               | ok, exit 0; voice keeper 10/10 |

Andon: none.
Surprises:
- `minutes-voices` is never deleted: `checkVoiceKeeper` empties its stores at its start and end, and the keeper opens the database per call and closes it after, so it holds no connection between calls.
- `Minutes.run` does take `hint` (shown only on runs that are not `followUp`); the `Run` typedef stays verbatim, the keeper passes none, and `audio stays` asserts no recorded run carries one.
- `people` lists a directory only when its name is `SlugOf` of its `voice.json` name (store.1); `take` keeps only slug-form directories; `added` events compare by parsed time to the nanosecond, not by string.
- `Minutes.receive` decodes every body as UTF-8, so `take` reads clips back as `base64` in one run per ≤ 9 MB, sized by one `wc -c` in its listing run.
- Each `put` and `take` runs `clai confdir` once, in its listing run, and passes the path on as `$1`.
- `take` keeps a `voice.json` only once it parses as JSON, so a half-written one (store.2's exclusive create) is not kept for good.
- `put` writes a clip as `.<id>.flac.<nonce>` per call and renames it when whole; a failed put leaves that dot-file, which nothing reads.
- `put` ends an unterminated last line on the machine with a newline before it appends, so a kept line never joins a half line.
- The scenario's clip bytes are printable ASCII, so "the slice as text" is a searchable string.
- R1-07: `slugOf` also keeps only decimal digits (Go `IsDigit`, `\p{Nd}`) and gives `-` for a name with no letter or digit, as `SlugOf` does; checked against Go for every code point below U+30000 (notebook 2026-11-18T17-33-15Z).
- R1-06: `audio stays` draws each put run's process rows through `window.minutes.hood` (`ran`, `render`) and restores the hood after; a cut keeps 40 characters, under the 64 of a slice's base64.

## Review findings

### Review 1, 2026-11-18

Findings (README Findings table): R1-06, R1-07 (minors).

Verified good:
- L1.1: probed with clips from 1 byte to 3 MB; the largest run was 1 467 768 bytes against a 2 097 152-byte limit.
- L1.2: two puts or two takes at once lose nothing.
- Half-written `voice.json` files and event lines are never kept.
- Shell metacharacters in event lines are appended verbatim and nothing is executed.
- A put that fails between parts leaves no part-written clip.


### Review 2, 2026-11-19

Root review, round 2. No new finding.

- R1-06 resolved: a put run's clip base64 is cut in the process tooltip, and `audio stays` checks the process rows.
- R1-07 resolved: `slugOf` lower-cases per code point and keeps `\p{L}\p{Nd}`; `people` lists `İbrahim` and `ΟΔΥΣΣΕΥΣ` under clai's slugs.
