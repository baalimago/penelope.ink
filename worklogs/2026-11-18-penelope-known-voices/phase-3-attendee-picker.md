# Phase 3 — Attendee picker

**Parent:** root · **Class:** contract · [README](README.md)

## Goal

Under New recording, show the people the kept library knows as a row of boxes to tick, pre-ticked from
the last filed meeting with the same title, and hand the ticked names to the root.

## Interface

Written to `web/www/people.js`. A UI interface: the elements below, and the module's exported functions
with JSDoc types. The app has one page, `/`, and this phase adds no route. `People` builds what it shows
inside the element it is given; the root (phase 6) puts that element, `#people`, into `#record-form` in
`index.html` and gives it its styles. The look is the implementer's.

| Element or state | Shown when |
| ---------------- | ---------- |
| `#people` (the `root` element) | `show()` found at least one person; hidden (`hidden` set, no box inside) otherwise |
| `#people input[type=checkbox]`, one per person, its `value` the person's `name`, labelled with that name | always inside a shown `#people`, in the order `people()` gave |
| a box is checked | the user ticked it; or `title(text)` pre-ticked it (L3.1) and the user has not changed that box since the last `reset()` |

```js
/** @typedef {import("./voicekeeper.js").Person} Person */

/**
 * A filed meeting, as Minutes.meetings lists it (newest first).
 * @typedef {{path: string, title: string}} Meeting
 */

/**
 * The newest meeting filed under `title`.
 *
 * - sameTitle.1 — The first meeting of `meetings` whose title equals
 *   `title` once both are trimmed and compared without case; null when
 *   there is none or `title` is blank. (L3.1)
 *
 * @param {Meeting[]} meetings  newest first
 * @param {string} title
 * @returns {Meeting|null}
 */
export function sameTitle(meetings, title) {}

/**
 * The people of the library who speak in a transcript.
 *
 * - spokeIn.1 — The `name` of each person who is the speaker of at least
 *   one utterance of `transcript` (`transcriptRows`), compared without
 *   case, in the order of `people`. A speaker that is a label (`isLabel`)
 *   or that the library does not hold gives nothing. (L3.1)
 *
 * @param {string} transcript  a filed transcript's text
 * @param {Person[]} people
 * @returns {string[]}
 */
export function spokeIn(transcript, people) {}

/**
 * New recording's people row.
 *
 * - People.1 — It runs nothing on the machine but `read`, writes no file
 *   and no storage, puts up no note and no status, and never rejects: a
 *   `people()` or `read` that fails or resolves nothing is an empty answer.
 *   (P5)
 */
export class People {
  /**
   * @param {object} seams
   * @param {HTMLElement} seams.root            the `#people` element
   * @param {() => Promise<Person[]>} seams.people     VoiceKeeper.people
   * @param {() => Meeting[]} seams.meetings           Minutes.meetings
   * @param {(path: string) => Promise<{transcript: string}|null>} seams.read
   *   Minutes.readMeeting, as a follow-up
   */
  constructor({ root, people, meetings, read }) {}

  /**
   * Draws the row from the kept library.
   *
   * - show.1 — After it resolves, the row holds one box per person of
   *   `people()`, in its order. A box whose name was there before keeps
   *   its state; a new one is unticked.
   * - show.2 — With no person, `#people` is hidden and holds no box, and
   *   `ticked()` is []. (P3)
   *
   * @returns {Promise<void>}
   */
  async show() {}

  /**
   * Pre-ticks the row for a meeting name.
   *
   * - title.1 — After it resolves, the boxes the user has not changed are
   *   ticked exactly for `spokeIn(transcript, people)` of the meeting
   *   `sameTitle(meetings(), text)`, its transcript read with `read`; with
   *   no such meeting, or one that cannot be read, they are unticked.
   *   (L3.1)
   * - title.2 — A box the user changed keeps the user's state, whatever
   *   the title becomes.
   * - title.3 — It reads at most one meeting per call, and none when the
   *   row holds no box or no meeting has the title. (P3)
   * - title.4 — Of two calls in flight, only the later one's answer is
   *   applied.
   *
   * @param {string} text  the meeting name as typed
   * @returns {Promise<void>}
   */
  async title(text) {}

  /**
   * - ticked.1 — The names of the checked boxes, in row order: what the
   *   row shows at that moment, and [] for a hidden row. (P3, P7)
   *
   * @returns {string[]}
   */
  ticked() {}

  /**
   * - reset.1 — Unticks every box and forgets which ones the user
   *   changed; the boxes stay.
   */
  reset() {}
}
```

Consumes:

- `VoiceKeeper.people` (phase 1): `people()` resolving to `Person[]`, `{name, slug, clips}`, in name
  order; through the `people` seam
- `Minutes.meetings` (import): the filed meetings, newest first, each `{path, title}`; through the
  `meetings` seam
- `Minutes.readMeeting` (import): `readMeeting(path, label, followUp)` resolving to
  `{summary, transcript}` or null; through the `read` seam
- `transcriptRows`, `isLabel` (import, `web/www/proofread.js`)

Documents: the row is not on the page until phase 6 wires it, so `README.md` and
`web/www/penelope-app.md` are edited there.

## Acceptance criteria

| #   | Criterion | Proves | Proof |
| --- | --------- | ------ | ----- |
| 1   | The row lists the library's people, and is hidden with nothing ticked when the library is empty | `show.1`, `show.2`, `ticked.1`, P3 | `checkPeople › lists the library`, `checkPeople › empty library` |
| 2   | Typing the name of a meeting filed before ticks the people of its newest filing whom the library holds | L3.1, `title.1`, `sameTitle.1`, `spokeIn.1` | `checkPeople › pre-tick`, `the last meeting with the same title`, `the library's people who spoke in a transcript` |
| 3   | The user's own ticks win over the pre-tick, and `ticked()` is what the row shows | `title.2`, `ticked.1`, `reset.1` | `checkPeople › the user's ticks stay` |
| 4   | The row reads one meeting at most, puts up nothing and never rejects | `title.3`, `title.4`, `People.1`, P5 | `checkPeople › quiet` |

## Test cases

`checkPeople(page)` is one scenario of `web/check.mjs`. It imports `./people.js` in the page and builds a
`People` over a `fieldset` of its own, appended to the page and removed at the end, with seams it makes
up: `people` resolving a list it sets, `meetings` returning a list it sets, and `read` counting its calls
and resolving the transcript the scenario gives for a path. Each step fails as
`FAIL: the people row: <step>`. The unit tests are in `web/units.test.mjs`.

The standing seams: people Ada, Christoph, Lorentz (one clip each); meetings, newest first,
`Daily sync` (path `a.md`, transcript with `[0:00] Lorentz: …`, `[0:04] Speaker B: …`,
`[0:09] christoph: …`, `[0:12] Grace: …`), `Design review` (`b.md`), `daily sync ` (`c.md`, transcript
with `[0:00] Ada: …`).

| Test | Level | Proves | Given | Then | Must not |
| ---- | ----- | ------ | ----- | ---- | -------- |
| `checkPeople › lists the library` | integration scenario | `show.1`, `ticked.1`, AC 1 | The standing seams; `show()`; then Ada ticked by a click, `people` set to Ada, Bo, Lorentz, `show()` | Three boxes with values Ada, Christoph, Lorentz, in that order, none checked, the row not hidden; afterwards boxes Ada, Bo, Lorentz with Ada still checked and `ticked()` `["Ada"]` | Tick a box on its own; drop the user's tick on a redraw |
| `checkPeople › empty library` | integration scenario | `show.2`, `title.3`, P3, AC 1 | `people` resolving `[]`; `show()`; `title("Daily sync")`; `ticked()` | The row is hidden and holds no `input`; `ticked()` is `[]`; `read` was not called | Show an empty row; read a meeting for an empty library |
| `checkPeople › pre-tick` | integration scenario | `title.1`, `title.3`, L3.1, AC 2 | The standing seams; `show()`; `title(" daily SYNC")`; then `title("Design review")` with `read` resolving null for `b.md`; then `title("Retro")` | After the first: Christoph and Lorentz checked, Ada not, `ticked()` `["Christoph", "Lorentz"]`, `read` called once, with `a.md`; after the second and the third: nothing checked; `read` was called twice in all | Read `c.md`, the older filing; tick Grace or a label; keep the first title's ticks |
| `checkPeople › the user's ticks stay` | integration scenario | `title.2`, `ticked.1`, `reset.1`, AC 3 | After the pre-tick: the user unticks Lorentz and ticks Ada; `title("Retro")`; `title("Daily sync")`; `ticked()`; then `reset()`; `title("Daily sync")` | `ticked()` is `["Ada", "Christoph"]` after both titles (Christoph by the pre-tick, Ada and Lorentz as the user left them); after `reset()` nothing is checked, and the last title ticks Christoph and Lorentz | Re-tick a box the user unticked; untick one the user ticked |
| `checkPeople › quiet` | integration scenario | `title.4`, `People.1`, P5, AC 4 | `read` for `a.md` held back; `title("Daily sync")` and, before it resolves, `title("Retro")`; then `a.md` let go; then `people` rejecting and `show()`; `read` rejecting and `title("Daily sync")`; the page's notes, `#status`, `localStorage` | Nothing is checked once both titles resolved; neither call rejects; the row is hidden after the failing `show()`; no `.note`, no status text, `localStorage` as it was | Apply the stale answer; reject; put up a note |
| `the last meeting with the same title` | unit | `sameTitle.1`, AC 2 | The standing meetings; titles `"Daily sync"`, `" DAILY SYNC "`, `"Daily"`, `""`, `"  "` | `a.md` for the first two, null for the rest | Match a part of a title; return the older filing |
| `the library's people who spoke in a transcript` | unit | `spokeIn.1`, AC 2 | The `a.md` transcript under a front matter, and the standing people; then a transcript with labels only; then `people` `[]` | `["Christoph", "Lorentz"]` (the library's spelling, in the library's order); `[]`; `[]` | Return a label, a speaker the library lacks, or the transcript's spelling |

