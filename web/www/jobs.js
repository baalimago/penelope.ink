// The agent's runs, under way in the background, and an estimate of what is left of each.

// Seconds, unless named otherwise. `encodePerMinute` is the page's ffmpeg making clai's request
// codec of a recording (OpenRouter past 13 minutes): 1, 5 and 15 minutes took 0.8, 4.7 and 14.5 s
// in headless Chromium on 2026-11-16.
export const PACE = {
  turn: 8,
  transcribeFixed: 6,
  transcribePerMinute: 3,
  encodePerMinute: 1,
  charsPerMinute: 1100,
  writeCharsPerSecond: 250,
  save: 6,
  // clai's survey path: one merge link between two parts, and naming against the voice library
  // after the stitch (the Retro, 2026-11-22: 4 links in 267 s; naming's two orders now at once).
  mergeLink: 65,
  naming: 75,
};

// Each provider's transcription, measured 2026-11-16 with 20 s and 80 s of speech (docs/app.md): the
// provider's answer, plus sending a 16 kHz WAV (1.92 MB a minute) at an assumed 1 MB/s, about
// 2 s a minute, which the page's own runs then correct.
// OpenAI's diarizer takes `splitPast` seconds in one request; past it clai's survey path cuts parts
// of about `core` seconds and sends them all at once, in rounds (survey-calibration worklog).
export const PROVIDER_PACE = {
  openai: { transcribeFixed: 3, transcribePerMinute: 22.5 + 2, splitPast: 1400, core: 1286 },
  openrouter: { transcribeFixed: 1.2, transcribePerMinute: 1.9 + 2 },
};

// The survey path's rounds: survey, labelling and a second try, each as long as one part with
// the 88 s of voice clips in front; the steps clai's progress names, and what the user is told.
const SURVEY_ROUNDS = 3;
const SURVEY_PREFIX = 88;
const SURVEY_STEPS = [
  ["finding voices", (n) => `finding the voices in ${n} parts`],
  ["matching voices", () => "matching the voices across the parts"],
  ["labelling", () => "labelling the speakers"],
  ["second try", () => "a second try at the voices left over"],
  ["stitching", () => "naming the speakers"],
];

// What the agent writes besides the transcript: the summary and its reply.
const SUMMARY_CHARS = 1500;

const PHASES = ["toTranscribe", "transcribing", "writing", "saving"];

export const PHASE_TEXT = {
  starting: "Starting the agent",
  recording: "Recording",
  working: "The agent is working",
  toTranscribe: "Transcribing",
  transcribing: "Transcribing",
  writing: "Writing the notes",
  saving: "Saving",
};

// `expects` is what follows the recording: `{ transcribe, audioSeconds, chars }`.
export function newJob({ id, label, title, action, now, recording = false, expects = null, ...rest }) {
  return {
    id, label, title, action, recording, expects,
    startedAt: new Date(now),
    from: recording || !expects ? null : now,
    stages: new Set(),
    wrote: new Set(),
    chunks: null,
    heard: null,
    encodeAt: null,
    requestAt: null,
    done: false,
    ...rest,
  };
}

const field = (output, name) => new RegExp(`^${name}: (.*)$`, "m").exec(output ?? "")?.[1]?.trim();

// One -json record of the job's run, taken at `now` (ms).
export function takeRecord(job, record, now) {
  const name = record.name;
  if (record.type === "tool_call" && name === "audio_record") job.recordCall ??= now;
  if (record.type === "tool_result" && name === "audio_record") {
    const seconds = Number.parseFloat(field(record.output, "duration_seconds"));
    job.recordResult = { ok: record.ok !== false, seconds: Number.isFinite(seconds) ? seconds : null, stoppedBecause: field(record.output, "stopped_because") ?? null };
    if (job.recordResult.seconds !== null) job.audioSeconds = job.recordResult.seconds;
    job.from ??= now;
  }
  if (record.type === "tool_call" && name === "audio_transcribe") {
    job.from ??= now;
    job.transcribeAt = now;
    job.transcribedAt = null;
    Object.assign(job, { chunks: null, heard: null, encodeAt: null, requestAt: null });
  }
  if (record.type === "progress" && record.title === "audio_transcribe" && job.transcribeAt) takeProgress(job, record, now);
  if (record.type === "tool_result" && name === "audio_transcribe") {
    job.transcribedAt = now;
    if (record.ok !== false) {
      job.transcribed = transcribedOf(record.output ?? "");
      job.transcriptChars = job.transcribed.chars;
    }
  }
}

