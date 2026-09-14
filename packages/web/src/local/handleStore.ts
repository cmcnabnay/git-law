/**
 * Persists the `FileSystemDirectoryHandle` the user picked for a repo, so
 * they don't have to re-browse to the folder on every page load —
 * `FileSystemDirectoryHandle` is structured-cloneable and IndexedDB is the
 * standard place to keep one across sessions. The browser still requires a
 * fresh permission grant (a user gesture) most sessions; only the "which
 * folder" step is skipped.
 */

const DB_NAME = "gitlaw-local-handles";
const STORE = "handles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveDirHandle(repoId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore("readwrite", (store) => store.put(handle, repoId));
}

export async function loadDirHandle(repoId: string): Promise<FileSystemDirectoryHandle | null> {
  const handle = await withStore<FileSystemDirectoryHandle | undefined>("readonly", (store) => store.get(repoId));
  return handle ?? null;
}

export async function clearDirHandle(repoId: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(repoId));
}

export async function queryReadWritePermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  return handle.queryPermission({ mode: "readwrite" });
}

/** Must be called from inside a user gesture (e.g. a click handler) — the
 * browser refuses to show the permission prompt otherwise. */
export async function requestReadWritePermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  return handle.requestPermission({ mode: "readwrite" });
}
