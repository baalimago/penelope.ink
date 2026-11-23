// "Who is speaking?": the names the library gave, the voices the agent learned and the labels to name, handed to the root as choices.
import { clock, transcriptLines, transcriptRows } from "./proofread.js";

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
 * @property {string} [naming]       what the root is doing with what the user chose, "" when nothing
 */

// Float slack, so that 1 s and 3 s measured from floats count as 1 s and 3 s.
const SLACK = 1e-9;

const finite = (n) => typeof n === "number" && Number.isFinite(n);
const fold = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

// How a segment's transcript line (transcriptLines) writes its speaker; "" for none.
function lineSpeaker(segment) {
  const line = transcriptLines(JSON.stringify([{ start: 0, speaker: segment?.speaker, voice: segment?.voice, text: "" }]));
  return /^\[0:00\] (.*): \n$/.exec(line)?.[1] ?? "";
}

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
export function rememberSpan(segments, speaker) {
  let best = null;
  let run = null;
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!speaker || lineSpeaker(s) !== speaker || !finite(s.start) || !finite(s.end)) {
      run = null;
      continue;
    }
    if (run && s.start - run.last <= REMEMBER_PAUSE_S + SLACK) run.end = Math.max(run.end, s.end);
    else run = { start: s.start, end: s.end };
    run.last = s.end;
    if (!best || run.end - run.start > best.end - best.start + SLACK) best = run;
  }
  if (!best || best.end - best.start < CLIP_MIN_S - SLACK) return null;
  return { start: best.start, end: best.end - best.start > CLIP_MAX_S + SLACK ? best.start + CLIP_MAX_S : best.end };
}

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
export function reviewRows(state) {
  const kept = state?.kept ?? null;
  const segments = Array.isArray(kept?.segments) ? kept.segments : [];
  /** @type {LabelRow[]} */
  const labels = (Array.isArray(state?.unknown) ? state.unknown : []).map(({ label, sample, start, end }) => ({
    kind: "label", label, sample, start: start ?? null, end: end ?? null, span: kept ? rememberSpan(segments, label) : null,
  }));
  if (!kept) return labels;

  const spoken = new Set(transcriptRows(String(state.transcript ?? "")).map((r) => r.u?.name).filter(Boolean));
  /** @type {Map<string, LibraryRow>} */
  const library = new Map();
  for (const s of segments) {
    const clip = s?.voice?.clip;
    if (typeof s?.speaker !== "string" || !s.speaker || typeof clip !== "string" || !clip) continue;
    let row = library.get(s.speaker);
    if (!row) {
      row = { kind: "library", name: s.speaker, clips: [], status: "confirmed", start: s.start, end: Math.min(s.end, s.start + CLIP_MAX_S) };
      library.set(s.speaker, row);
    }
    if (!row.clips.includes(clip)) row.clips.push(clip);
    if (s.voice.status !== "confirmed") row.status = "unconfirmed";
  }

  /** @type {Map<string, Person>} */
  const unconfirmed = new Map();
  for (const p of Array.isArray(state.people) ? state.people : []) {
    for (const c of Array.isArray(p?.clips) ? p.clips : []) if (c?.status === "unconfirmed" && !unconfirmed.has(c.id)) unconfirmed.set(c.id, p);
  }
  const speaks = (s, p) => fold(s?.speaker) === fold(p.name) || (typeof s?.voice?.clip === "string" && s.voice.clip.split("/")[0] === p.slug);
  /** @type {LearnedRow[]} */
  const learned = [];
  const seen = new Set();
  for (const l of Array.isArray(kept.learned) ? kept.learned : []) {
    const person = unconfirmed.get(l?.clip);
    if (!person || seen.has(l.clip)) continue;
    seen.add(l.clip);
    const first = segments.find((s) => speaks(s, person));
    learned.push({ kind: "learned", name: person.name, clip: `${person.slug}/${l.clip}`, start: first?.start ?? null, end: first?.end ?? null });
  }
  return [...learned, ...[...library.values()].filter((r) => spoken.has(r.name)), ...labels];
}

const listed = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

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
export function namingLine(naming) {
  if (!naming || typeof naming !== "object") return "";
  const unknown = [...new Set((Array.isArray(naming.voices) ? naming.voices : []).filter((v) => v?.result === "unknown-voice").map((v) => String(v.name)))];
  const error = typeof naming.error === "string" ? naming.error.trim() : "";
  const parts = [];
  if (unknown.length) parts.push(`The library has no voice for ${listed(unknown)} yet, so the transcript could not name them by voice.`);
  if (error) parts.push(`Naming by voice: ${error}`);
  return parts.join(" ");
}

let reviews = 0;

const keyOf = (row) => (row.kind === "label" ? `label\n${row.label}` : row.kind === "library" ? `name\n${row.name}` : `clip\n${row.clip}`);

/**
 * "Who is speaking?".
 *
 * - Review.1 — It runs nothing on the machine, writes no file and no
 *   storage, changes no transcript and puts up no note: what the user
 *   chose leaves it only through `choose`. (P4, P5)
 */
