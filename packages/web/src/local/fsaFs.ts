/**
 * A Node `fs.promises`-shaped adapter over a real folder on the user's
 * machine, backed by the browser's File System Access API
 * (`FileSystemDirectoryHandle`). isomorphic-git only knows how to talk to
 * an `fs`-like object — this is what lets it read/write the user's actual
 * local clone instead of some in-memory or IndexedDB-only filesystem.
 *
 * isomorphic-git always passes paths rooted at whatever `dir` you give it
 * (we use `dir: "/"`), so every path handed to these methods is an
 * absolute-looking POSIX path relative to the picked folder, e.g.
 * "/.git/objects/ab/cdef...".
 */

function notFound(filepath: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, '${filepath}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

// "." and ".." segments show up in paths isomorphic-git hands us (e.g. the
// root itself as "."). The File System Access API rejects "." and ".." as
// entry names outright ("Name is not allowed"), so they have to be resolved
// away here rather than treated as literal folder names.
function segments(filepath: string): string[] {
  const out: string[] = [];
  for (const part of filepath.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "NotFoundError" || err.name === "TypeMismatchError");
}

interface Stat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
}

function makeStat(isDir: boolean, size: number, mtimeMs: number): Stat {
  return {
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
    size,
    mode: isDir ? 0o40000 : 0o100644,
    mtimeMs,
    ctimeMs: mtimeMs,
    uid: 1,
    gid: 1,
    dev: 0,
    ino: 0,
  };
}

export class FsaFs {
  private root: FileSystemDirectoryHandle;
  // Directory handles get looked up over and over for the same prefixes
  // (every object read walks through .git/objects/, etc.) — a small cache
  // keyed by joined path avoids re-walking from the root every time.
  private dirCache = new Map<string, FileSystemDirectoryHandle>();

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }

  private async getDirHandle(segs: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    const key = segs.join("/");
    const cached = this.dirCache.get(key);
    if (cached) return cached;

    let dir = this.root;
    let path = "";
    for (const seg of segs) {
      path = path ? `${path}/${seg}` : seg;
      const cachedStep = this.dirCache.get(path);
      if (cachedStep) {
        dir = cachedStep;
        continue;
      }
      try {
        dir = await dir.getDirectoryHandle(seg, { create });
      } catch (err) {
        if (isNotFoundError(err)) throw notFound(segs.join("/"));
        throw err;
      }
      this.dirCache.set(path, dir);
    }
    return dir;
  }

  private async getFileHandle(filepath: string, create: boolean): Promise<FileSystemFileHandle> {
    const segs = segments(filepath);
    const name = segs.pop();
    if (!name) throw notFound(filepath);
    const dir = await this.getDirHandle(segs, create);
    try {
      return await dir.getFileHandle(name, { create });
    } catch (err) {
      if (isNotFoundError(err)) throw notFound(filepath);
      throw err;
    }
  }

  promises = {
    readFile: async (filepath: string, opts?: string | { encoding?: string }): Promise<Uint8Array | string> => {
      const handle = await this.getFileHandle(filepath, false);
      const file = await handle.getFile();
      const buf = new Uint8Array(await file.arrayBuffer());
      const encoding = typeof opts === "string" ? opts : opts?.encoding;
      if (encoding === "utf8") return new TextDecoder().decode(buf);
      return buf;
    },

    writeFile: async (filepath: string, data: Uint8Array | string, _opts?: unknown): Promise<void> => {
      const handle = await this.getFileHandle(filepath, true);
      const writable = await handle.createWritable();
      await writable.write(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
      await writable.close();
    },

    unlink: async (filepath: string): Promise<void> => {
      const segs = segments(filepath);
      const name = segs.pop();
      if (!name) throw notFound(filepath);
      const dir = await this.getDirHandle(segs, false);
      try {
        await dir.removeEntry(name);
      } catch (err) {
        if (isNotFoundError(err)) throw notFound(filepath);
        throw err;
      }
    },

    readdir: async (filepath: string): Promise<string[]> => {
      const dir = await this.getDirHandle(segments(filepath), false);
      const names: string[] = [];
      for await (const name of dir.keys()) names.push(name);
      return names;
    },

    mkdir: async (filepath: string): Promise<void> => {
      await this.getDirHandle(segments(filepath), true);
    },

    rmdir: async (filepath: string): Promise<void> => {
      const segs = segments(filepath);
      const name = segs.pop();
      if (!name) throw notFound(filepath);
      const dir = await this.getDirHandle(segs, false);
      try {
        await dir.removeEntry(name, { recursive: true });
      } catch (err) {
        if (isNotFoundError(err)) throw notFound(filepath);
        throw err;
      }
      // Any cached handle at or under this path is now stale — clearing the
      // whole cache is cheap next to correctness (rmdir is uncommon).
      this.dirCache.clear();
    },

    stat: async (filepath: string): Promise<Stat> => this.statImpl(filepath),
    lstat: async (filepath: string): Promise<Stat> => this.statImpl(filepath),

    // Real symlinks essentially never appear in a repo of legal documents,
    // and the File System Access API has no concept of them anyway — since
    // `stat`/`lstat` above never report a symlink, isomorphic-git never
    // calls readlink/symlink in practice, so these only exist to satisfy
    // the FsClient shape.
    readlink: async (filepath: string): Promise<string> => {
      throw new Error(`readlink not supported: ${filepath}`);
    },
    symlink: async (target: string, filepath: string): Promise<void> => {
      throw new Error(`symlink not supported: ${filepath} -> ${target}`);
    },
    // File System Access API has no concept of unix permission bits.
    chmod: async (_filepath: string, _mode: number): Promise<void> => {},
  };

  private async statImpl(filepath: string): Promise<Stat> {
    const segs = segments(filepath);
    if (segs.length === 0) return makeStat(true, 0, Date.now());
    const name = segs.pop()!;
    const dir = await this.getDirHandle(segs, false);
    try {
      const fileHandle = await dir.getFileHandle(name);
      const file = await fileHandle.getFile();
      return makeStat(false, file.size, file.lastModified);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    try {
      await dir.getDirectoryHandle(name);
      return makeStat(true, 0, Date.now());
    } catch (err) {
      if (isNotFoundError(err)) throw notFound(filepath);
      throw err;
    }
  }
}
