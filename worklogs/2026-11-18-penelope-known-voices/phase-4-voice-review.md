# Phase 4 — Voice review

**Parent:** root · **Class:** contract · [README](README.md)

## Goal

"Who is speaking?" shows the names the library gave with where they came from, asks whether a learned
voice is kept, and hands the root what the user chose: keep a clip, overrule a clip with a new name,
remember a speaker.

## Interface

Written to `web/www/review.js`. A UI interface: the elements below, and the module's exported functions
with JSDoc types. The app has one page, `/`, and this phase adds no route. `Review` builds what it shows
inside the form it is given, `#speakers`, which `index.html` holds today with its heading, its
`#speaker-rows` and its button; `index.html` is not edited here. `Review` runs nothing: every choice
goes to the root through `choose`. The look and the wording not quoted below are the implementer's.

| Element or state | Shown when |
| ---------------- | ---------- |
| `#speakers` (the `root` form) | not `busy`, and `reviewRows` gives at least one row or `#speakers-said` has text; hidden otherwise |
| `#speakers.playable` (the class) | `playable`: the recording is kept in this browser, so the ▸ buttons play |
| `.speaker[data-label]`, a label row: a ▸ `.speaker-play` with the line's time, the label, a line they said, and `input[data-label]` "Their name" | one per row of kind `label`, as today |
| `.speaker[data-name]`, a library row: a ▸ `.speaker-play`, the name, `.speaker-source` saying a confirmed or an unconfirmed clip named them, and the button `.speaker-not` "Not `<name>`?" | one per row of kind `library` |
| `.speaker[data-clip]`, a learned row: a ▸ `.speaker-play`, the name, that the agent learned this voice, the button `.speaker-keep` "Keep", and `.speaker-not` "Not `<name>`?" | one per row of kind `learned` |
| `input[data-not]` "Their name", in a library or learned row | the user pressed that row's `.speaker-not` |
| `.speaker-play` | its row has a `start`; hidden otherwise |
| `#remember`, a checkbox labelled "Remember these voices" | `playable`, and at least one label row has a `span` |
| the form's button "Name the speakers" | a label row or an `input[data-not]` is shown |
| `#speakers-said` (`role="status"`) | it has text: what `said(text)` gave, else `namingLine(kept.naming)` |

