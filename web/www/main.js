// The page: Minutes, and below it, when opened, a peek under the hood of the machine it runs
// on. The machine runs in a Web Worker (worker.js); its console is the peek's terminal, which
// shows what the app's programs print and takes lines of its own.
import { Terminal } from "./node_modules/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "./node_modules/@xterm/addon-fit/lib/addon-fit.mjs";
import { LineEditor, split, isShellLine } from "./shell.js";
import { AudioInputs, platformOf, withOsVersion } from "./audio.js";
import { HoodView, Machine } from "./hood.js";
import { Minutes } from "./minutes.js";
import { Doodles } from "./doodles.js";
import { Sketch } from "./sketch.js";
import { Recordings } from "./recordings.js";
import { VoiceKeeper } from "./voicekeeper.js";
import { SegmentKeeper } from "./segmentkeeper.js";
import { People } from "./people.js";
import { Review } from "./review.js";
import { RunLog } from "./runlog.js";
import { LoadBar } from "./loadbar.js";
import { Pointer } from "./pointer.js";
import { Downloads } from "./downloads.js";
import { NotebookKeeper } from "./notebookkeeper.js";
import { watchForUpdates } from "./update.js";
import { isReady, pending } from "./loadplan.js";

// No convertEol: clai's output comes through the machine's terminal, which turns "\n" into
// "\r\n" itself unless the program asked for raw output.
const term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 10_000 });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.querySelector("#terminal"));
fit.fit();
addEventListener("resize", () => {
  fit.fit();
  window.minutes?.placeNotes();
});

const hood = document.querySelector("#hood");
const peekButton = document.querySelector("#peek");
const peek = (open) => {
  hood.classList.toggle("open", open);
  peekButton.setAttribute("aria-expanded", String(open));
  peekButton.lastChild.textContent = open ? " Hide the machine" : " Peek under the hood";
  if (open) fit.fit();
};
peekButton.onclick = () => peek(!hood.classList.contains("open"));
document.querySelector("#peek-close").onclick = () => peek(false);

const tabs = document.querySelectorAll("[role=tab]");
const showTab = (name) => {
  peek(true);
  for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.classList.toggle("active", panel.dataset.panel === name);
  }
  if (name === "terminal") {
    fit.fit();
    term.focus();
  }
  if (name === "runlogs") minutes?.renderLogs();
};
for (const tab of tabs) tab.onclick = () => showTab(tab.dataset.tab);
window.showTab = showTab;

const model = new Machine();
const view = new HoodView(model, hood);
window.hoodModel = model;

