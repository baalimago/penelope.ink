# Phase 2 — Segment keeper

**Parent:** root · **Class:** contract · [README](README.md)

## Goal

Keep, in this browser and by a meeting's summary path, the segments and naming report its transcription
returned and the clips its run learned, so that the meeting's review can show them later.

## Interface

Written to `web/www/segmentkeeper.js`. A code interface: a JSDoc-typed class and the types it passes. The
class, its two members, the types, `SEGMENTS_DB` and the clauses are the frozen surface; the layout
inside its database is body.

```js
/**
 * The IndexedDB database of the kept segments. No other module opens it, and
 * SegmentKeeper opens no other database.
 */
export const SEGMENTS_DB = "minutes-segments";

/**
 * The clip that named a segment or a speaker: the `voice` field of
 * known-voices' json output (known-voices:Output.2,
 * Provenance.MarshalJSON.1).
 *
 * @typedef {object} VoiceProvenance
 * @property {string} clip    "<slug>/<id>", the clip's reference
 * @property {"confirmed"|"unconfirmed"} status
 */

/**
 * One segment of `audio_transcribe`'s json output (known-voices:Output.2).
 * A library name is a `speaker` with a `voice`; without `voice` the speaker
 * is the label the transcript gave, or absent.
 *
 * @typedef {object} Segment
 * @property {number} start    seconds, the float the output gave
 * @property {number} end      seconds, the float the output gave
 * @property {string} [speaker]
 * @property {VoiceProvenance} [voice]
 * @property {string} text
 */

/**
 * The `naming` object of known-voices' json output
 * (known-voices:NamingReport.MarshalJSON.1, .2). Every status, origin,
 * reason and result is the text known-voices gives; none is listed here.
 *
 * @typedef {object} NamingReport
 * @property {string} status
 * @property {string} origin
 * @property {Array<{label: string, name?: string, voice?: VoiceProvenance, reason?: string}>} speakers
 * @property {Array<{name: string, result: string}>} voices
 * @property {string} [error]
 * @property {string} [unrecorded]
 */

/**
 * One clip a run learned: one `audio_remember_voice` result of that run,
 * "<name>: clip <id> added (unconfirmed)"
 * (known-voices:audio_remember_voice CallWithContext.12). The person it
 * belongs to is the Person of VoiceKeeper.people whose clips hold `clip`.
 *
 * @typedef {object} LearnedClip
 * @property {string} name   <name> of the result line, as given
 * @property {string} clip   <id> of the result line, 12 lower-case hex digits
 */

/**
 * What is kept for one meeting.
 *
 * @typedef {object} KeptSegments
 * @property {Segment[]} segments
 * @property {NamingReport|null} naming   null when the output had no naming
 *   (known-voices:Output.4, the bare array of segments)
 * @property {LearnedClip[]} learned      [] when the run learned none
 */

/**
 * The kept segments of the meetings this browser transcribed.
 *
 * - SegmentKeeper.1 — The kept segments live in the IndexedDB database
 *   SEGMENTS_DB and nowhere else. A second SegmentKeeper built over the same
 *   `indexedDB` gets everything the first one kept.
 * - SegmentKeeper.2 — What is kept is text and numbers: the database holds
 *   no Blob, no ArrayBuffer and no typed array, so no clip audio. No member
 *   writes localStorage, the notebook or the machine. (P2)
 * - SegmentKeeper.3 — No member puts up a note or a status and none
 *   rejects: the outcome of a call is its result. (P5)
 */
export class SegmentKeeper {
  /**
   * @param {IDBFactory|undefined} indexedDB
   */
  constructor(indexedDB) {}

  /**
   * Keeps a meeting's segments, naming report and learned clips under its
   * summary path.
   *
   * - keep.1 — After it resolves true for a path not kept before,
   *   `get(path)` resolves to `{segments, naming, learned}` equal to what
   *   was given: the segments in
   *   their order, every `start` and `end` the same number (61.2 stays
   *   61.2), `speaker` and `voice` present exactly where they were given
   *   and `voice` with its `clip` and `status`, the naming report whole.
   *   (known-voices:Output.1, Output.2, F6)
   * - keep.2 — A `naming` of null and a `learned` of [] are kept as given:
   *   the output of a run with no voices is kept like any other.
   *   (known-voices:Output.4)
   * - keep.3 — `learned` is kept in the order given. The keeper looks at no
   *   library and adds no clip of its own, so a meeting holds only the clips
   *   its caller says that meeting's own runs learned. (README Flow "Record
   *   with known people")
   * - keep.4 — A keep for a path that is kept already replaces its segments
   *   and its naming, and unions `learned` with what the path holds, by clip
   *   id: the entries the path held come first, as they were, followed by
   *   the given entries whose `clip` it did not hold, in the order given. An
   *   entry whose `clip` is held already is not added again and the held
   *   entry keeps its `name`. So a clip learned in a first run is still
   *   there after "Transcribe again". Every other path's stay as they were.
   * - keep.5 — With no `indexedDB`, a database that cannot be opened, or a
   *   write the browser refuses, it resolves false and what was kept before
   *   is unchanged.
   *
   * @param {string} path        the meeting's summary path
   * @param {Segment[]} segments
   * @param {NamingReport|null} naming
   * @param {LearnedClip[]} learned
   * @returns {Promise<boolean>} true when it is kept
   */
  async keep(path, segments, naming, learned) {}

  /**
   * What is kept for a meeting.
   *
   * - get.1 — For a path that was kept it resolves to the segments and
   *   naming of the latest keep under it, and the learned clips of every
   *   keep under it (keep.4). Changing the value it
   *   resolved to changes nothing that is kept.
   * - get.2 — For a path that was never kept in this browser (another
   *   browser's meeting) it resolves null. (README Flow "Open a meeting")
   * - get.3 — With no `indexedDB`, or a database that cannot be opened or
   *   read, it resolves null.
   * - get.4 — It writes nothing: the database is the same before and after.
   *
   * @param {string} path  the meeting's summary path
   * @returns {Promise<KeptSegments|null>}
   */
  async get(path) {}
}
```

