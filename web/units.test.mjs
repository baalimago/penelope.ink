// The page's logic that needs no browser: the under-the-hood model the kernel's events build,
// and how Minutes reads the notebook and the agent's reply.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { Machine, describe, label, mask } from "./www/hood.js";
import { notePath, renderMarkdown } from "./www/markdown.js";
import { ORDER, STAGES, inOrder, isReady, pending, plan } from "./www/loadplan.js";
import { STEPS, barState } from "./www/loadbar.js";
import { CHECKLIST, doneLines, seenThrough } from "./www/arrival.js";
import { KINDS, groupLines, penMarkup, travelMs, writingMs } from "./www/pen.js";
import { DRY_MS, WAVE_MS, wetAt } from "./www/handwriting.js";
import { Doodles, wrapWords } from "./www/doodles.js";
import { inkPath } from "./www/sketch.js";
import { isShellLine } from "./www/shell.js";
import { AudioInputs, audioLimits, platformOf, withOsVersion } from "./www/audio.js";
import { AgentRun, brief, problemOf } from "./www/agent.js";
import { RecordPrinter } from "./www/records.js";
import {
  Fixes, align, clock, diffMarks, marksToHtml, named, offerWhere, parseUtterance, partsOf, resolveConflicts, singleChange, transcriptLines, transcriptRows,
} from "./www/proofread.js";
import { activityOf, correctionsOf, gaze, guideText, lunge, penelopeQuery, parseSay } from "./www/penelope.js";
import {
  DEFAULTS, Minutes, SILENCE_SECONDS, inputsToRecord, accountOf, conversationOf, digestOf, pinProfile, trustedDigest, untrustedProfile, precheck, notebookFormat, describeFile, groupMeetings, isRemote, meetingMeta, parseApproval, parseList, parseNote,
  parseSpaces, profilePage, signoutResult, splitMessage, summariesIn, unknownSpeakers,
  withFlags, withoutHeading,
} from "./www/minutes.js";
import {
  OPENROUTER_AUDIO, PROVIDERS, activeProvider, authorizeUrl, callbackMessage, challengeOf, exchangeCode, pkce, providerById, providerFlags, sha256Hex,
} from "./www/providers.js";
import {
  MCP_SERVERS, covers, discover, exchangeSignin, mcpState, register, revokeSignin, signinUrl, tokenEntry, tokenName, wellKnown, withServers,
} from "./www/connections.js";
import {
  PACE, PROVIDER_PACE, estimate, jobStatus, learnPace, leftText, listedJobs, newJob, phaseOf, recordingJob, stopFileOf, summaryOf, takeRecord,
  transcribeDetail, transcribedOf,
} from "./www/jobs.js";
import { isLive, popoutJobs, popoutRow, statusIcon, tabStatus } from "./www/popout.js";
import { addPeaks, drawInMs, fewer, inkLevels, recordingName, timeText, wavFormat, wavePath, waveSoFar, waveStrokes } from "./www/player.js";
import { toBase64 } from "./www/recordings.js";
import { Downloads } from "./www/downloads.js";
import { Installer } from "./www/install.js";
import { NotebookKeeper, restoreBatches } from "./www/notebookkeeper.js";
import { pageOf, turnsBack, turnsPage } from "./www/pageturn.js";
import { AGAIN_MS, IDLE_MS, Updates } from "./www/update.js";
import { againPath, againText, againWarning, canDelete, canTranscribeAgain, deleteAsk, deleteSaid, deleteWarning, retitled } from "./www/minutes.js";
import { VoiceKeeper } from "./www/voicekeeper.js";
import { SegmentKeeper } from "./www/segmentkeeper.js";
import { sameTitle, spokeIn } from "./www/people.js";
import { namingLine, rememberSpan, reviewRows } from "./www/review.js";
import { choosingStep, heardOf, learnedOf, namedIn, NAMING_STEP, peopleLine, voicesCommand, voicesFlag } from "./www/minutes.js";
import { execFileSync } from "node:child_process";
import { CAPS, RunLog, logName } from "./www/runlog.js";

const exec = (pid, ppid, path, argv, t = 1) => ({ t, type: "exec", pid, ppid, path, argv });

test("a line with a shell operator after its first word goes to bash whole", () => {
  for (const line of ["cd /tmp/m && go build .", "export A=1; ls", "cd /x | wc -l", "cd /x 2>/dev/null", "cd /x > out"])
    assert.ok(isShellLine(line), line);
  for (const line of ["cd /tmp/m", "export A=1 B=2", "help", "cd 'a > b'", 'cd "a && b"', "cd a\\>b"])
    assert.ok(!isShellLine(line), line);
});

test("a line's processes carry the tag of the bash that ran it", () => {
  const m = new Machine();
  m.add([
    exec(2, 1, "/bin/bash", ["bash", "-c", "cd -- '/home' || exit\nclai q hi", "minutes:Record#1"]),
    exec(3, 2, "/bin/clai", ["clai", "q", "hi"]),
    exec(4, 3, "/usr/bin/ffmpeg", ["ffmpeg", "-f", "pulse"]),
    exec(9, 1, "/bin/bash", ["bash", "-c", "ls", "terminal"]),
  ]);

  assert.deepEqual(m.find("minutes:Record#1", "ffmpeg").map((p) => p.pid), [4]);
  assert.equal(m.procs.get(9).action, "terminal");
  const [root] = m.tree("minutes:Record#1");
  assert.equal(root.proc.pid, 2);
  assert.equal(root.children[0].children[0].proc.name, "ffmpeg");
  assert.equal(describe(root.proc), "bash -c clai q hi");
});

test("bytes written through a copied descriptor count for the file", () => {
  const m = new Machine();
  m.add([
    exec(2, 1, "/bin/bash", ["bash", "-c", "echo hi > /tmp/a", "terminal"]),
    { t: 1, type: "open", pid: 2, fd: 3, path: "/tmp/a", write: true },
    { t: 1, type: "dup", pid: 2, from: 3, to: 1 },
    { t: 1, type: "close", pid: 2, fd: 3 },
    { t: 2, type: "io", pid: 2, fd: 1, dir: "out", bytes: 3 },
  ]);

  const file = m.resources.get("file:/tmp/a");
  assert.equal(file.out, 3);
  assert.deepEqual([...file.procs], ["bash"]);
});

test("a child execs with its parent's descriptors, but for those it changed", () => {
  const m = new Machine();
  m.add([
    exec(2, 1, "/bin/bash", ["bash", "-c", "x", "terminal"]),
    { t: 1, type: "open", pid: 2, fd: 5, path: "/tmp/out", write: true },
    { t: 1, type: "connect", pid: 2, fd: 6, host: "api.openai.com", port: 443 },
    { t: 1, type: "dup", pid: 7, from: 9, to: 6 },
    exec(7, 2, "/bin/cat", ["cat"]),
    { t: 2, type: "io", pid: 7, fd: 5, dir: "out", bytes: 10 },
    { t: 2, type: "io", pid: 7, fd: 6, dir: "out", bytes: 99 },
  ]);

  assert.equal(m.resources.get("file:/tmp/out").out, 10);
  assert.equal(m.resources.get("net:api.openai.com:443").out, 0);
});

test("an ended process's descriptors are forgotten", () => {
  const m = new Machine();
  m.add([
    exec(2, 1, "/bin/bash", ["bash", "-c", "x", "terminal"]),
    { t: 1, type: "open", pid: 2, fd: 5, path: "/tmp/out", write: true },
    { t: 2, type: "exit", pid: 2, code: 0 },
  ]);

  assert.equal(m.fds.size, 0);
  assert.equal(m.procs.get(2).status, "exit 0");
});

test("keys are masked wherever they show", () => {
  assert.equal(mask("OPENAI_API_KEY=sk-abcdefghijkl clai"), "OPENAI_API_KEY=sk-…ijkl clai");
  assert.equal(mask("TOKEN=short"), "TOKEN=…");
});

test("a notebook file names its meeting", () => {
  assert.deepEqual(describeFile("meetings/summaries/2026-10-30T08-00Z_daily-standup.md"), {
    start: "2026-10-30T08-00Z",
    title: "Daily standup",
  });
  assert.deepEqual(parseNote("---\ntitle: \"Daily\"\nduration: 15\n---\n# Notes\n"), {
    fields: { title: "Daily", duration: "15" },
    body: "# Notes\n",
  });
  assert.deepEqual(parseNote("no front matter"), { fields: {}, body: "no front matter" });
});

test("the agent's reply is its last reply record, whatever streamed before it", () => {
  const run = new AgentRun();
  for (const line of [
    '{"type":"reply_delta","text":"Let me "}',
    '{"type":"reply_delta","text":"record."}',
    '{"type":"reply","text":"Let me record."}',
    '{"type":"tool_call","name":"audio_record","inputs":{}}',
    '{"type":"tool_result","name":"audio_record","ok":true,"output":"saved /tmp/a.wav"}',
    '{"type":"diagnostic","name":"clai.run_summary","subsystem":"clai","level":"info","message":"query done","facts":{}}',
    '{"type":"reply_delta","text":"Who is "}',
    '{"type":"reply_delta","text":"Speaker A?"}',
    '{"type":"reply","text":"Who is Speaker A?"}',
    "",
  ]) run.take(line);
  assert.equal(run.text, "Who is Speaker A?");
  assert.deepEqual([run.errors, run.failures, run.warnings, run.stray], [[], [], [], []]);
  assert.equal(problemOf(run, 0), null);
});

test("a reply that never closed is what streamed of it", () => {
  const run = new AgentRun();
  run.take('{"type":"reply_delta","text":"Hello wor"}');
  assert.equal(run.text, "Hello wor");
});

test("a rejected key is a problem that names the status, clai's remedy and the provider's code", () => {
  const run = new AgentRun();
  const message = 'run step 0: stream completions: authentication failed, status: 401, provider code: invalid_api_key, body: {"error":{"message":"Incorrect API key provided"}}';
  run.take(JSON.stringify({ type: "error", message, causes: [{ message, status: 401, provider_code: "invalid_api_key", remedies: ["Set OPENAI_API_KEY to your API key"] }] }));
  assert.deepEqual(problemOf(run, 1), {
    level: "error",
    title: "The provider rejected the API key",
    detail: "authentication failed, status: 401, provider code: invalid_api_key",
    hint: "Set OPENAI_API_KEY to your API key",
    code: "invalid_api_key",
  });
});

test("an error without a status keeps clai's words, short", () => {
  const run = new AgentRun();
  const message = "failed to create text querier: failed to find text querier for model: opus-5.5";
  run.take(JSON.stringify({ type: "error", message, causes: [{ message }] }));
  const problem = problemOf(run, 1);
  assert.equal(problem.title, "The agent stopped with an error");
  assert.equal(problem.detail, message);
  assert.equal(brief(`run step 2: ${"x".repeat(400)}`).length, 220);
});

test("an interrupt and a cut-off reply say what they are", () => {
  const titled = (message) => {
    const run = new AgentRun();
    run.take(JSON.stringify({ type: "error", message, causes: [{ message }] }));
    return problemOf(run, 130).title;
  };
  assert.equal(titled("interrupted by signal: interrupt"), "The agent was interrupted");
  assert.equal(titled("run step 0: completion stream error: transport failure: the reply is truncated: unexpected EOF"), "The reply was cut off");
  assert.equal(titled("run step 0: completion stream error: unexpected provider response, status: 200, body: the provider returned no completion"), "The provider sent no reply");
});

test("a failed exit without an error record still is a problem, with the last thing said", () => {
  const run = new AgentRun();
  run.take("bash: clai: command not found");
  assert.deepEqual(run.stray, ["bash: clai: command not found"]);
  assert.deepEqual(problemOf(run, 127), {
    level: "error", title: "The agent stopped with exit status 127", detail: "bash: clai: command not found", hint: null, code: null,
  });
});

test("a run that printed no record and no reply died, even with a clean status", () => {
  const run = new AgentRun();
  run.take("panic: runtime error: index out of range");
  run.take("goroutine 1 [running]:");
  assert.equal(problemOf(run, 0).title, "The agent stopped unexpectedly");
  assert.equal(problemOf(run, 0).detail, "goroutine 1 [running]:");
  // A stray line beside a reply is not a failure.
  run.take('{"type":"reply","text":"All filed."}');
  assert.equal(problemOf(run, 0), null);
});

// What a printer writes for records, with the terminal's colours taken out.
const drawn = (records) => {
  const printer = new RecordPrinter();
  const text = records.map((r) => (typeof r === "string" ? printer.raw(r) : printer.print(r))).join("") + printer.end();
  return text.replace(/\x1b\[[0-9;]*m/g, "");
};

test("the terminal joins what streams into running text, and a reply is written once", () => {
  assert.equal(drawn([
    { type: "reasoning_delta", text: "The user" },
    { type: "reasoning_delta", text: " wants notes." },
    { type: "reply_delta", text: "I will " },
    { type: "reply_delta", text: "record\nnow." },
    { type: "reply", text: "I will record\nnow." },
    { type: "reply", text: "Whole." },
  ]), "thinking The user wants notes.\r\nI will record\r\nnow.\r\nWhole.\r\n");
});

test("the terminal shows a tool as a line and its result under it", () => {
  assert.equal(drawn([
    { type: "tool_call", name: "audio_sources", inputs: {} },
    { type: "tool_call", name: "audio_record", inputs: { dir: "/tmp/recordings", mic: true, devices: ["browser-mic"] } },
    { type: "tool_result", name: "audio_sources", ok: true, output: "system_audio: available\nmic one\nmic two\n" },
    { type: "tool_result", name: "fs", ok: false, output: "ERROR: Access denied", error: "Access denied" },
  ]), "▸ audio_sources\r\n▸ audio_record dir=/tmp/recordings mic=true devices=[\"browser-mic\"]\r\n" +
    "  ✓ audio_sources: system_audio: available (+2 more lines)\r\n  ✗ fs: Access denied\r\n");
});

test("the terminal redraws one line for a progress, and ends it when it is done", () => {
  const erase = "\r\x1b[2K";
  const printer = new RecordPrinter();
  const text = [
    { type: "progress", title: "audio_record", state: "start", detail: "/tmp/rec" },
    { type: "progress", title: "audio_record", state: "update", detail: "silent" },
    { type: "progress", title: "audio_record", state: "update", detail: "sound" },
    { type: "progress", title: "audio_record", state: "done", detail: "saved" },
    { type: "reply", text: "Filed." },
  ].map((r) => printer.print(r)).join("").replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(text, `… audio_record start /tmp/rec${erase}… audio_record update silent${erase}… audio_record update sound` +
    `${erase}… audio_record done saved\r\nFiled.\r\n`);
});

test("the terminal shows an error with its status, code and hint, and other lines as they are", () => {
  const message = "authentication failed, status: 401";
  assert.equal(drawn([
    { type: "reply_delta", text: "Let me" },
    { type: "error", message, causes: [{ message, status: 401, provider_code: "invalid_api_key", remedies: ["Set OPENAI_API_KEY"] }] },
    { type: "diagnostic", level: "warn", subsystem: "clai", message: "shutting down gracefully", facts: { signal: "interrupt" } },
    { type: "prompt", kind: "calibrate", text: "silence levels may not match", choices: ["a"] },
    "bash: clai: command not found",
  ]), "Let me\r\nerror: authentication failed, status: 401\r\n  status 401 · invalid_api_key\r\n  hint: Set OPENAI_API_KEY\r\n" +
    "warn [clai] shutting down gracefully signal=interrupt\r\n? silence levels may not match [a]\r\nbash: clai: command not found\r\n");
});

test("a tool that failed is kept for the run's problem, and alone does not stop the run", () => {
  const run = new AgentRun();
  run.take(JSON.stringify({
    type: "tool_result", name: "audio_sources", ok: false,
    output: "ERROR: failed to run tool: audio_sources, error: ffmpeg -sinks pulse failed: exit status 127: /bin/bash: /usr/local/bin/ffmpeg: No such file or directory",
    error: "failed to run tool: audio_sources, error: ffmpeg -sinks pulse failed: exit status 127: /bin/bash: /usr/local/bin/ffmpeg: No such file or directory",
  }));
  assert.equal(run.failures[0].name, "audio_sources");
  // The run itself went on, so nothing stopped it and nothing is put up.
  assert.equal(problemOf(run, 0), null);
  // A run that then failed says what the tool said, when nothing else did.
  assert.match(problemOf(run, 1).detail, /ffmpeg -sinks pulse failed/);
});

test("the process tree folds a wrapper into its program and draws its lines", () => {
  const m = new Machine();
  m.add([
    exec(2, 1, "/bin/bash", ["bash", "-c", "clai q", "minutes:Record#1"]),
    exec(3, 2, "/bin/clai", ["clai", "q"]),
    exec(4, 3, "/usr/local/bin/ffmpeg", ["ffmpeg", "-sources", "pulse"]),
    exec(5, 3, "/usr/local/bin/ffmpeg", ["ffmpeg", "-f", "pulse", "-i", "browser-mic"]),
    exec(6, 5, "/bin/ffmpeg", ["ffmpeg", "-f", "s16le", "-i", "/run/audio/mic"]),
  ]);

  assert.deepEqual(m.rows("minutes:Record#1").map((r) => `${r.prefix}${r.proc.pid}`), ["2", "└ 3", "  ├ 4", "  └ 5"]);
  assert.deepEqual(label(m.procs.get(5)), { note: "WASI", tag: "recording" });
  assert.equal(label(m.procs.get(4)).note, "lists audio devices");
  assert.equal(label(m.procs.get(3)).note, "the agent · Go, GOOS=wasix");
});

test("the notebook's listing gives each meeting its title, date and duration", () => {
  const body = "@@ meetings/summaries/2026-10-29T09-00Z_design-review.md\ntitle: Design review\nduration: 38\n---\n" +
    "@@ meetings/summaries/2026-10-30T08-00Z_daily-sync.md\n";
  const [first, second] = parseList(body);

  assert.equal(first.title, "Daily sync");
  assert.equal(first.date.toISOString(), "2026-10-30T08:00:00.000Z");
  assert.equal(first.duration, null);
  assert.equal(second.title, "Design review");
  assert.equal(second.duration, 38);
});

test("meetings group by day and say when and how long", () => {
  const now = new Date(2026, 9, 30, 15, 0);
  const at = (day, hour) => ({ date: new Date(2026, 9, day, hour, 0), duration: 38 });
  const groups = groupMeetings([at(30, 9), at(28, 10), at(1, 10)], now);

  assert.deepEqual(groups.map((g) => [g.label, g.items.length]), [["Today", 1], ["This week", 1], ["Earlier", 1]]);
  assert.match(meetingMeta(at(28, 10), now), /^\S+ · 38 min$/);
  assert.equal(meetingMeta({ date: null, duration: 0.2 }, now), "<1 min");
});

test("the agent's links to the notebook open in the app, and its HTML stays text", () => {
  const reply = "- [Transcript](file:///home/user/notebook/meetings/transcripts/2026-10-30T13-48Z_daily-sync.md)\n" +
    "- [Summary](file:///home/user/notebook/meetings/summaries/2026-10-30T13-48Z_daily-sync.md)\n\n" +
    "**Summary:** <img src=x onerror=alert(1)> [x](javascript:alert(1)) [docs](https://example.com)";
  const html = renderMarkdown(reply);

  assert.deepEqual(summariesIn(reply), ["meetings/summaries/2026-10-30T13-48Z_daily-sync.md"]);
  assert.equal(notePath("meetings/summaries/a.md"), "meetings/summaries/a.md");
  assert.equal(notePath("https://example.com"), null);
  assert.match(html, /<a href="#" data-note="meetings\/transcripts\/2026-10-30T13-48Z_daily-sync.md">Transcript<\/a>/);
  assert.match(html, /<strong>Summary:<\/strong> &lt;img/);
  assert.doesNotMatch(html, /javascript:|<img/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener">docs<\/a>/);
  // Only the blocks the app knows are pointed at; any other in-page link stays text.
  assert.equal(renderMarkdown("[a](#provider-card) [b](#app) [c](#notebook-card-x)").trim(),
    '<p><a href="#" data-point="provider-card">a</a> b c</p>');
});

test("slivingdoc's login gives its sign-in page and code, then who approved it", () => {
  const lines = ["To log in, open this page and approve the code FDFS-RLGM:"];
  assert.equal(parseApproval(lines), null);
  lines.push("  https://www.slivingdoc.dev/cli/login#FDFS-RLGM", "(or open https://www.slivingdoc.dev/cli/login and enter the code)");

  assert.deepEqual(parseApproval(lines), { code: "FDFS-RLGM", url: "https://www.slivingdoc.dev/cli/login#FDFS-RLGM" });
  assert.equal(accountOf('{"logins":[{"Key":"k","Account":"ada@example.com"}]}'), "ada@example.com");
  assert.equal(accountOf("not json"), null);
});

test("a sign-out forgets a login only once its key is revoked", () => {
  assert.deepEqual(signoutResult({ account: "ada@example.com", tokenOnly: false, status: 0 }), {
    revoked: true,
    message: "Signed out of ada@example.com.",
    page: null,
  });
  const failed = signoutResult({
    account: "ada@example.com",
    tokenOnly: false,
    status: 1,
    said: "logout: the login key could not be revoked and stays stored; retry",
  });
  assert.equal(failed.revoked, false);
  assert.match(failed.message, /^Signing out of ada@example\.com failed: logout: the login key could not be revoked/);
  assert.equal(failed.page, "https://www.slivingdoc.dev/tokens");
});

test("a token-only sign-out says the key outlives the tab", () => {
  const result = signoutResult({ account: null, tokenOnly: true, status: 0 });

  assert.equal(result.revoked, true);
  assert.match(result.message, /stays valid until it is revoked on slivingdoc\.dev\.$/);
  assert.equal(result.page, "https://www.slivingdoc.dev/tokens");
});

test("a login's spaces, and its default one", () => {
  const none = "HOSTED  https://api.slivingdoc.dev  ada@example.com\n  main  write  ada@example.com\n" +
    "  notes (meetings)  read  ada@example.com\nNo default space; run 'slivingdoc space <name>' to choose one.\n";
  assert.deepEqual(parseSpaces(none), { names: ["main", "notes"], current: null });
  assert.deepEqual(parseSpaces("HOSTED  https://api.slivingdoc.dev  ada\n  main  write  ada\n* notes  write  ada\n"),
    { names: ["main", "notes"], current: "notes" });
});

test("a hub profile is trusted before it runs, and its page says what it runs", () => {
  assert.equal(isRemote("cchub:baalimago/meeting-transcriber@13"), true);
  assert.equal(isRemote("/tmp/meeting.json"), false);
  assert.equal(profilePage("cchub:baalimago/meeting-transcriber@13"), "https://www.clai.chat/hub/baalimago/meeting-transcriber/");
  assert.equal(profilePage("gh:a/b/c.json@v1"), null);
});

test("the agent the app runs is the hub's latest, with no version pin", () => {
  assert.equal(DEFAULTS.profile, "cchub:baalimago/meeting-transcriber");
  assert.equal(isRemote(DEFAULTS.profile), true);
  assert.equal(profilePage(DEFAULTS.profile), "https://www.clai.chat/hub/baalimago/meeting-transcriber/");
});

test("a message names its topic on its first line, and its body stays bytes", () => {
  const { topic, body } = splitMessage(new Uint8Array([...new TextEncoder().encode("recording-part\n"), 0, 10, 255]));
  assert.equal(topic, "recording-part");
  assert.deepEqual([...body], [0, 10, 255]);
  assert.deepEqual(splitMessage(new TextEncoder().encode("recording-end")).body.length, 0);
});

test("a scribbled log line wraps at spaces instead of being cut", () => {
  const line = "exec: clai q Answer who Speaker A is, then write the summary · pid 31";
  const lines = wrapWords(line, 24, 8);
  assert.equal(lines.join(" "), line);
  assert.ok(lines.every((l) => l.length <= 24));
});

test("a scribbled word longer than a line breaks across lines", () => {
  assert.deepEqual(wrapWords("fs: /home/user/notebook/meetings", 12, 8), ["fs:", "/home/user/n", "otebook/meet", "ings"]);
});

test("a scribbled log line past the last rule ends in an ellipsis", () => {
  const lines = wrapWords("a b c d e f g h", 3, 2);
  assert.deepEqual(lines, ["a b", "c …"]);
});

test("a transcript's speakers without a name, each with a line they said", () => {
  const transcript = [
    "# Transcript", "",
    "**Speaker A:** Hi.",
    "**Speaker A:** Let us ship the peek on Friday.",
    "- Unknown speaker [00:12]: I can review it tomorrow morning.",
    "**Ada:** Sounds good.",
    "Speaker B: Fine.",
  ].join("\n");
  assert.deepEqual(unknownSpeakers(transcript), [
    { label: "Speaker A", sample: "Let us ship the peek on Friday.", start: null, end: null },
    { label: "Unknown speaker", sample: "I can review it tomorrow morning.", start: 12, end: 22 },
    { label: "Speaker B", sample: "Fine.", start: null, end: null },
  ]);
  assert.deepEqual(unknownSpeakers("**Ada:** Hi.\n**Grace:** Hello."), []);
  assert.deepEqual(unknownSpeakers("[00:00:14.550 --> 00:00:21.550] Speaker B: I think when you do it."), [
    { label: "Speaker B", sample: "I think when you do it.", start: 14.55, end: 21.55 },
  ]);
  // With start times only, a line plays to the next one's start, and a long one only so far.
  assert.deepEqual(unknownSpeakers("[0:25] Speaker A: Mm.\n[0:29] Speaker B: Mm-hmm.\n[0:32] Speaker A: I think we all heard it.\n[1:30] Speaker B: Yes."), [
    { label: "Speaker A", sample: "I think we all heard it.", start: 32, end: 42 },
    { label: "Speaker B", sample: "Mm-hmm.", start: 29, end: 32 },
  ]);
});

test("a note's own Summary or Transcript heading goes, the card has one", () => {
  assert.equal(withoutHeading("## Summary\n\n- Ship it", "summary"), "- Ship it");
  assert.equal(withoutHeading("# Meeting transcript\nAda: hi", "transcript"), "Ada: hi");
  assert.equal(withoutHeading("- Ship it\n## Summary", "summary"), "- Ship it\n## Summary");
});


// The site's lists as `make` writes them (bin/index.json with clai first, packages/index.json).
const SITE_PROGRAMS = [
  { name: "clai", file: "clai.wasm" },
  ...["duckduckgo-mcp-server", "mcp-server-filesystem", "slivingdoc", "slivingdoc-git2", "ffmpeg", "ffprobe"].map((name) => ({ name, file: `bin/${name}.wasm` })),
  { name: "npx", file: "bin/launcher.sh" }, { name: "uvx", file: "bin/launcher.sh" },
  ...["ffmpeg", "play", "cp", "download"].map((name) => ({ name, file: `bin/${name}.sh`, dir: "/usr/local/bin" })),
];
const SITE_PACKAGES = ["bash", "coreutils", "grep", "sed", "findutils", "ripgrep", "fd"].map((name) => ({ name: `wasmer/${name}`, file: `wasmer-${name}-1.0.0.webc` }));

test("a download's parts come together as one file under its name, beside another's, and other messages pass by", async () => {
  const saved = [];
  const downloads = new Downloads((blob, name) => saved.push({ blob, name }));
  const encode = (text) => new TextEncoder().encode(text);
  const message = (topic, body) => new Uint8Array([...encode(`${topic}\n`), ...(typeof body === "string" ? encode(body) : body)]);
  assert.equal(downloads.receive(message("download-part 7.1.1", "hello ")), true);
  downloads.receive(message("download-part 8.2.1", "still coming"));
  downloads.receive(message("download-part 7.1.1", new Uint8Array([0, 10, 255])));
  assert.equal(downloads.receive(message("download-end 7.1.1", "notes.txt")), true);
  // An empty file sends no part, only its end.
  downloads.receive(message("download-end 9.3.1", "empty.txt"));
  assert.equal(downloads.receive(message("transcribed", "download-part 1")), false);
  assert.deepEqual(saved.map(({ name }) => name), ["notes.txt", "empty.txt"]);
  assert.deepEqual([...new Uint8Array(await saved[0].blob.arrayBuffer())], [...encode("hello "), 0, 10, 255]);
  assert.equal(saved[1].blob.size, 0);
  assert.deepEqual([...downloads.parts.keys()], ["8.2.1"]);
});

test("the machine boots with bash, the basic tools and the wrappers, and the rest comes in the order a recording needs", () => {
  const { programs, packages, late } = plan(SITE_PROGRAMS, SITE_PACKAGES);
  assert.deepEqual(programs.map((p) => `${p.dir ?? "/bin"}/${p.name}`), ["/bin/npx", "/bin/uvx", "/usr/local/bin/ffmpeg", "/usr/local/bin/play", "/usr/local/bin/cp", "/usr/local/bin/download"]);
  assert.deepEqual(packages.map((p) => p.name), ["wasmer/bash", "wasmer/coreutils", "wasmer/grep", "wasmer/sed", "wasmer/findutils"]);
  assert.deepEqual(late.map((l) => `${l.stage}:${l.name}`), [
    "agent:clai",
    "record:ffmpeg", "record:ffprobe", "record:mcp-server-filesystem", "record:slivingdoc-git2", "record:slivingdoc",
    "extras:duckduckgo-mcp-server", "extras:rg", "extras:fd",
  ]);
  // A late program goes to /bin under its name; a late package says which commands /bin waits for.
  assert.deepEqual(late.filter((l) => l.program).map((l) => [l.program, l.url]).slice(0, 2), [["clai", "./clai.wasm"], ["ffmpeg", "./bin/ffmpeg.wasm"]]);
  assert.deepEqual(late.filter((l) => l.commands).map((l) => [l.url, l.commands]), [
    ["./packages/wasmer-ripgrep-1.0.0.webc", ["rg"]], ["./packages/wasmer-fd-1.0.0.webc", ["fd"]],
  ]);
  // A site without a planned file boots with what it has.
  assert.deepEqual(plan([{ name: "clai", file: "clai.wasm" }], []).late.map((l) => l.name), ["clai"]);
});

test("a stage is ready once it and every stage before it are on the machine", () => {
  const file = (stage, state) => ({ stage, state });
  assert.deepEqual(ORDER, ["machine", ...STAGES.map((s) => s.id)]);
  assert.deepEqual(pending(null), ORDER);
  assert.ok(!isReady(null, "machine"));
  const booted = [file("machine", "installed"), file("agent", "installed"), file("agent", "fetching"), file("record", "queued"), file("extras", "installed")];
  assert.deepEqual(pending(booted), ["agent", "record", "extras"]);
  assert.ok(isReady(booted, "machine") && !isReady(booted, "agent") && !isReady(booted, "extras"));
  // A recording waits for the agent's programs too, whatever came first.
  const failed = [file("machine", "installed"), file("agent", "failed"), file("record", "installed")];
  assert.ok(!isReady(failed, "record"));
  assert.deepEqual(pending([file("machine", "installed"), file("agent", "installed"), file("record", "installed")]), []);
});

test("late files start in the plan's order, a few at a time", async () => {
  const started = [];
  let running = 0;
  let most = 0;
  await inOrder(["a", "b", "c", "d", "e"], 2, async (name) => {
    started.push(name);
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, name === "a" ? 20 : 1));
    running--;
  });
  assert.deepEqual(started, ["a", "b", "c", "d", "e"]);
  assert.equal(most, 2);
});

