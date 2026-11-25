// A meeting's transcription segments, naming report and learned clips, kept in this browser by its summary path.

/**
 * The IndexedDB database of the kept segments. No other module opens it, and
 * SegmentKeeper opens no other database.
 */
export const SEGMENTS_DB = "minutes-segments";

/**
 * The clip that named a segment or a speaker: the `voice` field of
 * known-voices' json output (known-voices:Output.2,
 * Provenance.MarshalJSON.1).
 *
 * @typedef {object} VoiceProvenance
 * @property {string} clip    "<slug>/<id>", the clip's reference
 * @property {"confirmed"|"unconfirmed"} status
 */

/**
 * One segment of `audio_transcribe`'s json output (known-voices:Output.2).
 * A library name is a `speaker` with a `voice`; without `voice` the speaker
 * is the label the transcript gave, or absent.
 *
 * @typedef {object} Segment
 * @property {number} start    seconds, the float the output gave
 * @property {number} end      seconds, the float the output gave
 * @property {string} [speaker]
 * @property {VoiceProvenance} [voice]
 * @property {string} text
 */

/**
 * The `naming` object of known-voices' json output
 * (known-voices:NamingReport.MarshalJSON.1, .2). Every status, origin,
 * reason and result is the text known-voices gives; none is listed here.
 *
 * @typedef {object} NamingReport
 * @property {string} status
 * @property {string} origin
 * @property {Array<{label: string, name?: string, voice?: VoiceProvenance, reason?: string}>} speakers
 * @property {Array<{name: string, result: string}>} voices
 * @property {string} [error]
 * @property {string} [unrecorded]
 */

/**
 * One clip a run learned: one `audio_remember_voice` result of that run,
 * "<name>: clip <id> added (unconfirmed)"
 * (known-voices:audio_remember_voice CallWithContext.12). The person it
 * belongs to is the Person of VoiceKeeper.people whose clips hold `clip`.
 *
 * @typedef {object} LearnedClip
 * @property {string} name   <name> of the result line, as given
 * @property {string} clip   <id> of the result line, 12 lower-case hex digits
 */

/**
 * What is kept for one meeting.
 *
 * @typedef {object} KeptSegments
 * @property {Segment[]} segments
 * @property {NamingReport|null} naming   null when the output had no naming
 *   (known-voices:Output.4, the bare array of segments)
 * @property {LearnedClip[]} learned      [] when the run learned none
 */

const MEETINGS = "meetings";

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const finished = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("aborted"));
});

// Whether a Blob, an ArrayBuffer or a typed array is anywhere in `value` (SegmentKeeper.2).
const binary = (value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value) || (typeof Blob !== "undefined" && value instanceof Blob) ||
  (value !== null && typeof value === "object" && Object.values(value).some(binary));

