// Minutes: meeting notes recorded, transcribed and filed by clai's meeting-transcriber agent,
// in a notebook slivingdoc keeps. Each button runs a program on the machine: the agent records
// (its audio_record tool starts ffmpeg), transcribes and files the notes; the app starts it,
// answers it and reads the notebook, which programs send it through /run/page/out.

import { bytes, mask } from "./hood.js";
import { notePath, renderMarkdown } from "./markdown.js";
import { audioLimits, isPhone } from "./audio.js";
import { AgentRun, problemOf } from "./agent.js";
import { RecordPrinter } from "./records.js";
import { Fixes, Proofreader, frontLines, isLabel, marksToHtml, named, offerWhere, resolveConflicts, singleChange, transcriptLines, transcriptRows } from "./proofread.js";
import { Penelope, correctionsOf, guideText, penelopeQuery, parseSay } from "./penelope.js";
import { PROVIDERS, SIGNIN_CHANNEL, activeProvider, authorizeUrl, exchangeCode, pkce, providerById, providerFlags, sha256Hex } from "./providers.js";
import { RunLog, logName } from "./runlog.js";
import { restoreBatches } from "./notebookkeeper.js";
import {
  MCP_SERVERS, STORED_MCP, discover, exchangeSignin, mcpServerById, mcpState, register, revokeSignin, signinUrl, tokenName, withServers,
} from "./connections.js";
import { Popout, running, statusIcon, tabStatus } from "./popout.js";
import { Player, recordingName } from "./player.js";
import { toBase64 } from "./recordings.js";
import { pageOf, turnPage, turnsBack, turnsPage } from "./pageturn.js";
import {
  PACE, PROVIDER_PACE, audioSeconds, clock, estimate, jobStatus, learnPace, leftText, listedJobs, newJob, recordingJob, stopFileOf, summaryOf, takeRecord,
  transcribeDetail,
} from "./jobs.js";

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// clai flags joined, with the space before what follows them, or "".
export const withFlags = (...flags) => {
  const line = flags.filter(Boolean).join(" ");
  return line ? `${line} ` : "";
};

/** @typedef {import("./segmentkeeper.js").Segment} Segment */
/** @typedef {import("./segmentkeeper.js").NamingReport} NamingReport */
/** @typedef {import("./segmentkeeper.js").LearnedClip} LearnedClip */
/** @typedef {import("./review.js").Choice} Choice */

/**
 * The run flag that names a meeting's people.
 *
 * - voicesFlag.1 — "" for no name. (P3)
 * - voicesFlag.2 — Otherwise `-voices <names> `, the names joined by commas
 *   and quoted for the shell as one word: `-voices 'Lorentz,Christoph' `.
 *   (known-voices:Flag.1, Flag.3)
 *
 * @param {string[]} names
 * @returns {string}
 */
export function voicesFlag(names) {
  return names?.length ? `-voices ${quote(names.join(","))} ` : "";
}

/**
 * The query's paragraph that names a meeting's people.
 *
 * - peopleLine.1 — "" for no name (P3); otherwise `People: ` and the names
 *   joined by ", ": `People: Lorentz, Christoph`.
 *
 * @param {string[]} names
 * @returns {string}
 */
export function peopleLine(names) {
  return names?.length ? `People: ${names.join(", ")}` : "";
}

// The query with its People paragraph last, or as it is for nobody.
const withPeople = (query, names) => (names?.length ? `${query}\n\n${peopleLine(names)}` : query);

/**
 * What an `audio_transcribe` result holds, read from its json output.
 *
 * - heardOf.1 — For `{"segments": […], "naming": {…}}` it is
 *   `{segments, naming}`, the segments and the report as parsed.
 *   (known-voices:Output.1, Output.2)
 * - heardOf.2 — For the bare array of segments it is
 *   `{segments, naming: null}`. (known-voices:Output.4)
 * - heardOf.3 — For anything else (text that is no JSON, another shape) it
 *   is null.
 *
 * @param {string} output
 * @returns {{segments: Segment[], naming: NamingReport|null}|null}
 */
export function heardOf(output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (Array.isArray(value)) return { segments: value, naming: null };
  const named = value && typeof value === "object" && Array.isArray(value.segments) && value.naming && typeof value.naming === "object" && !Array.isArray(value.naming);
  return named ? { segments: value.segments, naming: value.naming } : null;
}

/**
 * The clip a record of a run says the run learned.
 *
 * - learnedOf.1 — For a `tool_result` record named `audio_remember_voice`
 *   that did not fail and whose output's first line is
 *   `<name>: clip <id> added (unconfirmed)`, `<id>` 12 lower-case hex
 *   digits, it is `{name, clip: id}`; a second line changes nothing.
 *   (known-voices:audio_remember_voice CallWithContext.11, .12)
 * - learnedOf.2 — For every other record it is null: a failed call, another
 *   tool, another line.
 *
 * @param {object} record  one of clai's -json records
 * @returns {LearnedClip|null}
 */
export function learnedOf(record) {
  if (record?.type !== "tool_result" || record.name !== "audio_remember_voice" || record.ok === false) return null;
  const m = /^(.+): clip ([0-9a-f]{12}) added \(unconfirmed\)$/.exec(String(record.output ?? "").split("\n")[0]);
  return m ? { name: m[1], clip: m[2] } : null;
}

/**
 * The people a meeting's kept segments named.
 *
 * - namedIn.1 — The distinct `speaker` of the segments that carry a
 *   `voice`, in order of first appearance; [] for none. (P7)
 *
 * @param {Segment[]} segments
 * @returns {string[]}
 */
export function namedIn(segments) {
  return [...new Set((Array.isArray(segments) ? segments : []).filter((s) => s?.voice && typeof s.speaker === "string" && s.speaker).map((s) => s.speaker))];
}

/**
 * The arguments after `clai audio voices` that carry out a choice.
 *
 * - voicesCommand.1 — Keep: `["list", <slug>, <id>, "confirm"]`, from its
 *   clip "<slug>/<id>". (known-voices:confirm.1, list.7)
 * - voicesCommand.2 — Overrule: `["list", <slug>, <id>, "overrule"]`.
 *   (known-voices:overrule.1, list.7)
 * - voicesCommand.3 — Remember: `["add", wav, "-from", <start>, "-to",
 *   <end>, "-name", <name>]`, the times as JavaScript writes the numbers
 *   (61.2, 69). (known-voices:add.1, voices.5)
 *
 * @param {Choice} choice
 * @param {string} [wav]  the recording's path on the machine, for Remember
 * @returns {string[]}
 */
export function voicesCommand(choice, wav) {
  if (choice.kind === "remember") return ["add", wav, "-from", String(choice.start), "-to", String(choice.end), "-name", choice.name];
  const [slug, id] = choice.clip.split("/");
  return ["list", slug, id, choice.kind === "keep" ? "confirm" : "overrule"];
}

// The review's line while the names go into the transcript and the summary (show.6).
export const NAMING_STEP = "Writing the names in the transcript and the summary…";

// The review's line while choice `i` of `count` runs (show.6).
export function choosingStep(choice, i, count) {
  const of = count > 1 ? `, ${i + 1} of ${count}` : "";
  if (choice.kind === "remember") return `Remembering ${choice.name}'s voice${of}…`;
  if (choice.kind === "overrule") return `Telling the voice library ${choice.from} is ${choice.to}${of}…`;
  return `Keeping the voice${of}…`;
}

// Where meetings go, which the agent reads at the top of its query: its profile and slivingdoc's
// own settings stay as they are, so the agent works the same elsewhere. Signed out of
// slivingdoc, the notes stay in the browser's notebook, and that is the user's choice: the agent
// neither looks for slivingdoc nor asks them to sign in.
// The model's own pick overrides audioConfig.json, and a 15 s pick ended two real meetings: pin it.
export const SILENCE_SECONDS = 300;
// How long a recorded shared tab may stay silent before the app asks if it is the right one.
export const QUIET_MS = 60_000;
const MEETING_FILES =
  "meetings/summaries/<start>_<slug>.md and meetings/transcripts/<start>_<slug>.md, " +
  "<start> in the form 2026-10-30T08-00Z. Begin each with front matter holding title, date " +
  "(ISO 8601) and duration (minutes). Give the transcript file its front matter only: when you finish, the app " +
  "puts audio_transcribe's output below it word for word, so never write or rewrite the transcript's lines, and never " +
  "copy, move or paste the transcription into the file, not even from a file a long tool output was saved in. " +
  "Record with audio_record's dir set to /tmp/recordings, " +
  `so the audio stays out of the notebook, and its silence_timeout_seconds set to ${SILENCE_SECONDS}: ` +
  "a meeting has quiet stretches, and the user stops the recording. In the summary, name a speaker only when the recording " +
  "makes clear who it is; otherwise use the transcription's labels (Speaker A, Speaker B) and do not ask: the app " +
  "asks the user who they are.";

export function notebookFormat(connected) {
  return connected
    ? `Notebook format for this app: keep each meeting in the slivingdoc notebook as two files, ${MEETING_FILES}`
    : "Notebook format for this app: the user keeps their notes on this machine and chose not to sign in to " +
      "slivingdoc. Do not use slivingdoc, do not mention it and do not ask the user to sign in. Write each " +
      `meeting as two files in the current directory, which is the notebook: ${MEETING_FILES}`;
}

export const DEFAULTS = {
  // No version tag: the hub serves the profile's latest release.
  profile: "cchub:baalimago/meeting-transcriber",
  flags: "",
  env: "",
  // clai's LOG_LEVEL on the agent's runs (failure-reports Q1); "" leaves clai's own.
  logLevel: "debug",
  notebook: "~/notebook",
  // The slivingdoc space meetings go to, when the login has it.
  space: "notes",
  // The agent's query: the format, the meeting, then the inputs the user set up to record.
  query: (title, details, connected, inputs = "") =>
    `${notebookFormat(connected)}\n\nMeeting: ${title}.${details ? ` ${details}` : ""}${inputs ? `\n\n${inputs}` : ""}`,
};

// What the agent records, as the checklist left it: the mic, and the computer's audio unless the user left it out.
export function inputsToRecord(micOnly, computer) {
  if (!computer) return "Record only the user's mic, browser-mic: the computer's audio is not available.";
  if (micOnly) return "Record only the user's mic, browser-mic: the user left the computer's audio out.";
  return `Record the user's mic, browser-mic, and the computer's audio, ${computer.source} (${computer.label}), together: ` +
    "the user set both up for this meeting.";
}

// The checklist before a recording, from AudioInputs.access(): the mic, the computer's audio
// and sound heard from it, each `{ id, done, text, action }`, an action being a line to click
// that asks the browser. `share` is audioLimits' share words, or null where this browser shares
// no sound; `micOnly` skips the computer's audio, `heard` and `silent` say what listening found.
// A recording may start only when it is `ready`, which needs no sound heard.
export function precheck({ mic, computer }, share, { micOnly = false, heard = false, silent = false, phone = false }) {
  const monitor = computer?.via === "monitor";
  const items = [
    { id: "mic", done: Boolean(mic), text: mic ? `Mic: ${mic}` : "Allow the mic", action: !mic },
    {
      id: "computer",
      done: Boolean(computer) || micOnly,
      text: phone ? "The call on speaker, near the phone" : computer ? `Computer audio: ${computer.label}` : micOnly ? "Computer audio: skipped, mic only"
        : share ? `${share} with your call` : "Computer audio: this browser can't record it",
      action: !computer && !micOnly && Boolean(share),
    },
    {
      id: "sound",
      done: monitor || (computer ? heard : micOnly),
      text: monitor ? "Sound comes through the monitor" : computer ? (heard ? "Sound heard" : silent ? "No sound yet. You can still start." : "Listening for sound…")
        : micOnly ? "Sound: your mic only" : "Hear the call's sound",
      action: false,
    },
  ];
  // Sound is not waited for: a recording may start before anyone speaks (watchQuiet asks later).
  return { items, ready: items.filter((i) => i.id !== "sound").every((i) => i.done), sharing: computer?.via === "share" };
}

// Front matter fields of a markdown file, and its body.
export function parseNote(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body: text.slice(match[0].length) };
}

// `text`, a note, with its front matter's title `title` (whitespace folded), which parseNote reads
// back as given: quoted when it holds what a YAML reader would take for more than text.
export function retitled(text, title) {
  const name = String(title).replace(/\s+/g, " ").trim();
  const value = /^[\s"'`!&*|>%@?\-[\]{}#,]|: | #|:$/.test(name) ? `"${name.replaceAll('"', "'")}"` : name;
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return `---\ntitle: ${value}\n---\n\n${text}`;
  const lines = match[1].split("\n");
  const at = lines.findIndex((line) => /^title\s*:/.test(line));
  if (at >= 0) lines[at] = `title: ${value}`;
  else lines.unshift(`title: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${text.slice(match[0].length).replace(/^/, match[0].endsWith("\n") ? "" : "\n")}`;
}

// `meetings/summaries/2026-10-30T08-00Z_daily-standup.md` → its start and a title.
export function describeFile(path) {
  const name = path.split("/").at(-1).replace(/\.md$/, "");
  const [start, ...rest] = name.split("_");
  const title = rest.join(" ").replaceAll("-", " ") || name;
  return { start, title: title.charAt(0).toUpperCase() + title.slice(1) };
}

// `2026-10-30T08-00Z`, the start in a notebook file's name, as a Date.
export function startDate(start) {
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)Z$/.exec(start ?? "");
  return match ? new Date(`${match[1]}T${match[2]}:${match[3]}:00Z`) : null;
}

// The meetings in what the list command sends: "@@ <path>" and the front matter under it.
export function parseList(body) {
  const meetings = [];
  for (const chunk of body.split(/^@@ /m).slice(1)) {
    const at = chunk.indexOf("\n");
    const path = (at < 0 ? chunk : chunk.slice(0, at)).trim();
    const { fields } = parseNote(`---\n${at < 0 ? "" : chunk.slice(at + 1).replace(/\n?---\s*$/, "")}\n---\n`);
    const file = describeFile(path);
    const date = new Date(fields.date ?? "");
    meetings.push({
      path,
      title: fields.title || file.title,
      start: file.start,
      date: Number.isNaN(date.getTime()) ? startDate(file.start) : date,
      duration: Number.parseFloat(fields.duration) || null,
    });
  }
  return meetings.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
}

const DAY = 24 * 60 * 60 * 1000;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// The meetings by when they were: Today, This week, Earlier (the empty groups left out).
export function groupMeetings(meetings, now = new Date()) {
  const today = dayStart(now);
  const groups = [["Today", []], ["This week", []], ["Earlier", []]];
  for (const m of meetings) {
    const day = m.date ? dayStart(m.date) : 0;
    groups[day >= today ? 0 : day > today - 7 * DAY ? 1 : 2][1].push(m);
  }
  return groups.filter(([, items]) => items.length > 0).map(([label, items]) => ({ label, items }));
}

// "Tue · 38 min", or the time for a meeting of today.
export function meetingMeta(m, now = new Date()) {
  const parts = [];
  if (m.date) {
    parts.push(dayStart(m.date) === dayStart(now)
      ? m.date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : m.date.toLocaleDateString([], dayStart(now) - dayStart(m.date) < 7 * DAY ? { weekday: "short" } : { day: "numeric", month: "short" }));
  }
  if (m.duration) parts.push(`${m.duration < 1 ? "<1" : Math.round(m.duration)} min`);
  return parts.join(" · ");
}

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
export function summariesIn(reply) {
  const paths = [...reply.matchAll(/\]\(([^)\s]+)\)|(file:\/\/[^\s\])]+)/g)].map((m) => notePath(m[1] ?? m[2].replace(/[.,;:!?]+$/, "")));
  return [...new Set(paths.filter((p) => p?.startsWith("meetings/summaries/")))];
}

// The sign-in page and code in what `slivingdoc login` printed so far, once it printed them.
export function parseApproval(lines) {
  const text = lines.join("\n");
  const code = /approve the code (\S+?):/.exec(text)?.[1];
  const url = /^\s*(https:\/\/\S+)$/m.exec(text)?.[1];
  return code && url ? { code, url } : null;
}

// Who approved the login stored in slivingdoc's credentials file, if it says.
export function accountOf(credentials) {
  let found = null;
  const walk = (value) => {
    if (found || value === null || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      if (key.toLowerCase() === "account" && typeof inner === "string") found = inner;
      else walk(inner);
    }
  };
  try {
    walk(JSON.parse(credentials));
  } catch {
    return null;
  }
  return found;
}

const TOKENS_PAGE = "https://www.slivingdoc.dev/tokens";

// What a sign-out leaves behind, from what it signed out of and how `slivingdoc logout` ended:
// the login is forgotten only once the site revoked the key, so a live key is never orphaned
// silently (2026-11-04 research/http-host-call/PROMPT.md).
export function signoutResult({ account, tokenOnly, status, said }) {
  if (status !== 0) {
    return {
      revoked: false,
      message: `Signing out of ${account ?? "slivingdoc"} failed: ${said || `exit ${status}`}. The login is kept, so it can be revoked.`,
      page: TOKENS_PAGE,
    };
  }
  return {
    revoked: true,
    message: tokenOnly
      ? "Signed out of the token. The key itself stays valid until it is revoked on slivingdoc.dev."
      : `Signed out of ${account ?? "slivingdoc"}.`,
    page: tokenOnly ? TOKENS_PAGE : null,
  };
}

// The spaces `slivingdoc space` lists for the stored login, and its default space, if any
// (marked with a *).
export function parseSpaces(text) {
  const rows = [...text.matchAll(/^([ *])!? (\S+)(?: \([^)]*\))? {2,}(?:write|read)\b/gm)];
  return { names: rows.map((m) => m[2]), current: rows.find((m) => m[1] === "*")?.[2] ?? null };
}

// The speakers a transcript names by a label rather than a name, each with a line they said and, when
// the transcript has times, that line's stretch of the recording in seconds, at most SNIPPET_S long,
// to hear them by: to its own end, else to the next line's start.
export const SNIPPET_S = 10;
export function unknownSpeakers(transcript) {
  const rows = transcriptRows(transcript).map((r) => r.u).filter(Boolean);
  const found = new Map();
  rows.forEach((u, i) => {
    if (!isLabel(u.name)) return;
    const said = u.words.trim();
    const known = found.get(u.name);
    if (known && !(known.sample.split(/\s+/).length < 4 && said.split(/\s+/).length >= 4)) return;
    const next = rows.slice(i + 1).find((r) => r.start !== null && r.start > u.start)?.start;
    const end = u.start === null ? null : Math.min(u.end > u.start ? u.end : next ?? u.start + SNIPPET_S, u.start + SNIPPET_S);
    found.set(u.name, { label: u.name, sample: said, start: u.start, end });
  });
  return [...found.values()];
}

// A note's body without its own leading "Summary" or "Transcript" heading, which the card has.
export function withoutHeading(body, word) {
  return body.replace(new RegExp(`^\\s*#{1,3} [^\\n]*\\b${word}\\s*\\n+`, "i"), "");
}