term.writeln("Booting a WASIX v2 machine…");
// index.html started the worker, and kept what it said while this module loaded.
const worker = window.machineWorker ?? new Worker("./worker.js", { type: "module" });
const size = () => ({ rows: term.rows, cols: term.cols });
worker.postMessage({ size: size() });
// The app is built at once: what it runs waits for the boot, and then for its programs.
let bash = true;
let home = "/";
let up = null;
const booted = new Promise((resolve) => (up = resolve));
// The worker's report of its files (loadplan.js), and the bar that shows it.
let loading = null;
const loadbar = new LoadBar(document, () => worker.postMessage({ retry: true }));
// What resolves each run under way, by its id.
const finishing = new Map();
let runs = 0;
let minutes = null;
// What `download FILE` sends from the machine, saved as the browser's downloads.
const downloads = new Downloads();
// The action of the app's line that has the console, whose printed lines its run log takes.
let onConsole = null;
// The loudest of each input's latest samples, for the waveform.
const peaks = new Map();
const audio = new AudioInputs({
  send: (name, bytes) => {
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    peaks.set(name, peak / 32768);
    if (name === "mic" || !audio.inputs().some((i) => i.name === "mic")) minutes?.level(Math.min(1, Math.max(...peaks.values()) * 1.6));
    worker.postMessage({ samples: { name, bytes } }, [bytes.buffer]);
  },
  notice: (text) => {
    term.write(`\r\n\x1b[33m${text}\x1b[0m\r\n`);
    minutes?.status(text);
  },
  changed: () => minutes?.render(),
  // /run/audio/devices follows what the page can record: a share, once made, is a sink.
  relist: () => booted.then(() => worker.postMessage({ devices: audio.listing() })),
});
// What `play` (audio/play.sh) wrote to /run/audio/play, in a player until it is closed.
const play = (bytes) => {
  const url = URL.createObjectURL(new Blob([bytes]));
  const player = document.createElement("div");
  player.className = "player";
  const element = new Audio(url);
  element.controls = true;
  const close = document.createElement("button");
  close.textContent = "✕";
  close.title = "Close";
  close.onclick = () => {
    element.pause();
    URL.revokeObjectURL(url);
    player.remove();
  };
  player.append(element, close);
  document.querySelector(".players").append(player);
  element.play().catch(() => {});
};
worker.onerror = (event) => {
  term.writeln(`\x1b[31mworker failed: ${event.message}\x1b[0m`);
  loadbar.show({ stopped: `The machine's worker failed: ${event.message}. Reload to try again.` });
};
// A line from the worker, above the prompt when the terminal waits at one.
let editor = null;
const say = (text) => term.write(editor && !editor.busy ? `\r\x1b[2K${text}\r\n${editor.prompt}${editor.line}` : `${text}\r\n`);
const heard = ({ data }) => {
  if (data.log) say(data.log);
  if (data.load) {
    loading = data.load;
    loadbar.show({ files: loading });
    const left = pending(loading).join(" ");
    if (left !== document.body.dataset.loading) {
      document.body.dataset.loading = left;
      minutes?.render();
    }
  }
  if (data.waiting) {
    loadbar.show({ waiting: data.waiting });
    if (data.waiting.length) say(`\x1b[2mWaiting for ${data.waiting.join(", ")} to load…\x1b[0m`);
  }
  if (data.ready) {
    ({ bash, home } = data);
    cwd = home;
    say(bash
      ? "Ready. Try \x1b[1mls /bin\x1b[0m, \x1b[1mclai h\x1b[0m, or \x1b[1mhelp\x1b[0m."
      : "Ready, without bash: run \x1b[1mmake packages\x1b[0m for it. Try \x1b[1mclai help\x1b[0m.");
    document.querySelector("#machine-chip").textContent = "wasmer.sh · WASIX v2 kernel: running";
    term.onResize(() => worker.postMessage({ size: size() }));
    up();
  }
  if (data.output) {
    term.write(data.output);
    if (onConsole) minutes?.printed(onConsole, data.output);
  }
  if (data.events) model.add(JSON.parse(data.events));
  if (data.outbox) for (const message of data.outbox) if (!downloads.receive(message)) minutes?.receive(message);
  if (data.audio) audio.want(data.audio);
  if (data.play) play(data.play);
  if (data.error) say(`\x1b[31m${data.error}\x1b[0m`);
  if (data.stopped) loadbar.show({ stopped: data.error });
  if ("status" in data) {
    // As bash does, the prompt goes on a new line after ^C killed the program.
    if (data.status === 128 + 2) term.write("\r\n");
    finishing.get(data.id)?.(data.status);
    finishing.delete(data.id);
  }
};

// Runs `args` from `path`, with `env` and `extra` (variables for this run only), resolving to
// its exit status and streaming what it prints. A `detached` run is a service: it is not on
// the console, so nothing typed there, nor its ^C or hangup, reaches it.
const env = new Map();
const exec = (path, args, extra = {}, detached = false) => booted.then(() => new Promise((resolve) => {
  const id = ++runs;
  finishing.set(id, resolve);
  const vars = [...env, ...Object.entries(extra)];
  worker.postMessage({ path, args, id, detached, env: vars.map(([key, value]) => `${key}=${value}`) });
}));

// Each line is a new `bash -c` in the page's working directory, so `cd` and `export` are
// the page's. Its $0 says who asked for it, which the under-the-hood view follows.
let cwd = home;
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const resolvePath = (target) => {
  const path = target.startsWith("/") ? target : target === "~" || target.startsWith("~/")
    ? home + target.slice(1) : `${cwd}/${target}`;
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
};

