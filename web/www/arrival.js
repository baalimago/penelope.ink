// The app comes onto the pad a piece at a time. The pad's own pen writes a checklist of what gets
// ready (CHECKLIST), a box and its words a line, and ticks a line off as soon as its piece is in;
// while it waits it doodles below. Penelope comes onto the desk once her line is written, asleep
// until the agent is in (penelope.js doze); the sidebar comes with the notes, as their line is
// ticked. Once every line is ticked, however long that takes, or when loading failed (the load bar
// then says what), an eraser rubs the list out and the page arrives: the sticky note is put down
// (pad.css), and every text of the app is written in by a pen of its own (pen.js), as is text
// that shows or changes later. What is still loading then, the load bar says (loadbar.js).
//
// The page comes a piece at a time too (PIECES), in reading order: the header's chips, each card
// of the setup (the sticky note is put down), the status line, then the recording form. A few pens
// (LANES) write it, each going on from one text to the next, so no more than they are ever about.
//
// #app gets the event "penelope" when she is due, the class "with-notes" when the sidebar comes,
// the class "arrived" when the page does (the body gets "app-arrived" with it, which shows the
// header's chips), and the event "arrived" once the page's pieces are written in.

import { Pens } from "./pen.js";
import { SHAPES } from "./doodles.js";
import { ORDER } from "./loadplan.js";

// The lines of the checklist, in the order the pen writes them. A line is ticked once `done` holds
// of #app's data-phase (`phase`) and of the load plan's stages not ready yet (`left`).
export const CHECKLIST = [
  { id: "machine", text: "Wake up the machine", done: ({ phase }) => phase !== "booting" },
  { id: "penelope", text: "Wake Penelope", done: ({ left }) => !left.includes("agent") },
  { id: "login", text: "Look for your slivingdoc login", done: ({ phase }) => !["booting", "checking"].includes(phase) },
  { id: "notes", text: "Fetch your notes", done: ({ phase }) => phase === "ready" },
  { id: "recorder", text: "Get the recorder ready", done: ({ left }) => !left.includes("record") },
  { id: "tools", text: "Pack Penelope's search tools", done: ({ left }) => !left.includes("extras") },
];

// The ids of the lines done, for #app's data-phase and body's data-loading (main.js: the stages not
// ready yet, space-separated; before the machine's first report there is none, and nothing is ready).
export function doneLines(phase = "booting", loading = undefined) {
  const left = loading === undefined ? [...ORDER] : loading.split(" ").filter(Boolean);
  return new Set(CHECKLIST.filter((line) => line.done({ phase, left })).map((line) => line.id));
}

// Whether `rect` shows through every one of `clips` (the window, and each box that scrolls or
// clips it): a pen writes nothing that does not.
export function seenThrough(rect, clips) {
  if (rect.bottom <= rect.top || rect.right <= rect.left) return false;
  return clips.every((c) => rect.bottom > c.top && rect.top < c.bottom && rect.right > c.left && rect.left < c.right);
}

// `el` on the screen: in the window and in every ancestor that scrolls or clips what overflows it.
function onScreen(el) {
  const clips = [{ top: 0, bottom: innerHeight, left: 0, right: innerWidth }];
  for (let box = el.parentElement; box && box !== document.body; box = box.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(box);
    if (`${overflowX} ${overflowY}` !== "visible visible") clips.push(box.getBoundingClientRect());
  }
  return seenThrough(el.getBoundingClientRect(), clips);
}

// What a pen writes in when it shows. The sticky note and the post-its are stuck on whole instead,
// and a meeting's notes are handwriting.js's.
const WRITTEN = [
  ".setup > .card:not(#notebook-card) > :is(h2, label, p)", ".setup > .card:not(#notebook-card) .row > *",
  "[data-view=record] > h1", "#record-form > :not(.postit)", "#empty", ".notebook > *", "#status",
  "#meetings .sidehead", "#meetings .meeting > *",
].join(", ");
const REWRITTEN = ["#machine-chip", "#notebook-chip", "#key-chip", "#status", "#notebook-status"];
// The header: its name at once, its chips with the page.
const BRAND = ".brand strong, .tagline";
const CHIPS = ".chip, .chips > button:not([hidden])";
// The pieces of the page in the order they come.
const PIECES = ["header .chips", "#provider-card", "#space-form", "#notebook-card", "#status", ".content > [data-view]"];
// The pens that write the page in, how far apart they set off, and their pace (1 is the pad's own).
const LANES = 4;
const LANE_MS = 220;
const LANE_PACE = 0.65;
// The sidebar's notes, written in as their line is ticked, have two.
const SIDE_LANES = 2;
const HIDDEN = "polygon(0 0, 0 0, 0 0)";

