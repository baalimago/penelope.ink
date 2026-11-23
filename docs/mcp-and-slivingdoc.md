# MCP servers and slivingdoc

The agent keeps the notes through MCP servers: slivingdoc for the hosted notebook, and a
filesystem server for files on the machine. This page says how they run in the browser machine,
which has no Node.js or Python.

| Path | What it is |
| --- | --- |
| `mcp/launcher.sh` | `npx` and `uvx`: run the packages that have a port in `/bin`, and say so for the others |
| `mcp/mcpserver` | The MCP stdio server (JSON-RPC, initialize, tools) the Go ports share |
| `mcp/mcp-server-filesystem` | A Go port of [@modelcontextprotocol/server-filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) 2.1.0: its 14 tools, arguments and output, confined to the directories it is given |
| `mcp/duckduckgo-mcp-server` | A Go port of [duckduckgo-mcp-server](https://github.com/nickclyde/duckduckgo-mcp-server) 0.7.0: its tools, arguments, output and `DDG_*` settings |
| `mcp/slivingdoc` | What slivingdoc needs on wasix: its libgit2 helper and the Go files and `x/sys` that build it for the port (below) |
| `components/slivingdoc`, `components/libgit2` | slivingdoc 1.3.1 and the libgit2 1.9.6 it pins |

## npx and uvx

clai profiles start MCP servers with `npx` (Node.js) and `uvx` (Python), and the machine has
neither runtime that could run them:

- Python: the registry's `python/python` 3.13 runs, but MCP servers need the `mcp` package,
  whose dependencies (`pydantic-core`, `rpds-py`, `cryptography`) are native extensions. The
  [WASIX index](https://python-registry.wasix.org/) has them as shared libraries, and the
  kernel's WASIX v1 layer refuses `dlopen`.
- Node.js: the registry's `wasmer/edgejs` has `node`, `npm` and `npx`, but no JavaScript
  engine of its own: it imports N-API from its host (wasmerio/napi has a browser backend for
  wasmer-js), which the WASIX v2 machine does not provide yet.

So `npx` and `uvx` are `mcp/launcher.sh`, which accepts their usual forms (`npx -y pkg@1.2.3
args`, `uvx pkg==1.2.3 args`, `--from`) and runs the package's port from `/bin`, ignoring the
version. `cchub:baalimago/meeting-transcriber` starts slivingdoc and Filesystem;
`cchub:clai/researcher` starts ddg:

| Server | Command | Here |
| --- | --- | --- |
| ddg | `uvx duckduckgo-mcp-server==0.7.0` | Runs the Go port: `search`, `fetch_content` and `expand_link` give the Python server's output, and a live search answers from the page |
| slivingdoc | `npx -y slivingdoc serve` | Runs slivingdoc 1.3.1 itself, with libgit2 1.9.6 in a helper process (below) |
| Filesystem | `npx -y @modelcontextprotocol/server-filesystem /tmp/ .` | Runs the Go port: the tools give the Node server's text, diffs included, and refuse paths, symlinks too, outside the directories given. It takes its directories only from its arguments, not from MCP Roots |

A remote MCP server needs no port: Penelope's **+ Tools** (beta) adds Linear by its URL, and clai
reaches it over the page's `fetch` ([app.md](app.md)).

The Go port has no threads, so a read that blocks in the kernel would stop every goroutine. The
port polls a descriptor outside the netpoller (a terminal, a pipe) until it is readable, sleeping
the goroutine in between, and only then reads it. The ddg port, which predates that, also puts
stdin in the netpoller (`mcp/duckduckgo-mcp-server/stdin_unix.go`).

## slivingdoc and libgit2

slivingdoc is optional: without it the notes stay in this browser. With it, the notebook lives in
slivingdoc.dev's hosted space, which **Connect slivingdoc** signs in to, or in your own
S3-compatible bucket (slivingdoc's self-hosted mode, `slivingdoc serve --bucket`).

slivingdoc (`components/slivingdoc`, at its v1.3.1 tag) is Go, and its git engine is libgit2
through cgo, which the Go port does not have. Its `internal/git2` package is the only libgit2
boundary: twenty seam functions, one per libgit2 operation. So the machine runs libgit2 in a
process of its own:

- `mcp/slivingdoc/git2/helper.c` is `/bin/slivingdoc-git2`: libgit2 1.9.6
  (`components/libgit2`), compiled to WASI with the wasi-sdk and linked into a small program
  that runs one operation per request on stdin and answers on stdout. It runs on the kernel's
  WASIX v1 layer, like bash. `mcp/slivingdoc/git2/wasi/` has the few POSIX headers and calls
  libgit2 names that WASI leaves out, for paths slivingdoc never takes (network transports,
  child processes); they fail as a host without them would.
- `mcp/slivingdoc/native_wasix.go` takes the place of slivingdoc's cgo file on wasix: the same
  seam functions, each one request to the helper, which it starts at libgit2's init.
- `mcp/slivingdoc/stdin_wasix.go` puts slivingdoc's stdin in the netpoller, as above.
- `mcp/slivingdoc/wasix.sh` lays those files over the checkout with `go build -overlay`, so it
  stays at the release, and gives the build a copy of `golang.org/x/sys` that builds for wasix
  (its `unix` package is linux's, and the port is linux/loong64's types with riscv32's
  system call numbers, so the loong64 files serve, renumbered).

slivingdoc's own `internal/git2` tests pass through the helper, natively and in the page,
except two that cannot: libgit2 here is built without threads, and a test that reads the
source tree for `os/exec` finds the helper's. To run them natively, build the helper with the
host's compiler against a native libgit2 and run
`CGO_ENABLED=0 go test -tags git2helper ./internal/git2/` in a checkout with
`native_wasix.go` copied in and the helper on `PATH`.

slivingdoc keeps the notebook in its hosted storage or an S3 bucket. Without a credential,
`serve` signs in on the first tool call: it prints an approval link on its stderr and waits.
`slivingdoc login` in the page does the same up front, and the login it stores serves the
servers clai starts afterwards. With a credential, pull, commit, log and slivingdoc's three-way
merges, conflict markers included, run in the page: two writers in it, against slivingdoc's
reference storage server (`internal/httpstore/gatewaytest`) also in it, pull, commit and
conflict as they do natively.

`fetch_content` (ddg) refuses addresses that are not public, as the Python server does, so a
network whose DNS answers with private addresses (a VPN's fake IPs in 198.18.0.0/15, say) needs
`DDG_ALLOW_PRIVATE_URLS=1`. The page's own resolver answers every name with an address in
198.18.0.0/15 ([architecture.md](architecture.md), The network), so in the page `fetch_content`
needs that setting too; `search` does not check addresses. slivingdoc's site answers CORS only for the origins it allows, so a
copy of Penelope at an origin it does not allow cannot sign in at all: the site's CORS headers are
its owner's work.