```js
/** @typedef {import("./voicekeeper.js").Person} Person */
/** @typedef {import("./segmentkeeper.js").Segment} Segment */
/** @typedef {import("./segmentkeeper.js").NamingReport} NamingReport */
/** @typedef {import("./segmentkeeper.js").KeptSegments} KeptSegments */

/** L4.1: the longest pause a remembered span runs across, in seconds. */
export const REMEMBER_PAUSE_S = 1;
/** known-voices' clip length, in seconds. */
export const CLIP_MIN_S = 3;
export const CLIP_MAX_S = 10;

/**
 * A speaker the transcript only labels, with a line they said and its
 * stretch of the recording: a row of today's "Who is speaking?".
 * @typedef {{label: string, sample: string, start: number|null, end: number|null}} Unknown
 */

/** @typedef {{start: number, end: number}} Span  seconds into the recording */

/**
 * Keep a learned clip. `clip` is "<slug>/<id>".
 * @typedef {{kind: "keep", clip: string}} Keep
 */

/**
 * The clip `clip` named someone `from` who is `to`.
 * @typedef {{kind: "overrule", clip: string, from: string, to: string}} Overrule
 */

/**
 * Remember the speaker labelled `label` as `name`, from `start` to `end`.
 * @typedef {{kind: "remember", label: string, name: string, start: number, end: number}} Remember
 */

/** @typedef {Keep|Overrule|Remember} Choice */

/**
 * @typedef {{kind: "label", label: string, sample: string, start: number|null, end: number|null, span: Span|null}} LabelRow
 * @typedef {{kind: "library", name: string, clips: string[], status: "confirmed"|"unconfirmed", start: number, end: number}} LibraryRow
 * @typedef {{kind: "learned", name: string, clip: string, start: number|null, end: number|null}} LearnedRow
 */

/**
 * What the review is shown.
 *
 * @typedef {object} ReviewState
 * @property {string} path           the meeting's summary path
 * @property {string} transcript     its transcript as it reads now
 * @property {Unknown[]} unknown     its labelled speakers
 * @property {KeptSegments|null} kept   SegmentKeeper.get(path)
 * @property {Person[]} people       VoiceKeeper.people()
 * @property {boolean} playable
 * @property {boolean} busy          a run of this meeting is under way
 */

/**
 * The span "Remember these voices" gives for a speaker (L4.1).
 *
 * - rememberSpan.1 — A segment is the speaker's when its transcript line
 *   (`transcriptLines`) names `speaker`: "Speaker B" for a segment whose
 *   speaker is "B", a name for itself.
 * - rememberSpan.2 — A run is the speaker's segments that follow each
 *   other in `segments`, each starting REMEMBER_PAUSE_S or less after the
 *   one before it ended. A segment of anyone else between two ends the run.
 * - rememberSpan.3 — The span is the longest run, from its first start to
 *   its last end, the earliest of equals; a run longer than CLIP_MAX_S is
 *   its first CLIP_MAX_S. Its times are the segments' floats, not rounded.
 * - rememberSpan.4 — null when the longest run is shorter than CLIP_MIN_S,
 *   or the speaker has no segment.
 *
 * @param {Segment[]} segments
 * @param {string} speaker  as the transcript writes it
 * @returns {Span|null}
 */
export function rememberSpan(segments, speaker) {}

/**
 * The rows of the review, top to bottom: learned, library, label.
 *
 * - reviewRows.1 — One label row per `unknown`, in order, with `span`
 *   `rememberSpan(kept.segments, label)`, or null without `kept`.
 * - reviewRows.2 — One library row per speaker name that a segment of
 *   `kept` carries with a `voice`, in order of first appearance, and only
 *   while that name is the speaker of an utterance of `transcript`
 *   (`transcriptRows`). `clips` are the distinct `voice.clip` of its
 *   segments; `status` is "unconfirmed" when any of them is; `start` and
 *   `end` are its first segment's, at most CLIP_MAX_S apart.
 *   (known-voices:Output.2, F6)
 * - reviewRows.3 — One learned row per entry of `kept.learned` whose `clip`
 *   is the id of an `unconfirmed` clip of a person of `people`: `name` is
 *   that person's name, `clip` is "<slug>/<id>", and `start` and `end` are
 *   those of the first segment that person speaks, null when there is
 *   none. A learned clip that is confirmed, or that `people` does not hold,
 *   gives no row.
 * - reviewRows.4 — With `kept` null the rows are the label rows alone.
 *
 * @param {ReviewState} state
 * @returns {Array<LearnedRow|LibraryRow|LabelRow>}
 */
export function reviewRows(state) {}

/**
 * What a naming report has to say in the meeting view.
 *
 * - namingLine.1 — "" for null, and for a report with no `error` and no
 *   voice whose result is `unknown-voice`.
 * - namingLine.2 — Otherwise one line that names every `unknown-voice`
 *   person and holds the report's `error` text when it has one.
 *   (P5, known-voices:NamingReport.MarshalJSON.2)
 *
 * @param {NamingReport|null} naming
 * @returns {string}
 */
export function namingLine(naming) {}

/**
 * "Who is speaking?".
 *
 * - Review.1 — It runs nothing on the machine, writes no file and no
 *   storage, changes no transcript and puts up no note: what the user
 *   chose leaves it only through `choose`. (P4, P5)
 */
export class Review {
  /**
   * @param {object} seams
   * @param {HTMLFormElement} seams.root   the `#speakers` form
   * @param {(start: number, end: number, button: HTMLElement) => void} seams.play
   *   Proofreader.playSpan
   * @param {(choices: Choice[], names: Array<[string, string]>) => void} seams.choose
   *   the root's; `names` are [label, name] pairs, today's Name the speakers
   */
  constructor({ root, play, choose }) {}

  /**
   * Draws the review for a meeting.
   *
   * - show.1 — The form shows the rows of `reviewRows(state)` and the
   *   elements of the table above.
   * - show.2 — A show whose path and rows are those already drawn keeps
   *   what the user typed, opened and ticked. A show for another path
   *   clears them and the text `said` gave.
   * - show.3 — A click on a `.speaker-play` calls `play(start, end,
   *   button)` with its row's times, and nothing else.
   * - show.4 — A click on `.speaker-keep` calls `choose([{kind: "keep",
   *   clip}], [])` with its row's clip, at once. (Flow "Keep a learned
   *   clip")
   * - show.5 — Submitting the form calls `choose(choices, names)` once:
   *   for each `input[data-not]` that holds a name other than its row's
   *   (compared without case), one Overrule per clip of that row, `from` the row's name and `to`
   *   the name typed; then, with `#remember` ticked, one Remember per
   *   label row that has a name and a span; `names` are the label rows'
   *   [label, name] pairs that have a name. Names are trimmed. With no
   *   choice and no name it calls nothing. (Flows "Correct a library name
   *   in the review", "Remember a speaker the user named")
   *
   * @param {ReviewState} state
   */
  show(state) {}

  /**
   * - said.1 — `#speakers-said` shows `text` until the next `said`, or a
   *   show for another path; `said("")` gives the line back to the naming
   *   report. (P5)
   *
   * @param {string} text  what a refused clip or a failed command said
   */
  said(text) {}
}
```

Consumes:

- `SegmentKeeper.get` (phase 2): its `KeptSegments`, `{segments, naming, learned}`, with `Segment`
  `{start, end, speaker?, voice?: {clip, status}, text}`, `NamingReport` and `LearnedClip` `{name, clip}`,
  `clip` the 12-digit id; handed in by the root as `state.kept`
- `VoiceKeeper.people` (phase 1): `Person` `{name, slug, clips}` and `Clip` `{id, status}`; handed in by
  the root as `state.people`
- `known-voices:` root (import): a named segment's `speaker` and `voice: {clip, status}` (`Output.2`);
  the naming report's `voices[].result` `unknown-voice` and its `error`
  (`NamingReport.MarshalJSON.1`, `.2`); the clip length, 3–10 s
- `Proofreader.playSpan` (import): `playSpan(start, end, element)`, through the `play` seam
- `transcriptRows`, `transcriptLines` (import, `web/www/proofread.js`): the utterances of a transcript;
  the line a segment is filed as, which gives the label a segment's speaker is written with

Documents: the review is not on the page until phase 6 wires it, so `README.md` and
`web/www/penelope-app.md` are edited there.

## Acceptance criteria

| #   | Criterion | Proves | Proof |
| --- | --------- | ------ | ----- |
| 1   | A meeting with no kept segments shows today's rows and hands back today's names | `reviewRows.1`, `reviewRows.4`, `show.1`, `show.5` | `checkReview › labels only`, `the review's rows` |
| 2   | A name the library gave shows with its clip's status, and "Not `<name>`?" hands back an overrule of the clip that named it | P4, `reviewRows.2`, `show.5` | `checkReview › overrule`, `the review's rows` |
| 3   | A clip this meeting's run learned asks to be kept while it is unconfirmed, and Keep hands back that clip | P4, `reviewRows.3`, `show.4` | `checkReview › keep`, `the review's rows` |
| 4   | With "Remember these voices" ticked, a named label hands back its span of L4.1 | L4.1, `rememberSpan.1`–`.4`, `show.5` | `checkReview › remember`, `the span to remember a speaker by` |
| 5   | The review runs and writes nothing; a naming report and a failed command show in the form, never as a note | P5, `Review.1`, `namingLine.1`, `namingLine.2`, `said.1` | `checkReview › quiet`, `a naming report's line` |
| 6   | ▸ plays the row's stretch, and a redraw keeps what the user typed | `show.2`, `show.3` | `checkReview › play and redraw` |

