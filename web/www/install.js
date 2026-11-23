// Penelope is a web app the browser can install beside the native ones. The sidebar's Install
// button opens the browser's own install prompt, which a page may open only once the browser
// offered it (beforeinstallprompt: Chrome and Microsoft Edge, on a computer or Android, the
// browsers that run the machine). In the installed app, and in a browser that offers nothing, the
// button stays hidden.

export class Installer {
  constructor(win, button) {
    this.win = win;
    this.button = button;
    // The browser's install prompt, until it is used: each opens once.
    this.offer = null;
  }

  start() {
    if (this.installed()) return this;
    this.win.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      this.offer = e;
      this.button.hidden = false;
    });
    this.win.addEventListener("appinstalled", () => this.done());
    this.button.addEventListener("click", () => this.install());
    return this;
  }

  installed() {
    return Boolean(this.win.matchMedia?.("(display-mode: standalone)").matches);
  }

  async install() {
    const offer = this.offer;
    if (!offer) return;
    this.offer = null;
    this.button.hidden = true;
    await offer.prompt();
    const { outcome } = await offer.userChoice;
    if (outcome === "accepted") this.done();
  }

  done() {
    this.offer = null;
    this.button.hidden = true;
  }
}

if (typeof document !== "undefined") {
  const button = document.getElementById("install");
  if (button) new Installer(window, button).start();
}
