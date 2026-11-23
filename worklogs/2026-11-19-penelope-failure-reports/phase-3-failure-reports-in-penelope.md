# Phase 3 — Failure reports in Penelope

**Parent:** root · **Class:** composition · [README](README.md)

## Goal

Every job of the app keeps a run log, a failure note names its cause and hands out the log, the peek lists the
logs kept, and the app's agent runs start clai at `LOG_LEVEL=debug`.

## Interface

The root's UI `report`, in `web/www/index.html`, `web/www/minutes.js`, `web/www/main.js` and `web/www/style.css`.

| Element or state                                             | Shown when                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `.note .note-cause` (monospace): `<label> · exit <n>`, then the last lines | the note is about a command that failed (report.1)                                                |
| `.note .note-copy` **Copy log**; says *Copied* for 2 s       | the note belongs to a job (report.2)                                                                         |
| `.note .note-download` **Download**                          | the note belongs to a job (report.2)                                                                         |
| `.note .note-said`                                           | a copy or a download failed; it says so (report.3)                                                            |
| `.note .note-peek` *See what the machine printed*            | as before, on every note                                                                                     |
| `[role=tab][data-tab=runlogs]` **Run logs**, after Terminal  | always                                                                                                       |
| `#runlogs > li.runlog` with `.runlog-when`, `.runlog-what`, `.runlog-how`, `.runlog-size`, `.runlog-copy`, `.runlog-download` | one per log of `RunLog.list()`, newest first (report.4) |
| `#runlogs-none`                                              | no log is kept                                                                                               |

- report.1 — An error note about a failed command shows the app's sentence and under it the cause: the command's
  label, its exit status and its last five lines on stderr. A note about a job whose command did not fail (the
  agent's own `error` record aside, whose cause is the agent run's) has no cause block. (E3)
- report.2 — Copy log puts `RunLog.text(job)` on the clipboard; Download saves the same text as
  `logName(row)`. (E1, E8)
- report.3 — A copy or download that fails says so on the note, or on the row; nothing else changes. (E4)
- report.4 — A row shows the time the job started (with its date when an earlier session kept it), the job kind
  and the meeting, `failed: <note title>` in red, `clean` or `running`, the size, then Copy and Download. (Q4)
- report.5 — Every job has a log: Start recording, Send, Try again, Transcribe again and Penelope's Ask. Every
  command a job runs is attached to it: the agent run, the voice library's put and take, and the follow-ups
  (keeping the recording, reading the meeting, filing the transcript, the commit, the refresh, Penelope's copies).
  The log is closed when the job ends, failed when it put up an error note or ended with a status other than 0. (E2, E6)
- report.6 — A foreground command's printed lines are what the console printed between its start and its end; the
  agent's lines are its `agent:<n>` messages; a body read through `/run/page/out` is its topic and length; the hood's
  events of an attached action are its process events. (E2, E8)
- report.7 — The app's agent runs (`agentLine`, Penelope's Ask) start clai as `LOG_LEVEL=debug clai -json …`
  (`config.logLevel`). The app's other clai commands (`config trust`, `profiles trust`, `audio voices`), whose
  output the page reads as text, stay as they are. (Q1)
- report.8 — A `diagnostic` record of level `debug` or `trace` goes to the run log only: not to the terminal, the
  job's stages, Penelope's activity or a note. (E6)
- report.9 — `writeTranscript` reads the paths the run named in order: linked in the reply, written by its
  programs, the meeting transcribed again, the job's own. It files the transcript at the first that reads and puts
  up *The transcript could not be filed* only when none reads, with the last read's cause. (E7)
- report.10 — A clean run puts up no note, and no call into `RunLog` changes a job's status, files, commits or
  notes. (E4, E6, known-voices P5)

Consumes: `summariesIn` (phase 1); `RunLog`, `logName`, `CAPS` (phase 2); `Minutes.run`, `Minutes.fail`,
`Minutes.note`, `writeTranscript`, `filedBy`, `newJob`, `machine.run`, `machine.spawn`, `Machine.note`
(`hood.js`), the records of `clai -json`, clai's `LOG_LEVEL` (imports).

## Acceptance criteria

