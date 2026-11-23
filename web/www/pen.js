// Pens that write the page's text by hand: each text that shows gets a pen of its own, which
// flies in from off the page, writes the text line by line (the text is revealed only behind
// its tip) and flies off again, so text written at the same time has as many pens flying. A
// pen also draws SVG strokes, its tip on the stroke's end. The pens live in a fixed layer over
// the whole page; with reduced motion, nothing is hidden and no pen shows.

const SVG = "http://www.w3.org/2000/svg";

// The pens of penelope.ink, and one pencil, drawn along +x with the tip at (0, 0): a fountain pen
// (the pad's own, as on the desk), a blue ballpoint, a red fineliner (the red pen that marks and
// rings), a black rollerball, a green fountain pen, and a yellow pencil.
const METAL = { body: "#c4c9d2", light: "#eef0f4", dark: "#868c97" };
const GOLD = { body: "#c9a55e", light: "#f0dca6", dark: "#7a5e2a" };
const n = (v) => +v.toFixed(2);
// A tube from x0 to x1, `hw` either side of the axis, lit from above; `round` rounds its far end.
const tube = (x0, x1, hw, c, round = 0) => {
  const band = n(hw * 0.6);
  const outline = round ? `M${x0} ${-hw}H${x1 - round}A${round} ${hw} 0 0 1 ${x1 - round} ${hw}H${x0}Z` : `M${x0} ${-hw}H${x1}V${hw}H${x0}Z`;
  return `<path d="${outline}" fill="${c.body}"/><rect x="${x0}" y="${-hw}" width="${x1 - x0 - round}" height="${band}" fill="${c.light}"/>` +
    `<rect x="${x0}" y="${n(hw - band)}" width="${x1 - x0 - round}" height="${band}" fill="${c.dark}"/>`;
};
// A cone from the tip's half-width `a` at x0 to `b` at x1, its lower half in shade.
const cone = (x0, x1, a, b, c) => `<path d="M${x0} ${-a}L${x1} ${-b}V${b}L${x0} ${a}Z" fill="${c.body}"/>` +
  `<path d="M${x0} ${n(a * 0.3)}L${x1} ${n(b * 0.3)}V${b}L${x0} ${a}Z" fill="${c.dark}"/>`;
const clip = (x0, x1, hw, c) => `<rect x="${x0}" y="${n(-hw - 3.2)}" width="${x1 - x0}" height="3" rx="1.5" fill="${c.light}"/>` +
  `<circle cx="${x0 + 1.5}" cy="${n(-hw - 1.7)}" r="2" fill="${c.body}"/>`;
const fountain = (lacquer, trim) =>
  `<path d="M0 0C5-1.2 13-4.6 22-5.6V5.6C13 4.6 5 1.2 0 0Z" fill="${trim.body}" stroke="${trim.dark}" stroke-width=".6"/>` +
  `<path d="M1.5 0H15" stroke="${trim.dark}" stroke-width=".8"/><circle cx="16" cy="0" r="1.2" fill="${trim.dark}"/>` +
  `<path d="M21-5.4 44-6.6V6.6L21 5.4Z" fill="${lacquer.dark}"/>` + tube(44, 47, 7.2, trim) + tube(47, 162, 7.6, lacquer) +
  tube(162, 166, 8, trim) + tube(166, 216, 8, lacquer, 4) + clip(176, 212, 8, trim);
const ballpoint = (body, grip) =>
  cone(0, 14, 0.8, 3.6, METAL) + `<circle cx="1" cy="0" r="1.1" fill="#3a3d44"/>` + tube(14, 50, 5.6, grip) +
  [18, 23, 28, 33, 38, 43].map((x) => `<rect x="${x}" y="-5.6" width="1.3" height="11.2" fill="${grip.dark}" opacity=".55"/>`).join("") +
  tube(50, 190, 6.6, body) + tube(190, 198, 6.2, grip) + tube(198, 211, 3.4, METAL, 2) + clip(150, 194, 6.6, grip);
