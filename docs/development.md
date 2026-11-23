# Development: build, check and deploy

## Prerequisites

- Go 1.24.6 or later on `PATH`, to bootstrap the Go port (`components/go`)
- [rustup](https://rustup.rs); `web/rust-toolchain.toml` pulls Rust 1.96 and the
  `wasm32-unknown-unknown` target on first use
- Node.js 20 or later
- CMake 3.16 or later and curl, for libgit2 and ffmpeg: the build downloads the
  [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 25 into `.tools/` to compile them
- Chrome or Microsoft Edge 137 or later, for JavaScript Promise Integration (JSPI)

The build installs `wasm-bindgen` into `.tools/` at the version the page's crate needs, and
downloads the ffmpeg 5.1.6 and LAME 3.100 releases there, each checked against its SHA-256. Build
output goes to `.build/`, `web/target/` and the ignored parts of `web/www` (`clai.wasm`, `bin/`,
`pkg/`, `packages/`, `ca-certificates.crt`).

## Make targets

| Command | What it does |
| --- | --- |
| `make dev` | Builds everything, serves the page on http://localhost:5001 and opens it in your default browser. `web/server.mjs` listens on 127.0.0.1; `PORT` changes the port. Use one address consistently: `localhost` and `127.0.0.1` are different origins, each with its own stored keys, recordings and voices |
| `make build` | Builds without serving: the Go port, clai and the MCP servers for it, slivingdoc with libgit2, ffmpeg, the machine's crate, the registry packages and `node_modules` |
| `make submodules` | Clones each submodule that is not checked out yet, at the commit the repository records |
| `make packages` | Downloads the registry packages `web/packages.txt` lists, from registry.wasmer.io |
| `make check` | Installs Playwright's Chromium, then runs `npm test` in `web/`: the unit tests, `check-fetch.mjs` and `check.mjs` |
| `make dist` | The static site in `dist/` |
| `make check-dist` | `make dist`, then the site in headless Chromium with only the headers Wasmer Edge sends |
| `make deploy` | `make check-dist`, then `wasmer deploy` |
| `make clean` | Removes `dist/`, the build output, `.tools/`, `.build/` and `node_modules`, and cleans the Go port |

The first build takes a few minutes (the Go port and the wasm kernel); later ones take seconds.
clai and the Go programs rebuild on every `make`.

`make submodules` keeps wasmer's own test suites out, because a recursive clone fails on one of
their pinned commits. A submodule that is already checked out keeps its branch and commit: `make`
never moves it, so updating one is up to you (`git submodule update`, or git in it).

The unit tests alone need no build or browser, only the page's node packages:
`cd web && npm ci && node --test units.test.mjs`.

## What the checks cover

`web/units.test.mjs` covers the page's logic that needs no browser. `make check` runs the page in
headless Chromium with clai's test models and stand-ins for the outside services, and checks,
among others, that:

- `clai help` prints clai's usage (and `clai h` fails with it, as natively), clai reads its terminal, and lines run in bash;
- clai calls the MCP servers `uvx` and `npx` start, its async commands run, and slivingdoc serves
  with libgit2 behind it;
- ffmpeg records Chromium's fake microphone, and the meeting-transcriber profile records and
  transcribes with it;
- the app shows and the machine boots while clai is still to come, a line that runs clai waits
  for it, and a failed load can be tried again;
- Penelope greets with her guide, answers with no meeting open and with her own profile, and
  attaches Linear under **+ Tools** against a stand-in for mcp.linear.app (`web/mcp-standin.mjs`);
- Sign in with OpenRouter works against a stand-in for its sign-in page and key exchange;
- Start recording runs through to the agent's reply, and starts nothing when a stand-in hub has
  replaced the profile this browser trusted;
- a line of a filed transcript is corrected and saved;
- a second meeting records while the first still writes its notes; both file; a recording plays,
  downloads, transcribes again, and is followed and stopped in the pop-out window.

## Hosting it on Wasmer Edge

The page needs no server of its own: the machine's HTTP goes out as the page's `fetch` calls, and
OpenAI's API and OpenRouter's (its key exchange included) answer a browser's CORS preflight, and
slivingdoc's does for the origins its site allows. So it is a static site:

```sh
make dist        # dist/: the site; the large files in dist/public are gzipped (about 50 MB)
make check-dist  # the dist in headless Chromium, served with only the headers Wasmer Edge will send, and installable
make deploy      # check-dist, then wasmer deploy: the site on Wasmer Edge
```

`make deploy` needs the `wasmer` CLI (`curl https://get.wasmer.io -sSfL | sh`, or the `wasmer`
of `components/wasmer`, built) and a login (`wasmer login`, or `WASMER_TOKEN`). `make dist`
rebuilds `dist/` from `edge/` every time, so the owner `wasmer deploy` writes into `dist/app.yaml`
does not last: `make deploy OWNER=<user or namespace>` names it, or `wasmer deploy` asks. `name:`
in `edge/app.yaml` is the app's name in that account; the live site's is `clai-minutes`.

A copy at another address cannot sign in to slivingdoc.dev unless slivingdoc allows that address,
so its notes stay in that browser; and it runs the same hub profile, `cchub:baalimago/meeting-transcriber`
(`profile` in `web/www/minutes.js`), until that line names your own ([audio.md](audio.md)).

`dist/` is `edge/` (a `wasmer.toml` that serves `public` with `wasmer/static-web-server`, its
`settings/config.toml`, and an `app.yaml`) and `dist/public`, which is `web/www` and what it
loads from `node_modules` (`@xterm`, `@fontsource` and `marked`). The one thing the site must send is a pair of headers,
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`,
which make the page cross-origin isolated so that guest memory can be a `SharedArrayBuffer`;
`edge/settings/config.toml` adds them to every file, with `Cache-Control: no-cache` so a deploy
is seen at once. A tab left open sees it too: `make dist` stamps the site with a hash of its
files (`web/stamp-dist.mjs`, in `version.json` and the page's `penelope-version` meta), and the
page offers a reload on a blue post-it once the site's version differs from its own and nothing
is recording, transcribing or saving (`web/www/update.js`). `make dev` serves an unstamped page,
which never asks. The same package runs locally with `wasmer run dist --publish 8080:8080` (the
`wasmer` of `components/wasmer`; a released `wasmer` takes `--net` instead), and
`DIST_URL=http://127.0.0.1:8080/ node web/check-dist.mjs` checks it. Wasmer Edge takes up to 500 MB
of files per app.

A new domain for the site is a new browser origin: it does not see what an old origin's browsers
kept (recordings, the voice library, sign-ins). Keep the old address reachable for anyone who needs
to download their recordings.

## The installable app

Penelope is a web app that installs beside the native ones, in its own window. The sidebar's
**Install Penelope as an app** (`web/www/install.js`) opens Chrome's or Microsoft Edge's own install
prompt once the browser offers one (`beforeinstallprompt`, Chrome and Edge on a computer or
Android). It is hidden in the installed app and where the browser offers nothing; Safari, which
cannot run the machine, gets no button. The browser's own install button in the
address bar or menu works too, from the site on Wasmer Edge as from localhost. `web/www/manifest.json` gives it its
name and icons, and `make check-dist` checks that Chromium reads them. The icons are
`web/www/favicon.svg`; `node web/icons.mjs` renders it into the PNG and `.ico` ones. There is no
service worker, so the app loads from the site each time, as the tab does, and needs the network.

## The agent's profile

The meeting-transcriber profile's source is `web/profiles/meeting-transcriber.json`; it is published
to the clai hub, and the app runs the hub's version ([audio.md](audio.md) has the publish command).
Penelope's profile, `web/www/penelope.json`, ships with the site.
