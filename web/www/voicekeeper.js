// The voice library (known-voices:store) kept in this browser, and moved between it and the tab's machine.
import { toBase64 } from "./recordings.js";

/**
 * The IndexedDB database of the kept library. No other module opens it, and
 * VoiceKeeper opens no other database: `minutes` stays Recordings' alone.
 */
export const VOICES_DB = "minutes-voices";

/**
 * Minutes.run, as VoiceKeeper calls it: runs `line` on the tab's machine and
 * resolves to its exit status and what it sent to the page under `topic`.
 *
 * @callback Run
 * @param {string} label
 * @param {string} line
 * @param {{topic?: string, followUp?: boolean, background?: boolean, args?: string[]}} options
 * @returns {Promise<{status: number, body: string|null}>}
 */

/**
 * Whether the user stands behind a clip (known-voices:store `Status`).
 * @typedef {"confirmed"|"unconfirmed"} ClipStatus
 */

/**
 * Which member enrolled a clip (known-voices:store `Source`).
 * @typedef {"voices add"|"audio_remember_voice"} ClipSource
 */

/**
 * One clip a person holds, as the kept library's events give it
 * (known-voices:ReadLibrary.4–.6).
 *
 * @typedef {object} Clip
 * @property {string} id       12 lower-case hex digits (known-voices:store.3)
 * @property {ClipStatus} status
 * @property {ClipSource} source
 * @property {number} seconds  its length, from its latest `added` event
 * @property {string} added    the `at` of its latest `added` event, as written
 */

/**
 * One person of the kept library. `<slug>/<clip id>` is the clip reference a
 * segment's `voice.clip` and the voices CLI use.
 *
 * @typedef {object} Person
 * @property {string} name   the name `voice.json` stores (known-voices:store.2)
 * @property {string} slug   the voice's directory name (known-voices:store.1)
 * @property {Clip[]} clips  at least one
 */

const VOICE = "voice.json";
const CLIP_FILE = /^([0-9a-f]{12})\.flac$/;
// A run's line and arguments stay under the guest's 2 MiB (minutes.js RECORDING_PART).
const BUDGET = 1_600_000;
const CLIP_PART = 1_100_000;
// Raw bytes a take reads back in one run: a message holds 16 MiB, as base64.
const FETCH = 9_000_000;

