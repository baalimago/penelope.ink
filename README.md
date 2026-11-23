<p align="center">
  <img src="web/www/favicon.svg" width="112" height="112" alt="Penelope's logo: a red pen with a pink bow on a yellow pad">
</p>

<h1 align="center">Penelope</h1>

<p align="center">Meeting notes, recorded and written in your browser · <a href="https://penelope.ink">penelope.ink</a> · <a href="https://github.com/baalimago/penelope.ink">source on GitHub</a></p>

Penelope records a meeting in a browser tab, transcribes it with the names of who spoke, writes a
summary, and files both as Markdown notes. It runs entirely in the tab: the page boots a small
Linux-like machine (Wasmer's WASIX kernel, compiled to WebAssembly) with bash, ffmpeg and the
[clai](https://github.com/baalimago/clai) AI agent on it. There is no Penelope server. You bring
your own AI provider, and your key stays in your browser. Penelope is also the app's guide: a red
pen with a bow who answers your questions and corrects your notes.

It is a web app: use it at [penelope.ink](https://penelope.ink), or install it from there beside your
native apps, in its own window.

It is for anyone who wants minutes of their calls without installing a native app or handing their
recordings to a notes service, and for developers who want to see real command-line programs run
in a browser.

## What it can do

- **Record** your microphone and the call's sound from a shared tab or screen, or the mic only. On
  a phone it records the mic only.
- **Transcribe with speakers**, through your OpenAI key or your OpenRouter account. The agent
  writes the summary; the transcript is filed word for word as the speech-to-text model heard it,
  and no model writes its lines.
- **Name the speakers.** "Who is speaking?" turns Speaker A and B into names, and a voice library
  in your browser remembers voices, so later meetings name known people by voice.
- **Proofread.** Click a line to correct its words, change its speaker or play it from the
  recording, or the title to rename the meeting. Fix a name once and the app offers to fix it
  everywhere. Save files the corrections.
- **Keep notes** in this browser, or in a [slivingdoc](https://www.slivingdoc.dev) notebook with
  history: slivingdoc.dev's hosted space or your own S3-compatible bucket. slivingdoc is optional.
- **Work in parallel.** Transcribe one meeting while you record the next. A pop-out window, the
  tab's title and system notifications show progress and the time left.
- **Replay and redo.** Play or download a recording this browser kept, or transcribe it again.
- **Ask Penelope.** She answers questions about the app and your meetings, corrects the open
  meeting in pen for you to keep or undo, and can press Transcribe again, New recording or open a
  meeting for you. **+ Tools** (beta) lets her use your Linear issues.
- **Peek under the hood.** See what each click started, opened and connected to, use the machine's
  terminal, and copy or download run logs.
- **Install it** as an app beside your native ones: it is a web app, so **Install Penelope as an
  app** in the sidebar puts it in its own window, in your dock, start menu or home screen (Chrome
  and Microsoft Edge, on a computer or Android).

## How it works

```
browser tab
├─ the app (web/www): the yellow pad, Penelope, and the peek under the hood
└─ Web Worker: one WASIX v2 machine (web/src, kernel from components/wasmer)
   ├─ /bin: clai, bash, coreutils, rg, fd, ffmpeg, slivingdoc, MCP servers
   ├─ /run/audio: the browser's mic and shared tab audio, as files ffmpeg records
   └─ network: each HTTP request becomes the page's own fetch (no proxy, no server)
        └─ your AI provider, slivingdoc.dev, the clai hub
```

1. **Record.** Start recording runs clai with the `meeting-transcriber` profile from the clai hub.
   The agent records with ffmpeg from `/run/audio` until you press Stop and summarize.
2. **Transcribe.** clai sends the recording to your AI provider for a transcript with speaker
   labels, then names the speakers it recognizes from the voice library.
3. **File.** The agent writes the summary into `~/notebook` on the machine, which with slivingdoc
   is a local copy of your hosted notebook. When the run ends, the app moves the recording into
   your browser, writes the transcript's lines itself, word for word from the transcription's
   segments, and, with slivingdoc, commits both files to the hosted notebook.
4. **Review.** The meeting opens with its recording, summary and transcript. You name the
   speakers, correct lines and save.

The agent comes from the clai hub, so the first time the button reads **Trust the agent and start
recording**: it trusts that version of the profile in this browser, and every run is pinned to it.
When the hub publishes a new version, the button asks again before the new one runs. Most controls
run a command on the machine; [docs/app.md](docs/app.md) lists what each one runs.

### clai

[clai](https://github.com/baalimago/clai) is a command-line AI agent written in Go, with profiles,
tools and MCP servers. The build compiles it to WASIX with the Go port in `components/go`, and the
app runs it for every AI step: the meeting-transcriber profile records, transcribes and files a
meeting; Penelope's own profile, [`web/www/penelope.json`](web/www/penelope.json), answers
questions; and `clai audio transcribe voices` manages the voice library.

### The terminal

**Peek under the hood → Terminal** is a shell on the machine; a failure note's link also opens it.
Each line runs in a new bash; try `ls /bin` or `clai help`. `help` lists these commands:

| Command | What it does |
| --- | --- |
| `cd DIR`, `export KEY=VALUE` | Set the directory and the variables later lines start with (the terminal's own commands, like `help` and `clear`) |
| `play FILE` | Plays a sound file, such as a recording, in the page (a small program on the machine) |
| `download FILE...` | Saves files of the machine in your browser's downloads, such as `download ~/notebook/meetings/transcripts/<file>.md` (a small program on the machine) |
| `clear` | Clears the screen |

## Where your data lives

| What | Where |
| --- | --- |
| AI provider key, slivingdoc login, the agent's trust | This browser's local storage for the site, put back on the machine at each load. Each agent run gets the key as an environment variable, and requests go from the browser straight to the provider |
| Notes (summary and transcript) | Without slivingdoc, this browser (IndexedDB), put back on the machine at `~/notebook/meetings/` at each load; with it, your slivingdoc notebook. slivingdoc keeps a notebook in its hosted space at slivingdoc.dev, which **Connect slivingdoc** signs in to, or in your own S3-compatible bucket (slivingdoc's [self-hosted mode](https://github.com/baalimago/slivingdoc)) |
| Recordings | This browser only (IndexedDB), under their meeting. The notebook holds text only, so a recording whose notes are gone stays stored but is no longer listed |
| Voice library | This browser only (IndexedDB). Clips go to your AI provider only inside a transcription's naming requests |
| Run logs | The newest ten runs, in this browser (IndexedDB), with secrets and the model's words taken out |
| clai's conversations | The tab's machine only: after a reload, answering the agent about an earlier meeting starts a new conversation |

AI providers: OpenAI (paste an API key) and OpenRouter (Sign in with OpenRouter). You connect one
at a time; **Disconnect** forgets its key so you can connect the other. Your provider bills you for
what the agent uses.

## Components

| Path | Role |
| --- | --- |
| `web/www` | The app: plain HTML, CSS and JavaScript modules with no build step, the worker that runs the machine, and Penelope's profile and app reference |
| `web/src` | The machine (Rust, compiled to wasm): boots the WASIX v2 kernel, installs `/bin`, streams `/run/audio`, and turns the machine's HTTP into the page's `fetch` |
| `web/profiles` | The source of the agent's clai profile, published to the clai hub as `cchub:baalimago/meeting-transcriber` |
| `web/*.mjs`, `web/packages.txt` | The local server, the registry package list and fetcher, the headless checks, and build helpers |
| `mcp/` | Go ports of MCP servers: the filesystem server the meeting agent starts, and DuckDuckGo for profiles that search, such as `cchub:clai/researcher`; slivingdoc's build for the machine with its libgit2 helper, and `launcher.sh`, the machine's `npx` and `uvx` |
| `audio/` | The ffmpeg build (audio only, for wasm32-wasi), the `ffmpeg` wrapper that offers the page's audio as PulseAudio devices, and `play` |
| `machine/` | Small wrappers in `/usr/local/bin`: `download`, and a `cp` that works where WASI has no file modes |
| `edge/` | The static-site configuration for Wasmer Edge, with the cross-origin isolation headers the page needs |
| `docs/` | How it works in depth |
| `worklogs/` | Design and implementation logs of larger changes |
| `components/clai` | [clai](https://github.com/baalimago/clai), the AI agent |
| `components/go` | Go with a `GOOS=wasix GOARCH=wasm` port, go1.27.3 (fork: [baalimago/go](https://github.com/baalimago/go)) |
| `components/wasmer` | Wasmer, whose WASIX v2 kernel (`lib/wasixv2`) the machine runs on (fork: [baalimago/wasmer](https://github.com/baalimago/wasmer)) |
| `components/wasixv2-abi` | The WASIX v2 ABI and its code generators, to regenerate the Go port's system call glue; the build does not need it ([baalimago/wasixv2-abi](https://github.com/baalimago/wasixv2-abi)) |
| `components/slivingdoc` | [slivingdoc](https://github.com/baalimago/slivingdoc) 1.3.1, the notebook's sync CLI and MCP server |
| `components/libgit2` | [libgit2](https://github.com/libgit2/libgit2) 1.9.6, slivingdoc's git engine, compiled to WASI |

The `components/` entries are git submodules; `go` and `wasmer` are forks of the upstream projects.

## Run it locally

### Prerequisites

- Go 1.24.6 or later, to bootstrap the Go port
- [rustup](https://rustup.rs) (the toolchain in `web/rust-toolchain.toml` installs on first use)
- Node.js 20 or later
- CMake 3.16 or later, make, git, curl and xz
- A C compiler for your computer (`cc`: gcc, clang or Xcode's command line tools), which Rust
  links its build scripts with
- Chrome or Microsoft Edge 137 or later

The build runs cargo from `$CARGO_HOME/bin` (`~/.cargo/bin` by default); set `CARGO_HOME` if your
rustup keeps it elsewhere.

```sh
git clone https://github.com/baalimago/penelope.ink
cd penelope.ink
make dev
```

`make dev` clones the submodules that are missing, builds everything, serves the page on
http://localhost:5001 and opens it in your browser (`PORT` changes the port). The first build takes a few minutes and downloads its toolchains into `.tools/`; later builds
take seconds. It serves until you press Ctrl-C; if no browser opens, go to http://localhost:5001
yourself. Then connect an AI provider in the app, and keep the tab open while a meeting records
and transcribes.

### Build and test

| Command | What it does |
| --- | --- |
| `make build` | Builds everything without serving |
| `make check` | Runs the unit tests and the end-to-end checks in headless Chromium |
| `cd web && npm ci && node --test units.test.mjs` | Runs only the unit tests; needs no build or browser |
| `make clean` | Removes the build output and downloaded toolchains |

`make` never moves a submodule that is already checked out.
[docs/development.md](docs/development.md) has every target and what the checks cover.

## Hosting it on Wasmer Edge

To run your own copy, build it from a clone (see [Run it locally](#run-it-locally)) and deploy it
under your own Wasmer account; fork [the repository](https://github.com/baalimago/penelope.ink)
first if you want to keep changes. Penelope is a static site; it needs only the two cross-origin
isolation headers that `edge/settings/config.toml` sends.

```sh
make dist        # the site in dist/
make check-dist  # dist/ in headless Chromium, with only the headers Edge sends
make deploy      # check-dist, then wasmer deploy
```

`make deploy` needs the `wasmer` CLI (`curl https://get.wasmer.io -sSfL | sh`) and `wasmer login`
(or `WASMER_TOKEN`, a token from your Wasmer account). `OWNER=<your Wasmer user or namespace>` deploys
without asking; `name:` in `edge/app.yaml` is the app's name in that account.

What changes on your own address:

- **slivingdoc:** slivingdoc.dev accepts sign-ins only from the addresses it allows, so on yours
  the notes stay in this browser ([docs/mcp-and-slivingdoc.md](docs/mcp-and-slivingdoc.md)). OpenAI
  and OpenRouter answer any address.
- **The agent:** the app runs `cchub:baalimago/meeting-transcriber` (`profile` in
  `web/www/minutes.js`). To run your own, publish it under your clai hub handle
  ([docs/audio.md](docs/audio.md)) and change that line.
- **The source link:** point `#source-link` in `web/www/index.html` at your fork.

## Limits

- It needs Chrome or Microsoft Edge 137 or later; Firefox and Safari cannot run the machine.
- Recording the call's sound needs a tab or screen share with audio, which depends on the browser
  and system ([docs/audio.md](docs/audio.md)).
- An Android phone needs Chrome or Microsoft Edge 137 or later too, and records the mic only: phone
  browsers cannot share a tab. iPhone and iPad browsers all use Safari's engine and cannot run it.
- One meeting records at a time; others can transcribe meanwhile.
- Two AI providers: OpenAI and OpenRouter.
- Files on the machine are gone when the tab reloads or closes; notes kept without slivingdoc stay
  in this browser only, so clearing the site's data removes them.
- It needs the network: there is no offline mode.
- `npx` and `uvx` run only the MCP servers that have a port in `/bin`; there is no Node.js or
  Python.
- In the terminal, each line is a new bash, so shell variables and functions do not carry over,
  and `^C` ends clai without letting it clean up.

## Documentation

| Page | What it covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The machine in the tab: worker, terminal, loading, network, the peek, and the files of `web/` |
| [docs/app.md](docs/app.md) | What each control runs, the agent and AI providers, the notebook, background runs, the voice library |
| [docs/audio.md](docs/audio.md) | Audio inputs, sharing the computer's sound by browser, ffmpeg, `play` and `download` |
| [docs/mcp-and-slivingdoc.md](docs/mcp-and-slivingdoc.md) | `npx`, `uvx` and the MCP server ports; slivingdoc and libgit2 |
| [docs/development.md](docs/development.md) | Prerequisites, make targets, checks, hosting and the installable app |
| [web/www/penelope-app.md](web/www/penelope-app.md) | The app's screens and controls, as Penelope knows them |
| `components/clai/architecture/` | clai's own design notes, such as `audio.md` for transcription and known voices |
| `components/wasmer/lib/wasixv2/DESIGN.md` | The WASIX v2 kernel |

## License

Penelope is under the [MIT license](LICENSE). The submodules in `components/` keep their own licenses.
