# Penelope reports why a run failed

## Goal

When a run fails, Penelope says why and hands the user the whole story: the failure note names the
command that failed, its exit status and the last lines it printed, and offers **Copy log** and
**Download log**. A run log holds the diagnostics of one job (each command and its exit status,
its stderr, clai's diagnostic and error records, its tool calls and how they ended, the processes it
started, the notes it raised) in time order. It holds no model output, and every secret the page
holds is taken out. The app runs clai at `LOG_LEVEL=debug`, so a log is enough to debug a failure
without reproducing it. A **Run logs** tab under the peek lists the logs kept. What must stay true:
only a failed run puts up a note (known-voices P5), logging never changes a run's outcome (E4), and
no secret (E1) and no model output (E8) leaves the page in a log.

## Background: the failure of 2026-11-19

A meeting run recorded, transcribed (78 segments) and wrote both files, then the app put up "The
transcript could not be filed · The meeting the agent filed could not be read." and filed the
transcript with its front matter only. The note gave no cause; the cause was on the peek's terminal.

- The agent's reply linked the files as `[file:///home/user/notebook/meetings/summaries/X.md](file:///home/user/notebook/meetings/summaries/X.md)`:
  the link text is itself a URL.
- `summariesIn` (`web/www/minutes.js:300`) matches `/\]\(([^)\s]+)\)|(file:\/\/\S+)/g`. The scan
  reaches the link text first, and the bare-URL branch takes `\S+` through `](file://…)`. The path
  became `meetings/summaries/X.md](file:///home/user/notebook/meetings/summaries/X.md)`.
- `writeTranscript` reads that path first (`summariesIn(r.reply)[0] ?? r.wrote …`), and `cat` failed:
  `No such file or directory`. It never tried the path in `r.wrote`, which was right.
- `save` then committed 0 files, and `filedBy` opened the meeting from `r.wrote`, so the meeting
  showed with a summary and an empty transcript.

## Glossary

