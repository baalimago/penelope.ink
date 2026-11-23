// Runs the WASIX v2 machine off the page's thread: browsers instantiate modules over 8 MB
// synchronously only in workers, and the terminal stays responsive while clai runs. The page's
// first message is the terminal's size; then come commands, keystrokes and new sizes. The
// machine boots with bash and the basic tools; the other programs come after (loadplan.js).
import init, { boot } from "./pkg/clai_web.js";
import { STAGES, inOrder, isReady, plan } from "./loadplan.js";

const post = (message) => postMessage(message);

// What the boot has fetched so far, for its summary and for a failure's report.
const loaded = { files: 0, bytes: 0 };

// Each large file by its url: {stage, name, bytes (on the wire, once known), got, state:
// queued, fetching, installed or failed}. The page's load bar shows them (loadbar.js).
const files = new Map();
let reporting = null;
const report = () => {
  reporting ??= setTimeout(() => {
    reporting = null;
    post({ load: [...files.values()] });
  }, 100);
};

// The files the site holds gzipped, as <file>.gz (compress-dist.mjs writes the list for a
// deployed site; the one in the tree is empty). Set before the first fetchBytes.
let precompressed = new Set();

// `bytes` unpacked. A server that sent the .gz with Content-Encoding: gzip had the browser
// unpack it already, so bytes without gzip's magic number are returned as they are.
const gunzip = async (bytes) => {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

// The response's body, whole, counted on `file` as it comes.
const bodyOf = async (response, file) => {
  const length = Number(response.headers.get("content-length"));
  if (file && length) file.bytes = length;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (file) file.got = size;
    if (file) report();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
};

const packedUrl = (url) => (precompressed.has(url.replace(/^\.\//, "")) ? `${url}.gz` : url);

// A file of the site, whole. A request that the network drops, or that the server answers
// with a 5xx, is tried again: a host under load resets some of twenty large downloads, and one
// lost file would otherwise stop the boot. What fails for good says which file it was.
const fetchBytes = async (url, tries = 4) => {
  const packed = packedUrl(url) !== url;
  const file = files.get(url);
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const started = performance.now();
    // Where the request stopped: before any answer, or while its body came in.
    let stage = "no answer";
    try {
      const response = await fetch(packedUrl(url));
      stage = `status ${response.status}, body of ${response.headers.get("content-length") ?? "unknown"} bytes cut short`;
      if (response.ok) {
        const bytes = await bodyOf(response, file);
        loaded.files++;
        loaded.bytes += bytes.length;
        stage = "unpacking";
        return packed ? await gunzip(bytes) : bytes;
      }
      last = new Error(`status ${response.status}`);
      if (response.status < 500) break;
    } catch (error) {
      last = new Error(`${error.message} (${stage}, after ${Math.round(performance.now() - started)} ms${navigator.onLine ? "" : ", the browser is offline"})`);
    }
    if (attempt < tries) {
      post({ log: `\x1b[33m${url}: ${last.message}, trying again (${attempt}/${tries - 1})\x1b[0m` });
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`cannot fetch ${url} in ${tries} tries: ${last.message}`);
};

// The terminal's size is needed at the boot, not before: the downloads start at once.
const sized = new Promise((resolve) => (onmessage = ({ data }) => resolve(data)));
// The registry packages `make` downloaded (fetch-packages.mjs), if it did.
const packageList = async () => {
  const response = await fetch("./packages/index.json");
  return response.ok ? response.json() : [];
};

// clai, then the programs `make` built for /bin: the MCP server ports, and npx and uvx; and the
// wrappers for /usr/local/bin, whose entries name that directory.
const programList = async () => {
  const response = await fetch("./bin/index.json");
  return [{ name: "clai", file: "clai.wasm" }, ...(response.ok ? await response.json() : [])];
};

// A failure of the boot says where it stopped, on the terminal and in the console: a module
// worker's own error event carries only the message.
let phase = "starting";
const bootStarted = performance.now();
addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  console.error(`boot failed while ${phase}`, reason);
  post({
    stopped: phase !== "running",
    error: `The machine did not start: it stopped while ${phase}, after ${Math.round(performance.now() - bootStarted)} ms and ` +
      `${loaded.files} files (${(loaded.bytes / 1e6).toFixed(1)} MB). ${reason?.message ?? reason}. Reload to try again.`,
  });
});

phase = "reading the site's lists";
const [packedList, allPrograms, allPackages] = await Promise.all([
  fetch("./precompressed.json").then((r) => (r.ok ? r.json() : []), () => []),
  programList(),
  packageList(),
]);
precompressed = new Set(packedList);
const { programs, packages: list, late } = plan(allPrograms, allPackages);
// The kernel's own module, fetched here as the programs are, so the load bar counts it.
const KERNEL = "./pkg/clai_web_bg.wasm";
const first = [
  ...programs.map(({ name, file }) => ({ name, url: `./${file}` })),
  ...list.map(({ name, file }) => ({ name, url: `./packages/${file}` })),
];
for (const { name, url } of [{ name: "the kernel", url: KERNEL }, ...first]) {
  if (!files.has(url)) files.set(url, { stage: "machine", name, bytes: null, got: 0, state: "fetching" });
}
for (const { stage, name, url } of late) files.set(url, { stage, name, bytes: null, got: 0, state: "queued" });
report();
post({ log: `Loading ${first.map(({ name }) => name).join(", ")}…` });
phase = "downloading the kernel and the first programs";
const whole = new Map();
const fetching = Promise.all([
  fetchBytes(KERNEL).then((bytes) => init({ module_or_path: bytes })),
  fetchBytes("./ca-certificates.crt"),
  inOrder([...new Set(first.map(({ url }) => url))], 6, async (url) => whole.set(url, await fetchBytes(url))),
]);
// What waits its turn says how big it is, so the load bar knows the whole early.
for (const { url } of late) {
  fetch(packedUrl(url), { method: "HEAD" }).then((response) => {
    const length = Number(response.headers.get("content-length"));
    if (response.ok && length) files.get(url).bytes ??= length;
    report();
  }, () => {});
}
const [, certificates] = await fetching;
const programBytes = programs.map(({ file }) => whole.get(`./${file}`));
const packages = list.map(({ file }) => whole.get(`./packages/${file}`));
post({ log: `\x1b[2mLoaded ${loaded.files} files, ${(loaded.bytes / 1e6).toFixed(1)} MB, in ${((performance.now() - bootStarted) / 1000).toFixed(1)} s.\x1b[0m` });
const { size: { rows, cols } } = await sized;
phase = "booting the machine";
const local = programs.map(({ dir }) => dir === "/usr/local/bin");
const pick = (items, wantLocal) => items.filter((_, i) => local[i] === wantLocal);
const names = programs.map(({ name }) => name);
const shell = await boot(
  certificates,
  pick(names, false),
  pick(programBytes, false),
  pick(names, true),
  pick(programBytes, true),
  packages,
  late.filter((entry) => entry.program).map((entry) => entry.program),
  late.flatMap((entry) => entry.commands ?? []),
  rows,
  cols,
);
for (const file of files.values()) if (file.stage === "machine") file.state = "installed";
report();
for (const note of shell.notes()) post({ log: `\x1b[33m${note}\x1b[0m` });
// Every run asks the host to carry its HTTP: the page's fetch is the client, with the browser's
// own TLS (WASIX_HTTP=host, components/go/src/net/http/wasix_http.go). A line that sets
// WASIX_HTTP keeps its own value, because bash applies its assignments over the login's.
const HOST = "WASIX_HTTP=host";
const home = shell.login_env().find((v) => v.startsWith("HOME="))?.slice("HOME=".length) ?? "/";
phase = "running";
post({ events: shell.take_events() });
post({ ready: true, bash: allPackages.some(({ name }) => name === "wasmer/bash"), home });
post({ log: "Network: the page's fetch is the client, with the browser's TLS, and only what the browser lets the page reach." });

// The audio inputs whose /run/audio files are open, which the page captures and sends back.
let wanted = "";
const audio = () => {
  const now = shell.audio_wanted();
  if (now.join() !== wanted) post({ audio: now });
  wanted = now.join();
};

// The programs still to come that something on the machine waits for.
let waited = "";
const drain = () => {
  const waiting = shell.waited_for();
  if (waiting.join() !== waited) post({ waiting });
  waited = waiting.join();
  const bytes = shell.take_output();
  if (bytes.length > 0) post({ output: bytes });
  for (const sound of shell.take_played()) post({ play: sound });
  const events = shell.take_events();
  if (events !== "[]") post({ events });
  const outbox = shell.take_outbox();
  if (outbox.length > 0) post({ outbox });
  for (const note of shell.take_network_notes()) post({ log: `\x1b[33m${note}\x1b[0m` });
  audio();
};

// Several runs may be under way at once; each answers with its own id.
let live = 0;
let timer = null;

// What the terminal says as each stage of the plan is on the machine.
const SAID = { agent: "clai is in", record: "Ready to record", extras: "Every program is in" };
const said = new Set();

// Brings `entry` of the plan: on the machine as soon as it is fetched. One that fails stays
// failed until the page asks again; what waits for it goes on waiting.
const bringOne = async (entry) => {
  const file = files.get(entry.url);
  file.state = "fetching";
  file.got = 0;
  delete file.error;
  report();
  try {
    const bytes = await fetchBytes(entry.url);
    const notes = await (entry.program
      ? shell.install([entry.program], [bytes], [], [])
      : shell.install([], [], [bytes], entry.commands));
    for (const note of notes) post({ log: `\x1b[33m${note}\x1b[0m` });
    file.state = "installed";
    for (const [stage, text] of Object.entries(SAID)) {
      if (!isReady([...files.values()], stage)) break;
      if (said.has(stage)) continue;
      said.add(stage);
      post({ log: `\x1b[2m${text}: ${loaded.files} files, ${(loaded.bytes / 1e6).toFixed(1)} MB, after ${((performance.now() - bootStarted) / 1000).toFixed(1)} s.\x1b[0m` });
    }
  } catch (error) {
    file.state = "failed";
    file.error = String(error?.message ?? error);
    post({ log: `\x1b[31m${entry.name} did not load: ${file.error}\x1b[0m` });
  }
  report();
  drain();
};

// A stage at a time, its files side by side: on a slow link the earlier stage gets all of it.
const bring = async (entries) => {
  for (const { id } of STAGES) await inOrder(entries.filter(({ stage }) => stage === id), 6, bringOne);
};

onmessage = async ({ data: { path, args, env, id, detached, input, size, samples, devices, retry } }) => {
  if (retry) {
    const failed = late.filter(({ url }) => files.get(url).state === "failed");
    for (const { url } of failed) files.get(url).state = "queued";
    return bring(failed);
  }
  if (samples) return shell.push_audio(samples.name, samples.bytes);
  if (devices) {
    for (const { name, label } of devices) {
      try {
        shell.add_audio_input(name, label);
      } catch (error) {
        post({ log: `\x1b[33mno /run/audio/${name}: ${error}\x1b[0m` });
      }
    }
    return;
  }
  if (input) return shell.type_input(input);
  if (size) return shell.resize(size.rows, size.cols);
  live += 1;
  timer ??= setInterval(drain, 30);
  let status;
  try {
    // A detached run is a service: off the console (Shell::spawn).
    status = await (detached ? shell.spawn(path, args, [...(env ?? []), HOST]) : shell.run(path, args, [...(env ?? []), HOST]));
  } catch (error) {
    post({ error: String(error) });
    status = 1;
  }
  if (--live === 0) {
    clearInterval(timer);
    timer = null;
  }
  drain();
  post({ status, id });
};

bring(late);