test("the arrival's checklist ticks each line once its piece is in", () => {
  assert.deepEqual(CHECKLIST.map((line) => line.id), ["machine", "penelope", "login", "notes", "recorder", "tools"]);
  const done = (phase, loading) => [...doneLines(phase, loading)].sort();
  // Before the machine's first report nothing is ready, whatever the phase says.
  assert.deepEqual(done("booting", undefined), []);
  assert.deepEqual(done("checking", undefined), ["machine"]);
  assert.deepEqual(done("booting", "agent record extras"), []);
  assert.deepEqual(done("checking", "agent record extras"), ["machine"]);
  assert.deepEqual(done("fetching", "record extras"), ["login", "machine", "penelope"]);
  assert.deepEqual(done("listing", "extras"), ["login", "machine", "penelope", "recorder"]);
  assert.deepEqual(done("ready", ""), ["login", "machine", "notes", "penelope", "recorder", "tools"]);
  // A stage still loading keeps its line open, and those of the stages after it.
  assert.deepEqual(done("ready", "agent record extras"), ["login", "machine", "notes"]);
});

test("the load bar says what is loading, how much, and what is not ready until then", () => {
  const f = (stage, name, state, got, bytes = 2_000_000) => ({ stage, name, state, got, bytes });
  assert.deepEqual(barState({ files: null, phase: "booting" }), {
    text: STEPS.booting, detail: "0.0 MB · not ready yet: the machine, Penelope, recording, the other tools", fraction: null, action: null,
  });
  const loading = [f("machine", "wasmer/bash", "installed", 2_000_000), f("agent", "clai", "fetching", 500_000), f("record", "slivingdoc", "queued", 0), f("extras", "fd", "queued", 0)];
  assert.deepEqual(barState({ files: loading, phase: "listing" }), {
    text: STEPS.listing, detail: "2.5 of 8.0 MB · not ready yet: Penelope, recording, the other tools", fraction: 2.5 / 8, action: null,
  });
  assert.equal(barState({ files: loading, phase: "ready" }).text, "Loading Penelope…");
  // What runs on the machine and waits for a program says so.
  assert.match(barState({ files: loading, phase: "ready", waiting: ["clai"] }).detail, / · a run waits for clai$/);
  const recording = loading.map((file) => (file.stage === "agent" ? { ...file, state: "installed", got: 2_000_000 } : file));
  assert.equal(barState({ files: recording, phase: "ready" }).text, "Getting ready to record…");
  // A size not known yet leaves the whole out.
  assert.match(barState({ files: [...loading, f("extras", "x", "queued", 0, null)], phase: "ready" }).detail, /^2\.5 MB · /);
});

test("the load bar offers to try a failed program again, and goes once everything is in", () => {
  const f = (stage, name, state, error) => ({ stage, name, state, got: 0, bytes: 1_000_000, error });
  const failed = barState({ files: [f("machine", "wasmer/bash", "installed"), f("agent", "clai", "failed", "cannot fetch ./clai.wasm in 4 tries: status 503")], phase: "ready" });
  assert.equal(failed.text, "Could not load clai.");
  assert.equal(failed.detail, "cannot fetch ./clai.wasm in 4 tries: status 503. Not ready yet: Penelope, recording, the other tools.");
  assert.equal(failed.action, "Try again");
  assert.deepEqual(barState({ stopped: "The machine did not start: no kernel." }), { text: "The machine did not start.", detail: "The machine did not start: no kernel.", fraction: null, action: "Reload" });
  const done = [f("machine", "wasmer/bash", "installed"), f("agent", "clai", "installed")];
  assert.equal(barState({ files: done, phase: "ready" }), null);
  // The notes are still being fetched: the bar stays to say so.
  assert.deepEqual(barState({ files: done, phase: "fetching" }), { text: STEPS.fetching, detail: "", fraction: null, action: null });
});

// The kernel `make build` wrote, booted here: Node runs it as the page's worker does.
const KERNEL = new URL("./www/pkg/clai_web_bg.wasm", import.meta.url);
const PACKAGE = (name) => new URL(`./www/packages/${JSON.parse(readFileSync(new URL("./www/packages/index.json", import.meta.url), "utf8")).find((p) => p.name === name).file}`, import.meta.url);
const built = existsSync(KERNEL) && existsSync(new URL("./www/packages/index.json", import.meta.url));
let kernelReady = null;
const kernel = () => (kernelReady ??= import("./www/pkg/clai_web.js").then((module) => {
  module.initSync({ module: readFileSync(KERNEL) });
  return module;
}));
// (module (import "wasi_snapshot_preview1" "proc_exit" (func (param i32))) (memory (export "memory") 1)
//   (func (export "_start") (call 0 (i32.const STATUS))))
const exits = (status) => new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 8, 2, 96, 1, 127, 0, 96, 0, 0, 2, 36, 1, 22, ...Buffer.from("wasi_snapshot_preview1"), 9, ...Buffer.from("proc_exit"), 0, 0,
  3, 2, 1, 1, 5, 3, 1, 0, 1, 7, 19, 2, 6, ...Buffer.from("memory"), 2, 0, 6, ...Buffer.from("_start"), 0, 1, 10, 8, 1, 6, 0, 65, status, 16, 0, 11,
]);
const settled = async (promise) => Promise.race([promise.then((value) => ({ value }), (error) => ({ error: String(error) })), new Promise((r) => setTimeout(() => r(null), 150))]);

test("a program that comes after the boot is in /bin and /usr/bin from the start, and what runs it waits for it", { skip: !built }, async () => {
  const { boot } = await kernel();
  const shell = await boot(new Uint8Array(), ["now"], [exits(7)], ["now"], [exits(9)], [], ["late", "now"], ["never"], 24, 80);
  // What the boot has runs at once, the wrapper in /usr/local/bin apart from the program in /bin.
  assert.equal(await shell.run("/bin/now", ["now"], []), 7);
  assert.equal(await shell.run("/usr/local/bin/now", ["now"], []), 9);
  const runs = ["/bin/late", "/usr/bin/late"].map((path) => shell.run(path, ["late"], []));
  assert.equal(await settled(runs[0]), null);
  assert.deepEqual(shell.waited_for(), ["late"]);
  // A name nothing brings is not waited for.
  assert.match((await settled(shell.run("/bin/nope", ["nope"], []))).error, /no such file or directory/);
  // The program the boot had keeps its name: the late one of that name is left out.
  assert.deepEqual([...await shell.install(["late", "now"], [exits(5), exits(6)], [], [])], []);
  assert.deepEqual(await Promise.all(runs), [5, 5]);
  assert.deepEqual(shell.waited_for(), []);
  assert.equal(await shell.run("/usr/bin/now", ["now"], []), 7);
  // A command no package had is no longer waited for.
  const never = shell.run("/bin/never", ["never"], []);
  assert.equal(await settled(never), null);
  assert.deepEqual([...await shell.install([], [], [], ["never"])], ["no package that came has the command never"]);
  assert.match((await settled(never)).error, /no such file or directory/);
});

test("a package that comes after the boot runs from bash as one mounted at the boot does", { skip: !built }, async () => {
  const { boot } = await kernel();
  const webc = (name) => new Uint8Array(readFileSync(PACKAGE(name)));
  const shell = await boot(new Uint8Array(), [], [], [], [], [webc("wasmer/bash")], [], ["rg", "ls", "head", "grep"], 24, 80);
  const said = () => new TextDecoder().decode(shell.take_output()).replaceAll("\r", "");
  // bash finds a command that is still coming, and waits as it starts it.
  const line = "command -v rg ls; rg --version | head -n 1; ls -d /opt/ripgrep/licenses; ls /usr/bin | grep -c -x -e rg -e ls -e bash";
  const run = shell.run("/bin/bash", ["bash", "-c", line], []);
  assert.equal(await settled(run), null);
  assert.deepEqual(shell.waited_for(), ["rg", "head"]);
  assert.deepEqual([...await shell.install([], [], [webc("wasmer/ripgrep"), webc("wasmer/coreutils"), webc("wasmer/grep")], ["rg", "ls", "head", "grep"])], []);
  assert.equal(await run, 0);
  assert.match(said(), /^\/bin\/rg\n\/bin\/ls\nripgrep \d+\.\d+\.\d+.*\n\/opt\/ripgrep\/licenses\n3\n$/);
});

test("a pen writes text line by line, the rects of one line taken together", () => {
  const rect = (left, top, width, height = 30) => ({ left, top, right: left + width, bottom: top + height });
  const lines = groupLines([rect(200, 40, 50), rect(10, 0, 100), rect(112, 2, 60, 26), rect(10, 40, 180), rect(5, 90, 0)]);
  assert.deepEqual(lines, [
    { left: 10, right: 172, top: 0, bottom: 30 },
    { left: 10, right: 250, top: 40, bottom: 70 },
  ]);
  assert.deepEqual(groupLines([]), []);
});

test("a pen takes longer over more text, within bounds", () => {
  assert.equal(writingMs(10), 260);
  assert.ok(writingMs(300) > writingMs(200));
  assert.equal(writingMs(5000), 1700);
});

test("new notes dry in one wave down the screen, however many blocks are on it", () => {
  assert.equal(wetAt(0, 1), 0);
  assert.deepEqual([0, 1, 2].map((i) => wetAt(i, 3)), [0, WAVE_MS / 2, WAVE_MS]);
  assert.equal(wetAt(399, 400), WAVE_MS);
  assert.ok(WAVE_MS + DRY_MS <= 2500, "the last block is dry within 2.5 s");
});

test("a pen hops a short way quickly and a long way unhurried, and the page's pens are pens but one", () => {
  assert.equal(travelMs(0), 140);
  assert.ok(travelMs(40) < travelMs(300));
  assert.equal(travelMs(5000), 600);
  assert.equal(KINDS.length, 6);
  assert.equal(KINDS.filter((k) => k.includes("#e98a8f")).length, 1, "one pencil, with its eraser");
  assert.match(penMarkup(0, 0.9), /^<g transform="scale\(0.9\) rotate\(28\)">/);
});

test("each meeting is a page of the pad in the order it was held, with New recording the blank page after them", () => {
  const page = (path) => pageOf("meeting", { path: `meetings/summaries/${path}` }, null);
  const older = page("2026-11-19T16-01Z_retro.md");
  const newer = page("2026-11-21T09-00Z_daily-sync.md");
  const run = pageOf("meeting", null, { id: 4 });
  // An older page comes back down over the binding; a newer one is under the page that turns up.
  assert.equal(turnsBack(newer, older), true);
  assert.equal(turnsBack(older, newer), false);
  assert.equal(turnsBack("record", older), true);
  assert.equal(turnsBack(older, "record"), false);
  // A run that filed nothing yet is the newest written page, just before the blank one.
  assert.equal(turnsBack(run, newer), true);
  assert.equal(turnsBack(newer, run), false);
  assert.equal(turnsBack("record", run), true);
  assert.equal(turnsBack(run, "record"), false);
});

test("the pad turns its page only from a page it showed to one about something else", () => {
  const design = { path: "meetings/summaries/2026-10-28T09-00Z_design-review.md" };
  const run = { id: 3 };
  assert.equal(pageOf(undefined, null, null), "record");
  assert.equal(pageOf("record", design, run), "record");
  assert.equal(pageOf("meeting", design, run), `meeting:${design.path}`);
  assert.equal(pageOf("meeting", null, run), "run:3");
  assert.equal(pageOf("meeting", null, null), "meeting");
  assert.equal(turnsPage(undefined, "record"), false);
  assert.equal(turnsPage("record", "record"), false);
  assert.equal(turnsPage(pageOf("meeting", design, null), pageOf("meeting", design, run)), false);
  assert.equal(turnsPage("record", pageOf("meeting", null, run)), true);
  assert.equal(turnsPage(pageOf("meeting", design, null), pageOf("meeting", { path: "meetings/summaries/b.md" }, null)), true);
  assert.equal(turnsPage(pageOf("meeting", null, run), "record"), true);
});

test("signed out of slivingdoc, the agent keeps the notes here and does not ask for a sign-in", () => {
  const local = DEFAULTS.query("Standup", "Ada and Grace", false);
  assert.match(local, /chose not to sign in to slivingdoc/);
  assert.match(local, /do not ask the user to sign in/);
  assert.doesNotMatch(local, /in the slivingdoc notebook/);
  assert.match(local, /Meeting: Standup\. Ada and Grace$/);
  assert.match(notebookFormat(true), /in the slivingdoc notebook/);
  for (const format of [notebookFormat(true), notebookFormat(false)]) assert.match(format, /meetings\/summaries\/<start>_<slug>\.md/);
});

test("the agent records the inputs the checklist set up, not what it guesses from the meeting", () => {
  const computer = { label: "Monitor of Built-in Audio", via: "monitor", source: "browser-dev1.monitor" };
  assert.equal(inputsToRecord(false, computer),
    "Record the user's mic, browser-mic, and the computer's audio, browser-dev1.monitor (Monitor of Built-in Audio), together: the user set both up for this meeting.");
  assert.match(inputsToRecord(true, computer), /^Record only the user's mic, browser-mic: the user left the computer's audio out\.$/);
  assert.match(inputsToRecord(false, null), /^Record only the user's mic, browser-mic: the computer's audio is not available\.$/);
  assert.match(DEFAULTS.query("Standup", "with team", true, inputsToRecord(false, computer)), /Meeting: Standup\. with team\n\nRecord the user's mic, browser-mic, and the computer's audio/);
});

// A MediaStream's stand-in: its tracks, and whether they were stopped. `surface` is what a
// display share shares.
const fakeStream = (kinds = ["audio", "video"], surface = "monitor") => {
  const listeners = [];
  const tracks = kinds.map((kind) => ({
    kind, label: kind, stopped: false,
    stop() { this.stopped = true; },
    getSettings: () => ({ displaySurface: surface }),
    addEventListener: (type, f) => listeners.push(f),
  }));
  return { tracks, end: () => listeners.forEach((f) => f()), getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === "audio"), getVideoTracks: () => tracks.filter((t) => t.kind === "video") };
};

// The browser's media devices, recording what was asked of them.
const fakeMedia = (devices, display = async () => fakeStream()) => {
  const asked = [];
  return {
    asked,
    getUserMedia: async (constraints) => (asked.push(["user", constraints]), fakeStream(["audio"])),
    getDisplayMedia: (constraints) => (asked.push(["display", constraints]), display()),
    enumerateDevices: async () => devices.map((d) => ({ kind: "audioinput", ...d })),
  };
};

