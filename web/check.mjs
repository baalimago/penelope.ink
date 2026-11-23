// Runs clai in the page in headless Chromium and checks that it printed its usage, that it
// reads what is typed on its terminal, and, with bash installed, that lines run in bash, that
// clai calls an MCP server uvx starts, that its async commands run, that slivingdoc serves
// with libgit2 behind it, and that ffmpeg and clai's meeting-transcriber profile record the
// page's microphone.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { chromium } from "playwright";

import { STANDIN_ISSUE, mcpStandIn } from "./mcp-standin.mjs";
import { VOICES_STANDIN } from "./voices-standin.mjs";
import { startServer } from "./server.mjs";

const COMMANDS = [
  // `h` is not a command, so clai says so, prints its usage and exits with 1, as it does natively.
  { line: "clai h", status: 1 },
  { line: "clai help", status: 0 },
];

// With the registry packages, lines run in bash, whose pipelines are WASIX v1 programs, and
// clai's tools start programs the same way.
const SHELL = [
  { line: "echo hello | tr a-z A-Z", prints: "HELLO" },
  { line: "ls /bin | grep -x clai", prints: "clai" },
  { line: "cd /usr/bin", prints: "" },
  { line: "pwd", prints: "/usr/bin" },
  // clai's cp tool runs `cp -a`; /usr/local/bin/cp keeps it working where WASI has no mode bits to preserve.
  { line: "echo kept > /tmp/cp-a && cp -a -- /tmp/cp-a /tmp/cp-b && cat /tmp/cp-b", prints: "kept" },
  { line: "mkdir -p /tmp/cp-d && echo deep > /tmp/cp-d/f && cp -a -- /tmp/cp-d /tmp/cp-e && cat /tmp/cp-e/f", prints: "deep" },
  { line: "cp -p --preserve=all /tmp/cp-a /tmp/cp-c && cat /tmp/cp-c", prints: "kept" },
];

// npx and uvx start the MCP server ports in /bin, and clai talks MCP to them over pipes. The
// profile has the shape of cchub:clai/researcher's ddg server; the test model calls the tools
// its prompt names, with no arguments, so the port's answer is that the query is missing. The
// terminal wraps long lines, so the expected texts are short.
const PROFILE = JSON.stringify({
  use_tools: true,
  tools: ["mcp_ddg*", "cmd", "async_cmd*"],
  mcp_servers: { ddg: { command: "uvx", args: ["duckduckgo-mcp-server==0.7.0"], startup: "lazy" } },
});
const FS_PROFILE = JSON.stringify({
  use_tools: true,
  tools: ["mcp_Filesystem*"],
  mcp_servers: { Filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "./"] } },
});
// An async command that writes its own id where the test model reads it, while `cmd` sleeps
// to let it run.
const ASYNC = [
  `ls /tmp | sed -n "s/^clai-async-cmd-\\(async_cmd_[0-9a-f]*\\)-stdout.log$/\\1/p" > /tmp/id.tmp`,
  "mv /tmp/id.tmp /tmp/id",
  "echo async-done",
];
const MCP = [
  {
    line: `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | uvx duckduckgo-mcp-server==0.7.0`,
    status: 0,
    prints: '"name":"ddg-search"',
  },
  { line: "npx -y left-pad@1.3.0", status: 127, prints: "left-pad is not available" },
  // slivingdoc-git2 answers a version request (op 3, framed as length 1) with libgit2's: 1.9.6.
  {
    line: "printf '\\001\\000\\000\\000\\003' | slivingdoc-git2 | od -An -tx1 | tr -d ' \\n'",
    status: 0,
    prints: "0d00000000010000000900000006000000",
  },
  { line: "npx -y slivingdoc@1.3.1 version", status: 0, prints: "slivingdoc 1.3.1" },
  // serve stops at the end of its input, so the input stays open until it has answered.
  {
    line:
      `(printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18",` +
      `"capabilities":{},"clientInfo":{"name":"check","version":"1"}}}'; sleep 3) | ` +
      `npx -y slivingdoc@1.3.1 serve 2>/dev/null | grep -o '"serverInfo":{"name":"slivingdoc"'`,
    status: 0,
    prints: '"serverInfo":{"name":"slivingdoc"',
  },
  // The filesystem server meeting-transcriber starts, confined to the directory it is given.
  { line: `printf '%s' '${FS_PROFILE}' > /tmp/fs.json`, status: 0, prints: "" },
  {
    line: "mkdir -p /tmp/notes && cd /tmp/notes && clai -profile-path /tmp/fs.json -cm test query tool_mcp_Filesystem_list_allowed_directories 2>&1 | cat",
    status: 0,
    prints: "Allowed directories:",
  },
  { line: `printf '%s' '${PROFILE}' > /tmp/mcp.json`, status: 0, prints: "" },
  {
    line: "clai -profile-path /tmp/mcp.json -cm test query tool_mcp_ddg_search 2>&1 | cat",
    status: 0,
    prints: "missing required argument",
  },
  { line: `printf '%s\\n' ${ASYNC.map((l) => `'${l.replaceAll("'", "'\\''")}'`).join(" ")} > /tmp/async.sh`, status: 0, prints: "" },
  {
    line:
      "CLAI_MOCK_CMD_COMMAND='sleep 2' CLAI_MOCK_ASYNC_CMD_RUN_COMMAND=sh CLAI_MOCK_ASYNC_CMD_RUN_ARGS=/tmp/async.sh " +
      "CLAI_MOCK_ASYNC_CMD_ID_FILE=/tmp/id clai -profile-path /tmp/mcp.json -cm test " +
      "query tool_async_cmd tool_cmd tool_async_cmd_await tool_async_cmd_logs 2>&1 | cat",
    status: 0,
    prints: '"preview":"async-done',
  },
];

// The page's microphone is Chromium's fake one, which beeps. ffmpeg records it from the files in
// /run/audio through the wrapper in /usr/local/bin, and clai runs the meeting-transcriber profile
// with the test models: it lists the inputs, records the microphone and the computer's monitor
// until its four seconds are up, and transcribes the recording without the network. Then a
// recording stops on Enter, as a user stops a meeting's.
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const MEETING = await readFile(new URL("../components/clai/examples/profiles/meeting-transcriber.json", import.meta.url), "utf8");
const audioConfig = (maxSeconds) => JSON.stringify({
  transcribe: { model: "test-diarize" },
  capture: { dir: "/tmp/rec", "max-seconds": maxSeconds, "silence-timeout": 0, calibrated: true },
});
// The mock transcription as the app files it: its segments word for word, one line each.
const MOCK_LINES = "[0:00] Speaker A: mock transcription\n[0:01] Speaker B: of an audio file\n";
const writeAudioConfig = (maxSeconds) =>
  `mkdir -p "$(clai confdir)" && printf '%s' ${quote(audioConfig(maxSeconds))} > "$(clai confdir)/audioConfig.json"`;
const RECORD = "CLAI_MOCK_AUDIO_TRANSCRIBE_FILE=/tmp/mic.wav clai -cm mock_test -prp /tmp/meeting.json " +
  "q tool_audio_sources tool_audio_record tool_audio_transcribe";
const AUDIO = [
  { line: "ls /run/audio", status: 0, prints: "mic" },
  // Shared (by SHARE below), a screen is a sink's monitor too.
  { line: "ffmpeg -hide_banner -sources pulse", status: 0, prints: "browser-tab.monitor [Monitor of Shared screen or tab (browser)]" },
  // Every audio input of the browser's, the computer's monitor among them, is a pulse device.
  { line: "ffmpeg -hide_banner -sources pulse", status: 0, prints: "browser-dev2.monitor [Monitor of Built-in Audio Analog Stereo]" },
  { line: "ffmpeg -hide_banner -sinks pulse", status: 0, prints: "* browser-dev2 [Built-in Audio Analog Stereo]" },
  {
    line: "ffmpeg -hide_banner -nostdin -loglevel error -f pulse -i browser-dev2.monitor -t 1 -ac 1 -ar 16000 -y /tmp/monitor.wav && echo bytes=$(wc -c < /tmp/monitor.wav)",
    status: 0,
    prints: "bytes=32078",
  },
  {
    line: "ffmpeg -hide_banner -nostdin -loglevel error -f pulse -i browser-mic -t 2 -ac 1 -ar 16000 -y /tmp/mic.wav && echo bytes=$(wc -c < /tmp/mic.wav)",
    status: 0,
    prints: "bytes=64",
  },
  { line: "play /tmp/mic.wav", status: 0, prints: "in the player" },
  { line: `printf '%s' ${quote(MEETING)} > /tmp/meeting.json`, status: 0, prints: "" },
  { line: writeAudioConfig(4), status: 0, prints: "" },
  // The agent records the microphone and the computer's monitor, mixed.
  { line: `${RECORD} 2>&1 | cat`, status: 0, prints: "sources: sink=Monitor of Built-in Audio Analog Stereo; mic=" },
  { line: writeAudioConfig(60), status: 0, prints: "" },
];

// A meeting in the notebook, as the agent files one.
const NOTEBOOK = "mkdir -p ~/notebook/meetings/summaries ~/notebook/meetings/transcripts && cd ~/notebook/meetings && " +
  `printf '%s' ${quote("---\ntitle: Design review\ndate: 2026-10-28T09:00:00Z\nduration: 38\n---\n## Decisions\n\n- Ship the peek\n")} ` +
  "> summaries/2026-10-28T09-00Z_design-review.md && " +
  `printf '%s' ${quote("**Speaker A** [00:12]: Ship it.\n")} > transcripts/2026-10-28T09-00Z_design-review.md`;

// `clai setup` asks for a category on /dev/tty. `keys` are typed once it does.
const INTERACTIVE = [
  // The terminal's line editing: the x is erased before clai reads the line, so it quits.
  { name: "a line, edited", keys: ["x", "Backspace", "q", "Enter"], status: 0 },
  // ^C is SIGINT for the foreground process, which the Go port cannot catch yet, so it dies of it.
  { name: "^C", keys: ["Control+C"], status: 128 + 2 },
];

// slivingdoc's sign-in and sign-out against the stub site on the page's own origin (server.mjs):
// every request of the CLI's is one host call, and the page's fetch makes it, so a guest with no
// TLS of its own logs in and out (2026-11-04 research/http-host-call/PROMPT.md).
const SIGNIN = (port) => [
  {
    line: `SLIVINGDOC_SITE=http://localhost:${port} slivingdoc login --no-browser --force </dev/null 2>&1 | cat`,
    status: 0,
    prints: "check-notes",
  },
  { line: "slivingdoc space </dev/null 2>&1 | cat", status: 0, prints: "check-notes" },
  { line: "slivingdoc logout </dev/null 2>&1 | cat", status: 0, prints: "Logged out of" },
  { line: "cat ~/.config/slivingdoc/credentials.json", status: 0, prints: '"logins": []' },
];

// `download FILE...` saves files of the machine as the browser's downloads, byte for byte and under
// their names: a small one whole, and one past a message's 16 MiB in parts. A directory and a
// missing file are refused, and without a file it says how to use it.
async function checkDownload(page) {
  const fail = (why) => {
    console.error(`\nFAIL: download: ${why}`);
    process.exitCode = 1;
  };
  const LINE = "0123456789abcdef\n";
  const BIG = 16_000_003;
  const made = await page.evaluate((line) => window.runCommand(line),
    `printf 'from the machine\\n' > /tmp/note.txt && yes 0123456789abcdef | head -c ${BIG} > '/tmp/big file.bin'`);
  const saved = [];
  const onDownload = (download) => saved.push(download);
  page.on("download", onDownload);
  const before = await page.evaluate(() => window.terminalText());
  const status = await page.evaluate((line) => window.runCommand(line), "download /tmp/note.txt '/tmp/big file.bin'");
  const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
  for (let waited = 0; saved.length < 2 && waited < 30_000; waited += 200) await new Promise((r) => setTimeout(r, 200));
  page.off("download", onDownload);
  const files = await Promise.all(saved.map(async (d) => ({ name: d.suggestedFilename(), bytes: await readFile(await d.path()) })));
  const refused = [];
  for (const [line, want, says] of [["download /tmp", 1, "is a directory"], ["download /tmp/none", 1, "is not a file"], ["download", 2, "usage: download FILE"]]) {
    const at = await page.evaluate(() => window.terminalText());
    const got = await page.evaluate((l) => window.runCommand(l), line);
    const said = (await page.evaluate(() => window.terminalText())).slice(at.length);
    if (got !== want || !said.includes(says)) refused.push({ line, got, says: said.trim().split("\n").pop() });
  }
  const big = files.find((f) => f.name === "big file.bin");
  const expected = Buffer.from(LINE.repeat(Math.ceil(BIG / LINE.length)).slice(0, BIG));
  console.log(`download: ${JSON.stringify({ made, status, files: files.map((f) => ({ name: f.name, bytes: f.bytes.length })), refused })}`);
  if (made !== 0 || status !== 0) fail(`the line exited with ${status}`);
  if (!printed.includes("note.txt (17 bytes) is in this browser's downloads") || !printed.includes("big file.bin (16.0 MB)")) fail("it did not say where each file went");
  if (files.find((f) => f.name === "note.txt")?.bytes.toString() !== "from the machine\n") fail("note.txt did not come whole");
  if (!big || !big.bytes.equals(expected)) fail(`the 16 MB file did not come byte for byte (${big?.bytes.length} bytes)`);
  if (refused.length) fail(`it did not refuse ${refused.map((r) => r.line).join(", ")} as it should`);
}

// A hub profile is checked before a run starts: when the hub replaced the version this browser
// trusted, Start recording starts nothing and asks to trust the new one. A stand-in serves the hub.
async function checkTrustBeforeRecord(context, page) {
  const hub = (url) => url.hostname === "www.clai.chat" && url.pathname === "/hub/check/agent/raw";
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, OPTIONS" };
  let body = MEETING;
  await context.route(hub, (route) => route.request().method() === "OPTIONS"
    ? route.fulfill({ status: 204, headers: cors })
    : route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body }));
  const fail = (why) => {
    console.error(`\nFAIL: the trust check before a run: ${why}`);
    process.exitCode = 1;
  };
  const records = () => page.evaluate(() => [...window.hoodModel.procs.values()].filter((p) => p.action.startsWith("minutes:Record")).length);
  try {
    const first = await page.evaluate(async () => {
      const m = window.minutes;
      m.config.profile = "cchub:check/agent";
      m.distrust();
      return { trusted: await m.trust(), check: await m.checkTrust() };
    });
    if (!/^[0-9a-f]{64}$/.test(first.trusted ?? "") || first.check !== 0) return fail(`trusting the first version: ${JSON.stringify(first)}`);
    body = MEETING.replace('"description": "', '"description": "Changed. ');
    const before = await records();
    await page.evaluate(() => window.minutes.record("Trust check", ""));
    const state = await page.evaluate(() => ({
      needsTrust: window.minutes.needsTrust,
      notes: [...document.querySelectorAll(".note.error strong")].map((e) => e.textContent),
      label: document.querySelector("#record-form > .primary").textContent,
      recording: window.minutes.recording?.title ?? null,
    }));
    console.log(`Minutes, a changed hub profile: ${JSON.stringify(state)}`);
    if (await records() !== before || state.recording === "Trust check") return fail("Start recording started the agent");
    if (!state.needsTrust || !state.notes.includes("The agent changed since you trusted it") || state.label !== "Trust the agent and start recording") {
      fail(`the app did not ask to trust the new version: ${JSON.stringify(state)}`);
    }
  } finally {
    await context.unroute(hub);
    await page.evaluate(() => {
      window.minutes.config.profile = "/tmp/meeting.json";
      window.minutes.dismissAll();
      window.minutes.render();
    });
  }
}

// A version the hub publishes after Start recording's check, before the run fetches, and then
// during the meeting, before an Answer: no run the app started is refused. Each run is pinned to
// the hash the check printed, which clai reads from its cache, so neither run fetches. The user
// hears of the new version up front: the next Start asks to trust it, an Answer in the meeting
// says it keeps the version it started with, and naming the speakers of a meeting the page did
// not record asks to trust it.
async function checkTrustDuringMeeting(context, page) {
  const hub = (url) => url.hostname === "www.clai.chat" && url.pathname === "/hub/check/meeting/raw";
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, OPTIONS" };
  const v1 = MEETING;
  const v2 = MEETING.replace('"description": "', '"description": "Published mid-meeting. ');
  let body = v1;
  let gets = 0;
  // Set to publish v2 right after the next GET has been answered.
  let publishAfterGet = false;
  await context.route(hub, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    gets++;
    const served = body;
    if (publishAfterGet) {
      body = v2;
      publishAfterGet = false;
    }
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: served });
  });
  const fail = (why) => {
    console.error(`\nFAIL: a hub version published during a meeting: ${why}`);
    process.exitCode = 1;
  };
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const notes = () => page.evaluate(() => [...document.querySelectorAll(".note strong")].map((e) => e.textContent));
  const jobOf = (label) => page.evaluate((l) => {
    const j = window.minutes.jobs.find((x) => x.label === l);
    const command = j?.action ? window.hoodModel.tree(j.action).map((n) => n.proc.argv[2]).join(" ") : "";
    return j && { done: j.done, status: j.status, profile: j.profile, problem: j.problem?.title ?? null, pinned: command.includes(`-profile-path ${j.profile} `) };
  }, label);
  const done = (label) => page
    .waitForFunction((l) => window.minutes.jobs.find((x) => x.label === l)?.done, label, { timeout: 90_000 })
    .then(() => true, () => false);
  const before = await page.evaluate(() => ({ profile: window.minutes.config.profile }));
  try {
    const trusted = await page.evaluate(async () => {
      const m = window.minutes;
      m.config.profile = "cchub:check/meeting";
      m.distrust();
      return m.trust();
    });
    if (trusted !== sha(v1)) return fail(`trusting v1 printed ${trusted}, want ${sha(v1)}`);
    // Start recording: the check fetches v1, and the hub publishes v2 right after it.
    gets = 0;
    publishAfterGet = true;
    await page.click("#new");
    if (await page.isDisabled("#record-form > .primary")) await page.click("#mic-only");
    await page.fill("#title", "Pinned meeting");
    await page.click("#record-form > .primary");
    const stop = await page.waitForSelector("#stop:not([hidden])", { timeout: 60_000 }).then(() => true, () => false);
    if (!stop) {
      await done("Record");
      return fail(`the recording never showed Stop: ${JSON.stringify({ record: await jobOf("Record"), gets, notes: await notes() })}`);
    }
    await page.waitForTimeout(1000);
    await page.click("#stop");
    const recorded = await done("Record");
    const record = await jobOf("Record");
    const startGets = gets;
    // Answer, with v2 on the hub since the check.
    const replying = await page.waitForSelector("#reply-form:not([hidden]) #reply", { timeout: 30_000 }).then(() => true, () => false);
    if (!replying) return fail(`no reply form after the recording: ${JSON.stringify(record)}`);
    await page.fill("#reply", "Speaker A is Ada");
    await page.click("#reply-form button");
    const answered = await done("Answer");
    const answer = await jobOf("Answer");
    const state = await page.evaluate(() => ({ needsTrust: window.minutes.needsTrust }));
    const quiet = await notes();
    console.log(`Minutes, a hub version published during a meeting: ${JSON.stringify({ record, answer, startGets, gets, ...state, notes: quiet })}`);
    const pin = `cchub:check/meeting#sha256=${sha(v1)}`;
    if (!recorded || record?.status !== 0 || record.profile !== pin || !record.pinned) fail(`the recording was not run on v1's pin: ${JSON.stringify(record)}`);
    if (!answered || answer?.status !== 0 || answer.profile !== pin || !answer.pinned) fail(`the Answer was refused or not run on v1's pin: ${JSON.stringify(answer)}`);
    if (startGets !== 1 || gets !== 1) fail(`the runs fetched the hub: ${startGets} fetches by the end of the recording, ${gets} after the Answer; want only the check's`);
    if (quiet.some((t) => /changed since you trusted|keeps the agent/.test(t)) || state.needsTrust) fail(`the user was told of a change the page cannot know yet: ${JSON.stringify(quiet)}`);
    // The next Start checks again: v2 is refused up front and the user is asked to trust it.
    await page.click("#new");
    await page.fill("#title", "Next meeting");
    const runsBefore = await page.evaluate(() => window.minutes.jobs.length);
    await page.click("#record-form > .primary");
    await page.waitForFunction(() => window.minutes.needsTrust, null, { timeout: 30_000 }).catch(() => {});
    const asked = await page.evaluate(() => ({
      jobs: window.minutes.jobs.length,
      label: document.querySelector("#record-form > .primary").textContent,
      notes: [...document.querySelectorAll(".note.error strong")].map((e) => e.textContent),
    }));
    if (asked.jobs !== runsBefore || asked.label !== "Trust the agent and start recording" || !asked.notes.includes("The agent changed since you trusted it")) {
      fail(`the next Start did not ask to trust v2 up front: ${JSON.stringify(asked)}`);
    }
    // An Answer in the first meeting still runs v1, and says so.
    const fetched = gets;
    await page.evaluate(() => window.minutes.dismissAll());
    await page.evaluate(() => window.minutes.answer("And Speaker B is Bo"));
    const again = await page.evaluate(() => {
      const j = window.minutes.jobs[0];
      return { label: j.label, status: j.status, profile: j.profile, notes: [...document.querySelectorAll(".note strong")].map((e) => e.textContent) };
    });
    console.log(`Minutes, an Answer after the hub moved on: ${JSON.stringify({ ...asked, again, fetches: gets - fetched })}`);
    if (again.label !== "Answer" || again.status !== 0 || again.profile !== pin || gets !== fetched) fail(`the second Answer did not run v1 without a fetch: ${JSON.stringify(again)}`);
    if (!again.notes.includes("This meeting keeps the agent it started with")) fail(`the Answer did not say it keeps v1: ${JSON.stringify(again.notes)}`);
    // Naming the speakers runs no agent, so it asks no trust, though the hub moved on.
    await page.evaluate(() => {
      window.minutes.recording = null;
      window.minutes.show("record");
    });
    await page.click(".meeting >> text=Design review");
    const label = await page
      .waitForFunction(() => !document.querySelector("#speakers").hidden && document.querySelector("#speakers > .primary").textContent, null, { timeout: 30_000 })
      .then((h) => h.jsonValue(), () => null);
    console.log(`Minutes, naming the speakers of a meeting recorded elsewhere: ${JSON.stringify(label)}`);
    if (label !== "Name the speakers") fail(`naming the speakers asked for an agent it does not run: ${JSON.stringify(label)}`);
  } finally {
    await context.unroute(hub);
    await page.evaluate((c) => {
      Object.assign(window.minutes.config, c);
      window.minutes.dismissAll();
      window.minutes.show("record");
      window.minutes.render();
    }, before);
  }
}

// Sign in with OpenRouter against a stand-in for its two endpoints: the sign-in page sends the
// tab back to the callback page with a code, which the app trades, with the verifier of the
// challenge it sent, for a key. Disconnect forgets the key and links to where it is deleted.
async function checkOpenRouterSignin(context, page) {
  const KEY = "sk-or-v1-check-not-a-key";
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
  const sent = { challenge: null, exchange: null };
  const authPage = (url) => url.hostname === "openrouter.ai" && url.pathname === "/auth";
  const keysApi = (url) => url.hostname === "openrouter.ai" && url.pathname === "/api/v1/auth/keys";
  await context.route(authPage, (route) => {
    const url = new URL(route.request().url());
    sent.challenge = url.searchParams.get("code_challenge");
    const back = new URL(url.searchParams.get("callback_url"));
    back.search = new URLSearchParams({ code: "check-code", state: url.searchParams.get("state") }).toString();
    return route.fulfill({ status: 302, headers: { location: back.href } });
  });
  await context.route(keysApi, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    sent.exchange = route.request().postDataJSON();
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ key: KEY }) });
  });
  const fail = (why) => {
    console.error(`\nFAIL: Sign in with OpenRouter: ${why}`);
    process.exitCode = 1;
  };
  try {
    await page.click("#signin-openrouter");
    const signed = await page
      .waitForFunction((key) => window.minutes.env.get("OPENROUTER_API_KEY") === key, KEY, { timeout: 20_000 })
      .then(() => true, () => false);
    if (!signed) return fail(`no key reached the agents' env (exchange sent ${JSON.stringify(sent.exchange)})`);
    const verifier = sent.exchange?.code_verifier ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (sent.exchange.code !== "check-code" || sent.exchange.code_challenge_method !== "S256" || challenge !== sent.challenge) {
      return fail(`the exchange did not prove the challenge: ${JSON.stringify(sent.exchange)}, challenge ${sent.challenge}`);
    }
    const state = await page.evaluate(() => ({
      kept: localStorage.getItem("minutes.openrouter-key"),
      chip: document.querySelector("#key-chip").textContent,
      card: document.querySelector("#provider-card").hidden,
      line: window.minutes.agentLine("q", false),
    }));
    console.log(`openrouter: ${state.chip}`);
    if (state.kept !== KEY || !state.chip.startsWith("OpenRouter:") || !state.card || !state.line.includes("-cm 'or:openai/gpt-5.6-luna' -am ")) {
      return fail(`after the sign-in: ${JSON.stringify(state)}`);
    }
    await page.click("#change-key");
    const manage = `https://openrouter.ai/keys/${createHash("sha256").update(KEY).digest("hex")}`;
    const linked = await page
      .waitForFunction((href) => document.querySelector("#provider-manage").href === href && !document.querySelector("#provider-manage").hidden, manage, { timeout: 5_000 })
      .then(() => true, () => false);
    const forgot = await page.evaluate(() => [window.minutes.env.has("OPENROUTER_API_KEY"), localStorage.getItem("minutes.openrouter-key")]);
    if (!linked || forgot[0] || forgot[1] !== null) fail(`Disconnect left ${JSON.stringify(forgot)} or no link to ${manage}`);
  } finally {
    await context.unroute(authPage);
    await context.unroute(keysApi);
  }
}

// What the peek's terminal shows after `before`, the text it showed earlier.
const shownSince = (page, before, text, timeout = 30_000) => page
  .waitForFunction(([length, want]) => window.terminalText().slice(length).includes(want), [before.length, text], { timeout })
  .then(() => true, () => false);

// The meeting-transcriber profile with `cmd`, whose mock command files a meeting.
const writeCmdProfile = (page) => {
  const profile = JSON.parse(MEETING);
  profile.tools = [...profile.tools, "cmd"];
  return page.evaluate((text) => window.writeFile("/tmp/meeting-cmd.json", text), JSON.stringify(profile));
};

// The env of a run whose mock `cmd` files the meeting `slug` after `wait` seconds.
const files = (slug, title, wait) => {
  const write = `sleep ${wait}; mkdir -p meetings/summaries meetings/transcripts && ` +
    `printf "%s\\n" --- "title: ${title}" --- "Done." > meetings/summaries/2026-11-16T10-00Z_${slug}.md && ` +
    `printf "%s\\n" "Speaker A: hello" > meetings/transcripts/2026-11-16T10-00Z_${slug}.md`;
  return `CLAI_MOCK_AUDIO_TRANSCRIBE_FILE=/tmp/mic.wav CLAI_MOCK_CMD_COMMAND=${quote(write)}`;
};

// Two meetings at once: the first ends while the second records, Stop still ends the second, and both are filed.
// Meanwhile the peek's terminal is the user's: a line run there has the console as its controlling
// terminal, reads what is typed, is not fed by Stop, and dies of ^C.
async function checkParallel(page) {
  const fail = (why) => {
    console.error(`\nFAIL: two meetings at once: ${why}`);
    process.exitCode = 1;
  };
  await writeCmdProfile(page);
  const before = await page.evaluate(() => ({ profile: window.minutes.config.profile, env: window.minutes.config.env }));
  const job = (title) => page.evaluate((t) => {
    const j = window.minutes.jobs.find((x) => x.title === t);
    return j && { done: j.done, status: j.status, filed: j.filed, stopped: j.recordResult?.stoppedBecause ?? null, transcribed: Boolean(j.transcribedAt) };
  }, title);
  const start = async (title, env) => {
    await page.click("#new");
    await page.evaluate((e) => {
      window.minutes.config.profile = "/tmp/meeting-cmd.json";
      window.minutes.config.env = e;
      window.minutes.config.query = () => "tool_audio_sources tool_audio_record tool_audio_transcribe tool_cmd";
    }, env);
    if (await page.isDisabled("#record-form > .primary")) await page.click("#mic-only");
    await page.fill("#title", title);
    await page.click("#record-form > .primary");
    return page.waitForSelector("#stop:not([hidden])", { timeout: 60_000 }).then(() => true, () => false);
  };
  try {
    if (!(await start("First meeting", files("first", "First meeting", 25)))) return fail("the first recording never showed Stop");
    await page.waitForTimeout(2000);
    await page.click("#stop");
    const writing = await page
      .waitForFunction(() => window.minutes.jobs[0]?.transcribedAt && !document.querySelector("#time-left").hidden, null, { timeout: 60_000 })
      .then(() => true, () => false);
    const drawn = await page
      .waitForFunction(() => document.querySelector("#time-left").classList.contains("drawn"), null, { timeout: 15_000 })
      .then(() => true, () => false);
    const left = await page.textContent("#time-left-text");
    console.log(`two meetings, the first writing its notes: ${JSON.stringify({ writing, drawn, left })}`);
    if (!writing || !drawn || !/left|longer/.test(left)) fail("the first meeting showed no time left, or the pencil did not draw it");
    if (!(await start("Second meeting", files("second", "Second meeting", 1)))) return fail("the second recording never showed Stop");
    const listed = await page.evaluate(() => [...document.querySelectorAll("#meetings .meeting.job")].map((b) => b.textContent));
    const firstDone = await page
      .waitForFunction(() => window.minutes.jobs.find((j) => j.title === "First meeting")?.done, null, { timeout: 90_000 })
      .then(() => true, () => false);
    const recording = await job("Second meeting");
    // While the second meeting records, ^C in the terminal ends the line there (clai setup, which
    // reads /dev/tty), and not the recording.
    await page.evaluate(() => window.showTab("terminal"));
    const asked = await page.evaluate(() => window.terminalText());
    await page.evaluate(() => {
      window.setup = window.runCommand("clai setup");
    });
    const menu = await shownSince(page, asked, "[q]uit");
    await page.keyboard.press("Control+C");
    const interrupted = await Promise.race([page.evaluate(() => window.setup), page.waitForTimeout(10_000).then(() => "still running")]);
    const spared = await job("Second meeting");
    // A line that reads the terminal: Stop ends the recording without feeding it, and what is typed reaches it.
    const before = await page.evaluate(() => window.terminalText());
    await page.evaluate(() => {
      window.reading = window.runCommand(': </dev/tty && echo has-tty; read -r x; echo "read=[$x]"');
    });
    const tty = await shownSince(page, before, "has-tty");
    await page.click("#peek-close");
    await page.waitForTimeout(1000);
    await page.click("#stop");
    const stopped = await page
      .waitForFunction(() => window.minutes.jobs.find((j) => j.title === "Second meeting")?.recordResult, null, { timeout: 30_000 })
      .then(() => true, () => false);
    const fed = (await page.evaluate(() => window.terminalText())).slice(before.length).includes("read=");
    await page.evaluate(() => window.showTab("terminal"));
    await page.keyboard.type("hello");
    await page.keyboard.press("Enter");
    const read = await Promise.race([page.evaluate(() => window.reading), page.waitForTimeout(10_000).then(() => "still running")]);
    const typed = await shownSince(page, before, "read=[hello]", 5000);
    await page.click("#peek-close");
    const terminal = { menu, interrupted, spared, tty, stopped, fed, read, typed };
    console.log(`two meetings, lines in the terminal meanwhile: ${JSON.stringify(terminal)}`);
    if (!menu || interrupted !== 128 + 2 || spared?.done || spared?.stopped !== null) {
      fail("^C in the terminal did not end the line there, or reached the recording, while a meeting ran in the background");
    }
    if (!tty) fail("a line in the terminal had no controlling terminal while a meeting recorded");
    if (!stopped || fed) fail("Stop did not end the second recording, or fed the line that read the terminal");
    if (read !== 0 || !typed) fail("the line in the terminal did not read what was typed while a meeting ran in the background");
    const secondDone = await page
      .waitForFunction(() => window.minutes.jobs.find((j) => j.title === "Second meeting")?.done, null, { timeout: 60_000 })
      .then(() => true, () => false);
    const first = await job("First meeting");
    const second = await job("Second meeting");
    const meetings = await page.evaluate(() => window.minutes.meetings.map((m) => m.path));
    console.log(`two meetings: ${JSON.stringify({ listed, firstDone, recording, first, second, meetings })}`);
    const want = (slug) => `meetings/summaries/2026-11-16T10-00Z_${slug}.md`;
    if (!listed.some((text) => text.startsWith("First meeting"))) fail("the first meeting was not listed as in progress while the second recorded");
    if (!firstDone || recording?.stopped !== null) fail("the first meeting did not end while the second was still recording");
    if (!secondDone || second?.stopped !== "stop_file") fail("Stop did not end the second recording once the first meeting had ended");
    if (first?.filed !== want("first") || second?.filed !== want("second") || !meetings.includes(want("first")) || !meetings.includes(want("second"))) {
      fail("both meetings were not filed");
    }
    const filed = await page.evaluate((p) => window.minutes.readMeeting(p, "Check", true), want("first"));
    console.log(`two meetings, the first's transcript: ${JSON.stringify(filed?.transcript)}`);
    if (filed?.transcript !== `---\ntitle: First meeting\n---\n\n${MOCK_LINES}`) {
      fail("the transcript filed was not the transcription word for word below the meeting's front matter");
    }
  } finally {
    await page.evaluate((c) => {
      Object.assign(window.minutes.config, c);
      window.minutes.config.query = () => "tool_audio_sources tool_audio_record tool_audio_transcribe";
    }, before);
  }
}

