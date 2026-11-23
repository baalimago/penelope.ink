# Architecture: the machine in the tab

Penelope is a static site. The page boots one WASIX v2 machine per tab in a Web Worker, and the
app's buttons run programs on that machine; a few, such as the sign-ins and the recording's player,
work in the page alone. There is no Penelope server: the machine's HTTP
goes out as the page's own `fetch` calls. This page describes the machine; [app.md](app.md) says
what the app runs on it.

```
browser tab
├─ index.html, main.js: the app (minutes.js), Penelope (penelope.js), and the peek under the hood,
│                       whose terminal is xterm.js and a small line editor (shell.js)
└─ worker.js: a Web Worker running the WASIX v2 machine (web/src/lib.rs)
   ├─ console: the peek's terminal, as the machine's /dev/hvc0, while a line runs
   ├─ /bin/clai: clai built with GOOS=wasix GOARCH=wasm (components/go)
   ├─ /bin/npx, /bin/uvx: mcp/launcher.sh, which starts the MCP server ports below
   ├─ /bin/duckduckgo-mcp-server: mcp/duckduckgo-mcp-server, built like clai
   ├─ /bin/mcp-server-filesystem: mcp/mcp-server-filesystem, built like clai
   ├─ /bin/slivingdoc: slivingdoc's release, built like clai with mcp/slivingdoc laid over it
   ├─ /bin/slivingdoc-git2: libgit2 compiled to WASI, which slivingdoc runs its git operations in
   ├─ /bin/ffmpeg, /bin/ffprobe: ffmpeg 5.1.6 for wasm32-wasi (audio/ffmpeg)
   ├─ /usr/local/bin/ffmpeg: audio/ffmpeg.sh, which gives ffmpeg the page's audio as pulse devices
   ├─ /usr/local/bin/play: audio/play.sh, which plays a sound file in the page
   ├─ /usr/local/bin/cp: machine/cp.sh, which keeps cp -a and -p working where WASI has no mode bits
   ├─ /usr/local/bin/download: machine/download.sh, which saves a file of the machine in the browser's downloads
   ├─ /run/audio/mic, /run/audio/tab: the page's microphone and shared tab audio (web/src/audio.rs)
   ├─ /run/page/out: what programs send the page (web/src/outbox.rs)
   ├─ /bin/bash, /bin/ls, ...: Wasmer registry packages (WASIX v1), on the kernel's v1 compatibility ABI
   └─ network: the page's own fetch calls, no proxy and no server: the guest's one-request
                 host call (web/src/host.rs); sockets are refused (web/src/net.rs)
```

## The worker, the console and the terminal

The machine runs in a Web Worker because Chrome compiles and instantiates a module over 8 MB
(clai is about 35 MB) synchronously only off the page's thread. One machine serves every command,
so what clai writes under `~/.config` stays until the tab closes. Each program compiles once, on
its first start. Processes take turns on the worker's one thread: one that computes holds the
others up. No file on the machine outlives a reload; the app keeps what must last in the browser
(see the README's table of where data lives).

Each terminal line runs as a new `bash -c` in the directory the page's `cd` last chose, with what
`export` set, so `cd` and `export` are the page's own (`main.js` `builtins`: `help`, `cd`,
`export`, `clear`). While a line runs, what you type goes to the machine's console, a terminal
whose line discipline is the kernel's, as on Linux: clai's descriptors 0, 1 and 2 and its
`/dev/tty` are that terminal, the kernel echoes and edits what you type, `^C` is SIGINT, and the
window's size reaches the program as the terminal's. Between commands the page's own line editor
reads the prompt.

The app's agent runs are not on the console: the page starts them as services, whose input is
`/dev/null` and whose output shows on the terminal ([app.md](app.md), Runs in the background).

## Loading in stages

The app shows at once, and the machine loads in steps (`web/www/loadplan.js`). `index.html`
starts the worker, which fetches the kernel and what the first screen runs side by side: bash,
coreutils, grep, sed, findutils and the wrappers. The machine boots with those. The rest comes
right after, a stage at a time, in the order a recording needs it: clai; then ffmpeg, ffprobe,
the MCP servers and slivingdoc; then rg, fd and duckduckgo-mcp-server. `/bin` lists a program from
the boot, and what starts one that is not in yet waits for it (`web/src/bin.rs`). The load bar on
the pad says what is not ready yet, **Start recording** waits until a recording can really run, and
a file that fails to load can be fetched again from the bar. To load a program later or sooner,
move it in `STAGES`; a registry package there names its commands. A deployed site serves the large
files gzipped (`web/compress-dist.mjs` lists them in `precompressed.json`), and the worker unpacks
them. `web/stamp-dist.mjs` stamps the site with a hash of its files, in `version.json` and in the
page: a page left open asks for `version.json` when it comes back into view and every quarter hour,
and once the site has moved on and nothing is recording, transcribing or saving, a post-it offers
a reload (`web/www/update.js`).

