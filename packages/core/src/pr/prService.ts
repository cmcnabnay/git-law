import { reposRepo, prRepo, eventsRepo, type PullRequest } from "../db/repositories.js";
import { commitAuthorEmail } from "../git/bareRepo.js";
import { detectParentBranch } from "../git/branches.js";
import { mergeBranchIntoMain } from "../git/merge.js";
import { nextTurnAfterPush } from "./turnLogic.js";

// Git signals "this ref was deleted" in a push update by sending the
// all-zero object id as the new sha, instead of a real commit sha.
const ZERO_SHA_PATTERN = /^0+$/;

/**
 * Called from the post-receive hook (via the hook-notify route) whenever a
 * branch is pushed (or deleted). Pushes to the default branch are a no-op
 * for PR logic. A push to a branch with no existing open-ended PR creates
 * one; a push to a branch with an existing open PR just adds a `pushed`
 * event and bumps head_sha; a push to a branch whose most recent PR was
 * `rejected` flips it back to `open` instead of creating a duplicate row.
 * Deleting a branch that has an open or rejected PR closes it (mirroring
 * GitHub: the PR is closed, not silently corrupted or deleted outright) —
 * this must be handled explicitly, since blindly writing the all-zero sha
 * into head_sha would leave the PR pointing at a commit that doesn't exist,
 * breaking any later attempt to diff it.
 */
export function createOrUpdatePr(repoId: string, branch: string, newSha: string): PullRequest | null {
  const repo = reposRepo.get(repoId);
  if (!repo) throw new Error(`Unknown repo: ${repoId}`);
  if (branch === repo.default_branch) return null;

  const existing = prRepo.findAnyByBranch(repoId, branch);

  if (ZERO_SHA_PATTERN.test(newSha)) {
    if (existing && (existing.status === "open" || existing.status === "rejected")) {
      prRepo.setStatus(existing.id, "closed");
      prRepo.setTurn(existing.id, null);
      eventsRepo.insert({ prId: existing.id, type: "closed", actorEmail: null });
      return prRepo.get(existing.id)!;
    }
    return null; // branch deleted with no open/rejected PR on it — nothing to do
  }

  const authorEmail = commitAuthorEmail(repo.bare_path, newSha);

  if (existing && (existing.status === "open" || existing.status === "rejected")) {
    prRepo.updateHeadSha(existing.id, newSha);
    if (existing.status === "rejected") {
      prRepo.setStatus(existing.id, "open");
    }
    prRepo.setTurn(existing.id, nextTurnAfterPush(repoId, authorEmail));
    eventsRepo.insert({ prId: existing.id, type: "pushed", actorEmail: authorEmail, sha: newSha });
    return prRepo.get(existing.id)!;
  }

  const parent = detectParentBranch(repo.bare_path, branch, newSha, repo.default_branch);
  const pr = prRepo.create({
    repoId,
    branch,
    targetBranch: repo.default_branch,
    headSha: newSha,
    baseSha: parent.sha,
    baseBranch: parent.branch,
    authorEmail,
    turnEmail: nextTurnAfterPush(repoId, authorEmail),
  });
  eventsRepo.insert({ prId: pr.id, type: "created", actorEmail: authorEmail, sha: newSha });
  return pr;
}

export async function approvePr(prId: string, actorEmail: string | null): Promise<PullRequest> {
  const pr = prRepo.get(prId);
  if (!pr) throw new Error(`Unknown pull request: ${prId}`);
  const repo = reposRepo.get(pr.repo_id);
  if (!repo) throw new Error(`Unknown repo: ${pr.repo_id}`);

  // Let a merge failure propagate — the PR stays `open` and the caller
  // (the API route) is responsible for surfacing the error, not swallowing it.
  const { mergeCommitSha } = await mergeBranchIntoMain(repo.bare_path, pr.branch, pr.target_branch);

  prRepo.setStatus(pr.id, "merged");
  prRepo.setTurn(pr.id, null);
  eventsRepo.insert({ prId: pr.id, type: "approved", actorEmail });
  eventsRepo.insert({ prId: pr.id, type: "merged", actorEmail, sha: mergeCommitSha });
  return prRepo.get(pr.id)!;
}

export function rejectPr(prId: string, actorEmail: string | null, comment: string | null): PullRequest {
  const pr = prRepo.get(prId);
  if (!pr) throw new Error(`Unknown pull request: ${prId}`);
  prRepo.setStatus(pr.id, "rejected");
  prRepo.setTurn(pr.id, pr.author_email);
  eventsRepo.insert({ prId: pr.id, type: "rejected", actorEmail, comment });
  return prRepo.get(pr.id)!;
}

export function addComment(prId: string, actorEmail: string | null, comment: string): PullRequest {
  const pr = prRepo.get(prId);
  if (!pr) throw new Error(`Unknown pull request: ${prId}`);
  eventsRepo.insert({ prId: pr.id, type: "comment", actorEmail, comment });
  return pr;
}
