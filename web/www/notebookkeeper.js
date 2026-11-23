// The notebook's files, kept in this browser's IndexedDB while no slivingdoc notebook is connected:
// the machine keeps no file past a reload, so each filed or saved meeting's summary and transcript
// are kept here by their path in the notebook, and go back onto the machine at the next load.
// Without storage (a private window, blocked site data) keep resolves false and all null.

const DB = "minutes-notebook";
const STORE = "files";

export class NotebookKeeper {
  constructor(indexedDB) {
    this.db = indexedDB ? new Promise((resolve) => {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    }) : Promise.resolve(null);
  }

  // Keeps each [path, text] in one transaction; resolves whether all were kept.
  async keep(files) {
    const db = await this.db;
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        for (const [path, text] of files) tx.objectStore(STORE).put(text, path);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  // Every kept [path, text], or null when nothing can be read.
  async all() {
    const db = await this.db;
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const store = db.transaction(STORE, "readonly").objectStore(STORE);
        const keys = store.getAllKeys();
        const texts = store.getAll();
        texts.onsuccess = () => resolve(keys.result.map((path, i) => [path, texts.result[i]]));
        texts.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
}

// `files` in runs of at most `max` characters of text each, in order; a larger file goes alone.
// A run's arguments hold 2 MiB in all (Minutes.writeFiles).
export function restoreBatches(files, max) {
  const batches = [];
  let batch = [];
  let size = 0;
  for (const file of files) {
    if (batch.length && size + file[1].length > max) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(file);
    size += file[1].length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
