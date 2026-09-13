import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Serializes merges per-repo so two concurrent approvals against the same
// bare repo can't race on worktree/ref updates.
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(repoKey: string, fn: () => T): Promise<T> {
  const prior = repoLocks.get(repoKey) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  repoLocks.set(
    repoKey,
    next.catch(() => undefined)
  );
  return next;
}

export function pruneWorktrees(barePath: string): void {
  try {
    execFileSync("git", ["-C", barePath, "worktree", "prune"]);
  } catch {
    // best-effort; nothing to prune or repo not initialized yet
  }
}

/**
 * Merges `branch` into `targetBranch` inside the given bare repo.
 *
 * Bare repos have no working tree to run `git merge` in directly, so this
 * attaches a temporary worktree checked out at `targetBranch` (supported
 * against bare repos since git 2.5+). Because the worktree shares the same
 * object database as the bare repo, committing the merge there updates
 * `refs/heads/<targetBranch>` directly — no push step is needed.
 *
 * Uses `-X theirs` because this is not a structural document merge: exactly
 * one party edits a given branch at a time in this workflow, so "approve"
 * means "replace the target's content with the branch's content." `-X
 * theirs` only resolves content-level conflicts, not structural ones
 * (renames, add/add, mode changes) — those are rare given the workflow's
 * one-file-one-editor-at-a-time shape, but if they occur the merge is
 * aborted and the worktree is always cleaned up, leaving the PR untouched
 * (still open) so the caller can report the failure.
 */
export async function mergeBranchIntoMain(
  barePath: string,
  branch: string,
  targetBranch: string
): Promise<{ mergeCommitSha: string }> {
  return withRepoLock(barePath, () => {
    pruneWorktrees(barePath);
    const worktreeDir = mkdtempSync(path.join(tmpdir(), "gitlaw-merge-"));
    try {
      execFileSync("git", ["-C", barePath, "worktree", "add", worktreeDir, targetBranch]);
      try {
        execFileSync("git", [
          "-C",
          worktreeDir,
          "merge",
          "--no-ff",
          "-X",
          "theirs",
          branch,
          "-m",
          `Merge branch '${branch}' into ${targetBranch}`,
        ]);
      } catch (err) {
        try {
          execFileSync("git", ["-C", worktreeDir, "merge", "--abort"]);
        } catch {
          // nothing to abort, or already clean
        }
        throw new Error(`Merge of '${branch}' into '${targetBranch}' failed: ${(err as Error).message}`);
      }
      const sha = execFileSync("git", ["-C", worktreeDir, "rev-parse", "HEAD"]).toString().trim();
      return { mergeCommitSha: sha };
    } finally {
      try {
        execFileSync("git", ["-C", barePath, "worktree", "remove", "--force", worktreeDir]);
      } catch {
        rmSync(worktreeDir, { recursive: true, force: true });
      }
    }
  });
}