// The database, or null; without `create` a database not there yet stays absent (get.4).
function open(indexedDB, create) {
  if (!indexedDB) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(SEGMENTS_DB, 1);
      request.onupgradeneeded = () => {
        if (create) request.result.createObjectStore(MEETINGS);
        else request.transaction.abort();
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * The kept segments of the meetings this browser transcribed.
 *
 * - SegmentKeeper.1 — The kept segments live in the IndexedDB database
 *   SEGMENTS_DB and nowhere else. A second SegmentKeeper built over the same
 *   `indexedDB` gets everything the first one kept.
 * - SegmentKeeper.2 — What is kept is text and numbers: the database holds
 *   no Blob, no ArrayBuffer and no typed array, so no clip audio. No member
 *   writes localStorage, the notebook or the machine. (P2)
 * - SegmentKeeper.3 — No member puts up a note or a status and none
 *   rejects: the outcome of a call is its result. (P5)
 */
export class SegmentKeeper {
  #indexedDB;

  /**
   * @param {IDBFactory|undefined} indexedDB
   */
  constructor(indexedDB) {
    this.#indexedDB = indexedDB;
  }

  /**
   * Keeps a meeting's segments, naming report and learned clips under its
   * summary path.
   *
   * - keep.1 — After it resolves true for a path not kept before,
   *   `get(path)` resolves to `{segments, naming, learned}` equal to what
   *   was given: the segments in
   *   their order, every `start` and `end` the same number (61.2 stays
   *   61.2), `speaker` and `voice` present exactly where they were given
   *   and `voice` with its `clip` and `status`, the naming report whole.
   *   (known-voices:Output.1, Output.2, F6)
   * - keep.2 — A `naming` of null and a `learned` of [] are kept as given:
   *   the output of a run with no voices is kept like any other.
   *   (known-voices:Output.4)
   * - keep.3 — `learned` is kept in the order given. The keeper looks at no
   *   library and adds no clip of its own, so a meeting holds only the clips
   *   its caller says that meeting's own runs learned. (README Flow "Record
   *   with known people")
   * - keep.4 — A keep for a path that is kept already replaces its segments
   *   and its naming, and unions `learned` with what the path holds, by clip
   *   id: the entries the path held come first, as they were, followed by
   *   the given entries whose `clip` it did not hold, in the order given. An
   *   entry whose `clip` is held already is not added again and the held
   *   entry keeps its `name`. So a clip learned in a first run is still
   *   there after "Transcribe again". Every other path's stay as they were.
   * - keep.5 — With no `indexedDB`, a database that cannot be opened, or a
   *   write the browser refuses, it resolves false and what was kept before
   *   is unchanged.
   *
   * @param {string} path        the meeting's summary path
   * @param {Segment[]} segments
   * @param {NamingReport|null} naming
   * @param {LearnedClip[]} learned
   * @returns {Promise<boolean>} true when it is kept
   */
  async keep(path, segments, naming, learned) {
    try {
      if (binary([segments, naming, learned])) return false;
      const db = await open(this.#indexedDB, true);
      if (!db) return false;
      try {
        const tx = db.transaction(MEETINGS, "readwrite");
        const end = finished(tx);
        end.catch(() => {});
        const store = tx.objectStore(MEETINGS);
        const held = (await done(store.get(path)))?.learned ?? [];
        const ids = new Set(held.map((l) => l.clip));
        try {
          store.put({ segments, naming, learned: [...held, ...learned.filter((l) => !ids.has(l.clip))] }, path);
        } catch (error) {
          tx.abort();
          throw error;
        }
        await end;
        return true;
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  }

  /**
   * What is kept for a meeting.
   *
   * - get.1 — For a path that was kept it resolves to the segments and
   *   naming of the latest keep under it, and the learned clips of every
   *   keep under it (keep.4). Changing the value it
   *   resolved to changes nothing that is kept.
   * - get.2 — For a path that was never kept in this browser (another
   *   browser's meeting) it resolves null. (README Flow "Open a meeting")
   * - get.3 — With no `indexedDB`, or a database that cannot be opened or
   *   read, it resolves null.
   * - get.4 — It writes nothing: the database is the same before and after.
   *
   * @param {string} path  the meeting's summary path
   * @returns {Promise<KeptSegments|null>}
   */
  async get(path) {
    try {
      const db = await open(this.#indexedDB, false);
      if (!db) return null;
      try {
        const kept = await done(db.transaction(MEETINGS, "readonly").objectStore(MEETINGS).get(path));
        return kept ? { segments: kept.segments, naming: kept.naming, learned: kept.learned } : null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  /**
   * Forgets what is kept for a meeting, when the meeting is deleted.
   *
   * - remove.1 — After it resolves true, `get(path)` resolves null; every
   *   other path's stay as they were.
   * - remove.2 — For a path that was never kept it resolves true.
   * - remove.3 — With no `indexedDB`, or a database that cannot be opened or
   *   written, it resolves false.
   *
   * @param {string} path  the meeting's summary path
   * @returns {Promise<boolean>} true when nothing is kept under the path
   */
  async remove(path) {
    try {
      const db = await open(this.#indexedDB, true);
      if (!db) return false;
      try {
        const tx = db.transaction(MEETINGS, "readwrite");
        const end = finished(tx);
        tx.objectStore(MEETINGS).delete(path);
        await end;
        return true;
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  }
}
