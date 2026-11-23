// The meeting's recording at the top of the meeting (index.html #tape): its wave sketched in
// pencil, which the red pen inks over as it plays, a seek, the time, and a link that downloads it.
import { clock } from "./proofread.js";
import { Pens } from "./pen.js";

const BARS = 600;
// The recording is read in parts of this many frames, so an hour of it is never in memory whole.
const FRAMES_PER_READ = 1 << 20;

const pad2 = (n) => String(n).padStart(2, "0");

// "Daily sync" on 16 November 2026 → "Daily-sync-2026-11-16.wav".
export function recordingName(title, date = null) {
  const name = String(title ?? "").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|-+$/g, "") || "recording";
  const day = date && !Number.isNaN(date.getTime()) ? `-${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` : "";
  return `${name}${day}.wav`;
}

export const timeText = (at, length) => `${clock(at)} of ${clock(length)}`;

const tag = (view, at) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + at, 4));

// A 16-bit PCM WAV's samples, from `head`, its first bytes, and `size`, the whole file's:
// { channels, rate, start, frames, seconds }, or null for anything else.
export function wavFormat(head, size) {
  const view = new DataView(head);
  if (head.byteLength < 12 || tag(view, 0) !== "RIFF" || tag(view, 8) !== "WAVE") return null;
  let format = null;
  for (let at = 12; at + 8 <= head.byteLength;) {
    const id = tag(view, at);
    const length = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 24 <= head.byteLength) {
      format = { pcm: view.getUint16(at + 8, true) === 1, channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    } else if (id === "data") {
      if (!format?.pcm || format.bits !== 16 || !format.channels || !format.rate) return null;
      const start = at + 8;
      // A WAV written to a pipe leaves its data's size unset.
      const bytes = length > 0 && length !== 0xffffffff ? Math.min(length, size - start) : size - start;
      const frames = Math.max(0, Math.floor(bytes / (2 * format.channels)));
      return { channels: format.channels, rate: format.rate, start, frames, seconds: frames / format.rate };
    }
    at += 8 + length + (length & 1);
  }
  return null;
}

// Takes the loudness of `bytes`, the frames of `format` from frame `first` on, into `peaks`, one a bar.
export function addPeaks(peaks, bytes, first, { channels, frames }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / (2 * channels));
  for (let i = 0; i < n; i += 4) {
    const bar = Math.min(peaks.length - 1, Math.floor(((first + i) * peaks.length) / frames));
    const v = Math.abs(view.getInt16(i * 2 * channels, true));
    if (v > peaks[bar]) peaks[bar] = v;
  }
}

// Peaks as 0 to 1 of the loudest, lifted so that quiet speech still shows.
export const inkLevels = (peaks) => {
  const loudest = Math.max(1, ...peaks);
  return [...peaks].map((p) => (p / loudest) ** 0.6);
};

// `levels` as `n` bars, each the loudest of those it takes in.
export function fewer(levels, n) {
  if (levels.length <= n) return [...levels];
  return Array.from({ length: n }, (_, i) => Math.max(...levels.slice(Math.floor((i * levels.length) / n), Math.floor(((i + 1) * levels.length) / n))));
}

// One pencil stroke a bar about the middle of 32, the longer ones leaning a little as a hand draws
// them; silence is a dot.
export function wavePath(levels) {
  return levels.map((level, i) => {
    const h = Math.max(0.5, level * 14);
    const lean = (((i * 7) % 5) - 2) * 0.09 * Math.min(1, h / 6);
    return `M${(i + 0.5 - lean).toFixed(2)} ${(16 + h).toFixed(1)}L${(i + 0.5 + lean).toFixed(2)} ${(16 - h).toFixed(1)}`;
  }).join("");
}

// wavePath's strokes in the order a pen draws them: even bars from the bottom up, odd ones from
// the top down, so it goes up and down along the wave and each stroke starts where the last ended.
export function waveStrokes(levels) {
  const ends = wavePath(levels).match(/-?[\d.]+/g).map(Number);
  return levels.map((_, i) => {
    const [bx, by, tx, ty] = ends.slice(i * 4, i * 4 + 4);
    return i % 2 ? { x0: tx, y0: ty, x1: bx, y1: by } : { x0: bx, y0: by, x1: tx, y1: ty };
  });
}