## The network

The machine's traffic goes out as the page's own `fetch` calls: no proxy behind the page, and no
server of any kind, so a copy of the page served as files runs clai against a model. Every run
has `WASIX_HTTP=host` (`web/www/worker.js`), so Go's `net/http` hands each `http` or `https`
request to the host as data (`components/go/src/net/http/wasix_http.go`), and the page's `fetch`
makes it with the browser's TLS (`web/src/host.rs`). A program that dials a socket itself, or a
line with `WASIX_HTTP=socket`, is refused: the page has no socket to give, and the terminal says
so (`web/src/net.rs`). Name lookups still answer, with addresses in 198.18.0.0/15 that the page
hands out (`web/src/names.rs`), for programs that resolve a name before they fetch.

The host call is one function in the guest ABI (`http-open`,
`components/wasixv2-abi/wit/ext.wit`): the request as `u32` counts and then the bytes — method,
URL, header count and pairs, body — and the response the same shape with a status in front. The
guest reads it as a descriptor: the head, then the body, then 0. TLS is the browser's, so nothing
is plaintext on any wire; the host never follows a redirect, and refuses `host`, `content-length`,
`connection`, `user-agent` and `accept-encoding`, which the browser sets or refuses itself. A
runtime without the call answers `ENOSYS`, and the port's transport then falls back to a socket,
which a native runtime has.

The page must be allowed by the target: a cross-origin request is a CORS request, so a provider
must answer the page's origin for a preflight. OpenAI's API, OpenRouter's (its key exchange
included) and slivingdoc's do. `make check` runs `web/check-fetch.mjs`, which drives a model on
the page's own origin (`web/server.mjs`, `/test/v1`) through the host call, and shows that a socket
is refused with the reason. It also runs `web/check.mjs`, whose `slivingdoc` rows sign in and out
against the stub site `web/server.mjs` serves on the page's own port: no cloud account, and no
CORS request.

So a query to an OpenAI-compatible endpoint with your own key works from the terminal, streamed,
with nothing configured first:

```
OPENAI_API_KEY=sk-… clai -cm gpt-4.1-mini query "what is wasix?"
```

## Messages to the page

Programs send what the app reads to `/run/page/out` (`web/src/outbox.rs`), a write-only file
whose every write, once closed, reaches the page as one message whose first line names it
(`reply`, `meetings`, `meeting`, `history`, and `download-part`/`download-end` for `download`). A
message holds 16 MiB.

## The peek under the hood

The peek is built from the kernel itself: the WASIX v2 trace layer
(`components/wasmer/lib/wasixv2/trace`) reports each `execve`, exit, open, `connect`, `dup`,
close, rename, mkdir and unlink that succeeds, and the bytes through each descriptor, for every
process, WASIX v1 programs such as bash and ffmpeg included. `web/src/observe.rs` keeps them
until the page takes them, as JSON, adding up the bytes a descriptor moves between two other
events and naming the host behind each address the machine's resolver handed out. Each line runs
as `bash -c LINE TAG`, so a process's tag, from its `$0` and inherited by what it starts, says
which click or terminal line it belongs to. The view (`web/www/hood.js`) has four tabs:
**Activity** (the last click's line, its process tree with each process labelled — the agent, an
MCP server, libgit2, the recording ffmpeg — and the event log), **Network and files** (the
connections by host and the files written, with the bytes moved through redirections and inherited
descriptors counted for the file or connection behind them), **Terminal**, and **Run logs**. The
app's progress steps come from the same events: the ffmpeg with an input is the recording, a
connection to the AI provider (api.openai.com, openrouter.ai) after it the transcription, one from
slivingdoc the save.

## What runs on the machine

- `clai help`, `clai version`, `clai confdir` and anything else that only prints.
- Live queries: each HTTP request is one host call that the page's `fetch` makes. Nothing leaves
  except what the browser allows, and the guest never terminates TLS.
- Interactive prompts: `clai setup`, `clai chat list` and the like read from the terminal, with
  the kernel editing the line as you type it, and `^C` stops clai.
- Starting programs: Go's `os/exec` starts them through wasixv2's `spawn` (`posix_spawn` in one
  call), with pipes, `Dir` and `Env`, and WASIX v1 programs start others as on wasmer's v1
  runtime, so clai's shell tools and `-add-shell-context` can run `sh -c`, rg and find (git too, where the
  registry has the optional `wasmer/git` package; today's build has none). A
  shell context's first variable starts bash, which compiles first, so give it a `timeout_ms` of
  some seconds rather than the 100 ms default.

Limits: each line is a new bash, so shell variables, functions and jobs do not outlive it; guest
threads run on the worker's one thread, so rg and fd search with one core; `^C` kills clai rather
than letting it clean up, because the Go port cannot deliver signals to Go code yet, so
`os/signal` never hears of SIGINT and its default action ends the process.

