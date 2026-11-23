# Phase 2 — Run log

**Parent:** root · **Class:** contract · [README](README.md)

## Goal

Keep what each job did as a bounded, secret-free text with no model output, and say why a command failed.

## Interface

Written to `web/www/runlog.js`. A code interface: the class, its members, the types, `RUNLOGS_DB`, `CAPS`,
`logName` and the clauses are the frozen surface. How a line of the text is laid out is body, except
where a clause names it.

```js
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

/** `penelope-<start>_<slug>-<job kind>.log`: <start> as a notebook file's, 2026-10-30T08-00Z. */
export function logName(row) {}

/**
 * The run logs of this browser.
 *
 * - RunLog.1 — No member throws or rejects, whatever it is given and whatever `secrets` and
 *   `indexedDB` do: the outcome of a call is its result. (E4)
 * - RunLog.2 — No member writes localStorage, the notebook, the machine or the network, and
 *   none puts up a note. (E4, E6)
 */
export class RunLog {
  /**
   * @param {object} deps
   * @param {IDBFactory|undefined} deps.indexedDB
   * @param {() => Array<[string, string]>} [deps.secrets]  the secrets the page holds now, [name, value]
   * @param {() => number} [deps.now]
   */
  constructor({ indexedDB, secrets, now }) {}

  /** Resolves once the logs earlier sessions kept are listed. Never rejects. */
  ready;

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
  open(job, head) {}

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
  attach(job, action, label, line, args) {}

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
  add(action, entry) {}

  /**
   * The command under `action` ended.
   *
   * - ended.1 — The log gets an entry with its exit status. (E2)
   *
   * @param {string} action
   * @param {number} status
   */
  ended(action, status) {}

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
  noted(job, note) {}

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
  cause(action) {}

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
  close(job, failed) {}

  /**
   * - list.1 — The logs kept and the logs of jobs under way, newest first by `started`.
   *
   * @returns {Row[]}
   */
  list() {}

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
  text(job) {}
}
```

Consumes: the records of `clai -json` (`web/www/agent.js`, `web/www/records.js`, import).

## Acceptance criteria

| #   | Criterion                                                                 | Proves                    | Proof                                                             |
| --- | ------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| 1   | A planted secret, in every kind of entry, is in no text and no cause      | E1, text.2, cause.2       | `units`: "no planted secret is in a run log"                       |
| 2   | Planted model output, in every record that carries some, is in no text    | E8, add.4, add.5, add.6   | `units`: "no planted model output is in a run log"                 |
| 3   | A log holds its head, commands, lines, records, events and notes in order | E2, open.1 … noted.1      | `units`: "a run log is whole and in order"                         |
| 4   | Entries, arguments and the log are bounded                                | E5, add.8, add.9, attach.2 | `units`: "a run log is bounded"                                   |
| 5   | A cause names the label, the status and the last five lines               | E3, cause.1, cause.3      | `units`: "a cause is the command's label, status and last lines"  |
| 6   | Without storage, or with garbage, nothing throws and the session keeps the log | E4, RunLog.1, close.4 | `units`: "a run log that cannot be kept changes nothing"          |
| 7   | Ten logs are kept across a reload, failed and clean alike                 | E6, close.1, close.2      | `node check.mjs`: "the run logs, kept"                             |

## Test cases