## Test cases

`checkReview(page)` is one scenario of `web/check.mjs`. It imports `./review.js` in the page and builds a
`Review` over a copy of the page's `#speakers` form, appended to the page and removed at the end, with a
`play` and a `choose` that record their calls. Each step fails as `FAIL: the voice review: <step>`. The
unit tests are in `web/units.test.mjs`.

The standing state: path `meetings/summaries/2026-11-16T10-00Z_daily-sync.md`; segments

| # | start | end | speaker | voice |
| - | ----- | --- | ------- | ----- |
| 0 | 0 | 8.2 | Lorentz | `lorentz/e81d5530c6a9`, confirmed |
| 1 | 9 | 15.5 | B | |
| 2 | 15.9 | 18.4 | B | |
| 3 | 19.5 | 21 | Lorentz | `lorentz/e81d5530c6a9`, confirmed |
| 4 | 21.2 | 22 | B | |
| 5 | 61.2 | 69 | Syrus | `syrus/3d81f60a2b97`, unconfirmed |
| 6 | 70 | 84 | C | |
| 7 | 90 | 91.5 | D | |

the transcript `transcriptLines` gives for them; `unknown` for Speaker B, C and D, each with its first
line; `naming` `{status: "named", origin: "flag", speakers: […], voices: [{name: "Lorentz", result:
"named"}, {name: "Ada", result: "unknown-voice"}]}`; `learned` `[{name: "Christoph", clip:
"4be07c19a2f1"}, {name: "Ada", clip: "0123456789ab"}]`; people Christoph (`christoph`, clip
`4be07c19a2f1` unconfirmed), Lorentz (`lorentz`, clips `9f3c2a1b0d4e` and `e81d5530c6a9` confirmed),
Syrus (`syrus`, `3d81f60a2b97` unconfirmed); `playable` true, `busy` false.