const builtins = {
  help: () => term.writeln(
    (bash ? "<line>              run the line with bash; /bin has coreutils, grep, rg, ffmpeg…\r\n"
      : "clai <args>         run clai on the WASIX v2 machine\r\n") +
    "cd DIR              change the directory the next lines start in\r\n" +
    "export KEY=VALUE    set a variable for every program, such as OPENAI_API_KEY\r\n" +
    (bash ? "play FILE           play a sound file, such as a recording, in the page\r\n" +
      "download FILE       save a file of the machine in this browser's downloads\r\n" : "") +
    "clear               clear the screen"),
  clear: () => term.clear(),
  export: (...assignments) => {
    for (const assignment of assignments) {
      const at = assignment.indexOf("=");
      if (at > 0) env.set(assignment.slice(0, at), assignment.slice(at + 1));
      else term.writeln(`export: want KEY=VALUE, got ${assignment}`);
    }
    return 0;
  },
  cd: async (target = "~") => {
    const dir = resolvePath(target);
    const status = bash ? await exec("/bin/bash", ["bash", "-c", 'cd -- "$1"', "cd", dir]) : 0;
    if (status === 0) cwd = dir;
    return status;
  },
};

// `positional` are the line's $1, $2…, which keep newlines and are not inherited.
async function run(line, tag = "terminal", extra = {}, positional = [], detached = false) {
  const args = split(line);
  if (args.length === 0) return 0;
  if (!isReady(loading, "machine") && tag === "terminal") term.writeln("\x1b[2mWaiting for the machine to boot…\x1b[0m");
  await booted;
  if (builtins[args[0]] && !isShellLine(line)) return (await builtins[args[0]](...args.slice(1))) ?? 0;
  if (bash) return exec("/bin/bash", ["bash", "-c", `cd -- ${quote(cwd)} || exit\n${line}`, tag, ...positional], extra, detached);
  return exec(args[0].includes("/") ? args[0] : `/bin/${args[0]}`, args, {}, detached);
}

// While a program runs, what is typed goes to the machine's terminal as it is. Only the
// terminal's lines and the app's own lines (machine.run) are on the console; the app's
// background runs are not, so nothing typed there is theirs.
const encoder = new TextEncoder();
const type = (data) => booted.then(() => worker.postMessage({ input: encoder.encode(data) }));
editor = new LineEditor(term, "$ ", run, type);
worker.onmessage = heard;
for (const data of window.machineSaid?.splice(0) ?? []) heard({ data });
// The screen's text, with the lines the terminal wrapped joined again.
window.terminalSelection = () => term.getSelection();
window.terminalText = () => {
  const buffer = term.buffer.active;
  let text = "";
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    const continued = buffer.getLine(i + 1)?.isWrapped ?? false;
    text += (i > 0 && !line.isWrapped ? "\n" : "") + line.translateToString(!continued);
  }
  return text;
};

