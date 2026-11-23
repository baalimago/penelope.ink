// Penelope, the red pen on the desk: the app's agent (penelope.json), who guides the user, answers about
// the app and their meetings, and corrects the meeting in focus; and the bubble to talk to her.
import { renderMarkdown } from "./markdown.js";

const MOODS = ["glad", "unsure", "sorry"];
const MOUTHS = {
  glad: "M19.5 91.5 Q24 96.5 28.5 91.5",
  unsure: "M19.5 93 Q21.75 90.5 24 93 T28.5 93",
  sorry: "M19.5 95 Q24 89.5 28.5 95",
  busy: "M22.2 93 a1.8 2.2 0 1 0 3.6 0 a1.8 2.2 0 1 0 -3.6 0",
  open: "M20.6 93 a3.4 3.4 0 1 0 6.8 0 a3.4 3.4 0 1 0 -6.8 0",
  chomp: "M19.5 93 l2.25 -1.4 l2.25 1.4 l2.25 -1.4 l2.25 1.4",
  // Chewing: a full mouth, then closed and wavy, by turns; then a gulp.
  full: "M21.4 93 a2.6 1.9 0 1 0 5.2 0 a2.6 1.9 0 1 0 -5.2 0",
  munch: "M20.2 93.4 q1.9 -1.5 3.8 0 t3.8 0",
  gulp: "M22.9 93 a1.1 1.3 0 1 0 2.2 0 a1.1 1.3 0 1 0 -2.2 0",
};
// How near her eyes, in px, a resting pointer gets pounced on, how long it rests first, and how seldom.
const POUNCE_REACH = 300;
const POUNCE_REST_MS = 900;
const POUNCE_EVERY_MS = 25_000;
// How she chews what she caught: bites, each this long, then a gulp.
const CHEWS = 6;
const CHEW_MS = 150;
// How long her bubble takes to shrink back into her (pad.css .penelope-bubble).
const BUBBLE_OUT_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Where her pupils look, in px, for a pointer `dx, dy` px from her eyes: toward it, less when it is close.
export function gaze(dx, dy) {
  const d = Math.hypot(dx, dy);
  if (!d) return { x: 0, y: 0 };
  const reach = Math.min(1, d / 60);
  return { x: (dx / d) * 1.7 * reach, y: (dy / d) * 2.2 * reach };
}

// How she jumps at a pointer `dx, dy` px from her eyes: as far as `most` px, hardly down, leaning toward it;
// `reached` when she gets all the way there, and so eats it rather than snap at the air.
export function lunge(dx, dy, most = 170) {
  const k = Math.min(1, most / (Math.hypot(dx, dy) || 1));
  const x = dx * k;
  return { x, y: Math.min(30, dy * k), turn: Math.max(-15, Math.min(15, x / 10)), reached: k === 1 && dy <= 30 };
}

// The INPUT section of Penelope's prompt: the user message of one turn.
export function penelopeQuery({ screen, actions, corrections, request }) {
  for (const [field, value] of Object.entries({ screen, actions, corrections, request })) {
    if (value === undefined) throw new Error(`penelopeQuery: ${field} is missing`);
  }
  return [
    "INPUT",
    "On the user's screen:",
    ...screen.map((line) => `- ${line}`),
    "Actions the app can take for you now:",
    ...actions.map((line) => `- ${line}`),
    "The user's unsaved corrections to the meeting in focus, already in its copies:",
    ...corrections.map((c) => `- ${c}`),
    `Request: ${request}`,
  ].join("\n");
}

// The unsaved corrections of a Fixes, a line each, at most `limit` of them.
export function correctionsOf(fixes, limit = 20) {
  const out = [];
  for (const file of Object.keys(fixes.lines)) {
    for (const [n, now] of fixes.changed[file]) {
      out.push(now === null ? `${file}.md: took out “${fixes.original(file, n)}”` : `${file}.md: “${fixes.original(file, n)}” → “${now}”`);
    }
    for (const lines of fixes.added[file].values()) for (const line of lines) out.push(`${file}.md: added “${line}”`);
  }
  return out.length > limit ? [...out.slice(0, limit), `and ${out.length - limit} more`] : out;
}

// The actions an answer's `do` names: { action, meeting }, meeting null when it names none.
const actionsOf = (list) => (Array.isArray(list) ? list : [])
  .filter((a) => typeof a?.action === "string")
  .map((a) => ({ action: a.action, meeting: typeof a.meeting === "string" ? a.meeting : null }));