| Test | Level | Proves | Given | Then | Must not |
| ---- | ----- | ------ | ----- | ---- | -------- |
| `the span to remember a speaker by` | unit | `rememberSpan.1`–`.4`, L4.1, AC 4 | The standing segments; `rememberSpan` for `Speaker B`, `Speaker C`, `Speaker D`, `Lorentz`, `Speaker E` | `{start: 9, end: 18.4}` (segments 1 and 2, the Lorentz line ending the run); `{start: 70, end: 80}`; null (1.5 s); `{start: 0, end: 8.2}`; null | Run across another speaker or a pause over 1 s; round a time; give a span under 3 s or over 10 s |
| `the review's rows` | unit | `reviewRows.1`–`.4`, AC 1, AC 2, AC 3 | The standing state; then the same with `Lorentz` renamed `Ada` throughout the transcript; then with Christoph's clip `confirmed`; then with `kept` null | Learned Christoph (`christoph/4be07c19a2f1`, no times); library Lorentz (`clips` `["lorentz/e81d5530c6a9"]`, confirmed, 0–8.2) and Syrus (unconfirmed, 61.2–69); labels B (span 9–18.4), C (70–80), D (null), in that order. No Lorentz row after the rename; no learned row once confirmed; labels alone, spans null, without `kept` | Give a row for learned Ada, whom `people` does not hold; list a clip twice |
| `a naming report's line` | unit | `namingLine.1`, `namingLine.2`, AC 5 | null; the standing naming; one with `voices` all `named`; one with `status` `request-failed` and `error` `"naming request failed: 503"` | `""`; a line that holds `Ada` and not `Lorentz`; `""`; a line that holds `naming request failed: 503` | Say anything for a report with nothing wrong |
| `checkReview › labels only` | integration scenario | `show.1`, `show.5`, `reviewRows.4`, AC 1 | `show` of the standing state with `kept` null and `people` `[]`; `Linus` typed for Speaker B; submit | Three label rows, no library or learned row, no `#remember`, the button shown; `choose` called once with `[]` and `[["Speaker B", "Linus"]]` | Show `#remember` without kept segments; emit a choice |
| `checkReview › overrule` | integration scenario | `show.1`, `show.5`, P4, AC 2 | `show` of the standing state; the Lorentz row's text; `.speaker-not` pressed on it, ` Ada ` typed; then on the Syrus row, `syrus` typed; submit | The Lorentz row says a confirmed clip named them, the Syrus row an unconfirmed one; `choose` called once with `[{kind: "overrule", clip: "lorentz/e81d5530c6a9", from: "Lorentz", to: "Ada"}]` and `[]` | Emit an overrule for a name typed as it was; show an `input[data-not]` before the button is pressed |
| `checkReview › keep` | integration scenario | `show.4`, `reviewRows.3`, AC 3 | `show` of the standing state; `.speaker-keep` pressed on the Christoph row; then `show` of the same state with Christoph's clip `confirmed` | `choose` called once, at the click, with `[{kind: "keep", clip: "christoph/4be07c19a2f1"}]` and `[]`; after the second show there is no learned row | Wait for a submit; show Keep on a library row |
| `checkReview › remember` | integration scenario | `show.5`, L4.1, AC 4 | `show` of the standing state; `Christoph` typed for Speaker B and `Dana` for Speaker D; submit; then `#remember` ticked and submit again; then `show` with `playable` false | First `choose`: `[]` and the two name pairs. Second: `[{kind: "remember", label: "Speaker B", name: "Christoph", start: 9, end: 18.4}]` and the same pairs; without `playable` there is no `#remember` | Remember Speaker D, who has no span; remember without the tick |
| `checkReview › play and redraw` | integration scenario | `show.2`, `show.3`, AC 6 | `show` of the standing state; ▸ pressed on the Syrus row and on the Speaker C row; `Grace` typed for Speaker C; `show` of the same state; then `show` with another path and its own rows | `play` called with `(61.2, 69, the button)` and with Speaker C's `unknown` times; `Grace` is still in its input after the same-state show, and gone after the other path's; `#speakers` has the class `playable`; the Christoph row has no shown ▸ | Call `choose` for a ▸; redraw rows that did not change |
| `checkReview › quiet` | integration scenario | `Review.1`, `said.1`, `namingLine.2`, P5, AC 5 | Snapshots of `localStorage`, of the number of entries in `window.hoodModel.log` and of the page's notes; every step above; then `show` with `busy` true; `show` with no rows and `said("Lorentz has no clip ffff")`; `said("")` on the standing state | The snapshots are unchanged; the form is hidden while busy; with no rows and a said text the form shows with that text in `#speakers-said`; after `said("")` the line is the naming report's and names Ada | Run a line; write storage; put up a `.note` |