| #   | Criterion                                                                                          | Proves               | Proof                                               |
| --- | -------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------- |
| 1   | A failed agent run's note has Copy log and Download; the copied text names the command, its status and clai's error | report.2, report.5, E2 | `node check.mjs`: "Minutes, a failed run's log" |
| 2   | The planted provider key and slivingdoc token are in no log of the whole check                     | E1                   | `node check.mjs`: "the run logs, no secret"          |
| 3   | The agent's reply and a tool's output are in no log                                                | E8                   | `node check.mjs`: "Minutes, Record's log"            |
| 4   | Record's log holds the agent run, its processes, a debug diagnostic and the follow-ups, and Record put up no note | report.5–.8, .10, E6 | `node check.mjs`: "Minutes, Record's log"   |
| 5   | A transcript files at the written path when the linked one does not read; with none readable the note shows `Read the meeting · exit 1` and cat's line | report.9, report.1, E7, E3 | `node check.mjs`: "the transcript's paths" |
| 6   | Run logs lists the kept logs newest first, and Download names the file                             | report.4             | `node check.mjs`: "the Run logs tab"                 |
| 7   | The agent's line starts clai with `LOG_LEVEL=debug`                                                | report.7             | the golden                                          |
| 8   | A debug diagnostic is not on the terminal                                                          | report.8             | `node check.mjs`: "Minutes, Record's log"            |

## Test cases

| Test                           | Level                | Proves                     | Given                                                         | Then                                                                 | Must not                                   |
| ------------------------------ | -------------------- | -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| `Minutes, Record's log`        | integration scenario | report.5–.8, .10, E2, E6, E8 | the check's Record run                                      | a clean log with the run line, `exec`, a `diagnostic debug`, `reply ‹n chars›`, the follow-ups | the reply's text; a note; a debug line on the terminal |
| `Minutes, a failed run's log`  | integration scenario | report.1–.3, E3            | the run with `-cm no-such-model`                              | the cause block; Copy log says Copied; the text holds clai's error   | the key                                    |
| `the transcript's paths`       | integration scenario | report.9, E7, E3           | a reply linking a file that is not there, and one written     | the transcript filed at the written one; then, none readable, the note with its cause | a note in the first case        |
| `the Run logs tab`             | integration scenario | report.4                   | the logs of the runs above                                    | rows newest first, a failed one in red, the download's name          | —                                          |
| `the run logs, no secret`      | integration scenario | E1                         | every log at the end of the check                             | no key, token or `Bearer` value                                      | —                                          |

## Error management

| Failure                               | Expected outcome                                         | Test                           |
| ------------------------------------- | -------------------------------------------------------- | ------------------------------ |
| The clipboard refuses                 | `.note-said`: *The log could not be copied.*             | `Minutes, a failed run's log`  |
| No path of a transcript's meeting reads | *The transcript could not be filed* with the read's cause | `the transcript's paths`     |

## Golden diff

| Golden                       | Change                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `web/goldens/run-lines.json` | `start`, `start-voices`, `continue`, `continue-voices`: `clai -json` becomes `LOG_LEVEL=debug clai -json`; the other four keys unchanged |

## Removes

None.

## Local facts

- M1 runs before deploy, not before this phase (orchestrator, 2026-11-20).
- A command outside a job (Save corrections, the trust check, sign-in) keeps no log; its note still shows its cause.

## Human required

None.

## Implementation notes

| Run   | Commit      | Command | Result |
| ----- | ----------- | ------- | ------ |
| start | b146a55+wip | `cd web && node --test units.test.mjs`; `cd web && node check.mjs` | 165 passed, 0 failed; check exit 1, the 14 FAIL lines of A01 (the run that ended phases 1 and 2) |
| end   | b146a55+wip | `cd web && node --test units.test.mjs`; `cd web && node check.mjs` | 165 passed, 0 failed; check exit 0 |
| end   | b146a55+wip | `cd web && node --test units.test.mjs`; `cd web && node check.mjs` | 165 passed, 0 failed; check exit 0 |

Golden: `cd web && UPDATE_GOLDENS=1 node check.mjs` wrote `web/goldens/run-lines.json`; `start`, `start-voices`, `continue` and
`continue-voices` gained ` LOG_LEVEL=debug` before `clai -json`, the other four keys are unchanged.

Andon: none of its own; A01 closed once `web/www/clai.wasm` was rebuilt at 14:18 by another session.
Surprises:

- The page's bash gives clai's status in the pipeline as 0 whatever it exited with, so the agent run's cause names its
  label and clai's error line, with no exit status. The log's `end` entry says `exit 0`, as the pipeline did.
- stdout and stderr are one stream on the console, so a foreground command's "lines on stderr" are the lines it printed there.
- `readMeeting` fails when the transcript file is missing (the group's status is the last `cat`'s); report.9's "reads" is that.
- Penelope's pen stands over the peek's bottom right corner; the Run logs panel keeps 130px clear of it.
- A note with the same title and detail shows once, so a second identical failure adds no note; its log still has the entry.
- Commands outside a job (Save corrections, the trust check) get a cause on their note and no log (Local facts).
- clai's version for the head is asked once, at the first log, with `clai version` off the console.
- The voice library's put and take reach `Minutes.run` through VoiceKeeper, so they join the log of the run that asked
  for them through `voicesLog`; two runs starting in the same moment could cross.
- A job's log closes when the job ends; a process event that reaches the page later is not in it.

## Review findings

None.