// An AudioContext's stand-in for AudioInputs.start: enough to wire a capture node.
const fakeAudio = () => {
  const node = () => ({ connect() {}, disconnect() {}, port: {} });
  globalThis.AudioWorkletNode = function () { return node(); };
  return class {
    constructor() { this.destination = node(); this.audioWorklet = { addModule: async () => {} }; }
    resume = async () => {};
    close = async () => {};
    createMediaStreamSource = () => node();
  };
};

const inputs = (media) => {
  const notices = [];
  let relisted = 0;
  const audio = new AudioInputs({ send: () => {}, notice: (t) => notices.push(t), relist: () => relisted++, media, Context: fakeAudio() });
  return { audio, notices, relisted: () => relisted };
};
const labelOf = (audio, name) => audio.listing().find((i) => i.name === name)?.label;

test("until a screen or tab is shared, its input has no label, so ffmpeg leaves it out", async () => {
  const { audio } = inputs(fakeMedia([{ deviceId: "default", label: "Default - Mic" }]));
  await audio.discover();
  assert.equal(labelOf(audio, "tab"), "");
  assert.equal(labelOf(audio, "mic"), "Mic");
  assert.deepEqual(audio.access(), { mic: "Mic", computer: null });
});

test("a share from the button is a sink for clai, named for what was shared, until it ends", async () => {
  const stream = fakeStream(["audio", "video"], "browser");
  const media = fakeMedia([{ deviceId: "default", label: "Default - Mic" }], async () => stream);
  const { audio, relisted } = inputs(media);
  await audio.discover();
  assert.equal(await audio.share(), "shared");
  const [[, constraints]] = media.asked.filter(([kind]) => kind === "display");
  assert.equal(constraints.systemAudio, "include");
  assert.equal(labelOf(audio, "tab"), "Monitor of Shared tab (browser)");
  assert.deepEqual(audio.access().computer, { label: "Shared tab", via: "share", source: "browser-tab.monitor" });
  assert.equal(relisted(), 1);
  // Recording it leaves the share up for the next recording.
  await audio.want(["mic", "tab"]);
  assert.ok(audio.inputs().find((i) => i.name === "tab").live);
  await audio.want([]);
  assert.ok(!stream.tracks.some((t) => t.stopped));
  stream.end();
  assert.equal(labelOf(audio, "tab"), "");
  assert.equal(relisted(), 2);
});

test("a share without audio is refused, and its video stopped", async () => {
  const stream = fakeStream(["video"]);
  const { audio, notices } = inputs(fakeMedia([], async () => stream));
  assert.equal(await audio.share(), "no-audio");
  assert.ok(stream.tracks[0].stopped);
  assert.match(notices.join(), /no audio/);
  assert.equal(labelOf(audio, "tab"), "");
});

test("a share turned down says why and lists nothing", async () => {
  const { audio, notices } = inputs(fakeMedia([], async () => { throw new Error("Permission denied"); }));
  assert.equal(await audio.share(), "refused");
  assert.match(notices.join(), /Permission denied/);
  assert.equal(audio.access().computer, null);
});

test("a monitor of the computer's output already carries its audio, with no share", async () => {
  const { audio } = inputs(fakeMedia([{ deviceId: "default", label: "Default - Mic" }, { deviceId: "m", label: "Monitor of Built-in Audio" }]));
  await audio.discover();
  assert.deepEqual(audio.access().computer, { label: "Monitor of Built-in Audio", via: "monitor", source: "browser-dev1.monitor" });
  assert.equal(labelOf(audio, "dev1"), "Monitor of Built-in Audio");
});

test("without a microphone, the shared input is still listed", async () => {
  const media = fakeMedia([]);
  media.getUserMedia = async () => { throw new Error("Permission denied"); };
  const { audio, notices } = inputs(media);
  await audio.discover();
  assert.deepEqual(audio.listing().map((i) => i.name), ["tab"]);
  assert.equal(audio.access().mic, null);
  assert.match(notices.join(), /no microphone/);
});

const ticks = (check) => check.items.map((i) => `${i.done ? "x" : " "} ${i.text}${i.action ? " >" : ""}`);

test("the checklist asks for the mic and a share; sound is only listened for, so a recording may start before anyone speaks", () => {
  const none = precheck({ mic: null, computer: null }, "Share a tab", {});
  assert.deepEqual(ticks(none), ["  Allow the mic >", "  Share a tab with your call >", "  Hear the call's sound"]);
  assert.equal(none.ready, false);
  const shared = { mic: "Mic", computer: { label: "Shared tab", via: "share" } };
  assert.deepEqual(ticks(precheck(shared, "Share a tab", {})), ["x Mic: Mic", "x Computer audio: Shared tab", "  Listening for sound…"]);
  assert.ok(precheck(shared, "Share a tab", {}).ready);
  // A phone shares nothing: the call is heard on speaker through the mic, and that is ready once the mic is.
  const phone = precheck({ mic: "Mic", computer: null }, null, { micOnly: true, phone: true });
  assert.deepEqual(ticks(phone), ["x Mic: Mic", "x The call on speaker, near the phone", "x Sound: your mic only"]);
  assert.ok(phone.ready);
  assert.equal(precheck(shared, "Share a tab", { silent: true }).items[2].text, "No sound yet. You can still start.");
  assert.ok(precheck(shared, "Share a tab", { silent: true }).ready);
  const heard = precheck(shared, "Share a tab", { heard: true });
  assert.deepEqual(ticks(heard).at(-1), "x Sound heard");
  assert.ok(heard.ready);
  assert.ok(heard.sharing);
});

test("a monitor needs no share, and mic only skips the computer's audio on purpose", () => {
  const monitor = precheck({ mic: "Mic", computer: { label: "Monitor of Built-in Audio", via: "monitor" } }, "Share a tab", {});
  assert.deepEqual(ticks(monitor), ["x Mic: Mic", "x Computer audio: Monitor of Built-in Audio", "x Sound comes through the monitor"]);
  assert.ok(monitor.ready);
  const micOnly = precheck({ mic: "Mic", computer: null }, "Share a tab", { micOnly: true });
  assert.deepEqual(ticks(micOnly), ["x Mic: Mic", "x Computer audio: skipped, mic only", "x Sound: your mic only"]);
  assert.ok(micOnly.ready);
  const safari = precheck({ mic: "Mic", computer: null }, null, {});
  assert.deepEqual(ticks(safari)[1], "  Computer audio: this browser can't record it");
  assert.equal(safari.ready, false, "the user says mic only before recording without the call's sound");
  assert.equal(precheck({ mic: null, computer: null }, "Share a tab", { micOnly: true }).ready, false, "no mic, nothing to record");
});