// What audio_transcribe returned: its text, or the file clai saved it in when it was too long to pass on.
export function transcribedOf(output) {
  const m = /^\[tool output too large: (\d+) runes; full output saved to temp file: (.+)\]$/.exec(output.trim());
  return m ? { file: m[2], chars: Number(m[1]) } : { text: output, chars: output.length };
}

// clai's progress of a transcription (architecture/audio.md, Progress): a status without rows for
// one request ("r.wav · 1 request · 19.2 MB", or "… · encoding for 1 request", then "requesting ·
// 4.8 MB"), with "heard mm:ss" as a streaming provider's segments arrive; a board with a row per
// chunk for a split recording ("… 4 chunks × 10.0 min …", "… 3 cores × 21 min …").
function takeProgress(job, record, now) {
  const chunks = (job.chunks ??= { total: null, rows: new Map() });
  const detail = record.detail ?? "";
  if (record.row) {
    chunks.rows.set(record.row, record.state);
    return;
  }
  const total = /(\d+) (?:requests?|chunks|cores)\b/.exec(detail)?.[1];
  if (total) chunks.total = Number(total);
  if (record.state === "start" && /^speaker labelling\b/.test(detail)) chunks.steps = {};
  const step = SURVEY_STEPS.find(([name]) => detail.startsWith(name))?.[0];
  if (chunks.steps && step) chunks.steps[step] ??= now;
  if (chunks.steps && record.state === "done") chunks.stitchedAt ??= now;
  const heard = /^heard (\d+):(\d\d)$/.exec(detail);
  if (heard) job.heard = { seconds: Number(heard[1]) * 60 + Number(heard[2]), at: now };
  if (record.state === "start" && /\bencoding\b/.test(detail)) job.encodeAt = now;
  else if (job.encodeAt && (/^(?:requesting|encoded)\b/.test(detail) || record.state === "start")) job.requestAt ??= now;
}

// The run that records, or will once it starts recording: only one may.
export const recordingJob = (jobs) => jobs.find((j) => j.recording && !j.done && !j.recordResult) ?? null;

// The runs to list: those under way, and those that ended without filing a meeting and were not run again.
export const listedJobs = (jobs) => jobs.filter((j) => !j.replaced && (!j.done || !j.filed));

export function audioSeconds(job) {
  if (Number.isFinite(job.audioSeconds)) return job.audioSeconds;
  if (job.started && job.recordedAt) return Math.max(0, (job.recordedAt - job.started) / 1000);
  return job.expects?.audioSeconds ?? null;
}

export function phaseOf(job) {
  if (job.done) return "done";
  if (job.agentEndAt) return "saving";
  if (job.transcribedAt) return "writing";
  if (job.transcribeAt) return "transcribing";
  if (job.recordResult?.ok === false) return "working";
  if (job.recording && !job.from) return job.recordCall || job.stages.has("recording") ? "recording" : "starting";
  if (!job.recording && !job.expects) return "working";
  return job.expects?.transcribe === false ? "writing" : "toTranscribe";
}

function phaseStart(job, phase) {
  return {
    toTranscribe: job.from,
    transcribing: job.transcribeAt,
    writing: job.transcribedAt ?? job.from,
    saving: job.agentEndAt,
  }[phase];
}

// A recording clai sends on the survey path: its parts and one round's seconds; null otherwise.
function survey(job, pace) {
  const audio = audioSeconds(job) ?? 0;
  if (!pace.core || !(audio > pace.splitPast) || (job.chunks && !job.chunks.steps && job.chunks.total)) return null;
  const parts = job.chunks?.steps && job.chunks.total ? job.chunks.total : Math.ceil(audio / pace.core);
  return { parts, round: (pace.transcribePerMinute * (audio / parts + SURVEY_PREFIX)) / 60 };
}

// The seconds the survey path takes from its start, `t` seconds in: what its steps so far took,
// then what is left after the step it is on, the first round's own time pacing the rounds after it.
function surveying(job, s, pace) {
  const at = job.chunks?.steps ?? {};
  const since = (ms) => Math.max(0, (ms - job.transcribeAt) / 1000);
  const links = (s.parts - 1) * pace.mergeLink;
  const round = at["matching voices"] && at["finding voices"] ? (at["matching voices"] - at["finding voices"]) / 1000 : s.round;
  if (at.stitching || job.chunks?.stitchedAt) return since(at.stitching ?? job.chunks.stitchedAt) + pace.naming;
  if (at["second try"]) return since(at["second try"]) + round + pace.naming;
  if (at.labelling) return since(at.labelling) + 2 * round + pace.naming;
  if (at["matching voices"]) return since(at["matching voices"]) + links + 2 * round + pace.naming;
  return pace.transcribeFixed + SURVEY_ROUNDS * round + links + pace.naming;
}