## Files

The machine (Rust, `web/src`, built with wasm-bindgen into `web/www/pkg`):

| Path | What it is |
| --- | --- |
| `web/src/lib.rs` | The machine: boots once per page with the CA bundle mounted and the first packages in `/bin`, takes the other programs as they arrive (`Shell::install`), compiles each program once, runs a file as often as asked |
| `web/src/bin.rs` | `/bin` and `/usr/bin`: a file per command; one that arrives after the boot is listed from the start, and opening it waits for it |
| `web/src/packages.rs` | Installs webc packages as `wasmer run` does: commands in `/bin`, with their `wasi` annotations for v1 programs, and volumes where the package says |
| `web/src/audio.rs` | `/run/audio`: the page's audio inputs as files that stream while they are open |
| `web/src/outbox.rs` | `/run/page/out`: each closed write reaches the page as one message |
| `web/src/host.rs`, `web/src/jshttp.rs` | The page as the machine's host: `http-open`, one whole request and its streamed response per descriptor, over the page's `fetch` |
| `web/src/net.rs`, `web/src/names.rs` | The machine's sockets: name lookups answered with addresses the page hands out, and every connection refused with the reason |
| `web/src/observe.rs` | The kernel's trace events, kept for the peek |

The app (`web/www`, plain JavaScript modules, no build step):

| Path | What it is |
| --- | --- |
| `index.html`, `main.js` | The page: starts the worker, wires the app, the peek and the terminal |
| `worker.js`, `loadplan.js`, `loadbar.js` | The worker that runs the machine, the order programs load in, and the pad's load bar |
| `minutes.js` | The app's core: recording, the agent's runs, filing, saving, sign-ins, Penelope's input |
| `agent.js`, `records.js` | clai's `-json` records: the reply and failures for the app, and their drawing on the terminal |
| `jobs.js`, `popout.js` | Runs in the background and their time left; the pop-out window, tab title and notifications |
| `audio.js` | Captures the microphone and a shared screen's or tab's audio for `/run/audio` |
| `proofread.js`, `review.js`, `people.js` | Proofreading the transcript; **Who is speaking?**; **Who is in the meeting?** on New recording |
| `voicekeeper.js`, `segmentkeeper.js`, `recordings.js`, `notebookkeeper.js`, `runlog.js` | What the browser keeps in IndexedDB: the voice library, each meeting's segments, its recording, the notes while no slivingdoc notebook is connected, and run logs |
| `player.js`, `downloads.js` | The recording's player at the top of a meeting; files `download` sends |
| `penelope.js`, `penelope.json`, `penelope-app.md` | Penelope: her bubble and moods, her clai profile, and the app reference she reads |
| `providers.js`, `connections.js`, `signin-callback.html` | AI providers and their sign-in; Penelope's **+ Tools** (Linear) OAuth; the sign-in callback page |
| `hood.js` | The peek under the hood |
| `markdown.js` | The agent's markdown as safe HTML |
| `shell.js` | The terminal's line editor and word splitter |
| `arrival.js`, `handwriting.js`, `pen.js`, `doodles.js`, `sketch.js`, `pageturn.js`, `pointer.js`, `drawer.js` | The pad's look and motion: the arrival checklist, wet ink, the writing pens, the ballpoint's doodles, the user's doodle pen, page turns, the red ring that points at a card, and the sidebar drawer on narrow screens |
| `style.css`, `pad.css`, `popout.css` | The machine's styles, the yellow pad over them, and the pop-out window |
| `manifest.json`, `favicon.svg`, `icon-*.png`, `apple-touch-icon.png`, `favicon.ico` | The installable app's name and icons; `web/icons.mjs` renders the PNGs and `.ico` from `favicon.svg` |
| `install.js` | The sidebar's **Install Penelope as an app**: opens the browser's own install prompt once the browser offers one |
| `update.js` | The blue post-it that offers a reload once a newer version of the site is deployed |

Tooling (`web`):

| Path | What it is |
| --- | --- |
| `web/server.mjs` | Serves the page's files with the cross-origin isolation headers, plus the checks' model and stub slivingdoc site; it listens on 127.0.0.1:5001 (`PORT` changes the port) and prints http://localhost:5001/ to open |
| `web/packages.txt`, `web/fetch-packages.mjs` | The registry packages, and the script that downloads them to `web/www/packages` |
| `web/units.test.mjs` | Unit tests of the page's logic that needs no browser |
| `web/check.mjs`, `web/check-fetch.mjs`, `web/check-dist.mjs` | The headless Chromium checks behind `make check` and `make check-dist` |
| `web/mcp-standin.mjs`, `web/voices-standin.mjs`, `web/goldens/` | Stand-ins and golden files the checks use |
| `web/compress-dist.mjs`, `web/stamp-dist.mjs`, `web/icons.mjs` | Gzips a built site's large files; stamps it with its version; renders the icons |