| Term       | Meaning                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Job        | one piece of the app's work for a meeting (Start recording, Send, Try again, Transcribe again, Penelope's Ask): `newJob` in `jobs.js`     |
| Action     | one command the app runs on the machine, `minutes:<label>#<n>` (`Minutes.run`)                                                             |
| Run log    | what one job did, as text: the head, then entries in time order                                                                           |
| Head       | what identifies a run: start time, page build, clai version, profile ref and sha256, provider and model, browser and OS, job kind, meeting |
| Entry      | one timed line of a run log: a command started or ended, a line it printed, a clai record, a process event from the hood, a note         |
| Model output | the reply and its deltas, the thinking, what a tool that succeeded returned, and argument values longer than the argument cap (a file's content, say) |
| Failed run | a job that put up an error note                                                                                                           |
| Clean run  | a job that ended without an error note                                                                                                    |
| Cause      | the failed command's label, its exit status and its last lines on stderr                                                                  |
| Secret     | a value the page holds that grants access: provider API keys, the OpenRouter key, MCP OAuth tokens (`mcpAuth`), slivingdoc credentials    |

## Flows

### A run fails

```text
┌──────┐                    ┌─────────┐                    ┌────────┐                    ┌────────┐
│ user │                    │ Minutes │                    │ RunLog │                    │ report │
└───┬──┘                    └────┬────┘                    └────┬───┘                    └────┬───┘
    │                            │                              │                             │
    │── Start ──────────────────▶│                              │                             │
    │                            │                              │                             │
    │                            │── open(job, head) ──────────▶│                             │
    │                            │                              │                             │
    │                            │── attach(job, action, …) ───▶│                             │
    │                            │                              │                             │
    │                            │── add(action, entry) ───────▶│                             │
    │                            │                              │                             │
    │                            │── ended(action, status) ────▶│                             │
    │                            │                              │                             │
    │                            │── cause(action) ────────────▶│                             │
    │                            │                              │                             │
    │                            │◀─ label, status, lines ──────│                             │
    │                            │                              │                             │
    │                            │── fail(title, detail, job, cause) ────────────────────────▶│
    │                            │                              │                             │
    │                            │── noted(job, note) ─────────▶│                             │
    │                            │                              │                             │
    │── Copy log ────────────────────────────────────────────────────────────────────────────▶│
    │                            │                              │                             │
    │                            │                              │◀─ text(job) ────────────────│
    │                            │                              │                             │
    │                            │                              │── the log, secrets out ────▶│
    │                            │                              │                             │
    │◀─ clipboard; "Copied" ──────────────────────────────────────────────────────────────────│
    │                            │                              │                             │
    │                            │── close(job, failed) ───────▶│                             │
    │                            │                              │                             │
```

Every command a job runs is attached to it: the agent run and its follow-ups (reading the meeting,
filing the transcript, the commit, the refresh). The agent run's lines come tagged with its run id
through `/run/page/out`; a foreground command's lines are what the console printed between its start
and its end (`machine.run` runs one at a time). Download log saves the same text as a file.

### Copy a log later

```text
┌──────┐                  ┌────────┐                  ┌────────┐
│ user │                  │ report │                  │ RunLog │
└───┬──┘                  └────┬───┘                  └────┬───┘
    │                          │                           │
    │── Peek; Run logs ───────▶│                           │
    │                          │                           │
    │                          │── list() ────────────────▶│
    │                          │                           │
    │                          │◀─ the kept runs ──────────│
    │                          │                           │
    │── Copy or Download ─────▶│                           │
    │                          │                           │
    │                          │── text(job) ─────────────▶│
    │                          │                           │
    │                          │◀─ the log, secrets out ───│
    │                          │                           │
    │◀─ clipboard or file ─────│                           │
    │                          │                           │
```

## Status board

**Line:** running

| #   | Node                        | Parent | Class       | Interface                                                                                                                         | Status      |
| --- | --------------------------- | ------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | Summary links               | root   | contract    | `summariesIn` (`web/www/minutes.js`): the meeting summaries an agent's reply links to                                             | Complete    |
| 2   | Run log                     | root   | contract    | `RunLog` (`open`, `attach`, `add`, `ended`, `noted`, `cause`, `close`, `list`, `text`; `web/www/runlog.js`)                     | Complete    |
| 3   | Failure reports in Penelope | root   | composition | root: UI `report`: the failure note's cause, Copy log and Download log; Run logs under the peek; the app's clai runs at `LOG_LEVEL` | Complete    |

### Imports

| Member                                                                     | Kind      | Used by phases |
| -------------------------------------------------------------------------- | --------- | -------------- |
| `Minutes.run`, `Minutes.fail`, `Minutes.note`, `writeTranscript`, `filedBy` | code      | 3              |
| `newJob` (`web/www/jobs.js`)                                               | code      | 3              |
| `machine.run`, `machine.spawn` (`web/www/main.js`)                         | code      | 3              |
| Records of `clai -json`: `reply_delta`, `reply`, `tool_call`, `tool_result`, `progress`, `diagnostic`, `error` (`agent.js`, `records.js`) | data      | 2, 3           |
| clai's `LOG_LEVEL` (clai diagnostics worklog F7; `clai h`, "Investigating") | CLI (env) | 3              |
| `Hood` process events (`web/www/hood.js`)                                  | code      | 3              |

## Scope

Out of scope, and no phase builds it:

- clai itself. The app sets `LOG_LEVEL` on the runs it starts; clai's own default stays `info` for
  everyone else (Q1). If M1 finds a secret in clai's debug records, that is a bug against clai's
  diagnostics (F7 redaction), and the app runs clai at the highest level M1 shows clean until it
  is fixed.
- Sending a log anywhere: no upload, telemetry or issue creation. The user copies or downloads it.
- A retry button on the note; Transcribe again already re-runs a kept recording.
- Penelope reading a run log to explain a failure. This is a good follow-up once logs exist.
- Order of work: this worklog starts after `2026-11-18-penelope-known-voices` closes. Its open R1
  fixes edit the same `minutes.js` paths (`answer`, `writeTranscript`, `choose`) that phase 3 edits.

## Root facts

**E1 — No secret leaves the page in a log.** `text(job)`, and so the copied text and the downloaded
file, replace every secret the page holds, as written and URL-encoded, with `‹secret: <name>›`.
`Authorization:` header values and `Bearer <token>` in any entry are replaced the same way.
Binds `RunLog.text`, the root.

**E2 — A log is whole and in order.** A job's log holds its head, and every command the job ran
(label, the line as run, start, end, exit status). It also holds what each command printed, the
job's clai `diagnostic`, `error` and `progress` records at the run's level, its tool calls and how
each ended (E8), the process events of its processes and the notes it raised, all in the order they
happened. Binds `RunLog.open`, `attach`, `add`, `ended`, `noted`, `text`, the
root.

**E3 — A failure note says why.** An error note about a failed command shows the app's sentence and
the cause: the command's label, exit status and its last lines on stderr. Binds `RunLog.cause`, the
`report` UI.

**E4 — Logging never changes a run.** If a log cannot be kept, persisted or copied, the job's result,
files, commits and notes stay as they would be without the log. A failed copy or download says so
on the note. Binds `RunLog`, the root.

**E5 — A log is bounded.** An entry longer than the entry cap is cut, with a marker giving its full
length. An argument given as data (a command's positional arguments, a process's arguments after
its program) that is longer than the argument cap shows as its length only. So base64, audio and
file texts never enter a log (known-voices R1-06). A log over the log cap keeps its head and its newest entries, and marks where it cut. Binds `RunLog.add`,
`RunLog.attach`, `RunLog.text`.

**E6 — Debug detail stays in the log.** clai records below the terminal level go to the run log
only. No diagnostic record reaches a note, the meeting view or Penelope's context. A clean run
puts up nothing (known-voices P5); its log is kept like a failed run's. Binds `RunLog.close`,
the root.

**E7 — The filed meeting is the one that reads.** `writeTranscript` reads the paths the run named in
order (linked, written, transcribed again, the job's own). It files the transcript at the first one
that reads, and fails only when none reads. Binds `summariesIn` and the root.

**E8 — Diagnostics only, no model output.** A log holds no model output. A reply, its deltas and the
thinking appear as one entry each with their kind and length. A tool call keeps its name, and each
argument value no longer than the argument cap (`path`, `devices`, `silence_timeout_seconds`); a
longer value shows as its length. A tool that succeeded shows `ok` and the length of what it
returned; one that failed keeps its error text. A body the page reads through `/run/page/out` (a
meeting's files, a transcription) shows as its topic and length. Binds `RunLog.add`, `RunLog.text`.

| Parameter                                 | Default                                                                 | Decided by                                          |
| ----------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| `LOG_LEVEL` on the app's clai runs        | `debug`, set by the app; clai unchanged                                 | Maintainer, 2026-11-19 (Q1); M1 checks it           |
| clai records shown on the terminal from   | `info`                                                                  | Proposal                                            |
| Entry cap                                 | 8 KiB                                                                   | Proposal                                            |
| Log cap                                   | 2 MiB                                                                   | Proposal                                            |
| Lines of stderr in a note's cause         | 5                                                                       | Proposal                                            |
| Argument cap                              | 200 characters                                                          | Proposal                                            |
| Logs kept across reloads                  | every run, failed or clean, the newest 10, in IndexedDB                 | Maintainer, 2026-11-19 (Q2), widened 2026-11-20     |
| Model output in a log                     | none: kind and length only (E8)                                         | Maintainer, 2026-11-19 (Q3)                         |
| Download file name                        | `penelope-<start>_<slug>-<job kind>.log`                                | Proposal                                            |

## Validation policy

### Gates

```sh
cd web && node --test units.test.mjs
cd web && node check.mjs
```

The golden `web/goldens/run-lines.json` is regenerated by `cd web && UPDATE_GOLDENS=1 node check.mjs`.
Phase 3 changes it, because the clai line gains `LOG_LEVEL`.

### Human checks

| Node | Command                                                                                                                                                       | Certified by                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| root | M1, before phase 3 starts: one real meeting-transcriber run (OpenRouter, 2 min of speech) at `LOG_LEVEL=debug`; count the bytes of `diagnostic` records, then search them for the key and for `Authorization` | a note under `codebases/imago/clai-in-wasmer-sh-poc/` with the size per minute and no secret found |
| root | `make deploy`; on the deployed site, make a run fail (sign out of slivingdoc during a recording), then Copy log and paste it into an editor                       | the note names the failed command and its stderr; the pasted log is whole and holds no secret        |

## Findings

| ID  | Severity | Node | Owner | Status | Summary |
| --- | -------- | ---- | ----- | ------ | ------- |
| A01 | quality andon | root | maintainer | Closed b146a55+wip | environment (the `web/www/clai.wasm` of 2026-11-20 08:57 against this tree, not rebuilt while `components/clai` is being edited) · `cd web && node check.mjs` · 14 FAIL lines before any change of this worklog: the trust check before a run (`-check` exits 2), a hub version published during a meeting, two meetings at once (Stop), replies to two meetings, the time left of a short recording, the pop-out's Stop, a Stop at once · b146a55+wip |

## Decisions (maintainer, 2026-11-19)

- **Q1 — Where the high level lives:** the app sets `LOG_LEVEL=debug` on the clai runs it starts.
  No change to clai.
- **Q2 — Which runs keep a log:** failed runs, persisted (newest 10); this is what matters. Revisit
  if logs grow too big. Clean runs were left open. The proposal keeps the newest 5 in memory for
  the session only, because a clean run can still file the wrong thing (the paraphrased transcript
  of 2026-11-18 was a clean run). Dropping them is a one-line change.
  **Amended 2026-11-20:** clean runs are kept across reloads like failed ones (newest 10 in all): an
  88-minute meeting ran clean yet came out labelled `unknown-N`, and its log is what debugs it.
- **Q3 — Content:** diagnostics only; no model output (E8).
- **Q4 — Where Copy and Download live:** on the failure note and under the peek. The maintainer left
  the UX open; this frontend worklog stays lean, so phase 3 builds the proposal below and the
  maintainer corrects it by feel.
  - The failure note: the cause in a small monospace block under the app's sentence, then
    **Copy log** (main), **Download** and the existing *See what the machine printed*. Copy log says
    *Copied* for two seconds.
  - The peek gains a fourth tab, **Run logs**, after Terminal. It has one row per kept log, newest
    first: the time, the job kind and meeting title, *failed: <note title>* in red or *clean*, the
    size, then Copy and Download. A row from an earlier session shows its date.

## Session journal

- 2026-11-19 · plan · README drafted from the failure of 2026-11-19 (Background); waits on Q1–Q4 and the README sign-off
- 2026-11-19 · plan · README amended: Q1–Q4 answered by the maintainer (Goal, Glossary, Imports, E2, E5, E6, new E8, parameters, Decisions with the Q4 UX proposal)
- 2026-11-20 · plan · README amended: Q2 widened, clean runs' logs kept across reloads (E6, parameters, Copy a log later); the order of work holds, as penelope-known-voices has only R1-09 (human checks) open
- 2026-11-20 · maintainer · README signed ("Add the diagnostics", answering the proposal to sign it with clean runs' logs kept)
- 2026-11-20 · plan · phase files 1–3 written from the signed README; no validation round and no interface sign-off (orchestrator's brief: lean frontend worklog)
- 2026-11-20 · work · phase 1 · A01 · the start gate `node check.mjs` fails 14 checks on the unchanged tree; the phases are built on at the orchestrator's brief, each end gate held against that baseline
- 2026-11-20 · work · phase 1 Complete
- 2026-11-20 · work · phase 2 Complete
- 2026-11-20 · work · A01 closed · not by this session: `web/www/clai.wasm` was rebuilt at 14:18 by another session, and the gate passes against it · `cd web && node check.mjs`: ok, twice
- 2026-11-20 · work · phase 3 Complete