// The seconds a phase takes, before it starts.
function expected(job, phase, pace) {
  const minutes = (audioSeconds(job) ?? 0) / 60;
  switch (phase) {
    case "toTranscribe":
      return pace.turn;
    case "transcribing":
      if (survey(job, pace)) return surveying(job, survey(job, pace), pace);
      return (job.encodeAt ? pace.encodePerMinute * minutes : 0) + pace.transcribeFixed + pace.transcribePerMinute * minutes;
    case "writing": {
      const chars = job.transcriptChars ?? job.expects?.chars ?? minutes * pace.charsPerMinute;
      return 2 * pace.turn + (chars + SUMMARY_CHARS) / pace.writeCharsPerSecond;
    }
    case "saving":
      return pace.save + minutes * 0.1;
    default:
      return 0;
  }
}

// The seconds transcribing takes from its start, `t` seconds in, from what clai has said of it:
// the chunks done set the pace of the rest; a streaming provider's last segment, how much audio
// is left; the end of the encode, when the request left.
function transcribing(job, t, pace) {
  const since = (at) => Math.max(0, (at - job.transcribeAt) / 1000);
  const chunks = job.chunks;
  const s = survey(job, pace);
  if (s) return surveying(job, s, pace);
  const finished = chunks ? [...chunks.rows.values()].filter((s) => s === "done").length : 0;
  if (chunks?.total > 1 && finished > 0) return t + (t / finished) * (chunks.total - finished);
  const audio = audioSeconds(job);
  if (job.heard && audio) return since(job.heard.at) + (Math.max(0, audio - job.heard.seconds) / 60) * pace.transcribePerMinute;
  if (job.requestAt) return since(job.requestAt) + pace.transcribeFixed + (pace.transcribePerMinute * (audio ?? 0)) / 60;
  return expected(job, "transcribing", pace);
}

// For the hatching: past 85 % of its estimate a phase still has a little left, less the longer it
// runs, so the box fills on but never full while the phase runs.
const KNEE = 0.85;
function left(e, t) {
  if (t < KNEE * e) return e - t;
  return (1 - KNEE) * e * ((KNEE * e) / t) ** 2;
}

const LATE_MARGIN = 10;

// `{ phase, seconds, rest, progress, late }` at `now` (ms), or null while nothing says how long is
// left. `seconds` counts down to `rest`, what the phases after this one take, and stays there once
// this one is `late`, past its estimate; `progress` goes on growing, toward 1.
export function estimate(job, now, pace = PACE) {
  const phase = phaseOf(job);
  const at = PHASES.indexOf(phase);
  if (at < 0 || (!job.recording && !job.expects)) return null;
  const transcribes = job.expects?.transcribe !== false;
  const phases = PHASES.slice(at).filter((p) => transcribes || p === "writing" || p === "saving");
  const t = Math.max(0, (now - phaseStart(job, phase)) / 1000);
  const base = expected(job, phase, pace);
  const e = phase === "transcribing" ? transcribing(job, t, pace) : base;
  let rest = 0;
  for (const p of phases.slice(1)) rest += expected(job, p, pace);
  const seconds = Math.max(0, e - t) + rest;
  const elapsed = Math.max(0, (now - job.from) / 1000);
  // A phase past its first estimate stays late until a record leaves it more than a moment.
  const late = t > e || (t > base && e - t < LATE_MARGIN);
  return { phase, seconds, rest, progress: elapsed / (elapsed + left(e, t) + rest || 1), late };
}

