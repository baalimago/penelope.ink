// New recording's people row: the kept library's people as boxes to tick, pre-ticked from the last meeting of the same name.
import { isLabel, transcriptRows } from "./proofread.js";

/** @typedef {import("./voicekeeper.js").Person} Person */

/**
 * A filed meeting, as Minutes.meetings lists it (newest first).
 * @typedef {{path: string, title: string}} Meeting
 */

const fold = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

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
export function sameTitle(meetings, title) {
  const want = fold(title);
  if (!want) return null;
  return meetings.find((m) => fold(m?.title) === want) ?? null;
}

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
export function spokeIn(transcript, people) {
  const said = new Set();
  for (const { u } of transcriptRows(transcript)) if (u && !isLabel(u.name.trim())) said.add(fold(u.name));
  return people.filter((p) => said.has(fold(p.name))).map((p) => p.name);
}

/**
 * New recording's people row.
 *
 * - People.1 — It runs nothing on the machine but `read`, writes no file
 *   and no storage, puts up no note and no status, and never rejects: a
 *   `people()` or `read` that fails or resolves nothing is an empty answer.
 *   (P5)
 */
export class People {
  #root;
  #people;
  #meetings;
  #read;
  /** @type {Person[]} */
  #shown = [];
  // The names whose box the user changed since the last reset.
  #changed = new Set();
  #drawn = 0;
  #asked = 0;

  /**
   * @param {object} seams
   * @param {HTMLElement} seams.root            the `#people` element
   * @param {() => Promise<Person[]>} seams.people     VoiceKeeper.people
   * @param {() => Meeting[]} seams.meetings           Minutes.meetings
   * @param {(path: string) => Promise<{transcript: string}|null>} seams.read
   *   Minutes.readMeeting, as a follow-up
   */
  constructor({ root, people, meetings, read }) {
    this.#root = root;
    this.#people = people;
    this.#meetings = meetings;
    this.#read = read;
    root.hidden = true;
    root.addEventListener("change", (e) => {
      if (this.#boxes().includes(e.target)) this.#changed.add(e.target.value);
    });
  }

  #boxes() {
    return [...this.#root.querySelectorAll("label.person > input[type=checkbox]")];
  }

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
  async show() {
    const drawn = ++this.#drawn;
    let got = [];
    try {
      got = await this.#people();
    } catch {
      got = [];
    }
    if (drawn !== this.#drawn) return;
    const people = [];
    for (const p of Array.isArray(got) ? got : []) {
      if (typeof p?.name === "string" && p.name && !people.some((q) => q.name === p.name)) people.push(p);
    }
    const was = new Map(this.#boxes().map((b) => [b.value, b.checked]));
    for (const box of this.#boxes()) box.parentElement.remove();
    const doc = this.#root.ownerDocument;
    for (const { name } of people) {
      const label = doc.createElement("label");
      label.className = "person";
      const box = doc.createElement("input");
      box.type = "checkbox";
      box.value = name;
      box.checked = was.get(name) ?? false;
      label.append(box, ` ${name}`);
      this.#root.append(label);
    }
    for (const name of this.#changed) if (!people.some((p) => p.name === name)) this.#changed.delete(name);
    this.#shown = people;
    this.#root.hidden = people.length === 0;
  }

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
  async title(text) {
    const asked = ++this.#asked;
    let names = [];
    if (this.#boxes().length > 0) {
      let meeting = null;
      try {
        meeting = sameTitle(this.#meetings() ?? [], text);
      } catch {
        meeting = null;
      }
      if (meeting) {
        try {
          const files = await this.#read(meeting.path);
          if (typeof files?.transcript === "string") names = spokeIn(files.transcript, this.#shown);
        } catch {
          names = [];
        }
      }
    }
    if (asked !== this.#asked) return;
    const tick = new Set(names);
    for (const box of this.#boxes()) if (!this.#changed.has(box.value)) box.checked = tick.has(box.value);
  }

  /**
   * - ticked.1 — The names of the checked boxes, in row order: what the
   *   row shows at that moment, and [] for a hidden row. (P3, P7)
   *
   * @returns {string[]}
   */
  ticked() {
    return this.#root.hidden ? [] : this.#boxes().filter((b) => b.checked).map((b) => b.value);
  }

  /**
   * Pre-ticks the row for the people a meeting named.
   *
   * - tick.1 — The boxes the user has not changed are ticked exactly for
   *   `names`; a box the user changed keeps the user's state. It reads
   *   nothing. (P7)
   *
   * @param {string[]} names
   */
  tick(names) {
    const want = new Set(Array.isArray(names) ? names : []);
    for (const box of this.#boxes()) if (!this.#changed.has(box.value)) box.checked = want.has(box.value);
  }

  /**
   * - reset.1 — Unticks every box and forgets which ones the user
   *   changed; the boxes stay.
   */
  reset() {
    for (const box of this.#boxes()) box.checked = false;
    this.#changed.clear();
  }
}
