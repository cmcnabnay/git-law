import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const execFileAsync = promisify(execFile);

export interface LocalBranchInfo {
  name: string;
  isCurrent: boolean;
  headSha: string;
  lastCommitMessage: string;
  lastCommitDate: string;
}

/** Runs git against a working-directory clone (not a bare repo) and, on
 * failure, rethrows with git's own stderr — the raw "your local changes
 * would be overwritten" / "not a valid ref" text is more useful to a user
 * driving git from the browser than a generic exec error. */
function run(localPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", localPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 20,
    }).toString();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    const stderr = e.stderr ? e.stderr.toString().trim() : "";
    throw new Error(stderr || e.message);
  }
}

/**
 * Same as `run`, but non-blocking. Every repo this app hosts has its own
 * server as `origin` — so `git push`/`git fetch` here make an HTTP request
 * back into this very process's smart-HTTP git endpoint. `execFileSync`
 * would block the whole (single-threaded) event loop for as long as the
 * child runs, which means the event loop would never be free to service
 * that inbound request: git push/fetch would deadlock against itself on
 * every call. Only push and fetch need this — everything else here is
 * local-only and safe to run synchronously like the rest of the codebase.
 */
async function runAsync(localPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", localPath, ...args], {
      maxBuffer: 1024 * 1024 * 20,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderr = e.stderr ? e.stderr.trim() : "";
    throw new Error(stderr || e.message);
  }
}

export function isGitWorkingRepo(localPath: string): boolean {
  try {
    if (!fs.existsSync(localPath)) return false;
    const out = execFileSync("git", ["-C", localPath, "rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out === "true";
  } catch {
    return false;
  }
}

/** Null on a detached HEAD (no branch checked out) rather than throwing —
 * every caller here treats "no current branch" as a normal state to show. */
export function currentLocalBranch(localPath: string): string | null {
  try {
    const out = run(localPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    return out === "HEAD" ? null : out;
  } catch {
    return null;
  }
}

export function listLocalBranches(localPath: string): LocalBranchInfo[] {
  const current = currentLocalBranch(localPath);
  const out = run(localPath, [
    "for-each-ref",
    "--format=%(refname:short)|%(objectname)|%(committerdate:iso-strict)|%(subject)",
    "refs/heads/",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, headSha, lastCommitDate, ...rest] = line.split("|");
      return { name, isCurrent: name === current, headSha, lastCommitDate, lastCommitMessage: rest.join("|") };
    });
}

export function hasUncommittedChanges(localPath: string): boolean {
  return run(localPath, ["status", "--porcelain"]).trim().length > 0;
}

/** `git checkout <branch>` — left to fail with git's own error (e.g.
 * uncommitted changes that would be overwritten) rather than force/stash,
 * so nothing is silently discarded. */
export function checkoutLocalBranch(localPath: string, branch: string): void {
  run(localPath, ["checkout", branch]);
}

/** `git add -A && git commit -m <message>` on whatever branch is currently
 * checked out. Throws instead of creating an empty commit when there's
 * nothing staged after `add -A`. */
export function addAndCommitAll(localPath: string, message: string): { sha: string } {
  run(localPath, ["add", "-A"]);
  const staged = run(localPath, ["diff", "--cached", "--name-only"]).trim();
  if (!staged) {
    throw new Error("Nothing to commit — working tree is clean.");
  }
  run(localPath, ["commit", "-m", message]);
  return { sha: run(localPath, ["rev-parse", "HEAD"]).trim() };
}

/** `git push -u origin <branch>`. Async — see `runAsync`. */
export async function pushBranch(localPath: string, branch: string): Promise<void> {
  await runAsync(localPath, ["push", "-u", "origin", branch]);
}

/** Async — see `runAsync`. */
export async function fetchOrigin(localPath: string): Promise<void> {
  await runAsync(localPath, ["fetch", "origin"]);
}

/** Short branch names behind `origin/`, excluding the symbolic `origin/HEAD`. */
export function remoteBranchNames(localPath: string): string[] {
  const out = run(localPath, ["branch", "-r", "--format=%(refname:short)"]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((name) => name.startsWith("origin/") && name !== "origin/HEAD")
    .map((name) => name.slice("origin/".length));
}

/** `git checkout -b <name> <from>`. */
export function createLocalBranch(localPath: string, newBranch: string, fromBranch: string): void {
  run(localPath, ["checkout", "-b", newBranch, fromBranch]);
}

/**
 * `git fetch origin`, then `git checkout -b <branch> origin/<branch>` for
 * every remote branch that doesn't already have a local counterpart.
 * Restores whatever branch was checked out beforehand once done, so
 * pulling down new branches never leaves the user's working directory
 * somewhere they didn't ask to be.
 */
export async function syncFromRemote(localPath: string): Promise<{ created: string[] }> {
  await fetchOrigin(localPath);
  const before = currentLocalBranch(localPath);
  const localNames = new Set(listLocalBranches(localPath).map((b) => b.name));
  const created: string[] = [];
  for (const name of remoteBranchNames(localPath)) {
    if (localNames.has(name)) continue;
    run(localPath, ["checkout", "-b", name, `origin/${name}`]);
    created.push(name);
  }
  if (before && created.length > 0) {
    run(localPath, ["checkout", before]);
  }
  return { created };
}
