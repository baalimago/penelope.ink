# Phase 1 — Summary links

**Parent:** root · **Class:** contract · [README](README.md)

## Goal

`summariesIn` gives the summaries a reply links to, also when a link's text is itself a URL (Background).

## Interface

Written to `web/www/minutes.js`. The function and its clauses are the frozen surface.

```js
/**
 * The meeting summaries an agent's reply links to, as paths under the notebook.
 *
 * - summariesIn.1 — A markdown link `[text](target)` whose target names a file under
 *   `meetings/summaries/` gives that path (`meetings/summaries/<file>`), whether the target is
 *   a `file://` URL, an absolute path or the path under the notebook.
 * - summariesIn.2 — A bare `file://` URL gives its path the same way. It ends at white space,
 *   `]` or `)`, and punctuation that closes a sentence after it (`.,;:!?`) is not part of it.
 * - summariesIn.3 — A link whose text is a URL, `[file://…/X.md](file://…/X.md)`, gives
 *   `meetings/summaries/X.md` once. (E7)
 * - summariesIn.4 — The paths come in the order the reply names them, each once; a link to
 *   anything else (a transcript, a web page) gives nothing.
 *
 * @param {string} reply
 * @returns {string[]}
 */
export function summariesIn(reply) {}
```

Consumes: `notePath` (`web/www/markdown.js`, repository code).

## Acceptance criteria

| #   | Criterion                                                                  | Proves                        | Proof                                                                                   |
| --- | -------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| 1   | The reply of 2026-11-19 gives the summary's real path                      | summariesIn.3, E7             | `node --test units.test.mjs`: "a link whose text is a URL names its summary once"       |
| 2   | Replies that worked before give what they gave                             | summariesIn.1, .2, .4         | `node --test units.test.mjs`: "the agent's links to the notebook open in the app, …"    |

## Test cases

| Test                                                    | Level | Proves                 | Given                                                              | Then                                   | Must not                                  |
| ------------------------------------------------------- | ----- | ---------------------- | ------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------- |
| `a link whose text is a URL names its summary once`     | unit  | summariesIn.3, E7      | `[file:///…/summaries/X.md](file:///…/summaries/X.md)`             | `["meetings/summaries/X.md"]`          | a path holding `](`                       |
| `a bare summary URL ends where its sentence does`       | unit  | summariesIn.2, .4      | a bare URL followed by `.`, one in parentheses, two summaries      | each path once, in order               | a transcript's path; trailing punctuation |
| `the agent's links to the notebook open in the app, …`  | unit  | summariesIn.1          | the existing reply                                                 | the existing path                      | —                                         |

## Error management

None.

## Golden diff

None.

## Removes

None.

## Local facts

None.

## Human required

None.

## Implementation notes

| Run   | Commit      | Command | Result |
| ----- | ----------- | ------- | ------ |
| start | b146a55+wip | `cd web && node --test units.test.mjs`; `cd web && node check.mjs` | 155 passed, 0 failed; check exit 1, 14 FAIL lines (A01) |
| end   | b146a55+wip | `cd web && node --test units.test.mjs`; `cd web && node check.mjs` | 165 passed, 0 failed; check exit 1, the same 14 FAIL lines as the start (A01), none new |
| end   | b146a55+wip | `cd web && node --test units.test.mjs`; `cd web && node check.mjs` | 165 passed, 0 failed; check exit 0 (run with phases 2 and 3 in, after `clai.wasm` was rebuilt at 14:18) |
| end   | b146a55+wip | `cd web && node --test units.test.mjs`; `cd web && node check.mjs` | 165 passed, 0 failed; check exit 0 |

Andon: A01 (the start gate; closed once `clai.wasm` was rebuilt by another session).
Surprises:

- The bare-URL branch also took a sentence's full stop and a closing parenthesis; summariesIn.2 ends it there.

## Review findings

None.