| Test                                                     | Level | Proves                         | Given                                                                                  | Then                                                             | Must not                                   |
| -------------------------------------------------------- | ----- | ------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `no planted secret is in a run log`                      | unit  | E1, text.2, cause.2            | a key in a line, an argument, a printed line, a diagnostic's facts, an error, a tool input, an exec, a note; URL-encoded; `Authorization:` and `Bearer` | `‹secret: NAME›` in their place, in `text` and `cause` | the key, whole or encoded                  |
| `no planted model output is in a run log`                | unit  | E8, add.4–.6                   | markers in a reply, deltas, thinking, a tool's output, a long input, stdout, an unknown record | kinds and lengths                                         | any marker                                 |
| `a run log is whole and in order`                        | unit  | E2, open.1, attach.1, add.1–.3, add.7, ended.1, noted.1, text.1, list.1 | one job with two commands                    | every entry, in the order added                                  | —                                          |
| `a run log is bounded`                                   | unit  | E5, add.8, add.9, attach.2     | a 20,000-character line; a 1.2 MB argument; 3 MiB of entries                           | the cut markers; the head and the newest entries                 | a text over the cap plus its head          |
| `a cause is the command's label, status and last lines`  | unit  | E3, cause.1, cause.3, attach.3 | seven printed lines and exit 1, with and without a job                                 | the last five                                                    | a cause for an unknown action              |
| `a run log that cannot be kept changes nothing`          | unit  | E4, RunLog.1, close.3, close.4 | no IndexedDB, a failing one, `secrets` that throws, entries of no kind                 | `close` resolves false, `list` has the log, nothing throws       | a throw or a rejection                     |
| `a log's file name`                                      | unit  | `logName`                      | a row with and without a meeting                                                       | `penelope-2026-11-20T09-14Z_daily-sync-record.log`               | —                                          |
| `the run logs, kept`                                     | integration scenario (`check.mjs`, the page's IndexedDB) | E6, close.1, close.2 | twelve closed logs, then a second RunLog over the same database | the newest ten, texts equal, the secret out | the two oldest                              |

## Error management

| Failure                                   | Expected outcome                                              | Test                                             |
| ----------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| IndexedDB is missing or fails             | `close` resolves false; the log lists for the session         | `a run log that cannot be kept changes nothing`  |
| `secrets()` throws                        | `text` and `cause` give no text rather than an unredacted one | `a run log that cannot be kept changes nothing`  |

## Golden diff

None.

## Removes

None.

## Local facts

- Lengths are counted in characters (UTF-16 code units): the entry cap is 8,192, the log cap 2,097,152.
- An entry's time is the page's clock when it was added, so entries are in the order they reached the page.
- clai's debug diagnostics dump whole conversations and tool calls (`[text_querier] InitialPrompt: {…}`, `[call] Invoke call: {…}`),
  which hold model output, and its configuration files. Each is a first line and a dump below it, so a debug or trace
  diagnostic keeps its first line and its facts (add.3). The one-line `calibration … key=value` records of the
  long-recording diarization path stay whole.
- A log's stored text is redacted at `close` and again at `text`, so a secret the page learns later is taken out too,
  and one it forgot since stays out.

## Human required

None.

## Implementation notes

| Run   | Commit      | Command | Result |
| ----- | ----------- | ------- | ------ |
| start | b146a55+wip | `cd web && node --test units.test.mjs`; `cd web && node check.mjs` | 155 passed, 0 failed; check exit 1, 14 FAIL lines (A01) |
| end   | b146a55+wip | `cd web && node --test units.test.mjs`; `cd web && node check.mjs` | 165 passed, 0 failed; check exit 1, the same 14 FAIL lines as the start (A01), none new; "the run logs, kept" passed |
| end   | b146a55+wip | `cd web && node --test units.test.mjs`; `cd web && node check.mjs` | 165 passed, 0 failed; check exit 0 (with phase 3 in, after `clai.wasm` was rebuilt at 14:18) |
| end   | b146a55+wip | `cd web && node --test units.test.mjs`; `cd web && node check.mjs` | 165 passed, 0 failed; check exit 0 |

Andon: A01 (the start gate; closed once `clai.wasm` was rebuilt by another session).
Surprises:

- add.3 was amended while phase 3 ran: clai's debug diagnostics dump conversations, tool calls and config files, so a
  `debug` or `trace` diagnostic keeps its first line and facts only (Local facts). E8 would not hold otherwise.
- A one-line debug record is kept whole, and the app cannot tell what it holds. M1 should search a real log for model
  output as well as for secrets.
- `Row.size` is the characters of the entries, not of `text(job)`: a list must not render ten logs to size them.

## Review findings

None.