## Error management

| Failure | Expected outcome | Test |
| ------- | ---------------- | ---- |
| A meeting filed in another browser (`kept` null) | not a failure: the label rows alone, as today (`reviewRows.4`) | `checkReview › labels only`, `the review's rows` |
| A learned clip the kept library does not hold, or holds confirmed | no row for it (`reviewRows.3`) | `the review's rows` |
| A speaker with no run of 3 s | no span: the name is handed back, no Remember (`rememberSpan.4`, `show.5`) | `checkReview › remember` |
| The root reports a refused clip or a failed command | its text in `#speakers-said`; no note (`said.1`) | `checkReview › quiet` |

## Golden diff

None.

## Removes

None.

## Local facts

| Parameter                                  | Default                                                                                                                                                | Decided by                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| L4.1 the span Remember these voices gives  | a speaker's segments merged across pauses of 1 s or less, the longest run, kept within `known-voices`' clip length, in the kept segments' float times | the design review, 2026-11-18 |

L4.1 binds `rememberSpan` and `Review.show`.

## Human required

None.

## Implementation notes

| Run   | Commit      | Command                                                                  | Result                    |
| ----- | ----------- | ------------------------------------------------------------------------ | ------------------------- |
| start | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | 144 passed, 0 failed; ok  |
| end   | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | 147 passed, 0 failed; ok (voice review 6/6) |
| end   | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | 147 passed, 0 failed; ok (voice review 6/6) |

Andon: none.
Surprises:
- `index.html` has no `#speakers-said` or `#remember`: `Review` adds them inside the form (before and after `#speaker-rows`) and reuses them when present.
- Phase 6 must drop Minutes' own `#speaker-rows` click and `#speakers` submit handlers and its rows render, or ▸ plays twice and a submit also runs `nameSpeakers`.
- `rememberSpan` compares with a 1e-9 s slack, so a 1 s pause or a 3 s run measured from floats (22.3 − 21.3) still counts as 1 s or 3 s.
- A learned row's times are its first segment's uncapped (`reviewRows.3`), unlike a library row's; a long first segment plays long.

## Review findings

None.