export class Review {
  #root;
  #play;
  #choose;
  #rowsEl;
  #saidEl;
  #remember;
  #rememberLabel;
  #submit;
  #submitLabel;
  #id;
  /** @type {ReviewState|null} */
  #state = null;
  /** @type {Array<LearnedRow|LibraryRow|LabelRow>} */
  #rows = [];
  /** @type {string|undefined} */
  #path = undefined;
  #key = null;
  #said = "";
  /** @type {WeakMap<Element, LearnedRow|LibraryRow|LabelRow>} */
  #rowOf = new WeakMap();

  /**
   * @param {object} seams
   * @param {HTMLFormElement} seams.root   the `#speakers` form
   * @param {(start: number, end: number, button: HTMLElement) => void} seams.play
   *   Proofreader.playSpan
   * @param {(choices: Choice[], names: Array<[string, string]>) => void} seams.choose
   *   the root's; `names` are [label, name] pairs, today's Name the speakers
   */
  constructor({ root, play, choose }) {
    this.#root = root;
    this.#play = play;
    this.#choose = choose;
    this.#id = `review-${++reviews}`;
    const doc = root.ownerDocument;
    this.#rowsEl = root.querySelector("#speaker-rows");
    if (!this.#rowsEl) {
      this.#rowsEl = doc.createElement("div");
      this.#rowsEl.id = "speaker-rows";
      this.#rowsEl.className = "stack";
      root.append(this.#rowsEl);
    }
    this.#saidEl = root.querySelector("#speakers-said");
    if (!this.#saidEl) {
      this.#saidEl = doc.createElement("p");
      this.#saidEl.id = "speakers-said";
      this.#saidEl.className = "quiet";
      this.#rowsEl.before(this.#saidEl);
    }
    this.#saidEl.setAttribute("role", "status");
    this.#remember = root.querySelector("#remember");
    if (!this.#remember) {
      const label = doc.createElement("label");
      label.className = "remember";
      this.#remember = doc.createElement("input");
      this.#remember.type = "checkbox";
      this.#remember.id = "remember";
      label.append(this.#remember, " Remember these voices");
      this.#rowsEl.after(label);
    }
    this.#rememberLabel = this.#remember.closest("label") ?? this.#remember;
    this.#submit = [...root.querySelectorAll("button")].find((b) => b.type === "submit" && !this.#rowsEl.contains(b));
    if (!this.#submit) {
      this.#submit = doc.createElement("button");
      this.#submit.className = "primary";
      this.#submit.textContent = "Name the speakers";
      root.append(this.#submit);
    }
    this.#submitLabel = this.#submit.textContent;
    root.addEventListener("click", (event) => {
      const button = event.target.closest?.("button");
      const el = button?.closest(".speaker");
      const row = el && this.#rowsEl.contains(el) ? this.#rowOf.get(el) : null;
      if (!row) return;
      if (button.classList.contains("speaker-play")) this.#play(row.start, row.end, button);
      else if (button.classList.contains("speaker-keep")) this.#choose([{ kind: "keep", clip: row.clip }], []);
      else if (button.classList.contains("speaker-not")) {
        const input = this.#open(el, row);
        this.#refresh();
        input.focus();
      }
    });
    root.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#submitted();
    });
  }

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
   *   choice and no name it calls nothing, says "Type a name first." in
   *   `#speakers-said` and puts the cursor in the first empty name.
   *   (Flows "Correct a library name in the review", "Remember a speaker
   *   the user named")
   * - show.6 — While `state.naming` is not "": `#speakers-said` shows it,
   *   the form is `aria-busy`, its submit button is disabled and reads
   *   "Naming the speakers…", and the rows' names, Keep and Not buttons and
   *   `#remember` are disabled. The play buttons still play. The form
   *   stays shown while it names, even with no row left.
   *
   * @param {ReviewState} state
   */
  show(state) {
    const rows = reviewRows(state);
    const path = String(state?.path ?? "");
    const other = path !== this.#path;
    const key = JSON.stringify(rows);
    if (other) {
      this.#said = "";
      this.#remember.checked = false;
    }
    if (other || key !== this.#key) this.#draw(rows, other ? new Map() : this.#typed());
    this.#path = path;
    this.#key = key;
    this.#state = state;
    this.#root.classList.toggle("playable", Boolean(state?.playable));
    this.#refresh();
  }

  /**
   * - said.1 — `#speakers-said` shows `text` until the next `said`, or a
   *   show for another path; `said("")` gives the line back to the naming
   *   report. (P5)
   *
   * @param {string} text  what a refused clip or a failed command said
   */
  said(text) {
    this.#said = String(text ?? "");
    this.#refresh();
  }

  #refresh() {
    const rows = this.#rows;
    const naming = String(this.#state?.naming ?? "");
    const line = naming || this.#said || namingLine(this.#state?.kept?.naming ?? null);
    this.#saidEl.textContent = line;
    this.#saidEl.hidden = !line;
    this.#saidEl.toggleAttribute("data-naming", Boolean(naming));
    this.#root.setAttribute("aria-busy", String(Boolean(naming)));
    for (const el of this.#rowsEl.querySelectorAll("input, .speaker-keep, .speaker-not")) el.disabled = Boolean(naming);
    this.#remember.disabled = Boolean(naming);
    this.#submit.disabled = Boolean(naming);
    this.#submit.textContent = naming ? "Naming the speakers…" : this.#submitLabel;
    this.#rememberLabel.hidden = !(this.#state?.playable && rows.some((r) => r.kind === "label" && r.span));
    this.#submit.hidden = !naming && !(rows.some((r) => r.kind === "label") || this.#rowsEl.querySelector("input[data-not]"));
    this.#root.hidden = Boolean(this.#state?.busy) || (rows.length === 0 && !line);
  }

  // What the user typed and opened, by row.
  #typed() {
    const typed = new Map();
    for (const el of this.#rowsEl.querySelectorAll(".speaker")) {
      const row = this.#rowOf.get(el);
      const input = el.querySelector("input[data-label], input[data-not]");
      if (row && input) typed.set(keyOf(row), input.value);
    }
    return typed;
  }

  #draw(rows, typed) {
    const doc = this.#root.ownerDocument;
    const make = (tag, className, text) => {
      const el = doc.createElement(tag);
      if (className) el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const button = (className, text) => {
      const b = make("button", className, text);
      b.type = "button";
      return b;
    };
    this.#rows = rows;
    this.#rowsEl.replaceChildren(...rows.map((row, i) => {
      const el = make("div", "speaker");
      this.#rowOf.set(el, row);
      const who = row.kind === "label" ? row.label : row.name;
      const at = typeof row.start === "number" ? clock(row.start) : "";
      const play = button("speaker-play", at);
      play.hidden = !at;
      play.setAttribute("aria-label", at ? `Hear ${who}, at ${at}` : `Hear ${who}`);
      if (row.kind === "label") {
        el.dataset.label = row.label;
        const said = make("label");
        said.htmlFor = `${this.#id}-${i}`;
        const quote = make("q", "", row.sample?.length > 90 ? `${row.sample.slice(0, 90)}…` : row.sample ?? "");
        said.append(make("strong", "", row.label), " ", quote);
        const input = make("input");
        input.id = `${this.#id}-${i}`;
        input.dataset.label = row.label;
        input.placeholder = "Their name";
        input.value = typed.get(keyOf(row)) ?? "";
        el.append(play, said, input);
        return el;
      }
      const about = make("div", "speaker-who");
      about.append(make("strong", "", row.name), " ");
      if (row.kind === "library") {
        el.dataset.name = row.name;
        const source = make("span", "speaker-source", `named by the library, from ${row.status === "confirmed" ? "a confirmed" : "an unconfirmed"} clip`);
        source.dataset.status = row.status;
        about.append(source);
      } else {
        el.dataset.clip = row.clip;
        about.append(make("span", "speaker-learned", "the agent learned this voice in this meeting"), " ", button("speaker-keep", "Keep"));
      }
      about.append(" ", button("speaker-not", `Not ${row.name}?`));
      el.append(play, about);
      if (typed.has(keyOf(row))) this.#open(el, row).value = typed.get(keyOf(row));
      return el;
    }));
  }