const segment = (x0, y0, x1, y1) => `M${x0.toFixed(2)} ${y0.toFixed(1)}L${x1.toFixed(2)} ${y1.toFixed(1)}`;

// The wave as drawn so far: the strokes before `bar` whole, `bar` itself `t` (0 to 1) of the
// way, and the pen's point, at the end of what is drawn.
export function waveSoFar(levels, bar, t) {
  const strokes = waveStrokes(levels);
  const done = strokes.slice(0, bar).map((s) => segment(s.x0, s.y0, s.x1, s.y1));
  const s = strokes[bar];
  if (!s) {
    const last = strokes.at(-1);
    return { d: done.join(""), x: last?.x1 ?? 0, y: last?.y1 ?? 16 };
  }
  const x = +(s.x0 + (s.x1 - s.x0) * t).toFixed(2);
  const y = +(s.y0 + (s.y1 - s.y0) * t).toFixed(1);
  return { d: done.join("") + segment(s.x0, s.y0, x, y), x, y };
}

// How long the pen takes to draw a wave of `bars`: about 14 ms a bar, from 1.1 s to 2.6 s.
export const drawInMs = (bars) => Math.round(Math.min(2600, Math.max(1100, bars * 14)));

// The wave is pencil, so the pencil draws it (pen.js KINDS).
const PENCIL = 5;
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

export class Player {
  constructor(root) {
    this.root = root;
    const $ = (s) => root.querySelector(s);
    this.audio = $("audio");
    this.link = $("#recording-download");
    this.button = $(".tape-play");
    this.seek = $(".tape-seek");
    this.track = $(".tape-track");
    this.svg = $(".tape-wave");
    this.pencil = $(".tape-pencil");
    this.ink = $(".tape-ink");
    this.inked = $(".tape-inked rect");
    this.head = $(".tape-head");
    this.at = $(".tape-at");
    this.length = $(".tape-length");
    this.blob = null;
    this.key = null;
    this.url = null;
    this.format = null;
    this.levels = [];
    this.bars = 0;
    this.shown = 0;
    this.frame = null;
    // The pencil that draws a new recording's wave in (drawIn), made on first use.
    this.pens = null;
    this.button.onclick = () => this.toggle();
    this.seek.oninput = () => this.to(Number(this.seek.value));
    this.seek.onkeydown = (event) => this.keyDown(event);
    for (const type of ["play", "pause", "ended", "seeked", "timeupdate", "loadedmetadata", "durationchange"]) {
      this.audio.addEventListener(type, () => this.update());
    }
    new ResizeObserver(() => this.draw()).observe(this.track);
  }

  // The recording's length in seconds, from the browser once it read it, else from the WAV.
  get seconds() {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : this.format?.seconds ?? 0;
  }

  // `blob`, kept under `key`, in the player and the link, which saves it as `name`; null puts the
  // player away. The recording already shown goes on playing.
  show(blob, name = "recording.wav", key = null) {
    this.link.download = name;
    if (blob && key !== null && key === this.key && blob.size === this.blob?.size) return;
    this.key = key;
    const shown = ++this.shown;
    this.audio.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.blob = blob;
    this.url = blob ? URL.createObjectURL(blob) : null;
    this.format = null;
    this.levels = [];
    this.root.hidden = !blob;
    this.link.hidden = !blob;
    if (!blob) {
      this.audio.removeAttribute("src");
      this.link.removeAttribute("href");
      return;
    }
    this.audio.src = this.url;
    this.link.href = this.url;
    this.link.textContent = `Download the recording (${(blob.size / 1e6).toFixed(1)} MB)`;
    this.draw();
    this.update();
    this.sketch(blob, shown);
  }

