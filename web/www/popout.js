// The pop-out: a small always-on-top window (Document Picture-in-Picture) with a row for each run,
// and what the tab's title and icon say of them while the user is elsewhere.

import { PHASE_TEXT, clock, estimate, jobStatus, leftText } from "./jobs.js";

// Whether job's ffmpeg records now (Minutes.watchStages).
export const isLive = (job) => !job.done && job.stages.has("recording") && !job.stages.has("recorded");

const recorded = (job, now) => clock(job.started ? Math.max(0, (now - job.started) / 1000) : 0);

// The runs under way, and those the open window has shown.
export const popoutJobs = (jobs, shown) => jobs.filter((j) => !j.replaced && (!j.done || shown.has(j.id)));

export const running = (jobs) => jobs.some((j) => !j.done);

// A run's row at `now` (ms): `kind` is recording, progress, working, filed, answered or stopped.
export function popoutRow(job, now, pace) {
  const row = { id: job.id, title: job.title, kind: "working", state: "", detail: "", progress: null, stoppable: false };
  if (job.done) {
    if (job.status !== 0) return { ...row, kind: "stopped", state: "The agent stopped", detail: job.problem?.title ?? `exit ${job.status}` };
    return { ...row, kind: job.filed ? "filed" : "answered", state: job.filed ? "✓ Filed" : "The agent answered" };
  }
  if (isLive(job)) {
    return {
      ...row, kind: "recording", state: `● ${recorded(job, now)}`,
      detail: job.quiet ? "no sound from the tab" : "", stoppable: Boolean(job.stopFile) && !job.stopSent,
    };
  }
  const guess = estimate(job, now, pace);
  if (!guess) return { ...row, detail: jobStatus(job, now, pace) };
  const left = leftText(guess).replace("taking longer than expected", "taking longer");
  return { ...row, kind: "progress", state: PHASE_TEXT[guess.phase], detail: left, progress: guess.progress };
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// What the tab says, `{ text, icon }`, or null when nothing runs: the recording, else the run
// nearest done, else that a run works; then how the last run that ended out of sight (`unseen`) ended.
export function tabStatus(jobs, unseen, now, pace) {
  const runs = jobs.filter((j) => !j.done && !j.replaced);
  const live = runs.find(isLive);
  if (live) return { text: `${live.quiet ? "(No sound) " : ""}● ${recorded(live, now)}`, icon: { kind: "recording" } };
  const guesses = runs.map((job) => estimate(job, now, pace)).filter(Boolean);
  if (guesses.length > 0) {
    const guess = guesses.reduce((a, b) => (b.seconds < a.seconds ? b : a));
    return { text: guess.late ? "Taking longer" : capital(leftText(guess).replace(/^about /, "")), icon: { kind: "progress", progress: guess.progress } };
  }
  if (runs.length > 0) return { text: jobStatus(runs[0], now, pace), icon: { kind: "progress", progress: 0 } };
  if (!unseen) return null;
  if (unseen.status !== 0) return { text: "The agent stopped", icon: { kind: "stopped" } };
  return { text: unseen.filed ? "✓ Filed" : "The agent answered", icon: { kind: "filed" } };
}

const PAD = '<rect x="1" y="1" width="30" height="30" rx="5" fill="#fff5b4" stroke="#d5c67c"/>';
const PEN = 'fill="none" stroke="#c0392b" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"';

// The tab's icon for a status, as SVG; the ring fills in twelfths.
export function statusIcon({ kind, progress = 0 }) {
  const body = {
    recording: '<circle cx="16" cy="16" r="12" fill="#c0392b"/>',
    progress: `${PAD}<circle cx="16" cy="16" r="9" fill="none" stroke="#e7da8f" stroke-width="6"/>` +
      `<circle cx="16" cy="16" r="9" fill="none" stroke="#c0392b" stroke-width="6" pathLength="12" ` +
      `stroke-dasharray="${Math.round(Math.min(1, progress) * 12)} 12" transform="rotate(-90 16 16)"/>`,
    filed: `${PAD}<path d="M8 17l5 5 11-12" ${PEN}/>`,
    stopped: `${PAD}<path d="M10 10l12 12M22 10 10 22" ${PEN}/>`,
  }[kind];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`;
}

const ROW_PX = 64;
const BARS = 40;

export class Popout {
  // `jobs()` and `pace()` are Minutes'; `stop(job)` ends a job's recording; `pick(job)` brings the
  // tab back with the job in view; `changed()` follows the window opening and closing.
  constructor({ jobs, pace, stop, pick, changed = () => {}, pip = globalThis.documentPictureInPicture }) {
    Object.assign(this, { jobs, pace, stop, pick, changed, pip });
    this.win = null;
    this.list = null;
    this.empty = null;
    this.shown = new Set();
    this.levels = [];
    this.waving = false;
    this.opening = false;
  }

  get supported() {
    return Boolean(this.pip);
  }

  get open() {
    return Boolean(this.win);
  }

  // Needs a click, or Chrome's automatic picture-in-picture (the enterpictureinpicture action).
  async show() {
    if (this.win || this.opening) return;
    this.opening = true;
    const rows = Math.max(1, popoutJobs(this.jobs(), this.shown).length);
    const win = await this.pip.requestWindow({ width: 300, height: Math.min(360, 16 + ROW_PX * rows) }).catch(() => null);
    this.opening = false;
    if (!win) return;
    const doc = win.document;
    const css = doc.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL("./popout.css", import.meta.url).href;
    doc.head.append(css);
    doc.title = "Penelope";
    this.list = doc.createElement("ol");
    doc.body.append(this.list);
    this.empty = Object.assign(doc.createElement("li"), { className: "empty", textContent: "Nothing in progress." });
    this.win = win;
    win.addEventListener("pagehide", () => this.closed(win));
    // The window's own timer: the hidden tab's are throttled.
    win.setInterval(() => this.render(), 500);
    this.render();
    this.changed();
  }

  close() {
    this.win?.close();
  }

  closed(win) {
    if (this.win !== win) return;
    this.win = null;
    this.list = null;
    this.empty = null;
    this.waving = false;
    this.shown.clear();
    this.changed();
  }

  render() {
    if (!this.win) return;
    const now = Date.now();
    const pace = this.pace();
    const jobs = popoutJobs(this.jobs(), this.shown);
    const drawn = new Map([...this.list.children].map((li) => [li.dataset.id, li]));
    const nodes = jobs.map((job) => {
      this.shown.add(job.id);
      const li = drawn.get(String(job.id)) ?? this.row(job);
      this.fill(li, popoutRow(job, now, pace));
      return li;
    });
    if (nodes.length === 0) nodes.push(this.empty);
    if (nodes.length !== this.list.children.length || nodes.some((li, i) => this.list.children[i] !== li)) this.list.replaceChildren(...nodes);
    this.drawWave();
  }

  row(job) {
    const doc = this.win.document;
    const el = (tag, className, parent) => parent.appendChild(Object.assign(doc.createElement(tag), { className }));
    const li = doc.createElement("li");
    li.dataset.id = job.id;
    const head = Object.assign(el("button", "line", li), { type: "button", title: "Back to Penelope", onclick: () => this.pick(job) });
    el("strong", "title", head);
    el("span", "state", head);
    const foot = el("div", "line", li);
    el("span", "wave", foot);
    el("i", "", el("span", "gauge", foot));
    el("span", "detail", foot);
    const stop = el("button", "stop", foot);
    stop.textContent = "Stop";
    stop.onclick = () => {
      this.stop(job);
      this.render();
    };
    return li;
  }

  fill(li, row) {
    const [head, foot] = li.children;
    const [title, state] = head.children;
    const [wave, gauge, detail, stop] = foot.children;
    li.className = row.kind;
    if (title.textContent !== row.title) title.textContent = row.title;
    if (state.textContent !== row.state) state.textContent = row.state;
    if (detail.textContent !== row.detail) detail.textContent = row.detail;
    wave.hidden = row.kind !== "recording";
    stop.hidden = row.kind !== "recording";
    stop.disabled = !row.stoppable;
    gauge.hidden = row.progress === null;
    if (row.progress !== null) gauge.style.setProperty("--p", row.progress.toFixed(3));
    foot.hidden = !row.detail && row.kind !== "recording" && row.progress === null;
  }

  // The loudness of the latest samples, 0 to 1, for the recording row's wave.
  wave(levels) {
    this.levels = levels;
    if (!this.win || this.waving) return;
    this.waving = true;
    this.win.requestAnimationFrame(() => {
      this.waving = false;
      this.drawWave();
    });
  }

  drawWave() {
    const wave = this.list?.querySelector(".recording .wave");
    if (!wave) return;
    const levels = this.levels.slice(-BARS);
    while (wave.children.length < levels.length) wave.append(this.win.document.createElement("span"));
    while (wave.children.length > levels.length) wave.lastChild.remove();
    levels.forEach((level, i) => {
      wave.children[i].style.height = `${Math.max(2, Math.round(level * 22))}px`;
    });
  }
}