const RULE = 32;
const BOX = 20;
// How long the pad's pen takes for a letter, a box and a tick, and the pause after each line, unhurried:
// it moves between them as far as the way is long (pen.js travelMs). The eraser's time for the list.
const LETTER_MS = 23;
const BOX_MS = 250;
const TICK_MS = 220;
const REST_MS = [60, 140];
const ERASE_MS = 1100;
const SVG = "http://www.w3.org/2000/svg";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export class Arrival {
  constructor(doc, pens = new Pens(doc)) {
    this.doc = doc;
    this.pens = pens;
    this.calm = pens.calm;
    this.app = doc.querySelector("#app");
    this.list = doc.querySelector("#loading");
    this.brought = new Set();
    // ?slowload=SECONDS keeps the checklist on the pad at least that long, to watch it.
    const hold = Number(new URLSearchParams(doc.location?.search ?? "").get("slowload")) || 0;
    this.holdUntil = hold * 1000;
    this.began = performance.now();
  }

  start() {
    if (!this.app) return;
    this.watch();
    if (!this.list || this.calm) {
      if (this.list) this.list.hidden = true;
      this.bring("penelope");
      this.bring("notes");
      return this.arrive();
    }
    this.run();
  }

  get done() {
    return doneLines(this.app.dataset.phase, this.doc.body.dataset.loading);
  }

  // The checklist gives way before every line is ticked only when what loads failed, so that the
  // load bar can say so.
  get over() {
    return Boolean(this.doc.querySelector("#loadbar.failed"));
  }

  async run() {
    await Promise.race([this.doc.fonts?.ready, sleep(1500)]);
    for (const [i, el] of [...this.doc.querySelectorAll(BRAND)].entries()) this.pens.write(el, { delay: i * 90 });
    this.ink = this.doc.createElementNS(SVG, "svg");
    this.ink.classList.add("loader-ink");
    this.list.append(this.ink);
    // The pad's own pen: the fountain pen, big, and in no hurry.
    this.pen = this.pens.pen({ size: 1.5, pace: 1, kind: 0 });
    this.began = performance.now();
    this.doodles = [];
    const lines = [];
    while (!this.over) {
      const done = this.done;
      // A line whose piece is in is ticked before anything else is written.
      const due = lines.find((l) => !l.ticked && done.has(l.id));
      if (due) {
        await this.tick(due);
        continue;
      }
      if (lines.length < CHECKLIST.length) {
        lines.push(await this.writeLine(CHECKLIST[lines.length], lines.length));
        continue;
      }
      if (lines.every((l) => l.ticked) && performance.now() - this.began >= this.holdUntil) break;
      await this.doodle();
      await sleep(rand(500, 900));
    }
    await this.erase();
  }

  // A box, then its words beside it; Penelope comes as hers are written.
  async writeLine(item, i) {
    const li = this.doc.createElement("li");
    li.dataset.line = item.id;
    const ink = this.doc.createElement("span");
    ink.className = "ink";
    ink.textContent = item.text;
    li.append(ink);
    this.list.insertBefore(li, this.ink);
    ink.style.clipPath = "polygon(0 0, 0 0, 0 0)";
    const box = this.path(this.boxPath(i));
    if (i === 0) await this.pen.flyIn(...this.startOf(box));
    await this.pens.draw(this.pen, box, BOX_MS);
    await this.pens.writeWith(this.pen, ink, undefined, { ms: item.text.length * LETTER_MS, fly: false });
    ink.style.clipPath = "";
    if (item.id === "penelope") this.bring("penelope");
    await sleep(rand(...REST_MS));
    return { id: item.id, i, li };
  }

  async tick(line) {
    line.ticked = true;
    line.li.classList.add("done");
    await this.pens.draw(this.pen, this.path(this.tickPath(line.i), "tick"), TICK_MS);
    if (line.id === "notes") this.bring("notes");
  }

  // A piece of the app that comes before the page: Penelope, or the sidebar with the notes.
  bring(id) {
    if (this.brought.has(id)) return;
    this.brought.add(id);
    if (id === "penelope") this.app.dispatchEvent(new Event("penelope"));
    if (id === "notes") {
      this.app.classList.add("with-notes");
      const sidebar = this.app.querySelector(".sidebar");
      if (sidebar) this.fill(this.textsOf(sidebar), SIDE_LANES);
    }
  }

  boxPath(i) {
    const y = i * RULE + 5;
    const p = (x, yy) => `${(x + rand(-1, 1)).toFixed(1)} ${(yy + rand(-1, 1)).toFixed(1)}`;
    return `M${p(4, y)} L${p(4 + BOX, y)} L${p(4 + BOX, y + BOX)} L${p(4, y + BOX)} L${p(4, y + 1)}`;
  }

  tickPath(i) {
    const y = i * RULE + 5;
    return `M7 ${y + 10} L12 ${y + 17} L${4 + BOX + 6} ${y - 6}`;
  }

  path(d, kind = "") {
    const path = this.doc.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    if (kind) path.classList.add(kind);
    this.ink.append(path);
    return path;
  }

  // Where on the page a stroke begins.
  startOf(path) {
    const point = path.getPointAtLength(0);
    const at = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
    return [at.x, at.y];
  }

  // Where doodles go: below the checklist, inside the list's own box (pad.css places it).
  area() {
    return {
      x: 40, y: (CHECKLIST.length + 1) * RULE,
      w: this.list.clientWidth - 80, h: this.list.clientHeight - (CHECKLIST.length + 2) * RULE,
    };
  }

  overlaps(r) {
    return this.doodles.some((d) => r.x < d.x + d.w + 16 && d.x < r.x + r.w + 16 && r.y < d.y + d.h + 12 && d.y < r.y + r.h + 12);
  }

  // Rubs out the older half of what is drawn below the checklist.
  async clearOldest() {
    const old = this.doodles.splice(0, Math.max(1, Math.ceil(this.doodles.length / 2)));
    for (const d of old) d.path.classList.add("gone");
    await sleep(400);
    for (const d of old) d.path.remove();
  }

  // One doodle below the checklist, rubbing out the oldest when there is no room; cut short when
  // loading failed.
  async doodle() {
    const area = this.area();
    const shape = SHAPES[pick(Object.keys(SHAPES))];
    const scale = rand(0.7, 1);
    const w = shape.w * scale;
    const h = shape.h * scale;
    let spot = null;
    for (let i = 0; i < 30 && !spot && area.w > w && area.h > h; i++) {
      const r = { x: area.x + rand(0, area.w - w), y: area.y + rand(0, area.h - h), w, h };
      if (!this.overlaps(r)) spot = r;
    }
    if (!spot) return this.doodles.length ? this.clearOldest() : sleep(300);
    const path = this.path(shape.d(shape.w, shape.h), "doodle");
    path.setAttribute("transform", `translate(${spot.x.toFixed(1)} ${spot.y.toFixed(1)}) scale(${scale.toFixed(2)})`);
    this.doodles.push({ ...spot, path });
    await this.pens.draw(this.pen, path, rand(1300, 1900), () => !this.over);
  }

  async erase() {
    this.pen?.flyOff();
    const eraser = this.doc.createElement("span");
    eraser.className = "eraser";
    eraser.setAttribute("aria-hidden", "true");
    eraser.style.setProperty("--far", `${Math.max(120, this.list.offsetWidth - 40)}px`);
    this.list.append(eraser);
    this.list.classList.add("erasing");
    await sleep(ERASE_MS * 0.55);
    this.arrive();
    await sleep(ERASE_MS * 0.45);
    this.list.hidden = true;
  }

  // The page arrives a piece at a time, and with it whatever of the app had not come yet and is due.
  async arrive() {
    this.bring("penelope");
    if (this.app.dataset.phase === "ready") this.bring("notes");
    this.app.classList.add("arrived");
    this.app.setAttribute("aria-busy", "false");
    this.doc.body.classList.add("app-arrived");
    const shownAt = performance.now();
    // Every piece is hidden at once, then written in its turn; the sticky note waits to be put down.
    const queue = [];
    for (const selector of this.calm ? [] : PIECES) {
      const piece = this.doc.querySelector(selector);
      if (!piece?.getClientRects().length || !piece.textContent.trim()) continue;
      if (piece.id === "notebook-card") {
        piece.style.setProperty("--put", "600s");
        queue.push({ note: piece });
      } else {
        queue.push(...(piece.matches(".chips") ? [...piece.querySelectorAll(CHIPS)] : this.textsOf(piece)).map((el) => ({ el })));
      }
    }
    await this.fill(queue, LANES, (note) => this.putDown(note, performance.now() - shownAt));
    this.app.dispatchEvent(new Event("arrived"));
  }

  // The sticky note is put down whole now, `since` ms after it showed (pad.css sticky-put: its
  // delay counts from then).
  async putDown(note, since) {
    note.style.setProperty("--put", `${Math.round(since)}ms`);
    setTimeout(() => note.style.removeProperty("--put"), 1400);
    await sleep(700);
  }

  // `lanes` pens write the texts of `items` ({el}, or {note} for `note(el)` to put down), in order:
  // each takes the next as it is done with one, and flies off when none is left. Every text is
  // hidden at once. Resolves once all are in.
  async fill(items, lanes, note = () => {}) {
    const queue = items.map((item) => (item.el || item.note ? item : { el: item }));
    for (const { el } of queue) if (el) el.style.clipPath = HIDDEN;
    const lane = async () => {
      let pen = null;
      for (let item; (item = queue.shift());) {
        if (item.note) {
          await note(item.note);
          continue;
        }
        const el = item.el;
        el.closest(".fresh")?.classList.remove("fresh");
        // What is not on the screen (below it, scrolled out of the sidebar's list, or not shown) is in at once.
        if (this.calm || !el.getClientRects().length || !onScreen(el)) {
          el.style.clipPath = "";
          continue;
        }
        const fly = !pen;
        pen ??= this.pens.pen({ pace: LANE_PACE });
        try {
          await this.pens.writeWith(pen, el, undefined, { fly });
        } finally {
          el.style.clipPath = "";
        }
      }
      pen?.flyOff();
    };
    await Promise.all(Array.from({ length: lanes }, (_, i) => sleep(i * LANE_MS).then(lane)));
  }

  // Whether `el` shows by now: the sidebar's once the notes came, the rest once the page did.
  shown(el) {
    return this.app.classList.contains("arrived") || (this.app.classList.contains("with-notes") && Boolean(el.closest?.(".sidebar")));
  }

  // The texts in `root` a pen writes in, in reading order.
  textsOf(root) {
    return [...(root.matches?.(WRITTEN) ? [root] : []), ...root.querySelectorAll(WRITTEN)].filter((el) => !el.closest(".postit"));
  }

  // Every text in `root` that shows is written in, by two pens taking turns.
  writeIn(root) {
    return this.fill(this.textsOf(root), SIDE_LANES);
  }

  // Afterwards: the notes once listed, what shows again, a meeting new to the list, and text that changes.
  watch() {
    new MutationObserver(() => {
      if (this.app.classList.contains("arrived") && this.app.dataset.phase === "ready") this.bring("notes");
    }).observe(this.app, { attributes: true, attributeFilter: ["data-phase"] });
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.oldValue === null || r.target.hidden || !this.shown(r.target)) continue;
        // A post-it is stuck on whole, not written.
        if (r.target.closest("#notebook-card, [data-view=meeting], #loading, .postit")) continue;
        this.writeIn(r.target);
      }
    }).observe(this.app, { attributes: true, attributeFilter: ["hidden"], attributeOldValue: true, subtree: true });
    const meetings = this.doc.querySelector("#meetings");
    if (meetings) {
      new MutationObserver(() => {
        if (!this.app.classList.contains("with-notes")) return;
        const parts = [];
        for (const fresh of meetings.querySelectorAll(".fresh")) {
          fresh.classList.remove("fresh");
          parts.push(...(fresh.matches(".sidehead") ? [fresh] : [...fresh.children]));
        }
        if (parts.length) this.fill(parts, SIDE_LANES);
      }).observe(meetings, { childList: true });
    }
    for (const el of REWRITTEN.map((s) => this.doc.querySelector(s)).filter(Boolean)) {
      let text = el.textContent;
      new MutationObserver(() => {
        if (el.textContent === text) return;
        text = el.textContent;
        if (text && this.shown(el)) this.pens.write(el);
      }).observe(el, { childList: true, characterData: true, subtree: true });
    }
  }
}

if (typeof document !== "undefined") new Arrival(document).start();