// A filed meeting's recording, on top of it: it plays, the keyboard moves it, and it downloads named
// for the meeting. Then Transcribe again asks first, puts the recording back on the machine for the
// agent, which writes the meeting's notes anew in its own two files, and the recording stays kept.
async function checkRecording(page) {
  const fail = (why) => {
    console.error(`\nFAIL: a meeting's recording: ${why}`);
    process.exitCode = 1;
  };
  const path = "meetings/summaries/2026-11-16T10-00Z_second.md";
  const audio = "/tmp/recordings/again-2026-11-16T10-00Z_second.wav";
  const before = await page.evaluate(() => ({ profile: window.minutes.config.profile, env: window.minutes.config.env }));
  try {
    await page.click("#meetings .meeting:not(.job) >> text=Second meeting");
    const shown = await page
      .waitForFunction((p) => window.minutes.view === "meeting" && window.minutes.current?.path === p && window.minutes.player.key === p &&
        !document.querySelector("#tape").hidden && window.minutes.player.levels.length > 0 && document.querySelector("#recording").readyState >= 1, path, { timeout: 30_000 })
      .then(() => true, () => false);
    if (!shown) return fail("the filed meeting showed no recording with its wave");
    const top = await page.evaluate(() => ({
      next: document.querySelector(".meeting-head").nextElementSibling.id,
      above: document.querySelector("#tape").getBoundingClientRect().bottom <= document.querySelector(".cards").getBoundingClientRect().top,
      native: document.querySelector("#recording").controls,
    }));
    await page.click("#tape-play");
    const played = await page
      .waitForFunction(() => document.querySelector("#recording").currentTime > 0.5 && document.querySelector("#tape").classList.contains("playing"), null, { timeout: 15_000 })
      .then(() => true, () => false);
    await page.click("#tape-play");
    const paused = await page.evaluate(() => ({
      paused: document.querySelector("#recording").paused,
      label: document.querySelector("#tape-play").getAttribute("aria-label"),
      inked: Number(document.querySelector(".tape-inked rect").getAttribute("width")) > 0,
    }));
    await page.focus("#tape-seek");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    const seek = await page.evaluate(() => ({ at: document.querySelector("#recording").currentTime, said: document.querySelector("#tape-seek").getAttribute("aria-valuetext") }));
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), page.click("#recording-download")]);
    const saved = await readFile(await download.path());
    const kept = await page.evaluate(async (p) => (await window.minutes.recordings.get(p))?.size ?? null, path);
    const player = { ...top, played, ...paused, seek, name: download.suggestedFilename(), bytes: saved.length, riff: saved.subarray(0, 4).toString() };
    console.log(`Minutes, a meeting's recording: ${JSON.stringify(player)}`);
    if (top.next !== "tape" || !top.above || top.native) fail("the recording is not the pad's player at the top of the meeting");
    if (!played || !paused.paused || paused.label !== "Play the recording" || !paused.inked) fail("the player did not play, ink what it played, and pause");
    if (!(seek.at > 4.9 && seek.at < 5.1) || !/^0:05 of \d+:\d\d$/.test(seek.said ?? "")) fail("Home then the right arrow did not move the recording to 0:05");
    if (!/^Second-meeting-\d{4}-\d\d-\d\d\.wav$/.test(player.name) || player.bytes !== kept || player.riff !== "RIFF") fail("Download did not save the kept WAV named for the meeting and its day");

    // Who is speaking: each speaker's line plays from the kept recording, to hear who it is, and stops again.
    const rows = await page.$$eval("#speakers.playable .speaker-play:not([hidden])", (bs) => bs.map((b) => b.textContent));
    await page.click("#speakers .speaker-play >> nth=1");
    const heard = await page
      .waitForFunction(() => document.querySelectorAll(".speaker-play.playing").length === 1 && !document.querySelector("#recording").paused &&
        document.querySelector("#recording").currentTime >= 1, null, { timeout: 10_000 })
      .then(() => true, () => false);
    await page.click("#speakers .speaker-play >> nth=1");
    const hushed = await page.evaluate(() => document.querySelector("#recording").paused && !document.querySelector(".speaker-play.playing"));
    console.log(`Minutes, hearing a speaker: ${JSON.stringify({ rows, heard, hushed })}`);
    if (JSON.stringify(rows) !== JSON.stringify(["0:00", "0:01"]) || !heard || !hushed) {
      fail("Who is speaking did not offer each speaker's line from the recording, or did not play and stop it");
    }

    // Asked through Penelope, Transcribe again asks first as its button does; Keep these notes leaves the meeting be.
    const viaHer = await askPenelope(page, JSON.stringify({ say: "Shall I?", mood: "unsure", do: [{ action: "transcribe_again" }] }));
    await page.click("#penelope-close");
    const herNote = await page.evaluate(() => !document.querySelector("#again-note").hidden);
    if (herNote) await page.click("#again-no");
    const herKept = await page.evaluate(() => document.querySelector("#again-note").hidden && !window.minutes.jobs.some((j) => j.label === "Transcribe again"));
    console.log(`Minutes, Transcribe again through Penelope: ${JSON.stringify({ answered: viaHer.answered, offered: viaHer.command.includes("transcribe_again:"), note: herNote, kept: herKept })}`);
    if (!viaHer.answered || !viaHer.command.includes("transcribe_again:") || !herNote || !herKept) fail("Penelope's transcribe_again did not have the app ask first, as Transcribe again does");

    // The mock agent transcribes the file put back on the machine (it fails on a missing one) and rewrites the meeting;
    // the app then files the transcription's lines in place of the agent's.
    const write = "sleep 3; " +
      `printf "%s\\n" --- "title: Second meeting" --- "Transcribed again." > ${path} && ` +
      `printf "%s\\n" "Speaker A: hello again" > ${path.replace("summaries", "transcripts")}`;
    await page.evaluate((e) => {
      window.minutes.config.profile = "/tmp/meeting-cmd.json";
      window.minutes.config.env = e;
      window.minutes.config.query = () => "tool_audio_transcribe tool_cmd";
    }, `CLAI_MOCK_AUDIO_TRANSCRIBE_FILE=${audio} CLAI_MOCK_CMD_COMMAND=${quote(write)}`);
    await page.click("#again");
    const asked = await page.evaluate(() => ({
      note: !document.querySelector("#again-note").hidden,
      said: document.querySelector("#again-said").textContent,
      focus: document.activeElement?.id,
    }));
    await page.click("#again-yes");
    const listed = await page
      .waitForFunction(() => [...document.querySelectorAll("#meetings .meeting.job")].some((b) => b.textContent.startsWith("Second meeting")) &&
        document.querySelector(".cards").inert, null, { timeout: 30_000 })
      .then(() => true, () => false);
    const done = await page
      .waitForFunction(() => window.minutes.jobs.find((j) => j.label === "Transcribe again")?.done, null, { timeout: 120_000 })
      .then(() => true, () => false);
    const job = await page.evaluate(() => {
      const j = window.minutes.jobs.find((x) => x.label === "Transcribe again");
      return j && { status: j.status, filed: j.filed, transcribed: Boolean(j.transcribedAt) && j.transcriptChars > 0, audioPath: j.audioPath };
    });
    const redrawn = await page
      .waitForFunction(() => document.querySelector("#transcript").textContent.includes("of an audio file") && !document.querySelector(".cards").inert, null, { timeout: 30_000 })
      .then(() => true, () => false);
    const files = await page.evaluate((p) => window.minutes.readMeeting(p, "Check", true), path);
    const after = await page.evaluate(async (p) => ({
      meetings: window.minutes.meetings.filter((m) => m.title === "Second meeting").length,
      kept: (await window.minutes.recordings.get(p))?.size ?? null,
      tape: !document.querySelector("#tape").hidden,
      again: !document.querySelector("#again").hidden,
    }), path);
    const { body: onMachine } = await page.evaluate((a) => window.minutes.run("check", `{ echo again-size; wc -c < ${a}; } > /run/page/out`, { topic: "again-size", followUp: true }), audio);
    console.log(`Minutes, Transcribe again: ${JSON.stringify({ ...asked, listed, done, job, redrawn, summary: files?.summary, ...after, onMachine: Number(onMachine) })}`);
    if (!asked.note || !/corrections to them are replaced/.test(asked.said) || !/history/.test(asked.said) || asked.focus !== "again-yes") {
      fail("Transcribe again did not ask first, saying the corrections are replaced and what becomes of this version");
    }
    if (!listed || !done || job?.status !== 0 || job?.filed !== path || !job?.transcribed || job?.audioPath !== audio || Number(onMachine) !== kept) {
      fail("Transcribe again did not run in progress and transcribe the recording put back on the machine into the same meeting");
    }
    if (files?.transcript !== `---\ntitle: Second meeting\n---\n\n${MOCK_LINES}`) {
      fail(`the meeting transcribed again kept the agent's transcript lines, not the transcription's: ${JSON.stringify(files?.transcript)}`);
    }
    if (!redrawn || !files?.summary.includes("Transcribed again.") || after.meetings !== 1 || after.kept !== kept || !after.tape || !after.again) {
      fail("the meeting transcribed again did not show its new notes in place of the old, or lost its recording");
    }
  } finally {
    await page.evaluate((c) => {
      Object.assign(window.minutes.config, c);
      window.minutes.config.query = () => "tool_audio_sources tool_audio_record tool_audio_transcribe";
    }, before);
  }
}

// A short recording, sent as one request, shows its time left moving: the mock transcriber takes
// 28 s and says halfway how far it has heard, where the pace says 20 s, so the time left counts
// down, then says plainly that it runs over while the hatching creeps on and the list's clock
// ticks (web/www/jobs.js estimate).
async function checkTimeLeft(page) {
  const fail = (why) => {
    console.error(`\nFAIL: the time left of a short recording: ${why}`);
    process.exitCode = 1;
  };
  const before = await page.evaluate(() => ({ env: window.minutes.config.env, pace: localStorage.getItem("minutes.pace.3") }));
  try {
    await page.evaluate(() => {
      const pace = { turn: 2, transcribeFixed: 20, transcribePerMinute: 3 };
      localStorage.setItem("minutes.pace.3", JSON.stringify({ openai: pace, openrouter: pace, other: pace }));
      window.minutes.config.env = "CLAI_MOCK_AUDIO_TRANSCRIBE_FILE=/tmp/mic.wav CLAI_MOCK_TRANSCRIBE_DELAY=28s";
    });
    await page.click("#new");
    if (await page.isDisabled("#record-form > .primary")) await page.click("#mic-only");
    await page.fill("#title", "Time left");
    await page.click("#record-form > .primary");
    if (!(await page.waitForSelector("#stop:not([hidden])", { timeout: 60_000 }).then(() => true, () => false))) return fail("the recording never showed Stop");
    await page.waitForTimeout(2000);
    await page.click("#stop");
    if (!(await page.waitForFunction(() => window.minutes.recording?.transcribeAt, null, { timeout: 60_000 }).then(() => true, () => false))) {
      return fail("the agent never called audio_transcribe");
    }
    const samples = [];
    for (let i = 0; i < 45; i++) {
      const sample = await page.evaluate(() => {
        const r = window.minutes.recording;
        const meter = document.querySelector("#time-left");
        const stage = [...document.querySelectorAll("#stages li")].find((li) => li.textContent.startsWith("Transcribing"));
        const listed = [...document.querySelectorAll("#meetings .meeting.job")].find((b) => b.firstChild.textContent === "Time left");
        return {
          t: Math.round((Date.now() - r.transcribeAt) / 100) / 10,
          transcribing: !r.transcribedAt && !r.done,
          text: meter.hidden ? null : document.querySelector("#time-left-text").textContent,
          progress: meter.hidden ? null : Number(meter.dataset.progress),
          drawn: meter.classList.contains("drawn"),
          stage: stage?.textContent ?? null,
          listed: listed?.lastChild.textContent ?? null,
        };
      });
      samples.push(sample);
      if (!sample.transcribing) break;
      await page.waitForTimeout(1000);
    }
    const during = samples.filter((s) => s.transcribing);
    console.log(`the time left of a short recording: ${JSON.stringify(during.map(({ t, text, progress, stage, listed }) => ({ t, text, progress, stage, listed })))}`);
    const counts = during.map((s) => /^About (\d+) s left$/.exec(s.text ?? "")?.[1]).filter(Boolean).map(Number);
    const progress = during.map((s) => s.progress);
    if (during.length < 15) fail(`only ${during.length} samples while transcribing`);
    if (progress.some((p) => p === null || !(p < 1))) fail("the time left was hidden, or full, while transcribing");
    if (progress.some((p, i) => i > 0 && p < progress[i - 1]) || !(progress.at(-1) > progress[0])) fail("the hatching went back, or never moved");
    if (new Set(counts).size < 3 || counts.some((n, i) => i > 0 && n > counts[i - 1])) fail(`no countdown of at least three steps: ${counts}`);
    if (!during.some((s) => s.text === "Taking longer than expected")) fail("the run went over its estimate without saying so");
    if (during.some((s) => /-\d/.test(s.text ?? ""))) fail("a negative time left");
    if (!during.some((s) => /^Transcribing with .* · heard \d+:\d\d of \d+:\d\d$/.test(s.stage ?? ""))) fail("the stages never said how far the provider had heard");
    if (new Set(during.map((s) => /^Transcribing (\d+:\d\d) ·/.exec(s.listed ?? "")?.[1])).size < 10) fail("the list's clock did not tick");
    if (!during.some((s) => s.drawn)) fail("the pencil never drew the time left");
    if (!(await page.waitForFunction(() => window.minutes.recording?.done, null, { timeout: 60_000 }).then(() => true, () => false))) fail("the run never ended");
  } finally {
    await page.evaluate((b) => {
      window.minutes.config.env = b.env;
      if (b.pace === null) localStorage.removeItem("minutes.pace.3");
      else localStorage.setItem("minutes.pace.3", b.pace);
    }, before);
  }
}

// The pop-out (web/www/popout.js): Chrome's enterpictureinpicture action opens it, here on a click as
// it would on a tab switch while the mic records; the button opens it again; its Stop ends the
// recording; its row follows the run to "Filed". The tab's title and icon follow the run, and a run
// that ends while the tab is hidden sends a notification.
async function checkPopout(page) {
  const fail = (why) => {
    console.error(`\nFAIL: the pop-out: ${why}`);
    process.exitCode = 1;
  };
  const before = await page.evaluate(() => ({ profile: window.minutes.config.profile, env: window.minutes.config.env, title: window.minutes.title }));
  const rows = () => page.evaluate(() => [...(window.minutes.popout.win?.document.querySelectorAll("li") ?? [])].map((li) => ({
    kind: li.className,
    title: li.querySelector(".title")?.textContent,
    state: li.querySelector(".state")?.textContent,
    detail: li.querySelector(".detail")?.textContent,
    bars: li.querySelectorAll(".wave span").length,
    stop: Boolean(li.querySelector(".stop:not([hidden]):not(:disabled)")),
    gauge: li.querySelector(".gauge:not([hidden])")?.style.getPropertyValue("--p") || null,
  })));
  const tab = () => page.evaluate(() => ({ title: document.title, icon: document.querySelector('link[rel="icon"][type="image/svg+xml"]').href.slice(0, 26) }));
  const until = (fn, timeout = 30_000) => page.waitForFunction(fn, null, { timeout }).then(() => true, () => false);
  await writeCmdProfile(page);
  try {
    await page.evaluate((env) => {
      window.minutes.config.profile = "/tmp/meeting-cmd.json";
      window.minutes.config.env = env;
      window.minutes.config.query = () => "tool_audio_sources tool_audio_record tool_audio_transcribe tool_cmd";
      window.notified = [];
      window.realNotification = window.Notification;
      window.Notification = class {
        static permission = "granted";
        constructor(title, options) {
          window.notified.push([title, options?.body]);
        }
      };
      const action = Object.assign(document.createElement("button"), { id: "pip-action", textContent: "pip" });
      action.style.cssText = "position: fixed; top: 0; left: 0; z-index: 99999";
      action.onclick = () => window.mediaActions.get("enterpictureinpicture")?.();
      document.body.append(action);
    }, files("popout", "Pop-out meeting", 4));
    await page.click("#new");
    if (await page.isDisabled("#record-form > .primary")) await page.click("#mic-only");
    await page.fill("#title", "Pop-out meeting");
    await page.click("#record-form > .primary");
    if (!(await page.waitForSelector("#stop:not([hidden])", { timeout: 60_000 }).then(() => true, () => false))) return fail("the recording never showed Stop");
    await page.click("#pip-action");
    const auto = await until(() => window.minutes.popout.win?.document.querySelector("li.recording .wave span"));
    const recording = { auto, rows: await rows(), tab: await tab(), buttons: await page.evaluate(() => [...document.querySelectorAll(".popout-open")].map((b) => b.hidden)) };
    await page.evaluate(() => window.minutes.popout.close());
    const reopened = await until(() => !window.minutes.popout.open && !document.querySelector("#popout").hidden) &&
      (await page.click("#popout").then(() => until(() => window.minutes.popout.win?.document.querySelector("li.recording"))));
    console.log(`the pop-out while recording: ${JSON.stringify({ ...recording, reopened })}`);
    if (!auto || !reopened) fail("the enterpictureinpicture action or the pop-out button did not open the window");
    const [row] = recording.rows;
    if (recording.rows.length !== 1 || row.kind !== "recording" || row.title !== "Pop-out meeting" || !/^● 0:\d\d$/.test(row.state) || !row.stop || row.bars === 0) {
      fail("the recording's row did not show its title, clock, wave and Stop");
    }
    if (!recording.tab.title.startsWith("● 0:") || !recording.tab.icon.startsWith("data:image/svg+xml")) fail("the tab's title or icon did not say it records");
    if (!recording.buttons.every(Boolean)) fail("a pop-out button showed while the window was open");
    // Sound to record, so that audio_record ends with stop_file and a length to estimate from.
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      window.minutes.popout.win.document.querySelector("li.recording .stop").click();
    });
    const stopped = await until(() => window.minutes.jobs[0].recordResult?.stoppedBecause === "stop_file", 30_000);
    const progressing = await until(() => window.minutes.popout.win?.document.querySelector("li.progress .gauge:not([hidden])"), 30_000);
    const transcribing = { rows: await rows(), tab: await tab() };
    const done = await until(() => window.minutes.jobs[0].done, 90_000);
    await page.waitForTimeout(700);
    const filed = { rows: await rows(), tab: await tab(), notified: await page.evaluate(() => window.notified), job: await page.evaluate(() => window.minutes.jobs[0].filed) };
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const back = await tab();
    console.log(`the pop-out after Stop: ${JSON.stringify({ stopped, progressing, transcribing, done, filed, back })}`);
    if (!stopped) fail("the pop-out's Stop did not end the recording");
    const [after] = transcribing.rows;
    if (!progressing || after?.kind !== "progress" || after.title !== "Pop-out meeting" || !after.state || !/left|longer/.test(after.detail) || after.gauge === null) {
      fail("the row did not show the run's phase, hatching and time left after Stop");
    }
    if (!/ · /.test(transcribing.tab.title) || transcribing.tab.title.startsWith("●")) fail("the tab's title did not follow the run after Stop");
    if (!done || filed.job !== "meetings/summaries/2026-11-16T10-00Z_popout.md") fail("the meeting was not filed");
    if (filed.rows[0]?.kind !== "filed" || filed.rows[0].state !== "✓ Filed") fail("the row did not say the meeting was filed");
    if (!filed.tab.title.startsWith("✓ Filed · ") || !filed.notified.some(([t, body]) => t === "Notes filed" && body === "Pop-out meeting")) {
      fail("a run filed while the tab was hidden did not say so in the title and a notification");
    }
    if (back.title !== before.title || back.icon.startsWith("data:")) fail("the tab's title and icon did not come back once it showed again");
  } finally {
    await page.evaluate((c) => {
      delete document.visibilityState;
      window.Notification = window.realNotification;
      document.querySelector("#pip-action")?.remove();
      window.minutes.popout.close();
      window.minutes.config.profile = c.profile;
      window.minutes.config.env = c.env;
      window.minutes.config.query = () => "tool_audio_sources tool_audio_record tool_audio_transcribe";
    }, before);
  }
}

// Whether Penelope's bubble is open, or opening: one that shrinks away is still on the page a moment.
const penelopeOpen = (page) => page.$eval("#penelope", (el) => el.classList.contains("open"));

// Asks Penelope in her bubble and waits for her answer: what she said and the clai line she ran.
async function askPenelope(page, text) {
  if (!(await penelopeOpen(page))) await page.$eval("#penelope-pen", (el) => el.click());
  const before = await page.$$eval("#penelope-log li.penelope-her", (items) => items.length);
  await page.fill("#penelope-input", text);
  await page.press("#penelope-input", "Enter");
  const answered = await page
    .waitForFunction((n) => document.querySelectorAll("#penelope-log li.penelope-her").length > n && !document.querySelector("#penelope").classList.contains("busy"), before, { timeout: 60_000 })
    .then(() => true, () => false);
  return {
    answered,
    ...(await page.evaluate(() => {
      const action = [...window.hoodModel.procs.values()].filter((p) => p.action.startsWith("minutes:Ask Penelope")).at(-1)?.action;
      return {
        said: [...document.querySelectorAll("#penelope-log li.penelope-her")].at(-1)?.textContent,
        errors: document.querySelectorAll(".note.error").length,
        command: action ? window.hoodModel.tree(action).map((n) => n.proc.argv[2]).join(" ") : "",
      };
    })),
  };
}

// Penelope's Tools (beta): Linear, against a stand-in for mcp.linear.app. Its tick signs in with
// OAuth in the page (discovery, registration, PKCE), which becomes clai's token store entry; her run
// gets Linear in her profile and calls its tool with that token. A token that expired is refreshed
// by clai and kept by the page; untick detaches, and Sign out revokes the refresh token.
async function checkTools(context, page) {
  const standin = mcpStandIn();
  const linear = (url) => url.hostname === "mcp.linear.app";
  await context.route(linear, async (route) => {
    const r = route.request();
    const out = standin.handle({ method: r.method(), url: r.url(), headers: await r.allHeaders(), body: r.postData() });
    return route.fulfill(out);
  });
  const fail = (why) => {
    console.error(`\nFAIL: Penelope's tools: ${why}`);
    process.exitCode = 1;
  };
  const kept = () => page.evaluate(() => JSON.parse(localStorage.getItem("minutes.mcp") ?? "null"));
  // The mock model calls a tool once for each of its tokens past the calls already in the conversation.
  const callLinear = () => askPenelope(page, Array(standin.seen.calls.length + 1).fill("tool_mcp_linear_list_issues").join(" "));
  try {
    if (!(await penelopeOpen(page))) await page.$eval("#penelope-pen", (el) => el.click());
    await page.click("#penelope-tools");
    await page.click('#penelope-tools-list input[data-tool="linear"]');
    const attached = await page
      .waitForFunction(() => window.minutes.mcp.attached.includes("linear") && !window.minutes.mcpSigning, null, { timeout: 20_000 })
      .then(() => true, () => false);
    const signin = {
      attached,
      button: await page.textContent("#penelope-tools"),
      redirect: standin.seen.registered[0]?.redirect_uris?.[0],
      asked: standin.seen.authorized[0] && { resource: standin.seen.authorized[0].resource, method: standin.seen.authorized[0].code_challenge_method },
      grants: standin.seen.grants.map((g) => g.grant_type),
      token: (await kept())?.signins?.linear?.entry?.access_token,
      problems: standin.seen.problems,
      said: await page.textContent("#penelope-tools-list"),
    };
    console.log(`Penelope's tools, Linear sign-in: ${JSON.stringify(signin)}`);
    if (!attached || signin.button !== "Linear" || !signin.redirect?.endsWith("/signin-callback.html") || signin.asked?.resource !== "https://mcp.linear.app/mcp" ||
      signin.asked?.method !== "S256" || signin.grants.join() !== "authorization_code" || signin.token !== "standin-access-1" || signin.problems.length > 0) {
      return fail("ticking Linear did not sign in through the stand-in and attach it");
    }
    await page.click("#penelope-tools");
    const her = await callLinear();
    const profile = await page.evaluate(async () =>
      (await window.minutes.run("Check", "{ echo check; cat /tmp/penelope/profile.json; } > /run/page/out", { topic: "check", followUp: true })).body);
    const used = {
      answered: her.answered, errors: her.errors, calls: standin.seen.calls, server: JSON.parse(profile ?? "{}").mcp_servers?.linear,
      // The terminal wraps long lines, so the result is looked for by its issue's key.
      printed: (await page.evaluate(() => window.terminalText())).includes(`mcp_linear_list_issues: ${STANDIN_ISSUE.split(" ")[0]}`),
    };
    console.log(`Penelope's tools, a run with Linear: ${JSON.stringify(used)}`);
    if (!her.answered || her.errors || !used.printed || used.calls[0]?.name !== "list_issues" || used.calls[0]?.bearer !== "Bearer standin-access-1" ||
      JSON.stringify(used.server) !== JSON.stringify({ url: "https://mcp.linear.app/mcp", optional: true })) {
      return fail("Penelope's run did not have Linear in her profile, or did not call its tool with the sign-in's token");
    }
    // clai refreshes an expired token and writes it back, which the page keeps for the next reload.
    await page.evaluate(() => {
      window.minutes.mcp.signins.linear.entry.expires_at = "2020-01-01T00:00:00Z";
      window.minutes.saveMcp();
    });
    const again = await callLinear();
    const refreshed = { answered: again.answered, bearer: standin.seen.calls[1]?.bearer, grants: standin.seen.grants.map((g) => g.grant_type), token: (await kept())?.signins?.linear?.entry?.access_token };
    console.log(`Penelope's tools, a refreshed sign-in: ${JSON.stringify(refreshed)}`);
    if (!again.answered || refreshed.bearer !== "Bearer standin-access-2" || refreshed.grants.join() !== "authorization_code,refresh_token" || refreshed.token !== "standin-access-2") {
      return fail("clai did not refresh the expired token, or the page did not keep the refreshed one");
    }
    await page.click("#penelope-tools");
    await page.click('#penelope-tools-list input[data-tool="linear"]');
    const detached = await page.evaluate(() => ({ attached: window.minutes.mcp.attached, button: document.querySelector("#penelope-tools").textContent }));
    await page.click('#penelope-tools-list [data-signout="linear"]');
    const out = await page
      .waitForFunction(() => document.querySelector("#penelope-tools-list").textContent.includes("Signed out:"), null, { timeout: 10_000 })
      .then(() => true, () => false);
    const after = { detached, out, revoked: standin.seen.revoked.map((r) => [r.token, r.token_type_hint]), signins: Object.keys((await kept())?.signins ?? {}) };
    console.log(`Penelope's tools, untick and Sign out: ${JSON.stringify(after)}`);
    if (detached.attached.length > 0 || detached.button !== "+ Tools" || !out || after.revoked[0]?.[0] !== "standin-refresh-2" || after.signins.length > 0) {
      fail("untick did not detach Linear, or Sign out did not revoke its refresh token and forget it");
    }
  } finally {
    await page.keyboard.press("Escape");
    if (await penelopeOpen(page)) await page.click("#penelope-close");
    await context.unroute(linear);
  }
}