Consumes:

- `Recordings` (import): its storage convention, an object built over `indexedDB` whose calls resolve
  null, or false for a write, when the browser keeps no storage (`web/www/recordings.js`)
- `known-voices:` root, json output (import): `{segments, naming}`, a segment's `voice: {clip, status}`,
  `Output.1`, `Output.2`, `Output.4`; `NamingReport.MarshalJSON.1`, `.2`; `Provenance.MarshalJSON.1`

The `LearnedClip` type names the line of `known-voices:audio_remember_voice` it is read from; reading a
run's records is the root's (phase 6), and this phase consumes no member for it.

Documents: this phase changes no behaviour a user sees, so the repository `README.md` button table is
not edited here.

## Acceptance criteria

| #   | Criterion                                                                                          | Proves                                  | Proof                                                          |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| 1   | A meeting's segments, with float times and `voice` provenance, its naming report and its learned clips come back as kept, after a new SegmentKeeper too | `keep.1`, `keep.3`, `get.1`, `SegmentKeeper.1` | `checkSegmentKeeper › round trip`                    |
| 2   | A run with no voices is kept: no naming, nothing learned                                           | `keep.2`                                | `checkSegmentKeeper › no voices`                               |
| 3   | A meeting transcribed again holds the new run's segments and naming, and the learned clips of both runs, each once, the earlier first | `keep.4`, `get.1`      | `checkSegmentKeeper › replace`                                 |
| 4   | A meeting this browser did not transcribe has nothing                                              | `get.2`, `get.4`                        | `checkSegmentKeeper › another browser's meeting`               |
| 5   | Nothing kept is audio, and nothing is written outside `minutes-segments`                           | P2, `SegmentKeeper.2`                   | `checkSegmentKeeper › no audio`                                |
| 6   | Without storage, keep is false and get is null, with no rejection and no note                      | P5, `SegmentKeeper.3`, `keep.5`, `get.3` | `a segment keeper with no storage keeps nothing`, `checkSegmentKeeper › refused write` |

## Test cases

`checkSegmentKeeper(page)` is one scenario of `web/check.mjs`, on the real page. It imports
`./segmentkeeper.js` in the page and builds a `SegmentKeeper` over the page's `indexedDB`. It starts
from, and leaves, no `minutes-segments` database. Each step below fails as
`FAIL: the segment keeper: <step>`.

The standing meeting: path `meetings/summaries/2026-11-16T10-00Z_daily sync.md`; the two segments and
the `naming` object of known-voices' "Output of a transcription" example, with a third segment
`{start: 61.2, end: 69, speaker: "Syrus", voice: {clip: "syrus/4be07c19a2f1", status: "unconfirmed"},
text: "…"}` and a fourth with no `speaker`; `learned` `[{name: "Christoph", clip: "4be07c19a2f1"},
{name: "Ada", clip: "e81d5530c6a9"}]`.