// Penelope's final answer, the JSON object her prompt asks for; what she said as it is, when it is none.
export function parseSay(text) {
  const tail = (text ?? "").trim().replace(/```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  for (let at = tail.lastIndexOf("{"); at >= 0; at = at > 0 ? tail.lastIndexOf("{", at - 1) : -1) {
    try {
      const answer = JSON.parse(tail.slice(at));
      if (typeof answer?.say === "string") return { say: answer.say.trim(), mood: MOODS.includes(answer.mood) ? answer.mood : "glad", actions: actionsOf(answer.do) };
    } catch {
      // Not the answer's opening brace.
    }
  }
  return { say: tail || "…", mood: "glad", actions: [] };
}

// What Penelope is doing, from a tool_call record.
export function activityOf({ name, inputs = {} }) {
  const file = String(inputs.file_path ?? inputs.file ?? inputs.path ?? "");
  const which = file.includes("summary") ? "the summary" : "the transcript";
  switch (name) {
    case "rg":
      return `Looking for “${inputs.pattern ?? "…"}”`;
    case "rows_between":
      return `Reading lines ${inputs.start_line ?? "?"} to ${inputs.end_line ?? "?"} of ${which}`;
    case "cat":
    case "head":
    case "tail":
      return `Reading ${which}`;
    case "sed":
    case "apply_patch":
      return `Correcting ${name === "sed" ? which : "a few lines"}`;
    case "write_file":
      return `Rewriting ${which}`;
    default:
      return `Using ${name}`;
  }
}

// How the app works, in her words, leaving out the steps the user has done.
export function guideText({ provider, notebook }) {
  const steps = [
    !provider && "[**Connect an AI provider**](#provider-card) on the pad.",
    !notebook && "[**Sign in to slivingdoc**](#notebook-card) for your notebook.",
    "**New recording**: share your call's tab and start.",
    "**Stop and summarize**: I write it all up.",
    "Ask me anything here: the app, your meetings, or the one you have open.",
  ].filter(Boolean);
  return `Hi, I'm **Penelope**! I take your meeting minutes:\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
}

// The pen and her bubble, one conversation for the session: `ask(text)` → { say, mood, step, after }, `step`
// the proposals `undo(step)` takes back, `after()` what the app does once she has said it.
export class Penelope {
  constructor({ root, ask, undo, canUndo }) {
    this.root = root;
    this.ask = ask;
    this.undo = undo;
    this.canUndo = canUndo;
    this.$ = (id) => root.querySelector(`#${id}`);
    this.log = [];
    this.focus = null;
    this.asked = false;
    this.nextPounce = 0;
    this.follow();
    this.ideas = [];
    this.busy = false;
    this.doing = "";
    this.mood = "glad";
    this.tipped = false;
    this.$("penelope-pen").onclick = () => this.toggle(!this.isOpen);
    this.$("penelope-close").onclick = () => this.toggle(false);
    this.$("penelope-form").onsubmit = (e) => {
      e.preventDefault();
      this.send(this.$("penelope-input").value);
    };
    this.$("penelope-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send(e.target.value);
      } else if (e.key === "Escape") this.toggle(false);
    });
    this.$("penelope-input").addEventListener("input", (e) => this.fit(e.target));
  }

  // On the desk, early (arrival.js): she pops up from below the screen's edge, saying nothing yet.
  appear() {
    if (!this.root.hidden) return;
    this.root.hidden = false;
    this.root.classList.add("arriving");
    this.$("penelope-pen").addEventListener("animationend", () => this.root.classList.remove("arriving"), { once: true });
  }

  // Asleep while the agent she is still loads, as her Ask waits for it (loadbar.js); once awake she
  // gives the greeting she was asked for (arrive).
  doze(on) {
    if (on === this.root.classList.contains("dozing")) return;
    this.root.classList.toggle("dozing", on);
    if (on) return;
    if (!this.root.hidden) {
      this.root.classList.add("waking");
      setTimeout(() => this.root.classList.remove("waking"), 650);
    }
    this.greet();
  }

  // Once the app has arrived on the pad: she says `guide`, and opens her bubble a moment after she is awake.
  arrive(guide) {
    const said = { who: "her", text: guide };
    said.actions = [["Got it", () => {
      said.actions = null;
      this.toggle(false);
    }]];
    this.log.push(said);
    this.appear();
    this.greeting = true;
    this.greet();
  }

  greet() {
    if (!this.greeting || this.root.classList.contains("dozing")) return;
    this.greeting = false;
    setTimeout(() => !this.isOpen && this.toggle(true, false), 1400);
  }

  // The meeting in focus, its path or null, with `ideas` to offer.
  place(focus, ideas = []) {
    if (focus === this.focus && ideas.join("\n") === this.ideas.join("\n")) return;
    if (focus !== this.focus) this.asked = false;
    this.focus = focus;
    this.ideas = ideas;
    this.render();
  }

  get isOpen() {
    return this.root.classList.contains("open");
  }

  // The bubble grows out of her and shrinks back into her (pad.css .penelope-bubble.shown); it is
  // hidden only once it has shrunk, and a click while it shrinks opens it again.
  toggle(open, focus = true) {
    const bubble = this.$("penelope-bubble");
    const win = this.root.ownerDocument.defaultView;
    clearTimeout(this.closing);
    this.$("penelope-pen").setAttribute("aria-expanded", String(open));
    this.root.classList.toggle("open", open);
    this.root.ownerDocument.body.classList.toggle("penelope-open", open);
    if (open) {
      if (bubble.hidden) {
        bubble.hidden = false;
        void bubble.offsetWidth;
      }
      bubble.classList.add("shown");
      this.render();
      if (focus) this.$("penelope-input").focus();
    } else {
      bubble.classList.remove("shown");
      const calm = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      this.closing = setTimeout(() => (bubble.hidden = true), calm ? 0 : BUBBLE_OUT_MS);
    }
  }

  // Her eyes follow the pointer, and one that rests near her, not on her or her bubble, is now and then pounced on.
  follow() {
    const doc = this.root.ownerDocument;
    const win = doc.defaultView;
    const calm = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let at = null;
    let frame = 0;
    let rest = 0;
    const look = () => {
      frame = 0;
      clearTimeout(rest);
      if (this.root.hidden || !at) return;
      const eyes = this.root.querySelector(".penelope-eyes").getBoundingClientRect();
      const dx = at.x - (eyes.left + eyes.width / 2);
      const dy = at.y - (eyes.top + eyes.height / 2);
      const { x, y } = gaze(dx, dy);
      this.root.style.setProperty("--look-x", `${x.toFixed(2)}px`);
      this.root.style.setProperty("--look-y", `${y.toFixed(2)}px`);
      const d = Math.hypot(dx, dy);
      const onHer = doc.elementFromPoint(at.x, at.y)?.closest?.("#penelope-bubble, .penelope-pen");
      if (!calm && d > 50 && d < POUNCE_REACH && !onHer) rest = setTimeout(() => this.pounce(dx, dy), POUNCE_REST_MS);
    };
    doc.addEventListener("pointermove", (e) => {
      at = { x: e.clientX, y: e.clientY };
      frame ||= win.requestAnimationFrame(look);
    }, { passive: true });
  }

  // She jumps at the pointer `dx, dy` px from her eyes, mouth open, and chomps: one she reaches she chews
  // and gulps, and it is gone meanwhile; one out of her reach she snaps at, and misses.
  async pounce(dx, dy) {
    const body = this.root.ownerDocument.body;
    if (this.pouncing || this.busy || this.root.hidden || this.root.classList.contains("dozing") || Date.now() < this.nextPounce) return;
    this.nextPounce = Date.now() + POUNCE_EVERY_MS;
    this.pouncing = true;
    const mouth = this.$("penelope-mouth");
    const { x, y, turn, reached } = lunge(dx, dy);
    this.root.style.setProperty("--lunge-x", `${x.toFixed(1)}px`);
    this.root.style.setProperty("--lunge-y", `${y.toFixed(1)}px`);
    this.root.style.setProperty("--lunge-turn", `${turn.toFixed(1)}deg`);
    this.root.classList.add("pouncing");
    mouth.setAttribute("d", MOUTHS.open);
    mouth.setAttribute("fill", "#4a1a14");
    await sleep(420);
    if (reached) body.classList.add("pen-eaten");
    mouth.setAttribute("d", MOUTHS.chomp);
    mouth.setAttribute("fill", "none");
    await sleep(530);
    this.root.classList.remove("pouncing");
    if (reached) {
      this.root.classList.add("chewing");
      for (let bite = 0; bite < CHEWS; bite++) {
        mouth.setAttribute("d", bite % 2 ? MOUTHS.munch : MOUTHS.full);
        mouth.setAttribute("fill", bite % 2 ? "none" : "#4a1a14");
        await sleep(CHEW_MS);
      }
      this.root.classList.remove("chewing");
      mouth.setAttribute("d", MOUTHS.gulp);
      mouth.setAttribute("fill", "#4a1a14");
      await sleep(220);
      mouth.setAttribute("fill", "none");
    }
    this.render();
    await sleep(350);
    body.classList.remove("pen-eaten");
    this.pouncing = false;
  }

  // Once a session: Penelope leans out and offers to look for the rest, as a certain paperclip would.
  tip(text, request) {
    if (this.tipped || this.busy || this.isOpen) return;
    this.tipped = true;
    this.log.push({ who: "her", text, actions: [["Yes, have a look", () => this.send(request)], ["No thanks", () => this.toggle(false)]] });
    this.toggle(true);
  }

  // Says `text` in the bubble, opening it.
  nudge(text) {
    this.log.push({ who: "her", text, mood: "unsure" });
    this.toggle(true);
  }

  async send(text) {
    const request = text.trim();
    if (!request || this.busy) return;
    this.$("penelope-input").value = "";
    this.fit(this.$("penelope-input"));
    this.asked = true;
    const log = this.log;
    for (const item of log) item.actions = null;
    log.push({ who: "you", text: request });
    this.working(true);
    try {
      const { say, mood, step, after } = await this.ask(request);
      log.push({ who: "her", text: say, mood, step });
      this.mood = mood;
      this.working(false);
      after?.();
    } catch (error) {
      log.push({ who: "her", text: `My ink ran out: ${error.message}`, mood: "sorry" });
      this.mood = "sorry";
      this.working(false);
    }
  }

  working(on, doing = "") {
    this.busy = on;
    this.doing = on ? doing || "Thinking" : "";
    this.render();
  }

  activity(record) {
    if (!this.busy || record.type !== "tool_call") return;
    this.doing = activityOf(record);
    this.render();
  }

  // As tall as what is typed, up to a few lines; it scrolls only past those.
  fit(area) {
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 128)}px`;
    area.style.overflowY = area.scrollHeight > 128 ? "auto" : "hidden";
  }

  render() {
    const doc = this.root.ownerDocument;
    this.root.classList.toggle("busy", this.busy);
    for (const mood of MOODS) this.root.classList.toggle(`mood-${mood}`, !this.busy && this.mood === mood);
    this.$("penelope-mouth").setAttribute("d", MOUTHS[this.busy ? "busy" : this.mood]);
    this.$("penelope-ask").disabled = this.busy;
    const doing = this.$("penelope-doing");
    doing.hidden = !this.busy;
    doing.textContent = this.doing;
    if (!this.isOpen) return;
    const items = this.log.map((item) => {
      const li = doc.createElement("li");
      li.className = item.who === "you" ? "penelope-you" : "penelope-her";
      if (item.who === "you") li.textContent = item.text;
      else li.innerHTML = renderMarkdown(item.text);
      if (item.step?.count) {
        const row = doc.createElement("p");
        row.className = "penelope-step";
        const n = item.step.count;
        row.append(`${n} ${n === 1 ? "line" : "lines"} in pen. `);
        const back = doc.createElement("button");
        back.type = "button";
        back.className = "penelope-link";
        back.textContent = "Undo these";
        back.disabled = !this.canUndo(item.step);
        back.onclick = () => {
          this.undo(item.step);
          this.render();
        };
        row.append(back);
        li.append(row);
      }
      if (item.actions) {
        const row = doc.createElement("p");
        row.className = "penelope-actions";
        for (const [label, act] of item.actions) {
          const b = doc.createElement("button");
          b.type = "button";
          b.className = "penelope-link";
          b.textContent = label;
          b.onclick = act;
          row.append(b);
        }
        li.append(row);
      }
      return li;
    });
    const list = this.$("penelope-log");
    list.replaceChildren(...items);
    list.scrollTop = list.scrollHeight;
    const ideas = this.$("penelope-ideas");
    ideas.hidden = this.busy || this.asked;
    ideas.replaceChildren(...this.ideas.map((idea) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "penelope-link";
      b.textContent = idea;
      b.onclick = () => this.send(idea);
      return b;
    }));
  }
}