// The pointer is the system's, a pen over a text field. A click on the pen on the desk picks it up: the
// pointer is the pen, a drag draws blue ink on the pad, Escape puts the pen down and the ink stays,
// and going to another page turns the ink away with its page.
async function checkDoodling(page) {
  const cursors = () => page.evaluate(() => ({
    body: getComputedStyle(document.body).cursor,
    field: getComputedStyle(document.querySelector("#penelope-input")).cursor.startsWith("url("),
    pad: getComputedStyle(document.querySelector(".content")).cursor.startsWith("url("),
    doodling: document.body.classList.contains("doodling"),
  }));
  const ink = () => page.$$eval(".sketch path", (paths) => paths.map((p) => p.getAttribute("d")));
  // Penelope's bubble shrinks away over the pad before it is hidden.
  await page.waitForFunction(() => document.querySelector("#penelope-bubble").hidden, null, { timeout: 5_000 }).catch(() => {});
  const before = await cursors();
  await page.click("#desk-pen");
  const held = await cursors();
  const box = await page.locator(".content").boundingBox();
  const [x, y] = [box.x + box.width * 0.3, box.y + box.height * 0.6];
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + i * 8, y + Math.sin(i / 2) * 20);
  await page.mouse.up();
  const drawn = await ink();
  await page.keyboard.press("Escape");
  const down = { ...(await cursors()), ink: (await ink()).length };
  await page.click("#meetings .meeting:not(.job)");
  const turned = await page.waitForFunction(() => document.querySelectorAll(".sketch path").length === 0, null, { timeout: 5_000 }).then(() => true, () => false);
  await page.click("#new");
  console.log(`Doodling: ${JSON.stringify({ before, held, drawn: drawn.map((d) => d.slice(0, 40)), down, turned })}`);
  if (before.body !== "default" || !before.field || before.pad || before.doodling) {
    console.error("\nFAIL: the pointer is not the system's, or a text field's is not the pen");
    process.exitCode = 1;
  }
  if (!held.doodling || !held.pad || drawn.length !== 1 || !drawn[0].includes("Q")) {
    console.error("\nFAIL: picking up the desk pen did not make the pointer the pen, or a drag on the pad drew no stroke");
    process.exitCode = 1;
  }
  if (down.doodling || down.body !== "default" || down.ink !== 1 || !turned) {
    console.error("\nFAIL: Escape did not put the pen down keeping the ink, or the ink stayed when the page turned");
    process.exitCode = 1;
  }
}

// A pointer that rests near Penelope, wherever it is but on her or her bubble, she pounces on: one she
// reaches she eats, chewing it, one out of her reach she snaps at and misses.
async function checkPounce(page) {
  await page.waitForFunction(() => document.querySelector("#penelope-bubble").hidden, null, { timeout: 5_000 }).catch(() => {});
  await page.evaluate(() => {
    window.pounces = [];
    const her = document.querySelector("#penelope");
    new MutationObserver(() => {
      if (her.classList.contains("pouncing")) window.pounces.push("pounce");
      if (her.classList.contains("chewing")) window.pounces.push("chew");
    }).observe(her, { attributeFilter: ["class"] });
    new MutationObserver(() => document.body.classList.contains("pen-eaten") && window.pounces.push("eaten")).observe(document.body, { attributeFilter: ["class"] });
  });
  const rest = async ([x, y]) => {
    // One pounce at a time: the last one has chewed and the pointer is back.
    await page.waitForFunction(() => !window.minutes.penelope.pouncing, null, { timeout: 10_000 });
    await page.evaluate(() => { window.minutes.penelope.nextPounce = 0; window.pounces = []; });
    await page.mouse.move(x, y, { steps: 6 });
    await page.waitForTimeout(2_600);
    const seen = await page.evaluate(() => [...new Set(window.pounces)]);
    await page.mouse.move(40, 40, { steps: 4 });
    await page.waitForTimeout(400);
    return seen.join("+") || "none";
  };
  const spots = () => page.evaluate(() => {
    const e = document.querySelector(".penelope-eyes").getBoundingClientRect();
    const b = document.querySelector("#penelope-bubble").getBoundingClientRect();
    const eyes = [e.left + e.width / 2, e.top + e.height / 2];
    return { near: [eyes[0] - 120, eyes[1] - 20], far: [eyes[0] - 250, eyes[1] - 60], beside: [Math.min(innerWidth - 4, b.right + 12), eyes[1] - 200], over: [b.right - 40, b.bottom - 40] };
  });
  const closed = await spots();
  const seen = { near: await rest(closed.near), far: await rest(closed.far) };
  await page.$eval("#penelope-pen", (el) => el.click());
  await page.waitForTimeout(500);
  const open = await spots();
  Object.assign(seen, { beside: await rest(open.beside), over: await rest(open.over) });
  await page.click("#penelope-close");
  console.log(`Penelope, pouncing: ${JSON.stringify(seen)}`);
  if (seen.near !== "pounce+eaten+chew" || seen.far !== "pounce" || seen.beside === "none" || seen.over !== "none") {
    console.error("\nFAIL: Penelope did not eat and chew a pointer resting in her reach, snap at one beyond it, pounce beside her open bubble, or leave one on it alone");
    process.exitCode = 1;
  }
}

// Long unbroken text, such as an rg pattern or a URL, wraps inside her bubble.
async function checkBubbleWrap(page) {
  await page.waitForFunction(() => document.querySelector("#penelope-bubble").hidden, null, { timeout: 5_000 }).catch(() => {});
  await page.$eval("#penelope-pen", (el) => el.click());
  await page.waitForSelector("#penelope.open #penelope-bubble:not([hidden])");
  const over = await page.evaluate(() => {
    const her = window.minutes.penelope;
    const long = "ticket/github/linear/migrat/decid/spec/ipv/float/credit/budget/billing/edge/fix/mysql/postgres";
    her.log.push({ who: "her", text: `see https://example.com/${long}` });
    her.working(true, `Looking for “${long}”`);
    const wide = (el) => el.scrollWidth - el.clientWidth;
    const over = { doing: wide(document.querySelector("#penelope-doing")), log: wide(document.querySelector("#penelope-log")) };
    her.log.pop();
    her.working(false);
    return over;
  });
  await page.click("#penelope-close");
  console.log(`Penelope, long text past her bubble (px): ${JSON.stringify(over)}`);
  if (over.doing > 0 || over.log > 0) {
    console.error("\nFAIL: a long unbroken status or log line ran past Penelope's bubble instead of wrapping");
    process.exitCode = 1;
  }
}

// Penelope comes onto the desk as the app arrives and says how it works; Got it puts the guide away.
// With no meeting in focus she still answers, on her desk, told what the screen shows.
async function checkGuide(page) {
  const shown = await page.waitForSelector("#penelope-bubble:not([hidden]) #penelope-log .penelope-actions", { timeout: 60_000 }).then(() => true, () => false);
  const said = shown ? await page.textContent("#penelope-log") : null;
  if (shown) await page.click("#penelope-log .penelope-actions button");
  // The bubble shrinks back into her before it is hidden.
  await page.waitForFunction(() => document.querySelector("#penelope-bubble").hidden, null, { timeout: 5_000 }).catch(() => {});
  const state = await page.evaluate(() => ({ away: document.querySelector("#penelope-bubble").hidden, onDesk: !document.querySelector("#penelope").hidden, title: document.title }));
  console.log(`Penelope, the guide: ${JSON.stringify({ shown, said, ...state })}`);
  if (!shown || !said.includes("New recording") || !state.away || !state.onDesk || state.title !== "Penelope") {
    console.error("\nFAIL: Penelope did not greet with the guide at the start, Got it did not put it away, or the title is not hers");
    process.exitCode = 1;
  }
  const her = await askPenelope(page, "How do I record the sound of a call?");
  console.log(`Penelope, with no meeting: ${JSON.stringify({ ...her, command: her.command.slice(0, 300) })}`);
  if (!her.answered || her.errors || !her.command.includes("cd /tmp/penelope/desk") || !her.command.includes("Buttons showing:") || !her.command.includes("Meeting in focus: none")) {
    console.error("\nFAIL: Penelope did not answer with no meeting in focus, on her desk, told what the screen shows");
    process.exitCode = 1;
  }
  await page.click("#penelope-close");
}

// A Stop the instant the recording shows, before ffmpeg has opened its inputs, still ends them
// (audio/ffmpeg.sh): audio_record answers, the run ends, and no ffmpeg is left recording.
async function checkEarlyStop(page) {
  const fail = (why) => {
    console.error(`\nFAIL: a Stop at once: ${why}`);
    process.exitCode = 1;
  };
  const until = (fn, timeout) => page.waitForFunction(fn, null, { timeout }).then(() => true, () => false);
  await page.click("#new");
  if (await page.isDisabled("#record-form > .primary")) await page.click("#mic-only");
  await page.fill("#title", "Stopped at once");
  await page.click("#record-form > .primary");
  if (!(await page.waitForSelector("#stop:not([hidden])", { timeout: 60_000 }).then(() => true, () => false))) return fail("the recording never showed Stop");
  await page.click("#stop");
  const answered = await until(() => window.minutes.jobs[0].recordResult, 30_000);
  const done = await until(() => window.minutes.jobs[0].done, 90_000);
  const state = await page.evaluate(() => {
    const job = window.minutes.jobs[0];
    const recording = [...window.hoodModel.procs.values()].filter((p) => p.name === "ffmpeg" && p.end === null);
    return { title: job.title, record: job.recordResult, status: job.status, recording: recording.length };
  });
  console.log(`a Stop at once: ${JSON.stringify({ answered, done, ...state })}`);
  if (state.title !== "Stopped at once") return fail(`another run is the newest: ${state.title}`);
  if (!answered) fail("audio_record never answered: the stop was lost");
  if (!done) fail("the run never ended");
  if (state.recording > 0) fail("an ffmpeg still records");
}

// Two meetings in the one notebook directory, and each reply goes to its own meeting's conversation:
// meeting A ends with a question, B records and is filed, and A is answered while B still runs and
// again after B is filed. B's speakers are named after A's answers, and a meeting no run of this tab
// filed is named in a conversation of its own. Which saved conversation got each reply is read from
// clai's conversation files, by markers in each meeting's query.
async function checkReplies(page) {
  const fail = (why) => {
    console.error(`\nFAIL: replies to two meetings: ${why}`);
    process.exitCode = 1;
  };
  const profile = JSON.parse(MEETING);
  profile.tools = [...profile.tools, "cmd"];
  await page.evaluate((text) => window.writeFile("/tmp/meeting-cmd.json", text), JSON.stringify(profile));
  const before = await page.evaluate(() => ({ profile: window.minutes.config.profile, env: window.minutes.config.env }));
  const slugOf = (title) => title.toLowerCase().replace(/\W+/g, "-");
  const done = (pick, timeout = 90_000) => page
    .waitForFunction(pick, null, { timeout })
    .then(() => true, () => false);
  // Each saved conversation that holds `marker`, with whether it holds the first and the second meeting's.
  const holding = (marker) => page.evaluate(async (m) => {
    const line = `cd "$(clai confdir)/conversations" && { echo convs; for f in *.json; do ` +
      `[ "$f" = globalScope.json ] && continue; grep -q -e '${m}' "$f" || continue; ` +
      `printf '%s %s %s\\n' "$f" "$(grep -c marker-first "$f")" "$(grep -c marker-second "$f")"; done; } > /run/page/out`;
    const { body } = await window.minutes.run("Find the conversation", line, { topic: "convs", followUp: true });
    return (body ?? "").split("\n").filter(Boolean).map((row) => {
      const [file, first, second] = row.split(" ");
      return { file, first: Number(first) > 0, second: Number(second) > 0 };
    });
  }, marker);
  const start = async (title, query, env) => {
    await page.click("#new");
    await page.evaluate(({ q, e }) => {
      window.minutes.config.profile = "/tmp/meeting-cmd.json";
      window.minutes.config.env = e;
      window.minutes.config.query = () => q;
    }, { q: query, e: env });
    if (await page.isDisabled("#record-form > .primary")) await page.click("#mic-only");
    await page.fill("#title", title);
    await page.click("#record-form > .primary");
  };
  const answer = async (text) => {
    await page.click("#meetings .meeting.job >> text=Replies first");
    if (!(await page.waitForSelector("#reply-form:visible", { timeout: 15_000 }).then(() => true, () => false))) return false;
    const answers = await page.evaluate(() => window.minutes.jobs.filter((j) => j.label === "Answer").length);
    await page.fill("#reply", text);
    await page.click("#reply-form button");
    return done(`window.minutes.jobs.filter((j) => j.label === "Answer").length === ${answers + 1} && window.minutes.jobs[0].done`);
  };
  // The meeting opens before its form is used: the one in view until then may show the form too.
  // The app names them itself, as saved corrections: no agent runs.
  const nameSpeakers = async (title, path, name) => {
    await page.click(`#meetings .meeting:not(.job) >> text=${title}`);
    if (!(await page.waitForSelector(`#speakers[data-path="${path}"]:not([hidden]) #speaker-rows input`, { timeout: 30_000 }).then(() => true, () => false))) return null;
    const jobs = await page.evaluate(() => window.minutes.jobs.length);
    await page.fill("#speaker-rows input", name);
    await page.click("#speakers > button");
    const saved = await page
      .waitForFunction(() => /^Saved/.test(document.querySelector("#fixes-count").textContent), null, { timeout: 30_000 })
      .then(() => true, () => false);
    const files = await page.evaluate((p) => window.minutes.readMeeting(p, "Check", true), path);
    return { saved, transcript: files?.transcript, ran: (await page.evaluate(() => window.minutes.jobs.length)) !== jobs };
  };
  const second = "2026-11-16T11-00Z_replies-second";
  const write = "sleep 30; mkdir -p meetings/summaries meetings/transcripts && " +
    `printf "%s\\n" --- "title: Replies second" --- "Done." > meetings/summaries/${second}.md && ` +
    `printf "%s\\n" "Speaker A: hello" > meetings/transcripts/${second}.md`;
  try {
    // A asks before it records anything, so its answer may start the recording.
    await start("Replies first", "tool_audio_sources marker-first", "");
    if (!(await done(() => window.minutes.jobs.find((j) => j.title === "Replies first")?.done))) return fail("the first meeting never ended");
    await start("Replies second", "tool_audio_sources tool_audio_record tool_audio_transcribe tool_cmd marker-second",
      `CLAI_MOCK_AUDIO_TRANSCRIBE_FILE=/tmp/mic.wav CLAI_MOCK_CMD_COMMAND=${quote(write)}`);
    if (!(await page.waitForSelector("#stop:not([hidden])", { timeout: 60_000 }).then(() => true, () => false))) return fail("the second recording never showed Stop");
    await page.waitForTimeout(1000);
    await page.click("#stop");
    if (!(await done(() => window.minutes.jobs.find((j) => j.title === "Replies second")?.recordResult))) return fail("the second recording did not stop");
    const answered = await answer("Ada is Speaker A marker-answer-one");
    const secondRan = await page.evaluate(() => !window.minutes.jobs.find((j) => j.title === "Replies second").done);
    const filed = await done(() => window.minutes.jobs.find((j) => j.title === "Replies second")?.filed);
    const again = filed && (await answer("Grace is Speaker B marker-answer-two"));
    const renamed = filed && (await nameSpeakers("Replies second", `meetings/summaries/${second}.md`, "Linus"));
    const design = await nameSpeakers("Design review", "meetings/summaries/2026-10-28T09-00Z_design-review.md", "Barbara");
    const found = {
      one: await holding("marker-answer-one"),
      two: await holding("marker-answer-two"),
    };
    const jobs = await page.evaluate(() => window.minutes.jobs.map((j) => ({ label: j.label, title: j.title, status: j.status, chat: j.chat ?? null })));
    console.log(`replies to two meetings: ${JSON.stringify({ answered, secondRan, filed, again, renamed, design, found, jobs })}`);
    const only = (rows, first, second) => rows.length === 1 && rows[0].first === first && rows[0].second === second;
    if (!answered || !again) return fail("a reply did not run to its end");
    if (!renamed?.saved || renamed.ran || renamed.transcript !== `---\ntitle: Replies second\n---\n\n${MOCK_LINES.replace("Speaker A", "Linus")}`) {
      fail(`naming a speaker did not put the name in place of the label, as saved corrections without an agent run: ${JSON.stringify(renamed)}`);
    }
    if (!design?.saved || design.ran || design.transcript !== "**Barbara** [00:12]: Ship it on Friday.\n") {
      fail(`naming the speaker of a meeting no run filed did not put the name in its transcript: ${JSON.stringify(design)}`);
    }
    if (!only(found.one, true, false)) fail(`the answer sent while the second meeting ran went to ${JSON.stringify(found.one)}, not the first meeting's conversation`);
    if (!only(found.two, true, false) || found.two[0].file !== found.one[0]?.file) fail(`the answer sent after the second meeting was filed went to ${JSON.stringify(found.two)}, not the first meeting's conversation`);
  } finally {
    await page.evaluate((c) => {
      Object.assign(window.minutes.config, c);
      window.minutes.config.query = () => "tool_audio_sources tool_audio_record tool_audio_transcribe";
    }, before);
  }
}

// known-voices phase 9, "Output of a transcription": Lorentz named by a confirmed clip, speaker B only labelled.
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

