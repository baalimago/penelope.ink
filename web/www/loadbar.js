// The load bar on the pad: the app shows before the machine is up and before its programs are
// in (loadplan.js), so the bar says what is still coming, how much of it, and what is not ready
// until then. It goes once everything is in and the notes are listed.
import { pending } from "./loadplan.js";

// What Minutes is doing as it starts, by #app's data-phase.
export const STEPS = {
  booting: "Waking up the machine…",
  checking: "Looking for your slivingdoc login…",
  fetching: "Fetching your notes from slivingdoc…",
  listing: "Reading the notes kept in this browser…",
};
// What a stage of the load plan lets the user do, and what the bar says while it loads.
const NEEDS = { machine: "the machine", agent: "Penelope", record: "recording", extras: "the other tools" };
const LOADING = { agent: "Loading Penelope…", record: "Getting ready to record…", extras: "Loading the other tools…" };

const mb = (bytes) => (bytes / 1e6).toFixed(1);

// What the bar shows for the worker's `files`, Minutes' `phase`, the programs something
// `waiting` on the machine waits for, and the boot's failure `stopped`: {text, detail, fraction
// (null when the whole is unknown), action}, or null when there is nothing left to show.
export function barState({ files = null, phase = "ready", waiting = [], stopped = "" } = {}) {
  if (stopped) return { text: "The machine did not start.", detail: stopped, fraction: null, action: "Reload" };
  const left = pending(files);
  if (left.length === 0) return STEPS[phase] ? { text: STEPS[phase], detail: "", fraction: null, action: null } : null;
  const got = (files ?? []).reduce((sum, f) => sum + (f.state === "installed" ? f.bytes ?? f.got : f.got), 0);
  const whole = files?.every((f) => f.bytes) ? files.reduce((sum, f) => sum + f.bytes, 0) : null;
  const notReady = `not ready yet: ${left.map((id) => NEEDS[id]).join(", ")}`;
  const failed = (files ?? []).filter((f) => f.state === "failed");
  if (failed.length) {
    return { text: `Could not load ${failed.map((f) => f.name).join(", ")}.`, detail: `${failed[0].error}. N${notReady.slice(1)}.`, fraction: whole && got / whole, action: "Try again" };
  }
  const parts = [whole ? `${mb(got)} of ${mb(whole)} MB` : `${mb(got)} MB`, notReady];
  if (waiting.length) parts.push(`a run waits for ${waiting.join(", ")}`);
  return {
    text: left[0] === "machine" ? STEPS.booting : STEPS[phase] ?? LOADING[left[0]],
    detail: parts.join(" · "), fraction: whole && got / whole, action: null,
  };
}

const W = 220;
const H = 14;
const wobble = (n) => (n + (Math.random() - .5) * 1.6).toFixed(1);
// A box drawn by hand, and the pencil shading that fills it from the left.
const boxPath = () => `M${wobble(1)} ${wobble(2)} L${wobble(W - 1)} ${wobble(1.5)} L${wobble(W - 1.5)} ${wobble(H - 1.5)} L${wobble(1.5)} ${wobble(H - 1)} L${wobble(1)} ${wobble(1)}`;
const shadePath = () => {
  let d = `M2 ${H - 2}`;
  for (let x = 2; x < W; x += 5) d += ` L${wobble(x + 4)} ${wobble(2.5)} L${wobble(x + 5)} ${wobble(H - 2.5)}`;
  return d;
};

export class LoadBar {
  constructor(doc, retry) {
    this.doc = doc;
    this.root = doc.querySelector("#loadbar");
    this.app = doc.querySelector("#app");
    this.retry = retry;
    this.state = {};
    if (!this.root) return;
    this.root.querySelector(".loadbar-box").setAttribute("d", boxPath());
    this.root.querySelector(".loadbar-shade").setAttribute("d", shadePath());
    this.root.querySelector("button").onclick = () => (this.state.stopped ? doc.location.reload() : this.retry());
    new MutationObserver(() => this.render()).observe(this.app, { attributes: true, attributeFilter: ["data-phase"] });
    this.render();
  }

  show(change) {
    Object.assign(this.state, change);
    this.render();
  }

  render() {
    if (!this.root) return;
    // Controls that run what is still loading say so; a click on one waits.
    const left = pending(this.state.files);
    for (const el of this.doc.querySelectorAll("[data-needs]")) {
      const waits = left.includes(el.dataset.needs);
      el.classList.toggle("getting-ready", waits);
      el.title = waits ? "Getting ready: this waits for what is still loading" : "";
    }
    const bar = barState({ ...this.state, phase: this.app.dataset.phase });
    this.root.hidden = !bar;
    if (!bar) return;
    const set = (selector, text) => {
      const el = this.root.querySelector(selector);
      if (el.textContent !== text) el.textContent = text;
    };
    set(".loadbar-text", bar.text);
    set(".loadbar-detail", bar.detail);
    this.root.classList.toggle("failed", Boolean(bar.action));
    this.root.querySelector("svg").style.visibility = bar.fraction === null ? "hidden" : "";
    this.root.querySelector(".loadbar-clip rect").setAttribute("width", String(W * (bar.fraction ?? 0)));
    const button = this.root.querySelector("button");
    button.hidden = !bar.action;
    if (bar.action) button.textContent = bar.action;
  }
}
