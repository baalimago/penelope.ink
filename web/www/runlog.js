// What each job did, as text: bounded, with no model output and with every secret taken out
// (worklogs/2026-11-19-penelope-failure-reports, phase 2).

/** The IndexedDB database of the kept logs. No other module opens it. */
export const RUNLOGS_DB = "minutes-runlogs";

/** The README's parameters. Lengths are in characters (Local facts). */
export const CAPS = { entry: 8192, log: 2 * 1024 * 1024, argument: 200, causeLines: 5, kept: 10 };

/**
 * What identifies a run. Every field but `started`, `kind` and `meeting` is free text; a field
 * left out shows as "unknown". The log keeps the object given, so a field its caller learns
 * later (clai's version) shows once it is set.
 *
 * @typedef {object} Head
 * @property {number} started   ms since the epoch
 * @property {string} kind      the job kind: "Record", "Answer", "Try again", "Transcribe again", "Ask Penelope"
 * @property {string} meeting   the meeting's title, "" when the job has none
 * @property {string} [build]   the page build
 * @property {string} [clai]    clai's version
 * @property {string} [profile] the profile ref and sha256
 * @property {string} [provider] the provider and model
 * @property {string} [browser] the browser and OS
 */

/**
 * What a caller adds under an action.
 *
 * @typedef {{kind: "printed", text: string}                       // what the console printed, in pieces
 *   | {kind: "record", record: object}                            // one clai -json record
 *   | {kind: "stray", text: string}                               // a line of clai's that is no record
 *   | {kind: "body", topic: string, length: number}               // a body read through /run/page/out
 *   | {kind: "process", event: string, text: string, argv?: string[], pid?: number}} Entry  // a hood event
 */

/**
 * @typedef {object} Cause
 * @property {string} label          the command's label ("Save to slivingdoc")
 * @property {number|null} status    its exit status, null while it runs
 * @property {string[]} lines        its last CAPS.causeLines lines on stderr, secrets out
 */

/**
 * @typedef {object} Row
 * @property {string} job
 * @property {number} started
 * @property {string} kind
 * @property {string} meeting
 * @property {"running"|"clean"|"failed"} state
 * @property {string} failed         the first error note's title, "" unless state is "failed"
 * @property {number} size           characters of its entries
 * @property {boolean} earlier       kept by an earlier session
 */

const STORE = "logs";
const ORPHANS = 50;
// A diagnostic at these levels may dump a conversation: add.3.
const QUIET = new Set(["debug", "trace"]);
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