// Known people in Penelope (worklogs/2026-11-18-penelope-known-voices, phase 6): Minutes' runs carry the voice
// library and the meeting's people, and "Who is speaking?" keeps, corrects and remembers voices. With an empty
// library the real clai runs as before; then voices-standin.mjs stands first on the machine's PATH. The
// scenario empties minutes-voices' and minutes-segments' stores at its start and end.
async function checkKnownPeople(page) {
  const fail = (step) => {
    console.error(`\nFAIL: known people: ${step}`);
    process.exitCode = 1;
  };
  await page.evaluate(async () => {
    const { toBase64 } = await import("./recordings.js");
    let topics = 0;
    const sh = async (line, args = []) => {
      const topic = `known-check-${++topics}`;
      const { status, body } = await window.minutes.run("Check known people", `{ echo ${topic}; ${line}; } > /run/page/out`,
        { topic, followUp: true, background: true, args });
      return { status, body };
    };
    const clip = (size, seed) => {
      const bytes = new Uint8Array(size);
      let x = 2166136261;
      for (const c of seed) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0;
      for (let i = 0; i < size; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        bytes[i] = x & 255;
      }
      return bytes;
    };
    // An existing database, or null; none is created.
    const opened = (name) => new Promise((resolve) => {
      const request = indexedDB.open(name);
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    const all = (db, store, what) => new Promise((resolve) => {
      if (!db?.objectStoreNames.contains(store)) return resolve([]);
      const q = db.transaction(store).objectStore(store)[what]();
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => resolve([]);
    });
    window.kpc = {
      sh,
      empty: async () => {
        for (const [name, stores] of [["minutes-voices", ["files", "lines"]], ["minutes-segments", ["meetings"]]]) {
          const db = await opened(name);
          const present = stores.filter((s) => db?.objectStoreNames.contains(s));
          if (present.length) {
            await new Promise((resolve) => {
              const tx = db.transaction(present, "readwrite");
              for (const s of present) tx.objectStore(s).clear();
              tx.oncomplete = tx.onerror = tx.onabort = resolve;
            });
          }
          db?.close();
        }
      },
      // Files under the machine's voices/: [path, base64] each.
      lay: async (files) => {
        const dir = `${(await sh("clai confdir")).body.trim()}/voices`;
        for (const [path, data] of files) {
          await sh(`mkdir -p "${dir}/${path.replace(/\/[^/]*$/, "")}" && printf %s "$1" | base64 -d > "${dir}/${path}"`, [data]);
        }
      },
      bytes: (size, seed) => toBase64(clip(size, seed)),
      text: (text) => toBase64(new TextEncoder().encode(text)),
      // A clip's bytes, staged where the stand-in's run copies them from.
      stage: (path, size, seed) => sh(`printf %s "$1" | base64 -d > ${path}`, [toBase64(clip(size, seed))]),
      counted: async () => {
        const db = await opened("minutes-segments");
        const keys = await all(db, "meetings", "getAllKeys");
        db?.close();
        return keys.length;
      },
      // The first 48 bytes of each kept clip, as base64 and as text.
      slices: async () => {
        const db = await opened("minutes-voices");
        const [keys, values] = [await all(db, "files", "getAllKeys"), await all(db, "files", "getAll")];
        db?.close();
        return keys.flatMap((k, i) => {
          if (!k.endsWith(".flac")) return [];
          const head = new Uint8Array(values[i]).subarray(0, 48);
          return [toBase64(head), String.fromCharCode(...head)];
        });
      },
      leaks: (slices) => {
        const stored = [];
        for (let i = 0; i < localStorage.length; i++) stored.push(localStorage.getItem(localStorage.key(i)) ?? "");
        const notes = [...document.querySelectorAll(".note")].map((n) => n.textContent).join("\n");
        const log = window.hoodModel.log.map((e) => e.text).join("\n");
        return slices.filter((s) => stored.some((v) => v.includes(s)) || notes.includes(s) || log.includes(s)).length;
      },
      // The stand-in's calls: their arguments, what voices/ held, an add's wav size and the transcript's sha256.
      calls: async () => {
        const parts = ((await sh("cat /tmp/standin/calls 2>/dev/null; :")).body ?? "").split("\0");
        const out = [];
        let c = null;
        for (let i = 0; i < parts.length; i++) {
          const t = parts[i];
          if (t === "call") out.push((c = { args: [], voices: "", wav: null, sha: null }));
          else if (t === "end") c = null;
          else if (c && ["arg", "voices", "wav", "sha"].includes(t)) {
            const v = parts[++i];
            if (t === "arg") c.args.push(v);
            else c[t] = v;
          }
        }
        return out;
      },
      notes: () => [...document.querySelectorAll(".note strong")].map((e) => e.textContent),
      rows: () => [...document.querySelector("#speakers").querySelectorAll("#speaker-rows .speaker")]
        .map((el) => (el.dataset.clip ? `learned ${el.dataset.clip}` : el.dataset.name ? `library ${el.dataset.name}` : `label ${el.dataset.label}`)),
      people: async () => (await window.minutes.voices.people()).map((p) => `${p.name}: ${p.clips.map((c) => `${c.id} ${c.status}`).join(", ")}`),
      kept: (path) => window.minutes.segments.get(path),
      files: (path) => window.minutes.readMeeting(path, "Check", true),
      said: () => (document.querySelector("#speakers-said").hidden ? "" : document.querySelector("#speakers-said").textContent),
      jobs: () => window.minutes.jobs.length,
    };
  });
  const kp = (name, ...args) => page.evaluate(([n, a]) => window.kpc[n](...a), [name, args]);
  const sh = async (line, args = []) => (await kp("sh", line, args)).body ?? "";
  const write = (path, text) => page.evaluate(([p, t]) => window.writeFile(p, t), [path, text]);
  const until = (fn, arg, timeout = 60_000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
  const idle = () => until(() => !window.minutes.saving && !window.minutes.choosing && !window.minutes.jobs.some((j) => !j.done));
  const SUMMARY = (slug) => `meetings/summaries/2026-11-18T09-00Z_${slug}.md`;
  const TRANSCRIPT = (slug) => SUMMARY(slug).replace("summaries", "transcripts");
  const LINES = "[0:00] Lorentz: …\n[0:09] Speaker B: …\n";
  const line = (e) => `${JSON.stringify(e)}\n`;
  const added = (id, at, clip, status, source, seconds) => line({ id, at, event: "added", clip, status, source, seconds });
  // The run's notes, as the agent files them: the transcript file holds its front matter only.
  const notes = (slug, title) => {
    const front = `--- ${quote(`title: ${title}`)} 'date: 2026-11-18T09:00:00Z' 'duration: 1' ---`;
    return [
      "mkdir -p meetings/summaries meetings/transcripts",
      `printf '%s\\n' ${front} '' 'Lorentz opened the meeting; Speaker B had last week'\\''s numbers.' > ${SUMMARY(slug)}`,
      `printf '%s\\n' ${front} > ${TRANSCRIPT(slug)}`,
    ].join("\n");
  };
  // What audio_remember_voice leaves in voices/ for a clip it learned.
  const learns = (slug, name, id, event) => [
    `mkdir -p "$VOICES/${slug}"`,
    `[ -e "$VOICES/${slug}/voice.json" ] || printf '%s' '{"name":"${name}"}' > "$VOICES/${slug}/voice.json"`,
    `[ -e "$VOICES/${slug}/${id}.flac" ] || cp /tmp/standin/${slug}.flac "$VOICES/${slug}/${id}.flac"`,
    `grep -qs ${quote(event.trim())} "$VOICES/${slug}/events.jsonl" || printf '%s' ${quote(event)} >> "$VOICES/${slug}/events.jsonl"`,
  ].join("\n");
  const CHRISTOPH = added("b1b2c3d4e5f60718", "2026-11-18T09:01:00Z", "4be07c19a2f1", "unconfirmed", "audio_remember_voice", 7.8);
  const ADA = added("c1c2c3d4e5f60718", "2026-11-18T09:05:00Z", "0123456789ab", "unconfirmed", "audio_remember_voice", 6.1);
  const HEDY = added("d1d2d3d4e5f60718", "2026-11-18T09:07:00Z", "5e5e5e5e5e5e", "unconfirmed", "audio_remember_voice", 5.2);
  const IDA = added("e1e2e3e4e5f60718", "2026-11-18T09:08:00Z", "6f6f6f6f6f6f", "unconfirmed", "audio_remember_voice", 4.4);
  const LORENTZ_CLIP = { clip: "lorentz/9f3c2a1b0d4e", status: "confirmed" };
  // The meeting transcribed again in a Send: other segments, Lorentz still named.
  const HEARD_AGAIN = {
    segments: [{ start: 0, end: 5.5, speaker: "Lorentz", voice: LORENTZ_CLIP, text: "…" }, { start: 6, end: 14, speaker: "C", text: "…" }],
    naming: { status: "named", origin: "flag", speakers: [{ label: "A", name: "Lorentz", voice: LORENTZ_CLIP }, { label: "C", reason: "no-match" }], voices: [{ name: "Lorentz", result: "named" }] },
  };
  // Lorentz named by two clips, so "Not Lorentz?" overrules both.
  const HEARD_TWO = {
    segments: [
      { start: 0, end: 6, speaker: "Lorentz", voice: LORENTZ_CLIP, text: "…" },
      { start: 7, end: 12, speaker: "B", text: "…" },
      { start: 13, end: 18, speaker: "Lorentz", voice: { clip: "lorentz/1a7d0f23c9b8", status: "unconfirmed" }, text: "…" },
    ],
    naming: { status: "named", origin: "flag", speakers: [], voices: [{ name: "Lorentz", result: "named" }] },
  };
  const remembered = (text) => [{ type: "tool_call", name: "audio_remember_voice" }, { type: "tool_result", name: "audio_remember_voice", ok: true, output: text }];
  const transcribed = (output) => [{ type: "tool_call", name: "audio_transcribe" }, { type: "tool_result", name: "audio_transcribe", ok: true, output }];
  const filed = (slug) => ({ type: "reply", text: `The notes are filed: [the summary](${SUMMARY(slug)}).` });
  // The standing run: the example transcription, Christoph's voice learned, the notes filed.
  const standing = (slug) => [
    { type: "chat", id: `standin-${slug}` }, ...transcribed(`${JSON.stringify(HEARD, null, 2)}\n`),
    ...remembered("Christoph: clip 4be07c19a2f1 added (unconfirmed)"), filed(slug),
  ];
  const stage = async ({ records, run = "", record = false }) => {
    await write("/tmp/standin/records", records.map(line).join(""));
    await write("/tmp/standin/run.sh", run);
    await sh(record ? ": > /tmp/standin/record" : "rm -f /tmp/standin/record");
  };
  const voicesCalls = async () => (await kp("calls")).filter((c) => c.args.slice(0, 2).join(" ") === "audio voices");
  const agentCalls = async () => (await kp("calls")).filter((c) => c.args.some((a) => a === "query" || a === "chat"));
  // New recording, the name typed and `tick` ticked, then Start; resolves once the run is done.
  const start = async (title, tick = []) => {
    await page.click("#new");
    if (await page.isDisabled("#record-form > .primary")) await page.click("#mic-only");
    await page.fill("#title", title);
    for (const name of tick) {
      await page.waitForSelector(`#people:not([hidden]) input[value="${name}"]`, { timeout: 15_000 });
      await page.check(`#people input[value="${name}"]`);
    }
    const jobs = await kp("jobs");
    await page.click("#record-form > .primary");
    return until((n) => window.minutes.jobs.length > n && window.minutes.jobs[0].done, jobs, 90_000);
  };
  const open = async (slug) => {
    await page.evaluate((p) => window.minutes.open(window.minutes.meetings.find((m) => m.path === p)), SUMMARY(slug));
    return until((p) => window.minutes.current?.path === p && !document.querySelector("#speakers").hidden, SUMMARY(slug));
  };
  // The machine's exec splits an argument at its newlines (2026-11-18), so a query reaches clai, and the stand-in, as several.
  const queryOf = (call) => call?.args.slice(call.args.lastIndexOf("query") + 1).join("\n") ?? "";
  const before = await page.evaluate(() => ({ profile: window.minutes.config.profile, env: window.minutes.config.env, path: window.minutes.env.get("PATH") ?? null }));
  try {
    await kp("empty");
    await page.evaluate(() => window.minutes.dismissAll());
    await sh('rm -rf "$(clai confdir)/voices" /tmp/standin; mkdir -p /tmp/standin/bin');

    // Unchanged without voices: the real clai, an empty library and nobody ticked.
    {
      await writeCmdProfile(page);
      await page.evaluate((e) => {
        window.minutes.config.profile = "/tmp/meeting-cmd.json";
        window.minutes.config.env = e;
        window.minutes.config.query = () => "tool_audio_sources tool_audio_record tool_audio_transcribe tool_cmd";
      }, files("unchanged", "Unchanged", 1));
      const puts = () => page.evaluate(() => [...window.hoodModel.procs.values()].filter((p) => p.action.startsWith("minutes:Put the voices")).length);
      const put = await puts();
      await page.click("#new");
      if (await page.isDisabled("#record-form > .primary")) await page.click("#mic-only");
      await page.fill("#title", "Unchanged");
      await page.waitForTimeout(500);
      const hidden = await page.evaluate(() => document.querySelector("#people").hidden);
      await page.click("#record-form > .primary");
      if (await page.waitForSelector("#stop:not([hidden])", { timeout: 60_000 }).then(() => true, () => false)) {
        await page.waitForTimeout(2000);
        await page.click("#stop");
      }
      const done = await until(() => window.minutes.jobs[0]?.label === "Record" && window.minutes.jobs[0].done && window.minutes.jobs[0].filed, null, 90_000);
      const path = "meetings/summaries/2026-11-16T10-00Z_unchanged.md";
      const ran = await page.evaluate(() => window.hoodModel.tree(window.minutes.jobs[0].action).map((n) => n.proc.argv[2]).join(" "));
      const transcript = (await kp("files", path))?.transcript;
      const kept = await kp("kept", path);
      const voices = (await sh('[ -e "$(clai confdir)/voices" ] && echo there || echo none')).trim();
      const unchanged = { hidden, done, flag: ran.includes("-voices"), people: ran.includes("People:"), voices, puts: (await puts()) - put, transcript, kept };
      console.log(`known people, unchanged without voices: ${JSON.stringify(unchanged)}`);
      if (!hidden || !done || unchanged.flag || unchanged.people || voices !== "none" || unchanged.puts !== 0 ||
        transcript !== `---\ntitle: Unchanged\n---\n\n${MOCK_LINES}` || kept?.segments?.length !== 2 || kept.naming !== null || JSON.stringify(kept.learned) !== "[]") {
        fail("unchanged without voices: the people row showed, the run carried -voices or People:, voices/ appeared, a put ran, or the transcript or the kept segments differ");
      }
    }

    // The stand-in first on PATH, and the standing library taken, then gone from the machine.
    await write("/tmp/standin/bin/clai", VOICES_STANDIN);
    await sh("chmod +x /tmp/standin/bin/clai");
    const path = await sh('printf %s "$PATH"');
    await page.evaluate((p) => {
      window.minutes.env.set("PATH", `/tmp/standin/bin:${p}`);
      Object.assign(window.minutes.config, { profile: "/tmp/meeting.json", env: "" });
      window.minutes.config.query = () => "Standing meeting";
    }, path);
    await kp("stage", "/tmp/standin/christoph.flac", 2900, "christoph");
    await kp("stage", "/tmp/standin/ada.flac", 2700, "ada");
    await kp("stage", "/tmp/standin/hedy.flac", 2600, "hedy");
    await kp("stage", "/tmp/standin/ida.flac", 2500, "ida");
    await kp("lay", [
      ["lorentz/voice.json", await kp("text", '{"name":"Lorentz"}')],
      ["lorentz/9f3c2a1b0d4e.flac", await kp("bytes", 3000, "lorentz-1")],
      ["lorentz/1a7d0f23c9b8.flac", await kp("bytes", 3100, "lorentz-2")],
      ["lorentz/events.jsonl", await kp("text", added("5a1f0c9e2b7d4a63", "2026-11-18T09:12:44.120394Z", "9f3c2a1b0d4e", "confirmed", "voices add", 8.4) +
        added("0c44e1a97f20b3d8", "2026-11-24T16:02:10Z", "1a7d0f23c9b8", "unconfirmed", "audio_remember_voice", 9.7))],
    ]);
    const taken = await page.evaluate(() => window.minutes.voices.take());
    await sh('rm -rf "$(clai confdir)/voices"');
    if (!taken) fail("the standing library was not taken");

    // Record with known people.
    {
      await stage({ records: standing("daily-sync"), run: `${notes("daily-sync", "Daily sync")}\n${learns("christoph", "Christoph", "4be07c19a2f1", CHRISTOPH)}`, record: true });
      await page.click("#new");
      const listed = await page.waitForSelector('#people:not([hidden]) input[value="Lorentz"]', { timeout: 15_000 }).then(() => true, () => false);
      const row = await page.$$eval("#people label.person", (ls) => ls.map((l) => l.textContent.trim()));
      const done = await start("Daily sync", ["Lorentz"]);
      const opened = await until((p) => window.minutes.current?.path === p, SUMMARY("daily-sync"));
      const call = (await agentCalls()).at(-1);
      const at = call?.args.indexOf("-voices") ?? -1;
      const transcript = (await kp("files", SUMMARY("daily-sync")))?.transcript ?? "";
      const kept = await kp("kept", SUMMARY("daily-sync"));
      const people = await kp("people");
      await page.click("#new");
      const christoph = await page.waitForSelector('#people input[value="Christoph"]', { timeout: 15_000 }).then(() => true, () => false);
      const ticked = await page.$$eval("#people input:checked", (bs) => bs.map((b) => b.value));
      await sh('rm -rf "$(clai confdir)/voices"');
      const put = await page.evaluate(() => window.minutes.voices.put());
      const restored = (await sh('[ -f "$(clai confdir)/voices/christoph/4be07c19a2f1.flac" ] && echo yes || echo no')).trim();
      const leaks = await kp("leaks", await kp("slices"));
      const notesShown = await kp("notes");
      const seen = { listed, row, done, opened, flag: call?.args.slice(at, at + 2), query: queryOf(call).slice(-20), voices: call?.voices, transcript, kept, people, christoph, ticked, put, restored, leaks, notes: notesShown };
      console.log(`known people, record with known people: ${JSON.stringify(seen)}`);
      if (!listed || JSON.stringify(row) !== '["Lorentz"]' || !done || !opened) fail("record with known people: the row did not list Lorentz, or the run did not end in its meeting");
      if (JSON.stringify(seen.flag) !== '["-voices","Lorentz"]' || !queryOf(call).endsWith("\n\nPeople: Lorentz") || !call.voices.includes("lorentz/9f3c2a1b0d4e.flac")) {
        fail("record with known people: the run had no -voices Lorentz or People: Lorentz, or the library was not on the machine when clai started");
      }
      if (!transcript.endsWith(`---\n\n${LINES}`) || transcript.includes("(unconfirmed)")) fail("record with known people: the transcript does not name the speakers as the segments do");
      if (JSON.stringify(kept) !== JSON.stringify({ segments: HEARD.segments, naming: HEARD.naming, learned: [{ name: "Christoph", clip: "4be07c19a2f1" }] })) {
        fail("record with known people: the meeting did not keep its segments, naming and its own run's learned clip alone");
      }
      if (!people.includes("Christoph: 4be07c19a2f1 unconfirmed") || !christoph || ticked.length !== 0) fail("record with known people: the learned clip is not in the browser, or the row did not list Christoph unticked");
      if (!put || restored !== "yes") fail("record with known people: a put on a new machine did not restore Christoph's clip");
      if (leaks !== 0 || notesShown.length !== 0) fail("record with known people: clip audio reached localStorage, a note or the hood's log, or a note went up");
    }

    // Each run names its people: a Send, Transcribe again, then a Start with nobody ticked that files nothing.
    {
      await stage({
        records: [{ type: "chat", id: "standin-daily-sync" }, ...remembered("Ada: clip 0123456789ab added (unconfirmed)"), filed("daily-sync")],
        run: learns("ada", "Ada", "0123456789ab", ADA),
      });
      const jobs = await kp("jobs");
      await page.evaluate(() => window.minutes.answer("Ada joined us halfway."));
      const sent = await until((n) => window.minutes.jobs.length > n && window.minutes.jobs[0].done, jobs);
      const send = (await agentCalls()).at(-1);
      const learned = (await kp("kept", SUMMARY("daily-sync")))?.learned;
      const segments = (await kp("kept", SUMMARY("daily-sync")))?.segments;
      // A Send that transcribes the meeting again and learns Hedy, the recording no longer on the machine (record.5).
      await sh("rm -f /tmp/recordings/standin-*.wav");
      await stage({
        records: [{ type: "chat", id: "standin-daily-sync" }, ...transcribed(`${JSON.stringify(HEARD_AGAIN, null, 2)}\n`), ...remembered("Hedy: clip 5e5e5e5e5e5e added (unconfirmed)"), filed("daily-sync")],
        run: `${notes("daily-sync", "Daily sync")}\n${learns("hedy", "Hedy", "5e5e5e5e5e5e", HEDY)}`,
      });
      let n = await kp("jobs");
      await page.evaluate(() => window.minutes.answer("Transcribe it again, please."));
      const retold = await until((k) => window.minutes.jobs.length > k && window.minutes.jobs[0].done, n);
      const heardAgain = await kp("kept", SUMMARY("daily-sync"));
      const transcriptAgain = (await kp("files", SUMMARY("daily-sync")))?.transcript ?? "";
      // A Send that learns Ida, links nothing and writes no note: it keeps the clip under the meeting it was about (record.6).
      await stage({ records: [{ type: "chat", id: "standin-daily-sync" }, ...remembered("Ida: clip 6f6f6f6f6f6f added (unconfirmed)"), { type: "reply", text: "Noted." }], run: learns("ida", "Ida", "6f6f6f6f6f6f", IDA) });
      n = await kp("jobs");
      await page.evaluate(() => window.minutes.answer("Ida was there too."));
      const unlinked = await until((k) => window.minutes.jobs.length > k && window.minutes.jobs[0].done, n);
      const heardUnlinked = await kp("kept", SUMMARY("daily-sync"));
      await stage({ records: [{ type: "chat", id: "standin-again" }, ...transcribed(`${JSON.stringify(HEARD, null, 2)}\n`), filed("daily-sync")], run: notes("daily-sync", "Daily sync") });
      await until((p) => window.minutes.current?.path === p && window.minutes.player.blob, SUMMARY("daily-sync"));
      // Transcribe again asks who is in the meeting, pre-ticked with whom its kept segments named (P7).
      n = await kp("jobs");
      await page.click("#again");
      await page.waitForFunction(() => document.querySelectorAll("#again-people input:checked").length > 0, null, { timeout: 10_000 }).catch(() => {});
      const againRow = await page.evaluate(() => [...document.querySelectorAll("#again-people input:checked")].map((b) => b.value));
      await page.click("#again-yes");
      await until((k) => window.minutes.jobs.length > k && window.minutes.jobs[0].done, n);
      const again = (await agentCalls()).at(-1);
      const count = await kp("counted");
      await stage({ records: [{ type: "chat", id: "standin-hallway" }, ...transcribed(JSON.stringify(HEARD.segments)), { type: "reply", text: "There was nothing to file." }] });
      const last = await start("Hallway chat");
      const after = await kp("counted");
      const nobody = (await agentCalls()).at(-1);
      const seen = {
        sent, send: send?.args.filter((a) => ["chat", "continue", "-voices", "Lorentz"].includes(a)), sendPeople: send?.args.some((a) => a.includes("People:")),
        learned, retold, heardAgain, unlinked, heardUnlinked: heardUnlinked?.learned,
        againRow, again: again?.args.filter((a) => ["-voices", "Lorentz"].includes(a)), againQuery: queryOf(again).slice(-17), last, nobody: nobody?.args.includes("-voices"), count, after,
      };
      console.log(`known people, each run names its people: ${JSON.stringify(seen)}`);
      if (!sent || JSON.stringify(seen.send) !== '["chat","continue","-voices","Lorentz"]' || seen.sendPeople) fail("each run names its people: the Send did not carry -voices Lorentz on chat continue, or carried a People paragraph");
      if (JSON.stringify(learned) !== JSON.stringify([{ name: "Christoph", clip: "4be07c19a2f1" }, { name: "Ada", clip: "0123456789ab" }]) ||
        JSON.stringify(segments) !== JSON.stringify(HEARD.segments)) fail("each run names its people: the Send did not keep its learned clip beside Christoph's under its meeting");
      const christophAda = [{ name: "Christoph", clip: "4be07c19a2f1" }, { name: "Ada", clip: "0123456789ab" }];
      if (!retold || !transcriptAgain.endsWith("---\n\n[0:00] Lorentz: …\n[0:06] Speaker C: …\n") ||
        JSON.stringify(heardAgain) !== JSON.stringify({ segments: HEARD_AGAIN.segments, naming: HEARD_AGAIN.naming, learned: [...christophAda, { name: "Hedy", clip: "5e5e5e5e5e5e" }] })) {
        fail("each run names its people: a Send that transcribed the meeting again did not keep its new segments, naming and learned clip");
      }
      if (!unlinked || JSON.stringify(heardUnlinked) !== JSON.stringify({ segments: HEARD_AGAIN.segments, naming: HEARD_AGAIN.naming,
        learned: [...christophAda, { name: "Hedy", clip: "5e5e5e5e5e5e" }, { name: "Ida", clip: "6f6f6f6f6f6f" }] })) {
        fail("each run names its people: a Send that learned a voice, linked nothing and wrote no note did not keep the clip under its meeting");
      }
      if (JSON.stringify(againRow) !== '["Lorentz"]' || JSON.stringify(seen.again) !== '["-voices","Lorentz"]' || seen.againQuery !== "\n\nPeople: Lorentz") {
        fail("each run names its people: Transcribe again did not ask who is in the meeting, pre-ticked with whom its kept segments named, and name them");
      }
      if (!last || seen.nobody || after !== count) fail("each run names its people: a Start with nobody ticked carried -voices, or a run that filed nothing kept segments");
    }

    // Keep: the meeting's rows, then Keep on Christoph's.
    {
      const opened = await open("daily-sync");
      await page.waitForSelector('.speaker[data-clip="christoph/4be07c19a2f1"] .speaker-keep', { timeout: 15_000 }).catch(() => {});
      const rows = await kp("rows");
      const jobs = await kp("jobs");
      const calls = (await voicesCalls()).length;
      await page.click('.speaker[data-clip="christoph/4be07c19a2f1"] .speaker-keep');
      const gone = await until(() => !document.querySelector('.speaker[data-clip="christoph/4be07c19a2f1"]') && !window.minutes.choosing);
      const made = (await voicesCalls()).slice(calls);
      const people = await kp("people");
      const seen = { opened, rows, gone, made: made.map((c) => [c.args.join(" "), c.voices.includes("christoph/")]), people, jobs: (await kp("jobs")) - jobs, notes: await kp("notes") };
      console.log(`known people, keep: ${JSON.stringify(seen)}`);
      if (!opened || !["learned christoph/4be07c19a2f1", "library Lorentz", "label Speaker B"].every((r) => rows.includes(r)) || rows.some((r) => r.includes("1a7d0f23c9b8"))) {
        fail("keep: the review did not show the library's name, the learned clip and the label, or showed a clip no run of the meeting learned");
      }
      if (JSON.stringify(seen.made) !== JSON.stringify([["audio voices list christoph 4be07c19a2f1 confirm", true]]) || !gone ||
        !people.includes("Christoph: 4be07c19a2f1 confirmed") || seen.jobs !== 0 || seen.notes.length !== 0) {
        fail("keep: Keep did not confirm the learned clip alone, with the library on the machine, and without an agent or a note");
      }
    }

    // Overrule: "Not Lorentz?" with Ada.
    {
      const transcriptFile = `~/notebook/${TRANSCRIPT("daily-sync")}`;
      await write("/tmp/standin/transcript", transcriptFile);
      const sha = (await sh(`sha256sum < ${transcriptFile} | cut -d' ' -f1`)).trim();
      const jobs = await kp("jobs");
      const calls = (await voicesCalls()).length;
      await page.click('.speaker[data-name="Lorentz"] .speaker-not');
      await page.fill('.speaker[data-name="Lorentz"] input[data-not]', "Ada");
      await page.click("#speakers > .primary");
      const saved = await until(() => !window.minutes.choosing && !window.minutes.saving && /^Saved/.test(document.querySelector("#fixes-count").textContent));
      const made = (await voicesCalls()).slice(calls);
      const files = await kp("files", SUMMARY("daily-sync"));
      const seen = {
        saved, made: made.map((c) => [c.args.join(" "), c.sha === sha]), transcript: files?.transcript.slice(-40), summary: files?.summary.slice(-60),
        row: await page.$('.speaker[data-name="Lorentz"]').then(Boolean), jobs: (await kp("jobs")) - jobs, notes: await kp("notes"),
      };
      console.log(`known people, overrule: ${JSON.stringify(seen)}`);
      if (JSON.stringify(seen.made) !== JSON.stringify([["audio voices list lorentz 9f3c2a1b0d4e overrule", true]])) fail("overrule: the clip was not overruled once, before the rename was saved, with no name on the line");
      if (!saved || !files?.transcript.includes("[0:00] Ada: …") || /\bLorentz\b/.test(files.transcript + files.summary) || !files.summary.includes("Ada opened the meeting")) {
        fail("overrule: the rename was not saved in both files");
      }
      if (seen.row || seen.jobs !== 0 || seen.notes.length !== 0) fail("overrule: the Lorentz row stayed, an agent ran or a note went up");
    }

    // Remember: Speaker B named Syrus with "Remember these voices", the WAV not on the machine.
    {
      const wav = "/tmp/recordings/again-2026-11-18T09-00Z_daily-sync.wav";
      await sh(`rm -f ${wav}`);
      const size = await page.evaluate(async (p) => (await window.minutes.recordings.get(p))?.size ?? null, SUMMARY("daily-sync"));
      const jobs = await kp("jobs");
      const calls = (await voicesCalls()).length;
      await page.fill('.speaker[data-label="Speaker B"] input[data-label]', "Syrus");
      await page.check("#remember");
      // show.6: the click answers at once, with the form busy and the step it is on.
      const busy = await page.evaluate(() => {
        const form = document.querySelector("#speakers");
        const button = form.querySelector(":scope > .primary");
        button.click();
        return {
          aria: form.getAttribute("aria-busy"), button: button.textContent, disabled: button.disabled, step: document.querySelector("#speakers-said").textContent,
          inputs: [...form.querySelectorAll("#speaker-rows input, #remember")].every((i) => i.disabled),
        };
      });
      const saved = await until(() => !window.minutes.choosing && !window.minutes.saving && window.minutes.current?.transcript.includes("[0:09] Syrus: …"));
      const idle = await page.evaluate(() => ({ aria: document.querySelector("#speakers").getAttribute("aria-busy"), naming: window.minutes.naming }));
      const made = (await voicesCalls()).slice(calls);
      const people = await kp("people");
      const transcript = (await kp("files", SUMMARY("daily-sync")))?.transcript ?? "";
      const seen = { busy, idle, saved, made: made.map((c) => [c.args.join(" "), c.wav?.trim()]), size, people, jobs: (await kp("jobs")) - jobs, notes: await kp("notes") };
      console.log(`known people, remember: ${JSON.stringify(seen)}`);
      if (JSON.stringify(seen.made) !== JSON.stringify([[`audio voices add ${wav} -from 9 -to 15.5 -name Syrus`, String(size)]])) fail("remember: the clip was not added once, from the recording put on the machine, at the span's times");
      if (!saved || !transcript.includes("[0:09] Syrus: …") || !people.some((p) => /^Syrus: [0-9a-f]{12} confirmed$/.test(p)) || seen.jobs !== 0 || seen.notes.length !== 0) {
        fail("remember: Syrus was not in the library with a confirmed clip and in the saved transcript, or an agent ran or a note went up");
      }
      if (busy.aria !== "true" || busy.button !== "Naming the speakers…" || !busy.disabled || !busy.inputs || busy.step !== "Getting the recording ready…") {
        fail(`remember: the click on Name the speakers did not show the form busy at once: ${JSON.stringify(busy)}`);
      }
      if (idle.aria !== "false" || idle.naming !== null) fail(`remember: the form stayed busy after naming: ${JSON.stringify(idle)}`);
    }

    // Quiet failures, on a meeting like the standing one.
    {
      await stage({ records: standing("weekly-sync"), run: `${notes("weekly-sync", "Weekly sync")}\n${learns("christoph", "Christoph", "4be07c19a2f1", CHRISTOPH)}`, record: true });
      const recorded = await start("Weekly sync", ["Lorentz"]);
      await until((p) => window.minutes.current?.path === p && document.querySelector('.speaker[data-name="Lorentz"]'), SUMMARY("weekly-sync"));
      await write("/tmp/standin/mode", "fail");
      const files = await kp("files", SUMMARY("weekly-sync"));
      await page.click('.speaker[data-name="Lorentz"] .speaker-not');
      await page.fill('.speaker[data-name="Lorentz"] input[data-not]', "Ada");
      await page.click("#speakers > .primary");
      const refused = await until(() => !window.minutes.choosing && document.querySelector("#speakers-said").textContent.includes("Lorentz has no clip ffff"));
      await idle();
      const unrenamed = JSON.stringify(await kp("files", SUMMARY("weekly-sync"))) === JSON.stringify(files);
      const terminal = await page.evaluate(() => window.terminalText().includes("Lorentz has no clip ffff"));
      const overruleNotes = await kp("notes");
      await page.fill('.speaker[data-name="Lorentz"] input[data-not]', "");
      await page.fill('.speaker[data-label="Speaker B"] input[data-label]', "Syrus");
      await page.check("#remember");
      await page.click("#speakers > .primary");
      const short = await until(() => !window.minutes.choosing && !window.minutes.saving && document.querySelector("#speakers-said").textContent.includes("clip too short") &&
        window.minutes.current?.transcript.includes("[0:09] Syrus: …"));
      const named = (await kp("files", SUMMARY("weekly-sync")))?.transcript.includes("[0:09] Syrus: …");
      const rememberNotes = await kp("notes");
      // The keepers fail: a Send that learns a voice, then a Send that fails.
      await page.evaluate(() => {
        const m = window.minutes;
        window.kpTakes = [];
        window.kpKeeps = 0;
        m.voices.put = async () => false;
        m.voices.take = async () => {
          window.kpTakes.push(Boolean(m.jobs[0]?.agentEndAt));
          return false;
        };
        m.segments.keep = async () => {
          window.kpKeeps += 1;
          return false;
        };
      });
      const learned = (await kp("kept", SUMMARY("weekly-sync")))?.learned;
      const lines = await page.evaluate(() => window.terminalText().split("could not be put on the machine").length);
      await stage({ records: [{ type: "chat", id: "standin-weekly-sync" }, ...remembered("Grace: clip 0a0b0c0d0e0f added (unconfirmed)"), filed("weekly-sync")] });
      let jobs = await kp("jobs");
      await page.evaluate(() => window.minutes.answer("Grace was there too."));
      const learnt = await until((n) => window.minutes.jobs.length > n && window.minutes.jobs[0].done, jobs);
      const quiet = { notes: await kp("notes"), keeps: await page.evaluate(() => window.kpKeeps), learned: (await kp("kept", SUMMARY("weekly-sync")))?.learned };
      const sends = (await agentCalls()).length;
      await stage({ records: [{ type: "error", message: "standin: the provider is unavailable" }] });
      jobs = await kp("jobs");
      await page.evaluate(() => window.minutes.answer("Are you there?"));
      const failed = await until((n) => window.minutes.jobs.length > n && window.minutes.jobs[0].done, jobs);
      await page.waitForSelector(".note.error", { timeout: 15_000 }).catch(() => {});
      const after = {
        started: (await agentCalls()).length - sends, takes: await page.evaluate(() => window.kpTakes), status: await page.evaluate(() => window.minutes.jobs[0].status),
        lines: (await page.evaluate(() => window.terminalText().split("could not be put on the machine").length)) - lines, notes: await kp("notes"),
      };
      const seen = { recorded, refused, unrenamed, terminal, overruleNotes, short, named, rememberNotes, learnt, quiet, after };
      console.log(`known people, quiet failures: ${JSON.stringify(seen)}`);
      if (!recorded || !refused || !unrenamed || !terminal || overruleNotes.length !== 0) fail("quiet failures: a failed overrule did not show in #speakers-said and the terminal alone, or renamed the files");
      if (!short || !named || rememberNotes.length !== 0) fail("quiet failures: a refused clip did not show in #speakers-said, or the names were not saved, or a note went up");
      if (!learnt || quiet.notes.length !== 0 || quiet.keeps !== 1 || JSON.stringify(quiet.learned) !== JSON.stringify(learned)) fail("quiet failures: a keeper that failed put up a note or changed what was kept");
      if (!failed || after.started !== 1 || after.status === 0 || after.takes.length !== 2 || !after.takes.every(Boolean) || after.lines < 2 ||
        JSON.stringify(after.notes) !== '["The agent stopped with an error"]') {
        fail("quiet failures: a failed put stopped the run, take did not run after it, the terminal had no line about the library, or a note other than the failed run's went up");
      }
      await page.evaluate(() => {
        const m = window.minutes;
        delete m.voices.put;
        delete m.voices.take;
        delete m.segments.keep;
        m.dismissAll();
      });
      await sh("rm -f /tmp/standin/mode");
    }

    // A row of two clips: its rename is saved only when both overrules succeed, and what happened is told only
    // on the meeting it was chosen on (record.10, record.13).
    twoClips: {
      await stage({ records: [{ type: "chat", id: "standin-two-clips" }, ...transcribed(`${JSON.stringify(HEARD_TWO, null, 2)}\n`), filed("two-clips")], run: notes("two-clips", "Two clips"), record: true });
      const recorded = await start("Two clips", ["Lorentz"]);
      // The review drawn for this meeting, not the one before it, which has a Lorentz row too.
      const reviewed = () => until((p) => window.minutes.current?.path === p && window.minutes.reviewing?.path === p &&
        document.querySelector('.speaker[data-name="Lorentz"]'), SUMMARY("two-clips"));
      const shown = await reviewed();
      const files = await kp("files", SUMMARY("two-clips"));
      const weekly = await kp("files", SUMMARY("weekly-sync"));
      // A page turn's copy of the sheet before it holds a Lorentz row too, with what was typed there.
      const not = async (to) => {
        await until(() => !document.querySelector(".page-turn"));
        if (!(await page.$('.speaker[data-name="Lorentz"] input[data-not]'))) await page.click('.speaker[data-name="Lorentz"] .speaker-not');
        await page.fill('.speaker[data-name="Lorentz"] input[data-not]', to);
        await page.click("#speakers > .primary");
      };
      // After each voices command the user has the weekly sync open.
      const leave = () => page.evaluate((p) => {
        const m = window.minutes;
        const run = m.voicesRun;
        m.voicesRun = async function (...args) {
          const result = await run.apply(this, args);
          if (m.current?.path !== p) await m.open(m.meetings.find((x) => x.path === p));
          return result;
        };
      }, SUMMARY("weekly-sync"));
      const stay = () => page.evaluate(() => delete window.minutes.voicesRun);
      const told = (text) => page.evaluate((t) => window.terminalText().split(t).length - 1, text);
      const overrules = ["audio voices list lorentz 9f3c2a1b0d4e overrule", "audio voices list lorentz 1a7d0f23c9b8 overrule"];
      const NOT_RENAMED = "Lorentz is not renamed Ada: overruling lorentz/1a7d0f23c9b8 failed.";
      const NOT_SAVED = "Not saved in the notes, as the meeting was closed: Lorentz as Ada.";

      // One overrule of the row refused: both files stay, and the review says which clip failed.
      await write("/tmp/standin/refuse", "1a7d0f23c9b8\n");
      let calls = (await voicesCalls()).length;
      await not("Ada");
      const refused = await until((t) => !window.minutes.choosing && !window.minutes.saving && document.querySelector("#speakers-said").textContent.includes(t), NOT_RENAMED);
      const partly = { refused, made: (await voicesCalls()).slice(calls).map((c) => c.args.join(" ")), said: await kp("said"), notes: await kp("notes") };
      const kept = JSON.stringify(await kp("files", SUMMARY("two-clips"))) === JSON.stringify(files);
      console.log(`known people, a row of two clips, one refused: ${JSON.stringify({ recorded, shown, ...partly, kept })}`);
      if (!recorded || !shown || JSON.stringify(partly.made) !== JSON.stringify(overrules) || !partly.refused || !kept || partly.said.includes("9f3c2a1b0d4e failed") ||
        partly.notes.length !== 0) {
        fail("a row of two clips: one refused overrule did not keep both files unrenamed, or the review did not say which clip failed");
        break twoClips;
      }

      // The same with the weekly sync opened meanwhile: nothing is said there, the terminal tells it.
      let before = await told(NOT_RENAMED);
      calls = (await voicesCalls()).length;
      await leave();
      await not("Ada");
      const away = await until((p) => !window.minutes.choosing && window.minutes.current?.path === p, SUMMARY("weekly-sync"));
      await idle();
      const elsewhere = { away, made: (await voicesCalls()).slice(calls).length, said: await kp("said"), told: (await told(NOT_RENAMED)) - before, notes: await kp("notes") };
      await stay();
      console.log(`known people, a row of two clips, another meeting opened: ${JSON.stringify(elsewhere)}`);
      if (!elsewhere.away || elsewhere.made !== 2 || /renamed|has no clip/.test(elsewhere.said) || elsewhere.told !== 1 || elsewhere.notes.length !== 0) {
        fail("a row of two clips: a failure was said on the meeting opened meanwhile, or not on the terminal");
      }

      // Both overrules succeed with the weekly sync opened meanwhile: neither meeting is renamed, and the terminal says the rename was not saved.
      await sh("rm -f /tmp/standin/refuse");
      await page.evaluate((p) => window.minutes.open(window.minutes.meetings.find((m) => m.path === p)), SUMMARY("two-clips"));
      const back = await reviewed();
      before = await told(NOT_SAVED);
      calls = (await voicesCalls()).length;
      await leave();
      await not("Ada");
      const left = await until((p) => !window.minutes.choosing && window.minutes.current?.path === p, SUMMARY("weekly-sync"));
      await idle();
      const closed = { left, made: (await voicesCalls()).slice(calls).map((c) => c.args.join(" ")), said: await kp("said"), told: (await told(NOT_SAVED)) - before, notes: await kp("notes") };
      await stay();
      const untouched = JSON.stringify(await kp("files", SUMMARY("two-clips"))) === JSON.stringify(files) &&
        JSON.stringify(await kp("files", SUMMARY("weekly-sync"))) === JSON.stringify(weekly);
      console.log(`known people, a row of two clips, not saved: ${JSON.stringify({ back, ...closed, untouched })}`);
      if (!back || !closed.left || JSON.stringify(closed.made) !== JSON.stringify(overrules) || /Not saved|renamed/.test(closed.said) || closed.told !== 1 || !untouched ||
        closed.notes.length !== 0) {
        fail("a row of two clips: overrules that ran without their rename being saved were not told on the terminal alone, or a meeting was renamed");
      }
    }

    // Other renames: a transcript row's speaker, then Penelope's corrections; neither overrules.
    {
      const calls = (await voicesCalls()).length;
      const ready = await open("weekly-sync");
      await page.evaluate(() => {
        const row = [...document.querySelectorAll("#transcript [data-line]")].find((r) => r.querySelector(".utt-who")?.textContent.includes("Lorentz"));
        window.minutes.proof.reassign(row, "Ada");
      });
      await page.click("#fixes-save");
      const row = await until(() => !window.minutes.saving && !window.minutes.fixes?.count && window.minutes.current?.transcript.includes("[0:00] Ada: …"));
      await stage({ records: [{ type: "reply", text: JSON.stringify({ say: "Syrus is Grace: I wrote her in.", mood: "glad" }) }], run: "sed -i 's/\\] Syrus:/] Grace:/' transcript.md" });
      const her = await askPenelope(page, "Syrus is Grace");
      await page.click("#penelope-close");
      const proposed = await page.evaluate(() => window.minutes.fixes?.count ?? 0);
      if (proposed) await page.click("#fixes-save");
      const penelope = await until(() => !window.minutes.saving && !window.minutes.fixes?.count && window.minutes.current?.transcript.includes("[0:09] Grace: …"));
      const made = (await voicesCalls()).slice(calls).map((c) => c.args.join(" "));
      console.log(`known people, other renames: ${JSON.stringify({ ready, row, answered: her.answered, proposed, penelope, made })}`);
      if (!ready || !row || !her.answered || !proposed || !penelope) fail("other renames: a row's speaker or Penelope's correction was not saved");
      if (made.length !== 0) fail(`other renames: a rename outside the review ran a voices command: ${JSON.stringify(made)}`);
    }
  } finally {
    await page.evaluate((b) => {
      const m = window.minutes;
      Object.assign(m.config, { profile: b.profile, env: b.env });
      m.config.query = () => "tool_audio_sources tool_audio_record tool_audio_transcribe";
      if (b.path === null) m.env.delete("PATH");
      else m.env.set("PATH", b.path);
      m.dismissAll();
      m.show("record");
    }, before);
    await sh('rm -rf /tmp/standin "$(clai confdir)/voices"');
    await kp("empty");
  }
}

// Failure reports (phase 3): what the app's own runs left in their run logs.
const logFail = (name, why) => {
  console.error(`\nFAIL: ${name}: ${why}`);
  process.exitCode = 1;
};

// E1 and E8: no log the page holds has a planted secret, a bearer token or the mock model's words.
async function checkLogsClean(page, when, planted) {
  const found = await page.evaluate((planted) => {
    const m = window.minutes;
    const rows = m.runlog.list();
    const hits = [];
    for (const row of rows) {
      const text = m.runlog.text(row.job) ?? "";
      for (const value of planted) if (text.includes(value)) hits.push(`${row.kind}: ${value}`);
      const bearer = /Bearer (?!‹secret)\S+/.exec(text);
      if (bearer) hits.push(`${row.kind}: ${bearer[0]}`);
      for (const said of ["done after tool for", "mock transcription"]) if (text.includes(said)) hits.push(`${row.kind}: model output "${said}"`);
    }
    return { logs: rows.length, kinds: [...new Set(rows.map((r) => r.kind))], hits };
  }, planted);
  console.log(`the run logs, no secret (${when}): ${JSON.stringify(found)}`);
  if (found.logs === 0 || found.hits.length > 0) logFail("the run logs, no secret", `${when}: a log held a secret or model output, or no log was kept: ${JSON.stringify(found.hits)}`);
}

// Record's log: whole, clean, at debug, with no model output, and its debug records off the terminal (report.5–.8, .10).
async function checkRecordLog(page, terminalBefore) {
  await page.waitForFunction(() => window.minutes.recording?.done, null, { timeout: 60_000 }).catch(() => {});
  await page.waitForFunction(() => window.minutes.runlog.list().some((r) => r.job === window.minutes.recording?.log && r.state !== "running"), null, { timeout: 10_000 }).catch(() => {});
  const log = await page.evaluate((from) => {
    const m = window.minutes;
    const r = m.recording;
    return {
      text: m.runlog.text(r.log) ?? "", row: m.runlog.list().find((x) => x.job === r.log), reply: r.reply,
      notes: document.querySelectorAll(".note").length, terminal: window.terminalText().slice(from),
    };
  }, terminalBefore);
  if (process.env.SHOW_RUNLOG) console.log(`Record's run log:\n${log.text}`);
  const has = (text) => log.text.includes(text);
  const seen = {
    state: log.row?.state, size: log.row?.size, lines: log.text.split("\n").length,
    head: /^Penelope run log\njob: Record\nmeeting: Daily sync\nstarted: \d{4}-.*\nended: \d{4}-.*\nresult: clean\npage build: .+\nclai: .+\nprofile: \/tmp\/meeting.json\nprovider: .+\nbrowser: .+\n\n/.test(log.text),
    clai: /^clai: (.*)$/m.exec(log.text)?.[1],
    line: has("│ run Record: mkdir -p ~/notebook && cd ~/notebook && CLAI_MOCK_AUDIO_TRANSCRIBE_FILE=/tmp/mic.wav LOG_LEVEL=debug clai -json"),
    exec: /│ proc exec pid \d+ .*clai/.test(log.text), ffmpeg: /│ proc exec pid \d+ \S*ffmpeg /.test(log.text),
    debug: (log.text.match(/│ clai diagnostic debug /g) ?? []).length,
    tools: has("│ clai tool_call audio_record") && /│ clai tool_result audio_transcribe ok ‹\d+ chars›/.test(log.text),
    reply: /│ clai reply ‹\d+ chars›/.test(log.text), end: has("│ end Record: exit 0"),
    followUps: has("│ run Keep the recording:") && has("│ run Refresh:") && /│ page meetings ‹\d+ chars›/.test(log.text),
    modelOutput: (log.reply && has(log.reply)) || has("done after tool for") || has("mock transcription"),
    notes: log.notes, debugOnTerminal: /^debug \[/m.test(log.terminal),
  };
  console.log(`Minutes, Record's log: ${JSON.stringify(seen)}`);
  if (seen.state !== "clean" || !seen.head || !seen.line || !seen.exec || !seen.ffmpeg || seen.debug === 0 || !seen.tools || !seen.reply || !seen.end ||
    !seen.followUps || seen.modelOutput || seen.notes !== 0 || seen.debugOnTerminal) {
    logFail("Minutes, Record's log", "the log is not whole, clean and at debug, holds model output, a note went up, or a debug record reached the terminal");
  }
}

// The failure note of the run with no such model: its cause, Copy log and Download (report.1–.3).
async function checkFailedLog(page) {
  const cause = await page.textContent(".note.error .note-cause").catch(() => null);
  await page.evaluate(() => {
    window.copied = [];
    window.clipboardWrite = navigator.clipboard.writeText;
    Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async () => { throw new Error("refused"); } });
  });
  await page.click(".note.error .note-copy");
  const refused = await page.waitForFunction(() => !document.querySelector(".note.error .note-said")?.hidden, null, { timeout: 5_000 })
    .then(() => page.textContent(".note.error .note-said"), () => null);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (text) => { window.copied.push(text); } });
  });
  await page.click(".note.error .note-copy");
  const copied = await page.waitForFunction(() => document.querySelector(".note.error .note-copy")?.textContent === "Copied", null, { timeout: 5_000 }).then(() => true, () => false);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), page.click(".note.error .note-download")]);
  const saved = (await readFile(await download.path())).toString();
  const text = await page.evaluate(() => window.copied[0] ?? "");
  const seen = {
    cause, refused, copied, name: download.suggestedFilename(), same: saved === text, said: await page.isHidden(".note.error .note-said"),
    result: /^result: (.*)$/m.exec(text)?.[1], line: text.includes("│ run Answer: "), error: /│ clai error failed to create text querier.*no-such-model/.test(text),
    end: /│ end Answer: exit \d+\n/.test(text), note: text.includes("│ error: The agent stopped with an error"), key: text.includes("sk-test-not-a-key"),
  };
  console.log(`Minutes, a failed run's log: ${JSON.stringify(seen)}`);
  if (!/^Answer( · exit [1-9]\d*)?\n.*no-such-model/.test(cause ?? "") || refused !== "The log could not be copied." || !copied || !seen.said ||
    !/^penelope-\d{4}-\d\d-\d\dT\d\d-\d\dZ_answer\.log$/.test(seen.name) || !seen.same || seen.result !== "failed: The agent stopped with an error" ||
    !seen.line || !seen.error || !seen.end || !seen.note || seen.key) {
    logFail("Minutes, a failed run's log", "the note did not name the cause, say a refused copy, copy and download the log, or the log is not the failed run's");
  }
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: window.clipboardWrite }));
}