  // Opens a library or learned row's "Their name".
  #open(el, row) {
    let input = el.querySelector("input[data-not]");
    if (!input) {
      input = el.ownerDocument.createElement("input");
      input.dataset.not = row.name;
      input.placeholder = "Their name";
      input.setAttribute("aria-label", `Not ${row.name}? Their name`);
      el.append(input);
      const not = el.querySelector(".speaker-not");
      if (not) not.hidden = true;
    }
    return input;
  }

  #submitted() {
    const choices = [];
    const names = [];
    const remember = !this.#rememberLabel.hidden && this.#remember.checked;
    const remembered = [];
    for (const el of this.#rowsEl.querySelectorAll(".speaker")) {
      const row = this.#rowOf.get(el);
      if (!row) continue;
      if (row.kind === "label") {
        const name = el.querySelector("input[data-label]")?.value.trim() ?? "";
        if (!name) continue;
        names.push([row.label, name]);
        if (remember && row.span) remembered.push({ kind: "remember", label: row.label, name, start: row.span.start, end: row.span.end });
        continue;
      }
      const to = el.querySelector("input[data-not]")?.value.trim() ?? "";
      if (!to || fold(to) === fold(row.name)) continue;
      for (const clip of row.kind === "learned" ? [row.clip] : row.clips) choices.push({ kind: "overrule", clip, from: row.name, to });
    }
    choices.push(...remembered);
    if (choices.length || names.length) return this.#choose(choices, names);
    this.said("Type a name first.");
    /** @type {HTMLInputElement|undefined} */
    const empty = [...this.#rowsEl.querySelectorAll("input[data-label], input[data-not]")].find((i) => !i.value.trim());
    empty?.focus();
  }
}
