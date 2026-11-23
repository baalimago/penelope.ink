// Points the user at a block of the pad, such as the AI provider card when nothing can run without
// one: the pad scrolls the block into view, a red pencil rings it, and the ring fades after a while
// (pad.css .pointer-ring). A page turn takes the ring away. With reduced motion the ring just shows.
import { Pens } from "./pen.js";

const SVG = "http://www.w3.org/2000/svg";
// How far the ring stands off the block, and how long it stays.
const GAP = 10;
const HOLD_MS = 5000;
const DRAW_MS = 1100;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A loose ring round the box at (x, y), w wide and h tall, drawn once round from near its top left,
// clockwise, and a little past where it began, as a hand goes round a paragraph.
export function ringPath(x, y, w, h, jitter = 2) {
  const p = (px, py) => `${(px + rand(-jitter, jitter)).toFixed(1)} ${(py + rand(-jitter, jitter)).toFixed(1)}`;
  const r = Math.min(30, w / 4, h / 3);
  const [L, T, R, B] = [x, y, x + w, y + h];
  return `M${p(L + w * 0.28, T + 3)} L${p(R - r, T - 1)} Q${p(R + 2, T)} ${p(R + 1, T + r)} ` +
    `L${p(R + 3, B - r)} Q${p(R + 1, B + 3)} ${p(R - r, B + 1)} L${p(L + r, B + 3)} Q${p(L - 3, B + 1)} ${p(L - 1, B - r)} ` +
    `L${p(L - 3, T + r)} Q${p(L - 1, T - 2)} ${p(L + r + 6, T - 2)} L${p(L + w * 0.36, T - 4)}`;
}

export class Pointer {
  constructor(doc, pens = new Pens(doc)) {
    this.doc = doc;
    this.pens = pens;
    this.ring = null;
    this.timer = 0;
  }

  // Rings `el`; false when it does not show, so there is nothing to point at.
  async at(el) {
    const content = el?.closest?.(".content");
    if (!content || !el.getClientRects().length) return false;
    this.clear();
    const view = this.doc.defaultView;
    const tall = el.getBoundingClientRect().height > view.innerHeight * 0.6;
    el.scrollIntoView({ behavior: this.pens.calm ? "auto" : "smooth", block: tall ? "start" : "center" });
    await this.settled(el);
    const box = el.getBoundingClientRect();
    const sheet = content.getBoundingClientRect();
    const ring = this.doc.createElementNS(SVG, "svg");
    ring.classList.add("pointer-ring");
    ring.setAttribute("aria-hidden", "true");
    ring.setAttribute("width", String(content.scrollWidth));
    ring.setAttribute("height", String(content.scrollHeight));
    const path = this.doc.createElementNS(SVG, "path");
    const x = box.left - sheet.left + content.scrollLeft - GAP;
    const y = box.top - sheet.top + content.scrollTop - GAP;
    path.setAttribute("d", ringPath(x, y, box.width + 2 * GAP, box.height + 2 * GAP));
    ring.append(path);
    content.append(ring);
    this.ring = ring;
    content.addEventListener("pageturn", () => this.clear(), { once: true });
    if (!this.pens.calm) {
      const pen = this.pens.pen({ size: 1.2, pace: 1, kind: 2 });
      await this.pens.draw(pen, path, DRAW_MS, () => this.ring === ring);
      pen.flyOff();
    }
    this.timer = setTimeout(() => this.fade(ring), HOLD_MS);
    return true;
  }

  // Waits until the scroll has stopped moving `el`, at most about a second.
  async settled(el) {
    let last = NaN;
    for (let i = 0; i < 40; i++) {
      await sleep(30);
      const top = el.getBoundingClientRect().top;
      if (Math.abs(top - last) < 0.5) return;
      last = top;
    }
  }

  fade(ring) {
    ring.classList.add("gone");
    setTimeout(() => ring.remove(), 700);
    if (this.ring === ring) this.ring = null;
  }

  clear() {
    clearTimeout(this.timer);
    this.ring?.remove();
    this.ring = null;
  }
}
