import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { FsaFs } from "./fsaFs.js";

export interface LocalBranchInfo {
  name: string;
  isCurrent: boolean;
  headSha: string;
  lastCommitMessage: string;
  lastCommitDate: string;
}

export interface LocalStatus {
  currentBranch: string | null;
  dirty: boolean;
  branches: LocalBranchInfo[];
}

export interface LocalFileEntry {
  path: string;
  size: number;
}

const DIR = "/";

export interface GitIdentity {
  name: string;
  email: string;
}

/** Reads `user.name`/`user.email` from this repo's own `.git/config`.
 * isomorphic-git never falls back to a machine-wide `~/.gitconfig` — the
 * File System Access permission is scoped to just this folder, so a fresh
 * clone on someone else's computer starts with neither field set, even if
 * they have a global git identity configured elsewhere. */
export async function getGitIdentity(fs: FsaFs): Promise<GitIdentity> {
  const [name, email] = await Promise.all([
    git.getConfig({ fs, dir: DIR, path: "user.name" }),
    git.getConfig({ fs, dir: DIR, path: "user.email" }),
  ]);
  return { name: name ?? "", email: email ?? "" };
}

export async function setGitIdentity(fs: FsaFs, identity: GitIdentity): Promise<void> {
  await git.setConfig({ fs, dir: DIR, path: "user.name", value: identity.name });
  await git.setConfig({ fs, dir: DIR, path: "user.email", value: identity.email });
}

export async function isGitWorkingRepo(root: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    await root.getDirectoryHandle(".git");
    return true;
  } catch {
    return false;
  }
}

export async function currentBranch(fs: FsaFs): Promise<string | null> {
  const name = await git.currentBranch({ fs, dir: DIR, fullname: false, test: true });
  return name ?? null;
}

/** A file counts as dirty unless it's identically present in HEAD, the
 * working directory, and the index — mirrors `git status --porcelain`
 * being non-empty. */
export async function isDirty(fs: FsaFs): Promise<boolean> {
  const matrix = await git.statusMatrix({ fs, dir: DIR });
  return matrix.some(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
}

export async function listLocalBranches(fs: FsaFs): Promise<LocalBranchInfo[]> {
  const names = await git.listBranches({ fs, dir: DIR });
  const current = await currentBranch(fs);
  const branches: LocalBranchInfo[] = [];
  for (const name of names) {
    const log = await git.log({ fs, dir: DIR, ref: name, depth: 1 });
    const top = log[0];
    branches.push({
      name,
      isCurrent: name === current,
      headSha: top?.oid ?? "",
      lastCommitMessage: (top?.commit.message ?? "").split("\n")[0],
      lastCommitDate: top ? new Date(top.commit.committer.timestamp * 1000).toISOString() : "",
    });
  }
  return branches;
}

export async function getStatus(fs: FsaFs): Promise<LocalStatus> {
  const [branch, dirty, branches] = await Promise.all([currentBranch(fs), isDirty(fs), listLocalBranches(fs)]);
  return { currentBranch: branch, dirty, branches };
}

/** `git checkout <branch>` — isomorphic-git's own conflict detection (like
 * real git) refuses and throws when the working directory has changes that
 * checkout would overwrite, rather than silently discarding them. */
export async function checkoutBranch(fs: FsaFs, branch: string): Promise<void> {
  await git.checkout({ fs, dir: DIR, ref: branch, force: false });
}

/** `git add -A && git commit -m <message>` on whatever branch is currently
 * checked out. Author/committer come from `user.name`/`user.email` in the
 * repo's real `.git/config`, exactly like the terminal would use. Throws
 * instead of committing when there's nothing staged. */
export async function addAndCommitAll(fs: FsaFs, message: string): Promise<{ sha: string }> {
  const matrix = await git.statusMatrix({ fs, dir: DIR });
  let changed = false;
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue; // already clean
    changed = true;
    if (workdir === 0) {
      await git.remove({ fs, dir: DIR, filepath });
    } else {
      await git.add({ fs, dir: DIR, filepath });
    }
  }
  if (!changed) {
    throw new Error("Nothing to commit — working tree is clean.");
  }
  const sha = await git.commit({ fs, dir: DIR, message });
  return { sha };
}

/** `git push -u origin <branch>` — pushes, then records the same
 * upstream-tracking config a real `-u` push would. */
export async function pushBranch(fs: FsaFs, branch: string): Promise<void> {
  await git.push({ fs, http, dir: DIR, remote: "origin", ref: branch });
  await git.setConfig({ fs, dir: DIR, path: `branch.${branch}.remote`, value: "origin" });
  await git.setConfig({ fs, dir: DIR, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });
}

export async function fetchOrigin(fs: FsaFs): Promise<void> {
  await git.fetch({ fs, http, dir: DIR, remote: "origin" });
}

/** `git clone <url>` into an already-picked (empty) folder — `singleBranch`
 * defaults to false, so every branch is fetched as a remote-tracking ref,
 * matching a real terminal clone; only the default branch is checked out,
 * same as the terminal. Pair with `syncFromRemote` right after to also
 * create local branches for every other remote branch. */
export async function cloneRepo(fs: FsaFs, url: string): Promise<void> {
  await git.clone({ fs, http, dir: DIR, url });
}

/** Remote-tracking branch short names under `origin/`, excluding the
 * symbolic `HEAD`. */
export async function remoteBranchNames(fs: FsaFs): Promise<string[]> {
  const names = await git.listBranches({ fs, dir: DIR, remote: "origin" });
  return names.filter((n) => n !== "HEAD");
}

/**
 * `git fetch origin`, then create a real local branch (not checked out)
 * for every remote branch that doesn't already have a local counterpart.
 * Unlike a literal `checkout -b` per branch, creating with `checkout:
 * false` never moves HEAD in the first place, so there's nothing to
 * "restore" afterward — the user's current branch is simply never touched.
 */
export async function syncFromRemote(fs: FsaFs): Promise<{ created: string[] }> {
  await fetchOrigin(fs);
  const localNames = new Set(await git.listBranches({ fs, dir: DIR }));
  const created: string[] = [];
  for (const name of await remoteBranchNames(fs)) {
    if (localNames.has(name)) continue;
    await git.branch({ fs, dir: DIR, ref: name, object: `refs/remotes/origin/${name}`, checkout: false });
    created.push(name);
  }
  return { created };
}

/** `git checkout -b <newBranch> <fromBranch>`. */
/** Creates `newBranch` at `fromBranch`'s commit and checks it out. `git.branch`'s
 * own `checkout` option only repoints the `HEAD` ref — it never writes the
 * target commit's files into the working directory or index (that's what
 * `git.checkout` does), so without the explicit checkout below the working
 * tree is silently left showing whatever branch was checked out before. */
export async function createBranch(fs: FsaFs, newBranch: string, fromBranch: string): Promise<void> {
  await git.branch({ fs, dir: DIR, ref: newBranch, object: fromBranch, checkout: false });
  await git.checkout({ fs, dir: DIR, ref: newBranch, force: false });
}

export async function listFilesAtRef(fs: FsaFs, ref: string): Promise<LocalFileEntry[]> {
  const paths = await git.listFiles({ fs, dir: DIR, ref });
  const commitOid = await git.resolveRef({ fs, dir: DIR, ref });
  const entries: LocalFileEntry[] = [];
  for (const filepath of paths) {
    try {
      const { blob } = await git.readBlob({ fs, dir: DIR, oid: commitOid, filepath });
      entries.push({ path: filepath, size: blob.length });
    } catch {
      entries.push({ path: filepath, size: 0 });
    }
  }
  return entries;
}
