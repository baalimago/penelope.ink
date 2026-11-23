// A page left open keeps running the version it loaded, after a newer one is deployed. Each built
// site carries its version (web/stamp-dist.mjs): index.html's <meta name="penelope-version"> is
// the page's, version.json the site's. The page asks version.json when it comes back into view,
// and now and then while in view. When the site moved on, a post-it offers a reload, but only
// once nothing is under way that a reload would stop: a recording, a transcription, a save. The
// page `make dev` serves says "dev" and never asks.

// How often a page in view asks, and never more often than AGAIN_MS whatever wakes it.
export const EVERY_MS = 15 * 60_000;
export const AGAIN_MS = 60_000;
// While work is under way, how often the page looks again whether it is done.
export const IDLE_MS = 5_000;

export const UNSTAMPED = "dev";

export class Updates {
  // `version` is the page's; `ask` resolves to the site's, or throws; `busy` says whether a
  // reload would stop work under way; `show(true|false)` shows or hides the post-it; `later`
  // calls back after a while (setTimeout).
  constructor({ version, ask, busy = () => false, show, now = Date.now, later = (fn, ms) => setTimeout(fn, ms) }) {
    Object.assign(this, { version, ask, busy, show, now, later });
    // The site's version when it is newer than the page's, and the one the person put off.
    this.newer = null;
    this.putOff = null;
    this.askedAt = -Infinity;
    this.waiting = false;
    this.shown = false;
  }

  get stamped() {
    return Boolean(this.version) && this.version !== UNSTAMPED;
  }

  // Asks the site for its version, at most once every AGAIN_MS; offline or unanswered is no news.
  async check() {
    if (!this.stamped || this.now() - this.askedAt < AGAIN_MS) return;
    this.askedAt = this.now();
    let site;
    try {
      site = await this.ask();
    } catch {
      return;
    }
    if (typeof site !== "string" || site === "") return;
    this.newer = site === this.version ? null : site;
    this.offer();
  }

  // Shows the post-it for a newer version not put off, once nothing is under way.
  offer() {
    const wanted = this.newer !== null && this.newer !== this.putOff;
    if (wanted && this.busy()) {
      this.toggle(false);
      if (!this.waiting) {
        this.waiting = true;
        this.later(() => {
          this.waiting = false;
          this.offer();
        }, IDLE_MS);
      }
      return;
    }
    this.toggle(wanted);
  }

  // Later: the post-it goes until a version newer still is deployed.
  putOffNewer() {
    this.putOff = this.newer;
    this.toggle(false);
  }

  toggle(shown) {
    if (shown === this.shown) return;
    this.shown = shown;
    this.show(shown);
  }
}

// The page's own wiring: the version in its <meta>, version.json beside it, the #update post-it.
export function watchForUpdates({ win, doc, busy }) {
  const note = doc.getElementById("update");
  const version = doc.querySelector('meta[name="penelope-version"]')?.content ?? "";
  const updates = new Updates({
    version,
    busy,
    ask: async () => {
      const response = await win.fetch(new URL("version.json", doc.baseURI), { cache: "no-store" });
      if (!response.ok) throw new Error(`version.json: ${response.status}`);
      return (await response.json())?.version;
    },
    show: (shown) => {
      note.hidden = !shown;
    },
  });
  if (!note || !updates.stamped) return updates;
  doc.getElementById("update-reload").addEventListener("click", () => win.location.reload());
  doc.getElementById("update-later").addEventListener("click", () => updates.putOffNewer());
  const inView = () => doc.visibilityState === "visible";
  doc.addEventListener("visibilitychange", () => inView() && updates.check());
  win.addEventListener("focus", () => updates.check());
  win.addEventListener("online", () => updates.check());
  win.setInterval(() => inView() && updates.check(), EVERY_MS);
  return updates;
}