const chars = (n) => `‹${n} chars›`;
const oneLine = (text) => String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", "\\n");
const written = (value) => (typeof value === "string" ? value : JSON.stringify(value) ?? String(value));
const capped = (value) => {
  const text = written(value);
  return text.length <= CAPS.argument ? text : chars(text.length);
};
const stamp = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `+${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;
};
const slug = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");

/** `penelope-<start>_<slug>-<job kind>.log`: <start> as a notebook file's, 2026-10-30T08-00Z. */
export function logName(row) {
  const at = new Date(row?.started ?? NaN);
  const start = Number.isNaN(at.getTime()) ? "undated" : `${at.toISOString().slice(0, 16).replace(":", "-")}Z`;
  return `penelope-${start}_${[slug(row?.meeting), slug(row?.kind) || "run"].filter(Boolean).join("-")}.log`;
}

function redact(text, secrets) {
  const forms = [];
  for (const [name, value] of secrets) {
    if (typeof value !== "string" || value.length < 6) continue;
    for (const form of new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])) forms.push([form, name]);
  }
  forms.sort((a, b) => b[0].length - a[0].length);
  for (const [form, name] of forms) text = text.replaceAll(form, `‹secret: ${name}›`);
  return text
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?!‹secret)(?:(?!\\n)[^"'\n])+/gi, "$1‹secret: Authorization›")
    .replace(/\b(bearer\s+)(?!‹secret)[\w.~+/=-]+/gi, "$1‹secret: Bearer›");
}

function recordText(r) {
  switch (r.type) {
    case "diagnostic": {
      const facts = Object.entries(r.facts ?? {}).map(([key, value]) => `${key}=${written(value)}`).join(" ");
      const message = String(r.message ?? "");
      const first = message.split("\n")[0];
      const said = QUIET.has(r.level) && first.length < message.length ? `${first} ‹+${message.length - first.length} chars›` : message;
      return `diagnostic ${r.level} [${r.subsystem}] ${said}${facts ? ` · ${facts}` : ""}`;
    }
    case "error": {
      const causes = r.causes?.length ? r.causes : [{ message: r.message }];
      return `error ${causes.map((c) => [c.message ?? "", c.status && `status ${c.status}`, c.provider_code,
        ...(c.remedies ?? []).map((remedy) => `hint: ${remedy}`)].filter(Boolean).join(" · ")).join(" | ")}`;
    }
    case "progress":
      return ["progress", r.title, r.row, r.state, r.detail].filter(Boolean).join(" ");
    case "chat":
      return `chat ${r.id}`;
    case "prompt":
      return `prompt ${r.text ?? ""}${r.choices?.length ? ` [${r.choices.join(" / ")}]` : ""}`;
    case "child_output":
      return `child_output ${r.source ?? "child"}: ${r.text ?? ""}`;
    case "output":
      return r.stream === "stderr" ? `output stderr: ${r.text ?? ""}` : `output ${r.stream ?? "stdout"} ${chars((r.text ?? "").length)}`;
    case "reply":
      return `reply ${chars((r.text ?? "").length)}`;
    case "tool_call":
      return ["tool_call", r.name, ...Object.entries(r.inputs ?? {}).map(([key, value]) => `${key}=${capped(value)}`)].join(" ");
    case "tool_result":
      return r.ok === false
        ? `tool_result ${r.name} failed: ${r.error || String(r.output ?? "").split("\n").find((line) => line.trim()) || ""}`
        : `tool_result ${r.name} ok ${chars(String(r.output ?? "").length)}`;
    default:
      return `${r.type} ${chars(JSON.stringify(r).length)}`;
  }
}

// What a record says on stderr, for a cause.
function recordSaid(r) {
  if (r.type === "error") return (r.causes?.length ? r.causes : [r]).map((c) => c.message ?? "");
  if (r.type === "output" && r.stream === "stderr") return [r.text ?? ""];
  return [];
}

function execText(e) {
  const argv = e.argv ?? [];
  const shell = argv[0] === "bash" && argv[1] === "-c";
  const shown = argv.map((arg, i) => (i === 0 || (shell && i <= 3) ? String(arg) : capped(String(arg))));
  return `exec pid ${e.pid ?? "?"} ${shown.join(" ")}`;
}

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function openDb(indexedDB) {
  return new Promise((resolve) => {
    if (!indexedDB) return resolve(null);
    try {
      const request = indexedDB.open(RUNLOGS_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "job" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * The run logs of this browser.
 *
 * - RunLog.1 — No member throws or rejects, whatever it is given and whatever `secrets` and
 *   `indexedDB` do: the outcome of a call is its result. (E4)
 * - RunLog.2 — No member writes localStorage, the notebook, the machine or the network, and
 *   none puts up a note. (E4, E6)
 */
export class RunLog {
  #indexedDB;
  #secrets;
  #now;
  #logs = new Map();
  #actions = new Map();
  #orphans = [];

  /**
   * @param {object} deps
   * @param {IDBFactory|undefined} deps.indexedDB
   * @param {() => Array<[string, string]>} [deps.secrets]  the secrets the page holds now, [name, value]
   * @param {() => number} [deps.now]
   */
  constructor({ indexedDB, secrets = () => [], now = () => Date.now() } = {}) {
    this.#indexedDB = indexedDB;
    this.#secrets = secrets;
    this.#now = now;
    /** Resolves once the logs earlier sessions kept are listed. Never rejects. */
    this.ready = this.#load().catch(() => {});
  }

  async #load() {
    const db = await openDb(this.#indexedDB);
    if (!db) return;
    try {
      const rows = await done(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
      for (const row of rows) {
        if (typeof row?.job !== "string" || typeof row.text !== "string" || this.#logs.has(row.job)) continue;
        this.#logs.set(row.job, {
          head: { started: row.started, kind: row.kind, meeting: row.meeting }, entries: null, text: row.text, size: row.size,
          closed: true, failed: row.state === "failed", title: row.failed ?? "", earlier: true,
        });
      }
    } finally {
      db.close();
    }
  }

  /**
   * Starts job `job`'s log.
   *
   * - open.1 — `text(job)` then starts with the head: started, the page build, clai's version,
   *   the profile, the provider and model, the browser and OS, the job kind and the meeting. (E2)
   * - open.2 — A job opened already keeps its log; the call does nothing.
   *
   * @param {string} job   unique in this browser
   * @param {Head} head
   */
  open(job, head) {
    try {
      if (typeof job !== "string" || this.#logs.has(job)) return;
      const given = head && typeof head === "object" ? head : {};
      if (!Number.isFinite(given.started)) given.started = this.#now();
      this.#logs.set(job, { head: given, entries: [], text: null, size: 0, cut: 0, closed: false, failed: false, title: "", earlier: false, ended: null });
    } catch {
      // E4
    }
  }

  /**
   * A command of `job` starts under `action`.
   *
   * - attach.1 — The log gets an entry with the label and the line as run. (E2)
   * - attach.2 — Each of `args`, the line's positional arguments, shows whole when it is no
   *   longer than CAPS.argument and as its length otherwise. (E5)
   * - attach.3 — With `job` null the command belongs to no log: `cause(action)` still answers
   *   for it, and `add` under it keeps only what `cause` needs.
   *
   * @param {string|null} job
   * @param {string} action   `minutes:<label>#<n>`
   * @param {string} label
   * @param {string} line
   * @param {string[]} [args]
   */
  attach(job, action, label, line, args = []) {
    try {
      const log = this.#logs.get(job);
      const mine = log && !log.closed ? job : null;
      this.#actions.set(action, { job: mine, label: String(label), status: null, said: [], partial: "", stream: null });
      if (!mine) {
        this.#orphans.push(action);
        if (this.#orphans.length > ORPHANS) this.#actions.delete(this.#orphans.shift());
        return;
      }
      const given = (args ?? []).map((arg, i) => ` $${i + 1}=${capped(String(arg))}`).join("");
      this.#push(log, action, `run ${label}: ${oneLine(line)}${given}`);
    } catch {
      // E4
    }
  }

  /**
   * Adds what happened under `action` to its job's log, stamped with `now()`.
   *
   * - add.1 — Entries show in `text` in the order they were added. (E2)
   * - add.2 — printed: each whole line is an entry, without ANSI sequences; a piece without its
   *   line end waits for the rest, and `ended` flushes it. (E2)
   * - add.3 — record, by `type`: `diagnostic` keeps its level, subsystem, message and facts,
   *   but at level `debug` or `trace` only the first line of its message, then the length of
   *   the rest: clai dumps conversations and tool calls there (E8);
   *   `error` its message, and each cause's status, provider code and remedies; `progress` its
   *   title, row, state and detail; `chat` its id; `prompt` its text; `child_output` its source
   *   and text; `output` on stderr its text. (E2)
   * - add.4 — record: `reply` shows as its kind and length. `reply_delta` and
   *   `reasoning_delta` each show as one entry with their count and total length, a new one
   *   after a record of another kind. `output` on stdout and a record of a type not named here
   *   show as their type and length. No character of their text is in `text`. (E8)
   * - add.5 — record: `tool_call` keeps its name, and each input no longer than CAPS.argument;
   *   a longer one shows as its length. `tool_result` that succeeded shows `ok` and the length
   *   of its output; one that failed keeps its error text. (E8)
   * - add.6 — body: shows as its topic and length. (E8)
   * - add.7 — process: `exec` with `argv` shows the program and each argument after it no
   *   longer than CAPS.argument, a longer one as its length; of `bash -c <script> <tag> <args>`
   *   the script shows whole. Any other event shows its `text`. (E2, E5)
   * - add.8 — An entry longer than CAPS.entry is cut there, with a marker giving its full
   *   length. (E5)
   * - add.9 — A log over CAPS.log drops its oldest entries until it fits and `text` says, after
   *   the head, how many it cut. The head is never cut. (E5)
   * - add.10 — An action that is not attached, or whose job is closed, adds nothing.
   *
   * @param {string} action
   * @param {Entry} entry
   */
  add(action, entry) {
    try {
      const a = this.#actions.get(action);
      if (!a || !entry) return;
      const log = a.job === null ? null : this.#logs.get(a.job);
      if (a.job !== null && (!log || log.closed)) return;
      const say = (lines) => {
        a.said.push(...lines.filter((line) => line.trim()).map(oneLine));
        if (a.said.length > CAPS.causeLines) a.said.splice(0, a.said.length - CAPS.causeLines);
      };
      const push = (text) => log && this.#push(log, action, text);
      switch (entry.kind) {
        case "printed": {
          const lines = (a.partial + String(entry.text ?? "")).replace(ANSI, "").replaceAll("\r\n", "\n").split(/[\n\r]/);
          a.partial = lines.pop();
          for (const line of lines.filter((l) => l.trim())) {
            say([line]);
            push(`out ${line}`);
          }
          return;
        }
        case "record": {
          const r = entry.record;
          if (!r || typeof r !== "object") return;
          if (r.type === "reply_delta" || r.type === "reasoning_delta") {
            if (!log) return;
            const length = String(r.text ?? "").length;
            if (a.stream?.type === r.type && !a.stream.entry.dropped) {
              a.stream.count += 1;
              a.stream.chars += length;
              this.#rewrite(log, a.stream.entry, `clai ${r.type} ×${a.stream.count} ${chars(a.stream.chars)}`);
            } else {
              a.stream = { type: r.type, count: 1, chars: length, entry: this.#push(log, action, `clai ${r.type} ×1 ${chars(length)}`) };
            }
            return;
          }
          a.stream = null;
          say(recordSaid(r));
          push(`clai ${oneLine(recordText(r))}`);
          return;
        }
        case "stray":
          a.stream = null;
          say([String(entry.text ?? "")]);
          push(`clai stray: ${oneLine(entry.text)}`);
          return;
        case "body":
          push(`page ${oneLine(entry.topic)} ${chars(Number(entry.length) || 0)}`);
          return;
        case "process":
          push(`proc ${entry.event === "exec" && entry.argv ? oneLine(execText(entry)) : `${entry.event ?? ""} ${oneLine(entry.text)}`}`);
          return;
        default:
      }
    } catch {
      // E4
    }
  }

  #push(log, action, text) {
    const tag = String(action).replace(/^minutes:/, "");
    const body = text.length > CAPS.entry ? `${text.slice(0, CAPS.entry)}… ‹cut: ${text.length} chars in all›` : text;
    const lead = `${stamp(this.#now() - log.head.started)} ${tag} │ `;
    const entry = { lead, line: lead + body, dropped: false };
    log.entries.push(entry);
    log.size += entry.line.length + 1;
    while (log.size > CAPS.log && log.entries.length > 1) {
      const old = log.entries.shift();
      old.dropped = true;
      log.size -= old.line.length + 1;
      log.cut += 1;
    }
    return entry;
  }

  #rewrite(log, entry, text) {
    log.size -= entry.line.length;
    entry.line = entry.lead + text;
    log.size += entry.line.length;
  }

  /**
   * The command under `action` ended.
   *
   * - ended.1 — The log gets an entry with its exit status. (E2)
   *
   * @param {string} action
   * @param {number} status
   */
  ended(action, status) {
    try {
      const a = this.#actions.get(action);
      if (!a) return;
      if (a.partial) this.add(action, { kind: "printed", text: "\n" });
      a.status = status;
      const log = this.#logs.get(a.job);
      if (log && !log.closed) this.#push(log, action, `end ${a.label}: exit ${status}`);
    } catch {
      // E4
    }
  }

  /**
   * `job` raised a note.
   *
   * - noted.1 — The log gets an entry with the note's level, title, detail, hint and code. (E2)
   * - noted.2 — The first note of level "error" makes the job a failed run; its title is the
   *   row's `failed`.
   *
   * @param {string} job
   * @param {{level: string, title: string, detail?: string, hint?: string|null, code?: string|null}} note
   */
  noted(job, note) {
    try {
      const log = this.#logs.get(job);
      if (!log || log.closed || !note) return;
      if (note.level === "error" && !log.failed) {
        log.failed = true;
        log.title = String(note.title ?? "");
      }
      this.#push(log, "note", oneLine([`${note.level}: ${note.title}`, note.detail, note.hint && `hint: ${note.hint}`, note.code].filter(Boolean).join(" · ")));
    } catch {
      // E4
    }
  }

  /**
   * Why the command under `action` failed.
   *
   * - cause.1 — The label it was attached with, the status `ended` gave, and the last
   *   CAPS.causeLines of its lines on stderr: its printed lines, its stray lines, the messages
   *   of its `error` records and its `output` on stderr. (E3)
   * - cause.2 — The lines hold no secret. (E1)
   * - cause.3 — null for an action never attached.
   *
   * @param {string} action
   * @returns {Cause|null}
   */
  cause(action) {
    try {
      const a = this.#actions.get(action);
      if (!a) return null;
      const said = a.said.map((line) => (line.length > 400 ? `${line.slice(0, 400)}…` : line));
      return { label: a.label, status: a.status, lines: said.length ? redact(said.join("\n"), this.#secrets()).split("\n") : [] };
    } catch {
      return null;
    }
  }

  /**
   * `job` is over.
   *
   * - close.1 — The log is kept, failed or clean alike: `list()` has it, and a RunLog built
   *   later over the same `indexedDB` lists it with the same text. What is stored has the
   *   secrets of this moment taken out. (E1, E6)
   * - close.2 — CAPS.kept closed logs are kept, the newest by `started`; an older one is
   *   dropped from `list()` and from the database.
   * - close.3 — `failed` true makes the job a failed run even without an error note; its
   *   row's `failed` is then "".
   * - close.4 — Resolves true once the log is in the database, false when it could not be
   *   stored; it is then kept for this session only. (E4)
   *
   * @param {string} job
   * @param {boolean} [failed]
   * @returns {Promise<boolean>}
   */
  async close(job, failed = false) {
    try {
      const log = this.#logs.get(job);
      if (!log || log.closed) return false;
      log.closed = true;
      log.ended = this.#now();
      if (failed) log.failed = true;
      for (const [action, a] of this.#actions) if (a.job === job) this.#actions.delete(action);
      const closed = [...this.#logs].filter(([, l]) => l.closed).sort((a, b) => b[1].head.started - a[1].head.started);
      const dropped = closed.slice(CAPS.kept).map(([key]) => key);
      for (const key of dropped) this.#logs.delete(key);
      const text = this.#logs.has(job) ? this.text(job) : null;
      const db = await openDb(this.#indexedDB);
      if (!db) return false;
      try {
        const tx = db.transaction(STORE, "readwrite");
        const end = new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () => reject(tx.error);
        });
        const store = tx.objectStore(STORE);
        for (const key of dropped) store.delete(key);
        if (text !== null) store.put({ ...this.#row(job, log), text });
        await end;
        return text !== null;
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  }

  #row(job, log) {
    return {
      job, started: log.head.started, kind: String(log.head.kind ?? ""), meeting: String(log.head.meeting ?? ""),
      state: !log.closed ? "running" : log.failed ? "failed" : "clean", failed: log.failed ? log.title : "",
      size: log.size, earlier: log.earlier,
    };
  }

  /**
   * - list.1 — The logs kept and the logs of jobs under way, newest first by `started`.
   *
   * @returns {Row[]}
   */
  list() {
    try {
      return [...this.#logs].map(([job, log]) => this.#row(job, log)).sort((a, b) => b.started - a.started);
    } catch {
      return [];
    }
  }

  /**
   * - text.1 — The job's log: the head, how it ended (running, clean, failed and why), then
   *   the entries, one a line, each with its time since the start and its action. (E2)
   * - text.2 — Every secret `secrets()` gives now, as written and URL-encoded, shows as
   *   `‹secret: <name>›`; so does the value of an `Authorization` header and the token after
   *   `Bearer`. A secret shorter than 6 characters is not looked for. (E1)
   * - text.3 — null for a job never opened or dropped.
   *
   * @param {string} job
   * @returns {string|null}
   */
  text(job) {
    try {
      const log = this.#logs.get(job);
      if (!log) return null;
      if (log.entries === null) return redact(log.text, this.#secrets());
      const h = log.head;
      const at = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "unknown");
      const result = !log.closed ? "running" : !log.failed ? "clean" : log.title ? `failed: ${log.title}` : "failed";
      const head = [
        "Penelope run log",
        `job: ${h.kind ?? "unknown"}`,
        `meeting: ${h.meeting || "none"}`,
        `started: ${at(h.started)}`,
        `ended: ${log.closed ? at(log.ended) : "running"}`,
        `result: ${result}`,
        `page build: ${h.build ?? "unknown"}`,
        `clai: ${h.clai ?? "unknown"}`,
        `profile: ${h.profile ?? "unknown"}`,
        `provider: ${h.provider ?? "unknown"}`,
        `browser: ${h.browser ?? "unknown"}`,
        "",
      ].map(oneLine);
      if (log.cut) head.push(`‹${log.cut} earlier entries cut: the log passed ${CAPS.log} characters›`);
      return redact(`${[...head, ...log.entries.map((e) => e.line)].join("\n")}\n`, this.#secrets());
    } catch {
      return null;
    }
  }
}