const fineliner = (body, ink) =>
  `<path d="M0 0L1-1 7-1.7V1.7L1 1Z" fill="${ink}"/>` + cone(7, 26, 1.9, 6.6, METAL) + tube(26, 186, 7, body) +
  tube(186, 189, 7.3, METAL) + tube(189, 214, 7.4, body, 4);
const rollerball = (body) =>
  cone(0, 18, 0.9, 5.2, METAL) + `<circle cx="1.1" cy="0" r="1.1" fill="#2a2c31"/>` + tube(18, 46, 6, { body: "#2b2d33", light: "#474a52", dark: "#17181c" }) +
  tube(46, 48.5, 6.6, METAL) + tube(48.5, 168, 7, body) + tube(168, 214, 7.6, body, 4) + clip(178, 210, 7.6, METAL);
const pencil = () => `<path d="M0 0 L29 -8 L29 8 Z" fill="#e8c592"/><path d="M0 0 L8 -2.2 L8 2.2 Z" fill="#333"/>` +
  tube(29, 189, 8, { body: "#f5c430", light: "#ffd95a", dark: "#d9a514" }) + `<rect x="189" y="-9" width="16" height="18" fill="#b9bcc2"/>` +
  `<rect x="205" y="-8" width="22" height="16" rx="3" fill="#e98a8f"/>`;
export const KINDS = [
  fountain({ body: "#1d2230", light: "#4a5470", dark: "#0e1118" }, GOLD),
  ballpoint({ body: "#2f5bb8", light: "#5b84d8", dark: "#1f3f86" }, { body: "#1f3f86", light: "#3a5ea8", dark: "#142a5c" }),
  fineliner({ body: "#c0392b", light: "#df5a4b", dark: "#8e2a1f" }, "#8e2a1f"),
  rollerball({ body: "#33353b", light: "#5a5d66", dark: "#1c1d21" }),
  fountain({ body: "#2f6b52", light: "#4f9576", dark: "#1d4635" }, METAL),
  pencil(),
];
// How often each is picked for a page's text: mostly pens, now and then the pencil.
const PICKS = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5];
// The markup of pen `kind` at `scale`, held at an angle as a hand holds it.
export const penMarkup = (kind, scale = 0.6) => `<g transform="scale(${n(scale)}) rotate(28)">${KINDS[kind]}</g>`;

// Client rects of text, as the lines they make up: rects whose middles are within half a
// line of each other are one line, from the leftmost to the rightmost.
export function groupLines(rects) {
  const lines = [];
  for (const r of [...rects].filter((r) => r.right > r.left && r.bottom > r.top).sort((a, b) => a.top - b.top || a.left - b.left)) {
    const mid = (r.top + r.bottom) / 2;
    const line = lines.find((l) => Math.abs((l.top + l.bottom) / 2 - mid) < Math.max(4, (r.bottom - r.top) / 2));
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
  }
  return lines.sort((a, b) => a.top - b.top);
}

// How long a pen takes over lines this many pixels wide in all.
export const writingMs = (width) => Math.round(Math.min(1700, Math.max(260, width * 2.4)));

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A hidden page gets no animation frames: a timer moves the pens on there.
const frame = () => new Promise((resolve) => {
  const timer = setTimeout(resolve, 100);
  requestAnimationFrame(() => {
    clearTimeout(timer);
    resolve();
  });
});
const easeIn = (p) => p * p;
// Slow to start and slow to land, as a hand moves a pen.
const easeInOut = (p) => (1 - Math.cos(p * Math.PI)) / 2;
// How long a pen takes to move `d` pixels through the air: a short hop is quick, a long one unhurried.
export const travelMs = (d) => Math.round(Math.min(600, Math.max(140, 120 + d * 0.7)));