  async sketch(blob, shown) {
    const format = wavFormat(await blob.slice(0, 4096).arrayBuffer(), blob.size);
    if (!format || shown !== this.shown) return;
    const peaks = new Array(BARS).fill(0);
    const frameBytes = 2 * format.channels;
    for (let first = 0; first < format.frames; first += FRAMES_PER_READ) {
      const from = format.start + first * frameBytes;
      const bytes = new Uint8Array(await blob.slice(from, from + FRAMES_PER_READ * frameBytes).arrayBuffer());
      if (shown !== this.shown) return;
      addPeaks(peaks, bytes, first, format);
    }
    this.format = format;
    this.levels = inkLevels(peaks);
    this.bars = 0;
    this.draw();
    this.update();
    await this.drawIn(shown);
  }

  // A pencil draws the wave of the recording just shown, stroke by stroke; another recording, or
  // a new width, ends it with the wave whole. Reduced motion shows it at once.
  async drawIn(shown) {
    this.pens ??= new Pens(this.root.ownerDocument);
    const bars = this.bars;
    if (this.pens.calm || !this.svg.getClientRects().length || !bars) return;
    const levels = fewer(this.levels, bars);
    const live = () => shown === this.shown && bars === this.bars && this.svg.getClientRects().length > 0;
    const screen = (x, y) => new DOMPoint(x, y).matrixTransform(this.svg.getScreenCTM());
    const first = waveSoFar(levels, 0, 0);
    this.pencil.setAttribute("d", "");
    const pen = this.pens.pen({ kind: PENCIL });
    try {
      const start = screen(first.x, first.y);
      await pen.flyIn(start.x, start.y);
      const total = drawInMs(bars);
      const t0 = performance.now();
      while (live()) {
        const at = Math.min(1, (performance.now() - t0) / total) * bars;
        const bar = Math.floor(at);
        const so = waveSoFar(levels, bar, at - bar);
        this.pencil.setAttribute("d", so.d);
        const point = screen(so.x, so.y);
        pen.place(point.x, point.y);
        if (bar >= bars) break;
        await nextFrame();
      }
    } finally {
      if (shown === this.shown && bars === this.bars) this.pencil.setAttribute("d", wavePath(levels));
      pen.flyOff();
    }
  }

  // The wave at a bar every 5 px of the track, drawn again when its width changes.
  draw() {
    const bars = Math.max(24, Math.min(BARS, Math.round(this.track.clientWidth / 5)));
    if (bars === this.bars && this.levels.length) return;
    this.bars = bars;
    const levels = this.levels.length ? fewer(this.levels, bars) : new Array(bars).fill(0);
    const d = wavePath(levels);
    this.svg.setAttribute("viewBox", `0 0 ${bars} 32`);
    this.pencil.setAttribute("d", d);
    this.ink.setAttribute("d", d);
    this.update();
  }

  toggle() {
    if (this.audio.paused) this.audio.play().catch(() => this.update());
    else this.audio.pause();
    this.update();
  }

  to(seconds) {
    this.audio.currentTime = Math.max(0, Math.min(this.seconds, seconds));
    this.update();
  }

  // The arrows move 5 s, Space plays and pauses; Home, End and the page keys are the range's own.
  keyDown(event) {
    const by = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[event.key];
    if (by) this.to(this.audio.currentTime + by);
    else if (event.key === " ") this.toggle();
    else return;
    event.preventDefault();
  }

  update() {
    const length = this.seconds;
    const at = Math.min(this.audio.currentTime || 0, length);
    const playing = !this.audio.paused;
    this.root.classList.toggle("playing", playing);
    this.button.setAttribute("aria-label", playing ? "Pause the recording" : "Play the recording");
    this.seek.max = String(length);
    this.seek.value = String(at);
    this.seek.setAttribute("aria-valuetext", timeText(at, length));
    this.at.textContent = clock(at);
    this.length.textContent = clock(length);
    const x = length > 0 ? (at / length) * this.bars : 0;
    this.inked.setAttribute("width", x.toFixed(2));
    this.head.setAttribute("x1", x.toFixed(2));
    this.head.setAttribute("x2", x.toFixed(2));
    this.head.classList.toggle("moved", at > 0 || playing);
    // timeupdate comes four times a second: the pen follows each frame while it plays.
    if (playing && this.frame === null) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.update();
      });
    }
  }
}