| Test | Level | Proves | Given | Then | Must not |
| ---- | ----- | ------ | ----- | ---- | -------- |
| `checkSegmentKeeper › round trip` | integration scenario | `keep.1`, `keep.3`, `get.1`, `SegmentKeeper.1`, AC 1 | `keep` of the standing meeting; `get(path)`; a second `SegmentKeeper` over the same `indexedDB` and `get(path)`; the first result's first segment changed in place, then `get(path)` again | `keep` true; each `get` deep-equals `{segments, naming, learned}` as given: four segments in order, `start` 61.2 and `end` 69 as numbers, `voice` on the first and third only, no `speaker` key on the fourth, `naming` whole, `learned` the two clips in order; the last `get` is unchanged by the edit | Round or stringify a time; add a `voice` or a `speaker`; add, drop or reorder a learned clip |
| `checkSegmentKeeper › no voices` | integration scenario | `keep.2`, AC 2 | `keep(other path, two segments with labels, null, [])`; `get(other path)` | true; `{segments, naming: null, learned: []}` with the two segments | Turn null into an object, or leave a key out |
| `checkSegmentKeeper › replace` | integration scenario | `keep.4`, `get.1`, AC 3 | The standing meeting and the no-voices meeting kept; `keep(standing path, one segment, a naming with status "no-agreement", [{name: "Bo", clip: "0123456789ab"}, {name: "Chris", clip: "4be07c19a2f1"}])`; both `get`s; then `keep(standing path, the same segment, null, [])` and `get` | The standing path gives the one segment and the new naming, with no segment and no naming of the first keep, and `learned` `[{Christoph, 4be07c19a2f1}, {Ada, e81d5530c6a9}, {Bo, 0123456789ab}]`; the other path is as it was; after the last keep `naming` is null and `learned` is the same three | Drop a clip an earlier run learned; keep one clip id twice; rename a held entry; merge old segments in; touch another path |
| `checkSegmentKeeper › another browser's meeting` | integration scenario | `get.2`, `get.4`, AC 4 | The standing meeting kept; the database's keys and values read; `get("meetings/summaries/never.md")`; the keys and values read again | null; the database is the same before and after | Create an entry for the path; resolve an empty object |
| `checkSegmentKeeper › no audio` | integration scenario | `SegmentKeeper.2`, P2, AC 5 | Snapshots of `localStorage`, of the keys of the databases `minutes` and `minutes-voices` (when they exist), of the notebook directory's file list and of the number of entries in `window.hoodModel.log`; the standing meeting kept and read; every value in `minutes-segments` walked | No value is a Blob, an ArrayBuffer or a typed array; the snapshots are unchanged, so nothing ran on the machine | Write a Recordings key, localStorage or a file |
| `checkSegmentKeeper › refused write` | integration scenario | `keep.5`, `SegmentKeeper.3`, AC 6 | The standing meeting kept; `keep(standing path, [{start: 0, end: 1, text: "x", extra: () => {}}], null, [{name: "Bo", clip: "0123456789ab"}])`, a value the browser cannot store; the notes on the page; `get(standing path)` | `keep` resolves false without rejecting; no note and no status text appears; `get` gives the standing meeting as first kept, with its two learned clips | Reject; keep half of the new value, its learned clip included |
| `a segment keeper with no storage keeps nothing` | unit | `keep.5`, `get.3`, `SegmentKeeper.3`, AC 6 | `new SegmentKeeper(undefined)`, and one over an `indexedDB` whose `open` fires `onerror`; `keep` of the standing meeting; `get(path)` | `keep` false, `get` null, for both; nothing rejects | Throw on a missing `indexedDB` |

## Error management

| Failure | Expected outcome | Test |
| ------- | ---------------- | ---- |
| The browser keeps no storage, or `minutes-segments` cannot be opened | `keep` resolves false, `get` resolves null; no rejection, no note (`keep.5`, `get.3`, `SegmentKeeper.3`) | `a segment keeper with no storage keeps nothing` |
| A write the browser refuses (a value it cannot store, a full disk) | `keep` resolves false; what was kept under the path and under every other path is unchanged; no note (`keep.5`) | `checkSegmentKeeper › refused write` |
| A path never kept in this browser | not a failure: `get` resolves null (`get.2`) | `checkSegmentKeeper › another browser's meeting` |

## Golden diff

None.

## Removes

None.

## Local facts

None.

## Human required

None.

## Implementation notes

| Run   | Commit      | Command                                                       | Result                                   |
| ----- | ----------- | ------------------------------------------------------------- | ---------------------------------------- |
| start | c4a4f9d+wip | `cd web && node --test units.test.mjs && node check.mjs`      | 141 passed, 0 failed; check.mjs ok       |
| end   | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | 142 passed, 0 failed (seed 12208); check.mjs ok (segment keeper 6/6) |
| end   | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | 142 passed, 0 failed (seed 22852); check.mjs ok (segment keeper 6/6) |

Andon: none.
Surprises:
- Validation correction: `checkSegmentKeeper` empties `minutes-segments`' store at start and end instead of starting from and leaving no database, since phase 6's keeper on the page would block `deleteDatabase`; SegmentKeeper opens the database per call, as VoiceKeeper does.
- `hoodModel.log` stands at its 2000-entry cap by then, so "no audio" checks the last entry's identity as well as the count.
- `get` aborts the upgrade when `minutes-segments` does not exist yet, so a get never creates the database (get.4).

## Review findings

None.