export class Pen {
  // `size` scales the pen, and `pace` every move it makes: 1.5 is half as slow again.
  constructor(layer, kind, { size = 1, pace = 1 } = {}) {
    this.size = size;
    this.pace = pace;
    this.el = layer.ownerDocument.createElementNS(SVG, "svg");
    this.el.classList.add("pen");
    this.el.setAttribute("width", "1");
    this.el.setAttribute("height", "1");
    this.el.innerHTML = penMarkup(kind, 0.6 * size);
    layer.append(this.el);
    this.x = 0;
    this.y = 0;
  }

  place(x, y) {
    this.x = x;
    this.y = y;
    this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  // To (x, y) over `ms` (as far as it goes, when not given), lifted in an arc as high as the way is long.
  async glide(x, y, ms = null, ease = easeInOut) {
    const [x0, y0] = [this.x, this.y];
    const d = Math.hypot(x - x0, y - y0);
    const lift = Math.min(30, 4 + d * 0.08) * this.size;
    ms ??= travelMs(d);
    const t0 = performance.now();
    for (;;) {
      const p = Math.min(1, (performance.now() - t0) / (ms * this.pace));
      const e = ease(p);
      this.place(x0 + (x - x0) * e, y0 + (y - y0) * e - Math.sin(p * Math.PI) * lift);
      if (p >= 1) return;
      await frame();
    }
  }

  // From off the page, to (x, y).
  async flyIn(x, y) {
    const w = innerWidth;
    const h = innerHeight;
    const from = pickEdge(x, y, w, h);
    this.place(from[0], from[1]);
    this.el.classList.add("lifted");
    await this.glide(x, y, rand(520, 700));
    this.el.classList.remove("lifted");
  }

  async flyOff() {
    this.el.classList.add("lifted");
    const [x, y] = pickEdge(this.x, this.y, innerWidth, innerHeight);
    await this.glide(x, y, rand(460, 600), easeIn);
    this.el.remove();
  }

  // Lifted over to (x, y), as between lines, over `ms` or as long as the way asks.
  async hop(x, y, ms = null) {
    this.el.classList.add("lifted");
    await this.glide(x, y, ms);
    this.el.classList.remove("lifted");
  }
}

// A point just off the page's nearest edge to (x, y), a little to the side.
function pickEdge(x, y, w, h) {
  const edges = [[x + rand(-260, 260), -90], [w + 120, y + rand(-220, 220)], [x + rand(-260, 260), h + 60]];
  if (x > w / 2) return edges[Math.random() < 0.6 ? 1 : 0];
  return edges[Math.random() < 0.7 ? 0 : 2];
}

export class Pens {
  constructor(doc, { calm } = {}) {
    this.doc = doc;
    this.calm = calm ?? matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.jobs = new WeakMap();
    this.layer = null;
  }

  // The pens about the page are small, and a little quicker than the pad's own.
  pen({ size = 0.7, pace = 0.75, kind = PICKS[Math.floor(Math.random() * PICKS.length)] } = {}) {
    if (!this.layer) {
      this.layer = this.doc.createElement("div");
      this.layer.className = "pens";
      this.layer.setAttribute("aria-hidden", "true");
      this.doc.body.append(this.layer);
    }
    return new Pen(this.layer, kind, { size, pace });
  }

  // Writes `el` in with a pen of its own, after `delay`: it is hidden at once, so call this in
  // the task that shows it. A new write of the same element replaces one under way.
  async write(el, { delay = 0 } = {}) {
    if (this.calm || !el.getClientRects().length) return;
    const job = { cancelled: false };
    const old = this.jobs.get(el);
    if (old) old.cancelled = true;
    this.jobs.set(el, job);
    el.style.clipPath = "polygon(0 0, 0 0, 0 0)";
    if (delay) await sleep(delay);
    if (job.cancelled) return;
    const pen = this.pen();
    try {
      await this.writeWith(pen, el, job);
    } finally {
      if (this.jobs.get(el) === job) {
        el.style.clipPath = "";
        this.jobs.delete(el);
      }
      pen.flyOff();
    }
  }