// The remote profile an error record says is not trusted (a new version, under -n), or whose
// pinned bytes are no longer there to run, or null.
export function untrustedProfile(errors) {
  for (const e of errors) {
    const m = /^profile (\S+): .*(?:you have not trusted|does not match its #sha256=)/.exec(e.message ?? "");
    if (m) return m[1].replace(/#.*$/, "");
  }
  return null;
}

// The hash clai printed for the version it checked or trusted:
// `<target> (sha256 <hex>) is trusted`, or `Trusted <target> (sha256 <hex>) in <file>`.
export function trustedDigest(output) {
  return [...(output ?? "").matchAll(/\(sha256 ([0-9a-f]{64})\)/g)].at(-1)?.[1] ?? null;
}

// The profile at exactly the bytes with `digest`. clai cached them when it checked or trusted
// them, and reads a #sha256= from its cache, so the run never fetches: a version the hub
// publishes after the check cannot reach it, and cannot get it refused halfway.
export const pinProfile = (profile, digest) => `${profile.replace(/#.*$/, "")}#sha256=${digest}`;

export const digestOf = (profile) => /#sha256=([0-9a-f]{64})$/.exec(profile ?? "")?.[1] ?? null;

// A profile clai fetches from the hub or a repository, rather than a file on the machine.
export const isRemote = (profile) => /^(cchub|gh):/.test(profile);

// clai's exit status when it refuses a remote profile, such as one it does not trust.
const REFUSED = 3;

const changedProblem = (profile) => ({
  level: "error", title: "The agent changed since you trusted it",
  detail: `Read what ${profile} runs now, then start again to trust this version.`, hint: null, code: null,
});

const keptVersion = (profile) => ({
  level: "warn", title: "This meeting keeps the agent it started with",
  detail: `The hub has a newer version of ${profile.replace(/#.*$/, "")}. Replies in this meeting run the version it started with; ` +
    "a new recording runs the newest one you trust.",
  hint: null, code: null,
});

// The hub's page for a cchub: profile, where its prompt and tools can be read.
export function profilePage(profile) {
  const m = /^cchub:([^/@\s]+)\/([^/@\s]+)/.exec(profile);
  return m ? `https://www.clai.chat/hub/${m[1]}/${m[2]}/` : null;
}

// JSON on one line: an environment variable with a newline does not reach the machine.
const compact = (json) => {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
};

// A message from /run/page/out: its first line names its topic, and the rest is its body.
export function splitMessage(bytes) {
  const at = bytes.indexOf(10);
  const end = at < 0 ? bytes.length : at;
  return { topic: new TextDecoder().decode(bytes.subarray(0, end)), body: bytes.subarray(Math.min(bytes.length, end + 1)) };
}

const ICON = "./icon-192.png";
// Messages hold at most 16 MB, so a recording comes in parts.
const PART = 15_000_000;
// Raw bytes a run takes back to the machine, as base64 in one argument of 1.6 MB.
const RECORDING_PART = 1_200_000;

const CREDENTIALS = "~/.config/slivingdoc/credentials.json";
const STORED_LOGIN = "minutes.slivingdoc-credentials";
const STORED_TRUST = "minutes.clai-trust";
const PROVIDER_HOSTS = new Set(PROVIDERS.flatMap((p) => p.hosts));
// Set once the user chose to keep the notes in this browser: the sign-in note then stays away.
const STORED_LOCAL = "minutes.local-only";
const TRUST = '"$(clai confdir)/trust.json"';
// clai's token store, in its config dir: where Penelope's tool sign-ins go for her runs.
const MCP_AUTH = "mcpAuth";

// slivingdoc where its stderr is the console's: at debug level, so that a pull or a save that
// fails says why there, the first time it does. Where the page reads what it prints (its
// spaces, its login, its log), it runs as it is.
const SLIVINGDOC = "LOG_LEVEL=debug slivingdoc";

const transcriptOf = (summary) => summary.replace("meetings/summaries/", "meetings/transcripts/");

// The run whose conversation goes on about the meeting filed at `path`: the newest run that filed
// it or was about it and saved a conversation, or null when no run of this tab did (clai keeps
// conversations only in the tab's machine, so after a reload there is none). A reply takes the
// conversation (`chat`) and the agent's version (`profile`) from it.
export function conversationOf(jobs, path) {
  return jobs.find((j) => j.chat && (j.filed === path || j.path === path)) ?? null;
}

// Where the recording of the meeting filed at `path` goes back on the machine to be transcribed again.
export const againPath = (path) => `/tmp/recordings/again-${path.split("/").at(-1).replace(/\.md$/, "").replace(/[^\w.-]+/g, "-")}.wav`;

// What the agent is told to transcribe the meeting filed at `path` again from `audio`, over its notes.
export const againText = (audio, path) =>
  `The recording of this meeting is already made and is the file ${audio}. Do not record again and do not ask for one: ` +
  `transcribe that file with audio_transcribe. The meeting is filed as ${path} and ${transcriptOf(path)}: read the ` +
  "summary for who the speakers are, then write the new summary over it, keeping its front matter's title, date and " +
  "duration, and leave the transcript file to the app. File nothing under another name.";

// What Transcribe again asks before it replaces the notes, where the notebook does or does not keep a history.
export const againWarning = (connected) =>
  "The agent transcribes the recording again and writes a new summary and transcript in place of these, " +
  "so your corrections to them are replaced. " +
  (connected ? "This version stays in the notebook's history on slivingdoc." : "The notebook in this browser keeps no history, so this version will be gone.");

// Whether the open meeting `c` can be transcribed again: this browser keeps its recording, and no run is about it.
export function canTranscribeAgain(c, kept, jobs) {
  return Boolean(c && kept) && !jobs.some((j) => !j.done && [j.again, j.path, j.filed].includes(c.path));
}

// Whether the open meeting `c` can be deleted: no run is about it.
export function canDelete(c, jobs) {
  return Boolean(c) && !jobs.some((j) => !j.done && [j.again, j.path, j.filed].includes(c.path));
}

// What the eraser asks before it deletes a meeting: `recorded` when this browser keeps its recording,
// `corrections` how many unsaved ones go with it.
export const deleteWarning = (connected, recorded, corrections = 0) =>
  `Its summary and transcript leave the notebook${recorded ? ", and its recording is erased from this browser" : ""}. ` +
  (corrections ? "Your unsaved corrections go with them. " : "") +
  (connected ? `The notes stay in the notebook's history on slivingdoc${recorded ? "; the recording is gone for good." : "."}`
    : "The notebook in this browser keeps no history, so it is gone for good.");

// “A”, “B” and “C”.
const quotedList = (titles) => titles.map((t) => `“${t}”`).join(", ").replace(/, ([^,]*)$/, " and $1");

// What Penelope asks before the app deletes the meetings she named, and the two answers.
export function deleteAsk(titles, connected) {
  const one = titles.length === 1;
  return {
    text: `Shall I delete ${quotedList(titles)}? ${one ? "Its" : "Their"} notes leave the notebook, and any recording this browser keeps of ${one ? "it" : "them"} is erased for good. ` +
      (connected ? "The notes stay in the notebook's history on slivingdoc." : "The notebook in this browser keeps no history, so the notes are gone for good too."),
    yes: one ? "Delete it" : `Delete all ${titles.length}`,
    no: one ? "Keep it" : "Keep them",
  };
}

// What Penelope says once the app deleted `gone` and could not delete `kept` (titles).
export function deleteSaid(gone, kept) {
  return {
    say: [gone.length ? `Deleted ${quotedList(gone)}.` : "", kept.length ? `I could not delete ${quotedList(kept)}; the note under the peek says why.` : ""].filter(Boolean).join(" "),
    mood: kept.length ? "sorry" : "glad",
  };
}

// Penelope works on copies of the open meeting's files, one directory a meeting, so -dre goes on with it.
const PENELOPE_HOME = "/tmp/penelope";
// Her working directory: app.md, and the copies of the meeting in focus.
const PENELOPE_DESK = `${PENELOPE_HOME}/desk`;
// What Penelope may have the app do, each by pressing its button while it shows: the button, and what it does.
const PENELOPE_BUTTONS = {
  transcribe_again: ["#again", "transcribe the meeting in focus again from its recording; the app asks the user to confirm"],
  new_recording: ["#new", "show New recording, where the user starts a recording"],
};

// Each line clai prints goes to the page as an `agent:<run>` message, then `agent-end:<run>`.
const AGENT_PIPE = " 2>&1 | while IFS= read -r line; do printf 'agent%s\\n%s\\n' \"$MINUTES_RUN\" \"$line\" > /run/page/out; done; " +
  "s=${PIPESTATUS[0]}; printf 'agent-end%s\\n' \"$MINUTES_RUN\" > /run/page/out; exit $s";
// ".2": paces learned before 2026-11-16 blended in a guessed 3 s an audio minute (jobs.js PROVIDER_PACE).
// ".3": before 2026-11-23 a long recording taught its whole time per audio minute, though clai sends
// its parts at once (the survey path), which put the 88-minute Retro at 59 minutes for 29.7.
const STORED_PACE = "minutes.pace.3";
// The kept notes go back onto the machine in runs of at most this many characters: a run's
// arguments hold 2 MiB in all, and a character takes up to 3 bytes.
const RESTORE_CHARS = 600_000;
// clai's diagnostics below the terminal's level, which go to the run log only (failure-reports E6).
const QUIET_LEVELS = new Set(["debug", "trace"]);
const SECRET_NAME = /key|token|secret|password|credential/i;

export class Minutes {
  // `machine.run(line, action)` runs a line on the machine and resolves to its status;
  // `machine.spawn(...)` runs one beside the others, off the console, and `machine.touch(path)`
  // creates a file at once, which is how Stop reaches a recording. `hood` shows what a click ran, `model` is what
  // the machine did, `env` the variables every run gets, `audio` the inputs being captured.
  // `store` keeps the slivingdoc login and the AI provider's key in the browser: get(key),
  // set(key, value), remove(key). `peek(tab)` opens the under-the-hood view on a tab, and
  // `anchor` is the button that does, which a note about a failure points at. `terminal` is the
  // peek's: write(text) writes there, mark(text) writes and returns where, and reveal(where)
  // scrolls to that and selects it. `voices` (VoiceKeeper), `segments` (SegmentKeeper), `people` (People)
  // and `review` (Review) are the voice library's keepers, New recording's people row and "Who is speaking?";
  // `againPeople` (People) is Transcribe again's row.
  constructor({
    root, machine, hood, model, env, audio, store, recordings, config, peek = () => {}, anchor = null,
    terminal = { write() {}, mark() { return null; }, reveal() {} }, platform = { os: "other", browser: "other" },
    voices = null, segments = null, people = null, againPeople = null, review = null, runlog = new RunLog({ indexedDB: undefined }),
    pointer = null, notebook = null,
  }) {
    // The notes kept in this browser while no slivingdoc notebook is connected (NotebookKeeper).
    this.notebook = notebook;
    // Rings a block of the pad the user is pointed at (pointer.js): the AI provider card, say.
    this.pointer = pointer;
    // The jobs' run logs (RunLog), the log a voice library put or take belongs to, and clai's version once asked.
    this.runlog = runlog;
    this.logs = 0;
    this.voicesLog = null;
    this.clai = null;
    this.consoleText = new TextDecoder();
    if (model) model.noted = (entry, proc) => this.processNoted(entry, proc);
    runlog.ready.then(() => this.renderLogs());
    this.voices = voices;
    this.segments = segments;
    this.people = people;
    this.againPeople = againPeople;
    // Transcribe again's row as it is being drawn for the meeting asked about: {path, drawn}.
    this.againDrawing = null;
    this.review = review;
    // The open meeting's kept segments and the library's people, as the review last read them.
    this.reviewing = null;
    this.choosing = false;
    this.platform = platform;
    this.title = document.title;
    this.quietNotice = null;
    this.terminal = terminal;
    this.peek = peek;
    this.anchor = anchor;
    this.notes = new Map();
    this.root = root;
    this.machine = machine;
    this.hood = hood;
    this.model = model;
    this.env = env;
    this.audio = audio;
    this.store = store;
    this.recordings = recordings;
    this.streams = new Map();
    this.login = null;
    this.signingOut = false;
    this.signoutNote = null;
    // An AI provider's sign-in under way, and what the provider card last said.
    this.providerSigning = null;
    this.providerSaid = null;
    // Penelope's tools (beta): what this browser keeps, the sign-in under way, what each row last said.
    this.mcp = mcpState(this.store.get(STORED_MCP));
    this.mcpSigning = null;
    this.mcpSaid = new Map();
    this.toolsOpen = false;
    this.trusted = null;
    // The hash of the newest version clai found trusted, checking or trusting it.
    this.latest = null;
    this.spaces = null;
    this.connecting = !this.store.get(STORED_LOCAL);
    this.config = { ...DEFAULTS, ...config };
    this.meetings = [];
    this.waiters = new Map();
    // The agent's runs, newest first; `recording` is the one the meeting view shows.
    this.jobs = [];
    this.agentRuns = 0;
    this.printing = null;
    this.ticker = null;
    this.recording = null;
    this.current = null;
    this.levels = [];
    this.actions = 0;
    // The checklist: mic only chosen, and what listening to the share found.
    this.micOnly = false;
    this.heard = false;
    this.silent = false;
    this.listening = null;
    this.shares = 0;
    this.$ = (s) => document.querySelector(s);
    // The open meeting's unsaved corrections, their post-it, and what the pad last drew.
    this.fixes = null;
    this.offer = null;
    this.saving = false;
    this.saveFailed = false;
    this.saveSaid = "";
    this.dropping = false;
    this.quiet = false;
    this.drawn = {};
    this.proof = new Proofreader({
      root: this.$("#transcript"),
      audio: this.$("#recording"),
      markdown: (text, first) => renderMarkdown(first ? withoutHeading(text, "transcript") : text),
      changed: (changes, words) => this.corrected(changes, words),
    });
    this.player = new Player(this.$("#tape"));
    // The meeting whose Transcribe again waits for a yes.
    this.asking = null;
    // The meeting whose eraser waits for a yes, and whether one is being deleted.
    this.deleting = null;
    this.removing = false;
    this.penelopeBusy = false;
    this.penelopeTalked = false;
    this.handFixes = 0;
    this.penelope = new Penelope({
      root: this.$("#penelope"),
      ask: (text) => this.askPenelope(text),
      undo: (step) => this.undoStep(step),
      canUndo: (step) => !this.penelopeBusy && this.fixes === step.fixes && this.fixes.undos.length === step.depth,
    });
    // The last run that ended while the tab was out of sight, which the tab's title still tells of.
    this.unseen = null;
    this.tabIcon = null;
    this.popout = new Popout({
      jobs: () => this.jobs,
      pace: () => this.pace,
      stop: (job) => this.stop(job),
      pick: (job) => this.pickJob(job),
      changed: () => this.render(),
    });
    this.bind();
    this.render();
  }

  bind() {
    const $ = this.$;
    const secret = (form, input, name, kept) => {
      $(form).onsubmit = (event) => {
        event.preventDefault();
        const value = $(input).value.trim();
        if (!value) return;
        this.env.set(name, value);
        if (kept) this.store.set(kept, value);
        $(input).value = "";
        this.render();
        if (name === "SLIVINGDOC_TOKEN") {
          this.connecting = false;
          this.refresh();
        }
      };
    };
    secret("#notebook-form", "#token-input", "SLIVINGDOC_TOKEN");
    for (const el of document.querySelectorAll("#provider-card [data-provider]")) {
      const provider = providerById(el.dataset.provider);
      if (provider.connect === "key") {
        el.onsubmit = (event) => {
          event.preventDefault();
          const input = el.querySelector("input");
          const value = input.value.trim();
          input.value = "";
          if (value) this.useKey(provider, value);
        };
      } else {
        el.onclick = () => this.signinProvider(provider, window.open("about:blank", "_blank"));
      }
    }
    // The callback page, in the tab the sign-in opened, hands its code back here.
    this.signins = new BroadcastChannel(SIGNIN_CHANNEL);
    this.signins.onmessage = (event) => this.signedIn(event.data);
    this.bindTools();
    $("#change-key").onclick = () => this.disconnect();
    $("#new").onclick = () => this.blocked() || this.show("record", true);
    // The open meeting's title renames it when clicked: a correction, saved with the others.
    $("#meeting-title").onclick = () => this.editTitle();
    $("#meeting-title").onkeydown = (event) => {
      if (event.key === "Enter" && event.target === $("#meeting-title")) this.editTitle();
    };
    $("#signin").onclick = () => this.signin(window.open("about:blank", "_blank"));
    $("#signout").onclick = () => this.blocked() || this.signout();
    $("#not-now").onclick = () => {
      this.keepLocal();
      this.render();
    };
    $("#connect").onclick = () => {
      if (this.blocked()) return;
      this.connecting = !this.connecting;
      // The sign-in note is on the new recording's page.
      if (this.connecting) this.view = "record";
      this.render();
      if (this.connecting) $("#token-input").focus();
    };
    $("#record-form").onsubmit = (event) => {
      event.preventDefault();
      if (recordingJob(this.jobs)) return this.status("A meeting is being recorded. Stop it before starting another.");
      this.record($("#title").value.trim() || "Meeting", $("#details").value.trim());
    };
    $("#unshare").onclick = () => this.audio?.unshare();
    $("#access-mic").onclick = async () => {
      await this.audio.discover();
      this.audio.relist();
      this.render();
    };
    $("#access-computer").onclick = () => this.shareComputer();
    $("#mic-only").onclick = () => {
      this.micOnly = !this.micOnly;
      this.render();
    };
    $("#stop").onclick = () => this.stop();
    $("#popout").onclick = () => this.popout.show();
    // Penelope comes onto the desk as the checklist names her, before the page (arrival.js).
    $("#app").addEventListener("penelope", () => this.penelope.appear(), { once: true });
    $("#app").addEventListener("arrived", () => {
      this.penelope.arrive(guideText({ provider: Boolean(activeProvider(this.env)), notebook: Boolean(this.login || this.connected) }));
    }, { once: true });
    // Chrome calls this on a tab switch while the page records the mic, over https only (automatic picture-in-picture).
    try {
      navigator.mediaSession?.setActionHandler("enterpictureinpicture", () => running(this.jobs) && this.popout.show());
    } catch {
      // A browser without the action.
    }
    const seen = () => {
      if (!this.inSight()) return;
      this.unseen = null;
      this.renderTab();
    };
    document.addEventListener("visibilitychange", seen);
    globalThis.addEventListener("focus", seen);
    $("#retry").onclick = () => this.blocked() || this.retry();
    $("#again").onclick = () => {
      if (this.blocked()) return;
      this.asking = this.current?.path ?? null;
      this.deleting = null;
      this.render();
      this.drawAgainPeople();
      $("#again-yes").focus();
    };
    // The eraser asks first, with the keyboard on the answer that keeps the meeting.
    $("#delete").onclick = () => {
      if (this.penelopeBusy) return this.penelope.nudge("Hang on, I'm still writing.");
      this.deleting = this.current?.path ?? null;
      this.asking = null;
      this.render();
      $("#delete-no").focus();
    };
    $("#delete-yes").onclick = () => this.deleteMeeting();
    const spare = () => {
      this.deleting = null;
      this.render();
      $("#delete").focus();
    };
    $("#delete-no").onclick = spare;
    $("#delete-note").onkeydown = (event) => event.key === "Escape" && spare();
    $("#again-yes").onclick = () => this.blocked() || this.transcribeAgain();
    const keep = () => {
      this.asking = null;
      this.render();
      $("#again").focus();
    };
    $("#again-no").onclick = keep;
    $("#again-note").onkeydown = (event) => event.key === "Escape" && keep();
    // The people row pre-ticks who was in the last meeting of the name typed (People.title).
    $("#title").addEventListener("input", () => this.people?.title($("#title").value));
    $("#space-form").onsubmit = (event) => {
      event.preventDefault();
      if ($("#space").value) this.chooseSpace($("#space").value);
    };
    $("#history").onclick = () => this.history();
    $("#reply-form").onsubmit = (event) => {
      event.preventDefault();
      const text = $("#reply").value.trim();
      if (text && !this.blocked()) this.answer(text);
    };
    $("#fixes-save").onclick = () => this.saveFixes();
    $("#fixes-undo").onclick = () => {
      this.fixes?.undo();
      this.offer = null;
      this.touched();
    };
    $("#fixes-drop").onclick = () => this.drop();
    $("#offer-all").onclick = () => this.fixEverywhere();
    $("#offer-one").onclick = () => {
      this.offer = null;
      this.render();
    };
    globalThis.addEventListener?.("beforeunload", (event) => {
      if (this.fixes?.count) event.preventDefault();
    });
    // A link in what Penelope says that points at a block of the pad (markdown.js): on a phone her
    // bubble covers the pad, so it goes first.
    document.addEventListener("click", (event) => {
      const link = event.target.closest?.("a[data-point]");
      if (!link) return;
      event.preventDefault();
      if (globalThis.matchMedia?.("(max-width: 600px)").matches) this.penelope.toggle(false);
      this.pointAt(link.dataset.point);
    });
    // Links to the notebook's files, in what the agent wrote, open them here.
    this.root.addEventListener("click", (event) => {
      const link = event.target.closest?.("a[data-note]");
      if (!link) return;
      event.preventDefault();
      const path = link.dataset.note.replace("meetings/transcripts/", "meetings/summaries/");
      this.visit(this.meetings.find((m) => m.path === path) ?? { path, ...describeFile(path) });
    });
  }

  // A meeting the user chose opens, but not over corrections to another still to be saved.
  visit(meeting) {
    if (this.fixes?.count && this.current?.path === meeting.path) return this.show("meeting");
    if (!this.blocked()) this.open(meeting);
  }

  // Whether a reload now would stop something under way: a recording or transcription, the
  // naming of the speakers, a save, or Penelope or the agent writing.
  working() {
    return running(this.jobs) || this.choosing || this.saving || this.penelopeBusy || this.asking !== null || this.deleting !== null || this.removing;
  }

  // True when corrections wait to be saved or dropped: the post-it says so, with a wiggle.
  blocked() {
    if (this.penelopeBusy) {
      this.penelope.nudge("Hang on, I'm still writing.");
      return true;
    }
    if (!this.fixes?.count) return false;
    this.saveSaid = "Save or drop these first.";
    this.dropping = false;
    this.show("meeting");
    const postit = this.$("#fixes");
    postit.classList.remove("nudge");
    void postit.offsetWidth;
    postit.classList.add("nudge");
    return true;
  }

  // A correction from the transcript; one word or name changed is offered everywhere it is.
  corrected(changes, words) {
    this.fixes.change(changes);
    if (++this.handFixes === 3) {
      this.penelope.tip("It looks like you're fixing the transcript. Want me to look for more like these?",
        "Look through the transcript for more mistakes like the ones I corrected, and fix them.");
    }
    this.offer = null;
    const change = words && singleChange(words.from, words.to);
    if (change) {
      const places = this.fixes.places(change.from);
      if (places.transcript.count + places.summary.count > 0) this.offer = { ...change, places };
    }
    this.touched();
  }

  // After the corrections changed: the transcript's rows, the summary and the post-it follow.
  touched() {
    this.saveSaid = "";
    this.saveFailed = false;
    this.dropping = false;
    this.proof.refresh();
    this.render();
    document.activeElement?.closest?.(".utt")?.scrollIntoView({ block: "nearest" });
  }

  fixEverywhere() {
    const offer = this.offer;
    this.offer = null;
    if (offer) this.fixes.everywhere(offer.from, offer.to);
    this.touched();
  }

  // Drops every correction, on a second click.
  drop() {
    if (!this.dropping) {
      this.dropping = true;
      return this.render();
    }
    this.fixes = new Fixes(this.current.raw);
    this.proof.fixes = this.fixes;
    this.offer = null;
    this.touched();
  }

  // The user keeps the notes in this browser: the sign-in note goes, and stays away.
  keepLocal() {
    this.connecting = false;
    this.store.set(STORED_LOCAL, "1");
  }

  get connected() {
    return this.env.has("SLIVINGDOC_TOKEN") || this.login !== null;
  }

  // Puts back the slivingdoc login this browser kept, then lists the notebook. #app's
  // data-phase says how far it got (the load bar shows it: loadbar.js): booting until the
  // machine is up, checking, then fetching or listing, then ready, whatever failed on the way.
  async start() {
    try {
      // The keys this browser kept, so a return to the site needs no paste or sign-in.
      for (const p of PROVIDERS) {
        const key = this.store.get(p.stored);
        if (key) this.env.set(p.env, key);
      }
      // The login shows at once; the machine gets it once it is up.
      const credentials = this.store.get(STORED_LOGIN);
      if (credentials) this.login = accountOf(credentials) ?? "signed in";
      this.render();
      await this.machine.booted;
      this.phase("checking");
      if (credentials) {
        const line = `mkdir -p ~/.config/slivingdoc && printf '%s' "$SLIVINGDOC_CREDENTIALS" > ${CREDENTIALS}`;
        const { status } = await this.run("Restore the slivingdoc login", line, {
          followUp: true, env: { SLIVINGDOC_CREDENTIALS: compact(credentials) },
        });
        if (status !== 0) this.login = null;
      }
      const trust = this.store.get(STORED_TRUST);
      if (trust) {
        const line = `mkdir -p "$(clai confdir)" && printf '%s' "$CLAI_TRUST" > ${TRUST}`;
        const { status } = await this.run("Restore the agent's trust", line, { followUp: true, env: { CLAI_TRUST: compact(trust) } });
        if (status === 0) this.trusted = this.store.get(STORED_TRUST + ".profile");
      }
      if (isRemote(this.config.profile) && !this.needsTrust) await this.checkTrust();
      this.render();
      if (this.login) await this.checkSpace();
      this.phase(this.connected && !this.spaces ? "fetching" : "listing");
      if (!this.connected) await this.restoreNotebook();
      await this.refresh(true);
      await this.drawPeople();
    } finally {
      this.phase("ready");
    }
  }

  phase(name) {
    this.root.dataset.phase = name;
  }

  // The browser's trust is for a version the hub has since replaced: the next start asks again.
  distrust() {
    this.trusted = null;
    this.store.remove(STORED_TRUST);
    this.store.remove(STORED_TRUST + ".profile");
    this.render();
  }

  get needsTrust() {
    return isRemote(this.config.profile) && this.trusted !== this.config.profile;
  }

  // clai asks on the console before it first runs a profile from the hub: the click on
  // Record is the answer, and the trust it records is kept in the browser.
  // Resolves to the hash of the version trusted, or null.
  async trust() {
    const profile = this.config.profile;
    // The run's env, so that clai trusts the version the run would fetch (CLAI_CLOUD_URL).
    const env = this.config.env ? `${this.config.env} ` : "";
    const said = "/tmp/minutes-trust.$$";
    const line = `${env}clai profiles trust ${quote(profile)} </dev/null > ${said} && cat ${said} >&2 && ` +
      `{ echo trust; cat ${TRUST}; printf '\\0'; cat ${said}; } > /run/page/out`;
    const { status, body, action } = await this.run("Trust the agent", line, { topic: "trust", followUp: true });
    const [json, out = ""] = (body ?? "").split("\0");
    const digest = trustedDigest(out);
    if (status !== 0 || !json || !digest) {
      this.fail(`clai could not fetch or trust ${profile}`, `clai profiles trust ended with exit status ${status}.`, null, this.runlog.cause(action));
      return null;
    }
    this.store.set(STORED_TRUST, compact(json));
    this.store.set(STORED_TRUST + ".profile", profile);
    this.trusted = profile;
    this.latest = digest;
    return digest;
  }

  // clai's answer to whether it would run the hub profile now, and the hash of the version it
  // would run; a version it would refuse is forgotten.
  async verify() {
    const env = this.config.env ? `${this.config.env} ` : "";
    const said = "/tmp/minutes-trust-check.$$";
    const line = `${env}clai config trust profile -check ${quote(this.config.profile)} </dev/null > ${said}; s=$?; ` +
      `cat ${said} >&2; { echo trust-check; cat ${said}; } > /run/page/out; exit $s`;
    const { status, body, action } = await this.run("Check the agent's trust", line, { topic: "trust-check", followUp: true });
    if (status === REFUSED) this.distrust();
    const digest = status === 0 ? trustedDigest(body) : null;
    if (digest) this.latest = digest;
    return { status, digest, action };
  }

  async checkTrust() {
    return (await this.verify()).status;
  }

  // The profile a new conversation runs: a hub profile pinned to the version clai finds trusted
  // now, or null when it finds none, and nothing may start. Every reply in the conversation runs
  // the same pin (replyProfile), so no run the app starts is refused for trust halfway.
  async trusts() {
    const profile = this.config.profile;
    if (!isRemote(profile)) return profile;
    if (this.needsTrust) {
      const digest = await this.trust();
      return digest && pinProfile(profile, digest);
    }
    const { status, digest, action } = await this.verify();
    if (status === 0 && digest) return pinProfile(profile, digest);
    if (status === REFUSED) this.note(changedProblem(profile));
    else this.fail(`clai could not check ${profile}`, `clai config trust profile -check ended with exit status ${status}.`, null, this.runlog.cause(action));
    return null;
  }

  // The profile a reply in `job`'s conversation runs: the version the conversation started
  // with, with no fetch and no question, or for a conversation the app did not start here, a
  // new pin (trusts). The user hears when the hub has moved on since.
  async replyProfile(job) {
    const pinned = job?.profile;
    if (!pinned) return this.trusts();
    if (isRemote(pinned) && (this.needsTrust || (this.latest && digestOf(pinned) !== this.latest))) this.note(keptVersion(pinned));
    return pinned;
  }

  // A login needs a default space before slivingdoc can pull: the app asks for one if the
  // login has none, and keeps the choice with the login.
  async checkSpace() {
    const { status, body } = await this.run("List slivingdoc spaces",
      "{ echo spaces; slivingdoc space </dev/null 2>&1; } > /run/page/out", { topic: "spaces", followUp: true });
    if (status !== 0 || body === null) {
      this.spaces = null;
      return this.status(`slivingdoc could not list the login's spaces (exit ${status}).`);
    }
    const { names, current } = parseSpaces(body);
    const space = names.includes(this.config.space) ? this.config.space : !current && names.length === 1 ? names[0] : null;
    if (space && space !== current) return this.chooseSpace(space, true);
    this.spaces = current ? null : names;
    this.render();
  }

  // `followUp` when the login's only space is chosen without asking: the caller refreshes.
  async chooseSpace(name, followUp = false) {
    const line = `${SLIVINGDOC} space ${quote(name)} </dev/null >&2 && { echo credentials; cat ${CREDENTIALS}; } > /run/page/out`;
    const { status, body } = await this.run(`Use space ${name}`, line, { topic: "credentials", followUp });
    if (status !== 0 || !body) return this.status(`slivingdoc could not make ${name} the default space (exit ${status}).`);
    this.store.set(STORED_LOGIN, compact(body));
    this.spaces = null;
    this.render();
    if (!followUp) await this.refresh();
  }

  // A provider's OAuth sign-in: its page opens in `tab` (opened by the click), and its callback
  // page hands the code back over SIGNIN_CHANNEL. A second click starts over.
  async signinProvider(provider, tab) {
    const { verifier, challenge, state } = await pkce();
    const callback = new URL("./signin-callback.html", location.href).href;
    const url = authorizeUrl(provider, { callback, challenge, state });
    this.providerSigning = { provider, verifier, state, url, text: `Approve Penelope on ${provider.name}'s page, in the tab that opened.` };
    this.providerSaid = null;
    if (tab && !tab.closed) tab.location.href = url;
    this.render();
  }

  // The callback's answer: an approval for the sign-in under way is traded for its key. A denial
  // carries no state.
  async signedIn({ code, state, error, iss } = {}) {
    const mcp = this.mcpSigning;
    if (mcp && (state === mcp.state || (!state && !code && !this.providerSigning))) return this.toolSignedIn({ code, error, iss });
    const signing = this.providerSigning;
    if (!signing || !(state === signing.state || (!state && !code))) return;
    const { provider } = signing;
    if (!code) {
      this.providerSigning = null;
      this.providerSaid = { text: `${provider.name} did not sign you in${error ? `: ${error}` : ""}.` };
      return this.render();
    }
    this.providerSigning = { ...signing, state: null, text: `Getting your key from ${provider.name}…` };
    this.render();
    try {
      this.useKey(provider, await exchangeCode(provider, { code, verifier: signing.verifier }));
    } catch (error) {
      this.providerSaid = { text: error.message };
    } finally {
      this.providerSigning = null;
      this.render();
    }
  }

  useKey(provider, key) {
    this.env.set(provider.env, key);
    this.store.set(provider.stored, key);
    this.providerSaid = null;
    this.render();
  }

  // Forgets the provider's key here. A key a sign-in created stays live at the provider, so the
  // card links to where it is deleted.
  async disconnect() {
    const provider = activeProvider(this.env);
    if (!provider) return;
    const key = this.env.get(provider.env);
    this.env.delete(provider.env);
    this.store.remove(provider.stored);
    const said = { text: `Penelope forgot your ${provider.name} key.`, name: provider.name, manage: null };
    this.providerSaid = said;
    this.render();
    if (!provider.manage) return;
    said.manage = await provider.manage(key);
    if (this.providerSaid === said) this.render();
  }

  // Penelope's Tools (beta): a card above her form, where a tick attaches an MCP server to her runs.
  bindTools() {
    const $ = this.$;
    const menu = $("#penelope-tools-menu");
    const close = () => {
      this.toolsOpen = false;
      this.renderTools();
    };
    $("#penelope-tools").onclick = () => {
      this.toolsOpen = !this.toolsOpen;
      this.renderTools();
    };
    menu.onchange = (event) => {
      const server = mcpServerById(event.target.dataset?.tool);
      if (server) this.useTool(server, event.target.checked);
    };
    menu.onclick = (event) => {
      const server = mcpServerById(event.target.dataset?.signout);
      if (server) this.signoutTool(server);
    };
    menu.onkeydown = (event) => {
      if (event.key !== "Escape") return;
      close();
      $("#penelope-tools").focus();
    };
    document.addEventListener("pointerdown", (event) => this.toolsOpen && !event.target.closest?.(".penelope-tools") && close());
    this.renderTools();
  }

  saveMcp() {
    this.store.set(STORED_MCP, JSON.stringify(this.mcp));
  }

  // A tick attaches `server`, signing in first when this browser has no sign-in for it: its page
  // opens in a tab the tick opens, as only a click may open one. Unticked, it is detached.
  useTool(server, on) {
    this.mcpSaid.delete(server.id);
    if (on && !this.mcp.signins[server.id]) return this.signinTool(server, window.open("about:blank", "_blank"));
    if (!on && this.mcpSigning?.server === server) this.mcpSigning = null;
    const attached = new Set(this.mcp.attached);
    if (on) attached.add(server.id);
    else attached.delete(server.id);
    this.mcp.attached = [...attached];
    this.saveMcp();
    this.renderTools();
  }

  // The server's OAuth sign-in: its documents say where, Penelope registers as a client there once
  // per browser, and its page opens in `tab`, whose callback page hands the code back over
  // SIGNIN_CHANNEL. A second tick starts over.
  async signinTool(server, tab) {
    const signing = { server, state: null, url: null, text: `Opening ${server.name}'s sign-in page…` };
    this.mcpSigning = signing;
    this.renderTools();
    const callback = new URL("./signin-callback.html", location.href).href;
    try {
      const meta = await discover(server);
      const kept = `${meta.issuer} ${callback}`;
      const client = this.mcp.clients[kept] ?? (await register(meta, callback));
      this.mcp.clients[kept] = client;
      this.saveMcp();
      const { verifier, challenge, state } = await pkce();
      if (this.mcpSigning === signing) {
        Object.assign(signing, {
          meta, client, callback, verifier, state, kept,
          url: signinUrl(meta, { clientId: client.id, callback, challenge, state }),
          text: `Approve Penelope on ${server.name}'s page, in the tab that opened.`,
        });
        if (tab && !tab.closed) tab.location.href = signing.url;
      } else if (tab && !tab.closed) tab.close();
    } catch (error) {
      if (tab && !tab.closed) tab.close();
      if (this.mcpSigning === signing) {
        this.mcpSigning = null;
        this.mcpSaid.set(server.id, `${server.name}'s sign-in did not start: ${error.message}.`);
      }
    }
    this.renderTools();
  }

  // The callback's answer for the tool sign-in under way: an approval is traded for clai's token
  // store entry, which this browser keeps, and the server is attached. A failed sign-in forgets the
  // client, so the next one registers anew rather than reuse one the server may not know.
  async toolSignedIn({ code, error, iss }) {
    const signing = this.mcpSigning;
    const { server } = signing;
    const failed = (text) => {
      if (signing.kept) delete this.mcp.clients[signing.kept];
      this.saveMcp();
      this.mcpSaid.set(server.id, text);
    };
    if (!code) failed(`${server.name} did not sign you in${error ? `: ${error}` : ""}.`);
    else if (iss && iss !== signing.meta.issuer) failed(`The sign-in came back from ${iss}, not from ${server.name}.`);
    else {
      signing.state = null;
      signing.text = `Finishing the sign-in with ${server.name}…`;
      this.renderTools();
      try {
        const entry = await exchangeSignin(signing.meta, { ...signing, code });
        this.mcp.signins[server.id] = { entry, revoke: signing.meta.revoke };
        this.mcp.attached = [...new Set([...this.mcp.attached, server.id])];
        this.saveMcp();
      } catch (e) {
        failed(`${server.name}: ${e.message}.`);
      }
    }
    if (this.mcpSigning === signing) this.mcpSigning = null;
    this.renderTools();
  }

  // Forgets the server's sign-in here and asks the server to revoke it. One it did not revoke stays
  // live there, which the row says rather than hide.
  async signoutTool(server) {
    const signin = this.mcp.signins[server.id];
    if (!signin) return;
    delete this.mcp.signins[server.id];
    this.mcp.attached = this.mcp.attached.filter((id) => id !== server.id);
    this.saveMcp();
    this.mcpSaid.set(server.id, `Signing out of ${server.name}…`);
    this.renderTools();
    const revoked = await revokeSignin(signin);
    this.mcpSaid.set(server.id, revoked
      ? `Signed out: ${server.name} revoked Penelope's sign-in.`
      : `Penelope forgot your ${server.name} sign-in, but ${server.name} did not confirm it revoked it: remove Penelope from the apps that use your ${server.name} account.`);
    this.renderTools();
  }

  // The servers attached and signed in, for Penelope's next run: each with its sign-in and the name
  // of clai's token store file for it.
  async penelopeTools() {
    const used = MCP_SERVERS.filter((s) => this.mcp.attached.includes(s.id) && this.mcp.signins[s.id]);
    return Promise.all(used.map(async (server) => ({ server, signin: this.mcp.signins[server.id], name: await tokenName(server.id) })));
  }

  // clai refreshes a sign-in's tokens as they expire and writes them back to its file; the newest
  // are kept here, since the machine keeps no file past a reload.
  async keepSignins(tools, log = null) {
    const line = `d="$(clai confdir)/${MCP_AUTH}" && { echo mcp-auth; ${tools.map((t) => `cat "$d/${t.name}"; printf '\\0';`).join(" ")} } > /run/page/out`;
    const { status, body } = await this.run("Keep Penelope's tool sign-ins", line, { topic: "mcp-auth", followUp: true, log });
    if (status !== 0 || body === null) return;
    let changed = false;
    body.split("\0").forEach((text, i) => {
      const signin = tools[i] && this.mcp.signins[tools[i].server.id];
      let entry = null;
      try {
        entry = JSON.parse(text);
      } catch {
        return;
      }
      if (!signin || typeof entry?.access_token !== "string" || entry.access_token === signin.entry.access_token) return;
      signin.entry = entry;
      changed = true;
    });
    if (changed) this.saveMcp();
  }

  renderTools() {
    const $ = this.$;
    const attached = MCP_SERVERS.filter((s) => this.mcp.attached.includes(s.id)).map((s) => s.name);
    const button = $("#penelope-tools");
    button.textContent = attached.length > 0 ? attached.join(", ") : "+ Tools";
    button.title = attached.length > 0 ? `Penelope uses ${attached.join(", ")}` : "Let Penelope use your tools";
    button.classList.toggle("on", attached.length > 0);
    button.setAttribute("aria-expanded", String(this.toolsOpen));
    $("#penelope-tools-menu").hidden = !this.toolsOpen;
    if (!this.toolsOpen) return;
    const focused = document.activeElement?.dataset?.tool ?? document.activeElement?.dataset?.signout;
    $("#penelope-tools-list").replaceChildren(...MCP_SERVERS.map((s) => this.toolRow(s)));
    if (focused) $(`#penelope-tools-list [data-tool="${focused}"]`)?.focus();
  }

  // A server's row: its tick, and where its sign-in stands.
  toolRow(server) {
    const el = (tag, props = {}, ...children) => {
      const node = Object.assign(document.createElement(tag), props);
      node.append(...children);
      return node;
    };
    const signing = this.mcpSigning?.server === server ? this.mcpSigning : null;
    const signedIn = Boolean(this.mcp.signins[server.id]);
    const box = el("input", { type: "checkbox", checked: this.mcp.attached.includes(server.id) || Boolean(signing) });
    box.dataset.tool = server.id;
    const state = el("p", { className: "penelope-tool-state" });
    const said = this.mcpSaid.get(server.id);
    if (signing) {
      state.append(signing.text);
      if (signing.state) state.append(" ", el("a", { href: signing.url, target: "_blank", rel: "noopener", className: "penelope-link" }, "Open it again"));
    } else {
      if (said) state.append(said, " ");
      if (signedIn) {
        const out = el("button", { type: "button", className: "penelope-link" }, "Sign out");
        out.dataset.signout = server.id;
        state.append("Signed in. ", out);
      } else if (!said) state.append(`Tick it to sign in with ${server.name}.`);
    }
    return el("li", { className: "penelope-tool" },
      el("label", {}, box, el("strong", {}, server.name), el("span", { className: "penelope-tool-what" }, server.what)), state);
  }

  // `slivingdoc login` in the machine: its sign-in page opens in `tab` (opened by the click,
  // as only a click may open one), and once approved, the login it stored is kept here.
  async signin(tab) {
    const lines = [];
    const $ = this.$;
    this.signing = { text: "Asking slivingdoc for a sign-in page…" };
    this.render();
    this.streams.set("login", (line) => {
      lines.push(line.replace(/\n$/, ""));
      const approval = parseApproval(lines);
      if (approval && !this.signing.url) {
        this.signing = { ...approval, text: "Approve the code on slivingdoc's page, in the tab that opened." };
        if (tab && !tab.closed) tab.location.href = approval.url;
        this.render();
      }
    });
    const line = "slivingdoc login --no-browser </dev/null 2>&1 | " +
      "while IFS= read -r line; do printf 'login\n%s\n' \"$line\" > /run/page/out; done; s=${PIPESTATUS[0]}; " +
      `[ $s = 0 ] && { echo credentials; cat ${CREDENTIALS}; } > /run/page/out; exit $s`;
    const { status, body } = await this.run("Sign in to slivingdoc", line, { topic: "credentials" });
    this.streams.delete("login");
    if (status !== 0 || !body) {
      if (tab && !tab.closed && !this.signing.url) tab.close();
      this.signing = { text: `The sign-in did not finish: ${lines.filter(Boolean).at(-1) ?? `exit ${status}`}` };
      this.render();
      return;
    }
    this.store.set(STORED_LOGIN, compact(body));
    this.store.remove(STORED_LOCAL);
    this.login = accountOf(body) ?? "signed in";
    this.signing = null;
    this.connecting = false;
    this.signoutNote = null;
    this.render();
    await this.checkSpace();
    await this.refresh();
  }

  // Signs out: `slivingdoc logout` revokes the login's key at the site and removes the login, and
  // only then does the app forget what it kept. A token-only session has no stored login, and its
  // key stays valid until it is revoked on slivingdoc.dev.
  async signout() {
    const account = this.login;
    const tokenOnly = !this.store.get(STORED_LOGIN);
    this.signingOut = true;
    this.signoutNote = null;
    this.render();
    let { status, body } = { status: 0, body: "" };
    if (!tokenOnly) {
      const line = "{ echo logout; slivingdoc logout </dev/null 2>&1; } > /run/page/out";
      ({ status, body } = await this.run("Sign out", line, { topic: "logout" }));
    }
    const said = (body ?? "").split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
    const result = signoutResult({ account, tokenOnly, status, said });
    if (result.revoked) {
      this.store.remove(STORED_LOGIN);
      this.env.delete("SLIVINGDOC_TOKEN");
      this.login = null;
      this.spaces = null;
      this.connecting = true;
      this.meetings = [];
      this.current = null;
      this.historyItems = null;
      this.signing = null;
    }
    this.signingOut = false;
    this.signoutNote = result;
    this.status(result.message);
    this.show("record");
  }

  // A message from /run/page/out: its first line says what it answers.
  receive(bytes) {
    const { topic, body: raw } = splitMessage(bytes);
    if (topic === "recording-part") return this.parts?.push(raw.slice());
    const body = new TextDecoder().decode(raw);
    this.streams.get(topic)?.(body);
    const waiter = this.waiters.get(topic);
    if (waiter) {
      this.waiters.delete(topic);
      waiter(body);
    }
  }

  // Runs `line` for the button `label`, and resolves to its status and what it sent to the
  // page under `topic`, if it names one. A `followUp` the app ran on its own leaves the hood
  // on the last click. `args` are the line's $1, $2…, for text too big or too free for `env`.
  // A `background` line runs beside the others; `started()` is called as the line starts.
  // `log` is the run log of the job the line belongs to.
  async run(label, line, { topic, followUp = false, hint = "", env, args, action, background = false, started, log = this.voicesLog } = {}) {
    action ??= `minutes:${label}#${++this.actions}`;
    this.runlog.attach(log, action, label, line, args);
    let sent = null;
    let mine = null;
    const listen = () => {
      if (topic) sent = new Promise((resolve) => this.waiters.set(topic, (mine = resolve)));
      started?.();
    };
    if (!followUp) this.hood.ran(label, action, line, hint);
    let status;
    if (background) {
      listen();
      status = await this.machine.spawn(line, action, env, args);
    } else {
      status = await this.machine.run(line, action, env, args, listen);
    }
    this.runlog.ended(action, status);
    const body = sent ? await Promise.race([sent, new Promise((r) => setTimeout(() => r(null), 2000))]) : null;
    if (topic && this.waiters.get(topic) === mine) this.waiters.delete(topic);
    if (topic && body !== null) this.runlog.add(action, { kind: "body", topic, length: body.length });
    return { status, body, action };
  }

  // What the console printed while the app's line `action` had it.
  printed(action, output) {
    this.runlog.add(action, { kind: "printed", text: typeof output === "string" ? output : this.consoleText.decode(output, { stream: true }) });
  }

  // A hood event of a process, for its action's run log.
  processNoted(entry, proc) {
    this.runlog.add(entry.action, { kind: "process", event: entry.kind, text: entry.text, pid: entry.pid, argv: entry.kind === "exec" ? proc?.argv : undefined });
  }

  // The secrets the page holds, by name: what a run log takes out (failure-reports E1).
  secrets() {
    const found = [...this.env].filter(([name]) => SECRET_NAME.test(name));
    const walk = (value, name, from) => {
      if (typeof value === "string") {
        if (SECRET_NAME.test(name)) found.push([`${from} ${name}`, value]);
      } else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) walk(inner, key, from);
      }
    };
    try {
      walk(JSON.parse(this.store.get(STORED_LOGIN) ?? "null"), "", "slivingdoc");
    } catch {
      // No login is kept.
    }
    walk(this.mcp.signins, "", "MCP");
    return found;
  }

  // Opens the run log of a job of `kind` and returns its key.
  openLog(kind, meeting, profile) {
    const key = `${Date.now()}-${++this.logs}`;
    const active = activeProvider(this.env);
    const built = new Date(document.lastModified);
    const head = {
      started: Date.now(), kind, meeting: meeting ?? "", clai: this.clai ?? undefined, profile: profile ?? undefined,
      build: Number.isNaN(built.getTime()) ? document.lastModified : built.toISOString(),
      provider: `${active?.name ?? "no provider"} · ${withFlags(providerFlags(active, kind === "Ask Penelope" ? "penelope" : "agent"), this.config.flags).trim() || "the profile's models"}`,
      browser: navigator.userAgent,
    };
    this.runlog.open(key, head);
    if (!this.clai) this.claiVersion().then((said) => { head.clai = said; });
    this.renderLogs();
    return key;
  }

  // clai's version for a log's head, asked once and off the console.
  claiVersion() {
    this.claiAsked ??= this.run("Ask clai's version", "{ echo clai-version; clai version 2>&1 | head -n 1; } > /run/page/out", {
      topic: "clai-version", followUp: true, background: true, log: null,
    }).then(({ body }) => (this.clai = body?.trim() || "unknown"), () => "unknown");
    return this.claiAsked;
  }

  closeLog(log, failed) {
    this.renderLogs();
    this.runlog.close(log, failed).then(() => this.renderLogs());
  }

  cd() {
    return `mkdir -p ${this.config.notebook} && cd ${this.config.notebook}`;
  }

  // Pulls the notebook when connected, then lists its meetings with their front matter.
  async refresh(followUp = false, log = null) {
    // Until the login has a space, there is nothing to pull from.
    const pull = this.connected && !this.spaces ? `${SLIVINGDOC} pull >&2 || echo pull-failed > /run/page/out; ` : "";
    const line = `${this.cd()} && ${pull}{ echo meetings; ` +
      "for f in $(find meetings/summaries -name '*.md' 2>/dev/null); do echo \"@@ $f\"; " +
      "sed -n '1{/^---$/!q};2,/^---$/p' \"$f\" | head -20; done; } > /run/page/out";
    let pullFailed = false;
    const failed = () => (pullFailed = true);
    const { status, body, action } = await this.run("Refresh", line, { topic: "meetings", followUp, log, started: () => this.streams.set("pull-failed", failed) });
    if (this.streams.get("pull-failed") === failed) this.streams.delete("pull-failed");
    if (status !== 0 || body === null) return this.status(`Listing the notebook failed (exit ${status}).`);
    if (!pullFailed) this.dismiss("slivingdoc could not pull the notebook");
    if (pullFailed) this.fail("slivingdoc could not pull the notebook", "This list is what is on this machine.", log, this.runlog.cause(action), "warn");
    this.meetings = parseList(body);
    this.render();
  }

  // The meeting's summary and transcript files as the notebook on the machine has them.
  async readMeeting(path, label, followUp, log = null) {
    return (await this.readFiles(path, label, followUp, log)).files;
  }

  // readMeeting's files, or null, and the action that read them.
  async readFiles(path, label, followUp, log = null) {
    const line = `${this.cd()} && { echo meeting; cat ${quote(path)}; printf '\\0'; ` +
      `cat ${quote(transcriptOf(path))} 2>/dev/null; } > /run/page/out`;
    const { status, body, action } = await this.run(label, line, { topic: "meeting", followUp, log });
    if (status !== 0 || body === null) return { files: null, action };
    const [summary, transcript = ""] = body.split("\0");
    return { files: { summary, transcript }, action };
  }

  async open(meeting, followUp = false, log = null) {
    const files = await this.readMeeting(meeting.path, `Open ${meeting.title}`, followUp, log);
    if (!files) return this.status(`Could not read ${meeting.path}.`);
    const note = parseNote(files.summary);
    this.recording = null;
    this.current = {
      ...meeting,
      title: note.fields.title || meeting.title,
      summary: note.body,
      transcript: parseNote(files.transcript).body,
      raw: files,
    };
    this.fixes = new Fixes(files);
    this.offer = null;
    this.saveSaid = "";
    this.saveFailed = false;
    this.dropping = false;
    this.historyItems = null;
    this.deleting = null;
    this.status("");
    this.show("meeting", !followUp);
    await this.loadReview();
    await this.showRecording(meeting.path, this.current.title, meeting.date);
  }

  // The recording the agent made for a meeting, from the machine into the browser's storage.
  async keepRecording(path, key, log = null) {
    const line = `${this.cd()} && f=${quote(path)}; size=$(wc -c < "$f") || exit; ` +
      `for ((at = 0; at < size; at += ${PART})); do { echo recording-part; tail -c +$((at + 1)) "$f" | head -c ${PART}; } > /run/page/out; done; ` +
      "echo recording-end > /run/page/out";
    const parts = [];
    const { status, body } = await this.run("Keep the recording", line, { topic: "recording-end", followUp: true, log, started: () => (this.parts = parts) });
    if (this.parts === parts) this.parts = null;
    if (status !== 0 || body === null) return this.status(`Could not read the recording ${path} (exit ${status}).`);
    if (!(await this.recordings.put(key, new Blob(parts, { type: "audio/wav" })))) {
      this.status("This browser keeps no storage, so the recording is not kept.");
    }
  }

  // The recording kept under `key` at the top of the meeting, which downloads named for `title` and `date`.
  async showRecording(key, title = "recording", date = null) {
    const blob = key === null ? null : await this.recordings.get(key);
    this.proof.setPlayable(false);
    this.player.show(blob, recordingName(title, date), key);
    this.proof.setPlayable(Boolean(blob));
    this.render();
  }

  // The recording kept under `key`, back on the machine at `path`: a run's arguments hold 2 MiB in all.
  async putRecording(key, path, log = null) {
    const blob = await this.recordings.get(key);
    if (!blob) return false;
    for (let at = 0; at < blob.size; at += RECORDING_PART) {
      const part = toBase64(new Uint8Array(await blob.slice(at, at + RECORDING_PART).arrayBuffer()));
      const line = at === 0 ? `mkdir -p ${quote(path.replace(/\/[^/]*$/, ""))} && printf %s "$1" | base64 -d > ${quote(path)}`
        : `printf %s "$1" | base64 -d >> ${quote(path)}`;
      const { status } = await this.run("Put the recording on the machine", line, { followUp: true, args: [part], background: true, log });
      if (status !== 0) return false;
    }
    return true;
  }

  // The run failed after the recording was made: the agent runs again on that recording, which
  // is still on the machine, and is told not to record anew. It starts a conversation of its own,
  // which an answer to it goes on with.
  async retry() {
    const r = this.recording;
    if (!r?.done || !r.audioPath) return;
    const text = r.again ? againText(r.audioPath, r.again) : `The recording of this meeting is already made and is the file ${r.audioPath}. Do not record again and do not ` +
      "ask for one: transcribe that file with audio_transcribe and file the notes.";
    this.dismissAll();
    const profile = await this.replyProfile(r);
    if (!profile) return;
    const voices = r.voices ?? [];
    const job = this.addJob({
      label: "Try again", title: r.title, answering: true, audioPath: r.audioPath, kept: r.kept, profile, again: r.again, path: r.path,
      started: r.started, recordedAt: r.recordedAt, expects: { transcribe: true, audioSeconds: audioSeconds(r) }, voices,
    }, r);
    job.stages = new Set(["recording", "recorded"]);
    this.recording = job;
    this.show("meeting");
    const line = this.agentLine(withPeople(this.config.query(r.title, text, this.connected), voices), null, profile, voices);
    const { status, reply, problem } = await this.runAgent("Try again", line, { job });
    await this.finish(job, status, reply, problem);
  }

  // The open meeting's notes, written anew from its recording by a new conversation. The machine
  // keeps no file past a reload, so the recording goes back on it from this browser first.
  async transcribeAgain() {
    const c = this.current;
    this.asking = null;
    if (!c || !this.player.blob) return this.render();
    if (this.blocker()) return this.refuse();
    this.dismissAll();
    const profile = await this.trusts();
    if (!profile) return this.render();
    const seconds = this.player.seconds;
    const started = c.date?.getTime() ?? Date.now() - seconds * 1000;
    // The people ticked in the note, pre-ticked with those the meeting's kept segments named (P7).
    const voices = await this.againVoices(c.path);
    const job = this.addJob({
      label: "Transcribe again", title: c.title, answering: true, again: c.path, path: c.path, kept: c.path, profile,
      started, recordedAt: started + seconds * 1000, audioSeconds: seconds, expects: { transcribe: true, audioSeconds: seconds }, voices,
    });
    job.stages = new Set(["recording", "recorded"]);
    this.recording = job;
    this.show("meeting");
    const audio = againPath(c.path);
    if (!(await this.putRecording(c.path, audio, job.log))) {
      return this.finish(job, 1, "", { title: "The recording could not be put back on the machine" });
    }
    job.audioPath = audio;
    const line = this.agentLine(withPeople(this.config.query(c.title, againText(audio, c.path), this.connected), voices), null, profile, voices);
    const { status, reply, problem } = await this.runAgent("Transcribe again", line, { job });
    await this.finish(job, status, reply, problem);
  }

  // The open meeting, gone, once the eraser's post-it said yes.
  async deleteMeeting() {
    const c = this.current;
    this.deleting = null;
    if (!canDelete(c, this.jobs) || this.removing || this.saving || this.penelopeBusy) return this.render();
    this.removing = true;
    this.render();
    try {
      if (await this.eraseMeeting(c)) await this.refresh(true);
    } finally {
      this.removing = false;
      this.render();
    }
  }

  // The filed meeting `m`, gone: its notes from the notebook, and from this browser its recording and
  // kept segments. A commit that fails puts the notes back and keeps the rest. Resolves whether it is gone.
  async eraseMeeting(m) {
    const c = this.current?.path === m.path ? this.current : null;
    if (c) this.proof.close(false);
    const notes = [m.path, transcriptOf(m.path)];
    // What a failed commit puts back.
    const raw = !this.connected ? null : c?.raw ?? (await this.readMeeting(m.path, "Read the meeting", true));
    if (this.connected && !raw) {
      this.fail("The meeting could not be deleted", "It could not be read from the notebook.");
      return false;
    }
    // The recording where a run of this tab left it on the machine, and where Transcribe again put it.
    const audio = this.jobs.filter((j) => j.audioPath && [j.filed, j.again].includes(m.path)).map((j) => j.audioPath);
    const line = `${this.cd()} && rm -f ${[...new Set([...notes, againPath(m.path), ...audio])].map(quote).join(" ")}`;
    const { status, action } = await this.run(`Delete ${m.title}`, line, { followUp: true });
    if (status !== 0) {
      this.fail("The meeting could not be deleted", "Its files are still in the notebook.", null, this.runlog.cause(action));
      return false;
    }
    const ran = {};
    if (this.connected && !(await this.commit(`Minutes: deleted ${m.title}`, null, ran))) {
      await this.writeFiles([[notes[0], raw.summary], [notes[1], raw.transcript]].filter(([, text]) => text), true, "Put the meeting back");
      this.fail("slivingdoc could not delete the meeting", "The notebook is as it was, and the recording is kept.", null, this.runlog.cause(ran.action));
      return false;
    }
    await this.notebook?.remove(notes);
    await this.recordings.remove(m.path);
    await this.segments?.remove(m.path);
    this.meetings = this.meetings.filter((x) => x.path !== m.path);
    if (this.current === c && c) {
      this.current = null;
      this.recording = null;
      this.fixes = null;
      this.offer = null;
      this.saveSaid = "";
      this.historyItems = null;
      this.reviewing = null;
      await this.showRecording(null);
      this.show("record", true);
      this.status(`Deleted “${m.title}”.`);
    }
    return true;
  }

  // Penelope's delete_meeting: she asks once in her bubble for all the meetings her answer named,
  // and a yes deletes them as the eraser would.
  penelopeDelete(paths) {
    const named = [...new Set(paths)].map((path) => this.meetings.find((m) => m.path === path)).filter((m) => canDelete(m, this.jobs));
    if (named.length === 0) return this.penelope.nudge("I found no meeting I can delete there: it is not in the notebook, or a run is working on it.");
    const titles = (list) => list.map((m) => (this.current?.path === m.path ? this.titleOf(this.current) : m.title));
    const { text, yes, no } = deleteAsk(titles(named), this.connected);
    this.penelope.confirm(text, [yes, no], async () => {
      if (this.removing || this.saving || this.penelopeBusy) return { say: "Hang on, the app is busy. Ask me again in a moment.", mood: "sorry" };
      this.removing = true;
      this.deleting = null;
      this.render();
      const gone = [];
      const kept = [];
      try {
        for (const m of named) {
          const title = titles([m])[0];
          const can = canDelete(this.meetings.find((x) => x.path === m.path), this.jobs);
          (can && (await this.eraseMeeting(m)) ? gone : kept).push(title);
        }
        if (gone.length) await this.refresh(true);
      } finally {
        this.removing = false;
        this.render();
      }
      return deleteSaid(gone, kept);
    });
  }

  async history() {
    if (!this.connected) {
      this.historyItems = ["Connect slivingdoc to keep a history of the notebook."];
      return this.render();
    }
    const line = `${this.cd()} && { echo history; slivingdoc log --limit 10; } > /run/page/out`;
    const { body } = await this.run("History", line, { topic: "history" });
    this.historyItems = (body ?? "").split("\n").filter(Boolean);
    this.render();
  }

  // `chat` is the conversation the query goes on with, or null for a new one. Every run cds to the
  // one notebook, so a reply names its conversation: `chat continue <id>` sends to that one, where
  // -dre would go on with whichever run in the notebook ended last, another meeting's when several
  // run at once. Its flags go after `continue` and before the id. `profile` is the conversation's
  // pin (trusts, replyProfile). `voices` are the meeting's people, whom the run's transcriptions expect (-voices).
  agentLine(query, chat = null, profile = this.config.profile, voices = []) {
    const c = this.config;
    const env = `${c.env ? `${c.env} ` : ""}${c.logLevel ? `LOG_LEVEL=${c.logLevel} ` : ""}`;
    const flags = withFlags(providerFlags(activeProvider(this.env), "agent"), c.flags);
    // slivingdoc's server then keeps the notebook the agent's file tools write in.
    const root = this.connected ? 'SLIVINGDOC_WORKSPACE_ROOT="$PWD" ' : "";
    // -json: every line clai prints, on either stream, is a record, and each goes to the page.
    // The page reads the reply and what went wrong from them and draws them on the console
    // (runAgent), so nothing of clai's is printed there as JSON.
    // clai stays the pipeline's own first program, so the peek files what it starts under this
    // click. This bash's PIPESTATUS says 0 for it whatever it exited with, so a failed run is
    // told by its error record.
    // -n: a hub profile that changed since it was trusted is refused at once, not asked about on
    // the console. The pin keeps that from happening; -n stays as the backstop.
    // -af json: the transcript's segments with their times, which the app files as they are (writeTranscript).
    const common = `-reply-only -n -af json ${voicesFlag(voices)}-profile-path ${profile} ${flags}`;
    const command = chat ? `chat continue ${common}${quote(chat)}` : `${common}query`;
    return `${this.cd()} && ${root}${env}clai -json ${command} ${quote(query)}${AGENT_PIPE}`;
  }

  // Runs the agent with `line` and resolves to its exit status and reply. A tool that fails
  // on the way and what stopped the run each become a note that points under the hood. The run
  // goes on beside the app's other lines, and `options.job` follows it.
  async runAgent(label, line, options = {}) {
    const job = options.job ?? null;
    // A run outside a job and its caller's log keeps a log of its own.
    const log = options.log ?? job?.log ?? this.openLog(label, "");
    const own = !options.log && !job?.log;
    const n = ++this.agentRuns;
    const action = `minutes:${label}#${++this.actions}`;
    const stopFile = stopFileOf(n);
    if (job) Object.assign(job, { action, stopFile });
    const unwatch = job ? this.watchStages(job) : null;
    const run = new AgentRun();
    const printer = new RecordPrinter();
    // Runs take turns on the terminal: what another left open closes, and each says whose lines follow.
    const say = (text) => {
      if (this.printing === printer) return text;
      const lead = this.printing ? `${this.printing.end()}\x1b[2m── ${label}\x1b[0m\r\n` : "";
      this.printing = printer;
      return lead + text;
    };
    // Where the terminal shows what stopped the run, for its note to point at.
    let failedAt = null;
    this.streams.set(`agent:${n}`, (body) => {
      for (const text of body.split("\n")) {
        if (!text.trim()) continue;
        const record = run.take(text);
        this.runlog.add(action, record ? { kind: "record", record } : { kind: "stray", text });
        if (record?.type === "diagnostic" && QUIET_LEVELS.has(record.level)) continue;
        if (!record) {
          failedAt = this.terminal.mark(say(printer.raw(text))) ?? failedAt;
        } else if (record.type === "error") {
          failedAt = this.terminal.mark(say(printer.print(record)));
        } else {
          // A failed tool stays on the terminal; only a failed run puts up a note.
          this.terminal.write(say(printer.print(record)));
        }
        if (record && job) this.follow(job, record);
        if (record) options.onRecord?.(record);
      }
    });
    // The run's last message: what is still open on the console closes before its prompt.
    this.streams.set(`agent-end:${n}`, () => {
      this.terminal.write(printer.end());
      if (job) job.agentEndAt ??= Date.now();
    });
    await this.putVoices(log);
    const { status } = await this.run(label, line, {
      action, hint: options.hint, followUp: options.followUp, topic: `agent-end:${n}`,
      env: { MINUTES_RUN: `:${n}`, CLAI_AUDIO_STOP_FILE: stopFile }, background: true, log,
    });
    this.streams.delete(`agent:${n}`);
    this.streams.delete(`agent-end:${n}`);
    unwatch?.();
    if (job) job.agentEndAt ??= Date.now();
    this.terminal.write(printer.end());
    if (this.printing === printer) this.printing = null;
    await this.takeVoices(log);
    // The conversation clai saved the run in, for an answer to go on with.
    if (job && run.chat) job.chat = run.chat;
    const changed = untrustedProfile(run.errors);
    if (changed) this.distrust();
    const found = changed ? changedProblem(changed) : problemOf(run, status);
    const problem = found ? { ...found, at: failedAt } : null;
    // The pipeline's status is 0 whatever clai exited with (agentLine), so its cause names none then.
    const cause = changed ? null : this.runlog.cause(action);
    if (problem) this.note({ ...problem, log, cause: cause && status === 0 ? { ...cause, status: null } : cause });
    if (own) this.closeLog(log, Boolean(problem) || status !== 0);
    // A run that reported an error failed, whatever status the pipeline gave.
    return { status: status === 0 && problem ? 1 : status, reply: run.text, problem };
  }

  // The programs a recording runs are still loading (loadplan.js): it would start late.
  get loadingRecorder() {
    return !(this.machine.has?.("record") ?? true);
  }

  // Why a recording cannot start yet, or "" when it can.
  // Says why a run cannot start, and points at the card on the pad that fixes it.
  refuse() {
    const why = this.blocker();
    this.pointAt(this.spaces && activeProvider(this.env) ? "space-form" : "provider-card");
    return this.status(why);
  }

  // Rings the block of the pad with this id, when it shows (pointer.js).
  pointAt(id) {
    return this.pointer?.at(document.getElementById(id)) ?? Promise.resolve(false);
  }

  blocker() {
    if (!activeProvider(this.env) && !this.config.flags) return "Connect an AI provider first.";
    if (this.spaces) return "Choose the slivingdoc space for your meetings first.";
    return "";
  }

  // Listens to the share until sound comes through, so that a recording never starts on a share
  // that records nothing. Each quiet round says so; a new share starts a new listen.
  async listen() {
    const shared = this.audio.access().computer;
    if (shared?.via !== "share" || this.listening === shared.label + this.shares) return;
    const round = shared.label + this.shares;
    this.listening = round;
    this.heard = false;
    this.silent = false;
    this.render();
    const meter = this.$("#precheck-level");
    for (;;) {
      const heard = await this.audio.hearShare({ onLevel: (peak) => meter.style.setProperty("--level", Math.min(1, peak * 4)) });
      if (this.listening !== round) return;
      if (heard !== "silent") {
        this.heard = heard === "sound";
        this.listening = null;
        meter.style.setProperty("--level", 0);
        return this.render();
      }
      this.silent = true;
      this.render();
    }
  }

  // From a click: a screen or tab to share, then listening to it.
  async shareComputer() {
    if ((await this.audio.share()) !== "shared") return;
    this.shares++;
    this.micOnly = false;
    this.listen();
  }

  // While recording `r` captures the shared tab, a minute without sound from it asks whether it
  // is the right tab: in the page, in its title, and as a system notification when allowed.
  async watchQuiet(r) {
    if (this.audio?.access().computer?.via !== "share") return;
    const recording = () => !r.done && !r.stages.has("recorded");
    const capturesTab = () => this.audio.inputs().some((i) => i.name === "tab");
    await this.audio.followShare({
      quietMs: QUIET_MS,
      active: recording,
      onQuiet: () => capturesTab() && this.quietTab(r, true),
      onSound: () => this.quietTab(r, false),
    });
    this.quietTab(r, false);
  }

  quietTab(r, quiet) {
    if (Boolean(r.quiet) === quiet) return;
    r.quiet = quiet;
    this.renderTab();
    this.quietNotice?.close();
    this.quietNotice = null;
    if (quiet && globalThis.Notification?.permission === "granted") {
      this.quietNotice = new Notification("Are you sharing the right tab?", {
        body: "Penelope has heard nothing from the shared tab for a minute.", tag: "minutes-quiet", icon: ICON,
      });
      this.quietNotice.onclick = () => globalThis.focus();
    }
    this.renderRecording();
  }

  check() {
    return precheck(this.audio.access(), audioLimits(this.platform).share, {
      micOnly: this.recordsMicOnly, heard: this.heard, silent: this.silent, phone: isPhone(this.platform),
    });
  }

  // The user skipped the computer's sound, or this is a phone, which can share none (audio.js isPhone).
  get recordsMicOnly() {
    return this.micOnly || isPhone(this.platform);
  }

  async record(title, details) {
    // The people ticked as the row shows them at the click (record.16).
    const voices = this.people?.ticked() ?? [];
    if (this.loadingRecorder) return this.status("Still getting ready to record: its programs are loading.");
    if (this.blocker()) return this.refuse();
    if (this.audio && !this.check().ready) return this.status("Tick off the checklist first.");
    const inputs = inputsToRecord(this.recordsMicOnly, this.audio?.access().computer ?? null);
    this.status("");
    // The checklist's listening is done with; a shared tab is followed while it records (watchQuiet).
    this.listening = null;
    if (globalThis.Notification?.permission === "default") Notification.requestPermission();
    const profile = await this.trusts();
    if (!profile) return;
    if (recordingJob(this.jobs)) return this.status("A meeting is being recorded. Stop it before starting another.");
    // Recording past the sign-in note answers it: the notes stay in this browser.
    if (!this.connected && this.connecting) this.keepLocal();
    // Nothing of the last meeting carries over: its notes, recording, history or the form's text.
    this.current = null;
    this.fixes = null;
    this.offer = null;
    this.saveSaid = "";
    this.historyItems = null;
    this.levels = [];
    this.$("#title").value = "";
    this.$("#details").value = "";
    this.people?.reset();
    this.renderWave();
    const job = this.addJob({ label: "Record", title, recording: true, profile, voices });
    this.recording = job;
    this.show("meeting", true);
    await this.showRecording(null);
    const line = this.agentLine(withPeople(this.config.query(title, details, this.connected, inputs), voices), null, profile, voices);
    const { status, reply, problem } = await this.runAgent("Record", line, {
      job, hint: "Stop and summarize creates the run's stop file, which ends the agent's recording.",
    });
    await this.finish(job, status, reply, problem);
  }

  async answer(text) {
    const before = this.recording;
    // An answer before the recording was made may start it.
    const records = Boolean(before?.recording && !before.recordResult);
    if (records && recordingJob(this.jobs)) return this.status("A meeting is being recorded. Stop it before answering.");
    const profile = await this.replyProfile(before);
    if (!profile) return;
    this.$("#reply").value = "";
    const title = before?.title ?? this.current?.title ?? "Meeting";
    // The answer goes on with the conversation of the run it answers. A run that stopped before
    // clai saved one leaves none: then the meeting starts again, with the answer as its details.
    const chat = before?.chat ?? null;
    // The people the meeting started with (P7).
    const voices = before?.voices ?? [];
    // The meeting it is about, and where its recording is kept: a run that filed has them under `filed` (record.5, record.6).
    const job = this.addJob({
      label: "Answer", title, answering: true, recording: records,
      audioPath: before?.audioPath, kept: before?.kept ?? before?.filed, path: before?.path ?? before?.filed ?? this.current?.path, chat, profile,
      transcribed: before?.filed ? undefined : before?.transcribed, voices,
    }, before);
    this.recording = job;
    this.show("meeting");
    const line = chat ? this.agentLine(text, chat, profile, voices)
      : this.agentLine(withPeople(this.config.query(title, text, this.connected), voices), null, profile, voices);
    const { status, reply, problem } = await this.runAgent("Answer", line, { job });
    await this.finish(job, status, reply, problem);
  }

  // Transcribe again's people row, drawn from the kept library, then pre-ticked for the people the
  // meeting's kept segments named (P7).
  drawAgainPeople() {
    const path = this.current?.path ?? null;
    const row = this.againPeople;
    if (!row || !path) return null;
    const drawn = (async () => {
      const named = namedIn((await this.segments?.get(path))?.segments);
      await row.show();
      row.reset();
      row.tick(named);
    })().catch(() => {});
    this.againDrawing = { path, drawn };
    return drawn;
  }

  // Whom Transcribe again names for the meeting at `path`: those ticked in its note, or, when the note
  // was not drawn for it, the people its kept segments named (P7).
  async againVoices(path) {
    if (this.againDrawing?.path !== path) return namedIn((await this.segments?.get(path))?.segments);
    await this.againDrawing.drawn;
    return this.againPeople.ticked();
  }

  // New recording's people row, drawn from the kept library, then pre-ticked for the name typed (record.16).
  async drawPeople() {
    if (!this.people) return;
    await this.people.show();
    await this.people.title(this.$("#title").value);
  }

  // The open meeting's kept segments and the library's people, which the review is drawn from (record.8).
  async loadReview() {
    const path = this.current?.path ?? null;
    const n = (this.reviewLoads = (this.reviewLoads ?? 0) + 1);
    const [kept, people] = await Promise.all([path ? (this.segments?.get(path) ?? null) : null, this.voices?.people() ?? []]);
    if (n !== this.reviewLoads || (this.current?.path ?? null) !== path) return;
    this.reviewing = { path, kept, people };
    this.renderMeeting();
  }

  // P1: the kept library goes on the machine before a run or a voices command; when it cannot, the run goes on (record.13).
  async putVoices(log = null) {
    if (!this.voices) return;
    this.voicesLog = log;
    const put = await this.voices.put();
    this.voicesLog = null;
    if (put) return;
    this.terminal.write("\r\n\x1b[33mThe voice library could not be put on the machine; this run goes on without it.\x1b[0m\r\n");
  }

  // P1: what a run or a command wrote in the library comes back, and the people row and the review are drawn again.
  async takeVoices(log = null) {
    if (!this.voices) return;
    this.voicesLog = log;
    const taken = await this.voices.take();
    this.voicesLog = null;
    if (!taken) {
      this.terminal.write("\r\n\x1b[33mThe voice library could not be taken back from the machine; the next run takes it.\x1b[0m\r\n");
    }
    this.drawPeople();
    await this.loadReview();
  }

  // A `clai audio voices` command between a put and a take: its exit status and its first line of output.
  async voicesRun(label, args) {
    await this.putVoices();
    const topic = `voices-said-${++this.actions}`;
    const line = 'out=$(clai audio voices "$@" </dev/null 2>&1); s=$?; ' +
      `{ echo ${topic}; printf '%s\\n%s\\n' "$s" "\${out%%$'\\n'*}"; } > /run/page/out; exit $s`;
    const { status, body } = await this.run(label, line, { topic, args, background: true });
    const [code, first = ""] = (body ?? "").split("\n");
    const exit = body === null ? status || 1 : Number(code);
    const said = first || `The voices command exited with ${exit}.`;
    this.terminal.write(`\r\n${said}\r\n`);
    await this.takeVoices();
    return { status: exit, said };
  }

  // What the review chose: each command between its own put and take, then the renames and names saved once (record.9–.12).
  // The review shows each step as it goes (show.6), from the click to the last save.
  async choose(choices, names) {
    const c = this.current;
    if (!c || this.choosing || this.saving || this.blocked()) return;
    this.choosing = true;
    const doing = (text) => {
      this.naming = text ? { path: c.path, text } : null;
      this.renderMeeting();
    };
    doing(choices.length ? choosingStep(choices[0], 0, choices.length) : NAMING_STEP);
    try {
      await this.chose(c, choices, names, doing);
    } finally {
      this.choosing = false;
      doing("");
    }
  }

  async chose(c, choices, names, doing) {
    // A row's rename is saved only when every overrule of that row succeeded (P4).
    const rows = new Map();
    const rowOf = (choice) => `${choice.from}\n${choice.to}`;
    for (const choice of choices.filter((ch) => ch.kind === "overrule")) {
      if (!rows.has(rowOf(choice))) rows.set(rowOf(choice), { from: choice.from, to: choice.to, clips: [], done: [] });
      rows.get(rowOf(choice)).clips.push(choice.clip);
    }
    const failed = [];
    let wav = null;
    for (const [i, choice] of choices.entries()) {
      if (choice.kind === "remember" && !wav) {
        doing("Getting the recording ready…");
        if (await this.putRecording(c.path, againPath(c.path))) wav = againPath(c.path);
        else {
          failed.push("The recording could not be put on the machine, so no voice was remembered.");
          break;
        }
      }
      doing(choosingStep(choice, i, choices.length));
      const label = { keep: "Keep the voice", overrule: "Overrule the voice", remember: "Remember the voice" }[choice.kind];
      const { status, said } = await this.voicesRun(label, voicesCommand(choice, wav));
      if (status !== 0) failed.push(said);
      else if (choice.kind === "overrule") rows.get(rowOf(choice)).done.push(choice.clip);
    }
    // P5: what failed shows on the terminal, and in the review only while the meeting it was chosen on is open.
    const tell = (line) => {
      this.terminal.write(`\r\n${line}\r\n`);
      failed.push(line);
    };
    const renames = [];
    for (const { from, to, clips, done } of rows.values()) {
      const left = clips.filter((clip) => !done.includes(clip));
      if (left.length === 0) renames.push([from, to]);
      else tell(`${from} is not renamed ${to}: overruling ${left.join(", ")} failed.`);
    }
    const here = () => this.current?.path === c.path;
    if (here()) this.review?.said(failed.join(" "));
    const why = !here() ? "the meeting was closed" : this.saving ? "a save was under way" : "no line of the notes names them";
    if (here() && [...renames, ...names].some(([, name]) => name)) doing(NAMING_STEP);
    const unsaved = here() ? await this.nameSpeakers([...renames, ...names]) : [...renames, ...names].filter(([, name]) => name);
    if (unsaved.length === 0) return;
    tell(`Not saved in the notes, as ${why}: ${unsaved.map(([from, to]) => `${from} as ${to}`).join(", ")}.`);
    if (here()) this.review?.said(failed.join(" "));
  }

  // What a run heard and learned, kept under the meeting it filed (record.5–.7); `held`: its recording is kept under `path`.
  async keepSegments(r, path, held) {
    if (!this.segments) return;
    const learned = r.learned ?? [];
    if (r.transcription && held) await this.segments.keep(path, r.transcription.segments, r.transcription.naming, learned);
    else if (!r.transcribedAt && learned.length) {
      const kept = await this.segments.get(path);
      await this.segments.keep(path, kept?.segments ?? [], kept?.naming ?? null, learned);
    } else return;
    if (this.current?.path === path) await this.loadReview();
  }

  // Names for the speakers, put in both notes as corrections and saved; resolves the [old, new] pairs it did not put in.
  async nameSpeakers(names) {
    const c = this.current;
    const given = names.filter(([, name]) => name);
    if (!c || !this.fixes || this.saving || given.length === 0) return given;
    const files = ["transcript", "summary"];
    const idle = given.filter(([label, name]) => files.every((file) => named(this.fixes.result(file), label, name) === this.fixes.result(file)));
    const rename = (text) => given.reduce((t, [label, name]) => named(t, label, name), text);
    const changes = files.flatMap((file) => this.fixes.adopt(file, rename(this.fixes.result(file))));
    if (changes.length === 0) return given;
    this.fixes.change(changes);
    await this.saveFixes();
    return idle;
  }

  // Penelope edits copies of the files as they read now; her changes return as one step of proposals.
  // Penelope's turn, on her desk: app.md, the copies of the meeting in focus, and what the screen shows.
  async askPenelope(request) {
    // She thinks with the user's AI provider: without one she points at where to connect it.
    if (!activeProvider(this.env) && !this.config.flags) {
      return {
        say: "I can't think without an AI provider yet. [**Connect one on the pad**](#provider-card): I've circled it for you.",
        mood: "unsure", step: null, after: () => this.pointAt("provider-card"),
      };
    }
    const c = this.penelopeFocus();
    let log = null;
    let failed = false;
    this.penelopeBusy = true;
    if (c) {
      this.proof.close(true);
      this.proof.locked = true;
    }
    this.render();
    try {
      this.penelopeProfile ??= await fetch(new URL("./penelope.json", import.meta.url)).then((r) => r.text());
      this.penelopeApp ??= await fetch(new URL("./penelope-app.md", import.meta.url)).then((r) => r.text());
      const files = c ? { transcript: this.fixes.result("transcript"), summary: this.fixes.result("summary") } : null;
      // The tools attached join her profile, each signed in by its entry in clai's token store.
      const tools = await this.penelopeTools();
      const args = [withServers(this.penelopeProfile, tools.map((t) => t.server)), this.penelopeApp, ...(files ? [files.transcript, files.summary] : [])];
      const signins = tools.map((t) => {
        args.push(JSON.stringify(t.signin.entry));
        return ` && printf %s "\${${args.length}}" > "$d/${t.name}"`;
      });
      const copy = `mkdir -p ${PENELOPE_DESK} && cd ${PENELOPE_DESK} && printf %s "$1" > ${PENELOPE_HOME}/profile.json && printf %s "$2" > app.md && ` +
        (files ? 'printf %s "$3" > transcript.md && printf %s "$4" > summary.md' : "rm -f transcript.md summary.md") +
        (tools.length > 0 ? ` && d="$(clai confdir)/${MCP_AUTH}" && mkdir -p "$d"${signins.join("")}` : "");
      log = this.openLog("Ask Penelope", c?.title ?? "", `${PENELOPE_HOME}/profile.json sha256=${await sha256Hex(args[0])}`);
      const { status: copied } = await this.run("Copy the notes for Penelope", copy, { followUp: true, args, log });
      failed = copied !== 0;
      if (failed) return { say: "I could not get my desk ready.", mood: "sorry", step: null };
      const actions = this.penelopeActions();
      const query = penelopeQuery({
        screen: this.penelopeScreen(c, files), actions: actions.map((a) => `${a.name}: ${a.what}`), corrections: c ? correctionsOf(this.fixes) : [], request,
      });
      const k = this.config;
      const line = `cd ${PENELOPE_DESK} && ${k.env ? `${k.env} ` : ""}${k.logLevel ? `LOG_LEVEL=${k.logLevel} ` : ""}clai -json -reply-only ${this.penelopeTalked ? "-dre " : ""}` +
        `-profile-path ${PENELOPE_HOME}/profile.json ${withFlags(providerFlags(activeProvider(this.env), "penelope"), k.flags)}query ${quote(query)}${AGENT_PIPE}`;
      const { status, reply, problem } = await this.runAgent("Ask Penelope", line, { log, onRecord: (record) => this.penelope.activity(record) });
      if (tools.length > 0) await this.keepSignins(tools, log);
      failed = status !== 0;
      if (failed) return { say: `${problem?.title ?? "I stopped before I was done"}. Nothing changed.`, mood: "sorry", step: null };
      this.penelopeTalked = true;
      const answer = { ...parseSay(reply), after: () => this.penelopeDo(actions, answer.actions) };
      if (!c) return { ...answer, step: null };
      if (this.penelopeFocus() !== c) return { say: `${answer.say}\n\nYou opened another meeting meanwhile, so I dropped my changes.`, mood: "sorry", step: null };
      const read = `cd ${PENELOPE_DESK} && { echo penelope-files; cat transcript.md; printf '\\0'; cat summary.md; } > /run/page/out`;
      const { body } = await this.run("Read Penelope's copies", read, { topic: "penelope-files", followUp: true, log });
      if (body === null) return { ...answer, mood: "sorry", step: null };
      const [transcript, summary = ""] = body.split("\0");
      // A file Penelope rewrote ends as the one she was given did, so a lost final newline is no correction.
      const ending = (text, like) => text.replace(/\n?$/, like.endsWith("\n") ? "\n" : "");
      // The front matter stays the app's.
      const changes = [...this.fixes.adopt("transcript", ending(transcript, files.transcript)), ...this.fixes.adopt("summary", ending(summary, files.summary))]
        .filter((ch) => ("after" in ch ? ch.after + 1 : ch.n) >= this.fixes.front[ch.file]);
      if (changes.length === 0) return { ...answer, step: null };
      this.fixes.change(changes);
      this.offer = null;
      this.touched();
      const first = Math.min(...changes.filter((ch) => ch.file === "transcript").map((ch) => ("after" in ch ? ch.after : ch.n)));
      this.proof.elements.get(first)?.scrollIntoView({ block: "center" });
      const count = changes.reduce((sum, ch) => sum + ("after" in ch ? Math.max(1, ch.lines.length) : 1), 0);
      return { ...answer, step: { fixes: this.fixes, depth: this.fixes.undos.length, count } };
    } finally {
      if (log) this.closeLog(log, failed);
      this.penelopeBusy = false;
      if (c) this.proof.locked = false;
      this.render();
    }
  }

  // What Penelope may have the app do now: press a button that shows, or open or delete a filed meeting.
  penelopeActions() {
    const shows = (selector) => this.$(selector)?.getClientRects().length > 0;
    const pressing = Object.entries(PENELOPE_BUTTONS).filter(([, [selector]]) => shows(selector)).map(([name, [selector, what]]) => ({
      name, what, run: () => shows(selector) && this.$(selector).click(),
    }));
    const open = {
      name: "open_meeting",
      what: "open a filed meeting; give its path, as in meetings/summaries/….md",
      run: ({ meeting }) => {
        const m = this.meetings.find((x) => x.path === meeting);
        if (m) this.visit(m);
      },
    };
    // Taken together by penelopeDo, so the user is asked once for all of them.
    const erase = {
      name: "delete_meeting",
      what: "delete a filed meeting for good, its summary, transcript and recording; give its path, one action for each meeting. " +
        "The app asks the user once, in your bubble, before it deletes any",
    };
    return [...pressing, ...(this.meetings.length > 0 ? [open, erase] : [])];
  }

  // Takes the actions Penelope's answer names, of those she was offered.
  penelopeDo(offered, asked) {
    for (const a of asked) offered.find((o) => o.name === a.action)?.run?.(a);
    const erase = offered.some((o) => o.name === "delete_meeting") ? asked.filter((a) => a.action === "delete_meeting") : [];
    if (erase.length > 0) this.penelopeDelete(erase.map((a) => a.meeting ?? this.current?.path));
  }

  // The meeting Penelope may correct: the filed one on the pad, with a transcript, while nothing records it.
  penelopeFocus() {
    const c = this.current;
    const r = this.recording;
    return (this.view ?? "record") === "meeting" && c && !(r && !r.done) && withoutHeading(c.transcript, "transcript").trim() ? c : null;
  }

  // What the user sees, for Penelope: the meeting in focus, the runs, the connections and what shows on the screen.
  penelopeScreen(c, files) {
    const texts = (selector) => [...new Set([...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0)
      .map((el) => `${el.textContent.trim().replace(/\s+/g, " ")}${el.disabled ? " (disabled)" : ""}`).filter((t) => /^\w/.test(t)))];
    const lines = (text) => text.split("\n").length;
    const active = activeProvider(this.env);
    const now = Date.now();
    return [
      c ? `Meeting in focus: “${c.title}” (${c.path}); its copies are transcript.md (${lines(files.transcript)} lines) and summary.md (${lines(files.summary)} lines)`
        : "Meeting in focus: none, so there are no copies to change",
      `View: ${this.view === "meeting" ? "a meeting" : "New recording"}`,
      ...this.jobs.filter((j) => !j.done).map((j) => `In progress: “${j.title}”, ${jobStatus(j, now, this.pace)}`),
      `AI provider: ${active ? active.name : "not connected"}`,
      `Tools attached for you (beta, under + Tools in your bubble): ${MCP_SERVERS.filter((t) => this.mcp.attached.includes(t.id)).map((t) => `${t.name}, as the mcp_${t.id}_ tools`).join("; ") || "none"}`,
      `Notebook: ${this.login ? `slivingdoc, signed in as ${this.login}` : this.connected ? "slivingdoc" : "kept in this browser"}, ${this.meetings.length} meetings filed`,
      `Headings showing: ${texts(".top strong, #app h1, #app h2, #app h3, #app legend").join(" · ")}`,
      `Buttons showing: ${texts(".top button, #app button:not(.meeting)").slice(0, 40).join(" · ")}`,
    ];
  }

  undoStep(step) {
    if (this.fixes !== step.fixes || this.fixes.undos.length !== step.depth) return;
    this.fixes.undo();
    this.offer = null;
    this.touched();
  }

  // What Penelope offers with no meeting in focus.
  deskIdeas() {
    return [
      ...(this.meetings.length > 0 ? ["What did we decide in my last meeting?", "What is on my plate from my meetings?"] : []),
      "How do I record the sound of a call?",
      "What does pop out do?",
    ];
  }

  // What Penelope offers to do for the open meeting, before the user asks anything.
  penelopeIdeas(c) {
    const unknown = unknownSpeakers(c.transcript).map((s) => s.label);
    return [
      "Look for other spellings of the names in this meeting",
      ...unknown.slice(0, 1).map((label) => `Who might ${label} be?`),
      "Bring the summary up to date with the transcript",
      "Take out filler words like um and uh",
    ];
  }

  // The agent is done with `r`: the notes it filed open if `r` is in view, else what it said shows.
  async finish(r, status, reply, problem = null) {
    r.status = status;
    r.reply = reply ?? "";
    r.problem = problem;
    this.render();
    // The recording leaves the machine first, whatever became of the run: it is only in this
    // tab's memory there, and a failed transcription or a reload would take it along.
    if (r.audioPath && !r.kept) {
      const key = `unfiled:${r.audioPath}`;
      await this.keepRecording(r.audioPath, key, r.log);
      r.kept = key;
      if (this.recording === r) await this.showRecording(key, r.title, r.startedAt);
    }
    if (status !== 0) return this.ended(r);
    if (r.transcribed) await this.writeTranscript(r);
    if (this.connected) await this.save(r);
    await this.refresh(true, r.log);
    const filed = this.filedBy(r);
    if (filed && !this.connected) await this.keepMeeting(filed.path, r.log);
    let held = false;
    if (filed && r.kept) {
      // Kept under the meeting it now belongs to; a recording kept under another meeting stays there too.
      const blob = r.kept !== filed.path && (await this.recordings.get(r.kept));
      const moved = Boolean(blob) && (await this.recordings.put(filed.path, blob));
      if (moved && r.kept.startsWith("unfiled:")) await this.recordings.remove(r.kept);
      held = moved || (r.kept === filed.path && Boolean(await this.recordings.get(filed.path)));
      r.kept = null;
    }
    if (filed) await this.keepSegments(r, filed.path, held);
    r.savedAt = Date.now();
    r.filed = filed?.path ?? null;
    if (filed && (r.recording || r.expects?.transcribe)) this.learn(r);
    if (filed && this.recording === r) {
      await this.open(filed, true, r.log);
      this.recording = r;
    } else if (filed && r.again && this.current?.path === filed.path) {
      await this.open(filed, true, r.log);
    }
    this.ended(r);
  }

  ended(r) {
    r.done = true;
    if (r.log) this.closeLog(r.log, r.status !== 0);
    if (!this.inSight()) {
      this.unseen = r;
      this.notifyEnd(r);
    }
    if (!this.jobs.some((j) => !j.done)) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.render();
  }

  // The transcript of the meeting job `r` filed, its lines audio_transcribe's own below the agent's front matter.
  async writeTranscript(r) {
    // E7: the paths the run named, in order: linked, written, transcribed again, the job's own.
    const paths = [...new Set([...summariesIn(r.reply), ...[...r.wrote].map(summaryOf), r.again, r.path].filter(Boolean))];
    if (paths.length === 0) return;
    let path;
    let files = null;
    let action;
    for (path of paths) {
      ({ files, action } = await this.readFiles(path, "Read the meeting", true, r.log));
      if (files) break;
    }
    if (!files) return this.fail("The transcript could not be filed", "The meeting the agent filed could not be read.", r.log, this.runlog.cause(action));
    if (!files.summary && !files.transcript) return;
    let output = r.transcribed.text;
    if (output === undefined) {
      const line = `{ echo transcribed; cat ${quote(r.transcribed.file)}; } > /run/page/out`;
      const { status, body, action: read } = await this.run("Read the transcription", line, { topic: "transcribed", followUp: true, log: r.log });
      if (status !== 0 || body === null) return this.fail("The transcript could not be filed", "The transcription could not be read back.", r.log, this.runlog.cause(read));
      output = body;
    }
    const has = frontLines(files.transcript) ? files.transcript : files.summary;
    const front = has.split("\n").slice(0, frontLines(has)).join("\n");
    const text = `${front ? `${front}\n\n` : ""}${transcriptLines(output)}`;
    const wrote = {};
    if (!(await this.writeFiles([[transcriptOf(path), text]], true, "File the transcript", r.log, wrote))) {
      return this.fail("The transcript could not be filed", "It could not be written in the notebook.", r.log, this.runlog.cause(wrote.action));
    }
    r.transcription = heardOf(output);
  }

  // The meeting job `r` filed: linked in its reply, else written by its programs, else the one it was about.
  filedBy(r) {
    const linked = summariesIn(r.reply);
    const wrote = new Set([...r.wrote].map(summaryOf).filter(Boolean));
    return this.meetings.find((m) => linked.includes(m.path)) ??
      this.meetings.find((m) => wrote.has(m.path)) ??
      this.meetings.find((m) => m.path === r.path) ?? null;
  }

  // Publishes what the agent filed, whether or not it committed through its notes tools.
  async save(r) {
    r.stages.add("saving");
    const ran = {};
    if (await this.commit(`Minutes: ${r.title}${r.again ? ", transcribed again" : ""}`, r.log, ran)) return true;
    this.fail("slivingdoc could not save the notes", "They are only on this machine.", r.log, this.runlog.cause(ran.action));
    return false;
  }

  // `ran.action` is the commit's action, for its cause when it fails.
  async commit(message, log = null, ran = {}) {
    const line = `${this.cd()} && ${SLIVINGDOC} commit -m ${quote(message)} >&2`;
    const { status, action } = await this.run("Save to slivingdoc", line, { followUp: true, log });
    ran.action = action;
    return status === 0;
  }

  // Without slivingdoc: a filed meeting's summary and transcript, as the machine has them, kept in this browser.
  async keepMeeting(path, log = null) {
    if (!this.notebook) return;
    const { files } = await this.readFiles(path, "Read the meeting", true, log);
    await this.keepFiles(files ? [[path, files.summary], [transcriptOf(path), files.transcript]] : null, log);
  }

  // Keeps `files` ([path, text]) in this browser; a browser that keeps no site data gets a warning.
  async keepFiles(files, log = null) {
    if (!this.notebook) return;
    if (files && (await this.notebook.keep(files))) return;
    this.fail("The notes are kept in this tab only", "This browser kept no copy of them, so a reload loses them.", log, null, "warn");
  }

  // Without slivingdoc: the notes this browser kept go back onto the machine before it lists them.
  async restoreNotebook() {
    const kept = (await this.notebook?.all()) ?? [];
    if (kept.length === 0) return;
    const dirs = [...new Set(kept.map(([path]) => path.slice(0, path.lastIndexOf("/") + 1) || "."))];
    await this.run("Make the notebook's folders", `${this.cd()} && mkdir -p ${dirs.map(quote).join(" ")}`, { followUp: true });
    for (const batch of restoreBatches(kept, RESTORE_CHARS)) await this.writeFiles(batch, true, "Put back the notes kept in this browser");
  }

  // The texts go as bash's arguments: an env var drops newlines and is inherited (128 KiB cap).
  async writeFiles(entries, followUp = false, label = "Save corrections", log = null, ran = {}) {
    if (entries.length === 0) return true;
    const line = `${this.cd()} && ${entries.map(([path], i) => `printf %s "$${i + 1}" > ${quote(path)}`).join(" && ")}`;
    const { status, action } = await this.run(label, line, { followUp, args: entries.map(([, text]) => text), log });
    ran.action = action;
    return status === 0;
  }

  // No conflict block may stay in the notebook: slivingdoc refuses every later commit.
  async saveFixes() {
    const c = this.current;
    const fixes = this.fixes;
    if (!c || !fixes?.count || this.saving) return;
    this.proof.close(true);
    this.saving = true;
    this.proof.locked = true;
    this.saveFailed = false;
    this.saveSaid = "";
    this.dropping = false;
    this.offer = null;
    this.render();
    const paths = { summary: c.path, transcript: transcriptOf(c.path) };
    const files = Object.keys(paths).filter((file) => fixes.size(file) > 0);
    const notSaved = (said) => {
      this.saveFailed = true;
      this.saveSaid = said;
    };
    try {
      const disk = await this.readMeeting(c.path, "Read the meeting", true);
      if (!disk) return notSaved("Not saved: the meeting could not be read back from the notebook.");
      let lost = 0;
      const texts = files.map((file) => {
        const { text, lost: missed } = fixes.rebase(file, disk[file]);
        lost += missed;
        return [paths[file], text];
      });
      if (!(await this.writeFiles(texts))) return notSaved("Not saved: the files could not be written.");
      if (!this.connected) await this.keepFiles(texts);
      let clashed = 0;
      const message = `Minutes: corrections to ${c.title}`;
      const ran = {};
      if (this.connected && !(await this.commit(message, null, ran))) {
        const back = await this.readMeeting(c.path, "Read the conflict", true);
        const resolved = files.map((file) => [paths[file], resolveConflicts(back?.[file] ?? "")]).filter(([, r]) => r.blocks > 0);
        clashed = resolved.reduce((sum, [, r]) => sum + r.blocks, 0);
        if (clashed === 0) {
          // No conflict: the files go back as they were, and the corrections stay on the post-it.
          await this.writeFiles(files.map((file) => [paths[file], disk[file]]), true);
          this.fail("slivingdoc could not save the corrections", "The notebook is as it was. Saving again tries again.", null, this.runlog.cause(ran.action));
          return notSaved("Not saved to slivingdoc. Try again.");
        }
        if (!((await this.writeFiles(resolved.map(([path, r]) => [path, r.text]), true)) && (await this.commit(message, null, ran)))) {
          this.fail("slivingdoc could not save the corrections", "They are written in the notebook on this machine; saving again tries the commit again.", null, this.runlog.cause(ran.action));
          return notSaved("Not saved to slivingdoc. Try again.");
        }
      }
      const final = (await this.readMeeting(c.path, "Read the saved meeting", true)) ?? disk;
      const said = [
        lost ? `${lost} ${lost === 1 ? "correction was" : "corrections were"} not made: the line changed elsewhere.` : "",
        clashed ? "Where the same lines changed elsewhere, that change was kept." : "",
      ].filter(Boolean).join(" ");
      this.saveSaid = said ? `Saved. ${said}` : this.connected ? "Saved to slivingdoc." : "Saved in this browser.";
      await this.settle(c, final);
      if (!said) {
        const shown = this.saveSaid;
        setTimeout(() => {
          if (this.saveSaid !== shown) return;
          this.saveSaid = "";
          this.render();
        }, 5000);
      }
    } finally {
      this.saving = false;
      this.proof.locked = false;
      this.render();
    }
  }

  // The saved meeting, drawn again once the struck words are rubbed out.
  // The open meeting's name as it reads now, its unsaved rename included.
  titleOf(c) {
    return parseNote(this.fixes?.result("summary") ?? c.raw?.summary ?? "").fields.title || c.title;
  }

  // Renames the open meeting `title`: the title in both notes' front matter, as one correction step
  // on the post-it, saved, undone or dropped with the others. Returns whether it changed anything.
  rename(title) {
    const c = this.current;
    if (!c || !this.fixes || this.saving || this.penelopeBusy || !String(title).trim()) return false;
    const changes = ["summary", "transcript"].flatMap((file) => {
      const text = this.fixes.result(file);
      if (file === "transcript" && !frontLines(text)) return [];
      return this.fixes.adopt(file, retitled(text, title));
    });
    if (changes.length === 0) return false;
    this.fixes.change(changes);
    this.render();
    return true;
  }

  // The title becomes a field: Enter or leaving it renames, Escape keeps the name.
  editTitle() {
    const c = this.current;
    const h1 = this.$("#meeting-title");
    if (!c || !this.fixes || this.saving || this.penelopeBusy || h1.querySelector("input")) return;
    const input = document.createElement("input");
    input.className = "title-edit";
    input.value = this.titleOf(c);
    input.setAttribute("aria-label", "Meeting name");
    h1.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const name = input.value;
      h1.textContent = this.titleOf(c);
      if (keep && this.current === c) this.rename(name);
      h1.focus();
    };
    input.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(event.key === "Enter");
      }
    };
    input.onblur = () => finish(true);
  }

  async settle(c, files) {
    this.proof.settle();
    this.$("#summary").classList.add("settling");
    if (!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) await new Promise((r) => setTimeout(r, 650));
    this.$("#summary").classList.remove("settling");
    if (this.current !== c) return;
    c.raw = files;
    c.summary = parseNote(files.summary).body;
    c.transcript = parseNote(files.transcript).body;
    c.title = parseNote(files.summary).fields.title || c.title;
    const listed = this.meetings.find((m) => m.path === c.path);
    if (listed) listed.title = c.title;
    this.fixes = new Fixes(files);
    this.quiet = true;
    try {
      this.render();
    } finally {
      this.quiet = false;
    }
  }

  // The run's stop file ends its recording: the agent's audio_record watches for it
  // (CLAI_AUDIO_STOP_FILE), so Stop reaches that recording and no other, whatever the terminal runs.
  stop(job = this.recording ?? recordingJob(this.jobs)) {
    if (!job?.stopFile || job.stopSent) return;
    job.stopSent = true;
    this.renderRecording();
    // A stop file that could not be made leaves the recording running: Stop can be clicked again.
    this.machine.touch(job.stopFile, job.action).then((status) => {
      if (status === 0) return;
      job.stopSent = false;
      this.renderRecording();
    });
  }

  // The loudness of the latest samples, 0 to 1, for the waveform.
  level(value) {
    this.levels.push(value);
    if (this.levels.length > 64) this.levels.shift();
    this.popout.wave(this.levels);
    if (this.waving) return;
    this.waving = true;
    requestAnimationFrame(() => {
      this.waving = false;
      this.renderWave();
    });
  }

  // Follows job `r`'s processes: the recording ffmpeg (others take no -i), the provider, slivingdoc, and what they write.
  watchStages(r) {
    const action = r.action;
    const mine = (pid) => this.model.procs.get(pid)?.action === action;
    const listener = (events) => {
      if (r.done) return;
      const ffmpeg = r.recording && this.model.find(action, "ffmpeg").filter((p) => p.argv.includes("-i")).at(-1);
      if (ffmpeg) {
        r.stages.add("recording");
        r.started ??= ffmpeg.start;
        r.quietWatch ??= this.watchQuiet(r);
        if (ffmpeg.end !== null) {
          r.stages.add("recorded");
          r.recordedAt ??= ffmpeg.end;
          r.from ??= ffmpeg.end;
          // clai records into a .part file and renames it once the recording is whole.
          r.audioPath ??= ffmpeg.argv.at(-1).replace(/\.part$/, "");
        }
      }
      for (const e of events) {
        if (!mine(e.pid)) continue;
        if (e.type === "connect" && PROVIDER_HOSTS.has(e.host) && r.stages.has("recorded")) r.stages.add("transcribing");
        if (e.type === "connect" && r.stages.has("recorded") && this.model.procs.get(e.pid).name.startsWith("slivingdoc")) {
          r.stages.add("saving");
        }
        if (e.type === "open" && e.write) r.wrote.add(e.path);
        if (e.type === "rename") r.wrote.add(e.to);
      }
      if (this.recording === r) this.renderRecording();
    };
    this.model.onChange(listener);
    return () => this.model.listeners.delete(listener);
  }

  // What a record of job `r`'s run says of where it is.
  follow(r, record) {
    takeRecord(r, record, Date.now());
    // Only the clips this run's own records name (record.7).
    const learned = learnedOf(record);
    if (learned) (r.learned ??= []).push(learned);
    const result = record.type === "tool_result";
    if (record.type === "tool_call" && record.name === "audio_transcribe") r.stages.add("transcribing");
    if (result && record.name === "audio_transcribe") r.stages.add("writing");
    if (result && record.name === "audio_record") r.stages.add("recorded");
    if (this.recording === r) this.renderRecording();
  }

  // A new job, listed and ticking; the one it `replaces` leaves the list.
  addJob(fields, replaces = null) {
    if (replaces) replaces.replaced = true;
    const job = newJob({ id: this.jobs.length + 1, now: Date.now(), ...fields });
    job.log = this.openLog(job.label, job.title, job.profile);
    this.jobs.unshift(job);
    this.ticker ??= setInterval(() => {
      this.renderList();
      this.renderRecording();
      this.renderTab();
    }, 500);
    this.render();
    return job;
  }

  // Whether the user can see the tab: it shows, and it or its pop-out has focus.
  inSight() {
    return document.visibilityState === "visible" && (document.hasFocus() || Boolean(this.popout.win?.document.hasFocus()));
  }

  // A run that ended out of sight says how, and a click brings the tab back to it.
  notifyEnd(r) {
    if (globalThis.Notification?.permission !== "granted") return;
    const title = r.status !== 0 ? "The agent stopped" : r.filed ? "Notes filed" : "The agent answered";
    const body = r.status !== 0 && r.problem ? `${r.title}: ${r.problem.title}` : r.title;
    const notice = new Notification(title, { body, tag: `minutes-run-${r.id}`, icon: ICON });
    notice.onclick = () => this.pickJob(r);
  }

  // A run picked in the pop-out or a notification: the tab, with the meeting it filed or the run.
  pickJob(job) {
    globalThis.focus();
    const meeting = job.filed && this.meetings.find((m) => m.path === job.filed);
    if (meeting) this.visit(meeting);
    else this.viewJob(job);
  }

  // A job from the list, in the meeting view.
  viewJob(job) {
    if (this.blocked()) return;
    this.current = null;
    this.fixes = null;
    this.offer = null;
    this.historyItems = null;
    this.recording = job;
    this.status("");
    this.show("meeting", true);
    this.showRecording(job.kept ?? null, job.title, job.startedAt);
  }

  get pace() {
    const id = activeProvider(this.env)?.id ?? "other";
    return { ...PACE, ...PROVIDER_PACE[id], ...this.paces()[id] };
  }

  paces() {
    try {
      return JSON.parse(this.store.get(STORED_PACE) ?? "{}") ?? {};
    } catch {
      return {};
    }
  }

  learn(r) {
    const paces = this.paces();
    paces[activeProvider(this.env)?.id ?? "other"] = learnPace(this.pace, r);
    this.store.set(STORED_PACE, JSON.stringify(paces));
  }

  status(text) {
    this.$("#status").textContent = text;
  }

  // Something the app ran failed: a note with what and, under the hood, why.
  // `log` is the run log of the job it failed in; `cause` the failed command's (RunLog.cause).
  fail(title, detail = "", log = null, cause = null, level = "error") {
    this.note({ level, title, detail, hint: null, code: null, log, cause });
  }

  dismissAll() {
    for (const el of this.notes.values()) el.remove();
    this.notes.clear();
    this.placeNotes();
  }

  dismiss(title) {
    for (const [key, el] of this.notes) {
      if (!key.startsWith(`${title}\n`)) continue;
      el.remove();
      this.notes.delete(key);
    }
    this.placeNotes();
  }

  // A note about a problem, hung under the button that peeks under the hood and pointing at
  // it: the terminal there has what the programs printed. An error stays until it is closed;
  // a warning leaves by itself. The same note is shown once.
  // With a `cause` it says which command failed and its last lines; with a `log`, the job's run log can be copied and downloaded.
  note({ level, title, detail, hint, code, at = null, log = null, cause = null }) {
    if (log) this.runlog.noted(log, { level, title, detail, hint, code });
    const host = document.querySelector("#notes");
    const key = `${title}\n${detail}`;
    if (!host || this.notes.has(key)) return;
    const el = document.createElement("div");
    el.className = `note ${level}`;
    el.setAttribute("role", level === "error" ? "alert" : "status");
    const head = document.createElement("strong");
    head.textContent = title;
    const close = document.createElement("button");
    close.className = "note-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "✕";
    const remove = () => {
      el.remove();
      this.notes.delete(key);
      this.placeNotes();
    };
    close.onclick = remove;
    el.append(head, close);
    for (const [text, name] of [[detail, "note-detail"], [hint, "note-hint"]]) {
      if (!text) continue;
      const p = document.createElement("p");
      p.className = name;
      p.textContent = text;
      el.append(p);
    }
    if (code) {
      const tag = document.createElement("code");
      tag.className = "note-code";
      tag.textContent = code;
      el.append(tag);
    }
    if (cause) {
      const why = document.createElement("pre");
      why.className = "note-cause";
      why.textContent = [cause.status === null ? cause.label : `${cause.label} · exit ${cause.status}`, ...cause.lines].join("\n");
      el.append(why);
    }
    if (log) el.append(this.logButtons(log, "note", "Copy log"));
    const look = document.createElement("button");
    look.className = "note-peek";
    look.textContent = "See what the machine printed";
    look.onclick = () => {
      this.peek("terminal");
      // The lines of the terminal the note is about, selected.
      if (at) this.terminal.reveal(at);
      this.placeNotes();
    };
    el.append(look);
    host.append(el);
    this.notes.set(key, el);
    if (level !== "error") setTimeout(remove, 15_000);
    this.placeNotes();
  }

  // Copy and Download for the run log `log`; one that fails says so beside them (failure-reports E4).
  logButtons(log, name, copyText) {
    const row = document.createElement("div");
    row.className = `${name}-log`;
    const button = (kind, text) => {
      const b = document.createElement("button");
      b.className = `${name}-${kind}`;
      b.textContent = text;
      return b;
    };
    const copy = button("copy", copyText);
    const download = button("download", "Download");
    const said = document.createElement("p");
    said.className = `${name}-said`;
    said.hidden = true;
    const say = (text) => {
      said.textContent = text;
      said.hidden = !text;
      this.placeNotes();
    };
    copy.onclick = async () => {
      try {
        const text = this.runlog.text(log);
        if (text === null) throw new Error("no log");
        await navigator.clipboard.writeText(text);
        say("");
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = copyText; }, 2000);
      } catch {
        say("The log could not be copied.");
      }
    };
    download.onclick = () => {
      try {
        const text = this.runlog.text(log);
        const kept = this.runlog.list().find((r) => r.job === log);
        if (text === null || !kept) throw new Error("no log");
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
        link.download = logName(kept);
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
        say("");
      } catch {
        say("The log could not be downloaded.");
      }
    };
    row.append(copy, download, said);
    return row;
  }

  // The peek's Run logs: a row for each log kept and each run under way, newest first (failure-reports Q4).
  renderLogs() {
    const list = document.querySelector("#runlogs");
    if (!list) return;
    const rows = this.runlog.list();
    document.querySelector("#runlogs-none").hidden = rows.length > 0;
    const span = (name, text) => {
      const el = document.createElement("span");
      el.className = `runlog-${name}`;
      el.textContent = text;
      el.title = text;
      return el;
    };
    list.replaceChildren(...rows.map((row) => {
      const li = document.createElement("li");
      li.className = `runlog ${row.state}`;
      const at = new Date(row.started);
      const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      li.append(
        span("when", row.earlier ? `${at.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}` : time),
        span("what", [row.kind, row.meeting].filter(Boolean).join(" · ")),
        span("how", row.state === "failed" ? `failed: ${row.failed || "the run stopped"}` : row.state),
        span("size", bytes(row.size)),
        this.logButtons(row.job, "runlog", "Copy"),
      );
      return li;
    }));
  }

  // Hangs the notes under the peek button, their arrow at its middle, and has the button
  // pulse while there is one.
  placeNotes() {
    const host = document.querySelector("#notes");
    if (!host) return;
    const open = this.notes.size > 0;
    host.hidden = !open;
    this.anchor?.classList.toggle("nudge", open);
    if (!open || !this.anchor) return;
    const at = this.anchor.getBoundingClientRect();
    const right = Math.max(8, document.documentElement.clientWidth - at.right);
    host.style.top = `${Math.round(at.bottom + 12)}px`;
    host.style.right = `${Math.round(right)}px`;
    host.style.setProperty("--arrow", `${Math.round(at.width / 2)}px`);
  }

  // `turn`: the user went there, so a page about something else turns the pad's page.
  show(view, turn = false) {
    this.view = view;
    if (view === "record") this.drawPeople();
    const next = pageOf(view, this.current, this.recording);
    if (turn && turnsPage(this.page, next)) {
      // An earlier meeting is a page back in the pad: it comes down once it is drawn.
      const landed = turnPage(this.$(".content"), turnsBack(this.page, next));
      // The ink on the old page goes with it (sketch.js).
      this.$(".content").dispatchEvent(new Event("pageturn"));
      this.render();
      landed();
      return;
    }
    this.render();
  }

  render() {
    const $ = this.$;
    const active = activeProvider(this.env);
    $("#key-chip").textContent = active ? `${active.name}: ${mask(`KEY=${this.env.get(active.env)}`).slice(4)}` : "AI provider: not connected";
    $("#change-key").hidden = !active;
    $("#notebook-chip").textContent = this.login ? `slivingdoc: ${this.login}` : this.connected ? "slivingdoc: connected" : "slivingdoc: local notebook";
    $("#provider-card").hidden = Boolean(active);
    const signing = this.providerSigning;
    $("#provider-wait").hidden = !signing;
    if (signing) {
      $("#provider-wait-text").textContent = signing.text;
      $("#provider-link").hidden = !signing.state;
      $("#provider-link").href = signing.url;
    }
    const said = this.providerSaid;
    $("#provider-said").hidden = !said;
    if (said) {
      $("#provider-said-text").textContent = said.text;
      $("#provider-manage").hidden = !said.manage;
      if (said.manage) {
        $("#provider-manage").href = said.manage;
        $("#provider-manage").textContent = `Delete it on ${said.name}`;
      }
    }
    $("#notebook-card").hidden = this.connected || !this.connecting || (this.view ?? "record") !== "record";
    $("#signin").disabled = Boolean(this.signing);
    $("#signin-wait").hidden = !this.signing;
    if (this.signing) {
      $("#signin-text").textContent = this.signing.text;
      $("#signin-code").textContent = this.signing.code ?? "…";
      $("#signin-link").hidden = !this.signing.url;
      if (this.signing.url) $("#signin-link").href = this.signing.url;
    }
    $("#connect").hidden = this.connected;
    $("#signout").hidden = !this.connected;
    $("#signout").disabled = this.signingOut;
    $("#signout-note").hidden = !this.signoutNote;
    if (this.signoutNote) {
      $("#signout-said").textContent = this.signoutNote.message;
      $("#tokens-link").hidden = !this.signoutNote.page;
      if (this.signoutNote.page) $("#tokens-link").href = this.signoutNote.page;
    }
    if (this.audio) {
      // A share that ended takes what was heard with it.
      if (!this.check().sharing && this.listening === null) this.heard = false;
      const check = this.check();
      for (const item of check.items) {
        const line = $(`#access-${item.id}`);
        line.textContent = item.text;
        line.classList.toggle("allowed", item.done);
        line.disabled = !item.action;
      }
      const listening = this.listening !== null && !check.items[2].done;
      $("#precheck-level").hidden = !listening;
      $("#precheck-hint").textContent = audioLimits(this.platform, this.audio.access().computer?.via === "monitor" ? this.audio.access().computer.label : null).text;
      $("#unshare").hidden = !check.sharing;
      $("#mic-only").textContent = this.micOnly ? "Record the call's sound after all" : "Or skip it: record the mic only";
      $("#mic-only").hidden = (check.items[1].done && !this.micOnly) || isPhone(this.platform);
      if (isPhone(this.platform)) $("#record-says").textContent = "It records your mic: put the call on speaker, near the phone.";
      $("#record-form > .primary").disabled = !check.ready;
    }
    const recorder = recordingJob(this.jobs);
    if (recorder || this.loadingRecorder) $("#record-form > .primary").disabled = true;
    $("#record-busy").hidden = !recorder;
    $("#record-busy").textContent = recorder ? `“${recorder.title}” is being recorded. Stop it to start another.` : "";
    $("#space-form").hidden = !this.spaces;
    if (this.spaces && $("#space").options.length !== this.spaces.length) {
      $("#space").replaceChildren(...this.spaces.map((name) => new Option(name, name)));
    }
    const page = profilePage(this.config.profile);
    $("#trust-note").hidden = !this.needsTrust;
    $("#trust-profile").textContent = this.config.profile;
    $("#trust-link").hidden = !page;
    if (page) $("#trust-link").href = page;
    $("#record-form > .primary").textContent = this.loadingRecorder ? "Getting ready to record…"
      : this.needsTrust ? "Trust the agent and start recording" : "Start recording";
    $("#notebook-status").textContent = this.connected ? "Notebook: slivingdoc" : "Notebook: in this browser";
    for (const view of this.root.querySelectorAll("[data-view]")) view.hidden = view.dataset.view !== (this.view ?? "record");
    this.page = pageOf(this.view, this.current, this.recording);
    this.renderList();
    this.renderMeeting();
    this.renderRecording();
    this.renderTab();
    this.popout.render();
    const focus = this.penelopeFocus();
    this.penelope.place(focus?.path ?? null, focus ? this.penelopeIdeas(focus) : this.deskIdeas());
    this.penelope.doze(Boolean(this.machine?.has) && !this.machine.has("agent"));
  }

  // Keeps the entries it drew before, so only a meeting new to the list is written in: the new
  // ones have the class "fresh" until arrival.js has them written.
  renderList() {
    const list = this.$("#meetings");
    const drawn = new Map([...list.children].map((el) => [el.dataset.key, el]));
    const nodes = [];
    const entry = (key, make) => {
      let el = drawn.get(key);
      if (!el) {
        el = make();
        el.dataset.key = key;
        el.classList.add("fresh");
      }
      nodes.push(el);
      return el;
    };
    const jobs = listedJobs(this.jobs);
    if (jobs.length > 0) {
      const head = entry("group:jobs", () => {
        const head = document.createElement("div");
        head.className = "sidehead";
        const popout = document.createElement("button");
        popout.className = "popout-open";
        popout.textContent = "pop out";
        popout.title = "Show what is in progress in a small window that stays on top";
        popout.onclick = () => this.popout.show();
        head.append("In progress", popout);
        return head;
      });
      head.querySelector(".popout-open").hidden = !this.popout.supported || this.popout.open || !running(this.jobs);
    }
    const now = Date.now();
    const pace = this.pace;
    for (const job of jobs) {
      const button = entry(`job:${job.id}`, () => {
        const button = document.createElement("button");
        button.className = "meeting job";
        button.append(document.createElement("strong"), document.createElement("span"));
        return button;
      });
      const [title, meta] = button.children;
      if (title.textContent !== job.title) title.textContent = job.title;
      const said = jobStatus(job, now, pace);
      if (meta.textContent !== said) meta.textContent = said;
      button.classList.toggle("failed", job.done && job.status !== 0);
      if (this.recording === job && !this.current) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
      button.onclick = () => this.viewJob(job);
    }
    for (const { label, items } of groupMeetings(this.meetings)) {
      entry(`group:${label}`, () => {
        const head = document.createElement("div");
        head.className = "sidehead";
        head.textContent = label;
        return head;
      });
      for (const meeting of items) {
        const button = entry(`meeting:${meeting.path}`, () => {
          const button = document.createElement("button");
          button.className = "meeting";
          button.append(document.createElement("strong"), document.createElement("span"));
          return button;
        });
        const [title, meta] = button.children;
        if (title.textContent !== meeting.title) title.textContent = meeting.title;
        const when = meetingMeta(meeting);
        if (meta.textContent !== when) meta.textContent = when;
        if (this.current?.path === meeting.path) button.setAttribute("aria-current", "true");
        else button.removeAttribute("aria-current");
        button.onclick = () => this.visit(meeting);
      }
    }
    if (nodes.length !== list.children.length || nodes.some((el, i) => list.children[i] !== el)) list.replaceChildren(...nodes);
    this.$("#empty").hidden = this.meetings.length + jobs.length > 0;
  }

  renderMeeting() {
    const $ = this.$;
    const r = this.recording;
    const c = this.current;
    const title = $("#meeting-title");
    title.classList.toggle("renamable", Boolean(c));
    title.tabIndex = c ? 0 : -1;
    title.title = c ? "Click to rename this meeting" : "";
    if (!title.querySelector("input")) title.textContent = c ? this.titleOf(c) : r?.title ?? "Meeting";
    const meta = c ? meetingMeta(c) : r ? `Today · started ${r.startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    $("#meeting-meta").textContent = meta;
    // Redrawn only when changed, so a render keeps a correction being typed.
    const summary = $("#summary");
    const same = Boolean(c) && this.drawn.path === c.path;
    const summaryHtml = c ? this.summaryHtml(c) : renderMarkdown("_Written by the agent when you stop the recording._");
    if (this.drawn.summary !== summaryHtml) {
      summary.toggleAttribute("data-written", same && (this.quiet || this.drawn.summaryRaw === c.raw.summary));
      summary.innerHTML = summaryHtml;
      this.drawn.summary = summaryHtml;
    }
    const transcriptKey = c ? `${c.path}\n${c.raw.transcript}` : "";
    if (this.drawn.transcript !== transcriptKey) {
      if (c && withoutHeading(c.transcript, "transcript").trim()) {
        this.proof.draw(this.fixes, same && this.quiet);
      } else {
        this.proof.clear();
        const transcript = $("#transcript");
        transcript.removeAttribute("data-written");
        transcript.innerHTML = renderMarkdown(c ? "_No transcript in the notebook for this meeting._" : "_Transcribed with speaker labels when the recording stops._");
      }
      this.drawn.transcript = transcriptKey;
    }
    this.drawn.path = c?.path;
    this.drawn.summaryRaw = c?.raw.summary;
    this.renderFixes();
    this.renderTape();
    $("#saved").hidden = !c;
    // "Who is speaking?": the review, drawn from the open meeting and what loadReview read for it.
    const form = $("#speakers");
    form.dataset.path = c?.path ?? "";
    if (c && this.review) {
      const v = this.reviewing?.path === c.path ? this.reviewing : null;
      this.review.show({
        path: c.path, transcript: c.transcript, unknown: unknownSpeakers(c.transcript), kept: v?.kept ?? null, people: v?.people ?? [],
        playable: this.proof.playable, busy: Boolean(r && !r.done), naming: this.naming?.path === c.path ? this.naming.text : "",
      });
    } else form.hidden = true;
    $("#saved-path").textContent = c?.path ?? "";
    const history = $("#history-list");
    history.hidden = !this.historyItems;
    history.replaceChildren(...(this.historyItems ?? []).map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
  }

  // The summary, with what the corrections strike and write in marked.
  summaryHtml(c) {
    const text = this.fixes ? this.fixes.marked("summary") : c.raw.summary;
    return marksToHtml(renderMarkdown(withoutHeading(parseNote(text).body, "summary") || "_The summary is empty._"));
  }

  // The recording pauses off the meeting view; Transcribe again asks first, and the notes it replaces fade while it runs.
  renderTape() {
    const $ = this.$;
    const c = this.current;
    if ((this.view ?? "record") !== "meeting" && !this.player.audio.paused) this.player.audio.pause();
    const can = canTranscribeAgain(c, Boolean(this.player.blob), this.jobs);
    $("#again").hidden = !can;
    const asking = can && this.asking === c.path;
    $("#again-note").hidden = !asking;
    if (asking) {
      $("#again-said").textContent = againWarning(this.connected);
      $("#again-yes").textContent = this.needsTrust ? "Trust the agent and transcribe again" : "Transcribe again";
    }
    const erasable = canDelete(c, this.jobs);
    $("#delete").hidden = !erasable;
    $("#delete").disabled = this.removing;
    const erasing = erasable && !this.removing && this.deleting === c.path;
    $("#delete-note").hidden = !erasing;
    if (erasing) $("#delete-said").textContent = deleteWarning(this.connected, Boolean(this.player.blob), this.fixes?.count ?? 0);
    const replacing = Boolean(c) && (this.removing || this.jobs.some((j) => !j.done && j.again === c.path));
    $(".cards").inert = replacing;
    $(".cards").classList.toggle("replacing", replacing);
  }

  // The post-it of corrections: how many, the offer to make one everywhere, and saving them.
  renderFixes() {
    const $ = this.$;
    const c = this.current;
    const n = this.fixes?.count ?? 0;
    const hint = $("#proof-hint");
    hint.hidden = !c || this.proof.rows.length === 0;
    hint.textContent = this.proof.playable
      ? "Click a line to correct it, a name to change who said it, a time to hear it."
      : "Click a line to correct it, or a name to change who said it.";
    const postit = $("#fixes");
    postit.hidden = !c || (this.view ?? "record") !== "meeting" || (n === 0 && !this.saving && !this.saveSaid);
    $("#fixes-count").textContent = n === 0 ? (this.saving ? "Saving" : "Saved") : n === 1 ? "1 correction" : `${n} corrections`;
    $("#fixes-said").textContent = this.dropping ? `Drop ${n === 1 ? "it" : `all ${n}`}? Click again to drop.` : this.saveSaid;
    const save = $("#fixes-save");
    save.textContent = this.saving ? "Saving…" : this.saveFailed ? "Try again" : "Save";
    save.disabled = this.saving || this.penelopeBusy;
    save.hidden = n === 0;
    $("#fixes-undo").hidden = this.saving || !this.fixes?.undos.length;
    $("#fixes-drop").hidden = this.saving || n === 0;
    $("#fixes-drop").textContent = `${this.dropping ? "Yes, drop" : "Drop"} ${n === 1 ? "it" : "them"}`;
    const offer = this.offer;
    $("#fix-offer").hidden = !offer || this.saving;
    if (offer) {
      $("#offer-what").textContent = `${offer.from} → ${offer.to}`;
      $("#offer-where").textContent = offerWhere(offer.places);
    }
    // What is scrolled into view, such as the line being corrected, stays above the post-it.
    for (const el of [this.root, $(".content")]) {
      const below = Number.parseFloat(getComputedStyle(el).paddingBottom) || 0;
      el.style.scrollPaddingBottom = postit.hidden ? "" : `${postit.offsetHeight + below + 40}px`;
    }
  }

  renderRecording() {
    const $ = this.$;
    const r = this.recording;
    const busy = r && !r.done;
    $("#recbar").hidden = !busy;
    $("#recbar").dataset.action = (busy && r.action) || "";
    $("#stages").hidden = !busy;
    const live = Boolean(busy && r.stages.has("recording") && !r.stages.has("recorded"));
    $("#stop").hidden = !live;
    // Stop is sent once: the stop file is there from then on.
    $("#stop").disabled = !live || Boolean(r.stopSent);
    $("#popout").hidden = !busy || !this.popout.supported || this.popout.open;
    $("#agent").hidden = !(r?.done && (r.status !== 0 || !this.current));
    $("#agent-text").innerHTML = r?.done
      ? renderMarkdown(r.status === 0 ? r.reply || "_The agent said nothing._"
        : `${r.problem?.title ?? `The agent stopped with exit status ${r.status}`}. ${r.reply ?? ""}`)
      : "";
    $("#retry-note").hidden = !(r?.done && r.status !== 0 && r.audioPath);
    const guess = busy ? estimate(r, Date.now(), this.pace) : null;
    const meter = $("#time-left");
    meter.hidden = !guess;
    if (guess) {
      const said = leftText(guess);
      const text = said.charAt(0).toUpperCase() + said.slice(1);
      meter.dataset.job = r.id;
      meter.dataset.progress = guess.progress.toFixed(3);
      if ($("#time-left-text").textContent !== text) $("#time-left-text").textContent = text;
    }
    if (!busy) return;
    const time = clock(r.started ? Math.max(0, Math.round(((r.recordedAt ?? Date.now()) - r.started) / 1000)) : 0);
    $("#rec-quiet").hidden = !(live && r.quiet);
    const state = $("#rec-state");
    state.classList.toggle("live", live);
    $("#recbar").classList.toggle("waiting", !live && !r.stages.has("recorded"));
    $("#recbar").classList.toggle("summarizing", r.stages.has("recorded"));
    state.textContent = live ? `Recording ${time}` : r.stages.has("recorded") ? `Recorded ${time}` : r.answering ? "The agent is working…" : "Starting the agent…";
    const inputs = this.audio?.inputs() ?? [];
    $("#rec-inputs").textContent = inputs.map((i) => i.label).join(" + ") || "Mic";
    const stages = [
      ["recording", "Recording"],
      ["recorded", "Recorded"],
      ["transcribing", [`Transcribing with ${activeProvider(this.env)?.name ?? "the AI provider"}`, transcribeDetail(r)].filter(Boolean).join(" · ")],
      ["writing", "Writing the notes"],
      ["saving", "Saving to slivingdoc"],
    ].filter(([key]) => key !== "saving" || this.connected);
    $("#stages").replaceChildren(...stages.map(([key, text]) => {
      const li = document.createElement("li");
      li.className = r.stages.has(key) ? "done" : "";
      li.textContent = text;
      return li;
    }));
  }

  // The tab's title and icon say what runs, for a user in another tab.
  renderTab() {
    const said = tabStatus(this.jobs, this.unseen, Date.now(), this.pace);
    const title = said ? `${said.text} · ${this.title}` : this.title;
    if (document.title !== title) document.title = title;
    const icon = said ? `data:image/svg+xml,${encodeURIComponent(statusIcon(said.icon))}` : null;
    if (icon === this.tabIcon) return;
    this.tabIcon = icon;
    for (const link of document.querySelectorAll('link[rel="icon"]')) {
      link.dataset.href ??= link.getAttribute("href");
      link.href = icon ?? link.dataset.href;
    }
  }

  renderWave() {
    const wave = this.$("#wave");
    const bars = this.levels.map((level) => {
      const bar = document.createElement("span");
      bar.style.height = `${Math.max(3, Math.round(level * 32))}px`;
      return bar;
    });
    wave.replaceChildren(...bars);
  }
}