const minutesText = (seconds) => {
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

// "about 3 min left", rounded the way one says it. A phase past its estimate gives no number for
// itself, which would only stand still, but says so, and what the phases after it take.
export function leftText({ seconds, rest = 0, late }) {
  if (late) return rest >= 60 ? `taking longer than expected, then about ${minutesText(rest)}` : "taking longer than expected";
  if (seconds < 10) return "a few seconds left";
  if (seconds < 55) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} s left`;
  return `about ${minutesText(seconds)} left`;
}

// Where transcribing is, from clai's progress: "heard 4:10 of 10:00", "1 of 4 parts done",
// "preparing the recording", or "".
export function transcribeDetail(job) {
  if (phaseOf(job) !== "transcribing") return "";
  const chunks = job.chunks;
  if (chunks?.steps) {
    const step = SURVEY_STEPS.findLast(([name]) => chunks.steps[name]);
    return step ? step[1](chunks.total) : "";
  }
  if (chunks?.total > 1) {
    const finished = [...chunks.rows.values()].filter((s) => s === "done").length;
    return `${finished} of ${chunks.total} parts done`;
  }
  if (job.heard) {
    const audio = audioSeconds(job);
    return audio ? `heard ${clock(Math.min(job.heard.seconds, audio))} of ${clock(audio)}` : `heard ${clock(job.heard.seconds)}`;
  }
  if (job.encodeAt && !job.requestAt) return "preparing the recording";
  return "";
}

export const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

// The file whose creation stops run `n`'s recording (clai's CLAI_AUDIO_STOP_FILE): one per run,
// so Stop ends the recording it belongs to and no other.
export const stopFileOf = (n) => `/tmp/minutes-stop-${n}`;

// When the words of a phase first showed: "Transcribing" covers the turn before the tool call.
const labelStart = (job, phase) => (phase === "transcribing" || phase === "toTranscribe" ? job.from : phaseStart(job, phase));

// What the list says of a job at `now` (ms): the phase, how long it has run, and the time left.
export function jobStatus(job, now, pace = PACE) {
  if (job.done) {
    if (job.status !== 0) return `Stopped: ${job.problem?.title ?? `exit ${job.status}`}`;
    return job.filed ? "Filed" : "The agent answered";
  }
  const phase = phaseOf(job);
  if (phase === "recording") return job.started ? `Recording ${clock(Math.max(0, (now - job.started) / 1000))}` : "Starting the recording";
  const guess = estimate(job, now, pace);
  if (!guess) return `${PHASE_TEXT[phase]}…`;
  return `${PHASE_TEXT[phase]} ${clock(Math.max(0, (now - labelStart(job, phase)) / 1000))} · ${leftText(guess)}`;
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const blend = (old, measured, lo, hi) => (Number.isFinite(measured) ? (old + clamp(measured, lo, hi)) / 2 : old);

// The pace after a job that filed its meeting: each phase it measured moves it halfway.
export function learnPace(pace, job) {
  const next = { ...pace };
  const minutes = (audioSeconds(job) ?? 0) / 60;
  const s = (from, to) => (from && to && to > from ? (to - from) / 1000 : NaN);
  next.turn = blend(pace.turn, s(job.from, job.transcribeAt), 1, 60);
  const steps = job.chunks?.steps;
  if (steps && job.chunks.total > 1) {
    // The survey path: the first round paces a part, the steps after it the links and the naming.
    const parts = job.chunks.total;
    const part = (minutes * 60) / parts + SURVEY_PREFIX;
    next.transcribePerMinute = blend(pace.transcribePerMinute, s(steps["finding voices"], steps["matching voices"]) / (part / 60), 0.2, 60);
    next.mergeLink = blend(pace.mergeLink, s(steps["matching voices"], steps.labelling) / (parts - 1), 5, 600);
    next.naming = blend(pace.naming, s(job.chunks.stitchedAt ?? steps.stitching, job.transcribedAt), 0, 600);
  } else if (minutes >= 1) {
    if (job.encodeAt) next.encodePerMinute = blend(pace.encodePerMinute, s(job.encodeAt, job.requestAt) / minutes, 0.1, 60);
    const request = s(job.encodeAt ? job.requestAt : job.transcribeAt, job.transcribedAt);
    next.transcribePerMinute = blend(pace.transcribePerMinute, (request - pace.transcribeFixed) / minutes, 0.2, 60);
  }
  if (minutes >= 1 && job.transcriptChars) next.charsPerMinute = blend(pace.charsPerMinute, job.transcriptChars / minutes, 100, 5000);
  if (job.transcriptChars) {
    const writing = s(job.transcribedAt, job.agentEndAt) - 2 * next.turn;
    next.writeCharsPerSecond = blend(pace.writeCharsPerSecond, (job.transcriptChars + SUMMARY_CHARS) / Math.max(writing, 5), 20, 5000);
  }
  next.save = blend(pace.save, s(job.agentEndAt, job.savedAt) - minutes * 0.1, 1, 120);
  return next;
}

// The meeting a notebook path written by a job belongs to, as its summary's path, or null.
export function summaryOf(path) {
  const m = /(?:^|\/)meetings\/(summaries|transcripts)\/([^/]+\.md)$/.exec(path ?? "");
  return m ? `meetings/summaries/${m[2]}` : null;
}