// What the app runs and lines from scripts take turns with what is typed: one runs at a time,
// as the console has one foreground program. The app's do not go through the line editor; the
// terminal notes them, as the console shows what they print.
let queue = Promise.resolve();
const serially = (task) => {
  const next = queue.then(async () => {
    while (editor.busy) await new Promise((r) => setTimeout(r, 100));
    return task();
  });
  queue = next.catch(() => {});
  return next;
};
window.runCommand = (line) => serially(() => editor.submit(line));
// Writes a file in the machine for what the page has in hand and no program does (a program's
// source it is about to build, say). bash writes it, so its directory is the machine's.
window.writeFile = (path, text) => serially(() => exec(
  "/bin/bash",
  ["bash", "-c", 'd=${1%/*}; [ "$d" = "$1" ] && d=.; mkdir -p "$d" && printf %s "$2" > "$1"', "write", path, text],
));
const note = (verb, line) => `\r\x1b[2K\x1b[2m# Penelope ${verb}: ${line.replaceAll("\n", "; ")}\x1b[0m\r\n`;
const machine = {
  // `started()` is called as the line starts, after the lines queued before it.
  run: (line, action, extra, positional, started) => serially(async () => {
    editor.busy = true;
    term.write(note("ran", line));
    started?.();
    onConsole = action;
    try {
      return await run(line, action, extra, positional);
    } finally {
      onConsole = null;
      editor.busy = false;
      term.write(editor.prompt + editor.line);
    }
  }),
  // Runs the line beside the others, detached from the console: the terminal stays free, and
  // the line reads /dev/null, not what is typed there.
  spawn: (line, action, extra, positional) => {
    term.write(note("started", line) + (editor.busy ? "" : editor.prompt + editor.line));
    return run(`exec </dev/null\n${line}`, action, extra, positional, true);
  },
  // Creates the file at `path` in the machine at once, from a detached run, whatever the
  // terminal runs: how Stop reaches the recording it belongs to.
  touch: (path, action = "touch") => exec("/bin/bash", ["bash", "-c", ': > "$1"', action, path], {}, true),
  booted,
  // Whether everything a stage of the load plan needs is on the machine (loadplan.js).
  has: (stage) => isReady(loading, stage),
};
// The voice library and the meetings' segments kept in this browser, New recording's people row and
// "Who is speaking?": they reach Minutes' runs, list and player through `minutes`, made just below.
const voices = new VoiceKeeper({ run: (...args) => minutes.run(...args), indexedDB: globalThis.indexedDB });
const people = new People({
  root: document.querySelector("#people"),
  people: () => voices.people(),
  meetings: () => minutes?.meetings ?? [],
  read: (path) => minutes.readMeeting(path, "Read the last meeting of that name", true),
});
// Transcribe again's row: ticked for whom the meeting named, so it reads no meeting.
const againPeople = new People({
  root: document.querySelector("#again-people"),
  people: () => voices.people(),
  meetings: () => [],
  read: async () => null,
});
const review = new Review({
  root: document.querySelector("#speakers"),
  play: (start, end, button) => minutes.proof.playSpan(start, end, button),
  choose: (choices, names) => minutes.choose(choices, names),
});
minutes = new Minutes({
  root: document.querySelector("#app"),
  machine,
  hood: view,
  model,
  env,
  audio,
  // Storage can be off (a private window, blocked site data): the login then lasts the tab.
  store: {
    get: (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Kept for this tab only.
      }
    },
    remove: (key) => {
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing was kept to forget.
      }
    },
  },
  recordings: new Recordings(globalThis.indexedDB),
  notebook: new NotebookKeeper(globalThis.indexedDB),
  voices,
  segments: new SegmentKeeper(globalThis.indexedDB),
  people,
  againPeople,
  pointer: new Pointer(document),
  review,
  runlog: new RunLog({ indexedDB: globalThis.indexedDB, secrets: () => minutes?.secrets() ?? [] }),
  // A note about a failure points at the peek and opens its terminal.
  peek: showTab,
  anchor: peekButton,
  terminal: {
    write: (text) => term.write(text),
    // Writes `text` and returns markers of its first line and of the line after it. Writes are
    // queued, so the markers are set once the terminal has taken what came before.
    mark: (text) => {
      const span = { start: null, end: null };
      term.write("", () => { span.start = term.registerMarker(0); });
      term.write(text, () => { span.end = term.registerMarker(0); });
      return span;
    },
    reveal: ({ start, end }) => {
      if (!start || start.isDisposed) return;
      const last = Math.max(start.line, (end && !end.isDisposed ? end.line : start.line + 1) - 1);
      term.scrollToLine(Math.max(0, start.line - 2));
      term.selectLines(start.line, last);
    },
  },
  config: window.minutesConfig ?? {},
  platform: platformOf(navigator),
});
minutes.start();
// What the audio note says depends on the macOS version, which Chromium tells when asked.
withOsVersion(minutes.platform, navigator).then((platform) => { minutes.platform = platform; });
new Doodles(document, model).start();
new Sketch(document).start();
window.minutes = minutes;
// A newer deploy of the site is offered as a reload, once nothing under way would stop.
watchForUpdates({ win: window, doc: document, busy: () => minutes.working() });

// The microphone is asked for up front, so that the browser names its audio inputs; ffmpeg in
// the machine then lists them all, and the agent picks which to record (audio/ffmpeg.sh).
const findDevices = async () => {
  await audio.discover();
  audio.relist();
  minutes.render();
};
navigator.mediaDevices?.addEventListener("devicechange", () => findDevices());
await findDevices();
await booted;

if (bash) document.body.dataset.bash = "true";
document.body.dataset.ready = "true";