// E7 (report.9): the transcript goes to the first path that reads; with none, the note has the read's cause.
async function checkTranscriptPaths(page) {
  const seen = await page.evaluate(async () => {
    const m = window.minutes;
    const path = "meetings/summaries/2026-11-19T08-00Z_paths.md";
    const gone = "file:///home/user/notebook/meetings/summaries/2026-11-19T08-00Z_gone.md";
    const front = "---\ntitle: Paths\ndate: 2026-11-19T08:00:00Z\nduration: 1\n---\n";
    await m.writeFiles([[path, `${front}\nSummary.\n`], [path.replace("summaries", "transcripts"), front]], true, "Write a meeting");
    const log = m.openLog("Record", "Paths");
    const job = (wrote) => ({
      log, reply: `Filed: [${gone}](${gone})`, wrote: new Set(wrote), stages: new Set(),
      transcribed: { text: JSON.stringify([{ start: 0, end: 1, speaker: "A", text: "Hello paths." }]) },
    });
    const notes = () => [...document.querySelectorAll(".note.error")].map((el) => [el.querySelector("strong").textContent, el.querySelector(".note-cause")?.textContent ?? null, Boolean(el.querySelector(".note-copy"))]);
    await m.writeTranscript(job([`/home/user/notebook/${path}`]));
    const first = { notes: notes(), transcript: (await m.readMeeting(path, "Check", true))?.transcript ?? null };
    await m.writeTranscript(job([]));
    const second = notes();
    m.closeLog(log, true);
    const text = m.runlog.text(log);
    m.dismissAll();
    return { first, second, reads: (text.match(/│ run Read the meeting: /g) ?? []).length, filed: text.includes("│ run File the transcript: ") };
  });
  console.log(`the transcript's paths: ${JSON.stringify(seen)}`);
  const [title, cause, copy] = seen.second[0] ?? [];
  if (seen.first.notes.length !== 0 || !seen.first.transcript?.includes("Hello paths.") || seen.second.length !== 1 || title !== "The transcript could not be filed" ||
    !/^Read the meeting · exit 1\n/.test(cause ?? "") || !/No such file or directory/.test(cause ?? "") || !copy || seen.reads !== 3 || !seen.filed) {
    logFail("the transcript's paths", "the transcript was not filed at the path that reads, or the note of a meeting that cannot be read has no cause");
  }
}

// The peek's Run logs tab: the rows, newest first, and a row's download (report.4).
async function checkRunLogsTab(page) {
  await page.click("#peek");
  await page.click("[role=tab][data-tab=runlogs]");
  const rows = await page.evaluate(() => [...document.querySelectorAll("#runlogs .runlog")].map((li) => ({
    state: li.className.replace("runlog ", ""), when: li.querySelector(".runlog-when").textContent, what: li.querySelector(".runlog-what").textContent,
    how: li.querySelector(".runlog-how").textContent, size: li.querySelector(".runlog-size").textContent,
    red: getComputedStyle(li.querySelector(".runlog-how")).color, buttons: [...li.querySelectorAll("button")].map((b) => b.textContent).join(","),
  })));
  const shown = await page.evaluate(() => ({
    tab: document.querySelector("[role=tab][aria-selected=true]")?.dataset.tab,
    panel: document.querySelector(".panel.active")?.dataset.panel, none: document.querySelector("#runlogs-none").hidden,
    order: window.minutes.runlog.list().map((r) => r.started),
  }));
  const at = rows.findIndex((r) => r.what === "Record · Daily sync");
  const [download] = at < 0 ? [null] : await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }), page.click(`#runlogs .runlog:nth-child(${at + 1}) .runlog-download`, { timeout: 10_000 }),
  ]).catch(async (error) => {
    console.error(`the Run logs tab, download: ${error.message.split("\n")[0]} ${JSON.stringify(await page.evaluate((n) => {
      const b = document.querySelector(`#runlogs .runlog:nth-child(${n}) .runlog-download`);
      const box = b?.getBoundingClientRect();
      const top = box && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { box: box && [box.x, box.y, box.width, box.height], top: top?.className, said: b?.parentElement.querySelector(".runlog-said")?.textContent, view: [innerWidth, innerHeight] };
    }, at + 1))}`);
    return [null];
  });
  const name = download?.suggestedFilename() ?? null;
  console.log(`the Run logs tab: ${JSON.stringify({ ...shown, order: undefined, name, rows })}`);
  const paths = rows.find((r) => r.what === "Record · Paths");
  const answer = rows.find((r) => r.what === "Answer");
  if (shown.tab !== "runlogs" || shown.panel !== "runlogs" || !shown.none || shown.order.some((t, i) => i > 0 && t > shown.order[i - 1]) ||
    rows[0]?.what !== "Record · Paths" || paths?.how !== "failed: The transcript could not be filed" || paths.red !== "rgb(255, 138, 122)" ||
    answer?.how !== "failed: The agent stopped with an error" || rows[at]?.state !== "clean" || rows[at]?.how !== "clean" || !/^\d\d[:.]\d\d/.test(rows[at]?.when ?? "") ||
    !/ (B|KB|MB)$/.test(rows[at]?.size ?? "") || rows.some((r) => r.buttons !== "Copy,Download") ||
    !/^penelope-\d{4}-\d\d-\d\dT\d\d-\d\dZ_daily-sync-record\.log$/.test(name ?? "")) {
    logFail("the Run logs tab", "the tab does not list the kept logs newest first with how each ended, or a row's Download is not named for its run");
  }
  await page.click("#peek-close");
}

// Phase 2 (failure reports), close.1 and close.2: a second RunLog over the page's IndexedDB lists the newest ten logs, texts equal, the secret out.
// The open meeting's title renames it: a field in place, a correction on the post-it, saved in
// both notes' front matter and shown in the sidebar; Escape keeps the name.
async function checkRename(page) {
  const fail = (why) => {
    console.error(`\nFAIL: renaming a meeting: ${why}`);
    process.exitCode = 1;
  };
  const name = "Renamed: by the check";
  const path = await page.evaluate(async () => {
    const m = window.minutes;
    m.dismissAll?.();
    const meeting = m.meetings.find((x) => !x.path.includes("design-review")) ?? m.meetings[0];
    await m.open(meeting);
    return meeting.path;
  });
  await page.click("#meeting-title");
  const editing = await page.$("#meeting-title input.title-edit").then(Boolean);
  await page.fill("#meeting-title input.title-edit", "Not this name");
  await page.keyboard.press("Escape");
  const kept = await page.evaluate(() => ({ count: window.minutes.fixes.count, input: Boolean(document.querySelector("#meeting-title input")) }));
  await page.click("#meeting-title");
  await page.fill("#meeting-title input.title-edit", name);
  await page.keyboard.press("Enter");
  const pending = await page.evaluate(() => ({
    title: document.querySelector("#meeting-title").textContent,
    count: document.querySelector("#fixes-count").textContent,
  }));
  await page.click("#fixes-save");
  await page.waitForFunction(() => !window.minutes.saving && window.minutes.fixes.count === 0, null, { timeout: 30_000 });
  const saved = await page.evaluate(async (p) => {
    const m = window.minutes;
    const files = await m.readMeeting(p, "Read the meeting", true);
    const { parseNote } = await import("./minutes.js");
    return {
      summary: parseNote(files.summary).fields.title,
      transcript: parseNote(files.transcript).fields.title ?? null,
      listed: document.querySelector('.meeting[aria-current="true"] strong')?.textContent,
      shown: document.querySelector("#meeting-title").textContent,
    };
  }, path);
  console.log(`Minutes, rename: ${JSON.stringify({ editing, kept, pending, saved })}`);
  if (!editing) fail("a click on the title did not make it a field");
  if (kept.count !== 0 || kept.input) fail(`Escape left ${kept.count} corrections or the field open`);
  if (pending.title !== name || !/^[12] corrections?$/.test(pending.count)) fail(`before Save the title read ${JSON.stringify(pending.title)} and the post-it ${JSON.stringify(pending.count)}`);
  if (saved.summary !== name || (saved.transcript !== null && saved.transcript !== name)) fail(`the notes' titles are ${JSON.stringify(saved)}`);
  if (saved.listed !== name || saved.shown !== name) fail(`the sidebar shows ${JSON.stringify(saved.listed)} and the page ${JSON.stringify(saved.shown)}`);
}

// Without slivingdoc the notes are kept in this browser (notebookkeeper.js): a new tab, whose
// machine starts empty, lists the meetings the first tab filed, with their files back on its machine.
async function checkNotesOutliveReload(context, page, url) {
  const fail = (why) => {
    console.error(`\nFAIL: the notes kept in this browser: ${why}`);
    process.exitCode = 1;
  };
  const before = await page.evaluate(async () => ({
    connected: window.minutes.connected,
    listed: window.minutes.meetings.map((m) => m.path).sort(),
    kept: ((await window.minutes.notebook.all()) ?? []).map(([path]) => path),
    status: document.querySelector("#notebook-status").textContent,
  }));
  const tab = await context.newPage();
  try {
    await tab.goto(url);
    await tab.waitForFunction(() => document.querySelector("#app")?.dataset.phase === "ready", null, { timeout: 120_000 });
    const after = await tab.evaluate(async (path) => ({
      listed: window.minutes.meetings.map((m) => m.path).sort(),
      transcript: path ? await window.minutes.readMeeting(path, "Read the meeting", true).then((f) => f?.transcript.length ?? 0) : 0,
    }), before.listed.find((path) => before.kept.includes(path)));
    const seen = { ...before, kept: before.kept.length, after: after.listed, transcript: after.transcript };
    console.log(`Minutes, notes kept in this browser: ${JSON.stringify(seen)}`);
    // Meetings the checks wrote on the machine by hand were never filed, so only the kept ones come back.
    const kept = before.listed.filter((path) => before.kept.includes(path));
    if (before.connected) return fail("the run left slivingdoc connected, so nothing here was kept");
    if (kept.length === 0) return fail("no meeting the runs filed was kept");
    if (before.status !== "Notebook: in this browser") fail(`the sidebar says ${JSON.stringify(before.status)}`);
    if (JSON.stringify(after.listed) !== JSON.stringify(kept)) fail(`the new tab listed ${JSON.stringify(after.listed)}, want the kept ${JSON.stringify(kept)}`);
    if (!(after.transcript > 0)) fail("the new tab's machine has no transcript for the first kept meeting");
  } finally {
    await tab.close();
  }
}

async function checkRunLogKept(page) {
  const kept = await page.evaluate(async () => {
    const { RunLog, RUNLOGS_DB } = await import("./runlog.js");
    const secret = "sk-check-PLANTED-secret";
    const first = new RunLog({ indexedDB, secrets: () => [["OPENAI_API_KEY", secret]] });
    await first.ready;
    const stored = [];
    for (let i = 1; i <= 12; i++) {
      const job = `check-kept-${i}`;
      first.open(job, { started: i * 1000, kind: "Record", meeting: `Meeting ${i}` });
      first.attach(job, `minutes:Record#${i}`, "Record", `KEY=${secret} clai query`);
      first.ended(`minutes:Record#${i}`, i % 2);
      if (i % 2) first.noted(job, { level: "error", title: `Failed ${i}`, detail: "" });
      stored.push(await first.close(job));
    }
    const texts = first.list().map((r) => first.text(r.job));
    const second = new RunLog({ indexedDB, secrets: () => [] });
    await second.ready;
    const rows = second.list();
    const result = {
      stored: stored.every(Boolean),
      jobs: rows.map((r) => r.job.replace("check-kept-", "")).join(","),
      states: rows.map((r) => (r.state === "failed" ? r.failed : r.state)).slice(0, 2),
      earlier: rows.every((r) => r.earlier),
      same: rows.length === texts.length && rows.every((r, i) => second.text(r.job) === texts[i]),
      redacted: texts.every((t) => t.includes("KEY=‹secret: OPENAI_API_KEY› clai query")),
      leaked: rows.some((r) => second.text(r.job).includes(secret)),
    };
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(RUNLOGS_DB);
      request.onsuccess = request.onerror = request.onblocked = resolve;
    });
    return result;
  });
  console.log(`the run logs, kept: ${JSON.stringify(kept)}`);
  if (!kept.stored || kept.jobs !== "12,11,10,9,8,7,6,5,4,3" || kept.states.join() !== "clean,Failed 11" || !kept.earlier || !kept.same || !kept.redacted || kept.leaked) {
    console.error("\nFAIL: the run logs, kept: a second RunLog did not list the newest ten logs as they were closed, or one held the secret");
    process.exitCode = 1;
  }
}

// The lines and texts a run is made of, against web/goldens/run-lines.json (UPDATE_GOLDENS=1 writes it):
// with no names they stay byte for byte as they were before the known voices (worklogs/2026-11-18-penelope-known-voices, phase 6).
const GOLDEN = new URL("./goldens/run-lines.json", import.meta.url);
async function checkRunLines(page) {
  const lines = await page.evaluate(async (heard) => {
    const { DEFAULTS, peopleLine } = await import("./minutes.js");
    const { transcriptLines } = await import("./proofread.js");
    const m = window.minutes;
    const query = DEFAULTS.query("Daily sync", "Remote call with Ada and Grace", false);
    const bare = [{ start: 0, end: 8.2, speaker: "A", text: "Good morning." }, { start: 9, end: 15.5, speaker: "B", text: "Morning." }];
    const names = ["Lorentz", "Christoph"];
    const chat = "019a7c2e-4b1d-7f3a-9c2e-1d4b5a6f7e80";
    return {
      start: m.agentLine(query),
      "start-voices": m.agentLine(query, null, undefined, names),
      continue: m.agentLine("Ada is Speaker A", chat),
      "continue-voices": m.agentLine("Ada is Speaker A", chat, undefined, names),
      query,
      "query-voices": `${query}\n\n${peopleLine(names)}`,
      transcript: transcriptLines(JSON.stringify(bare)),
      "transcript-voices": transcriptLines(JSON.stringify(heard)),
    };
  }, HEARD);
  const text = `${JSON.stringify(lines, null, 2)}\n`;
  if (process.env.UPDATE_GOLDENS) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(new URL("./goldens/", import.meta.url), { recursive: true });
    await writeFile(GOLDEN, text);
    console.log(`run lines: wrote ${GOLDEN.pathname}`);
    return;
  }
  const want = await readFile(GOLDEN, "utf8").catch(() => null);
  console.log(`run lines: ${want === text ? "as the golden" : "differ from the golden"}`);
  if (want !== text) {
    console.error(`\nFAIL: the run lines differ from ${GOLDEN.pathname}: ${text}`);
    process.exitCode = 1;
  }
}