test("the browser, its version and the OS come from the user agent", () => {
  const linuxChrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
  assert.deepEqual(platformOf({ userAgent: linuxChrome }), { os: "linux", browser: "chromium", name: "Chrome", version: 142 });
  assert.deepEqual(platformOf({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0" }), { os: "windows", browser: "chromium", name: "Edge", version: 142 });
  assert.deepEqual(platformOf({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15" }), { os: "mac", browser: "safari", name: "Safari", version: 17 });
  assert.deepEqual(platformOf({ userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" }), { os: "linux", browser: "firefox", name: "Firefox", version: 140 });
  assert.deepEqual(platformOf({ userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36" }), { os: "chromeos", browser: "chromium", name: "Chrome", version: 142 });
  // A phone is a phone, though Android's agent also says Linux and an iPhone's Mac OS X; it records the mic alone.
  const android = platformOf({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36" });
  const iphone = platformOf({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1" });
  assert.deepEqual([android.os, android.browser, iphone.os, iphone.browser], ["android", "chromium", "ios", "safari"]);
  for (const phone of [android, iphone]) {
    assert.equal(audioLimits(phone).share, null);
    assert.match(audioLimits(phone).text, /only your mic.*speaker/);
  }
  // Chromium names itself in its brands, which Brave and others keep out of the user agent.
  assert.equal(platformOf({ userAgent: linuxChrome, userAgentData: { brands: [{ brand: "Brave", version: "142" }, { brand: "Chromium", version: "142" }] } }).name, "Brave");
});

test("on a Mac, Chromium tells its macOS version, which the user agent freezes", async () => {
  const userAgentData = { brands: [], getHighEntropyValues: async () => ({ platformVersion: "14.5.0" }) };
  const mac = platformOf({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36" });
  assert.deepEqual(await withOsVersion(mac, { userAgentData }), { ...mac, osVersion: [14, 5] });
  const refused = { brands: [], getHighEntropyValues: async () => { throw new Error("NotAllowedError"); } };
  assert.deepEqual(await withOsVersion(mac, { userAgentData: refused }), mac);
  const linux = platformOf({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36" });
  assert.deepEqual(await withOsVersion(linux, { userAgentData }), linux);
});

const chrome = (os, extra = {}) => ({ os, browser: "chromium", name: "Chrome", version: 142, ...extra });
const said = (platform, monitor) => audioLimits(platform, monitor).text;

test("the audio note is one short instruction for this browser and OS", () => {
  assert.equal(said(chrome("linux")), "Chrome can only record a tab's sound. Share the tab with your call; desktop apps such as Zoom won't be heard.");
  assert.equal(audioLimits(chrome("linux")).share, "Share a tab");
  assert.equal(said(chrome("windows")), "Share your screen with \"Share system audio\" on, or the tab with your call.");
  assert.equal(audioLimits(chrome("windows")).share, "Share screen or tab");
  assert.equal(said({ ...chrome("windows"), name: "Edge" }), said(chrome("windows")));
  assert.equal(said({ os: "mac", browser: "safari", name: "Safari", version: 17 }), "Safari can't record a call's sound, only your mic. Use Chrome or Edge for calls.");
  assert.equal(audioLimits({ os: "linux", browser: "firefox", name: "Firefox" }).share, null);
  assert.equal(said({ os: "linux", browser: "firefox", name: "Firefox" }, "Monitor of Built-in Audio"), "Your computer's sound comes in through Monitor of Built-in Audio: nothing to share.");
});

test("on a Mac the note knows whether this Chrome and macOS can share the screen's sound", () => {
  assert.equal(said(chrome("mac", { osVersion: [14, 5] })), said(chrome("windows")));
  assert.equal(said(chrome("mac", { version: 140, osVersion: [14, 5] })), "Chrome 140 can only record a tab's sound (Chrome 141 can record the screen's). Share the tab with your call.");
  assert.equal(said(chrome("mac", { osVersion: [13, 6] })), "macOS 13.6 lets Chrome record only a tab's sound (macOS 14.2 can record the screen's). Share the tab with your call.");
  assert.equal(said(chrome("mac")), "Share the tab with your call. The screen's sound works only on macOS 14.2 or newer.");
});

test("every audio note fits in two lines of the pad", () => {
  const platforms = [chrome("linux"), chrome("windows"), chrome("chromeos"), chrome("mac"), chrome("mac", { osVersion: [14, 5] }),
    chrome("mac", { version: 140, osVersion: [14, 5] }), chrome("mac", { osVersion: [13, 6] }), { os: "mac", browser: "safari", name: "Safari" }];
  for (const platform of platforms) assert.ok(said(platform).length <= 120, said(platform));
});

// A clock the test moves: `sleep` advances it instead of waiting.
const fakeClock = () => {
  let now = 0;
  return { now: () => now, sleep: async (ms) => { now += ms; } };
};

// An AudioContext's stand-in whose analyser hears `peaks`, one per look, then silence.
const hearing = (peaks) => {
  const heard = [...peaks];
  const state = { closed: false };
  class Context {
    resume = async () => {};
    close = async () => { state.closed = true; };
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
    createAnalyser = () => ({ fftSize: 4, getFloatTimeDomainData: (data) => data.fill(heard.shift() ?? 0) });
  }
  return { Context, state };
};

const listening = async (peaks) => {
  const { Context, state } = hearing(peaks);
  const media = fakeMedia([], async () => fakeStream());
  const audio = new AudioInputs({ send: () => {}, notice: () => {}, media, Context, ...fakeClock() });
  await audio.share();
  return { audio, state };
};

test("a share is heard once its sound passes the threshold", async () => {
  const { audio, state } = await listening([0, 0.001, 0.2]);
  const levels = [];
  assert.equal(await audio.hearShare({ onLevel: (l) => levels.push(l) }), "sound");
  assert.deepEqual(levels, [0, 0.001, 0.2].map(Math.fround));
  assert.ok(state.closed, "the listening context is closed");
});

test("a share with no sound for the whole wait is silent", async () => {
  const { audio } = await listening([]);
  assert.equal(await audio.hearShare({ ms: 2000 }), "silent");
});

test("nothing shared, or a share that ends while listening, is said so", async () => {
  const { Context } = hearing([]);
  const bare = new AudioInputs({ send: () => {}, notice: () => {}, media: fakeMedia([]), Context, ...fakeClock() });
  assert.equal(await bare.hearShare(), "unshared");
  const { audio } = await listening([]);
  const heard = audio.hearShare({ ms: 2000, onLevel: () => audio.unshare() });
  assert.equal(await heard, "ended");
});

test("a followed share says when it has been quiet for quietMs, and when sound comes back", async () => {
  const { audio, state } = await listening([0.2, 0, 0, 0, 0, 0, 0, 0.3, 0]);
  const events = [];
  let looks = 0;
  const end = await audio.followShare({
    quietMs: 1000, every: 250, active: () => ++looks <= 10,
    onQuiet: () => events.push(`quiet@${audio.now()}`), onSound: () => events.push(`sound@${audio.now()}`),
  });
  assert.equal(end, "done");
  assert.deepEqual(events, ["quiet@1000", "sound@1750"]);
  assert.ok(state.closed, "the following context is closed");
});

test("following nothing shared, or a share that ends, is said so", async () => {
  const { Context } = hearing([]);
  const bare = new AudioInputs({ send: () => {}, notice: () => {}, media: fakeMedia([]), Context, ...fakeClock() });
  assert.equal(await bare.followShare({ onQuiet() {}, onSound() {} }), "unshared");
  const { audio } = await listening([]);
  let looks = 0;
  const end = await audio.followShare({ every: 250, active: () => ++looks < 3 || (audio.unshare(), true), onQuiet() {}, onSound() {} });
  assert.equal(end, "ended");
});

test("a transcript line is an utterance whatever shape the agent wrote it in", () => {
  const say = (line) => {
    const u = parseUtterance(line);
    return u && [u.name, u.words, u.start, u.end];
  };
  assert.deepEqual(say("[00:00:04.300 --> 00:00:09.250] Tesi: Lawrence, share the screen."), ["Tesi", "Lawrence, share the screen.", 4.3, 9.25]);
  assert.deepEqual(say("**Speaker A** [00:12]: Ship it."), ["Speaker A", "Ship it.", 12, null]);
  assert.deepEqual(say("- **Speaker B**: ok"), ["Speaker B", "ok", null, null]);
  assert.deepEqual(say("**Ada:** at 10:30 we meet"), ["Ada", "at 10:30 we meet", null, null]);
  assert.deepEqual(say("1:02:05 Grace: yes"), ["Grace", "yes", 3725, null]);
  assert.equal(say("- see https://example.com"), null);
  // Rebuilt from its parts, a corrected line keeps its time and markup.
  const u = parseUtterance("**Speaker A** [00:12]: Ship it.");
  assert.equal(u.prefix + "Ada" + u.mid + "Ship it today.", "**Ada** [00:12]: Ship it today.");
  assert.deepEqual(partsOf("**Ada** [00:12]: Ship it today.", u), { name: "Ada", words: "Ship it today." });
  assert.equal(clock(4.3), "0:04");
  assert.equal(clock(3725), "1:02:05");
});

test("the transcript's rows skip front matter and the metadata above it, and keep a speaker who speaks once", () => {
  const text = "---\ntitle: Sync\n---\n# Sync transcript\n\n- **Duration:** 38\n- **Source:** mic\n\nAda: one\nGrace: two\nAda: three\n";
  const rows = transcriptRows(text).map(({ n, u }) => `${n}:${u ? u.name : "-"}`);
  assert.deepEqual(rows, ["3:-", "4:-", "5:-", "6:-", "7:-", "8:Ada", "9:Grace", "10:Ada", "11:-"]);
});

test("a correction shows what was struck and what was written in", () => {
  const marks = (a, b) => marksToHtml(diffMarks(a, b));
  assert.equal(marks("Lawrence, you have to", "Lorentz, you have to"), "<del>Lawrence</del><ins>Lorentz</ins>, you have to");
  assert.equal(marks("we use wasm air now", "we use Wasmer now"), "we use <del>wasm air</del><ins>Wasmer</ins> now");
  assert.equal(marks("same", "same"), "same");
});

test("a fix of one word or name is offered everywhere, not a fix of case or of several places", () => {
  assert.deepEqual(singleChange("Lawrence, you have to", "Lorentz, you have to"), { from: "Lawrence", to: "Lorentz" });
  assert.deepEqual(singleChange("Lawrence's turn", "Lorentz's turn"), { from: "Lawrence", to: "Lorentz" });
  assert.deepEqual(singleChange("we use wasm air now", "we use Wasmer now"), { from: "wasm air", to: "Wasmer" });
  assert.equal(singleChange("may we", "May we"), null);
  assert.equal(singleChange("a b c", "x b y"), null);
  assert.equal(singleChange("at 12 sharp", "at 13 sharp"), null);
  assert.equal(singleChange("and the plan", "and a plan"), null);
  assert.deepEqual(singleChange("ask Bob now", "ask Rob now"), { from: "Bob", to: "Rob" });
  assert.equal(singleChange("ok", "ok"), null);
});

test("corrections are undone a step at a time, and a line set back is no correction", () => {
  const fixes = new Fixes({ transcript: "Ada: one\nGrace: two", summary: "" });
  fixes.change([{ file: "transcript", n: 0, text: "Ada: uno" }]);
  fixes.change([{ file: "transcript", n: 1, text: null }]);
  assert.equal(fixes.count, 2);
  assert.equal(fixes.text("transcript", 1), null);
  fixes.change([{ file: "transcript", n: 0, text: "Ada: one" }]);
  assert.equal(fixes.count, 1);
  fixes.undo();
  assert.equal(fixes.text("transcript", 0), "Ada: uno");
  fixes.undo();
  fixes.undo();
  assert.equal(fixes.count, 0);
  assert.equal(fixes.undo(), false);
});

test("fixing a name everywhere reaches the transcript and the summary, but not their front matter", () => {
  const fixes = new Fixes({
    transcript: "---\ntitle: With Lawrence\n---\nLawrence: hi\nAda: hi lawrence, and Lawrence's dog\nAda: Lawrenceville",
    summary: "---\ntitle: With Lawrence\n---\n- Lawrence decides\n",
  });
  const places = fixes.places("Lawrence");
  assert.deepEqual([places.transcript.count, places.summary.count], [3, 1]);
  assert.equal(offerWhere(places), "In 4 more places: 3 in the transcript, 1 in the summary.");
  assert.equal(offerWhere({ transcript: { count: 1 }, summary: { count: 0 } }), "In 1 more place in the transcript.");
  assert.equal(fixes.everywhere("Lawrence", "Lorentz"), 3);
  assert.equal(fixes.text("transcript", 3), "Lorentz: hi");
  assert.equal(fixes.text("transcript", 4), "Ada: hi Lorentz, and Lorentz's dog");
  assert.equal(fixes.text("transcript", 5), "Ada: Lawrenceville");
  assert.equal(fixes.text("summary", 3), "- Lorentz decides");
  assert.equal(fixes.text("transcript", 1), "title: With Lawrence");
  // A $ in the new word is written as it is.
  fixes.undo();
  fixes.everywhere("Lawrence", "$1");
  assert.equal(fixes.text("summary", 3), "- $1 decides");
});

test("saving puts each correction on its line as the notebook has the file now", () => {
  const filed = "Ada: one\nGrace: two\nAda: three";
  const fixes = new Fixes({ transcript: filed, summary: "" });
  fixes.change([{ file: "transcript", n: 0, text: "Ada: uno" }, { file: "transcript", n: 1, text: null }, { file: "transcript", n: 2, text: "Ada: tres" }]);
  assert.deepEqual(fixes.rebase("transcript", filed), { text: "Ada: uno\nAda: tres", lost: 0 });
  // Lines added elsewhere move nothing; a line changed elsewhere loses its correction.
  assert.deepEqual(fixes.rebase("transcript", "Bo: new\nAda: one\nGrace: two\nAda: 3"), { text: "Bo: new\nAda: uno\nAda: 3", lost: 1 });
  // A save tried again finds its corrections already made.
  assert.deepEqual(fixes.rebase("transcript", "Ada: uno\nAda: tres"), { text: "Ada: uno\nAda: tres", lost: 0 });
});

test("a conflict slivingdoc wrote into a file keeps the other side's text", () => {
  const text = "a\n<<<<<<< local\nmine\n=======\ntheirs\nand more\n>>>>>>> remote\nb\n<<<<<<< local\nunclosed";
  assert.deepEqual(resolveConflicts(text), { text: "a\ntheirs\nand more\nb\n<<<<<<< local\nunclosed", blocks: 1 });
});

test("an agent's edited copy comes back as corrections to the lines it changed, and as lines it added", () => {
  const filed = "---\ntitle: Sync\n---\nAda: one\nGrace: two wasm air\nAda: three\n";
  const fixes = new Fixes({ transcript: filed, summary: "- Decide\n" });
  fixes.change([{ file: "transcript", n: 3, text: "Ada: uno" }]);
  // The copy holds the user's correction; the agent fixed a word, split a line, and took one out.
  assert.equal(fixes.result("transcript"), "---\ntitle: Sync\n---\nAda: uno\nGrace: two wasm air\nAda: three\n");
  const copy = "---\ntitle: Sync\n---\nAda: uno\nGrace: two Wasmer\nAda: three, and\nGrace: four\n";
  const changes = fixes.adopt("transcript", copy);
  assert.deepEqual(changes, [
    { file: "transcript", n: 4, text: "Grace: two Wasmer" },
    { file: "transcript", n: 5, text: "Ada: three, and" },
    { file: "transcript", after: 5, lines: ["Grace: four"] },
  ]);
  fixes.change([...changes, ...fixes.adopt("summary", "- Decide\n- Ship on Friday\n")]);
  assert.equal(fixes.result("transcript"), copy);
  assert.equal(fixes.count, 5);
  assert.equal(fixes.marked("summary"), "- Decide\n- \uE002Ship on Friday\uE003\n");
  // The agent's step undoes as one, leaving the user's own correction.
  fixes.undo();
  assert.equal(fixes.count, 1);
  assert.deepEqual(fixes.adopt("transcript", fixes.result("transcript")), []);
  // A line taken out is struck, its list marker kept.
  const summary = new Fixes({ summary: "- Keep\n- Drop me\n" });
  summary.change(summary.adopt("summary", "- Keep\n"));
  assert.equal(summary.marked("summary"), "- Keep\n- \uE000Drop me\uE001\n");
});

test("lines an agent added are saved after their line as the notebook has it, once", () => {
  const filed = "a\nb\nc";
  const fixes = new Fixes({ transcript: filed });
  fixes.change(fixes.adopt("transcript", "top\na\nb\nb2\nc"));
  assert.deepEqual(fixes.rebase("transcript", filed), { text: "top\na\nb\nb2\nc", lost: 0 });
  assert.deepEqual(fixes.rebase("transcript", "x\na\nb\nc"), { text: "top\nx\na\nb\nb2\nc", lost: 0 });
  assert.deepEqual(fixes.rebase("transcript", "top\na\nb\nb2\nc"), { text: "top\na\nb\nb2\nc", lost: 0 });
  // Its line gone from the notebook, an added line has nowhere to go.
  assert.deepEqual(fixes.rebase("transcript", "top\na\nc"), { text: "top\na\nc", lost: 1 });
  assert.deepEqual(align(["a", "b"], ["a", "x", "b"]).map((op) => op.type), ["same", "ins", "same"]);
});

test("fixing a name everywhere reaches lines an agent added too", () => {
  const fixes = new Fixes({ transcript: "Ada: hi Lawrence", summary: "" });
  fixes.change([{ file: "transcript", after: 0, lines: ["Lawrence: hello"] }]);
  assert.equal(fixes.places("Lawrence").transcript.count, 2);
  fixes.everywhere("Lawrence", "Lorentz");
  assert.equal(fixes.result("transcript"), "Ada: hi Lorentz\nLorentz: hello");
});

test("Penelope's turn is the INPUT of her prompt, with the user's unsaved corrections in it", () => {
  const fixes = new Fixes({ transcript: "Ada: hi Lawrence\nGrace: bye", summary: "- Ship\n" });
  fixes.change([{ file: "transcript", n: 0, text: "Ada: hi Lorentz" }, { file: "transcript", n: 1, text: null }, { file: "summary", after: 0, lines: ["- Test"] }]);
  const corrections = correctionsOf(fixes);
  assert.deepEqual(corrections, [
    "transcript.md: “Ada: hi Lawrence” → “Ada: hi Lorentz”",
    "transcript.md: took out “Grace: bye”",
    "summary.md: added “- Test”",
  ]);
  assert.deepEqual(correctionsOf(fixes, 1), [corrections[0], "and 2 more"]);
  const screen = ["Meeting in focus: “Sync”", "Buttons showing: New recording · Save"];
  const actions = ["new_recording: show New recording"];
  assert.equal(
    penelopeQuery({ screen, actions, corrections: corrections.slice(0, 1), request: "Fix the names" }),
    "INPUT\nOn the user's screen:\n- Meeting in focus: “Sync”\n- Buttons showing: New recording · Save\n" +
      "Actions the app can take for you now:\n- new_recording: show New recording\n" +
      "The user's unsaved corrections to the meeting in focus, already in its copies:\n- transcript.md: “Ada: hi Lawrence” → “Ada: hi Lorentz”\nRequest: Fix the names",
  );
  assert.throws(() => penelopeQuery({ screen, actions, corrections: [] }), /request is missing/);
  assert.throws(() => penelopeQuery({ actions, corrections: [], request: "Hi" }), /screen is missing/);
  assert.throws(() => penelopeQuery({ screen, corrections: [], request: "Hi" }), /actions is missing/);
});

test("Penelope's answer is the JSON object her prompt asks for, and what she said when she wrote none", () => {
  assert.deepEqual(parseSay('Done.\n{"say": "Fixed **Lorentz** at 0:04.", "mood": "glad"}'), { say: "Fixed **Lorentz** at 0:04.", mood: "glad", actions: [] });
  assert.deepEqual(parseSay('```json\n{"say": "Who is Speaker A?", "mood": "unsure"}\n```'), { say: "Who is Speaker A?", mood: "unsure", actions: [] });
  assert.deepEqual(parseSay('{"say": "Hm {odd}", "mood": "grumpy"}'), { say: "Hm {odd}", mood: "glad", actions: [] });
  assert.deepEqual(parseSay("done after tool for: hello"), { say: "done after tool for: hello", mood: "glad", actions: [] });
  assert.deepEqual(parseSay(""), { say: "…", mood: "glad", actions: [] });
  assert.deepEqual(
    parseSay('{"say": "Opening it.", "mood": "glad", "do": [{"action": "open_meeting", "meeting": "meetings/summaries/a.md"}, {"action": "new_recording"}, {"nope": 1}, "x"]}').actions,
    [{ action: "open_meeting", meeting: "meetings/summaries/a.md" }, { action: "new_recording", meeting: null }],
  );
  assert.deepEqual(parseSay('{"say": "Hi", "do": "open_meeting"}').actions, []);
});

test("what Penelope is doing reads from the tool she calls", () => {
  assert.equal(activityOf({ name: "rg", inputs: { pattern: "Lawrence", path: "." } }), "Looking for “Lawrence”");
  assert.equal(activityOf({ name: "rows_between", inputs: { file_path: "summary.md", start_line: 3, end_line: 9 } }), "Reading lines 3 to 9 of the summary");
  assert.equal(activityOf({ name: "sed", inputs: { file_path: "transcript.md" } }), "Correcting the transcript");
  assert.equal(activityOf({ name: "write_file", inputs: { file_path: "summary.md" } }), "Rewriting the summary");
  assert.equal(activityOf({ name: "date" }), "Using date");
});

test("Penelope's guide at the start leaves out the steps the user has done", () => {
  const fresh = guideText({ provider: false, notebook: false });
  assert.match(fresh, /^Hi, I'm \*\*Penelope\*\*/);
  assert.match(fresh, /\n1\. \[\*\*Connect an AI provider\*\*\]\(#provider-card\).*\n2\. \[\*\*Sign in to slivingdoc\*\*\]\(#notebook-card\).*\n3\. \*\*New recording\*\*/);
  // The first two steps point at their card on the pad (pointer.js).
  assert.match(renderMarkdown(fresh), /<a href="#" data-point="provider-card"><strong>Connect an AI provider<\/strong><\/a>/);
  assert.match(renderMarkdown(fresh), /<a href="#" data-point="notebook-card"><strong>Sign in to slivingdoc<\/strong><\/a>/);
  const set = guideText({ provider: true, notebook: true });
  assert.doesNotMatch(set, /AI provider|slivingdoc/);
  assert.match(set, /\n1\. \*\*New recording\*\*.*\n2\. \*\*Stop and summarize\*\*.*\n3\. Ask me anything/);
});

test("the agent is told to record through five minutes of silence, signed in or not", () => {
  assert.equal(SILENCE_SECONDS, 300);
  for (const connected of [true, false]) assert.match(notebookFormat(connected), /silence_timeout_seconds set to 300:/);
  for (const connected of [true, false]) {
    assert.match(notebookFormat(connected), /Give the transcript file its front matter only: .*audio_transcribe's output below it word for word/);
    assert.match(notebookFormat(connected), /never write or rewrite the transcript's lines/);
    assert.match(notebookFormat(connected), /never copy, move or paste the transcription into the file, not even from a file a long tool output was saved in/);
  }
});

test("the transcript is audio_transcribe's segments word for word, one line each with its time and speaker", () => {
  const segments = JSON.stringify([
    { start: 0, end: 1.5, speaker: "A", text: " Shall we\n start?" },
    { start: 72.4, end: 74, speaker: "unknown-1", text: "Yes." },
    { start: 3725, end: 3726, speaker: "1-B", text: "Okay, uh, so." },
    { start: 3730, end: 3731, text: "Nobody's label." },
  ], null, 2);
  const text = transcriptLines(segments);
  assert.equal(text, "[0:00] Speaker A: Shall we start?\n[1:12] unknown-1: Yes.\n[1:02:05] Speaker 1-B: Okay, uh, so.\n[1:02:10] Nobody's label.\n");
  const rows = transcriptRows(text).filter((r) => r.u);
  assert.deepEqual(rows.map((r) => [r.u.name, r.u.start]), [["Speaker A", 0], ["unknown-1", 72], ["Speaker 1-B", 3725]]);
  assert.deepEqual(unknownSpeakers(text).map((s) => s.label), ["Speaker A", "unknown-1", "Speaker 1-B"]);
  assert.equal(transcriptLines("A: plain text, as it came\n"), "A: plain text, as it came\n");
  assert.equal(transcriptLines("{}"), "{}");
  // clai's calibrated runs (a long recording) label speaker-N, which the app asks names for like any label; a name stays a name.
  const calibrated = transcriptLines(JSON.stringify([
    { start: 1, end: 2, speaker: "speaker-1", text: "Morning." },
    { start: 3, end: 4, speaker: "speaker-12", text: "Hi." },
    { start: 5, end: 6, speaker: "Lorentz", text: "Let's start." },
  ]));
  assert.equal(calibrated, "[0:01] Speaker 1: Morning.\n[0:03] Speaker 12: Hi.\n[0:05] Lorentz: Let's start.\n");
  assert.deepEqual(unknownSpeakers(calibrated).map((s) => s.label), ["Speaker 1", "Speaker 12"]);
});

test("audio_transcribe's output is kept, or the file clai saved it in when it was too long to pass on", () => {
  assert.deepEqual(transcribedOf("[\n  {}\n]\n"), { text: "[\n  {}\n]\n", chars: 9 });
  assert.deepEqual(transcribedOf("[tool output too large: 48211 runes; full output saved to temp file: /tmp/clai-tool-output-123.txt]"),
    { file: "/tmp/clai-tool-output-123.txt", chars: 48211 });
  const job = newJob({ id: 1, now: 0 });
  takeRecord(job, { type: "tool_result", name: "audio_transcribe", ok: false, output: "ERROR: no key" }, 1);
  assert.equal(job.transcribed, undefined);
  takeRecord(job, { type: "tool_result", name: "audio_transcribe", ok: true, output: "[]\n" }, 2);
  assert.deepEqual(job.transcribed, { text: "[]\n", chars: 3 });
});

test("a speaker is named wherever the label stands whole, and nowhere it is part of another", () => {
  assert.equal(named("[0:00] Speaker A: Speaker AB said so.\nSpeaker A’s point.", "Speaker A", "Ada"), "[0:00] Ada: Speaker AB said so.\nAda’s point.");
  assert.equal(named("unknown-1 and unknown-10", "unknown-1", "Bo"), "Bo and unknown-10");
  assert.equal(named("Speaker 1-A, Speaker 1-AB", "Speaker 1-A", "Cy $&"), "Cy $&, Speaker 1-AB");
});

test("a hub profile that changed since it was trusted is named, so the app asks to trust it again", () => {
  const changed = "profile cchub:baalimago/meeting-transcriber: cchub:baalimago/meeting-transcriber changed to a version (sha256 1a2b…9c8d) " +
    "you have not trusted, and there is no terminal to ask in. Not running it.\n  Read it:  https://www.clai.chat/hub/baalimago/meeting-transcriber/";
  assert.equal(untrustedProfile([{ message: "something else" }, { message: changed }]), "cchub:baalimago/meeting-transcriber");
  assert.equal(untrustedProfile([{ message: "failed to create text querier: no such model" }]), null);
  assert.equal(untrustedProfile([]), null);
  // A pin whose bytes left clai's cache is fetched again and refused: the same note, about the profile.
  const gone = `profile cchub:a/b#sha256=${"1".repeat(64)}: cchub:a/b does not match its #sha256=: want 1111…1111, got 2a2a…2a2a. Not running it`;
  assert.equal(untrustedProfile([{ message: gone }]), "cchub:a/b");
});

test("a run is pinned to the hash clai printed when it checked or trusted the hub profile", () => {
  const v1 = "a".repeat(64);
  assert.equal(trustedDigest(`cchub:baalimago/meeting-transcriber (sha256 ${v1}) is trusted\n`), v1);
  // profiles trust prints the summary first; the hash is the last line's.
  const summary = `▸ cchub:a/b · fetched · runs on your machine\n  sha256   abcd…ef01\n  page     https://www.clai.chat/hub/a/b/\n\n` +
    `Trusted cchub:a/b (sha256 ${v1}) in /home/u/.config/clai/trust.json\n`;
  assert.equal(trustedDigest(summary), v1);
  assert.equal(trustedDigest("cchub:a/b changed to a version (sha256 1a2b…9c8d) you have not trusted"), null);
  assert.equal(trustedDigest(null), null);
  assert.equal(pinProfile("cchub:baalimago/meeting-transcriber", v1), `cchub:baalimago/meeting-transcriber#sha256=${v1}`);
  assert.equal(pinProfile(`cchub:a/b#sha256=${"b".repeat(64)}`, v1), `cchub:a/b#sha256=${v1}`);
  assert.equal(digestOf(pinProfile("cchub:a/b", v1)), v1);
  assert.equal(digestOf("cchub:a/b"), null);
  assert.equal(digestOf("/tmp/meeting.json"), null);
});

// RFC 7636 appendix B: these 32 octets make this verifier, whose S256 challenge is this.
const RFC_OCTETS = [116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121];
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("a provider sign-in's PKCE pair is RFC 7636's S256, and its state is fresh", async () => {
  assert.equal(await challengeOf(RFC_VERIFIER), RFC_CHALLENGE);
  const { verifier, challenge, state } = await pkce((n) => new Uint8Array(n === 32 ? RFC_OCTETS : Array(n).fill(255)));
  assert.equal(verifier, RFC_VERIFIER);
  assert.equal(challenge, RFC_CHALLENGE);
  assert.equal(state, "_____________________w");
  const a = await pkce();
  const b = await pkce();
  assert.match(a.verifier, /^[\w-]{43}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
});

test("OpenRouter's sign-in page gets the callback, the challenge, S256, a key label and the state", () => {
  const url = new URL(authorizeUrl(providerById("openrouter"), { callback: "https://minutes.example/signin-callback.html", challenge: RFC_CHALLENGE, state: "s1" }));
  assert.equal(url.origin + url.pathname, "https://openrouter.ai/auth");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    callback_url: "https://minutes.example/signin-callback.html",
    code_challenge: RFC_CHALLENGE,
    code_challenge_method: "S256",
    key_label: "Penelope",
    state: "s1",
  });
});

const respond = (status, body) => async (url, init) => {
  respond.last = { url, init };
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
};

test("the callback's code is traded for the key with the verifier", async () => {
  const openrouter = providerById("openrouter");
  assert.equal(await exchangeCode(openrouter, { code: "c1", verifier: RFC_VERIFIER }, respond(200, { key: "sk-or-v1-abc" })), "sk-or-v1-abc");
  assert.equal(respond.last.url, "https://openrouter.ai/api/v1/auth/keys");
  assert.equal(respond.last.init.method, "POST");
  assert.deepEqual(JSON.parse(respond.last.init.body), { code: "c1", code_verifier: RFC_VERIFIER, code_challenge_method: "S256" });
});

test("a refused or keyless exchange throws with what the provider said", async () => {
  const openrouter = providerById("openrouter");
  const refused = respond(403, { error: { message: "Invalid code or code_verifier", code: 403 } });
  await assert.rejects(exchangeCode(openrouter, { code: "c", verifier: "v" }, refused), /OpenRouter refused the sign-in \(403: Invalid code or code_verifier\)/);
  await assert.rejects(exchangeCode(openrouter, { code: "c", verifier: "v" }, respond(502, "bad gateway")), /\(502: bad gateway\)/);
  await assert.rejects(exchangeCode(openrouter, { code: "c", verifier: "v" }, respond(200, { id: "x" })), /OpenRouter sent no key/);
  await assert.rejects(exchangeCode(openrouter, { code: "c", verifier: "v" }, respond(200, "<html>")), /OpenRouter sent no key/);
});

test("the callback page reads an approval's code and state, or a denial's error", () => {
  assert.deepEqual(callbackMessage("?code=c1&state=s1"), { code: "c1", state: "s1", error: null, iss: null });
  assert.deepEqual(callbackMessage("?error=access_denied&error_description=User+denied"), { code: null, state: null, error: "User denied", iss: null });
  assert.deepEqual(callbackMessage(""), { code: null, state: null, error: null, iss: null });
  assert.equal(callbackMessage("?code=c1&state=s1&iss=https%3A%2F%2Fmcp.linear.app").iss, "https://mcp.linear.app");
});

test("the first connected provider is the one the agents run with", () => {
  assert.equal(activeProvider(new Map()), null);
  assert.equal(activeProvider(new Map([["OPENROUTER_API_KEY", "k"]])).id, "openrouter");
  assert.equal(activeProvider(new Map([["OPENROUTER_API_KEY", "k"], ["OPENAI_API_KEY", "k"]])).id, "openai");
  assert.equal(new Set(PROVIDERS.map((p) => p.stored)).size, PROVIDERS.length);
  assert.equal(providerById("openai").stored, "minutes.openai-key");
});

test("OpenRouter runs the agents on or: models; OpenAI keeps the profiles' own", () => {
  assert.equal(providerFlags(providerById("openai"), "agent"), "");
  assert.equal(providerFlags(null, "agent"), "");
  assert.equal(providerFlags(providerById("openrouter"), "agent"), `-cm 'or:openai/gpt-5.6-luna' -am '${OPENROUTER_AUDIO}'`);
  assert.equal(providerFlags(providerById("openrouter"), "penelope"), "-cm 'or:openai/gpt-6.1-sol'");
  assert.equal(withFlags("", ""), "");
  assert.equal(withFlags("-cm 'a'", ""), "-cm 'a' ");
  assert.equal(withFlags("-cm 'a'", "-cm mock_test"), "-cm 'a' -cm mock_test ");
});

test("a signed-in OpenRouter key is deleted on its page, found by the key's SHA-256", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await providerById("openrouter").manage("abc"), "https://openrouter.ai/keys/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(providerById("openai").manage, undefined);
});

const RECORDED = (seconds, because = "enter") =>
  `recorded: /tmp/recordings/r.wav\nstarted_at: 2026-11-16T10:00:00Z\nended_at: 2026-11-16T10:10:00Z\nduration_seconds: ${seconds}\nstopped_because: ${because}\nsources: mic=Mic\n`;

const recordJob = () => newJob({ id: 1, label: "Record", title: "Sync", action: "minutes:Record#1", now: 0, recording: true });

test("a run has no time left while it starts and records, and one from the recording's length after", () => {
  const job = recordJob();
  assert.equal(estimate(job, 0), null);
  takeRecord(job, { type: "tool_call", name: "audio_record", inputs: {} }, 1000);
  assert.equal(phaseOf(job), "recording");
  assert.equal(estimate(job, 300_000), null);
  takeRecord(job, { type: "tool_result", name: "audio_record", ok: true, output: RECORDED(600) }, 601_000);
  assert.equal(job.audioSeconds, 600);
  const guess = estimate(job, 601_000);
  // A turn; 6 + 3 s an audio minute; two turns and 11 000 + 1 500 characters at 250/s; 6 + 1 s to save.
  assert.equal(guess.phase, "toTranscribe");
  assert.equal(Math.round(guess.seconds), 8 + 36 + 66 + 7);
  assert.equal(guess.progress, 0);
  assert.equal(guess.late, false);
});

test("the time left follows the run from transcribing to writing as many notes as the transcript holds", () => {
  const job = recordJob();
  takeRecord(job, { type: "tool_result", name: "audio_record", ok: true, output: RECORDED(600) }, 601_000);
  takeRecord(job, { type: "tool_call", name: "audio_transcribe", inputs: { file_path: "/tmp/recordings/r.wav" } }, 605_000);
  const transcribing = estimate(job, 615_000);
  assert.equal(transcribing.phase, "transcribing");
  assert.equal(Math.round(transcribing.seconds), 36 - 10 + 66 + 7);
  assert.equal(transcribing.progress.toFixed(3), (14 / (14 + 99)).toFixed(3));
  takeRecord(job, { type: "tool_result", name: "audio_transcribe", ok: true, output: "x".repeat(5000) }, 640_000);
  const writing = estimate(job, 640_000);
  assert.equal(writing.phase, "writing");
  assert.equal(Math.round(writing.seconds), 16 + 26 + 7);
  job.agentEndAt = 700_000;
  assert.equal(estimate(job, 702_000).phase, "saving");
  assert.ok(estimate(job, 702_000).progress > writing.progress);
});

test("the chunks transcribed so far set the pace of the ones left", () => {
  const job = recordJob();
  takeRecord(job, { type: "tool_result", name: "audio_record", ok: true, output: RECORDED(2400) }, 1000);
  takeRecord(job, { type: "tool_call", name: "audio_transcribe", inputs: {} }, 2000);
  takeRecord(job, { type: "progress", title: "audio_transcribe", state: "start", detail: "splitting via ffmpeg  r.wav  73.2 MB > 25 MB limit  4 chunks × 10.0 min  3 workers" }, 3000);
  takeRecord(job, { type: "progress", title: "audio_transcribe", row: "00:00–10:00", state: "update", detail: "transcribing" }, 3000);
  takeRecord(job, { type: "progress", title: "audio_transcribe", row: "00:00–10:00", state: "done", detail: "done" }, 22_000);
  assert.equal(job.chunks.total, 4);
  const guess = estimate(job, 22_000);
  const unchunked = estimate({ ...job, chunks: null }, 22_000);
  // One of four chunks in 20 s leaves 60 s, where 6 + 3 s for each of 40 minutes left 106.
  assert.equal(Math.round(guess.seconds - unchunked.seconds), 60 - (126 - 20));
});

test("a phase past its estimate leaves only the phases after it, says it is late, and still creeps toward done", () => {
  const job = newJob({ id: 2, label: "Name the speakers", title: "Sync", action: "a", now: 0, expects: { transcribe: false, chars: 1000 } });
  assert.equal(phaseOf(job), "writing");
  // Two turns and 2 500 characters: 26 s, and 6 s to save.
  assert.equal(Math.round(estimate(job, 0).seconds), 32);
  const late = estimate(job, 40_000);
  const later = estimate(job, 80_000);
  assert.ok(late.late && later.late);
  assert.ok(later.seconds === late.seconds && later.seconds === later.rest && later.rest === 6);
  assert.ok(later.progress > late.progress && later.progress < 1);
  assert.equal(leftText({ seconds: 30, late: true }), "taking longer than expected");
});

test("an answer to the agent says nothing of how long it takes", () => {
  const job = newJob({ id: 3, label: "Answer", title: "Sync", action: "a", now: 0, answering: true });
  assert.equal(phaseOf(job), "working");
  assert.equal(estimate(job, 5000), null);
  assert.equal(jobStatus(job, 5000), "The agent is working…");
});

test("the time left is said as one would say it", () => {
  assert.equal(leftText({ seconds: 4, late: false }), "a few seconds left");
  assert.equal(leftText({ seconds: 42, late: false }), "about 40 s left");
  assert.equal(leftText({ seconds: 12, late: false }), "about 10 s left");
  assert.equal(leftText({ seconds: 150, late: false }), "about 3 min left");
  assert.equal(leftText({ seconds: 3720, late: false }), "about 1 h 2 min left");
  // A late phase gives no number for itself, which would stand still, only for what follows it.
  assert.equal(leftText({ seconds: 150, rest: 140, late: true }), "taking longer than expected, then about 2 min");
  assert.equal(leftText({ seconds: 150, rest: 3720, late: true }), "taking longer than expected, then about 1 h 2 min");
  assert.equal(leftText({ seconds: 150, rest: 30, late: true }), "taking longer than expected");
});

test("the list says where each run is", () => {
  const job = recordJob();
  assert.equal(jobStatus(job, 0), "Starting the agent…");
  takeRecord(job, { type: "tool_call", name: "audio_record", inputs: {} }, 1000);
  job.started = 1000;
  assert.equal(jobStatus(job, 76_000), "Recording 1:15");
  takeRecord(job, { type: "tool_result", name: "audio_record", ok: true, output: RECORDED(600) }, 601_000);
  takeRecord(job, { type: "tool_call", name: "audio_transcribe", inputs: {} }, 605_000);
  // The clock is the phase's, from the end of the recording: it moves while nothing else does.
  assert.equal(jobStatus(job, 605_000), "Transcribing 0:04 · about 2 min left");
  assert.equal(jobStatus(job, 640_000, { ...PACE, transcribePerMinute: 0 }), "Transcribing 0:39 · taking longer than expected, then about 1 min");
  Object.assign(job, { done: true, status: 1, problem: { title: "The provider rejected the API key" } });
  assert.equal(jobStatus(job, 0), "Stopped: The provider rejected the API key");
});

test("each run has a stop file of its own, which no earlier stop left", () => {
  assert.equal(stopFileOf(7), "/tmp/minutes-stop-7");
  assert.notEqual(stopFileOf(1), stopFileOf(2));
});

test("one run records at a time, from its start until its recording is made", () => {
  const first = recordJob();
  const answer = newJob({ id: 2, label: "Answer", title: "Sync", action: "a", now: 0 });
  assert.equal(recordingJob([answer]), null);
  assert.equal(recordingJob([answer, first]), first);
  takeRecord(first, { type: "tool_result", name: "audio_record", ok: true, output: RECORDED(60) }, 1000);
  assert.equal(recordingJob([first]), null);
  assert.equal(recordingJob([{ ...recordJob(), done: true }]), null);
});

test("the list keeps runs under way and those that filed nothing, but not one run again", () => {
  const live = recordJob();
  const filed = { ...recordJob(), done: true, filed: "meetings/summaries/a.md" };
  const failed = { ...recordJob(), done: true, status: 1, filed: null };
  const retried = { ...failed, replaced: true };
  assert.deepEqual(listedJobs([live, filed, failed, retried]), [live, failed]);
});

test("the pop-out shows the recording with its clock and Stop, then the time left, then how the run ended", () => {
  const job = { ...recordJob(), stopFile: stopFileOf(1) };
  const shown = (row) => [row.kind, row.state, row.detail];
  assert.deepEqual(shown(popoutRow(job, 0, PACE)), ["working", "", "Starting the agent…"]);
  takeRecord(job, { type: "tool_call", name: "audio_record", inputs: {} }, 1000);
  job.stages.add("recording");
  job.started = 1000;
  assert.equal(isLive(job), true);
  assert.deepEqual(shown(popoutRow(job, 76_000, PACE)), ["recording", "● 1:15", ""]);
  assert.equal(popoutRow(job, 76_000, PACE).stoppable, true);
  job.quiet = true;
  assert.equal(popoutRow(job, 76_000, PACE).detail, "no sound from the tab");
  job.stopSent = true;
  assert.equal(popoutRow(job, 76_000, PACE).stoppable, false);
  takeRecord(job, { type: "tool_result", name: "audio_record", ok: true, output: RECORDED(600) }, 601_000);
  job.stages.add("recorded");
  takeRecord(job, { type: "tool_call", name: "audio_transcribe", inputs: {} }, 605_000);
  const row = popoutRow(job, 605_000, PACE);
  assert.deepEqual(shown(row), ["progress", "Transcribing", "about 2 min left"]);
  assert.ok(row.progress > 0 && row.progress < 1);
  Object.assign(job, { done: true, status: 0, filed: "meetings/summaries/a.md" });
  assert.deepEqual(shown(popoutRow(job, 0, PACE)), ["filed", "✓ Filed", ""]);
  Object.assign(job, { status: 1, problem: { title: "The provider rejected the API key" } });
  assert.deepEqual(shown(popoutRow(job, 0, PACE)), ["stopped", "The agent stopped", "The provider rejected the API key"]);
});

test("a late pop-out row says so briefly, with what follows", () => {
  const job = recordJob();
  takeRecord(job, { type: "tool_result", name: "audio_record", ok: true, output: RECORDED(1800) }, 1000);
  takeRecord(job, { type: "tool_call", name: "audio_transcribe", inputs: {} }, 5000);
  assert.equal(popoutRow(job, 300_000, PACE).detail, "taking longer, then about 3 min");
});

test("a run whose recording failed is the agent's turn, with no time left", () => {
  const job = recordJob();
  takeRecord(job, { type: "tool_call", name: "audio_record", inputs: {} }, 1000);
  job.from = 3000;
  takeRecord(job, { type: "tool_result", name: "audio_record", ok: false, output: "ERROR: no audio captured" }, 3000);
  assert.equal(phaseOf(job), "working");
  assert.equal(estimate(job, 4000, PACE), null);
  assert.deepEqual([popoutRow(job, 4000, PACE).kind, tabStatus([job], null, 4000, PACE).text], ["working", "The agent is working…"]);
});

test("the pop-out shows the runs under way, and keeps those it saw end, but none that ended before or ran again", () => {
  const live = recordJob();
  const filed = { ...recordJob(), id: 2, done: true, filed: "meetings/summaries/a.md" };
  const failed = { ...recordJob(), id: 3, done: true, status: 1, filed: null };
  assert.deepEqual(popoutJobs([live, filed, failed], new Set()), [live]);
  assert.deepEqual(popoutJobs([live, filed, failed], new Set([2, 3])), [live, filed, failed]);
  assert.deepEqual(popoutJobs([{ ...filed, replaced: true }], new Set([2])), []);
});

test("the tab tells of the recording, else of the run nearest done, then of how a run out of sight ended", () => {
  assert.equal(tabStatus([], null, 0, PACE), null);
  assert.deepEqual(tabStatus([recordJob()], null, 0, PACE), { text: "Starting the agent…", icon: { kind: "progress", progress: 0 } });
  const starting = recordJob();
  takeRecord(starting, { type: "tool_call", name: "audio_record", inputs: {} }, 1000);
  assert.equal(tabStatus([starting], null, 2000, PACE).text, "Starting the recording");
  const live = recordJob();
  live.stages.add("recording");
  live.started = 1000;
  assert.deepEqual(tabStatus([live], null, 76_000, PACE), { text: "● 1:15", icon: { kind: "recording" } });
  live.quiet = true;
  assert.equal(tabStatus([live], null, 76_000, PACE).text, "(No sound) ● 1:15");
  const transcribing = (id, seconds) => {
    const job = { ...recordJob(), id };
    takeRecord(job, { type: "tool_result", name: "audio_record", ok: true, output: RECORDED(seconds) }, 1000);
    takeRecord(job, { type: "tool_call", name: "audio_transcribe", inputs: {} }, 2000);
    return job;
  };
  const said = tabStatus([transcribing(2, 600), transcribing(3, 60)], null, 2000, PACE);
  assert.equal(said.text, "40 s left");
  assert.equal(said.icon.kind, "progress");
  const filed = { ...recordJob(), done: true, status: 0, filed: "meetings/summaries/a.md" };
  assert.deepEqual(tabStatus([filed], filed, 0, PACE), { text: "✓ Filed", icon: { kind: "filed" } });
  assert.equal(tabStatus([filed], { ...filed, status: 1 }, 0, PACE).text, "The agent stopped");
});

test("the tab's icon fills its ring in twelfths", () => {
  assert.match(statusIcon({ kind: "progress", progress: 0.5 }), /stroke-dasharray="6 12"/);
  assert.match(statusIcon({ kind: "progress", progress: 0.02 }), /stroke-dasharray="0 12"/);
  assert.match(statusIcon({ kind: "progress", progress: 1.3 }), /stroke-dasharray="12 12"/);
  for (const kind of ["recording", "filed", "stopped"]) assert.match(statusIcon({ kind }), /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 32 32"><(rect|circle) /);
});

test("a run's measured phases move the pace halfway toward them", () => {
  const job = recordJob();
  takeRecord(job, { type: "tool_result", name: "audio_record", ok: true, output: RECORDED(600) }, 1000);
  takeRecord(job, { type: "tool_call", name: "audio_transcribe", inputs: {} }, 13_000);
  takeRecord(job, { type: "tool_result", name: "audio_transcribe", ok: true, output: "x".repeat(8000) }, 73_000);
  Object.assign(job, { agentEndAt: 73_000 + 44_000, savedAt: 73_000 + 44_000 + 9000 });
  const pace = learnPace(PACE, job);
  assert.equal(pace.turn, (8 + 12) / 2);
  assert.equal(pace.transcribePerMinute, (3 + (60 - 6) / 10) / 2);
  assert.equal(pace.charsPerMinute, (1100 + 800) / 2);
  assert.equal(pace.writeCharsPerSecond, (250 + 9500 / (44 - 20)) / 2);
  assert.equal(pace.save, (6 + 8) / 2);
  assert.deepEqual(learnPace(PACE, recordJob()), PACE);
});

const OPENAI = { ...PACE, ...PROVIDER_PACE.openai };
const OPENROUTER = { ...PACE, ...PROVIDER_PACE.openrouter };
const status = (state, detail) => ({ type: "progress", title: "audio_transcribe", state, detail });
// A run whose recording of `seconds` ended at 0 and whose transcription began at 1 s.
const transcribingJob = (seconds) => {
  const job = recordJob();
  takeRecord(job, { type: "tool_result", name: "audio_record", ok: true, output: RECORDED(seconds) }, 0);
  takeRecord(job, { type: "tool_call", name: "audio_transcribe", inputs: {} }, 1000);
  return job;
};
// The time left of the transcribing phase alone, `t` seconds into it.
const transcribingLeft = (job, t, pace) => {
  const guess = estimate(job, 1000 + t * 1000, pace);
  return guess.seconds - guess.rest;
};

test("each provider's measured pace sets the time a transcription takes before any of it is done", () => {
  const job = transcribingJob(600);
  // OpenAI: 3 s, then 22.5 s an audio minute and 2 for the upload; OpenRouter 1.2, then 1.9 and 2.
  assert.equal(Math.round(transcribingLeft(job, 0, OPENAI)), 3 + 245);
  assert.equal(Math.round(transcribingLeft(job, 0, OPENROUTER)), 1 + 39);
  takeRecord(job, status("start", "r.wav · 1 request · 18.3 MB"), 1100);
  assert.equal(job.chunks.total, 1);
  assert.equal(Math.round(transcribingLeft(job, 100, OPENAI)), 248 - 100);
});

test("a streaming provider's segments say how much audio is left, and the time left counts down between them", () => {
  const job = transcribingJob(600);
  takeRecord(job, status("start", "r.wav · 1 request · 18.3 MB"), 1100);
  assert.equal(transcribeDetail(job), "");
  takeRecord(job, status("update", "heard 02:00"), 61_000);
  assert.deepEqual(job.heard, { seconds: 120, at: 61_000 });
  assert.equal(transcribeDetail(job), "heard 2:00 of 10:00");
  // Eight minutes of audio left at 24.5 s a minute.
  assert.equal(Math.round(transcribingLeft(job, 60, OPENAI)), 196);
  assert.equal(Math.round(transcribingLeft(job, 70, OPENAI)), 186);
  // A segment past the recording's end leaves nothing of the request: before the first estimate
  // ran out, the run is on time; after it, late.
  takeRecord(job, status("update", "heard 10:01"), 200_000);
  assert.equal(transcribeDetail(job), "heard 10:00 of 10:00");
  assert.equal(estimate(job, 200_000, OPENAI).late, false);
  takeRecord(job, status("update", "heard 10:01"), 300_000);
  assert.equal(estimate(job, 300_000, OPENAI).late, true);
});

test("a request past its estimate says so, still creeps toward done, and counts down again once segments come", () => {
  const job = transcribingJob(60);
  takeRecord(job, status("start", "r.wav · 1 request · 1.8 MB"), 1100);
  // 3 + 24.5 s, so 40 s in it is late.
  const late = estimate(job, 41_000, OPENAI);
  const later = estimate(job, 121_000, OPENAI);
  assert.ok(!estimate(job, 20_000, OPENAI).late && late.late && later.late);
  assert.match(leftText(late), /^taking longer than expected/);
  assert.ok(later.progress > late.progress && later.progress < 1);
  assert.equal(later.seconds, later.rest);
  // Half the audio heard leaves 12 s: a countdown again, but not for a moment's worth.
  takeRecord(job, status("update", "heard 00:30"), 121_000);
  const back = estimate(job, 122_000, OPENAI);
  assert.equal(back.late, false);
  assert.match(leftText(back), /left$/);
  assert.equal(estimate(job, 124_000, OPENAI).late, true);
  takeRecord(job, status("update", "heard 00:59"), 130_000);
  assert.equal(estimate(job, 130_000, OPENAI).late, true);
});

test("the time left never stands still or goes below zero, however long a phase runs over", () => {
  const job = transcribingJob(1800);
  let last = null;
  let lastChange = 0;
  let text = "";
  for (let t = 0; t <= 3 * 3600; t += 1) {
    const guess = estimate(job, 1000 + t * 1000, OPENAI);
    assert.ok(guess.seconds >= 0 && guess.progress < 1, `at ${t} s: ${JSON.stringify(guess)}`);
    if (last) assert.ok(guess.progress > last.progress, `the hatching stopped at ${t} s`);
    const said = leftText(guess);
    if (said !== text) [text, lastChange] = [said, t];
    // Until the phase is late, the words change at least once a minute and a half.
    if (!guess.late) assert.ok(t - lastChange <= 90, `"${said}" stood for ${t - lastChange} s at ${t} s`);
    last = guess;
  }
  assert.match(text, /^taking longer than expected, then about \d+ min$/);
});

test("a recording the page encodes first adds the encode, which ends when the request leaves", () => {
  const job = transcribingJob(1800);
  takeRecord(job, status("start", "r.wav · 55.3 MB · encoding for 1 request"), 1100);
  assert.equal(job.encodeAt, 1100);
  assert.equal(transcribeDetail(job), "preparing the recording");
  // 1 s an audio minute to encode, then 1.2 + 3.9 s a minute.
  assert.equal(Math.round(transcribingLeft(job, 0, OPENROUTER)), Math.round(30 + 1.2 + 117));
  takeRecord(job, status("update", "requesting · 13.8 MB"), 51_000);
  assert.equal(job.requestAt, 51_000);
  assert.equal(transcribeDetail(job), "");
  assert.equal(Math.round(transcribingLeft(job, 60, OPENROUTER)), Math.round(50 + 1.2 + 117 - 60));
});

// clai's survey path (OpenAI's diarizer past one request): every part at once, in rounds.
const SURVEY_START = "speaker labelling  r.wav  5 chunks × 21m26s  ≤23 requests";
const surveyRound = (pace, seconds, parts) => (pace.transcribePerMinute * (seconds / parts + 88)) / 60;

test("a recording on the survey path takes rounds of one part, not its minutes", () => {
  // The Retro of 2026-11-22: 87.6 min in 5 parts took 29.7 min, where 24.5 s a minute gave 59.
  const job = transcribingJob(5256);
  const round = surveyRound(OPENAI, 5256, 5);
  const before = OPENAI.transcribeFixed + 3 * round + 4 * OPENAI.mergeLink + OPENAI.naming;
  assert.equal(Math.round(transcribingLeft(job, 0, OPENAI)), Math.round(before));
  assert.ok(before > 25 * 60 && before < 31 * 60, `${before} s`);
  // The steps clai names each leave what comes after them; the first round's own time paces the rest.
  takeRecord(job, status("start", SURVEY_START), 1000);
  takeRecord(job, status("update", "finding voices · 5 chunks"), 1000);
  assert.equal(transcribeDetail(job), "finding the voices in 5 parts");
  takeRecord(job, status("update", "matching voices · 26 clips"), 446_000);
  assert.equal(transcribeDetail(job), "matching the voices across the parts");
  assert.equal(Math.round(transcribingLeft(job, 445, OPENAI)), 4 * OPENAI.mergeLink + 2 * 445 + OPENAI.naming);
  takeRecord(job, status("update", "labelling · 5 chunks · 6 speakers"), 713_000);
  assert.equal(Math.round(transcribingLeft(job, 712, OPENAI)), 2 * 445 + OPENAI.naming);
  takeRecord(job, { ...status("done", "labelled · 5 speakers"), row: "00:00–17:29" }, 1_100_000);
  assert.equal(Math.round(transcribingLeft(job, 1099, OPENAI)), 2 * 445 + OPENAI.naming - (1099 - 712), "a part done is no round done");
  takeRecord(job, status("update", "second try · 5 chunks with unmatched voices"), 1_146_000);
  assert.equal(transcribeDetail(job), "a second try at the voices left over");
  assert.equal(Math.round(transcribingLeft(job, 1145, OPENAI)), 445 + OPENAI.naming);
  takeRecord(job, status("update", "stitching"), 1_546_000);
  assert.equal(transcribeDetail(job), "naming the speakers");
  assert.equal(Math.round(transcribingLeft(job, 1545, OPENAI)), OPENAI.naming);
});

test("a survey run teaches the round, the merge link and the naming it took", () => {
  const job = transcribingJob(5256);
  takeRecord(job, status("start", SURVEY_START), 1000);
  takeRecord(job, status("update", "finding voices · 5 chunks"), 1000);
  takeRecord(job, status("update", "matching voices · 26 clips"), 446_000);
  takeRecord(job, status("update", "labelling · 5 chunks · 6 speakers"), 714_000);
  takeRecord(job, status("update", "stitching"), 1_546_000);
  takeRecord(job, status("done", "requests 23/≤23 · 26m10s elapsed"), 1_546_000);
  takeRecord(job, { type: "tool_result", name: "audio_transcribe", ok: true, output: "x".repeat(90_000) }, 1_626_000);
  const pace = learnPace(OPENAI, job);
  assert.equal(pace.transcribePerMinute, (OPENAI.transcribePerMinute + 445 / ((5256 / 5 + 88) / 60)) / 2);
  assert.equal(pace.mergeLink, (OPENAI.mergeLink + 268 / 4) / 2);
  assert.equal(pace.naming, (OPENAI.naming + 80) / 2);
});

test("an encoded recording too long for one request is split, and its chunks set the pace", () => {
  const job = transcribingJob(4000);
  takeRecord(job, status("start", "r.wav · 128.0 MB · encoding for 1 request"), 1100);
  takeRecord(job, status("update", "encoded 30.5 MB, over the 25 MB request cap: splitting"), 41_000);
  assert.equal(job.requestAt, 41_000);
  takeRecord(job, status("start", "splitting via ffmpeg  r.mp3  30.5 MB > 25 MB limit  2 chunks × 33.3 min  3 workers  speaker labels per chunk"), 42_000);
  assert.equal(job.chunks.total, 2);
  takeRecord(job, { ...status("update", "transcribing"), row: "00:00–33:20" }, 42_000);
  takeRecord(job, { ...status("done", "transcribed · 300 segments"), row: "00:00–33:20" }, 101_000);
  assert.equal(transcribeDetail(job), "1 of 2 parts done");
  assert.equal(job.heard, null);
  // One of two in 100 s since the tool call leaves 100.
  assert.equal(Math.round(transcribingLeft(job, 100, OPENROUTER)), 100);
});

test("the encode and the request each teach the pace they took", () => {
  const job = transcribingJob(1200);
  takeRecord(job, status("start", "r.wav · 36.6 MB · encoding for 1 request"), 1000);
  takeRecord(job, status("update", "requesting · 9.2 MB"), 41_000);
  takeRecord(job, { type: "tool_result", name: "audio_transcribe", ok: true, output: "x".repeat(22_000) }, 121_000);
  const pace = learnPace(OPENROUTER, job);
  assert.equal(pace.encodePerMinute, (1 + 40 / 20) / 2);
  assert.equal(pace.transcribePerMinute, (3.9 + (80 - 1.2) / 20) / 2);
});

test("a file a run wrote names the meeting it filed", () => {
  assert.equal(summaryOf("/home/user/notebook/meetings/summaries/2026-11-16T10-00Z_sync.md"), "meetings/summaries/2026-11-16T10-00Z_sync.md");
  assert.equal(summaryOf("meetings/transcripts/2026-11-16T10-00Z_sync.md"), "meetings/summaries/2026-11-16T10-00Z_sync.md");
  assert.equal(summaryOf("/tmp/recordings/r.wav"), null);
  assert.equal(summaryOf("meetings/summaries/old/x.txt"), null);
});

test("a run names the conversation clai saved it in, and none until clai says", () => {
  const run = new AgentRun();
  run.take(JSON.stringify({ type: "reply", text: "Who is Speaker A?" }));
  assert.equal(run.chat, null);
  run.take(JSON.stringify({ type: "chat", id: "019a7c2e-4b1d-7f3a-9c2e-1d4b5a6f7e80" }));
  assert.equal(run.chat, "019a7c2e-4b1d-7f3a-9c2e-1d4b5a6f7e80");
  assert.equal(run.text, "Who is Speaker A?");
});

test("the terminal shows the saved conversation as a line, not as JSON", () => {
  assert.equal(drawn([{ type: "chat", id: "c1" }]), "conversation c1\r\n");
});

// agentLine as a Minutes with `config` builds it, signed out, with no provider connected.
const lineOf = (query, chat, profile) => Minutes.prototype.agentLine.call(
  { config: { ...DEFAULTS, profile: "/tmp/meeting.json" }, env: new Map(), login: null, connected: false, cd: () => "cd ~/notebook" },
  query, chat, profile,
);

test("a reply names the conversation it goes on with; the notebook's last one is never taken", () => {
  const answer = lineOf("Ada is Speaker A", "019a7c2e-4b1d-7f3a-9c2e-1d4b5a6f7e80");
  assert.match(answer, /clai -json chat continue -reply-only -n -af json -profile-path \/tmp\/meeting.json '019a7c2e-4b1d-7f3a-9c2e-1d4b5a6f7e80' 'Ada is Speaker A'/);
  assert.doesNotMatch(answer, /-dre|query/);
  for (const fresh of [lineOf("Meeting: Standup."), lineOf("Meeting: Standup.", null)]) {
    assert.match(fresh, /clai -json -reply-only -n -af json -profile-path \/tmp\/meeting.json query 'Meeting: Standup.'/);
    assert.doesNotMatch(fresh, /-dre|chat continue/);
  }
  // A reply runs the version its conversation started with.
  const pin = `cchub:a/b#sha256=${"c".repeat(64)}`;
  assert.match(lineOf("And Bo is B", "c1", pin), new RegExp(`chat continue -reply-only -n -af json -profile-path ${pin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 'c1' 'And Bo is B'`));
});

test("a filed meeting goes on in the conversation of the newest run that filed it or was about it", () => {
  const path = "meetings/summaries/2026-11-16T10-00Z_first.md";
  const jobs = [
    { label: "Record", chat: "other", filed: "meetings/summaries/2026-11-16T11-00Z_second.md" },
    { label: "Name the speakers", chat: null, path },
    { label: "Answer", chat: "answered", filed: path },
    { label: "Record", chat: "recorded", filed: path },
  ];
  assert.equal(conversationOf(jobs, path)?.chat, "answered");
  assert.equal(conversationOf(jobs.slice(3), path)?.chat, "recorded");
  assert.equal(conversationOf([{ label: "Name the speakers", chat: "renamed", path }, ...jobs], path)?.chat, "renamed");
  // The run is returned whole: a reply takes the agent's version from it too.
  assert.equal(conversationOf([{ label: "Record", chat: "pinned", profile: "cchub:a/b#sha256=x", filed: path }], path)?.profile, "cchub:a/b#sha256=x");
  // A meeting no run of this tab filed, as after a reload: a new conversation.
  assert.equal(conversationOf(jobs, "meetings/summaries/2026-10-28T09-00Z_design-review.md"), null);
  assert.equal(conversationOf([], path), null);
});

// A 16-bit PCM WAV of `samples`, interleaved over `channels`, with `size` as its data chunk's size.
const wav = (samples, { channels = 1, rate = 16000, size = samples.length * 2, extra = 0 } = {}) => {
  const bytes = new Uint8Array(44 + extra + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const put = (at, text) => [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  put(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  let at = 36;
  if (extra) {
    put(at, "LIST");
    view.setUint32(at + 4, extra - 8, true);
    at += extra;
  }
  put(at, "data");
  view.setUint32(at + 4, size, true);
  samples.forEach((s, i) => view.setInt16(at + 8 + i * 2, s, true));
  return bytes;
};

test("a recording downloads named for its meeting's title and day", () => {
  assert.equal(recordingName("Daily sync", new Date(2026, 10, 16, 9, 30)), "Daily-sync-2026-11-16.wav");
  assert.equal(recordingName("Päivän palaveri: Q4 / budget", new Date(2026, 0, 5)), "Päivän-palaveri-Q4-budget-2026-01-05.wav");
  assert.equal(recordingName("Retro", null), "Retro.wav");
  assert.equal(recordingName("../..", new Date(Number.NaN)), "recording.wav");
  assert.equal(recordingName(undefined), "recording.wav");
});

test("the player says where it is as m:ss of the length, and h:mm:ss past an hour", () => {
  assert.equal(timeText(83.9, 760), "1:23 of 12:40");
  assert.equal(timeText(0, 3725), "0:00 of 1:02:05");
});

test("a 16-bit PCM WAV's samples are found past the chunks before them, and anything else is not read", () => {
  const plain = wav(new Array(32000).fill(0));
  assert.deepEqual(wavFormat(plain.buffer, plain.length), { channels: 1, rate: 16000, start: 44, frames: 32000, seconds: 2 });
  const listed = wav(new Array(8).fill(0), { channels: 2, extra: 26 });
  assert.deepEqual(wavFormat(listed.buffer, listed.length), { channels: 2, rate: 16000, start: 70, frames: 4, seconds: 4 / 16000 });
  // A WAV written to a pipe leaves the size unset: the samples run to the end of the file.
  const piped = wav(new Array(1600).fill(0), { size: 0xffffffff });
  assert.equal(wavFormat(piped.buffer, piped.length).frames, 1600);
  const cut = wav(new Array(1600).fill(0));
  assert.equal(wavFormat(cut.slice(0, 44 + 1000).buffer, 44 + 1000).frames, 500);
  const float = wav([0]);
  new DataView(float.buffer).setUint16(20, 3, true);
  assert.equal(wavFormat(float.buffer, float.length), null);
  assert.equal(wavFormat(new TextEncoder().encode("ID3 not a wave at all").buffer, 21), null);
});

test("the wave is each stretch's loudest sample, read in parts, as 0 to 1 of the loudest stretch", () => {
  const samples = [...new Array(400).fill(100), ...new Array(400).fill(-3000), ...new Array(400).fill(0), ...new Array(400).fill(30000)];
  const file = wav(samples);
  const format = wavFormat(file.buffer, file.length);
  const peaks = new Array(4).fill(0);
  // Two parts, split mid-stretch, add up to the whole.
  addPeaks(peaks, file.subarray(44, 44 + 1200), 0, format);
  addPeaks(peaks, file.subarray(44 + 1200), 600, format);
  assert.deepEqual(peaks, [100, 3000, 0, 30000]);
  const levels = inkLevels(peaks);
  assert.equal(levels[3], 1);
  assert.equal(levels[2], 0);
  assert.ok(levels[1] > 3000 / 30000, "quiet speech is lifted");
  // Stereo is read from its first channel.
  const stereo = wav([5, 9000, 7, 9000, 6, 9000, 8, 9000], { channels: 2 });
  const two = [0, 0];
  addPeaks(two, stereo.subarray(44), 0, wavFormat(stereo.buffer, stereo.length));
  assert.deepEqual(two, [5, 0]);
});

test("the wave is drawn with a bar every few pixels, each the loudest it takes in, as one pencil stroke", () => {
  assert.deepEqual(fewer([0.1, 0.9, 0.2, 0.3, 0.5, 0.4], 3), [0.9, 0.3, 0.5]);
  assert.deepEqual(fewer([0.1, 0.2], 5), [0.1, 0.2]);
  // Silence is a dot on the line; the loudest reaches near the top and bottom, and may lean.
  assert.equal(wavePath([0, 0, 1]), "M0.52 16.5L0.48 15.5M1.50 16.5L1.50 15.5M2.32 30.0L2.68 2.0");
});

test("the pen draws the wave stroke by stroke, up one bar and down the next, on the strokes' own ends", () => {
  // Even bars from the bottom up, odd ones from the top down, so the pen zigzags along the wave.
  assert.deepEqual(waveStrokes([0, 0, 1]), [
    { x0: 0.52, y0: 16.5, x1: 0.48, y1: 15.5 },
    { x0: 1.5, y0: 15.5, x1: 1.5, y1: 16.5 },
    { x0: 2.32, y0: 30, x1: 2.68, y1: 2 },
  ]);
  // Halfway up the loud bar: the two before it whole, it to the pen's point.
  assert.deepEqual(waveSoFar([0, 0, 1], 2, 0.5), {
    d: "M0.52 16.5L0.48 15.5M1.50 15.5L1.50 16.5M2.32 30.0L2.50 16.0", x: 2.5, y: 16,
  });
  assert.deepEqual(waveSoFar([0, 0, 1], 0, 0), { d: "M0.52 16.5L0.52 16.5", x: 0.52, y: 16.5 });
  // Done: every stroke, the pen at the last one's end.
  const done = waveSoFar([0, 0, 1], 3, 0);
  assert.equal(done.d, "M0.52 16.5L0.48 15.5M1.50 15.5L1.50 16.5M2.32 30.0L2.68 2.0");
  assert.deepEqual([done.x, done.y], [2.68, 2]);
  // A short wave takes a little over a second, a long one no more than about two and a half.
  assert.equal(drawInMs(24), 1100);
  assert.equal(drawInMs(120), 1680);
  assert.equal(drawInMs(600), 2600);
});

test("a recording goes back to the machine as base64, whatever its size", () => {
  const bytes = new Uint8Array(100_003).map((_, i) => (i * 7919) & 255);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
  assert.equal(toBase64(new Uint8Array()), "");
});

test("a meeting is transcribed again from its recording put back on the machine, over its own two files", () => {
  const path = "meetings/summaries/2026-11-16T10-00Z_daily sync.md";
  assert.equal(againPath(path), "/tmp/recordings/again-2026-11-16T10-00Z_daily-sync.wav");
  const text = againText(againPath(path), path);
  assert.ok(text.includes("/tmp/recordings/again-2026-11-16T10-00Z_daily-sync.wav"));
  assert.ok(text.includes(path) && text.includes("meetings/transcripts/2026-11-16T10-00Z_daily sync.md"));
  assert.match(text, /Do not record again/);
  assert.match(text, /File nothing under another name/);
});

test("Transcribe again says the corrections are replaced, and whether the notebook keeps this version", () => {
  assert.match(againWarning(true), /corrections to them are replaced\. This version stays in the notebook's history on slivingdoc\.$/);
  assert.match(againWarning(false), /keeps no history, so this version will be gone\.$/);
});

test("a meeting can be transcribed again while this browser keeps its recording and no run is about it", () => {
  const c = { path: "meetings/summaries/2026-11-16T10-00Z_first.md" };
  assert.equal(canTranscribeAgain(null, true, []), false);
  assert.equal(canTranscribeAgain(c, false, []), false);
  assert.equal(canTranscribeAgain(c, true, []), true);
  for (const about of [{ again: c.path }, { path: c.path }, { filed: c.path }]) {
    assert.equal(canTranscribeAgain(c, true, [{ done: false, ...about }]), false, JSON.stringify(about));
    assert.equal(canTranscribeAgain(c, true, [{ done: true, ...about }]), true, JSON.stringify(about));
  }
  // Another meeting's run, even a recording, leaves it be.
  assert.equal(canTranscribeAgain(c, true, [{ done: false, recording: true, path: undefined }, { done: false, again: "meetings/summaries/x.md" }]), true);
});

test("a meeting can be deleted while no run is about it", () => {
  const c = { path: "meetings/summaries/2026-11-16T10-00Z_first.md" };
  assert.equal(canDelete(null, []), false);
  assert.equal(canDelete(c, []), true);
  for (const about of [{ again: c.path }, { path: c.path }, { filed: c.path }]) {
    assert.equal(canDelete(c, [{ done: false, ...about }]), false, JSON.stringify(about));
    assert.equal(canDelete(c, [{ done: true, ...about }]), true, JSON.stringify(about));
  }
  assert.equal(canDelete(c, [{ done: false, again: "meetings/summaries/x.md" }]), true);
});

test("Penelope asks once for the meetings she would delete, and says what became of them", () => {
  const one = deleteAsk(["Daily sync"], true);
  assert.match(one.text, /^Shall I delete “Daily sync”\? Its notes leave the notebook, and any recording this browser keeps of it is erased for good\. The notes stay in the notebook's history on slivingdoc\.$/);
  assert.deepEqual([one.yes, one.no], ["Delete it", "Keep it"]);
  const three = deleteAsk(["A", "B", "C"], false);
  assert.match(three.text, /^Shall I delete “A”, “B” and “C”\? Their notes .* of them is erased for good\. The notebook in this browser keeps no history, so the notes are gone for good too\.$/);
  assert.deepEqual([three.yes, three.no], ["Delete all 3", "Keep them"]);
  assert.deepEqual(deleteSaid(["A", "B"], []), { say: "Deleted “A” and “B”.", mood: "glad" });
  assert.deepEqual(deleteSaid(["A"], ["B"]), { say: "Deleted “A”. I could not delete “B”; the note under the peek says why.", mood: "sorry" });
  assert.equal(deleteSaid([], ["B"]).mood, "sorry");
});

test("the eraser says what goes, and what the notebook's history keeps", () => {
  assert.match(deleteWarning(true, true), /^Its summary and transcript leave the notebook, and its recording is erased from this browser\. The notes stay in the notebook's history on slivingdoc; the recording is gone for good\.$/);
  assert.match(deleteWarning(true, false), /^Its summary and transcript leave the notebook\. The notes stay in the notebook's history on slivingdoc\.$/);
  assert.match(deleteWarning(false, true), /erased from this browser\. The notebook in this browser keeps no history, so it is gone for good\.$/);
  assert.match(deleteWarning(false, false, 2), /leave the notebook\. Your unsaved corrections go with them\. The notebook in this browser/);
});

test("the doodles scribble only what the run in view did", () => {
  const log = [
    { kind: "exec", text: "ffprobe of the other run", action: "minutes:Record#1" },
    { kind: "exec", text: "clai of this run", action: "minutes:Record#2" },
    { kind: "fs", text: "writes /run/page/out", action: "machine" },
  ];
  const doodles = new Doodles(null, { log });
  doodles.action = "minutes:Record#2";
  doodles.since = 0;
  assert.equal(doodles.nextLine(), "exec: clai of this run");
  assert.equal(doodles.nextLine(), "exec: clai of this run");
  doodles.action = "";
  assert.equal(doodles.nextLine(), null);
});

test("Penelope looks toward the pointer, less when it is close, and jumps at it only so far", () => {
  assert.deepEqual(gaze(0, 0), { x: 0, y: 0 });
  const far = gaze(-300, 0);
  assert.ok(Math.abs(far.x + 1.7) < 1e-9 && Math.abs(far.y) < 1e-9);
  const near = gaze(-30, 0);
  assert.ok(Math.abs(near.x + 0.85) < 1e-9);
  const up = lunge(-600, -800);
  assert.ok(Math.abs(Math.hypot(up.x, up.y) - 170) < 1e-9);
  assert.ok(Math.abs(up.turn + 10.2) < 1e-9);
  assert.equal(lunge(0, 500).y, 30);
  assert.equal(lunge(-1000, 0).turn, -15);
  // She eats a pointer she gets all the way to, and snaps at one too far or below her reach.
  assert.equal(lunge(-120, -20).reached, true);
  assert.equal(up.reached, false);
  assert.equal(lunge(0, 100).reached, false);
});

// Linear's documents as mcp.linear.app served them on 2026-11-18, trimmed to what a sign-in reads.
const LINEAR_PRM = { resource: "https://mcp.linear.app/mcp", authorization_servers: ["https://mcp.linear.app"], scopes_supported: ["read", "write"] };
const LINEAR_AS = {
  issuer: "https://mcp.linear.app", authorization_endpoint: "https://mcp.linear.app/authorize", token_endpoint: "https://mcp.linear.app/token",
  registration_endpoint: "https://mcp.linear.app/register", revocation_endpoint: "https://mcp.linear.app/token", code_challenge_methods_supported: ["S256"],
};
const LINEAR = MCP_SERVERS.find((s) => s.id === "linear");

// A fetch that answers each URL from `routes` (a body, or [status, body]) and keeps what it was sent.
function fakeFetch(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (!(url in routes)) return new Response("not found", { status: 404 });
    const [status, body] = Array.isArray(routes[url]) ? routes[url] : [200, routes[url]];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetchFn, calls };
}

const linearRoutes = (prm = LINEAR_PRM, as = LINEAR_AS) => ({
  "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": prm,
  "https://mcp.linear.app/.well-known/oauth-authorization-server": as,
});

test("a server's well-known documents sit between its host and its path", () => {
  assert.equal(wellKnown("https://mcp.linear.app/mcp", "oauth-protected-resource"), "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp");
  assert.equal(wellKnown("https://mcp.linear.app", "oauth-authorization-server"), "https://mcp.linear.app/.well-known/oauth-authorization-server");
  assert.equal(wellKnown("https://id.example/tenant/", "oauth-authorization-server"), "https://id.example/.well-known/oauth-authorization-server/tenant");
  assert.ok(covers("https://mcp.linear.app/mcp", "https://mcp.linear.app/mcp"));
  assert.ok(covers("https://mcp.linear.app", "https://mcp.linear.app/mcp"));
  assert.ok(!covers("https://mcp.linear.app/mc", "https://mcp.linear.app/mcp"));
  assert.ok(!covers("https://evil.example/mcp", "https://mcp.linear.app/mcp"));
});

test("discovery reads Linear's documents into where its sign-in happens", async () => {
  const { fetchFn } = fakeFetch(linearRoutes());
  assert.deepEqual(await discover(LINEAR, fetchFn), {
    issuer: "https://mcp.linear.app", resource: "https://mcp.linear.app/mcp", scopes: ["read", "write"],
    authorize: "https://mcp.linear.app/authorize", token: "https://mcp.linear.app/token", register: "https://mcp.linear.app/register",
    revoke: "https://mcp.linear.app/token",
  });
});

test("discovery refuses documents about something else, or a sign-in clai's would not do", async () => {
  const refused = async (routes, words) => {
    const { fetchFn } = fakeFetch(routes);
    await assert.rejects(discover(LINEAR, fetchFn), (e) => e.message.includes(words));
  };
  await refused(linearRoutes({ ...LINEAR_PRM, resource: "https://other.example/mcp" }), "is for https://other.example/mcp");
  await refused(linearRoutes(LINEAR_PRM, { ...LINEAR_AS, issuer: "https://other.example" }), "says it is https://other.example");
  await refused(linearRoutes(LINEAR_PRM, { ...LINEAR_AS, code_challenge_methods_supported: ["plain"] }), "PKCE");
  await refused(linearRoutes(LINEAR_PRM, { ...LINEAR_AS, token_endpoint: "http://mcp.linear.app/token" }), "token endpoint is not https");
  await refused(linearRoutes(LINEAR_PRM, { ...LINEAR_AS, registration_endpoint: undefined }), "registration endpoint is not a URL");
  await refused({}, "resource document answered 404");
  await refused({ "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": "<html>" }, "is not JSON");
});

test("Penelope registers as a public client of the sign-in server", async () => {
  const meta = await discover(LINEAR, fakeFetch(linearRoutes()).fetchFn);
  const { fetchFn, calls } = fakeFetch({ "https://mcp.linear.app/register": { client_id: "c-1" } });
  assert.deepEqual(await register(meta, "https://penelope.example/signin-callback.html", fetchFn), { id: "c-1", secret: null });
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), {
    client_name: "Penelope", redirect_uris: ["https://penelope.example/signin-callback.html"], grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none",
  });
  const refusing = fakeFetch({ "https://mcp.linear.app/register": [400, { error: "invalid_redirect_uri", error_description: "redirect not allowed" }] });
  await assert.rejects(register(meta, "https://x.example/cb", refusing.fetchFn), /did not register Penelope \(400: redirect not allowed\)/);
});

test("the sign-in page is asked for a code with PKCE, for the server's resource and scopes", async () => {
  const meta = await discover(LINEAR, fakeFetch(linearRoutes()).fetchFn);
  const url = new URL(signinUrl(meta, { clientId: "c-1", callback: "https://penelope.example/signin-callback.html", challenge: "ch", state: "st" }));
  assert.equal(url.origin + url.pathname, "https://mcp.linear.app/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: "code", client_id: "c-1", redirect_uri: "https://penelope.example/signin-callback.html", code_challenge: "ch",
    code_challenge_method: "S256", state: "st", resource: "https://mcp.linear.app/mcp", scope: "read write",
  });
});

test("a code becomes clai's token store entry for the server", async () => {
  const meta = await discover(LINEAR, fakeFetch(linearRoutes()).fetchFn);
  const { fetchFn, calls } = fakeFetch({ "https://mcp.linear.app/token": { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "read write" } });
  const now = Date.parse("2026-11-18T08:00:00Z");
  const entry = await exchangeSignin(meta, { code: "co", verifier: "ve", client: { id: "c-1", secret: null }, callback: "https://p.example/cb" }, fetchFn, now);
  assert.deepEqual(entry, {
    issuer: "https://mcp.linear.app", resource: "https://mcp.linear.app/mcp", client_id: "c-1", access_token: "at", refresh_token: "rt",
    expires_at: "2026-11-18T09:00:00.000Z", scopes: ["read", "write"],
  });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), {
    grant_type: "authorization_code", code: "co", redirect_uri: "https://p.example/cb", client_id: "c-1", code_verifier: "ve", resource: "https://mcp.linear.app/mcp",
  });
  // A token with no expiry gets Go's zero time, which clai reads as never expiring; a client secret is kept for the refresh.
  const forever = tokenEntry(meta, { id: "c-2", secret: "s" }, { access_token: "at" }, now);
  assert.equal(forever.expires_at, "0001-01-01T00:00:00Z");
  assert.equal(forever.client_secret, "s");
  assert.equal("refresh_token" in forever, false);
  assert.deepEqual(forever.scopes, ["read", "write"]);
  const refusing = fakeFetch({ "https://mcp.linear.app/token": [400, { error: "invalid_grant", error_description: "code expired" }] });
  await assert.rejects(exchangeSignin(meta, { code: "co", verifier: "ve", client: { id: "c-1" }, callback: "x" }, refusing.fetchFn), /refused \(400: code expired\)/);
  const sayingNo = fakeFetch({ "https://mcp.linear.app/token": { error: "invalid_client" } });
  await assert.rejects(exchangeSignin(meta, { code: "co", verifier: "ve", client: { id: "c-1" }, callback: "x" }, sayingNo.fetchFn), /invalid_client/);
});

test("signing out revokes the refresh token, and says when the server did not", async () => {
  const entry = { client_id: "c-1", access_token: "at", refresh_token: "rt" };
  const { fetchFn, calls } = fakeFetch({ "https://mcp.linear.app/token": "" });
  assert.equal(await revokeSignin({ entry, revoke: "https://mcp.linear.app/token" }, fetchFn), true);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), { token: "rt", token_type_hint: "refresh_token", client_id: "c-1" });
  assert.equal(await revokeSignin({ entry, revoke: null }, fetchFn), false);
  assert.equal(await revokeSignin({ entry, revoke: "https://mcp.linear.app/token" }, fakeFetch({}).fetchFn), false);
  assert.equal(await revokeSignin({ entry, revoke: "https://x.example" }, async () => { throw new TypeError("offline"); }), false);
});

test("an attached server joins Penelope's profile as an optional url server, with no auth block", () => {
  const profile = JSON.stringify({ model: "m", tools: ["*"], prompt: "p" });
  assert.equal(withServers(profile, []), profile);
  assert.deepEqual(JSON.parse(withServers(profile, [LINEAR])), {
    model: "m", tools: ["*"], prompt: "p", mcp_servers: { linear: { url: "https://mcp.linear.app/mcp", optional: true } },
  });
});

test("the browser keeps only sign-ins it can use, and attaches only signed-in servers", async () => {
  assert.deepEqual(mcpState(null), { attached: [], signins: {}, clients: {} });
  assert.deepEqual(mcpState("not json"), { attached: [], signins: {}, clients: {} });
  const kept = mcpState(JSON.stringify({
    attached: ["linear", "linear", "gone"],
    signins: { linear: { entry: { access_token: "at" }, revoke: null }, gone: { entry: { access_token: "x" } }, broken: {} },
    clients: { "https://mcp.linear.app https://p.example/cb": { id: "c-1", secret: null } },
  }));
  assert.deepEqual(kept.attached, ["linear"]);
  assert.deepEqual(Object.keys(kept.signins), ["linear"]);
  assert.equal(kept.clients["https://mcp.linear.app https://p.example/cb"].id, "c-1");
  assert.deepEqual(mcpState(JSON.stringify({ attached: ["linear"] })).attached, []);
  assert.equal(await tokenName("linear"), `${createHash("sha256").update("linear").digest("hex")}.json`);
});

test("the user's ink is a smooth stroke through the points the pen passed, and a dot when it did not move", () => {
  assert.equal(inkPath([]), "");
  assert.equal(inkPath([[10, 20]]), "M10 20l0.1 0");
  assert.equal(inkPath([[0, 0], [10, 0]]), "M0 0L10 0");
  assert.equal(inkPath([[0, 0], [10, 0], [20, 10], [30, 10]]), "M0 0Q10 0 15 5Q20 10 25 10L30 10");
  assert.equal(inkPath([[0.123, 1.987], [2.04, 3]]), "M0.1 2L2 3");
});

test("a voice keeper with no storage keeps nothing and runs nothing", async () => {
  let runs = 0;
  const run = async () => {
    runs += 1;
    return { status: 0, body: "" };
  };
  const failing = {
    open() {
      const request = {};
      setTimeout(() => request.onerror?.({ target: request }));
      return request;
    },
  };
  for (const indexedDB of [undefined, failing]) {
    const keeper = new VoiceKeeper({ run, indexedDB });
    assert.equal(await keeper.put(), true);
    assert.equal(await keeper.take(), false);
    assert.deepEqual(await keeper.people(), []);
  }
  assert.equal(runs, 0);
});

test("a segment keeper with no storage keeps nothing", async () => {
  const path = "meetings/summaries/2026-11-16T10-00Z_daily sync.md";
  const segments = [
    { start: 0, end: 8.2, speaker: "Lorentz", voice: { clip: "lorentz/9f3c2a1b0d4e", status: "confirmed" }, text: "…" },
    { start: 9, end: 15.5, speaker: "B", text: "…" },
  ];
  const naming = { status: "named", origin: "flag", speakers: [{ label: "B", reason: "no-match" }], voices: [{ name: "Lorentz", result: "named" }] };
  const failing = {
    open() {
      const request = {};
      setTimeout(() => request.onerror?.({ target: request }));
      return request;
    },
  };
  for (const indexedDB of [undefined, failing]) {
    const keeper = new SegmentKeeper(indexedDB);
    assert.equal(await keeper.keep(path, segments, naming, [{ name: "Christoph", clip: "4be07c19a2f1" }]), false);
    assert.equal(await keeper.get(path), null);
    assert.equal(await keeper.remove(path), false);
  }
});

const STANDING_MEETINGS = [
  { path: "a.md", title: "Daily sync" },
  { path: "b.md", title: "Design review" },
  { path: "c.md", title: "daily sync " },
];

// sameTitle.1
test("the last meeting with the same title", () => {
  assert.equal(sameTitle(STANDING_MEETINGS, "Daily sync")?.path, "a.md");
  assert.equal(sameTitle(STANDING_MEETINGS, " DAILY SYNC ")?.path, "a.md");
  for (const title of ["Daily", "", "  "]) assert.equal(sameTitle(STANDING_MEETINGS, title), null);
});

// spokeIn.1
test("the library's people who spoke in a transcript", () => {
  const people = ["Ada", "Christoph", "Lorentz"].map((name) => ({ name, slug: name.toLowerCase(), clips: [] }));
  const transcript = "---\ntitle: Daily sync\n---\n\n[0:00] Lorentz: good morning\n[0:04] Speaker B: morning\n" +
    "[0:09] christoph: shall we start\n[0:12] Grace: yes\n";
  assert.deepEqual(spokeIn(transcript, people), ["Christoph", "Lorentz"]);
  assert.deepEqual(spokeIn("[0:00] Speaker A: hello\n[0:03] Speaker B: hi\n[0:05] Unknown speaker 2: hey\n", people), []);
  assert.deepEqual(spokeIn(transcript, []), []);
});

// The voice review's standing state (phase 4, Test cases).
const lorentzVoice = { clip: "lorentz/e81d5530c6a9", status: "confirmed" };
const REVIEW_SEGMENTS = [
  { start: 0, end: 8.2, speaker: "Lorentz", voice: lorentzVoice, text: "Good morning, everyone, shall we start?" },
  { start: 9, end: 15.5, speaker: "B", text: "Morning. I have last week's numbers ready." },
  { start: 15.9, end: 18.4, speaker: "B", text: "They look better." },
  { start: 19.5, end: 21, speaker: "Lorentz", voice: lorentzVoice, text: "Great." },
  { start: 21.2, end: 22, speaker: "B", text: "Yes." },
  { start: 61.2, end: 69, speaker: "Syrus", voice: { clip: "syrus/3d81f60a2b97", status: "unconfirmed" }, text: "I will take the release notes this time." },
  { start: 70, end: 84, speaker: "C", text: "Then I will write up the design review for Friday." },
  { start: 90, end: 91.5, speaker: "D", text: "Thanks, all." },
];
const reviewPerson = (name, ...clips) => ({
  name, slug: name.toLowerCase(), clips: clips.map(([id, status]) => ({ id, status, source: "voices add", seconds: 8, added: "2026-11-16T10:00:00Z" })),
});
const reviewState = ({ christoph = "unconfirmed", rename = false, kept = true } = {}) => {
  const filed = transcriptLines(JSON.stringify(REVIEW_SEGMENTS));
  const transcript = rename ? named(filed, "Lorentz", "Ada") : filed;
  return {
    path: "meetings/summaries/2026-11-16T10-00Z_daily-sync.md",
    transcript,
    unknown: unknownSpeakers(transcript),
    kept: kept ? {
      segments: REVIEW_SEGMENTS,
      naming: { status: "named", origin: "flag", speakers: [], voices: [{ name: "Lorentz", result: "named" }, { name: "Ada", result: "unknown-voice" }] },
      learned: [{ name: "Christoph", clip: "4be07c19a2f1" }, { name: "Ada", clip: "0123456789ab" }],
    } : null,
    people: [
      reviewPerson("Christoph", ["4be07c19a2f1", christoph]),
      reviewPerson("Lorentz", ["9f3c2a1b0d4e", "confirmed"], ["e81d5530c6a9", "confirmed"]),
      reviewPerson("Syrus", ["3d81f60a2b97", "unconfirmed"]),
    ],
    playable: true,
    busy: false,
  };
};

// rememberSpan.1–.4, L4.1
test("the span to remember a speaker by", () => {
  assert.deepEqual(rememberSpan(REVIEW_SEGMENTS, "Speaker B"), { start: 9, end: 18.4 });
  assert.deepEqual(rememberSpan(REVIEW_SEGMENTS, "Speaker C"), { start: 70, end: 80 });
  assert.equal(rememberSpan(REVIEW_SEGMENTS, "Speaker D"), null);
  assert.deepEqual(rememberSpan(REVIEW_SEGMENTS, "Lorentz"), { start: 0, end: 8.2 });
  assert.equal(rememberSpan(REVIEW_SEGMENTS, "Speaker E"), null);
  assert.equal(rememberSpan(REVIEW_SEGMENTS, "B"), null);
  // a pause over 1 s ends a run; the earliest of equal runs; a float pause of 1 s still joins
  const at = (start, end, speaker = "A") => ({ start, end, speaker, text: "x" });
  assert.equal(rememberSpan([at(0, 2), at(3.1, 5)], "Speaker A"), null);
  assert.deepEqual(rememberSpan([at(0, 4), at(5.5, 9.5), at(20, 24)], "Speaker A"), { start: 0, end: 4 });
  assert.deepEqual(rememberSpan([at(20.3, 21.3), at(22.3, 23.3), at(23.4, 24)], "Speaker A"), { start: 20.3, end: 24 });
});

// reviewRows.1–.4
test("the review's rows", () => {
  const labels = (spans) => unknownSpeakers(reviewState().transcript).map(({ label, sample, start, end }, i) => ({ kind: "label", label, sample, start, end, span: spans[i] }));
  const christoph = { kind: "learned", name: "Christoph", clip: "christoph/4be07c19a2f1", start: null, end: null };
  const lorentz = { kind: "library", name: "Lorentz", clips: ["lorentz/e81d5530c6a9"], status: "confirmed", start: 0, end: 8.2 };
  const syrus = { kind: "library", name: "Syrus", clips: ["syrus/3d81f60a2b97"], status: "unconfirmed", start: 61.2, end: 69 };
  const spans = [{ start: 9, end: 18.4 }, { start: 70, end: 80 }, null];
  const rows = reviewRows(reviewState());
  assert.deepEqual(rows, [christoph, lorentz, syrus, ...labels(spans)]);
  assert.deepEqual(rows.slice(-3).map((r) => [r.label, r.start, r.end]), [["Speaker B", 9, 15], ["Speaker C", 70, 80], ["Speaker D", 90, 100]]);
  assert.deepEqual(reviewRows(reviewState({ rename: true })).map((r) => r.name ?? r.label), ["Christoph", "Syrus", "Speaker B", "Speaker C", "Speaker D"]);
  assert.deepEqual(reviewRows(reviewState({ christoph: "confirmed" })), [lorentz, syrus, ...labels(spans)]);
  assert.deepEqual(reviewRows(reviewState({ kept: false })), labels([null, null, null]));
  // a clip learned twice gives one row, timed by the first segment its person speaks
  const twice = reviewState();
  twice.kept = { ...twice.kept, learned: [...twice.kept.learned, { name: "Christoph", clip: "4be07c19a2f1" }] };
  twice.kept.segments = [...REVIEW_SEGMENTS, { start: 95, end: 99, speaker: "Christoph", voice: { clip: "christoph/4be07c19a2f1", status: "unconfirmed" }, text: "Bye." }];
  const learned = reviewRows(twice).filter((r) => r.kind === "learned");
  assert.deepEqual(learned, [{ ...christoph, start: 95, end: 99 }]);
});

// namingLine.1–.2
test("a naming report's line", () => {
  const { naming } = reviewState().kept;
  assert.equal(namingLine(null), "");
  const line = namingLine(naming);
  assert.match(line, /Ada/);
  assert.doesNotMatch(line, /Lorentz/);
  assert.equal(namingLine({ ...naming, voices: [{ name: "Lorentz", result: "named" }, { name: "Syrus", result: "named" }] }), "");
  assert.match(namingLine({ status: "request-failed", origin: "flag", speakers: [], voices: [], error: "naming request failed: 503" }), /naming request failed: 503/);
});

// instruct.1–.5: the meeting-transcriber profile, read from disk.
const PROFILE_FILE = new URL("./profiles/meeting-transcriber.json", import.meta.url);
const KNOWN_VOICES = `## Known voices
The user keeps a library of voice clips of the people they meet often. audio_transcribe names a speaker whose voice it finds there, so a transcript can hold names beside labels such as Speaker-B.

- The message's "People:" line says who is in the meeting. The app has already told audio_transcribe to expect them: leave its voices argument out.
- Use a name the library gave as it is. In the json output such a segment carries voice {clip, status}; in text, a name from a clip the user has not confirmed yet is written "<name> (unconfirmed)". Write the plain name in the summary.
- When you are sure who a labelled speaker is, because they said their name or the user told you, remember their voice: call audio_remember_voice with the recording, the name, and the start and end of 3 to 10 seconds in which only that person speaks, taken from the json segments. Never remember a voice on a guess, and remember a person at most once per meeting.
- When the meeting makes clear that a name from the library is wrong, remember the right person the same way and pass overrules with that segment's voice.clip.
- A person on the "People:" line who was not found stays a label: tell the user "failed to find a match for <name>, were they in the meeting?" and ask about them as about any other speaker.`;
// sha256 of the prompt as the file had it before the Known voices section (c4a4f9d)
const PROMPT_BEFORE_SHA256 = "20ae3c721ee41d2b12902c7a6f02037b33a145044c19c54f705db52395c5aecc";
const PROFILE_KEPT = {
  model: "cchub:baalimago/cheap@1",
  description:
    "The meetings transcriber is an agent-as-a-json which embeds a fully functional application, within the json. A meeting can be held in a room, or remote. The transcriber supports both and automatically selects which audio channels it should record from depending on the suitable need.\n\nIntended to be plug and play, but with the exception of needing the names of the participants.",
  mcp_servers: {
    slivingdoc: { command: "npx", args: ["-y", "slivingdoc", "serve"] },
    Filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/", "."] },
  },
  use_skills: false,
  use_lookback: true,
  audio: { model: "gpt-4o-transcribe-diarize" },
};

// instruct.1, instruct.2
test("the meeting-transcriber profile lets the agent remember voices", () => {
  const text = readFileSync(PROFILE_FILE, "utf8");
  const profile = JSON.parse(text);
  assert.equal(JSON.stringify(profile, null, 2) + "\n", text);
  assert.deepEqual(profile.tools, ["audio_sources", "audio_record", "apply_patch", "cp", "date", "audio_transcribe", "audio_remember_voice"]);
  assert.equal(profile.use_tools, true);
});

// instruct.3, instruct.4, instruct.5
test("the meeting-transcriber profile tells the agent about known voices", () => {
  const profile = JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
  const { prompt } = profile;
  assert.equal(prompt.split(KNOWN_VOICES).length, 2, "the section, once");
  const at = prompt.indexOf(KNOWN_VOICES);
  assert.ok(prompt.indexOf("## Transcription") < at && at < prompt.indexOf("## Storage"));
  assert.ok(prompt.includes(`${KNOWN_VOICES}\n\n## Storage`), "one blank line before ## Storage");
  const before = prompt.replace(`${KNOWN_VOICES}\n\n`, "");
  assert.equal(createHash("sha256").update(before).digest("hex"), PROMPT_BEFORE_SHA256);
  assert.ok(KNOWN_VOICES.includes("leave its voices argument out"));
  assert.deepEqual(Object.keys(profile), ["model", "description", "tools", "use_tools", "prompt", "mcp_servers", "use_skills", "use_lookback", "audio"]);
  for (const [key, value] of Object.entries(PROFILE_KEPT)) assert.deepEqual(profile[key], value, key);
});

// Known people in Penelope (worklogs/2026-11-18-penelope-known-voices, phase 6): the root's pure parts.
// known-voices phase 9, "Output of a transcription".
const HEARD = {
  segments: [
    { start: 0, end: 8.2, speaker: "Lorentz", voice: { clip: "lorentz/9f3c2a1b0d4e", status: "confirmed" }, text: "…" },
    { start: 9, end: 15.5, speaker: "B", text: "…" },
  ],
  naming: {
    status: "named",
    origin: "flag",
    speakers: [
      { label: "A", name: "Lorentz", voice: { clip: "lorentz/9f3c2a1b0d4e", status: "confirmed" } },
      { label: "B", reason: "no-match" },
    ],
    voices: [{ name: "Lorentz", result: "named" }, { name: "Ada", result: "unknown-voice" }],
  },
};

// voicesFlag.1, voicesFlag.2, peopleLine.1
test("the flag and the paragraph that name a meeting's people", () => {
  assert.equal(voicesFlag([]), "");
  assert.equal(peopleLine([]), "");
  assert.equal(voicesFlag(["Lorentz", "Christoph"]), "-voices 'Lorentz,Christoph' ");
  assert.equal(peopleLine(["Lorentz", "Christoph"]), "People: Lorentz, Christoph");
  const flag = voicesFlag(["O'Brien"]);
  const words = execFileSync("bash", ["-c", `set -- ${flag}; printf '%s\\n' "$#" "$2"`], { encoding: "utf8" });
  assert.equal(words, "2\nO'Brien\n");
});

// heardOf.1–heardOf.3
test("a transcription's output as kept segments", () => {
  const heard = heardOf(`${JSON.stringify(HEARD, null, 2)}\n`);
  assert.deepEqual(heard, { segments: HEARD.segments, naming: HEARD.naming });
  assert.equal(heard.segments[1].start, 9);
  assert.equal(heard.segments[1].end, 15.5);
  assert.deepEqual(heard.segments[0].voice, { clip: "lorentz/9f3c2a1b0d4e", status: "confirmed" });
  const bare = [{ start: 0, end: 1, speaker: "A", text: "mock transcription" }, { start: 1, end: 11, speaker: "B", text: "of an audio file" }];
  assert.deepEqual(heardOf(JSON.stringify(bare)), { segments: bare, naming: null });
  assert.equal(heardOf("mock transcription"), null);
  assert.equal(heardOf('{"segments": 3}'), null);
  // The transcript's lines of the object are those of its segments; other output stays as it is.
  assert.equal(transcriptLines(JSON.stringify(HEARD)), "[0:00] Lorentz: …\n[0:09] Speaker B: …\n");
  assert.equal(transcriptLines('{"segments": 3}'), '{"segments": 3}');
});

// record.4, rememberSpan.1, reviewRows.2, P4: a speaker a clip named keeps its name, whatever its shape.
test("a library name of capitals or digits is written as the name, not as a label", () => {
  const voice = (clip) => ({ clip, status: "confirmed" });
  const segments = [
    { start: 0, end: 4, speaker: "TJ", voice: voice("tj/0123456789ab"), text: "Morning." },
    { start: 4.5, end: 8, speaker: "J-P", voice: voice("j-p/ba9876543210"), text: "Hi." },
    { start: 9, end: 13, speaker: "JP", voice: voice("jp/abcdefabcdef"), text: "Hello." },
    { start: 14, end: 15, speaker: "TJ", text: "A label, not a name." },
  ];
  const text = transcriptLines(JSON.stringify({ segments, naming: { status: "named" } }));
  assert.equal(text, "[0:00] TJ: Morning.\n[0:04] J-P: Hi.\n[0:09] JP: Hello.\n[0:14] Speaker TJ: A label, not a name.\n");
  assert.equal(transcriptLines(JSON.stringify(segments)), text);
  assert.deepEqual(unknownSpeakers(text).map((s) => s.label), ["Speaker TJ"]);
  assert.deepEqual(rememberSpan(segments, "TJ"), { start: 0, end: 4 });
  assert.equal(rememberSpan(segments, "Speaker TJ"), null);
  const rows = reviewRows({ path: "p", transcript: text, unknown: unknownSpeakers(text), kept: { segments, naming: null, learned: [] }, people: [], playable: true, busy: false });
  assert.deepEqual(rows.filter((r) => r.kind === "library").map((r) => r.name), ["TJ", "J-P", "JP"]);
});

// learnedOf.1, learnedOf.2
test("the clip a run learned", () => {
  const result = (output, extra = {}) => ({ type: "tool_result", name: "audio_remember_voice", ok: true, output, ...extra });
  const standing = result("Christoph: clip 4be07c19a2f1 added (unconfirmed)");
  assert.deepEqual(learnedOf(standing), { name: "Christoph", clip: "4be07c19a2f1" });
  assert.deepEqual(learnedOf(result(`${standing.output}\noverrule of lorentz/ffffffffffff failed: Lorentz has no clip ffffffffffff`)),
    { name: "Christoph", clip: "4be07c19a2f1" });
  assert.equal(learnedOf(result(standing.output, { ok: false })), null);
  assert.equal(learnedOf({ ...standing, name: "audio_transcribe" }), null);
  assert.equal(learnedOf(result("Christoph: clip 4be07c19a2f1 added (confirmed)")), null);
  assert.equal(learnedOf({ type: "tool_call", name: "audio_remember_voice", output: standing.output }), null);
});

// namedIn.1
test("the people kept segments named", () => {
  const voice = { clip: "x/0123456789ab", status: "confirmed" };
  const segments = [
    { start: 0, end: 1, speaker: "Lorentz", voice, text: "a" },
    { start: 1, end: 2, speaker: "B", text: "b" },
    { start: 2, end: 3, speaker: "Lorentz", voice, text: "c" },
    { start: 3, end: 4, speaker: "Syrus", voice, text: "d" },
  ];
  assert.deepEqual(namedIn(segments), ["Lorentz", "Syrus"]);
  assert.deepEqual(namedIn(segments.map(({ voice: _, ...s }) => s)), []);
});

// voicesCommand.1–.3
test("the command a choice runs", () => {
  assert.deepEqual(voicesCommand({ kind: "keep", clip: "christoph/4be07c19a2f1" }), ["list", "christoph", "4be07c19a2f1", "confirm"]);
  assert.deepEqual(voicesCommand({ kind: "overrule", clip: "lorentz/e81d5530c6a9", from: "Lorentz", to: "Ada" }), ["list", "lorentz", "e81d5530c6a9", "overrule"]);
  assert.deepEqual(voicesCommand({ kind: "remember", label: "Speaker B", name: "Christoph", start: 61.2, end: 69 }, "/tmp/recordings/again-x.wav"),
    ["add", "/tmp/recordings/again-x.wav", "-from", "61.2", "-to", "69", "-name", "Christoph"]);
});

test("a link whose text is a URL names its summary once", () => {
  const url = "file:///home/user/notebook/meetings/summaries/2026-11-19T08-00Z_planning.md";
  const reply = `Filed:\n- [${url}](${url})\n- [${url.replace("summaries", "transcripts")}](${url.replace("summaries", "transcripts")})`;

  assert.deepEqual(summariesIn(reply), ["meetings/summaries/2026-11-19T08-00Z_planning.md"]);
});

test("a bare summary URL ends where its sentence does", () => {
  const a = "meetings/summaries/2026-11-19T08-00Z_a.md";
  const b = "meetings/summaries/2026-11-19T09-00Z_b.md";
  const reply = `The summary is file:///home/user/notebook/${a}. Another (file:///home/user/notebook/${b}) and ` +
    `[the transcript](meetings/transcripts/2026-11-19T08-00Z_a.md), then [again](${a}).`;

  assert.deepEqual(summariesIn(reply), [a, b]);
});

const SECRET = "sk-or-v1-PLANTED+secret/value=";
const logged = (secrets = () => [["OPENROUTER_API_KEY", SECRET]], at = { t: 1_000 }) => {
  const log = new RunLog({ indexedDB: undefined, secrets, now: () => at.t });
  log.open("job", { started: 1_000, kind: "Record", meeting: "Daily sync", build: "b1", clai: "clai 1", profile: "p#sha256=ab", provider: "OpenRouter", browser: "Chromium" });
  return log;
};

test("no planted secret is in a run log", () => {
  const log = logged();
  const coded = encodeURIComponent(SECRET);
  log.attach("job", "minutes:Record#1", "Record", `KEY=${SECRET} clai query`, [SECRET, `https://x.test/?key=${coded}`]);
  log.add("minutes:Record#1", { kind: "printed", text: `curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="\nsent ${SECRET}\n` });
  log.add("minutes:Record#1", { kind: "record", record: { type: "diagnostic", level: "debug", subsystem: "http", message: "request", facts: { header: "Bearer tok_abcdefgh123", url: `https://x.test/?k=${coded}` } } });
  log.add("minutes:Record#1", { kind: "record", record: { type: "error", message: `rejected ${SECRET}`, causes: [{ message: `401 for ${SECRET}`, status: 401 }] } });
  log.add("minutes:Record#1", { kind: "record", record: { type: "tool_call", name: "fetch", inputs: { token: SECRET } } });
  log.add("minutes:Record#1", { kind: "record", record: { type: "tool_result", name: "fetch", ok: false, error: `denied ${SECRET}` } });
  log.add("minutes:Record#1", { kind: "stray", text: `panic: ${SECRET}` });
  log.add("minutes:Record#1", { kind: "process", event: "exec", pid: 7, argv: ["clai", "-key", SECRET] });
  log.add("minutes:Record#1", { kind: "process", event: "net", text: `clai asks x.test GET ${coded}` });
  log.ended("minutes:Record#1", 1);
  log.noted("job", { level: "error", title: "Stopped", detail: `the key ${SECRET} was refused` });
  const text = log.text("job");
  const cause = log.cause("minutes:Record#1");

  for (const held of [text, JSON.stringify(cause)]) {
    assert.ok(!held.includes(SECRET) && !held.includes(coded), held);
    assert.ok(!held.includes("dXNlcjpwYXNzd29yZA") && !held.includes("tok_abcdefgh123"), held);
  }
  assert.match(text, /KEY=‹secret: OPENROUTER_API_KEY› clai query/);
  assert.match(text, /Authorization: ‹secret: Authorization›/);
  assert.match(text, /Bearer ‹secret: Bearer›/);
  assert.match(cause.lines.join("\n"), /401 for ‹secret: OPENROUTER_API_KEY›/);
});

test("no planted model output is in a run log", () => {
  const log = logged();
  const said = "PLANTED-MODEL-OUTPUT";
  log.attach("job", "minutes:Record#1", "Record", "clai query hello");
  const add = (record) => log.add("minutes:Record#1", { kind: "record", record });
  add({ type: "reasoning_delta", text: `${said} thinking` });
  add({ type: "reasoning_delta", text: `${said} more` });
  add({ type: "reply_delta", text: `${said} one` });
  add({ type: "reply_delta", text: `${said} two` });
  add({ type: "reply", text: `${said} one${said} two` });
  add({ type: "tool_call", name: "write_file", inputs: { path: "meetings/summaries/a.md", content: said.repeat(20) } });
  add({ type: "tool_result", name: "write_file", ok: true, output: `wrote ${said}` });
  add({ type: "tool_result", name: "audio_transcribe", ok: false, error: "no such file /tmp/r.wav" });
  add({ type: "output", stream: "stdout", text: said });
  add({ type: "something_new", text: said });
  add({ type: "reply_delta", text: said });
  add({ type: "diagnostic", level: "debug", subsystem: "call", message: `Invoke call: {\n "inputs": {"content": "${said}"}\n}`, facts: { tool: "write_file" } });
  add({ type: "diagnostic", level: "trace", subsystem: "text_querier", message: `InitialPrompt: {\n "messages": ["${said}"]\n}` });
  add({ type: "diagnostic", level: "warn", subsystem: "audio", message: "two lines\nstay whole" });
  log.add("minutes:Record#1", { kind: "body", topic: "meeting", length: said.length });
  const text = log.text("job");

  assert.ok(!text.includes(said), text);
  assert.match(text, /clai reasoning_delta ×2 ‹54 chars›/);
  assert.match(text, /clai reply_delta ×2 ‹48 chars›\n.*clai reply ‹48 chars›/);
  assert.match(text, /clai tool_call write_file path=meetings\/summaries\/a.md content=‹400 chars›/);
  assert.match(text, /clai tool_result write_file ok ‹26 chars›/);
  assert.match(text, /clai tool_result audio_transcribe failed: no such file \/tmp\/r.wav/);
  assert.match(text, /clai output stdout ‹20 chars›/);
  assert.match(text, /clai something_new ‹\d+ chars›/);
  assert.match(text, /clai reply_delta ×1 ‹20 chars›/);
  assert.match(text, /page meeting ‹20 chars›/);
  assert.match(text, /clai diagnostic debug \[call\] Invoke call: \{ ‹\+\d+ chars› · tool=write_file\n/);
  assert.match(text, /clai diagnostic trace \[text_querier\] InitialPrompt: \{ ‹\+\d+ chars›\n/);
  assert.match(text, /clai diagnostic warn \[audio\] two lines\\nstay whole\n/);
});

test("a run log is whole and in order", () => {
  const at = { t: 1_000 };
  const log = logged(undefined, at);
  log.open("job", { started: 5, kind: "Other", meeting: "" });
  log.attach("job", "minutes:Record#1", "Record", "cd ~/notebook &&\nclai -json query 'hi'", ["first"]);
  at.t = 2_500;
  log.add("minutes:Record#1", { kind: "process", event: "exec", pid: 12, argv: ["bash", "-c", "cd -- '/' || exit\nclai", "minutes:Record#1", "first"] });
  log.add("minutes:Record#1", { kind: "record", record: { type: "diagnostic", level: "debug", subsystem: "audio", message: "chunked", facts: { chunks: 4, codec: "opus" } } });
  log.add("minutes:Record#1", { kind: "record", record: { type: "progress", title: "audio_transcribe", row: "2/4", state: "done", detail: "heard 4:10" } });
  log.add("minutes:Record#1", { kind: "record", record: { type: "chat", id: "019a" } });
  log.add("minutes:Record#1", { kind: "record", record: { type: "child_output", source: "mcp_fs", text: "listening" } });
  log.add("minutes:Record#1", { kind: "record", record: { type: "error", message: "boom", causes: [{ message: "boom", status: 500, provider_code: "overloaded", remedies: ["wait"] }] } });
  log.add("minutes:Record#1", { kind: "process", event: "exit", text: "clai exited with 1" });
  at.t = 63_250;
  log.ended("minutes:Record#1", 1);
  log.attach("job", "minutes:Save to slivingdoc#2", "Save to slivingdoc", "slivingdoc commit");
  log.add("minutes:Save to slivingdoc#2", { kind: "printed", text: "\x1b[31mdebug: pu" });
  log.add("minutes:Save to slivingdoc#2", { kind: "printed", text: "sh refused\x1b[0m\r\nlast" });
  log.ended("minutes:Save to slivingdoc#2", 3);
  log.noted("job", { level: "warn", title: "Slow", detail: "" });
  log.noted("job", { level: "error", title: "slivingdoc could not save the notes", detail: "They are only on this machine.", hint: "Sign in", code: "x1" });
  log.noted("job", { level: "error", title: "Second", detail: "" });
  log.add("minutes:Unknown#9", { kind: "printed", text: "never\n" });

  assert.equal(log.text("job"), [
    "Penelope run log", "job: Record", "meeting: Daily sync", "started: 1970-01-01T00:00:01.000Z", "ended: running", "result: running",
    "page build: b1", "clai: clai 1", "profile: p#sha256=ab", "provider: OpenRouter", "browser: Chromium", "",
    "+0:00.000 Record#1 │ run Record: cd ~/notebook &&\\nclai -json query 'hi' $1=first",
    "+0:01.500 Record#1 │ proc exec pid 12 bash -c cd -- '/' || exit\\nclai minutes:Record#1 first",
    "+0:01.500 Record#1 │ clai diagnostic debug [audio] chunked · chunks=4 codec=opus",
    "+0:01.500 Record#1 │ clai progress audio_transcribe 2/4 done heard 4:10",
    "+0:01.500 Record#1 │ clai chat 019a",
    "+0:01.500 Record#1 │ clai child_output mcp_fs: listening",
    "+0:01.500 Record#1 │ clai error boom · status 500 · overloaded · hint: wait",
    "+0:01.500 Record#1 │ proc exit clai exited with 1",
    "+1:02.250 Record#1 │ end Record: exit 1",
    "+1:02.250 Save to slivingdoc#2 │ run Save to slivingdoc: slivingdoc commit",
    "+1:02.250 Save to slivingdoc#2 │ out debug: push refused",
    "+1:02.250 Save to slivingdoc#2 │ out last",
    "+1:02.250 Save to slivingdoc#2 │ end Save to slivingdoc: exit 3",
    "+1:02.250 note │ warn: Slow",
    "+1:02.250 note │ error: slivingdoc could not save the notes · They are only on this machine. · hint: Sign in · x1",
    "+1:02.250 note │ error: Second",
    "",
  ].join("\n"));
  assert.deepEqual(log.list(), [{ job: "job", started: 1_000, kind: "Record", meeting: "Daily sync", state: "running", failed: "slivingdoc could not save the notes", size: log.list()[0].size, earlier: false }]);
  assert.equal(log.text("nobody"), null);
});

test("a run log is bounded", () => {
  const log = logged();
  log.attach("job", "minutes:Put#1", "Put", "printf %s \"$1\" | base64 -d", ["A".repeat(1_200_000), "short"]);
  log.add("minutes:Put#1", { kind: "printed", text: `${"x".repeat(20_000)}\n` });
  log.add("minutes:Put#1", { kind: "process", event: "exec", pid: 3, argv: ["bash", "-c", "printf", "minutes:Put#1", "B".repeat(500)] });
  log.add("minutes:Put#1", { kind: "process", event: "exec", pid: 4, argv: ["clai", "query", "C".repeat(201), "D".repeat(200)] });
  const text = log.text("job");

  assert.match(text, /\$1=‹1200000 chars› \$2=short\n/);
  assert.match(text, new RegExp(`out x{${CAPS.entry - 4}}… ‹cut: 20004 chars in all›\\n`));
  assert.match(text, /exec pid 3 bash -c printf minutes:Put#1 ‹500 chars›\n/);
  assert.match(text, new RegExp(`exec pid 4 clai query ‹201 chars› D{200}\\n`));
  assert.ok(!/A{201}|B{201}|C{201}/.test(text));

  const line = "y".repeat(8_000);
  for (let i = 0; i < 400; i++) log.add("minutes:Put#1", { kind: "printed", text: `${i} ${line}\n` });
  const full = log.text("job");
  assert.ok(full.length <= CAPS.log + 600, String(full.length));
  assert.ok(full.startsWith("Penelope run log\njob: Record\n"));
  assert.match(full, /browser: Chromium\n\n‹\d+ earlier entries cut: the log passed 2097152 characters›\n/);
  assert.ok(full.includes("out 399 yyy") && !full.includes("out 0 yyy") && !full.includes("run Put:"));
});

test("a cause is the command's label, status and last lines", () => {
  const log = logged();
  for (const [job, action] of [["job", "minutes:Save to slivingdoc#1"], [null, "minutes:Trust the agent#2"]]) {
    log.attach(job, action, "Save to slivingdoc", "slivingdoc commit");
    assert.deepEqual(log.cause(action), { label: "Save to slivingdoc", status: null, lines: [] });
    log.add(action, { kind: "printed", text: "one\ntwo\n\nthree\nfour\nfive\nsix\nsev" });
    log.add(action, { kind: "printed", text: "en" });
    log.ended(action, 1);
    assert.deepEqual(log.cause(action), { label: "Save to slivingdoc", status: 1, lines: ["three", "four", "five", "six", "seven"] });
  }
  log.attach("job", "minutes:Answer#3", "Answer", "clai");
  log.add("minutes:Answer#3", { kind: "record", record: { type: "output", stream: "stderr", text: "warming up" } });
  log.add("minutes:Answer#3", { kind: "stray", text: "panic: nil map" });
  log.add("minutes:Answer#3", { kind: "record", record: { type: "error", message: "no such model" } });
  log.ended("minutes:Answer#3", 0);

  assert.deepEqual(log.cause("minutes:Answer#3"), { label: "Answer", status: 0, lines: ["warming up", "panic: nil map", "no such model"] });
  assert.equal(log.cause("minutes:Never#4"), null);
  assert.ok(!log.text("job").includes("Trust the agent#2"));
});

test("a run log that cannot be kept changes nothing", async () => {
  const failing = {
    open() {
      const request = {};
      setTimeout(() => request.onerror?.({ target: request }));
      return request;
    },
  };
  const throwing = { open() { throw new Error("no storage"); } };
  for (const indexedDB of [undefined, failing, throwing]) {
    const log = new RunLog({ indexedDB });
    await log.ready;
    log.open("a", { started: 10, kind: "Record", meeting: "M" });
    log.open("a", { started: 99, kind: "Other", meeting: "X" });
    log.attach("a", "minutes:Record#1", "Record", "clai");
    for (const entry of [null, undefined, {}, { kind: "nothing" }, { kind: "record" }, { kind: "record", record: 7 }, { kind: "record", record: { type: "tool_call", inputs: 3 } }, { kind: "printed" }, { kind: "process" }]) {
      log.add("minutes:Record#1", entry);
    }
    log.add(undefined, { kind: "printed", text: "x\n" });
    log.attach(undefined, undefined);
    log.ended("minutes:Never#1", 1);
    log.noted("nobody", { level: "error", title: "x" });
    log.noted("a", null);
    log.open(null, null);
    assert.equal(await log.close("a", true), false);
    assert.equal(await log.close("a"), false);
    assert.equal(await log.close("nobody"), false);
    log.add("minutes:Record#1", { kind: "printed", text: "late\n" });
    assert.deepEqual(log.list().map((r) => [r.job, r.kind, r.state, r.failed, r.earlier]), [["a", "Record", "failed", "", false]]);
    assert.match(log.text("a"), /result: failed\n/);
    assert.ok(!log.text("a").includes("late"));
  }
  const log = new RunLog({ indexedDB: undefined, secrets: () => { throw new Error("no secrets"); } });
  log.open("a", { started: 10, kind: "Record", meeting: "M" });
  log.attach("a", "minutes:Record#1", "Record", "clai");
  log.add("minutes:Record#1", { kind: "printed", text: "x\n" });
  assert.equal(log.text("a"), null);
  assert.equal(log.cause("minutes:Record#1"), null);
  assert.equal(await log.close("a"), false);
});

test("the newest ten closed logs stay listed", async () => {
  const log = new RunLog({ indexedDB: undefined });
  for (let i = 1; i <= 12; i++) {
    log.open(`j${i}`, { started: i * 1_000, kind: "Record", meeting: `M${i}` });
    if (i % 2) log.noted(`j${i}`, { level: "error", title: `Failed ${i}` });
    if (i !== 12) await log.close(`j${i}`);
  }

  assert.deepEqual(log.list().map((r) => r.job), ["j12", "j11", "j10", "j9", "j8", "j7", "j6", "j5", "j4", "j3", "j2"]);
  assert.deepEqual(log.list().slice(0, 3).map((r) => [r.state, r.failed]), [["running", ""], ["failed", "Failed 11"], ["clean", ""]]);
  assert.equal(log.text("j1"), null);
});

test("a log's file name", () => {
  const started = Date.UTC(2026, 10, 20, 9, 14, 30);

  assert.equal(logName({ started, kind: "Record", meeting: "Daily sync" }), "penelope-2026-11-20T09-14Z_daily-sync-record.log");
  assert.equal(logName({ started, kind: "Ask Penelope", meeting: "" }), "penelope-2026-11-20T09-14Z_ask-penelope.log");
  assert.equal(logName({ started, kind: "Transcribe again", meeting: "Åsa & Co: Q4/Q1" }), "penelope-2026-11-20T09-14Z_åsa-co-q4-q1-transcribe-again.log");
});

// show.6: the line the review shows while each choice runs.
test("the review says which step of naming it is on", () => {
  assert.equal(choosingStep({ kind: "remember", label: "Speaker B", name: "Syrus", start: 9, end: 15 }, 0, 1), "Remembering Syrus's voice…");
  assert.equal(choosingStep({ kind: "overrule", clip: "lorentz/9f3c", from: "Lorentz", to: "Ada" }, 1, 3), "Telling the voice library Lorentz is Ada, 2 of 3…");
  assert.equal(choosingStep({ kind: "keep", clip: "christoph/4be0" }, 0, 1), "Keeping the voice…");
  assert.match(NAMING_STEP, /…$/);
});

// install.js: the sidebar's Install button, where the browser offers to install.
const installPage = ({ standalone = false } = {}) => {
  const win = new EventTarget();
  win.matchMedia = (q) => ({ matches: standalone && q === "(display-mode: standalone)" });
  const button = Object.assign(new EventTarget(), { hidden: true });
  return { win, button, installer: new Installer(win, button).start() };
};
const installPrompt = (outcome) => {
  const e = new Event("beforeinstallprompt", { cancelable: true });
  e.prompts = 0;
  e.prompt = async () => { e.prompts++; };
  e.userChoice = Promise.resolve({ outcome });
  return e;
};

test("Install opens the browser's own prompt once it is offered, once, and goes when installed", async () => {
  const { win, button } = installPage();
  assert.equal(button.hidden, true, "nothing to offer before the browser says it can install");
  button.dispatchEvent(new Event("click"));
  const e = installPrompt("accepted");
  win.dispatchEvent(e);
  assert.ok(e.defaultPrevented && !button.hidden);
  button.dispatchEvent(new Event("click"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.prompts, 1);
  assert.equal(button.hidden, true);
  // Dismissed: the prompt is used up, until the browser offers another.
  const p = installPage();
  p.win.dispatchEvent(installPrompt("dismissed"));
  p.button.dispatchEvent(new Event("click"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.button.hidden, true);
  p.win.dispatchEvent(installPrompt("accepted"));
  assert.equal(p.button.hidden, false);
  p.win.dispatchEvent(new Event("appinstalled"));
  assert.equal(p.button.hidden, true);
  // The installed app offers nothing.
  const installed = installPage({ standalone: true });
  installed.win.dispatchEvent(installPrompt("accepted"));
  assert.equal(installed.button.hidden, true);
});

// notebookkeeper.js: the notes kept in this browser without slivingdoc.
test("kept notes go back onto the machine in runs whose arguments fit", () => {
  const files = [["meetings/summaries/a.md", "x".repeat(600)], ["meetings/transcripts/a.md", "y".repeat(900)], ["meetings/summaries/b.md", "z".repeat(300)]];
  assert.deepEqual(restoreBatches(files, 1000).map((b) => b.map(([path]) => path)), [["meetings/summaries/a.md"], ["meetings/transcripts/a.md"], ["meetings/summaries/b.md"]]);
  assert.deepEqual(restoreBatches(files, 1600).map((b) => b.length), [2, 1]);
  assert.deepEqual(restoreBatches(files, 2000).map((b) => b.length), [3]);
  assert.deepEqual(restoreBatches([], 1000), []);
  // A file larger than a run alone still goes, alone.
  assert.deepEqual(restoreBatches([["big.md", "b".repeat(5000)]], 1000).map((b) => b.length), [1]);
});

test("without IndexedDB the keeper keeps nothing and says so", async () => {
  const keeper = new NotebookKeeper(undefined);
  assert.equal(await keeper.keep([["meetings/summaries/a.md", "a"]]), false);
  assert.equal(await keeper.all(), null);
  assert.equal(await keeper.remove(["meetings/summaries/a.md"]), false);
});

// A meeting's name is its notes' front matter title (Minutes.rename).
test("renaming a meeting rewrites the title in its front matter, and nothing else", () => {
  const summary = "---\ntitle: Meeting\ndate: 2026-11-23T08:00:00Z\nduration: 12\n---\n\n## Summary\n\ntitle: not this one\n";
  assert.equal(retitled(summary, "Design review"), summary.replace("title: Meeting", "title: Design review"));
  // A title with a colon is quoted, so the front matter still reads as one field.
  assert.equal(parseNote(retitled(summary, "Q4: planning")).fields.title, "Q4: planning");
  assert.match(retitled(summary, "Q4: planning"), /^---\ntitle: "Q4: planning"\n/);
  // Front matter without a title gets one; a note without front matter gets some.
  assert.equal(retitled("---\ndate: 2026-11-23\n---\nBody\n", "Sync"), "---\ntitle: Sync\ndate: 2026-11-23\n---\nBody\n");
  assert.equal(retitled("Body only\n", "Sync"), "---\ntitle: Sync\n---\n\nBody only\n");
  // Whitespace and line breaks in what was typed fold to single spaces.
  assert.equal(parseNote(retitled(summary, "  Daily \n sync ")).fields.title, "Daily sync");
});

// arrival.js: a pen writes only what shows, through the window and every box that clips it.
test("a text scrolled out of the sidebar's list, or below the window, shows through nothing", () => {
  const box = (top, bottom, left = 0, right = 200) => ({ top, bottom, left, right });
  const list = box(200, 600);
  const window = box(0, 900, 0, 1280);
  assert.equal(seenThrough(box(250, 280), [list, window]), true);
  assert.equal(seenThrough(box(590, 620), [list, window]), true, "a row half in the list shows");
  assert.equal(seenThrough(box(640, 670), [list, window]), false, "a row scrolled below the list");
  assert.equal(seenThrough(box(150, 190), [list, window]), false, "a row scrolled above it");
  assert.equal(seenThrough(box(950, 980), [window]), false, "below the window");
  assert.equal(seenThrough(box(100, 100, 10, 10), [window]), false, "nothing to see");
});

// update.js: a page left open offers a reload once the site it came from has a newer version.
test("a newer deploy is offered once nothing is under way, at most once a minute, and Later lasts until the next", async () => {
  let clock = 0;
  let site = "v1";
  let asked = 0;
  let busy = false;
  const shown = [];
  const waits = [];
  const updates = new Updates({
    version: "v1",
    ask: async () => {
      asked++;
      if (site instanceof Error) throw site;
      return site;
    },
    busy: () => busy,
    show: (on) => shown.push(on),
    now: () => clock,
    later: (fn, ms) => waits.push({ fn, ms }),
  });
  await updates.check();
  assert.deepEqual(shown, [], "the same version is no news");
  site = "v2";
  clock += AGAIN_MS - 1;
  await updates.check();
  assert.equal(asked, 1, "asked again within a minute");
  clock += 1;
  busy = true;
  await updates.check();
  assert.deepEqual(shown, [], "offered while a meeting is being recorded");
  assert.equal(waits.length, 1);
  assert.equal(waits[0].ms, IDLE_MS);
  waits.shift().fn();
  assert.equal(waits.length, 1, "looks again while the work goes on");
  busy = false;
  waits.shift().fn();
  assert.deepEqual(shown, [true], "offered once the work is done");
  updates.putOffNewer();
  assert.deepEqual(shown, [true, false]);
  clock += AGAIN_MS;
  await updates.check();
  assert.deepEqual(shown, [true, false], "Later did not last");
  site = new Error("offline");
  clock += AGAIN_MS;
  await updates.check();
  site = "v3";
  clock += AGAIN_MS;
  await updates.check();
  assert.deepEqual(shown, [true, false, true], "a version newer still is offered");
  site = "v1";
  clock += AGAIN_MS;
  await updates.check();
  assert.deepEqual(shown, [true, false, true, false], "a site back at the page's version takes the offer back");
});

test("a page `make dev` serves, unstamped, never asks for the site's version", async () => {
  for (const version of ["dev", ""]) {
    let asked = 0;
    const updates = new Updates({ version, ask: async () => (asked++, "v2"), show: () => assert.fail("offered") });
    await updates.check();
    assert.equal(asked, 0, version);
  }
});