const NAME = /^\p{L}[\p{L}\p{N} .'’-]{0,38}$/u;
const RESERVED = /^(speaker|unknown)-\d+$/i;
const AT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;
const KINDS = new Set(["added", "confirmed", "overruled", "removed", "placed", "named"]);
const NEEDS = { added: ["status", "source", "seconds"], placed: ["landed"], named: ["speakers"] };

// Each code point lower-cased alone, as Go's unicode.ToLower does: İ is i, a final Σ is σ.
const lower = (text) => [...text].map((c) => String.fromCodePoint(c.toLowerCase().codePointAt(0))).join("");

// known-voices SlugOf.1: a letter or a decimal digit stays, every other run is one "-".
const slugOf = (name) => lower(name).replace(/[^\p{L}\p{Nd}]+/gu, "-").replace(/^-+|-+$/g, "") || "-";

const isSlug = (name) => name !== "" && slugOf(name) === name;

// A fixed-width key that sorts as the time `at` does, to the nanosecond; null for no time.
function timeOf(at) {
  const m = AT.exec(at);
  const ms = m ? Date.parse(`${m[1]}Z`) : NaN;
  return Number.isNaN(ms) ? null : String(ms / 1000 + 1e11).padStart(12, "0") + (m[2] ?? "").padEnd(9, "0");
}

function eventOf(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const when = typeof e.at === "string" ? timeOf(e.at) : null;
  const ok = when && /^[0-9a-f]{16}$/.test(e.id) && /^[0-9a-f]{12}$/.test(e.clip) && KINDS.has(e.event) &&
    (!("status" in e) || ["confirmed", "unconfirmed"].includes(e.status)) &&
    (!("source" in e) || ["voices add", "audio_remember_voice"].includes(e.source)) &&
    (!("seconds" in e) || (typeof e.seconds === "number" && e.seconds > 0)) &&
    (!("landed" in e) || typeof e.landed === "boolean") &&
    (!("speakers" in e) || (Array.isArray(e.speakers) && e.speakers.length > 0 && e.speakers.every((s) => typeof s === "string" && s !== ""))) &&
    (NEEDS[e.event] ?? []).every((k) => k in e);
  return ok ? { ...e, when } : null;
}

// The fold of a voice's lines (known-voices:ReadLibrary.4–.7): clip id to its Clip, or null when removed.
function clipsOf(lines) {
  const events = new Map();
  for (const line of lines) {
    const e = eventOf(line);
    if (e && !events.has(e.id)) events.set(e.id, e);
  }
  const byClip = Map.groupBy(events.values(), (e) => e.clip);
  const clips = new Map();
  for (const [id, list] of byClip) {
    const added = list.filter((e) => e.event === "added").sort((a, b) => (a.when === b.when ? a.id < b.id : a.when < b.when) ? -1 : 1).at(-1);
    if (!added) continue;
    const since = list.filter((e) => e.when >= added.when);
    if (since.some((e) => e.event === "removed")) {
      clips.set(id, null);
      continue;
    }
    const status = added.status === "confirmed" || since.some((e) => e.event === "confirmed") ? "confirmed" : "unconfirmed";
    clips.set(id, { id, status, source: added.source, seconds: added.seconds, added: added.at, when: added.when });
  }
  return clips;
}

// The name a voice.json holds, when it is a record of voice.schema.json stored under its slug (store.1).
function nameOf(bytes, slug) {
  try {
    const record = JSON.parse(new TextDecoder().decode(bytes));
    const name = record?.name;
    const only = record && typeof record === "object" && !Array.isArray(record) && Object.keys(record).length === 1;
    return only && typeof name === "string" && NAME.test(name) && !RESERVED.test(name) && slugOf(name) === slug ? name : null;
  } catch {
    return null;
  }
}

const parses = (bytes) => {
  try {
    JSON.parse(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
};

const fromBase64 = (text) => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const sizeOf = (text) => new TextEncoder().encode(text).length;

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const finished = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("aborted"));
});

