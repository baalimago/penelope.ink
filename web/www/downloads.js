// `download FILE` on the machine (machine/download.sh) saves the file on this computer. Its bytes
// come through /run/page/out as `download-part <id>` messages of at most 15 MB, then a
// `download-end <id>` whose body is the file's name, and the browser downloads them as one file.
import { splitMessage } from "./minutes.js";

export class Downloads {
  // `save(blob, name)` hands a finished file to the browser.
  constructor(save = saveFile) {
    this.save = save;
    // The parts of each file still coming, by its id.
    this.parts = new Map();
  }

  // Takes the message `bytes` if it is a download's, and says whether it was.
  receive(bytes) {
    const { topic, body } = splitMessage(bytes);
    const [kind, id] = topic.split(" ");
    if (kind === "download-part") {
      if (!this.parts.has(id)) this.parts.set(id, []);
      this.parts.get(id).push(body);
      return true;
    }
    if (kind !== "download-end") return false;
    const parts = this.parts.get(id) ?? [];
    this.parts.delete(id);
    this.save(new Blob(parts), new TextDecoder().decode(body) || "download");
    return true;
  }
}

// Saves `blob` as a download of the browser's named `name`.
export function saveFile(blob, name) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