## Error management

| Failure | Expected outcome | Test |
| ------- | ---------------- | ---- |
| `people()` rejects or resolves nothing | the row is hidden with no box; `show()` resolves (`People.1`, `show.2`) | `checkPeople › quiet` |
| The meeting with the title cannot be read (`read` resolves null or rejects) | no box is pre-ticked; `title()` resolves; no note (`title.1`, `People.1`) | `checkPeople › pre-tick`, `checkPeople › quiet` |
| No meeting has the title | not a failure: no box is pre-ticked and nothing is read (`title.3`) | `checkPeople › pre-tick` |

## Golden diff

None.

## Removes

None.

## Local facts

| Parameter                 | Default                                                                                                                  | Decided by             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| L3.1 pre-ticked attendees | the speakers of the last filed meeting with the same title whose names the kept library holds, read from its transcript | maintainer, 2026-11-18 |

L3.1 binds `People.title`, `sameTitle` and `spokeIn`.

## Human required

None.

## Implementation notes

| Run   | Commit      | Command                      | Result                |
| ----- | ----------- | ---------------------------- | --------------------- |
| start | c4a4f9d+wip | `cd web && node --test units.test.mjs && node check.mjs` | 142 passed, 0 failed; check ok |
| end   | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` | seed 3081571850: 144 passed, 0 failed; check ok (people row 5/5) |
| end   | c4a4f9d+wip | `cd web && node --test --test-randomize units.test.mjs && node check.mjs` seed 4031287627: 144 passed, 0 failed; check ok (people row 5/5) |

Andon: none.
Surprises:
- `People` adds and removes only its own `label.person` boxes, so a `<legend>` phase 6 puts in `#people` stays; the constructor sets `hidden` until a `show()` finds someone.
- A box `show()` adds while a title stands is unticked (show.1); phase 6 calls `title()` again after `show()` to pre-tick it.
- `show()` gives one box per name: two kept voices with one `name` make one box.

## Review findings

None.
