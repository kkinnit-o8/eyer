// Saved songs: imported maps are kept in the browser (IndexedDB) so they're
// still there next time. Only the charts (.osu) and the song are stored.

const DB_NAME = "eyer";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("songs", { keyPath: "id" }); // { id, title, artist, addedAt, playedAt }
      db.createObjectStore("songFiles"); // id -> [{ name, bytes }]
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

// Runs fn(stores) in one transaction and resolves with what its last
// request returned, once the transaction has committed.
async function transact(names, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const stores = names.map((n) => tx.objectStore(n));
    const request = fn(...stores);
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Saved songs, most recently played first. */
export async function listSongs() {
  const songs = await transact(["songs"], "readonly", (s) => s.getAll());
  return songs.sort((a, b) => b.playedAt - a.playedAt);
}

/** Saves (or replaces) a song. files: Map of file name -> bytes. */
export async function saveSong(song, files) {
  const list = [...files].map(([name, bytes]) => ({ name, bytes }));
  await transact(["songs", "songFiles"], "readwrite", (songs, songFiles) => {
    songs.put(song);
    return songFiles.put(list, song.id);
  });
  // Ask the browser not to clear saved songs when space runs low.
  navigator.storage?.persist?.().catch(() => {});
}

/** A saved song's files, as a Map of file name -> bytes. */
export async function loadSongFiles(id) {
  const list = await transact(["songFiles"], "readonly", (s) => s.get(id));
  return new Map((list ?? []).map((f) => [f.name, f.bytes]));
}

export async function touchSong(song) {
  await transact(["songs"], "readwrite", (s) => s.put({ ...song, playedAt: Date.now() }));
}

export async function removeSong(id) {
  await transact(["songs", "songFiles"], "readwrite", (songs, songFiles) => {
    songs.delete(id);
    return songFiles.delete(id);
  });
}
