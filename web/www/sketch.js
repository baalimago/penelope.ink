// The user's blue pen, lying on the desk (#desk-pen). A click picks it up: the pointer is the pen
// (body.doodling), and dragging on the pad draws in blue ink beside the pencil's doodles. A click on
// its place, or Escape, puts it down. The ink stays on the page until the pad turns it ("pageturn").

const SVG = "http://www.w3.org/2000/svg";
// Points nearer than this, in px, to the last one add nothing to a stroke.
const STEP = 1.5;

// A stroke through `points` ([x, y]) as a path: quadratic curves through the midpoints, so it is as
// smooth as the hand that drew it; a single point is a dot.
export function inkPath(points) {
  if (points.length === 0) return "";
  const f = (n) => Number(n.toFixed(1));
  const [[x0, y0]] = points;
  if (points.length === 1) return `M${f(x0)} ${f(y0)}l0.1 0`;
  let d = `M${f(x0)} ${f(y0)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const [xl, yl] = points.at(-1);
  return `${d}L${f(xl)} ${f(yl)}`;
}

export class Sketch {
  constructor(doc) {
    this.doc = doc;
    this.pen = doc.querySelector("#desk-pen");
    this.content = doc.querySelector(".content");
    this.layer = null;
    this.stroke = null;
  }

  start() {
    if (!this.pen || !this.content) return;
    this.pen.onclick = () => this.hold(!this.held);
    this.doc.addEventListener("keydown", (e) => {
      if (!this.held || e.target.closest?.("input, textarea, [contenteditable='true']")) return;
      if (e.key === "Escape") this.hold(false);
      // Ctrl/Cmd+Z takes back the last stroke.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        this.layer?.lastElementChild?.remove();
      }
    });
    this.content.addEventListener("pageturn", () => this.layer?.replaceChildren());
    this.hold(false);
  }

  get held() {
    return this.doc.body.classList.contains("doodling");
  }

  hold(on) {
    this.doc.body.classList.toggle("doodling", on);
    this.pen.setAttribute("aria-pressed", String(on));
    this.pen.title = on ? "Put your pen down (Esc)" : "Pick up your pen to doodle on the pad";
    this.pen.querySelector(".desk-pen-say").textContent = on ? "Put it down" : "Doodle";
    if (on) this.fit();
    else this.stroke = null;
  }

  // The layer covers the pad's whole page, however far it scrolls.
  fit() {
    if (!this.layer) {
      this.layer = this.doc.createElementNS(SVG, "svg");
      this.layer.classList.add("sketch");
      this.layer.setAttribute("aria-hidden", "true");
      this.layer.addEventListener("pointerdown", (e) => this.down(e));
      this.layer.addEventListener("pointermove", (e) => this.move(e));
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) this.layer.addEventListener(type, () => (this.stroke = null));
    }
    if (!this.layer.isConnected) this.content.append(this.layer);
    this.layer.setAttribute("width", this.content.scrollWidth);
    this.layer.setAttribute("height", this.content.scrollHeight);
  }

  at(e) {
    const box = this.layer.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top];
  }

  down(e) {
    if (!this.held || e.button !== 0) return;
    e.preventDefault();
    this.fit();
    this.layer.setPointerCapture?.(e.pointerId);
    const path = this.doc.createElementNS(SVG, "path");
    this.layer.append(path);
    this.stroke = { id: e.pointerId, path, points: [this.at(e)] };
    path.setAttribute("d", inkPath(this.stroke.points));
  }

  move(e) {
    const s = this.stroke;
    if (!s || e.pointerId !== s.id) return;
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length > 0 ? events : [e]) {
      const p = this.at(ev);
      const last = s.points.at(-1);
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= STEP) s.points.push(p);
    }
    s.path.setAttribute("d", inkPath(s.points));
  }
}
