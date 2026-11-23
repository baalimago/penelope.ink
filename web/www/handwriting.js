// What the app puts on the pad shows at once, in fresh ink that dries. When the title, the summary,
// the transcript or the agent's reply changes, its new blocks on the screen show in wet ink, which
// dries to the pad's own in a wave down the screen (pad.css ink-dry). Nothing is hidden or waits
// for an animation, so a long transcript can be read and scrolled at once; what is out of view,
// or was on the pad before the change, just shows.

const TARGETS = ["#meeting-title", "#summary", "#transcript", "#agent-text"];
// The blocks that dry one after another: a transcript's lines, and the rendered markdown's blocks.
const BLOCKS = ".utt, .utt-added, p, li, h1, h2, h3, h4, blockquote, pre, td, th";
// How long the wave takes down the screen, however many blocks are on it, and how long ink takes to dry.
export const WAVE_MS = 700;
export const DRY_MS = 1300;

// The innermost blocks of `el` in order, or `el` itself when it has none.
export function blocksOf(el) {
  const all = [...el.querySelectorAll(BLOCKS)].filter((b) => !b.querySelector(BLOCKS));
  return all.length ? all : [el];
}

// When each of `count` blocks starts to dry, so the last starts as the wave ends.
export const wetAt = (i, count) => (count > 1 ? Math.round((i * WAVE_MS) / (count - 1)) : 0);

export class Handwriting {
  constructor(doc) {
    this.doc = doc;
    // The texts of each target's blocks when it last changed: a block with one of them is not new.
    this.seen = new Map();
    this.observer = new MutationObserver((records) => this.changed(records));
  }

  start() {
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const el of this.targets()) {
      this.observer.observe(el, { childList: true, characterData: true, subtree: true });
      this.ink(el, calm);
    }
    this.calm = calm;
  }

  targets() {
    return TARGETS.map((s) => this.doc.querySelector(s)).filter(Boolean);
  }

  changed(records) {
    const touched = new Set();
    for (const record of records) {
      // What the user corrected (proofread.js) shows as it is.
      if ((record.target.closest ? record.target : record.target.parentElement)?.closest("[data-written]")) continue;
      const el = this.targets().find((t) => t.contains(record.target));
      if (el) touched.add(el);
    }
    for (const el of touched) this.ink(el, this.calm);
  }

  // The new blocks of `el` on the screen show in wet ink, drying top to bottom.
  ink(el, calm = false) {
    const before = this.seen.get(el);
    const blocks = blocksOf(el);
    this.seen.set(el, new Set(blocks.map((b) => b.textContent)));
    if (calm || !before || !el.getClientRects().length) return;
    const fresh = [];
    for (const block of blocks) {
      const box = block.getBoundingClientRect();
      // In document order: past the screen's bottom, nothing more is on it.
      if (box.top > innerHeight) break;
      if (box.bottom < 0 || before.has(block.textContent) || !block.textContent.trim()) continue;
      fresh.push(block);
    }
    const wet = (this.wet = (this.wet ?? 0) + 1);
    fresh.forEach((block, i) => {
      const at = wetAt(i, fresh.length);
      block.style.setProperty("--wet-at", `${at}ms`);
      block.classList.remove("ink-wet");
      void block.offsetWidth;
      block.classList.add("ink-wet");
      block.dataset.wet = wet;
      setTimeout(() => {
        if (block.dataset.wet !== String(wet)) return;
        block.classList.remove("ink-wet");
        block.style.removeProperty("--wet-at");
        delete block.dataset.wet;
      }, at + DRY_MS + 100);
    });
  }
}

if (typeof document !== "undefined") new Handwriting(document).start();