  // `pen` writes `el`, flying in first if it is not on the page yet, or else hopping over (in `hop` ms, if given).
  async writeWith(pen, el, job = { cancelled: false }, { ms, fly = true, hop = null } = {}) {
    const box = el.getBoundingClientRect();
    const lines = this.linesOf(el, box);
    if (!lines.length) return;
    const reveal = (k, x) => {
      const L = (v) => (v - box.left).toFixed(1);
      const T = (v) => (v - box.top).toFixed(1);
      const W = box.width + 16;
      const H = box.height + 16;
      const top = k === 0 ? "-16" : T(lines[k].top);
      const bottom = k === lines.length - 1 ? H : T(lines[k].bottom);
      el.style.clipPath = `polygon(-16px -16px, ${W}px -16px, ${W}px ${top}px, ${L(x)}px ${top}px, ` +
        `${L(x)}px ${bottom}px, -16px ${bottom}px)`;
    };
    reveal(0, lines[0].left - 2);
    const total = lines.reduce((sum, l) => sum + l.right - l.left, 0);
    const budget = (ms ?? writingMs(total)) * pen.pace;
    const tip = (l) => l.top + (l.bottom - l.top) * 0.76;
    if (fly) await pen.flyIn(lines[0].left, tip(lines[0]));
    else await pen.hop(lines[0].left, tip(lines[0]), hop);
    for (const [k, line] of lines.entries()) {
      if (job.cancelled) return;
      if (k > 0) await pen.hop(line.left, tip(line));
      const lineMs = Math.max(120, (budget * (line.right - line.left)) / Math.max(1, total));
      const t0 = performance.now();
      for (;;) {
        if (job.cancelled) return;
        const p = Math.min(1, (performance.now() - t0) / lineMs);
        const x = line.left + (line.right - line.left) * p;
        reveal(k, x + 3);
        pen.place(x, tip(line) + Math.sin(p * (line.right - line.left) / (5 * pen.size)) * 2.2 * pen.size);
        if (p >= 1) break;
        await frame();
      }
    }
  }

  // `pen` draws `path` (an SVG path on the page) over `ms`, its tip on the stroke's end, after a
  // hop to where it begins (of `hop` ms, if given).
  async draw(pen, path, ms, live = () => true, hop = null) {
    const length = path.getTotalLength();
    path.style.strokeDasharray = `${length} ${length}`;
    path.style.strokeDashoffset = length;
    const at = (p) => {
      const point = path.getPointAtLength(length * p);
      return new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
    };
    const start = at(0);
    await pen.hop(start.x, start.y, hop);
    const t0 = performance.now();
    while (live()) {
      const p = Math.min(1, (performance.now() - t0) / (ms * pen.pace));
      path.style.strokeDashoffset = length * (1 - p);
      const point = at(p);
      pen.place(point.x, point.y);
      if (p >= 1) return;
      await frame();
    }
  }

  linesOf(el, box) {
    if (el.matches("input, textarea, select")) {
      const text = el.value || el.placeholder || el.selectedOptions?.[0]?.text || "";
      const size = parseFloat(getComputedStyle(el).fontSize) || 16;
      const width = Math.min(box.width, Math.max(40, text.length * size * 0.42 + 14));
      const bottom = el.matches("textarea") ? box.top + Math.min(box.height, size * 1.4) : box.bottom;
      return [{ left: box.left, right: box.left + width, top: box.top, bottom }];
    }
    const rects = [];
    const walker = this.doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = this.doc.createRange();
    while (walker.nextNode()) {
      if (!walker.currentNode.data.trim()) continue;
      range.selectNodeContents(walker.currentNode);
      rects.push(...range.getClientRects());
    }
    for (const field of el.querySelectorAll("input, textarea, select")) rects.push(...this.linesOf(field, field.getBoundingClientRect()));
    // A line starts at the element's own edge, so its padding and background show with it.
    const lines = groupLines(rects).map((l) => ({ ...l, left: Math.min(l.left, box.left) }));
    return lines.length ? lines : box.width ? [{ left: box.left, right: box.right, top: box.top, bottom: box.bottom }] : [];
  }
}