// The voice keeper (worklogs/2026-11-18-penelope-known-voices, phase 1): the kept library goes from
// minutes-voices to the machine's voices/ and back, adding only, in background runs of its own. The
// scenario empties minutes-voices' stores at its start and end and never deletes the database.
async function checkVoiceKeeper(page) {
  const fail = (why) => {
    console.error(`\nFAIL: the voice keeper: ${why}`);
    process.exitCode = 1;
  };
  await page.evaluate(async () => {
    const { VoiceKeeper } = await import("./voicekeeper.js");
    const { toBase64 } = await import("./recordings.js");
    let topics = 0;
    const sh = async (line, args = []) => {
      const topic = `voices-check-${++topics}`;
      const { status, body } = await window.minutes.run("Check the voices", `{ echo ${topic}; ${line}; } > /run/page/out`,
        { topic, followUp: true, background: true, args });
      return { status, body };
    };
    const V = `${(await sh("clai confdir")).body.trim()}/voices`;
    const clip = (size, seed) => {
      const bytes = new Uint8Array(size);
      let x = 2166136261;
      for (const c of seed) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0;
      for (let i = 0; i < size; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        bytes[i] = 32 + (x % 95);
      }
      return bytes;
    };
    const bytesOf = ([path, kind, data]) => (kind === "c" ? clip(data.size, data.seed ?? path) : new TextEncoder().encode(data));
    const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const snap = async () => {
      const { body } = await sh('shopt -s nullglob dotglob; V=$1; [ -d "$V" ] && echo dir; f=(); for x in "$V"/* "$V"/*/*; do [ -f "$x" ] && f+=("$x"); done; ' +
        'if [ ${#f[@]} -gt 0 ]; then printf "\\0"; sha256sum "${f[@]}"; printf "\\0"; wc -c "${f[@]}"; ' +
        'for x in "${f[@]}"; do case $x in */events.jsonl) printf "\\0%s\\n" "$x"; cat "$x";; esac; done; fi; :', [V]);
      const [head, sums = "", sizes = "", ...events] = (body ?? "").split("\0");
      const files = {};
      const rel = (path) => path.slice(V.length + 1);
      for (const m of sums.matchAll(/^([0-9a-f]{64})\s+\*?(.+)$/gm)) files[rel(m[2])] = { hash: m[1] };
      for (const m of sizes.matchAll(/^\s*(\d+)\s+(\/.+)$/gm)) if (files[rel(m[2])]) files[rel(m[2])].size = Number(m[1]);
      const texts = {};
      for (const e of events) texts[rel(e.slice(0, e.indexOf("\n")))] = e.slice(e.indexOf("\n") + 1);
      return { exists: head === "dir\n", files, events: texts };
    };
    const calls = [];
    const record = (label, line, options, forward = true) => {
      const size = line.length + (options.args ?? []).reduce((sum, a) => sum + a.length, 0);
      const call = { label, line, followUp: options.followUp, background: options.background, hint: "hint" in options, size, action: null };
      calls.push(call);
      if (!forward) return Promise.resolve({ status: 1, body: null });
      return window.minutes.run(label, line, options).then((result) => {
        call.action = result.action;
        return result;
      });
    };
    const listings = [];
    let keeper = null;
    let made = 0;
    window.vkc = {
      count: () => calls.length,
      calls: (from = 0) => calls.slice(from),
      made: () => made,
      listings: () => listings.splice(0),
      snap,
      fresh: () => sh('rm -rf "$1"', [V]),
      want: async (files) => Object.fromEntries(await Promise.all(files.filter((f) => f[1] !== "a").map(async (f) => [f[0], await hex(bytesOf(f))]))),
      lay: async (files) => {
        let args = [];
        const flush = async () => {
          if (!args.length) return;
          const { status } = await sh('V=$1; shift; while [ $# -gt 0 ]; do f=$V/$2; mkdir -p "${f%/*}" || exit; ' +
            'if [ "$1" = a ]; then printf %s "$3" | base64 -d >> "$f"; else printf %s "$3" | base64 -d > "$f"; fi || exit; shift 3; done', [V, ...args]);
          if (status !== 0) throw new Error(`laying the files exited with ${status}`);
          args = [];
        };
        for (const file of files) {
          const b64 = toBase64(bytesOf(file));
          if (args.reduce((sum, a) => sum + a.length, 0) + b64.length > 1_500_000) await flush();
          args.push(file[1] === "a" ? "a" : "w", file[0], b64);
        }
        await flush();
      },
      // Empties the kept library's stores; the database itself stays, as a keeper of the page may hold it.
      clear: async () => {
        if (!(await indexedDB.databases()).some((d) => d.name === "minutes-voices")) return;
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open("minutes-voices");
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const names = [...db.objectStoreNames];
        if (names.length) {
          await new Promise((resolve, reject) => {
            const tx = db.transaction(names, "readwrite");
            for (const name of names) tx.objectStore(name).clear();
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });
        }
        db.close();
      },
      // A new VoiceKeeper over the page's indexedDB: its run forwards to Minutes.run, or lists voices/
      // before each call from the second on, or answers exit 1 from the third call on, or to every call.
      keeper: (kind = "real") => {
        made = 0;
        const run = (label, line, options) => {
          made += 1;
          if (kind === "listing" && made > 1) return snap().then((s) => listings.push(s)).then(() => record(label, line, options));
          return record(label, line, options, kind === "real" || kind === "listing" || (kind === "fails-third" && made < 3));
        };
        keeper = new VoiceKeeper({ run, indexedDB });
      },
      call: async (name) => {
        try {
          return await keeper[name]();
        } catch (error) {
          return `rejected: ${error}`;
        }
      },
      both: (a, b) => Promise.all([window.vkc.call(a), window.vkc.call(b)]),
      // The first 48 bytes of each clip in `files`, as base64 and as text.
      slices: (files) => files.filter((f) => f[1] === "c").flatMap((f) => {
        const head = bytesOf(f).subarray(0, 48);
        return [toBase64(head), String.fromCharCode(...head)];
      }),
      world: async () => {
        const stored = {};
        for (let i = 0; i < localStorage.length; i++) stored[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
        const notebook = (await sh(`shopt -s globstar nullglob; cd ${window.minutes.config.notebook} 2>/dev/null || exit 0; ` +
          'for f in **; do [ -f "$f" ] && { printf "\\0%s\\n" "$f"; cat "$f"; }; done; :')).body;
        const dbs = (await indexedDB.databases()).map((d) => d.name).sort();
        const recordings = await new Promise((resolve) => {
          const r = indexedDB.open("minutes");
          r.onsuccess = () => {
            const q = r.result.transaction("recordings").objectStore("recordings").getAllKeys();
            q.onsuccess = () => {
              r.result.close();
              resolve(q.result);
            };
          };
          r.onerror = () => resolve(null);
        });
        return { stored, notebook, dbs, recordings };
      },
      shown: (slices) => {
        const log = window.hoodModel.log.map((e) => e.text).join("\n");
        const terminal = window.terminalText();
        return slices.filter((s) => log.includes(s) || terminal.includes(s)).length;
      },
      // The hood's process rows of the recorded runs from `from` on, each drawn as a click would: their text and tooltips.
      rows: (from) => {
        const hood = window.minutes.hood;
        const was = { action: hood.action, label: hood.label, command: hood.command, hint: hood.hint };
        const rows = [];
        for (const { action } of calls.slice(from)) {
          if (!action) continue;
          hood.ran("Check the voices", action, "");
          hood.render();
          for (const name of document.querySelectorAll("#hood-tree li .name")) rows.push(`${name.textContent}\n${name.title}`);
        }
        Object.assign(hood, was);
        hood.render();
        return rows;
      },
      notes: () => ({ notes: window.minutes.notes.size, status: document.querySelector("#status").textContent }),
    };
  });
  const vk = (name, ...args) => page.evaluate(([n, a]) => window.vkc[n](...a), [name, args]);
  const line = (e) => `${JSON.stringify(e)}\n`;
  const event = (id, at, kind, clip, extra = {}) => ({ id, at, event: kind, clip, ...extra });
  const added = (id, at, clip, status, source, seconds) => event(id, at, "added", clip, { status, source, seconds });
  const LORENTZ = [
    added("5a1f0c9e2b7d4a63", "2026-11-18T09:12:44.120394Z", "9f3c2a1b0d4e", "confirmed", "voices add", 8.4),
    added("0c44e1a97f20b3d8", "2026-11-24T16:02:10Z", "1a7d0f23c9b8", "unconfirmed", "audio_remember_voice", 9.7),
    event("77b0d2c4e19a5f06", "2026-11-25T10:00:03Z", "placed", "9f3c2a1b0d4e", { landed: true }),
    event("4d2e8f0a1b3c5d79", "2026-11-25T10:00:03Z", "placed", "e81d5530c6a9", { landed: false }),
    event("e3a9b6d0c1f24875", "2026-11-25T10:00:03Z", "named", "9f3c2a1b0d4e", { speakers: ["A"] }),
  ].map(line);
  const CHRISTOPH = [line(added("b1b2c3d4e5f60718", "2026-11-20T12:00:00Z", "4be07c19a2f1", "unconfirmed", "audio_remember_voice", 6.1))];
  const STANDING = [
    ["lorentz/voice.json", "t", '{"name":"Lorentz"}'],
    ["lorentz/9f3c2a1b0d4e.flac", "c", { size: 3000 }],
    ["lorentz/1a7d0f23c9b8.flac", "c", { size: 3100 }],
    ["lorentz/events.jsonl", "t", LORENTZ.join("")],
    ["christoph/voice.json", "t", '{"name":"christoph"}'],
    ["christoph/4be07c19a2f1.flac", "c", { size: 2900 }],
    ["christoph/events.jsonl", "t", CHRISTOPH.join("")],
  ];
  const PEOPLE = [
    { name: "christoph", slug: "christoph", clips: [{ id: "4be07c19a2f1", status: "unconfirmed", source: "audio_remember_voice", seconds: 6.1, added: "2026-11-20T12:00:00Z" }] },
    { name: "Lorentz", slug: "lorentz", clips: [
      { id: "9f3c2a1b0d4e", status: "confirmed", source: "voices add", seconds: 8.4, added: "2026-11-18T09:12:44.120394Z" },
      { id: "1a7d0f23c9b8", status: "unconfirmed", source: "audio_remember_voice", seconds: 9.7, added: "2026-11-24T16:02:10Z" },
    ] },
  ];
  const BIG = [
    ["bigby/voice.json", "t", '{"name":"Bigby"}'],
    ...[1, 2, 3, 4, 5, 6].map((i) => [`bigby/b1600000000${i}.flac`, "c", { size: 400_000 }]),
    ["bigby/events.jsonl", "t", [1, 2, 3, 4, 5, 6].map((i) => line(added(`b16000000000000${i}`, `2026-11-2${i}T08:00:00Z`, `b1600000000${i}`, "confirmed", "voices add", 12.5))).join("")],
  ];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const linesOf = (text = "") => text.split("\n").slice(0, -1).map((l) => `${l}\n`);
  // Every file of `want` (path to hash) is on the machine with that hash.
  const holds = (snap, want) => Object.entries(want).every(([path, hash]) => hash === undefined || snap.files[path]?.hash === hash);
  const layout = (snap) => Object.keys(snap.files).every((p) => /^[^./][^/]*\/(voice\.json|events\.jsonl|[0-9a-f]{12}\.flac)$/.test(p));
  // The round trip: the same files, each events.jsonl with the same lines, each ended by a newline.
  const sameLibrary = (a, b) => same(Object.keys(a.files).sort(), Object.keys(b.files).sort()) && Object.keys(a.files).every((p) => (p.endsWith("events.jsonl")
    ? same(linesOf(a.events[p]).sort(), linesOf(b.events[p]).sort()) && b.events[p].endsWith("\n")
    : a.files[p].hash === b.files[p].hash));
  // Kept and on the machine: the standing library, or `files`.
  const reset = async (files = STANDING) => {
    await vk("clear");
    await vk("fresh");
    await vk("lay", files);
    await vk("keeper");
    return vk("call", "take");
  };
  const start = await vk("world");
  try {
    await vk("clear");
    await vk("fresh");

    // empty
    await vk("keeper");
    let mark = await vk("count");
    const emptyPut = await vk("call", "put");
    const emptyRan = (await vk("count")) - mark;
    const emptyPeople = await vk("call", "people");
    const emptyTake = await vk("call", "take");
    const emptyAfter = await vk("snap");
    console.log(`the voice keeper, empty: ${JSON.stringify({ emptyPut, emptyRan, emptyPeople, emptyTake, exists: emptyAfter.exists })}`);
    if (emptyPut !== true || emptyRan !== 0 || !same(emptyPeople, []) || emptyTake !== true || emptyAfter.exists) {
      fail("empty: put ran a line or did not resolve true, people was not [], take did not resolve true, or voices/ appeared");
    }

    // round trip
    await vk("lay", STANDING);
    const tripTake = await vk("call", "take");
    const tripBefore = await vk("snap");
    const tripPeople = await vk("call", "people");
    await vk("fresh");
    await vk("keeper");
    mark = await vk("count");
    const tripFresh = await vk("call", "people");
    const peopleRan = (await vk("count")) - mark;
    const tripPut = await vk("call", "put");
    const tripAfter = await vk("snap");
    const tripLater = await vk("call", "people");
    console.log(`the voice keeper, round trip: ${JSON.stringify({ tripTake, tripPut, peopleRan, files: Object.keys(tripAfter.files).length })}`);
    if (tripTake !== true || tripPut !== true || !sameLibrary(tripBefore, tripAfter) || !layout(tripAfter)) {
      fail("round trip: the library a take kept did not come back byte for byte on a fresh machine");
    }
    if (!same(tripPeople, PEOPLE) || !same(tripFresh, PEOPLE) || !same(tripLater, PEOPLE) || peopleRan !== 0) {
      fail(`round trip: people was not the standing library before and after the put, or ran a line: ${JSON.stringify(tripLater)}`);
    }

    // put adds only
    const OTHER = line(event("c0c0c0c0c0c0c0c0", "2026-11-26T09:00:00Z", "overruled", "9f3c2a1b0d4e"));
    const MACHINE = [
      ["lorentz/voice.json", "t", '{"name":"LORENTZ"}'],
      ["lorentz/9f3c2a1b0d4e.flac", "c", { size: 3000, seed: "another writer" }],
      ["lorentz/events.jsonl", "t", LORENTZ[0] + OTHER],
      ["lorentz/.aaaaaaaaaaaa.flac.tmp", "c", { size: 500 }],
      ["syrus/voice.json", "t", '{"name":"Syrus"}'],
      ["syrus/5e5e5e5e5e5e.flac", "c", { size: 1000 }],
      ["syrus/events.jsonl", "t", line(added("5e5e5e5e5e5e5e5e", "2026-11-22T08:00:00Z", "5e5e5e5e5e5e", "confirmed", "voices add", 3))],
    ];
    await vk("fresh");
    await vk("lay", MACHINE);
    const addBefore = await vk("snap");
    const addPut = await vk("call", "put");
    const addMid = await vk("snap");
    const addPut2 = await vk("call", "put");
    const addAfter = await vk("snap");
    const standing = await vk("want", STANDING);
    const kept = Object.entries(addBefore.files).filter(([p]) => p !== "lorentz/events.jsonl").every(([p, f]) => addMid.files[p]?.hash === f.hash);
    const appended = linesOf(addMid.events["lorentz/events.jsonl"]);
    const order = same(appended.slice(0, 2), [LORENTZ[0], OTHER]) && same(appended.slice(2).sort(), LORENTZ.slice(1).sort());
    const lacked = ["lorentz/1a7d0f23c9b8.flac", "christoph/voice.json", "christoph/4be07c19a2f1.flac"].every((p) => addMid.files[p]?.hash === standing[p]) &&
      same(linesOf(addMid.events["christoph/events.jsonl"]), CHRISTOPH);
    const extra = Object.keys(addMid.files).length === Object.keys(addBefore.files).length + 4;
    console.log(`the voice keeper, put adds only: ${JSON.stringify({ addPut, addPut2, kept, order, lacked, extra, again: same(addMid, addAfter) })}`);
    if (addPut !== true || addPut2 !== true || !kept || !order || !lacked || !extra || !same(addMid, addAfter)) {
      fail("put adds only: a put rewrote, deleted or appended again what the machine held, missed what it lacked, or a second put changed a file");
    }

    // take adds only
    const HALF = line(event("d1d1d1d1d1d1d1d1", "2026-11-27T08:00:00Z", "confirmed", "e81d5530c6a9"));
    const E81 = line(added("e8e8e8e8e8e8e8e8", "2026-11-26T10:00:00Z", "e81d5530c6a9", "unconfirmed", "audio_remember_voice", 5));
    await vk("fresh");
    await vk("lay", [
      ...STANDING.filter(([p]) => !["lorentz/voice.json", "lorentz/9f3c2a1b0d4e.flac", "lorentz/events.jsonl"].includes(p)),
      ["lorentz/voice.json", "t", '{"name":"LORENTZ"}'],
      ["lorentz/9f3c2a1b0d4e.flac", "c", { size: 3000, seed: "another writer" }],
      ["lorentz/e81d5530c6a9.flac", "c", { size: 2000 }],
      ["lorentz/.bbbbbbbbbbbb.flac.tmp", "c", { size: 700 }],
      ["lorentz/notes.txt", "t", "not part of the library\n"],
      [".trash/voice.json", "t", '{"name":"Trash"}'],
      [".trash/0123456789ab.flac", "c", { size: 600 }],
      ["lorentz/events.jsonl", "t", LORENTZ.join("") + E81 + HALF.slice(0, 30)],
    ]);
    const takeTake = await vk("call", "take");
    await vk("fresh");
    const takePut = await vk("call", "put");
    const takeAfter = await vk("snap");
    const e81 = (await vk("want", [["lorentz/e81d5530c6a9.flac", "c", { size: 2000 }]]))["lorentz/e81d5530c6a9.flac"];
    const firstKept = holds(takeAfter, { ...standing, "lorentz/events.jsonl": undefined }) && takeAfter.files["lorentz/e81d5530c6a9.flac"]?.hash === e81;
    const takeLines = linesOf(takeAfter.events["lorentz/events.jsonl"]);
    const onlyLines = same(takeLines.slice().sort(), [...LORENTZ, E81].sort());
    const skipped = layout(takeAfter);
    const unconfirmed = (await vk("call", "people")).find((p) => p.slug === "lorentz")?.clips.find((c) => c.id === "e81d5530c6a9")?.status;
    await vk("lay", [["lorentz/events.jsonl", "a", HALF]]);
    const takeAgain = await vk("call", "take");
    const confirmed = (await vk("call", "people")).find((p) => p.slug === "lorentz")?.clips.find((c) => c.id === "e81d5530c6a9")?.status;
    console.log(`the voice keeper, take adds only: ${JSON.stringify({ takeTake, takePut, firstKept, onlyLines, skipped, unconfirmed, takeAgain, confirmed })}`);
    if (takeTake !== true || takePut !== true || takeAgain !== true || !firstKept || !onlyLines || !skipped || unconfirmed !== "unconfirmed" || confirmed !== "confirmed") {
      fail("take adds only: a take replaced a kept file, kept a .-name, notes.txt or an unfinished line, dropped a line, or missed the line once complete");
    }

    // two writers
    await reset();
    const twoPut = await vk("call", "put");
    const A = [["lorentz/a0a0a0a0a0a1.flac", "c", { size: 2500 }], ["lorentz/events.jsonl", "a",
      line(added("a0a0a0a0a0a0a0a1", "2026-11-28T08:00:00Z", "a0a0a0a0a0a1", "unconfirmed", "audio_remember_voice", 7))]];
    const B = [
      ["ada/voice.json", "t", '{"name":"Ada"}'],
      ["ada/ad0000000001.flac", "c", { size: 2200 }],
      ["ada/events.jsonl", "t", line(added("ad00000000000001", "2026-11-28T09:00:00Z", "ad0000000001", "unconfirmed", "audio_remember_voice", 4.2))],
      ["christoph/events.jsonl", "a", line(event("cc00000000000001", "2026-11-28T09:30:00Z", "confirmed", "4be07c19a2f1"))],
    ];
    await vk("lay", A);
    const first = await vk("both", "take", "put");
    await vk("lay", B);
    const second = await vk("both", "take", "take");
    const twoPeople = await vk("call", "people");
    await vk("fresh");
    const twoFresh = await vk("call", "put");
    const twoAfter = await vk("snap");
    const ab = await vk("want", [...A, ...B]);
    const bothKept = holds(twoAfter, ab) && [A[1], B[2], B[3]].every(([p, , l]) => linesOf(twoAfter.events[p]).includes(l));
    const listed = twoPeople.find((p) => p.slug === "lorentz")?.clips.some((c) => c.id === "a0a0a0a0a0a1") && twoPeople.some((p) => p.name === "Ada") &&
      twoPeople.find((p) => p.slug === "christoph")?.clips[0].status === "confirmed";
    console.log(`the voice keeper, two writers: ${JSON.stringify({ twoPut, first, second, twoFresh, bothKept, listed })}`);
    if (twoPut !== true || !same([...first, ...second, twoFresh], [true, true, true, true, true]) || !bothKept || !listed) {
      fail("two writers: a call in flight beside another lost a clip or a line of either writer, or did not resolve true");
    }

    // removed
    await reset();
    const REMOVED = line(event("7e7e7e7e7e7e7e7e", "2026-11-26T09:30:00Z", "removed", "1a7d0f23c9b8"));
    await vk("lay", [["lorentz/events.jsonl", "a", REMOVED]]);
    const remTake = await vk("call", "take");
    const remPeople = (await vk("call", "people")).find((p) => p.slug === "lorentz")?.clips.map((c) => c.id);
    await vk("fresh");
    const remPut = await vk("call", "put");
    const remAfter = await vk("snap");
    const remLines = linesOf(remAfter.events["lorentz/events.jsonl"]);
    const gone = !remAfter.files["lorentz/1a7d0f23c9b8.flac"] && remLines.includes(REMOVED) && remLines.includes(LORENTZ[1]);
    await vk("lay", [STANDING[2], ["lorentz/events.jsonl", "a", line(added("8a8a8a8a8a8a8a8a", "2026-11-27T09:00:00Z", "1a7d0f23c9b8", "unconfirmed", "audio_remember_voice", 9.7))]]);
    const backTake = await vk("call", "take");
    const backPeople = (await vk("call", "people")).find((p) => p.slug === "lorentz")?.clips.map((c) => c.id);
    await vk("fresh");
    const backPut = await vk("call", "put");
    const back = (await vk("snap")).files["lorentz/1a7d0f23c9b8.flac"]?.hash === standing["lorentz/1a7d0f23c9b8.flac"];
    console.log(`the voice keeper, removed: ${JSON.stringify({ remTake, remPeople, remPut, gone, backTake, backPeople, backPut, back })}`);
    if (remTake !== true || remPut !== true || !same(remPeople, ["9f3c2a1b0d4e"]) || !gone || backTake !== true || backPut !== true ||
      !same(backPeople, ["9f3c2a1b0d4e", "1a7d0f23c9b8"]) || !back) {
      fail("removed: a removed clip's audio stayed kept, its event lines were dropped, or the clip added again was not taken again");
    }

    // big library
    const bigTake = await reset(BIG);
    await vk("fresh");
    mark = await vk("count");
    const bigPut = await vk("call", "put");
    const bigRuns = (await vk("calls", mark)).length;
    const big = await vk("want", BIG);
    const bigWhole = holds(await vk("snap"), big);
    await vk("fresh");
    await vk("keeper", "listing");
    const listedPut = await vk("call", "put");
    const listings = await vk("listings");
    const clips = Object.entries(big).filter(([p]) => p.endsWith(".flac"));
    const neverPart = listings.length > 1 && listings.every((s) => clips.every(([p, hash]) => !s.files[p] || (s.files[p].hash === hash && s.files[p].size === 400_000)));
    const somePart = listings.some((s) => clips.some(([p]) => s.files[p]));
    console.log(`the voice keeper, big library: ${JSON.stringify({ bigTake, bigPut, bigRuns, bigWhole, listedPut, listings: listings.length, neverPart, somePart })}`);
    if (bigTake !== true || bigPut !== true || bigRuns < 3 || !bigWhole || listedPut !== true || !neverPart || !somePart) {
      fail("big library: a library over one run's arguments did not go over in several runs, or a clip stood under its name before it was whole");
    }

    // audio stays
    const before = await vk("world");
    mark = await vk("count");
    await reset();
    await vk("fresh");
    const putFrom = await vk("count");
    const stayPut = await vk("call", "put");
    const slices = await vk("slices", STANDING);
    const ran = await vk("calls", mark);
    const after = await vk("world");
    const inRuns = ran.some((c) => slices.some((s) => c.label.includes(s) || c.line.includes(s)) || c.hint);
    const inStore = slices.some((s) => JSON.stringify(after.stored).includes(s) || (after.notebook ?? "").includes(s));
    const shown = await vk("shown", slices);
    const puts = (await vk("calls", putFrom)).length;
    const rows = await vk("rows", putFrom);
    const inRows = slices.filter((s) => rows.some((r) => r.includes(s))).length;
    const dbs = same(after.dbs, [...new Set([...start.dbs, "minutes-voices"])].sort());
    console.log(`the voice keeper, audio stays: ${JSON.stringify({ stayPut, runs: ran.length, inRuns, inStore, shown, puts, rows: rows.length, inRows, dbs: after.dbs })}`);
    if (stayPut !== true || inRuns || inStore || shown || !same(before.stored, after.stored) || before.notebook !== after.notebook ||
      !dbs || !same(start.recordings, after.recordings)) {
      fail("audio stays: clip audio reached a run's label, line or hint, localStorage, the notebook, the terminal or the hood's log, or another database changed");
    }
    if (puts === 0 || rows.length < puts || inRows) fail("audio stays: clip audio reached the text or the tooltip of a put run's process row in the hood");

    // people
    await vk("clear");
    await vk("fresh");
    await vk("lay", [
      ...STANDING.filter(([p]) => p !== "lorentz/events.jsonl"),
      ["lorentz/events.jsonl", "t", [LORENTZ[3], LORENTZ[1], "\n", LORENTZ[4], '{"event":"added"}\n', LORENTZ[0], LORENTZ[1],
        line(added("f0f0f0f0f0f0f0f0", "2026-11-19T08:00:00Z", "f0f0f0f0f0f0", "confirmed", "voices add", 3)),
        line(event("c1c1c1c1c1c1c1c1", "2026-11-19T09:00:00Z", "confirmed", "c1c1c1c1c1c1")), LORENTZ[2]].join("")],
      ["ada/voice.json", "t", '{"name":"Ada"}'],
      ["ada/ad0000000001.flac", "c", { size: 2200 }],
      ["ada/events.jsonl", "t", line(added("ad00000000000001", "2026-11-21T10:00:00Z", "ad0000000001", "unconfirmed", "audio_remember_voice", 4.2)) +
        line(event("ad00000000000002", "2026-11-21T11:00:00Z", "confirmed", "ad0000000001"))],
      ["empty/voice.json", "t", '{"name":"Empty"}'],
      ["empty/e0e0e0e0e0e0.flac", "c", { size: 900 }],
      ["empty/events.jsonl", "t", line(added("e0e0e0e0e0e0e0e1", "2026-11-21T10:00:00Z", "e0e0e0e0e0e0", "confirmed", "voices add", 2)) +
        line(event("e0e0e0e0e0e0e0e2", "2026-11-22T10:00:00Z", "removed", "e0e0e0e0e0e0"))],
      ["nobody/0b0b0b0b0b0b.flac", "c", { size: 900 }],
      ["nobody/events.jsonl", "t", line(added("0b0b0b0b0b0b0b0b", "2026-11-21T10:00:00Z", "0b0b0b0b0b0b", "confirmed", "voices add", 2))],
      ["bad/voice.json", "t", '{"nom":"x"}'],
      ["bad/bad000000001.flac", "c", { size: 900 }],
      ["bad/events.jsonl", "t", line(added("bad0000000000001", "2026-11-21T10:00:00Z", "bad000000001", "confirmed", "voices add", 2))],
      // clai lower-cases a slug per rune (SlugOf.1): İ is i, and a final Σ is σ.
      ["ibrahim/voice.json", "t", '{"name":"İbrahim"}'],
      ["ibrahim/1b0000000001.flac", "c", { size: 900 }],
      ["ibrahim/events.jsonl", "t", line(added("1b00000000000001", "2026-11-21T10:00:00Z", "1b0000000001", "confirmed", "voices add", 3))],
      ["οδυσσευσ/voice.json", "t", '{"name":"ΟΔΥΣΣΕΥΣ"}'],
      ["οδυσσευσ/0d0000000001.flac", "c", { size: 900 }],
      ["οδυσσευσ/events.jsonl", "t", line(added("0d00000000000001", "2026-11-21T10:00:00Z", "0d0000000001", "confirmed", "voices add", 3))],
    ]);
    await vk("keeper");
    const peopleTake = await vk("call", "take");
    const people = await vk("call", "people");
    const ada = { name: "Ada", slug: "ada", clips: [{ id: "ad0000000001", status: "confirmed", source: "audio_remember_voice", seconds: 4.2, added: "2026-11-21T10:00:00Z" }] };
    const one = (name, slug, id) => ({ name, slug, clips: [{ id, status: "confirmed", source: "voices add", seconds: 3, added: "2026-11-21T10:00:00Z" }] });
    const want = [ada, PEOPLE[0], one("İbrahim", "ibrahim", "1b0000000001"), PEOPLE[1], one("ΟΔΥΣΣΕΥΣ", "οδυσσευσ", "0d0000000001")];
    console.log(`the voice keeper, people: ${JSON.stringify({ peopleTake, people: people.map((p) => `${p.name}:${p.clips.map((c) => `${c.id} ${c.status}`)}`) })}`);
    if (peopleTake !== true || !same(people, want)) {
      fail(`people: not exactly Ada, christoph, İbrahim, Lorentz and ΟΔΥΣΣΕΥΣ with their clips, statuses and order: ${JSON.stringify(people)}`);
    }

    // failed run
    await reset(BIG);
    await vk("fresh");
    const quiet = await vk("notes");
    await vk("keeper", "fails-third");
    const failedPut = await vk("call", "put");
    const putCalls = await vk("made");
    const failedSnap = await vk("snap");
    const whole = clips.every(([p, hash]) => !failedSnap.files[p] || failedSnap.files[p].hash === hash);
    await vk("keeper");
    const laterPut = await vk("call", "put");
    const laterWhole = holds(await vk("snap"), big);
    await reset([]);
    await vk("lay", STANDING);
    await vk("keeper", "fails-all");
    const failedTake = await vk("call", "take");
    const takeCalls = await vk("made");
    await vk("keeper");
    const laterTake = await vk("call", "take");
    const laterPeople = await vk("call", "people");
    await vk("fresh");
    const roundPut = await vk("call", "put");
    const round = holds(await vk("snap"), standing);
    const still = same(quiet, await vk("notes"));
    console.log(`the voice keeper, failed run: ${JSON.stringify({ failedPut, putCalls, whole, laterPut, laterWhole, failedTake, takeCalls, laterTake, roundPut, round, still })}`);
    if (failedPut !== false || putCalls !== 3 || !whole || laterPut !== true || !laterWhole || failedTake !== false || takeCalls !== 1 ||
      laterTake !== true || !same(laterPeople, PEOPLE) || roundPut !== true || !round || !still) {
      fail("failed run: a failed run did not resolve false at once, left a part-written clip under its name, put up a note, or lost what a later call finishes");
    }

    // every run: beside the others, followUp, and under 2 MiB
    const all = await vk("calls");
    const beside = all.every((c) => c.followUp === true && c.background === true);
    const largest = Math.max(...all.map((c) => c.size));
    console.log(`the voice keeper, its runs: ${JSON.stringify({ runs: all.length, beside, largest })}`);
    if (!beside) fail("two writers: a run of a put or a take was not a followUp, background run");
    if (largest >= 2_097_152) fail(`big library: a run's line and arguments held ${largest} bytes`);
  } finally {
    await vk("clear");
    await vk("fresh");
  }
}

// The segment keeper (worklogs/2026-11-18-penelope-known-voices, phase 2): a meeting's segments, naming
// and learned clips kept in minutes-segments by its summary path. The scenario empties the database's
// stores at its start and end and never deletes it, as a keeper of the page may hold it.
async function checkSegmentKeeper(page) {
  const fail = (why) => {
    console.error(`\nFAIL: the segment keeper: ${why}`);
    process.exitCode = 1;
  };
  await page.evaluate(async () => {
    const { SegmentKeeper } = await import("./segmentkeeper.js");
    const exists = async (name) => (await indexedDB.databases()).some((d) => d.name === name);
    const opened = (name) => new Promise((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    // Every store of `name` as [store, keys, values], or null when the database is not there.
    const stores = async (name) => {
      if (!(await exists(name))) return null;
      const db = await opened(name);
      try {
        return await Promise.all([...db.objectStoreNames].map((store) => new Promise((resolve, reject) => {
          const tx = db.transaction(store);
          const keys = tx.objectStore(store).getAllKeys();
          const values = tx.objectStore(store).getAll();
          tx.oncomplete = () => resolve([store, keys.result, values.result]);
          tx.onerror = () => reject(tx.error);
        })));
      } finally {
        db.close();
      }
    };
    const binary = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v) || v instanceof Blob ||
      (v !== null && typeof v === "object" && Object.values(v).some(binary));
    let keeper = new SegmentKeeper(indexedDB);
    let mark = null;
    window.skc = {
      keeper: () => {
        keeper = new SegmentKeeper(indexedDB);
      },
      keep: async (...args) => {
        try {
          return await keeper.keep(...args);
        } catch (error) {
          return `rejected: ${error}`;
        }
      },
      // A function in a segment: a value the browser cannot store.
      keepUnstorable: async (path, learned) => {
        try {
          return await keeper.keep(path, [{ start: 0, end: 1, text: "x", extra: () => {} }], null, learned);
        } catch (error) {
          return `rejected: ${error}`;
        }
      },
      get: async (path) => {
        try {
          return await keeper.get(path);
        } catch (error) {
          return `rejected: ${error}`;
        }
      },
      // The keys of each segment, as kept, and whether a time came back a number.
      shapes: async (path) => {
        const got = await keeper.get(path);
        return got && got.segments.map((s) => ({ keys: Object.keys(s), numbers: typeof s.start === "number" && typeof s.end === "number" }));
      },
      // get, then the first segment of what it gave changed in place, then get again.
      edited: async (path) => {
        const got = await keeper.get(path);
        got.segments[0].text = "changed";
        got.segments[0].start = 999;
        got.learned.push({ name: "Mallory", clip: "ffffffffffff" });
        return keeper.get(path);
      },
      dump: () => stores("minutes-segments"),
      binaries: async () => (await stores("minutes-segments"))?.some(([, keys, values]) => binary(keys) || binary(values)),
      clear: async () => {
        if (!(await exists("minutes-segments"))) return;
        const db = await opened("minutes-segments");
        const names = [...db.objectStoreNames];
        if (names.length) {
          await new Promise((resolve, reject) => {
            const tx = db.transaction(names, "readwrite");
            for (const name of names) tx.objectStore(name).clear();
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });
        }
        db.close();
      },
      world: async () => {
        const stored = {};
        for (let i = 0; i < localStorage.length; i++) stored[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
        const keys = async (name) => (await stores(name))?.map(([store, k]) => [store, k]) ?? null;
        const dbs = (await indexedDB.databases()).map((d) => d.name).filter((n) => n !== "minutes-segments").sort();
        return { stored, minutes: await keys("minutes"), voices: await keys("minutes-voices"), dbs };
      },
      notebook: async () => {
        const topic = `segments-check-${Math.random().toString(36).slice(2, 8)}`;
        const { body } = await window.minutes.run("Check the segments", `{ echo ${topic}; shopt -s globstar nullglob; ` +
          `cd ${window.minutes.config.notebook} 2>/dev/null && for f in **; do printf '%s\\n' "$f"; done; :; } > /run/page/out`,
        { topic, followUp: true, background: true });
        return body;
      },
      logMark: () => {
        mark = window.hoodModel.log.at(-1);
        return window.hoodModel.log.length;
      },
      logSame: () => window.hoodModel.log.at(-1) === mark,
      notes: () => ({ notes: window.minutes.notes.size, status: document.querySelector("#status").textContent }),
    };
  });
  const sk = (name, ...args) => page.evaluate(([n, a]) => window.skc[n](...a), [name, args]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const PATH = "meetings/summaries/2026-11-16T10-00Z_daily sync.md";
  const OTHER = "meetings/summaries/2026-11-17T09-00Z_standup.md";
  const SEGMENTS = [
    { start: 0, end: 8.2, speaker: "Lorentz", voice: { clip: "lorentz/9f3c2a1b0d4e", status: "confirmed" }, text: "…" },
    { start: 9, end: 15.5, speaker: "B", text: "…" },
    { start: 61.2, end: 69, speaker: "Syrus", voice: { clip: "syrus/4be07c19a2f1", status: "unconfirmed" }, text: "…" },
    { start: 70.25, end: 74.5, text: "and no one said it" },
  ];
  const NAMING = {
    status: "named",
    origin: "flag",
    speakers: [
      { label: "A", name: "Lorentz", voice: { clip: "lorentz/9f3c2a1b0d4e", status: "confirmed" } },
      { label: "B", reason: "no-match" },
    ],
    voices: [{ name: "Lorentz", result: "named" }, { name: "Ada", result: "unknown-voice" }],
  };
  const LEARNED = [{ name: "Christoph", clip: "4be07c19a2f1" }, { name: "Ada", clip: "e81d5530c6a9" }];
  const STANDING = { segments: SEGMENTS, naming: NAMING, learned: LEARNED };
  const PLAIN = [{ start: 0, end: 4.75, speaker: "A", text: "good morning" }, { start: 5, end: 9.1, speaker: "B", text: "morning" }];
  const keepStanding = () => sk("keep", PATH, SEGMENTS, NAMING, LEARNED);
  try {
    await sk("clear");

    // round trip
    const tripKeep = await keepStanding();
    const tripGet = await sk("get", PATH);
    await sk("keeper");
    const tripSecond = await sk("get", PATH);
    const shapes = await sk("shapes", PATH);
    const tripEdited = await sk("edited", PATH);
    const keysAsGiven = same(shapes?.map((s) => s.keys), SEGMENTS.map((s) => Object.keys(s))) && shapes.every((s) => s.numbers);
    console.log(`the segment keeper, round trip: ${JSON.stringify({ tripKeep, first: same(tripGet, STANDING), second: same(tripSecond, STANDING), keysAsGiven,
      edited: same(tripEdited, STANDING) })}`);
    if (tripKeep !== true || !same(tripGet, STANDING) || !same(tripSecond, STANDING) || !keysAsGiven || !same(tripEdited, STANDING)) {
      fail(`round trip: what came back was not the standing meeting as kept, by a second keeper too, or an edit of it changed what is kept: ${JSON.stringify(tripGet)}`);
    }

    // no voices
    const plainKeep = await sk("keep", OTHER, PLAIN, null, []);
    const plainGet = await sk("get", OTHER);
    console.log(`the segment keeper, no voices: ${JSON.stringify({ plainKeep, plainGet })}`);
    if (plainKeep !== true || !same(plainGet, { segments: PLAIN, naming: null, learned: [] })) {
      fail(`no voices: a run with no naming and nothing learned was not kept as given: ${JSON.stringify(plainGet)}`);
    }

    // replace
    const AGAIN = [{ start: 1.5, end: 3.25, speaker: "A", text: "once more" }];
    const NO_AGREEMENT = { status: "no-agreement", origin: "flag", speakers: [{ label: "A", reason: "no-agreement" }], voices: [{ name: "Lorentz", result: "no-agreement" }] };
    const UNION = [...LEARNED, { name: "Bo", clip: "0123456789ab" }];
    const againKeep = await sk("keep", PATH, AGAIN, NO_AGREEMENT, [{ name: "Bo", clip: "0123456789ab" }, { name: "Chris", clip: "4be07c19a2f1" }]);
    const againGet = await sk("get", PATH);
    const otherGet = await sk("get", OTHER);
    const thirdKeep = await sk("keep", PATH, AGAIN, null, []);
    const thirdGet = await sk("get", PATH);
    console.log(`the segment keeper, replace: ${JSON.stringify({ againKeep, againGet, other: same(otherGet, plainGet), thirdKeep, thirdGet })}`);
    if (againKeep !== true || !same(againGet, { segments: AGAIN, naming: NO_AGREEMENT, learned: UNION }) || !same(otherGet, plainGet) ||
      thirdKeep !== true || !same(thirdGet, { segments: AGAIN, naming: null, learned: UNION })) {
      fail("replace: a second keep did not replace the segments and naming while keeping every clip learned once, the earlier first, or touched another path");
    }

    // another browser's meeting
    await sk("clear");
    await keepStanding();
    const dumpBefore = await sk("dump");
    const never = await sk("get", "meetings/summaries/never.md");
    const dumpAfter = await sk("dump");
    console.log(`the segment keeper, another browser's meeting: ${JSON.stringify({ never, unchanged: same(dumpBefore, dumpAfter) })}`);
    if (never !== null || !same(dumpBefore, dumpAfter)) {
      fail("another browser's meeting: get of a path never kept did not resolve null, or changed the database");
    }

    // no audio
    const notebookBefore = await sk("notebook");
    const worldBefore = await sk("world");
    const logBefore = await sk("logMark");
    const audioKeep = await keepStanding();
    const audioGet = await sk("get", PATH);
    const binaries = await sk("binaries");
    const logAfter = await page.evaluate(() => window.hoodModel.log.length);
    const logSame = await sk("logSame");
    const worldAfter = await sk("world");
    const notebookAfter = await sk("notebook");
    console.log(`the segment keeper, no audio: ${JSON.stringify({ audioKeep, kept: same(audioGet, STANDING), binaries, log: [logBefore, logAfter, logSame],
      world: same(worldBefore, worldAfter), notebook: notebookBefore === notebookAfter })}`);
    if (audioKeep !== true || !same(audioGet, STANDING) || binaries !== false || logBefore !== logAfter || !logSame || !same(worldBefore, worldAfter) ||
      notebookBefore === null || notebookBefore !== notebookAfter) {
      fail("no audio: minutes-segments held a Blob, an ArrayBuffer or a typed array, or a keep wrote localStorage, another database, a file or ran on the machine");
    }

    // refused write
    await sk("clear");
    await keepStanding();
    const quiet = await sk("notes");
    const refused = await sk("keepUnstorable", PATH, [{ name: "Bo", clip: "0123456789ab" }]);
    await page.waitForTimeout(300);
    const after = await sk("notes");
    const refusedGet = await sk("get", PATH);
    console.log(`the segment keeper, refused write: ${JSON.stringify({ refused, quiet: same(quiet, after), kept: same(refusedGet, STANDING) })}`);
    if (refused !== false || !same(quiet, after) || !same(refusedGet, STANDING)) {
      fail(`refused write: a keep the browser refused did not resolve false, put up a note, or changed what was kept: ${JSON.stringify(refusedGet)}`);
    }
  } finally {
    await sk("clear");
  }
}

async function checkPeople(page) {
  const fail = (step) => {
    console.error(`\nFAIL: the people row: ${step}`);
    process.exitCode = 1;
  };
  await page.evaluate(async () => {
    const { People } = await import("./people.js");
    const person = (name) => ({
      name, slug: name.toLowerCase(), clips: [{ id: "0123456789ab", status: "confirmed", source: "voices add", seconds: 8, added: "2026-11-16T10:00:00Z" }],
    });
    const TRANSCRIPTS = {
      "a.md": "[0:00] Lorentz: good morning\n[0:04] Speaker B: morning\n[0:09] christoph: shall we start\n[0:12] Grace: yes\n",
      "c.md": "[0:00] Ada: hello\n",
    };
    const MEETINGS = [{ path: "a.md", title: "Daily sync" }, { path: "b.md", title: "Design review" }, { path: "c.md", title: "daily sync " }];
    let s = null;
    let row = null;
    let people = null;
    let release = null;
    const settled = (p) => p.then(() => "ok", (error) => `rejected: ${error}`);
    window.ppc = {
      // A fresh row over the standing seams.
      make: () => {
        row?.remove();
        s = { people: ["Ada", "Christoph", "Lorentz"], peopleFails: false, readFails: false, held: null, reads: [] };
        row = document.createElement("fieldset");
        document.body.append(row);
        people = new People({
          root: row,
          people: async () => {
            if (s.peopleFails) throw new Error("no library");
            return s.people?.map(person);
          },
          meetings: () => MEETINGS,
          read: async (path) => {
            s.reads.push(path);
            if (s.readFails) throw new Error("unreadable");
            if (path === s.held) await new Promise((resolve) => (release = resolve));
            return path in TRANSCRIPTS ? { summary: "", transcript: TRANSCRIPTS[path] } : null;
          },
        });
      },
      set: (key, value) => {
        s[key] = value;
      },
      show: () => settled(people.show()),
      title: (text) => settled(people.title(text)),
      tick: (names) => people.tick(names),
      click: (name) => row.querySelector(`input[value="${name}"]`).click(),
      reset: () => people.reset(),
      // title("Daily sync") with a.md held, title("Retro") before it resolves, then a.md let go.
      race: async () => {
        s.held = "a.md";
        release = null;
        const first = settled(people.title("Daily sync"));
        for (let i = 0; !release && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        const second = await settled(people.title("Retro"));
        release?.();
        return [await first, second];
      },
      state: () => {
        const boxes = [...row.querySelectorAll("input[type=checkbox]")];
        return {
          hidden: row.hidden,
          inputs: row.querySelectorAll("input").length,
          boxes: boxes.map((b) => [b.value, b.checked]),
          labelled: boxes.every((b) => b.labels[0]?.textContent.trim() === b.value),
          ticked: people.ticked(),
          reads: [...s.reads],
        };
      },
      world: () => {
        const stored = {};
        for (let i = 0; i < localStorage.length; i++) stored[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
        return {
          stored, notes: window.minutes.notes.size, noteEls: document.querySelectorAll(".note").length,
          status: document.querySelector("#status").textContent, log: window.hoodModel.log.length,
        };
      },
      cleanup: () => row?.remove(),
    };
  });
  const pp = (name, ...args) => page.evaluate(([n, a]) => window.ppc[n](...a), [name, args]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const none = (state) => state.boxes.every(([, checked]) => !checked);
  try {
    const before = await pp("world");

    // lists the library (show.1, ticked.1)
    await pp("make");
    const listed = await pp("show");
    const first = await pp("state");
    await pp("click", "Ada");
    await pp("set", "people", ["Ada", "Bo", "Lorentz"]);
    await pp("show");
    const redrawn = await pp("state");
    console.log(`the people row, lists the library: ${JSON.stringify({ listed, first, redrawn })}`);
    if (listed !== "ok" || first.hidden || !first.labelled || !same(first.boxes, [["Ada", false], ["Christoph", false], ["Lorentz", false]]) ||
      !same(redrawn.boxes, [["Ada", true], ["Bo", false], ["Lorentz", false]]) || !same(redrawn.ticked, ["Ada"])) {
      fail("lists the library: the row did not show Ada, Christoph, Lorentz unticked, or a redraw dropped the user's tick on Ada");
    }

    // empty library (show.2, title.3)
    await pp("make");
    await pp("set", "people", []);
    await pp("show");
    await pp("title", "Daily sync");
    const empty = await pp("state");
    console.log(`the people row, empty library: ${JSON.stringify(empty)}`);
    if (!empty.hidden || empty.inputs !== 0 || !same(empty.ticked, []) || empty.reads.length !== 0) {
      fail("empty library: the row showed, held an input, ticked someone, or read a meeting");
    }

    // pre-tick (title.1, title.3)
    await pp("make");
    await pp("show");
    await pp("title", " daily SYNC");
    const ticked = await pp("state");
    await pp("title", "Design review");
    const unread = await pp("state");
    await pp("title", "Retro");
    const untitled = await pp("state");
    console.log(`the people row, pre-tick: ${JSON.stringify({ ticked, unread, untitled })}`);
    if (!same(ticked.boxes, [["Ada", false], ["Christoph", true], ["Lorentz", true]]) || !same(ticked.ticked, ["Christoph", "Lorentz"]) ||
      !same(ticked.reads, ["a.md"]) || !none(unread) || !none(untitled) || !same(untitled.reads, ["a.md", "b.md"])) {
      fail("pre-tick: \" daily SYNC\" did not tick Christoph and Lorentz from a.md alone, or an unreadable or unfiled title kept ticks or read more");
    }

    // the user's ticks stay (title.2, ticked.1, reset.1)
    await pp("make");
    await pp("show");
    await pp("title", "Daily sync");
    await pp("click", "Lorentz");
    await pp("click", "Ada");
    await pp("title", "Retro");
    const retro = await pp("state");
    await pp("title", "Daily sync");
    const again = await pp("state");
    await pp("reset");
    const reset = await pp("state");
    await pp("title", "Daily sync");
    const fresh = await pp("state");
    console.log(`the people row, the user's ticks stay: ${JSON.stringify({ retro: retro.ticked, again: again.ticked, reset, fresh: fresh.ticked })}`);
    if (!same(retro.ticked, ["Ada"]) || !same(again.ticked, ["Ada", "Christoph"]) || !none(reset) || reset.boxes.length !== 3 ||
      !same(fresh.ticked, ["Christoph", "Lorentz"])) {
      fail("the user's ticks stay: a title re-ticked a box the user unticked or unticked one the user ticked, or reset() did not untick and forget");
    }

    // ticked for the people a meeting named, the user's ticks kept, nothing read (tick.1)
    await pp("make");
    await pp("show");
    await pp("tick", ["Lorentz", "Nobody"]);
    const named = await pp("state");
    await pp("click", "Ada");
    await pp("click", "Lorentz");
    await pp("tick", ["Christoph"]);
    const kept = await pp("state");
    console.log(`the people row, ticked for whom a meeting named: ${JSON.stringify({ named: named.ticked, kept: kept.ticked, reads: kept.reads })}`);
    if (!same(named.ticked, ["Lorentz"]) || !same(kept.ticked, ["Ada", "Christoph"]) || kept.reads.length !== 0) {
      fail("tick: it did not tick exactly the people named, overrode a box the user changed, or read a meeting");
    }

    // quiet (title.4, People.1)
    await pp("make");
    await pp("show");
    const race = await pp("race");
    const stale = await pp("state");
    await pp("set", "readFails", true);
    const unreadable = await pp("title", "Daily sync");
    const failedRead = await pp("state");
    await pp("set", "peopleFails", true);
    const failedShow = await pp("show");
    const noLibrary = await pp("state");
    await pp("set", "peopleFails", false);
    await pp("set", "people", undefined);
    const nothingShow = await pp("show");
    const nothing = await pp("state");
    await page.waitForTimeout(300);
    const after = await pp("world");
    console.log(`the people row, quiet: ${JSON.stringify({ race, stale: stale.ticked, unreadable, failedRead: failedRead.ticked, failedShow, noLibrary, nothingShow,
      nothing: nothing.hidden, world: same(before, after) })}`);
    if (!same(race, ["ok", "ok"]) || !none(stale) || unreadable !== "ok" || !none(failedRead) || !same(failedRead.reads, ["a.md", "a.md"]) ||
      failedShow !== "ok" || !noLibrary.hidden || noLibrary.inputs !== 0 || !same(noLibrary.ticked, []) || nothingShow !== "ok" || !nothing.hidden ||
      !same(before, after)) {
      fail(`quiet: the stale answer was applied, a call rejected, a failed library left the row up, or a note, status, localStorage or run changed: ${JSON.stringify([before, after])}`);
    }
  } finally {
    await pp("cleanup");
  }
}

async function checkReview(page) {
  const fail = (step) => {
    console.error(`\nFAIL: the voice review: ${step}`);
    process.exitCode = 1;
  };
  await page.evaluate(async () => {
    const { Review } = await import("./review.js");
    const { transcriptLines } = await import("./proofread.js");
    const { unknownSpeakers } = await import("./minutes.js");
    const PATH = "meetings/summaries/2026-11-16T10-00Z_daily-sync.md";
    const lorentz = { clip: "lorentz/e81d5530c6a9", status: "confirmed" };
    const SEGMENTS = [
      { start: 0, end: 8.2, speaker: "Lorentz", voice: lorentz, text: "Good morning, everyone, shall we start?" },
      { start: 9, end: 15.5, speaker: "B", text: "Morning. I have last week's numbers ready." },
      { start: 15.9, end: 18.4, speaker: "B", text: "They look better." },
      { start: 19.5, end: 21, speaker: "Lorentz", voice: lorentz, text: "Great." },
      { start: 21.2, end: 22, speaker: "B", text: "Yes." },
      { start: 61.2, end: 69, speaker: "Syrus", voice: { clip: "syrus/3d81f60a2b97", status: "unconfirmed" }, text: "I will take the release notes this time." },
      { start: 70, end: 84, speaker: "C", text: "Then I will write up the design review for Friday." },
      { start: 90, end: 91.5, speaker: "D", text: "Thanks, all." },
    ];
    const TRANSCRIPT = transcriptLines(JSON.stringify(SEGMENTS));
    const person = (name, ...clips) => ({
      name, slug: name.toLowerCase(), clips: clips.map(([id, status]) => ({ id, status, source: "voices add", seconds: 8, added: "2026-11-16T10:00:00Z" })),
    });
    // The standing state of the phase's Test cases, with what a step changes.
    const state = ({ path = PATH, christoph = "unconfirmed", kept = true, people = true, playable = true, busy = false, empty = false } = {}) => ({
      path,
      transcript: empty ? "" : TRANSCRIPT,
      unknown: empty ? [] : unknownSpeakers(TRANSCRIPT),
      kept: kept && !empty ? {
        segments: SEGMENTS,
        naming: { status: "named", origin: "flag", speakers: [], voices: [{ name: "Lorentz", result: "named" }, { name: "Ada", result: "unknown-voice" }] },
        learned: [{ name: "Christoph", clip: "4be07c19a2f1" }, { name: "Ada", clip: "0123456789ab" }],
      } : null,
      people: people ? [
        person("Christoph", ["4be07c19a2f1", christoph]),
        person("Lorentz", ["9f3c2a1b0d4e", "confirmed"], ["e81d5530c6a9", "confirmed"]),
        person("Syrus", ["3d81f60a2b97", "unconfirmed"]),
      ] : [],
      playable,
      busy,
    });
    let form = null;
    let review = null;
    let plays = [];
    let chosen = [];
    const who = (el) => el?.dataset.clip ?? el?.dataset.name ?? el?.dataset.label ?? null;
    // Shown inside the form: no element between it and the form is hidden.
    const shown = (el) => {
      for (let e = el; e && e !== form; e = e.parentElement) if (e.hidden) return false;
      return Boolean(el);
    };
    window.rvc = {
      make: () => {
        form?.remove();
        form = document.querySelector("#speakers").cloneNode(true);
        document.body.append(form);
        plays = [];
        chosen = [];
        review = new Review({
          root: form,
          play: (start, end, button) => plays.push({ start, end, row: who(button.closest(".speaker")), play: button.classList.contains("speaker-play") }),
          choose: (choices, names) => chosen.push([choices, names]),
        });
      },
      show: (options) => review.show(state(options)),
      said: (text) => review.said(text),
      type: (selector, text) => {
        const input = form.querySelector(selector);
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      click: (selector) => form.querySelector(selector).click(),
      submit: () => form.requestSubmit(),
      mark: (selector) => {
        form.querySelector(selector).dataset.marked = "1";
      },
      unknownC: () => unknownSpeakers(TRANSCRIPT).find((u) => u.label === "Speaker C"),
      state: () => ({
        hidden: form.hidden,
        playable: form.classList.contains("playable"),
        rows: [...form.querySelectorAll("#speaker-rows > .speaker")].map((r) => ({
          kind: r.dataset.clip ? "learned" : r.dataset.name ? "library" : "label",
          who: who(r),
          play: shown(r.querySelector(".speaker-play")),
          keep: shown(r.querySelector(".speaker-keep")),
          not: shown(r.querySelector(".speaker-not")),
          source: r.querySelector(".speaker-source")?.textContent ?? null,
          inputs: [...r.querySelectorAll("input")].filter(shown).map((i) => [i.dataset.not === undefined ? "label" : "not", i.value]),
          marked: r.dataset.marked === "1",
        })),
        remember: shown(form.querySelector("#remember")),
        button: shown(form.querySelector("button.primary")),
        said: shown(form.querySelector("#speakers-said")) ? form.querySelector("#speakers-said").textContent : "",
        role: form.querySelector("#speakers-said")?.getAttribute("role") ?? null,
        plays: [...plays],
        chosen: JSON.parse(JSON.stringify(chosen)),
      }),
      world: () => {
        const stored = {};
        for (let i = 0; i < localStorage.length; i++) stored[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
        return {
          stored, notes: window.minutes.notes.size, noteEls: document.querySelectorAll(".note").length,
          status: document.querySelector("#status").textContent, log: window.hoodModel.log.length,
        };
      },
      cleanup: () => form?.remove(),
    };
  });
  const rv = (name, ...args) => page.evaluate(([n, a]) => window.rvc[n](...a), [name, args]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const row = (state, name) => state.rows.find((r) => r.who === name);
  const PAIRS = [["Speaker B", "Christoph"], ["Speaker D", "Dana"]];
  try {
    const before = await rv("world");

    // labels only (show.1, show.5, reviewRows.4)
    await rv("make");
    await rv("show", { kept: false, people: false });
    await rv("type", '.speaker[data-label="Speaker B"] input[data-label]', "Linus");
    await rv("submit");
    const labels = await rv("state");
    console.log(`the voice review, labels only: ${JSON.stringify(labels)}`);
    if (labels.hidden || !same(labels.rows.map((r) => [r.kind, r.who]), [["label", "Speaker B"], ["label", "Speaker C"], ["label", "Speaker D"]]) ||
      labels.remember || !labels.button || !same(labels.chosen, [[[], [["Speaker B", "Linus"]]]])) {
      fail("labels only: the rows were not today's three labels with the button, #remember showed, or the submit did not hand back [] and Speaker B as Linus");
    }

    // overrule (show.1, show.5, P4)
    await rv("make");
    await rv("show");
    const drawn = await rv("state");
    await rv("click", '.speaker[data-name="Lorentz"] .speaker-not');
    await rv("type", '.speaker[data-name="Lorentz"] input[data-not]', " Ada ");
    await rv("click", '.speaker[data-name="Syrus"] .speaker-not');
    await rv("type", '.speaker[data-name="Syrus"] input[data-not]', "syrus");
    await rv("submit");
    const overruled = await rv("state");
    console.log(`the voice review, overrule: ${JSON.stringify({ drawn: drawn.rows, chosen: overruled.chosen })}`);
    const source = (state, name) => row(state, name)?.source ?? "";
    if (!same(drawn.rows.map((r) => [r.kind, r.who]), [["learned", "christoph/4be07c19a2f1"], ["library", "Lorentz"], ["library", "Syrus"],
      ["label", "Speaker B"], ["label", "Speaker C"], ["label", "Speaker D"]]) ||
      !/\bconfirmed/.test(source(drawn, "Lorentz")) || /unconfirmed/.test(source(drawn, "Lorentz")) || !/unconfirmed/.test(source(drawn, "Syrus")) ||
      drawn.rows.some((r) => r.kind !== "label" && r.inputs.length) || !row(drawn, "Lorentz").not || row(drawn, "Lorentz").keep ||
      !same(overruled.chosen, [[[{ kind: "overrule", clip: "lorentz/e81d5530c6a9", from: "Lorentz", to: "Ada" }], []]])) {
      fail("overrule: the rows or their clip's status were wrong, Their name showed before Not was pressed, or the submit did not hand back one overrule of lorentz/e81d5530c6a9 as Ada");
    }

    // keep (show.4, reviewRows.3)
    await rv("make");
    await rv("show");
    await rv("click", '.speaker[data-clip="christoph/4be07c19a2f1"] .speaker-keep');
    const kept = await rv("state");
    await rv("show", { christoph: "confirmed" });
    const confirmed = await rv("state");
    console.log(`the voice review, keep: ${JSON.stringify({ chosen: kept.chosen, rows: confirmed.rows.map((r) => r.who) })}`);
    if (!same(kept.chosen, [[[{ kind: "keep", clip: "christoph/4be07c19a2f1" }], []]]) || !row(kept, "christoph/4be07c19a2f1").keep ||
      kept.rows.some((r) => r.kind === "library" && r.keep) || confirmed.rows.some((r) => r.kind === "learned") || confirmed.chosen.length !== 1) {
      fail("keep: Keep did not hand back christoph/4be07c19a2f1 at the click, a library row offered Keep, or the learned row stayed once confirmed");
    }

    // remember (show.5, L4.1)
    await rv("make");
    await rv("show");
    await rv("type", '.speaker[data-label="Speaker B"] input[data-label]', "Christoph");
    await rv("type", '.speaker[data-label="Speaker D"] input[data-label]', "Dana");
    await rv("submit");
    const offered = await rv("state");
    await rv("click", "#remember");
    await rv("submit");
    const remembered = await rv("state");
    await rv("show", { playable: false });
    const unplayable = await rv("state");
    console.log(`the voice review, remember: ${JSON.stringify({ chosen: remembered.chosen, remember: [offered.remember, unplayable.remember] })}`);
    if (!offered.remember || !same(remembered.chosen, [[[], PAIRS], [[{ kind: "remember", label: "Speaker B", name: "Christoph", start: 9, end: 18.4 }], PAIRS]]) ||
      unplayable.remember) {
      fail("remember: the names were not handed back alone without the tick, the tick did not remember Speaker B from 9 to 18.4 alone, or #remember showed without playable");
    }

    // play and redraw (show.2, show.3)
    await rv("make");
    await rv("show");
    await rv("click", '.speaker[data-name="Syrus"] .speaker-play');
    await rv("click", '.speaker[data-label="Speaker C"] .speaker-play');
    await rv("type", '.speaker[data-label="Speaker C"] input[data-label]', "Grace");
    await rv("mark", '.speaker[data-name="Lorentz"]');
    await rv("show");
    const again = await rv("state");
    await rv("show", { path: "meetings/summaries/2026-11-17T09-00Z_retro.md" });
    const other = await rv("state");
    const c = await rv("unknownC");
    console.log(`the voice review, play and redraw: ${JSON.stringify({ plays: again.plays, c, grace: [row(again, "Speaker C")?.inputs, row(other, "Speaker C")?.inputs] })}`);
    if (!same(again.plays, [{ start: 61.2, end: 69, row: "Syrus", play: true }, { start: c.start, end: c.end, row: "Speaker C", play: true }]) ||
      c.start !== 70 || again.chosen.length !== 0 || !again.playable || row(again, "christoph/4be07c19a2f1").play || !row(again, "Syrus").play ||
      !same(row(again, "Speaker C").inputs, [["label", "Grace"]]) || !row(again, "Lorentz").marked ||
      !same(row(other, "Speaker C").inputs, [["label", ""]]) || row(other, "Lorentz").marked) {
      fail("play and redraw: ▸ did not play the row's stretch alone, the same state's show redrew or lost Grace, or another path's show kept her");
    }

    // quiet (Review.1, said.1, namingLine.2, P5)
    await rv("show", { busy: true });
    const busy = await rv("state");
    await rv("show", { empty: true });
    const empty = await rv("state");
    await rv("said", "Lorentz has no clip ffff");
    const failed = await rv("state");
    await rv("show");
    await rv("said", "");
    const naming = await rv("state");
    await page.waitForTimeout(300);
    const after = await rv("world");
    console.log(`the voice review, quiet: ${JSON.stringify({ busy: busy.hidden, empty: empty.hidden, failed: [failed.hidden, failed.said], naming: naming.said,
      role: naming.role, world: same(before, after) })}`);
    if (!busy.hidden || !empty.hidden || failed.hidden || failed.said !== "Lorentz has no clip ffff" || naming.hidden || !/Ada/.test(naming.said) ||
      /ffff/.test(naming.said) || naming.role !== "status" || !same(before, after)) {
      fail(`quiet: the form showed while busy or with nothing to say, a said text or the naming line did not show in #speakers-said, or a note, status, localStorage or run changed: ${JSON.stringify([before, after])}`);
    }
  } finally {
    await rv("cleanup");
  }
}

// The app shows and the machine boots without clai (loadplan.js): the site answers 404 for it
// at first. Until it is in, the load bar says what is not ready, Start recording says it is
// getting ready, and a line that runs clai waits; Try again fetches it, and the line then runs.
async function checkLateLoad(context, url) {
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("page error:", error.stack ?? error.message));
  const fail = (text) => {
    console.error(`\nFAIL: late loading: ${text}`);
    process.exitCode = 1;
  };
  let there = false;
  await page.route("**/clai.wasm", (route) => (there ? route.continue() : route.fulfill({ status: 404 })));
  await page.goto(url);
  await page.waitForSelector("body[data-ready]", { timeout: 120_000 });
  await page.waitForSelector("#loadbar.failed", { timeout: 60_000 });
  const typed = page.evaluate(() => window.runCommand("clai version | head -n 1"));
  await page.waitForFunction(() => window.terminalText().includes("Waiting for clai to load…"), null, { timeout: 30_000 }).catch(() => {});
  const waiting = await page.evaluate(() => ({
    arrived: document.querySelector("#app").classList.contains("arrived"),
    chip: document.querySelector("#machine-chip").textContent,
    loading: document.body.dataset.loading,
    bar: [...document.querySelectorAll("#loadbar > :not(svg)")].map((el) => (el.hidden ? "" : el.textContent)),
    start: [document.querySelector("#record-form > .primary").textContent, document.querySelector("#record-form > .primary").disabled],
    ask: document.querySelector("#penelope-ask").className,
    listed: document.querySelector("#app").dataset.phase,
    terminal: window.terminalText(),
  }));
  const [text, detail, action] = waiting.bar;
  console.log(`late loading, clai missing: ${JSON.stringify({ ...waiting, terminal: undefined })}`);
  if (!waiting.arrived || !waiting.chip.endsWith("running") || waiting.listed !== "ready") fail("the app did not show, the machine did not boot or the notes were not listed without clai");
  if (waiting.loading !== "agent record extras") fail(`body's data-loading is ${waiting.loading}, not "agent record extras"`);
  if (text !== "Could not load clai." || !/^cannot fetch \.\/clai\.wasm in 4 tries: status 404\. Not ready yet: Penelope, recording, the other tools\.$/.test(detail) || action !== "Try again") {
    fail(`the load bar does not say that clai failed, what is not ready and Try again: ${JSON.stringify(waiting.bar)}`);
  }
  if (waiting.start[0] !== "Getting ready to record…" || !waiting.start[1]) fail(`Start recording is ${JSON.stringify(waiting.start)} while its programs load`);
  if (!waiting.ask.includes("getting-ready")) fail("Ask does not say it is getting ready");
  if (!waiting.terminal.includes("Waiting for clai to load…") || waiting.terminal.includes("command not found")) fail("the typed line did not wait for clai");
  // What does not need clai runs meanwhile, beside the waiting line.
  const beside = await page.evaluate(() => window.minutes.run("Check", "{ echo beside; ls /bin | grep -c -x -e clai -e rg -e bash; } > /run/page/out", { topic: "beside", background: true }));
  if (beside.status !== 0 || beside.body?.trim() !== "3") fail(`a line beside the waiting one ended with ${beside.status} and counted ${beside.body} of clai, rg and bash in /bin`);
  there = true;
  await page.click("#loadbar button");
  const status = await typed;
  await page.waitForFunction(() => document.body.dataset.loading === "", null, { timeout: 60_000 });
  const lines = "command -v clai rg fd ffprobe slivingdoc; /usr/bin/clai version | head -n 1; type ffmpeg npx";
  const before = await page.evaluate(() => window.terminalText().length);
  const resolved = await page.evaluate((line) => window.runCommand(line), lines);
  const after = await page.evaluate(() => ({
    bar: document.querySelector("#loadbar").hidden,
    start: [document.querySelector("#record-form > .primary").textContent, document.querySelector("#access-mic").disabled, document.querySelector("#record-form > .primary").disabled],
    ask: document.querySelector("#penelope-ask").className,
    terminal: window.terminalText(),
  }));
  // The terminal may still be writing the worker's last line above the prompt.
  const printed = after.terminal.slice(before - 200);
  console.log(`late loading, clai in: ${JSON.stringify({ status, resolved, ...after, terminal: undefined })}\n${printed.trimEnd()}`);
  if (status !== 0 || !/Waiting for clai to load…[^]*version: v?\d/.test(after.terminal)) fail(`the typed line ended with ${status} or did not run clai once it was in`);
  if (!after.bar) fail("the load bar stays though everything is in");
  if (!after.start[0].endsWith("tart recording") || after.ask.includes("getting-ready")) fail(`Start recording says ${after.start[0]}, or Ask still gets ready, with everything in`);
  const want = ["/bin/clai", "/bin/rg", "/bin/fd", "/bin/ffprobe", "/bin/slivingdoc", "version: ", "ffmpeg is /usr/local/bin/ffmpeg", "npx is /bin/npx"];
  if (resolved !== 0 || want.some((text) => !printed.includes(text))) fail(`the late programs do not resolve as at the boot: ${printed}`);
  await page.close();
}

// A newer deploy (update.js): a page stamped "old" on a site whose version.json says "new" offers a
// reload once it asks and nothing is under way, Reload loads the page again, and Later puts it off.
async function checkNewVersion(context, url) {
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("page error:", error.stack ?? error.message));
  const fail = (text) => {
    console.error(`\nFAIL: a newer version: ${text}`);
    process.exitCode = 1;
  };
  const UNSTAMPED = '<meta name="penelope-version" content="dev">';
  let stamped = 0;
  await page.route((u) => u.pathname === "/" || u.pathname.endsWith("/index.html"), async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    if (html.includes(UNSTAMPED)) stamped++;
    await route.fulfill({ response, body: html.replace(UNSTAMPED, '<meta name="penelope-version" content="old">') });
  });
  await page.route("**/version.json", (route) => route.fulfill({ contentType: "application/json", body: '{"version":"new"}\n' }));
  const asks = [];
  page.on("request", (request) => request.url().endsWith("/version.json") && asks.push(request.url()));
  await page.goto(url);
  await page.waitForSelector("body[data-ready]", { timeout: 120_000 });
  const note = () => page.evaluate(() => {
    const el = document.querySelector("#update");
    return { hidden: el.hidden, shown: el.checkVisibility(), text: el.innerText.replace(/\s+/g, " ").trim() };
  });
  // Naming the speakers is under way: the offer waits for it.
  await page.evaluate(() => {
    window.minutes.choosing = true;
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForTimeout(800);
  const busy = await note();
  await page.evaluate(() => {
    window.minutes.choosing = false;
    window.notReloaded = true;
  });
  await page.waitForSelector("#update", { state: "visible", timeout: 10_000 }).catch(() => {});
  const idle = await note();
  console.log(`a newer version: ${JSON.stringify({ stamped, asks: asks.length, busy, idle })}`);
  if (stamped === 0) fail(`index.html does not say ${UNSTAMPED}, which web/stamp-dist.mjs stamps`);
  if (asks.length === 0) fail("the page never asked for version.json");
  if (!busy.hidden) fail("offered a reload while the speakers were being named");
  if (!idle.shown || idle.text !== "Penelope has been updated Reload to get the new version. Your meetings stay where they are. Reload Later") {
    fail(`no offer once nothing was under way: ${JSON.stringify(idle)}`);
  }
  await Promise.all([page.waitForEvent("load", { timeout: 60_000 }), page.click("#update-reload")]);
  await page.waitForSelector("body[data-ready]", { timeout: 120_000 });
  if (await page.evaluate(() => window.notReloaded === true)) fail("Reload did not load the page again");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector("#update", { state: "visible", timeout: 10_000 }).catch(() => fail("the reloaded page, still old, did not offer the reload"));
  await page.click("#update-later");
  if (!(await note()).hidden) fail("Later did not put the offer away");
  await page.close();
}

// The app comes onto the pad a piece at a time (arrival.js): the pen writes the checklist's six
// lines and ticks each as its piece is in; Penelope comes before the page, the sidebar with the
// notes, and the header's chips with the page, which arrives once all is ticked and never before.
async function checkArrival(context, url) {
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("page error:", error.stack ?? error.message));
  await page.addInitScript(() => {
    const seen = (window.arrivalSeen = { lines: 0, ticked: 0 });
    const mark = (key) => (seen[key] ??= Math.round(performance.now()));
    new MutationObserver(() => {
      const app = document.querySelector("#app");
      const chips = document.querySelector(".top .chips");
      if (!app || !chips || !document.querySelector("#loading")) return;
      if (document.querySelector("#penelope:not([hidden])")) mark("penelope");
      if (app.classList.contains("with-notes")) mark("notes");
      if (app.classList.contains("arrived")) mark("arrived");
      if (app.classList.contains("arrived")) seen.tickedWhenArrived ??= document.querySelectorAll("#loading li.done").length;
      seen.lines = Math.max(seen.lines, document.querySelectorAll("#loading li").length);
      if (seen.lines) mark("began");
      seen.ticked = Math.max(seen.ticked, document.querySelectorAll("#loading li.done").length);
      // Only once pad.css applies: before that the page is not rendered at all.
      const styled = getComputedStyle(document.querySelector("#loading")).position === "absolute";
      if (styled && !app.classList.contains("arrived") && getComputedStyle(chips).visibility === "visible") mark("chipsEarly");
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden"] });
  });
  await page.goto(url);
  const arrived = await page.waitForSelector("#app.arrived", { timeout: 120_000 }).then(() => true, () => false);
  await page.waitForFunction(() => document.querySelector("#loading").hidden, null, { timeout: 5_000 }).catch(() => {});
  const seen = await page.evaluate(() => ({
    ...window.arrivalSeen, erased: document.querySelector("#loading").hidden, chips: getComputedStyle(document.querySelector(".top .chips")).visibility,
  }));
  console.log(`the arrival, a piece at a time (ms after navigation): ${JSON.stringify(seen)}`);
  if (!arrived || seen.lines !== 6 || seen.ticked !== 6 || !seen.erased) fail("the arrival: the pen did not write and tick the checklist's six lines, or the page did not arrive and rub it out");
  if (!(seen.penelope < seen.arrived) || !(seen.notes <= seen.arrived) || seen.chipsEarly || seen.chips !== "visible") {
    fail("the arrival: Penelope did not come before the page, the sidebar after it, or the chips showed before it or not at all");
  }
  if (seen.tickedWhenArrived !== 6) fail(`the arrival: the page came with ${seen.tickedWhenArrived} of the checklist's six lines ticked`);
  await page.close();

  function fail(text) {
    console.error(`\nFAIL: ${text}`);
    process.exitCode = 1;
  }
}

// On a phone (390 px, touch) with no AI provider: the header is one row with the menu, the sidebar
// is a drawer the menu opens and a tap beside it closes, nothing scrolls sideways, and the provider
// card is ringed in red pencil (pointer.js) from the guide's link and when Penelope is asked.
async function checkPhone(browser, url) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("page error:", error.stack ?? error.message));
  const fail = (text) => {
    console.error(`\nFAIL: phone: ${text}`);
    process.exitCode = 1;
  };
  try {
    await page.goto(url);
    await page.waitForSelector("#penelope-bubble:not([hidden]) a[data-point=provider-card]", { timeout: 60_000 });
    const layout = await page.evaluate(() => ({
      wide: document.documentElement.scrollWidth > innerWidth,
      top: Math.round(document.querySelector(".top").getBoundingClientRect().height),
      menu: getComputedStyle(document.querySelector("#menu")).display !== "none",
      chips: getComputedStyle(document.querySelector("#machine-chip")).display,
      drawer: Math.round(document.querySelector("#sidebar").getBoundingClientRect().right),
    }));
    // The guide's link: the bubble goes, the card is ringed.
    await page.click("#penelope-bubble a[data-point=provider-card]");
    const ringed = await page.waitForSelector(".pointer-ring path", { timeout: 5_000 }).then(() => true, () => false);
    const around = await page.evaluate(() => {
      const ring = document.querySelector(".pointer-ring path")?.getBoundingClientRect();
      const card = document.querySelector("#provider-card").getBoundingClientRect();
      return ring ? { encloses: ring.left <= card.left && ring.top <= card.top && ring.right >= card.right && ring.bottom >= card.bottom, cardTop: Math.round(card.top) } : null;
    });
    // Penelope, asked without a provider, runs nothing and points at the card again.
    await page.evaluate(() => document.querySelector(".pointer-ring")?.remove());
    // She sways, so she is never "stable" for a Playwright click; the other checks click her this way too.
    await page.$eval("#penelope-pen", (el) => el.click());
    await page.fill("#penelope-input", "How do I start?");
    await page.click("#penelope-ask");
    const asked = await page.waitForSelector(".pointer-ring path", { timeout: 8_000 }).then(() => true, () => false);
    const said = await page.textContent("#penelope-log");
    // Her desk is set up only when she runs (askPenelope's copy line).
    const ran = await page.evaluate(() => window.minutes.jobs.length + (window.terminalText().includes("penelope/desk") ? 1 : 0));
    await page.click("#penelope-close");
    // The drawer: the menu opens it, a tap beside it closes it.
    await page.click("#menu");
    await page.waitForTimeout(450);
    const open = await page.evaluate(() => Math.round(document.querySelector("#sidebar").getBoundingClientRect().left));
    await page.click("#scrim", { position: { x: 370, y: 400 } });
    await page.waitForTimeout(450);
    const shut = await page.evaluate(() => ({ right: Math.round(document.querySelector("#sidebar").getBoundingClientRect().right), scrim: document.querySelector("#scrim").hidden }));
    console.log(`phone: ${JSON.stringify({ ...layout, ringed, around, asked, said: said.slice(-120), ran, open, shut })}`);
    if (layout.wide || layout.top > 60 || !layout.menu || layout.chips !== "none" || layout.drawer > 0) fail("the header is not one row with the menu, the chips show, the sidebar is not a closed drawer, or the page scrolls sideways");
    if (!ringed || !around?.encloses) fail("the guide's link did not ring the provider card");
    if (!asked || !/AI provider/.test(said) || ran !== 0) fail("Penelope, asked without a provider, ran something or did not point at the card");
    if (open !== 0 || shut.right > 0 || !shut.scrim) fail("the menu did not open the drawer, or a tap beside it did not close it");
  } finally {
    await context.close();
  }
}

const server = await startServer();
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
try {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  // Minutes runs its agent with the test models and the meeting-transcriber profile the AUDIO
  // rows write, as they do.
  // Chromium's fake devices have no monitor source, so the second fake input plays one: on Linux,
  // PipeWire's "Monitor of ..." inputs hold what the computer plays.
  await page.addInitScript(() => {
    const enumerate = MediaDevices.prototype.enumerateDevices;
    MediaDevices.prototype.enumerateDevices = async function () {
      return (await enumerate.call(this)).map((d) => d.kind === "audioinput" && d.label === "Fake Audio Input 2"
        ? { deviceId: d.deviceId, groupId: d.groupId, kind: d.kind, label: "Monitor of Built-in Audio Analog Stereo" }
        : d);
    };
  });
  await page.addInitScript(() => {
    window.minutesConfig = {
      profile: "/tmp/meeting.json",
      flags: "-cm mock_test",
      env: "CLAI_MOCK_AUDIO_TRANSCRIBE_FILE=/tmp/mic.wav",
      query: () => "tool_audio_sources tool_audio_record tool_audio_transcribe",
    };
  });
  // The page's media session actions, so the check can run the one Chrome runs on a tab switch.
  await page.addInitScript(() => {
    window.mediaActions = new Map();
    const set = MediaSession.prototype.setActionHandler;
    MediaSession.prototype.setActionHandler = function (action, handler) {
      window.mediaActions.set(action, handler);
      return set.call(this, action, handler);
    };
  });
  page.on("pageerror", (error) => console.error("page error:", error.stack ?? error.message));
  await checkArrival(context, `http://localhost:${server.address().port}/`);
  await checkPhone(browser, `http://localhost:${server.address().port}/`);
  await checkLateLoad(context, `http://localhost:${server.address().port}/`);
  await checkNewVersion(context, `http://localhost:${server.address().port}/`);
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForSelector("body[data-ready]", { timeout: 120_000 });
  // The checks below run with every program on the machine.
  await page.waitForFunction(() => document.body.dataset.loading === "", null, { timeout: 120_000 });
  await checkRunLines(page);
  await checkRunLogKept(page);
  await checkGuide(page);
  await checkPounce(page);
  await checkBubbleWrap(page);
  for (const { line, status: want } of COMMANDS) {
    const before = await page.evaluate(() => window.terminalText());
    const status = await page.evaluate((line) => window.runCommand(line), line);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== want || !printed.includes("Usage: clai")) {
      console.error(`\nFAIL: ${line} exited with ${status} (want ${want}) or printed no usage`);
      process.exitCode = 1;
    }
  }
  const bash = await page.evaluate(() => document.body.dataset.bash === "true");
  for (const { line, prints } of bash ? SHELL : []) {
    const before = await page.evaluate(() => window.terminalText());
    const status = await page.evaluate((line) => window.runCommand(line), line);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== 0 || !printed.includes(prints)) {
      console.error(`\nFAIL: ${line} exited with ${status} or did not print ${prints}`);
      process.exitCode = 1;
    }
  }
  // The kernel's events reach the page: the line's bash, tagged as the terminal's, and the file
  // it writes.
  if (bash) {
    await page.evaluate((line) => window.runCommand(line), "echo hood > /tmp/hood.txt");
    const seen = await page
      .waitForFunction(() => {
        const procs = [...window.hoodModel.procs.values()];
        const shell = procs.find((p) => p.name === "bash" && p.argv[2]?.includes("/tmp/hood.txt"));
        const wrote = window.hoodModel.resources.get("file:/tmp/hood.txt");
        return shell?.action === "terminal" && wrote?.procs.has("bash") && wrote.out === 5;
      }, null, { timeout: 10_000 })
      .then(() => true, () => false);
    console.log(`under the hood: ${seen ? "saw" : "missed"} bash write /tmp/hood.txt`);
    if (!seen) {
      console.error("\nFAIL: the under-the-hood model did not see bash, tagged terminal, write 5 bytes to /tmp/hood.txt");
      process.exitCode = 1;
    }
  }
  // Nothing shared yet: ffmpeg leaves the shared input out. Then the page shares a screen, as
  // Allow mic and computer audio does: here a stand-in for getDisplayMedia, an oscillator's audio
  // and a canvas's video, since headless Chromium shows no picker.
  if (bash) {
    const line = "ffmpeg -hide_banner -sources pulse | grep -q browser-tab || echo no-shared-input";
    const before = await page.evaluate(() => window.terminalText());
    await page.evaluate((line) => window.runCommand(line), line);
    if (!(await page.evaluate(() => window.terminalText())).slice(before.length).includes("no-shared-input")) {
      console.error("\nFAIL: ffmpeg lists the shared input before anything is shared");
      process.exitCode = 1;
    }
    await page.evaluate(async () => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        const tone = context.createOscillator();
        // Silent until the check turns it up: nobody has spoken yet.
        window.shareVolume = context.createGain();
        window.shareVolume.gain.value = 0;
        tone.connect(window.shareVolume).connect(destination);
        tone.start();
        const video = document.createElement("canvas").captureStream().getVideoTracks();
        return new MediaStream([...destination.stream.getAudioTracks(), ...video]);
      };
    });
    // The checklist's share line asks for it (here, past the fake monitor that already ticks it).
    // A silent share already lets a recording start; the tone then ticks off its sound.
    await page.evaluate(() => window.minutes.shareComputer());
    if (!(await page.textContent("#access-computer")).includes("Shared screen or tab")) {
      console.error("\nFAIL: the checklist does not say a screen is shared");
      process.exitCode = 1;
    }
    const early = await page.evaluate(() => ({
      heard: document.querySelector("#access-sound").classList.contains("allowed"),
      start: !document.querySelector("#record-form > .primary").disabled,
    }));
    if (early.heard || !early.start) {
      console.error(`\nFAIL: before any sound, Start recording should be on and the sound unticked: ${JSON.stringify(early)}`);
      process.exitCode = 1;
    }
    await page.evaluate(() => { window.shareVolume.gain.value = 1; });
    const heard = await page.waitForSelector("#access-sound.allowed", { timeout: 20_000 }).then(() => true, () => false);
    if (!heard || (await page.isDisabled("#record-form > .primary"))) {
      console.error("\nFAIL: the checklist did not hear the share once it played, or Start recording went off");
      process.exitCode = 1;
    }
  }
  for (const { line, status: want, prints } of bash ? [...MCP, ...AUDIO, ...SIGNIN(server.address().port)] : []) {
    const before = await page.evaluate(() => window.terminalText());
    const status = await page.evaluate((line) => window.runCommand(line), line);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== want || !printed.includes(prints)) {
      console.error(`\nFAIL: ${line} exited with ${status} (want ${want}) or did not print ${prints}`);
      process.exitCode = 1;
    }
  }
  if (!bash) console.log("\nskipped the shell and MCP rows: no bash (make packages)");
  if (bash) await checkDownload(page);
  // `play` put the 2 s recording in a player the browser can decode.
  if (bash) {
    const seconds = await page.evaluate(async () => {
      const element = document.querySelector(".player audio");
      if (!element) return 0;
      if (element.readyState < 1) await new Promise((loaded) => (element.onloadedmetadata = loaded));
      return element.duration;
    });
    console.log(`player: ${seconds} s`);
    if (!(Math.abs(seconds - 2) < 0.1)) {
      console.error(`\nFAIL: play: the page's player holds ${seconds} s, want 2 s`);
      process.exitCode = 1;
    }
  }
  // Minutes' Record: the agent starts ffmpeg through its audio_record tool, the page shows Stop,
  // which ends the recording as Enter does, and the agent's reply comes back to the app. Then
  // a meeting of the notebook opens as its summary and transcript, rendered.
  if (bash) {
    await page.evaluate((line) => window.runCommand(line), NOTEBOOK);
    await checkOpenRouterSignin(context, page);
    await page.fill("#key-input", "sk-test-not-a-key");
    await page.click("#key-form button");
    // The key stays in this browser for this site, so a return to it needs no paste.
    const kept = await page.evaluate(() => [localStorage.getItem("minutes.openai-key"), window.minutes.env.get("OPENAI_API_KEY")]);
    if (kept[0] !== "sk-test-not-a-key" || kept[1] !== "sk-test-not-a-key") {
      console.error(`\nFAIL: the browser did not keep the OpenAI key (localStorage ${kept[0]}, env ${kept[1]})`);
      process.exitCode = 1;
    }
    const changeable = await page.isVisible("#change-key");
    if (!changeable) {
      console.error("\nFAIL: no way to change the key the browser kept");
      process.exitCode = 1;
    }
    const terminalBefore = await page.evaluate(() => window.terminalText().length);
    await page.fill("#title", "Daily sync");
    await page.click("#record-form > .primary");
    const stop = await page
      .waitForSelector("#stop:not([hidden])", { timeout: 60_000 })
      .then(() => true, () => false);
    if (stop) {
      await page.waitForTimeout(2000);
      await page.click("#stop");
    }
    const replied = await page
      .waitForSelector("#agent:not([hidden])", { timeout: 60_000 })
      .then(() => true, () => false);
    // The recording is copied out of the machine once the agent is done, whatever it said.
    await page.waitForSelector("#recording-download:not([hidden])", { timeout: 30_000 }).catch(() => {});
    const result = await page.evaluate(() => {
      const r = window.minutes.recording;
      const action = [...window.hoodModel.procs.values()].find((p) => p.action.startsWith("minutes:Record"))?.action;
      // ffmpeg's wrapper in /usr/local/bin runs ffmpeg itself.
      const ancestors = [];
      for (let p = window.hoodModel.find(action, "ffmpeg").at(-1); p; p = window.hoodModel.procs.get(p.ppid)) {
        ancestors.push(p.name);
      }
      return {
        status: r.status,
        reply: r.reply,
        stages: [...r.stages],
        ffmpegUnder: ancestors.find((name) => name !== "ffmpeg" && name !== "bash"),
        command: window.hoodModel.tree(action).map((n) => n.proc.argv[2]).join(" "),
        // The recording is kept in the browser and can be downloaded.
        download: document.querySelector("#recording-download").hidden ? null : document.querySelector("#recording-download").textContent,
      };
    });
    console.log(`Minutes, Record: ${JSON.stringify(result)}`);
    if (!stop || !replied || result.status !== 0 || !result.stages.includes("recorded") ||
      result.ffmpegUnder !== "clai" || !result.command.includes("clai -json -reply-only -n -af json -profile-path /tmp/meeting.json") ||
      !/^Download the recording \(\d/.test(result.download ?? "")) {
      console.error("\nFAIL: Minutes' Record did not show Stop, run ffmpeg under clai, bring the agent's reply back, or keep the recording for download");
      process.exitCode = 1;
    }
    await checkRecordLog(page, terminalBefore);
    // A run that fails: clai's error record becomes a note hung under the peek button, which
    // opens the terminal, where the record itself is.
    {
      const ran = await page.evaluate(async () => {
        window.minutes.config.flags = "-cm no-such-model";
        const { status, reply, problem } = await window.minutes.runAgent("Answer", window.minutes.agentLine("hello", false));
        return { status, reply, level: problem?.level };
      });
      const note = await page.waitForSelector(".note.error", { timeout: 30_000 }).then(() => true, () => false);
      const shown = await page.evaluate(() => {
        const el = document.querySelector(".note.error");
        const anchor = document.querySelector("#peek").getBoundingClientRect();
        const at = el?.getBoundingClientRect();
        return {
          title: el?.querySelector("strong")?.textContent,
          detail: el?.querySelector(".note-detail")?.textContent,
          nudged: document.querySelector("#peek").classList.contains("nudge"),
          under: Boolean(at) && at.top >= anchor.bottom && at.right <= anchor.right + 1,
        };
      });
      if (note) await page.click(".note.error .note-peek");
      const opened = await page.evaluate(() => ({
        hood: document.querySelector("#hood").classList.contains("open"),
        tab: document.querySelector("[role=tab][aria-selected=true]")?.dataset.tab,
        // The record drawn, not its JSON, and the note's link selects it.
        record: window.terminalText().includes("error: failed to create text querier") && !window.terminalText().includes('{"type":"error"'),
        selected: window.terminalSelection(),
      }));
      console.log(`Minutes, a failed run: ${JSON.stringify({ ...ran, ...shown, ...opened })}`);
      if (!note || ran.status === 0 || ran.level !== "error" || shown.title !== "The agent stopped with an error" || !shown.detail?.includes("no-such-model") ||
        !shown.nudged || !shown.under || !opened.hood || opened.tab !== "terminal" || !opened.record ||
        !opened.selected.includes("no-such-model")) {
        console.error("\nFAIL: a failed run did not hang a note under the peek button that opens the terminal with clai's error selected");
        process.exitCode = 1;
      }
      if (note) await checkFailedLog(page);
      await page.click(".note.error .note-close");
      await page.click("#peek-close");
      await page.evaluate(() => { window.minutes.config.flags = "-cm mock_test"; });
    }
    await checkTranscriptPaths(page);
    await checkRunLogsTab(page);
    await checkLogsClean(page, "after the first runs", ["sk-test-not-a-key", "sk-or-v1-check-not-a-key"]);
    await checkTrustBeforeRecord(context, page);
    await checkTrustDuringMeeting(context, page);
    await page.click(".meeting >> text=Design review");
    const opened = await page
      .waitForFunction(() => document.querySelector("#transcript").textContent.includes("Speaker A"), null, { timeout: 30_000 })
      .then(() => true, () => false);
    // The notes show at once, nothing hidden for an animation, in wet ink that dries (handwriting.js).
    const meeting = await page.evaluate(() => ({
      title: document.querySelector("#meeting-title").textContent,
      item: document.querySelector("#summary ul > li")?.textContent,
      path: document.querySelector("#saved-path").textContent,
      wet: document.querySelectorAll("#summary .ink-wet, #transcript .ink-wet").length,
      hidden: [...document.querySelectorAll("#summary *, #transcript *")].filter((e) => e.getClientRects().length &&
        (getComputedStyle(e).visibility === "hidden" || Number(getComputedStyle(e).opacity) < 1 || e.style.clipPath)).length,
    }));
    console.log(`Minutes, a meeting: ${JSON.stringify(meeting)}`);
    if (!opened || meeting.title !== "Design review" || meeting.item !== "Ship the peek") {
      console.error("\nFAIL: the notebook's meeting did not open as its rendered summary and transcript");
      process.exitCode = 1;
    }
    if (opened && (meeting.hidden > 0 || meeting.wet === 0)) {
      console.error(`\nFAIL: the meeting's notes did not show at once in drying ink (${meeting.hidden} hidden, ${meeting.wet} wet)`);
      process.exitCode = 1;
    }
    // A correction: the line's words open in place, Enter keeps them, and Save writes the file.
    if (opened) {
      await page.click("#transcript .utt-words");
      await page.fill("#transcript textarea.utt-edit", "Ship it on Friday.");
      await page.keyboard.press("Enter");
      const counted = await page.textContent("#fixes-count");
      await page.click("#fixes-save");
      const saved = await page
        .waitForFunction(() => document.querySelector("#fixes-count").textContent === "Saved", null, { timeout: 30_000 })
        .then(() => true, () => false);
      const file = await page.evaluate(async () =>
        (await window.minutes.readMeeting("meetings/summaries/2026-10-28T09-00Z_design-review.md", "Check", true))?.transcript);
      console.log(`Minutes, a correction: ${JSON.stringify({ counted, saved, file })}`);
      if (counted !== "1 correction" || !saved || file !== "**Speaker A** [00:12]: Ship it on Friday.\n") {
        console.error("\nFAIL: a correction to the transcript did not show on the post-it or did not reach the file");
        process.exitCode = 1;
      }
    }
    // Penelope, the red pen: her bubble runs clai with her own profile on copies of the meeting, and answers.
    if (opened) {
      const her = await askPenelope(page, "hello");
      console.log(`Minutes, Penelope: ${JSON.stringify({ ...her, command: her.command.slice(0, 300) })}`);
      if (!her.answered || her.errors || !her.command.includes("-profile-path /tmp/penelope/profile.json") || !her.command.includes("Meeting in focus: “")) {
        console.error("\nFAIL: Penelope did not answer in her bubble about the meeting in focus, or did not run clai with her profile");
        process.exitCode = 1;
      }
      // The mock model says back what it is asked, so an answer asked for is hers: she has the app show New recording.
      const acted = await askPenelope(page, JSON.stringify({ say: "Over to you.", mood: "glad", do: [{ action: "new_recording" }] }));
      const view = await page.evaluate(() => window.minutes.view);
      console.log(`Minutes, Penelope's action: ${JSON.stringify({ answered: acted.answered, said: acted.said, offered: acted.command.includes("new_recording: show New recording"), view })}`);
      if (!acted.answered || acted.said?.trim() !== "Over to you." || !acted.command.includes("new_recording: show New recording") || view !== "record") {
        console.error("\nFAIL: Penelope's answer did not have the app take the action it named");
        process.exitCode = 1;
      }
      await page.click("#penelope-close");
      await checkTools(context, page);
      await checkLogsClean(page, "after Penelope's tools", ["sk-test-not-a-key", "sk-or-v1-check-not-a-key", "standin-access-", "standin-refresh-"]);
      await checkDoodling(page);
    }
    await checkParallel(page);
    await checkRecording(page);
    await checkReplies(page);
    await checkTimeLeft(page);
    await checkPopout(page);
    await checkEarlyStop(page);
    await checkVoiceKeeper(page);
    await checkSegmentKeeper(page);
    await checkPeople(page);
    await checkReview(page);
    await checkKnownPeople(page);
    await checkRename(page);
    await checkNotesOutliveReload(context, page, `http://localhost:${server.address().port}/`);
  }
  // Minutes' sign-out of a session that pasted a token: the app forgets the token, says the key
  // itself stays valid, and the chip returns to the notebook in this tab (2026-11-04
  // research/http-host-call/PROMPT.md). A stored login's sign-out runs `slivingdoc logout`, which
  // the rows above prove on its own.
  if (bash) {
    // The stub site stands in for the hosted endpoint too, so the pull a token asks for stays on
    // this machine.
    await page.evaluate(
      (endpoint) => window.minutes.env.set("SLIVINGDOC_ENDPOINT", endpoint),
      `http://localhost:${server.address().port}`,
    );
    await page.evaluate(() => {
      if (document.querySelector("#notebook-card").hidden) document.querySelector("#connect").click();
    });
    await page.fill("#token-input", "sld_check_token_only");
    await page.click("#notebook-form button");
    const offered = await page
      .waitForSelector("#signout:not([hidden])", { timeout: 30_000 })
      .then(() => true, () => false);
    await page.click("#signout");
    const local = await page
      .waitForFunction(() => document.querySelector("#notebook-chip").textContent === "slivingdoc: local notebook", null, {
        timeout: 30_000,
      })
      .then(() => true, () => false);
    const said = await page.evaluate(() => document.querySelector("#signout-said").textContent);
    console.log(`Minutes, Sign out: ${JSON.stringify({ offered, local, said })}`);
    if (!offered || !local || !said.includes("stays valid")) {
      console.error("\nFAIL: Minutes did not offer Sign out, forget the token, or say the key stays valid");
      process.exitCode = 1;
    }
  }
  if (bash) await checkLogsClean(page, "at the end", ["sk-test-not-a-key", "sk-or-v1-check-not-a-key", "sld_check_token_only", "standin-access-", "standin-refresh-"]);
  // The keyboard goes to the terminal, in its tab.
  await page.evaluate(() => window.showTab("terminal"));
  for (const { name, keys, status: want } of INTERACTIVE) {
    const before = await page.evaluate(() => window.terminalText());
    await page.evaluate(() => {
      window.running = window.runCommand("clai setup");
    });
    await page.waitForFunction(
      (length) => window.terminalText().slice(length).includes("[q]uit"),
      before.length,
      { timeout: 60_000 },
    ).catch(async (error) => {
      const text = await page.evaluate(() => window.terminalText());
      console.error(`the terminal, which never showed the menu:\n${JSON.stringify(text.slice(-1500))}`);
      throw error;
    });
    for (const key of keys) await page.keyboard.press(key);
    const status = await page.evaluate(() => window.running);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== want) {
      console.error(`\nFAIL: clai setup, then ${name}: exited with ${status} (want ${want})`);
      process.exitCode = 1;
    }
  }
  if (bash) {
    const before = await page.evaluate(() => window.terminalText());
    await page.evaluate((line) => {
      window.running = window.runCommand(line);
    }, `${RECORD} 2>&1 | cat`);
    await page.waitForFunction(() => window.terminalText().includes("stops: [Enter], max 1m"), null, {
      timeout: 60_000,
    });
    await page.waitForTimeout(2000);
    await page.keyboard.press("Enter");
    const status = await page.evaluate(() => window.running);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== 0 || !printed.includes("stopped_because: enter")) {
      console.error(`\nFAIL: a recording, then Enter: exited with ${status} or did not stop on Enter`);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) {
    console.log("\nok: clai printed its usage, read its terminal and recorded the page's microphone on WASIX v2 in Chromium");
  }
} finally {
  await browser.close();
  server.close();
}