function open(indexedDB) {
  if (!indexedDB) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(VOICES_DB, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("files");
        request.result.createObjectStore("lines", { autoIncrement: true }).createIndex("line", ["slug", "line"], { unique: true });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// The kept files by "<slug>/<name>" (bytes only when `bytes`) and lines by slug, in the order kept.
async function readKept(db, bytes) {
  const tx = db.transaction(["files", "lines"], "readonly");
  const files = tx.objectStore("files");
  const keys = await done(files.getAllKeys());
  const values = await (bytes ? done(files.getAll()) : Promise.all(keys.map((k) => (k.endsWith(`/${VOICE}`) ? done(files.get(k)) : null))));
  const rows = await done(tx.objectStore("lines").getAll());
  const lines = new Map();
  for (const { slug, line } of rows) lines.set(slug, lines.get(slug) ?? []).get(slug).push(line);
  return { files: new Map(keys.map((k, i) => [k, values[i]])), lines };
}

// Adds the lines and files the kept library lacks, then drops the audio of clips its events removed (take.3, take.6).
async function keep(db, lines, files) {
  const tx = db.transaction(["files", "lines"], "readwrite");
  const end = finished(tx);
  end.catch(() => {});
  const store = tx.objectStore("files");
  const rows = tx.objectStore("lines");
  for (const [slug, list] of lines) {
    for (const line of new Set(list)) if ((await done(rows.index("line").getKey([slug, line]))) === undefined) rows.add({ slug, line });
  }
  for (const [key, bytes] of files) if ((await done(store.getKey(key))) === undefined) store.put(bytes, key);
  const touched = new Set([...lines.keys(), ...[...files.keys()].map((k) => k.split("/")[0])]);
  const all = await done(rows.getAll());
  for (const slug of touched) {
    for (const [id, clip] of clipsOf(all.filter((r) => r.slug === slug).map((r) => r.line))) {
      if (clip === null) store.delete(`${slug}/${id}.flac`);
    }
  }
  await end;
}

/**
 * The kept library: the browser's copy of the files of `known-voices:store`,
 * and the two ways it meets `$(clai confdir)/voices/` on the tab's machine.
 *
 * - VoiceKeeper.1 — The kept library lives in the IndexedDB database
 *   VOICES_DB and nowhere else in the browser. A second VoiceKeeper built
 *   over the same `indexedDB` holds everything the first one took. (P1)
 * - VoiceKeeper.2 — Clip audio is only in VOICES_DB and in the machine's
 *   files. No `label`, `line` or `hint` of a run holds a clip's bytes in any
 *   encoding; a put carries them to the machine only in a run's `args`. No
 *   put, take or people writes localStorage, the terminal or the notebook,
 *   and none puts clip audio into a line of the hood's log. (P2)
 * - VoiceKeeper.3 — No member puts up a note or a status and none rejects:
 *   the outcome of a call is its result. (P5)
 * - VoiceKeeper.4 — Every run a put or a take makes is a `followUp`,
 *   `background` run, so it runs beside an agent run and takes no turn at
 *   the console. Calls in flight at once each get their own answer from the
 *   machine. (L1.2)
 * - VoiceKeeper.5 — With no `indexedDB` (a private window, blocked site
 *   data), or one whose database cannot be opened, the kept library is
 *   empty and stays empty: `put` runs nothing and resolves true, `take` runs
 *   nothing and resolves false, `people` resolves []. (P3)
 */
export class VoiceKeeper {
  #run;
  #indexedDB;
  #topic = `voices-${Math.random().toString(36).slice(2, 10)}`;
  #runs = 0;

  /**
   * @param {{run: Run, indexedDB: IDBFactory|undefined}} seams
   */
  constructor({ run, indexedDB }) {
    this.#run = run;
    this.#indexedDB = indexedDB;
  }

  #machine(label, line, args) {
    const topic = `${this.#topic}-${++this.#runs}`;
    return this.#run(label, line(topic), { topic, followUp: true, background: true, args });
  }

  // What the machine's voices/ holds, or null when the run fails; `voices` is null without the directory.
  async #list(label) {
    const { status, body } = await this.#machine(label, LIST, []);
    if (status !== 0 || body === null) return null;
    const [head, ...records] = body.split("\0");
    const voices = records.length ? new Map() : null;
    const sizes = new Map();
    let voice = null;
    for (const record of records) {
      const text = record.slice(1);
      if (record[0] === "S") {
        for (const m of text.matchAll(/^\s*(\d+)\s+.*\/([^/\n]+\/[^/\n]+)$/gm)) sizes.set(m[2], Number(m[1]));
      } else if (record[0] === "D") {
        const slug = text.replace(/\n$/, "");
        voice = { slug, files: new Set(), lines: [] };
        if (!slug.startsWith(".") && isSlug(slug)) voices.set(slug, voice);
      } else if (record[0] === "F" && voice) {
        voice.files.add(text.replace(/\n$/, ""));
      } else if (record[0] === "E" && voice) {
        voice.lines = text.split("\n").slice(0, -1);
      }
    }
    return { dir: head.replace(/\n$/, ""), voices, sizes };
  }

  /**
   * Puts the kept library on the machine, under `$(clai confdir)/voices/`.
   *
   * - put.1 — With an empty kept library it makes no run, and no file or
   *   directory appears on the machine; it resolves true. (P3)
   * - put.2 — After it resolves true, the machine holds every kept
   *   `<slug>/voice.json` and `<slug>/<id>.flac`, and each machine
   *   `<slug>/events.jsonl` holds every kept event line, whole and ended by
   *   a newline. A file the machine lacked has exactly the kept bytes.
   *   (P1, known-voices:store.1–.4)
   * - put.3 — A `voice.json` or `<id>.flac` the machine already holds keeps
   *   its bytes, whatever the kept copy says. An event line the machine
   *   already holds is not appended again, and the lines the machine holds
   *   keep their bytes and their order: new lines come after them. A put
   *   that follows a put with nothing new changes no file. (L1.2,
   *   known-voices:store.2, store.3, store.4)
   * - put.4 — It deletes nothing: a file, a line or a directory the machine
   *   holds and the kept library lacks is there afterwards, unchanged, names
   *   that start with `.` included. (L1.2, known-voices:F10)
   * - put.5 — The `line` and `args` of each run it makes hold under
   *   2 MiB (2 097 152 bytes) in all; a kept library that needs more is put
   *   in more runs. (L1.1)
   * - put.6 — A clip is on the machine under its name `<id>.flac` only
   *   whole: until its last byte is written it stands under a name that
   *   starts with `.`. (known-voices:F10, store.5)
   * - put.7 — When a run exits other than 0, it makes no further run and
   *   resolves false. What the machine held before the put is unchanged, and
   *   every `<id>.flac` there is whole; a later put writes what is still
   *   lacking. (L1.2)
   *
   * @returns {Promise<boolean>} true when the machine holds the kept library
   */
  async put() {
    try {
      const db = await open(this.#indexedDB);
      if (!db) return true;
      let kept;
      try {
        kept = await readKept(db, true);
      } finally {
        db.close();
      }
      if (kept.files.size === 0 && kept.lines.size === 0) return true;
      const there = await this.#list("Put the voices on the machine");
      if (!there) return false;
      const ops = [];
      const slugs = new Set([...kept.lines.keys(), ...[...kept.files.keys()].map((k) => k.split("/")[0])]);
      for (const slug of [...slugs].sort()) {
        const has = there.voices?.get(slug) ?? { files: new Set(), lines: [] };
        const voice = kept.files.get(`${slug}/${VOICE}`);
        if (voice && !has.files.has(VOICE)) ops.push(["v", slug, toBase64(voice)]);
        for (const [key, bytes] of kept.files) {
          const [owner, name] = key.split("/");
          if (owner !== slug || !CLIP_FILE.test(name) || has.files.has(name)) continue;
          for (let at = 0; at < bytes.length; at += CLIP_PART) {
            const last = at + CLIP_PART >= bytes.length;
            ops.push(["c", slug, name.slice(0, 12), at ? "1" : "0", last ? "1" : "0", toBase64(bytes.subarray(at, at + CLIP_PART))]);
          }
        }
        const held = new Set(has.lines);
        for (const line of kept.lines.get(slug) ?? []) if (!held.has(line)) ops.push(["e", slug, line]);
      }
      const nonce = Math.random().toString(36).slice(2, 10);
      const base = WRITE.length + sizeOf(there.dir) + nonce.length;
      const runs = [];
      let size = Infinity;
      for (const op of ops) {
        const cost = op.reduce((sum, arg, i) => sum + (op[0] !== "e" && i === op.length - 1 ? arg.length : sizeOf(arg)) + 1, 0);
        if (size + cost > BUDGET) {
          runs.push([there.dir, nonce]);
          size = base;
        }
        runs.at(-1).push(...op);
        size += cost;
      }
      for (const run of runs) {
        const { status } = await this.#machine("Put the voices on the machine", () => WRITE, run);
        if (status !== 0) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Takes back into the kept library what the machine's
   * `$(clai confdir)/voices/` holds and the kept library lacks.
   *
   * - take.1 — With no `voices/` directory on the machine it adds nothing
   *   and resolves true. It never creates, changes or deletes a file on the
   *   machine. (known-voices:ReadLibrary.1, L1.2)
   * - take.2 — After it resolves true, the kept library holds, for every
   *   directory `voices/<slug>/`, its `voice.json`, each `<id>.flac`
   *   (`<id>` 12 lower-case hex digits) with the machine's bytes, and every
   *   complete line of its `events.jsonl`. No other entry is taken.
   *   (P1, known-voices:store.1, store.3, store.4)
   * - take.3 — A kept `voice.json` or `<id>.flac` is never replaced: the
   *   first one kept stays, whatever the machine holds later. A line the
   *   kept library already holds is not added again, and no kept line is
   *   removed. (L1.2, known-voices:store.2, store.3, store.7)
   * - take.4 — A last line of `events.jsonl` that does not end in a newline
   *   is not taken; a later take, once the line is complete, takes it.
   *   (L1.2, known-voices:store.4, F10)
   * - take.5 — A name that starts with `.` is skipped: as a directory under
   *   `voices/` and as a file in a voice's directory, so a clip being
   *   written (`.<id>.flac.tmp`) is never kept. (L1.2, known-voices:store.5)
   * - take.6 — After a take, the kept library holds no `<id>.flac` of a clip
   *   its kept events do not hold (a `removed` event at or after the clip's
   *   latest `added` event, known-voices:ReadLibrary.4), whether or not the
   *   machine still has the file. The clip's event lines stay. A clip added
   *   again after its removal is taken again. (L1.2)
   * - take.7 — When a run exits other than 0, or the machine does not
   *   answer, it resolves false. What it had added by then stays, each file
   *   whole, and a later take adds the rest. (L1.2)
   *
   * @returns {Promise<boolean>} true when the kept library holds what the machine held
   */
  async take() {
    try {
      const db = await open(this.#indexedDB);
      if (!db) return false;
      try {
        const there = await this.#list("Take the voices back");
        if (!there) return false;
        if (!there.voices) return true;
        await keep(db, new Map([...there.voices].map(([slug, v]) => [slug, v.lines])), new Map());
        const kept = await readKept(db, false);
        const wanted = [];
        for (const [slug, voice] of there.voices) {
          const clips = clipsOf(kept.lines.get(slug) ?? []);
          for (const name of voice.files) {
            const clip = CLIP_FILE.exec(name);
            if ((name !== VOICE && !clip) || kept.files.has(`${slug}/${name}`) || clips.get(clip?.[1]) === null) continue;
            wanted.push({ path: `${slug}/${name}`, size: there.sizes.get(`${slug}/${name}`) ?? 0 });
          }
        }
        const batches = [];
        let size = Infinity;
        for (const file of wanted) {
          if (size + file.size > FETCH) {
            batches.push([]);
            size = 0;
          }
          batches.at(-1).push(file.path);
          size += file.size;
        }
        for (const paths of batches) {
          const { status, body } = await this.#machine("Take the voices back", FETCH_LINE, [there.dir, ...paths]);
          if (status !== 0 || body === null) return false;
          const files = new Map();
          for (const record of body.split("\0").slice(1)) {
            const at = record.indexOf("\n");
            const path = record.slice(0, at);
            const bytes = fromBase64(record.slice(at + 1));
            if (paths.includes(path) && bytes.length > 0 && (!path.endsWith(`/${VOICE}`) || parses(bytes))) files.set(path, bytes);
          }
          await keep(db, new Map(), files);
        }
        return true;
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  }

  /**
   * The people of the kept library, with their clips and statuses.
   *
   * - people.1 — It reads the kept library only: it makes no run, and it
   *   resolves the same before and after a put.
   * - people.2 — One Person per kept voice that holds a clip: a directory
   *   whose `voice.json` is a record of known-voices:voice.schema.json, with
   *   `name` its name and `slug` the directory's name. A voice whose clips
   *   are all removed, and a directory with no such `voice.json`, are not
   *   listed. (known-voices:store.1, List.1)
   * - people.3 — A person's clips are the clips the kept events hold whose
   *   `<id>.flac` is kept. A clip is `confirmed` when its latest `added`
   *   event says so or a `confirmed` event follows it, else `unconfirmed`;
   *   `source`, `seconds` and `added` are those of its latest `added` event.
   *   (known-voices:store.6, ReadLibrary.4–.6)
   * - people.4 — The order of the kept lines does not matter, a line kept
   *   twice and events with one `id` count once, and a complete line that is
   *   not a record of known-voices:event.schema.json is skipped and hides no
   *   other line. (known-voices:ReadLibrary.3, ReadLibrary.7, store.7)
   * - people.5 — People come in name order, compared without case; a
   *   person's clips come oldest `added` first, then by id. An empty kept
   *   library is []. (known-voices:List.1 for the people; clip order is this
   *   member's own, since ranking is known-voices' Ranker)
   *
   * @returns {Promise<Person[]>}
   */
  async people() {
    try {
      const db = await open(this.#indexedDB);
      if (!db) return [];
      let kept;
      try {
        kept = await readKept(db, false);
      } finally {
        db.close();
      }
      const people = [];
      for (const [key, bytes] of kept.files) {
        const [slug, file] = key.split("/");
        const name = file === VOICE && isSlug(slug) ? nameOf(bytes, slug) : null;
        if (!name) continue;
        const clips = [...clipsOf(kept.lines.get(slug) ?? []).values()]
          .filter((c) => c && kept.files.has(`${slug}/${c.id}.flac`))
          .sort((a, b) => (a.when === b.when ? (a.id < b.id ? -1 : 1) : a.when < b.when ? -1 : 1))
          .map(({ id, status, source, seconds, added }) => ({ id, status, source, seconds, added }));
        if (clips.length) people.push({ name, slug, clips });
      }
      return people.sort((a, b) => lower(a.name).localeCompare(lower(b.name)) || (a.slug < b.slug ? -1 : 1));
    } catch {
      return [];
    }
  }
}

// Lists voices/: its path, then per directory its files and complete event lines, and the clips' sizes.
const LIST = (topic) => "shopt -s nullglob; d=$(clai confdir) || exit; d=$d/voices; " +
  `{ echo ${topic}; printf '%s\\n' "$d"; if [ -d "$d" ]; then f=("$d"/*/*.flac); printf '\\0S'; ` +
  '[ ${#f[@]} = 0 ] || wc -c "${f[@]}"; for v in "$d"/*/; do v=${v%/}; printf \'\\0D%s\\n\' "${v##*/}"; ' +
  'for e in "$v"/*; do printf \'\\0F%s\\n\' "${e##*/}"; done; printf \'\\0E\'; ' +
  '[ -f "$v/events.jsonl" ] && while IFS= read -r l; do printf \'%s\\n\' "$l"; done < "$v/events.jsonl"; done; fi; :; } > /run/page/out';

// Sends the files "$2"… under the directory "$1", each as base64 after its path.
const FETCH_LINE = (topic) => `cd "$1" || exit; shift; { echo ${topic}; for f in "$@"; do printf '\\0%s\\n' "$f"; ` +
  '[ -f "$f" ] && base64 "$f"; done; :; } > /run/page/out';

// Writes v <slug> <voice.json>, c <slug> <id> <append> <last> <part>, e <slug> <line>: each file whole where none is, each line once.
const WRITE = [
  'd=$1 n=$2; shift 2; [ -d "$d" ] || mkdir -p "$d" || exit; cd "$d" || exit; at=',
  'while [ $# -gt 0 ]; do [ -d "$2" ] || mkdir "$2" || exit; case $1 in',
  'v) f=$2/voice.json t=$2/.voice.json.$n; if [ ! -e "$f" ]; then printf %s "$3" | base64 -d > "$t" || exit; ' +
  'if [ -e "$f" ]; then rm "$t"; else mv "$t" "$f" || exit; fi; fi; shift 3;;',
  'c) f=$2/$3.flac t=$2/.$3.flac.$n; if [ "$4" = 0 ]; then printf %s "$6" | base64 -d > "$t" || exit; ' +
  'else printf %s "$6" | base64 -d >> "$t" || exit; fi; ' +
  'if [ "$5" = 1 ]; then if [ -e "$f" ]; then rm "$t"; else mv "$t" "$f" || exit; fi; fi; shift 6;;',
  'e) f=$2/events.jsonl; if [ "$2" != "$at" ]; then at=$2; unset have; declare -A have; l=; ' +
  'if [ -f "$f" ]; then while IFS= read -r l; do have["x$l"]=1; done < "$f"; [ -z "$l" ] || echo >> "$f"; fi; fi; ' +
  '[ -n "${have["x$3"]}" ] || { printf \'%s\\n\' "$3" >> "$f" || exit; have["x$3"]=1; }; shift 3;;',
  "*) exit 2;; esac; done",
].join("\n");
