// On a narrow screen (pad.css, max-width 900px) the sidebar is a drawer: #menu slides it in over
// the pad, and a tap beside it (#scrim), Escape, or a choice in it (a meeting, New recording)
// slides it out. On a wide screen it is the sidebar it always was, and nothing here applies.

export const NARROW = "(max-width: 900px)";

export class Drawer {
  constructor(doc) {
    this.doc = doc;
    this.menu = doc.querySelector("#menu");
    this.sidebar = doc.querySelector("#sidebar");
    this.scrim = doc.querySelector("#scrim");
    this.narrow = doc.defaultView?.matchMedia?.(NARROW) ?? null;
  }

  start() {
    if (!this.menu || !this.sidebar || !this.scrim) return;
    this.menu.onclick = () => this.open(!this.isOpen);
    this.scrim.onclick = () => this.open(false);
    // After the app's own handler for the click: the meeting opens, then the drawer goes.
    this.sidebar.addEventListener("click", (e) => e.target.closest?.(".meeting, #new") && this.open(false));
    this.doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) {
        this.open(false);
        this.menu.focus();
      }
    });
    this.narrow?.addEventListener?.("change", () => this.open(false));
  }

  get isOpen() {
    return this.doc.body.classList.contains("drawer-open");
  }

  open(on) {
    this.doc.body.classList.toggle("drawer-open", on);
    this.menu.setAttribute("aria-expanded", String(on));
    this.scrim.hidden = !on;
    if (on) this.sidebar.querySelector("#new, button, a")?.focus({ preventScroll: true });
  }
}

if (typeof document !== "undefined") new Drawer(document).start();
