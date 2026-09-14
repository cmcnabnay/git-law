import { Router } from "express";
import {
  reposRepo,
  prRepo,
  eventsRepo,
  approvePr,
  rejectPr,
  addComment,
  computePrDiff,
  branchExists,
  branchHeadSha,
  type FileDiff,
} from "@gitlaw/core";
import { asyncHandler } from "../asyncHandler.js";

export const prsRouter = Router({ mergeParams: true });

interface RepoParams {
  repoId: string;
}
interface PrParams extends RepoParams {
  prId: string;
}

// Git's "this ref doesn't exist" sentinel (all-zero object id) can end up
// stored on an already-corrupted row from before this validation existed —
// never hand that to a git command, it isn't a real commit.
const VALID_SHA = /^[0-9a-f]{7,64}$/i;
function isRealCommit(sha: string): boolean {
  return VALID_SHA.test(sha) && !/^0+$/.test(sha);
}

prsRouter.get<RepoParams>("/", (req, res) => {
  const repo = reposRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: "repo not found" });
  const status = req.query.status as "open" | "rejected" | "merged" | "closed" | undefined;
  res.json(prRepo.listForRepo(repo.id, status));
});

prsRouter.get<PrParams>(
  "/:prId",
  asyncHandler(async (req, res) => {
    const repo = reposRepo.get(req.params.repoId);
    if (!repo) return res.status(404).json({ error: "repo not found" });
    const pr = prRepo.get(req.params.prId);
    if (!pr || pr.repo_id !== repo.id) return res.status(404).json({ error: "pull request not found" });

    // ?compareTo=<branch> lets the caller preview the diff against any
    // branch's current head instead of the PR's stored base_sha — a
    // display-only override for this one response, never written back to
    // the PR row (which keeps deciding what it merges into and, by
    // default, what it diffs against).
    const compareTo = req.query.compareTo as string | undefined;
    const useOverride = !!compareTo && branchExists(repo.bare_path, compareTo);
    const baseSha = useOverride ? branchHeadSha(repo.bare_path, compareTo!) : pr.base_sha;
    const compareBranch = useOverride ? compareTo! : (pr.base_branch ?? pr.target_branch);

    const diffs: FileDiff[] =
      isRealCommit(pr.head_sha) && isRealCommit(baseSha)
        ? await computePrDiff(repo.bare_path, baseSha, pr.head_sha)
        : [];

    res.json({
      pr,
      events: eventsRepo.listForPr(pr.id),
      diffs,
      compareBranch,
      compareSha: baseSha,
    });
  })
);

prsRouter.delete<PrParams>("/:prId", (req, res) => {
  const repo = reposRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: "repo not found" });
  const pr = prRepo.get(req.params.prId);
  if (!pr || pr.repo_id !== repo.id) return res.status(404).json({ error: "pull request not found" });

  prRepo.delete(pr.id);
  res.json({ ok: true, deleted: pr });
});

prsRouter.post<PrParams>(
  "/:prId/approve",
  asyncHandler(async (req, res) => {
    const repo = reposRepo.get(req.params.repoId);
    if (!repo) return res.status(404).json({ error: "repo not found" });
    const pr = prRepo.get(req.params.prId);
    if (!pr || pr.repo_id !== repo.id) return res.status(404).json({ error: "pull request not found" });
    if (pr.status !== "open") return res.status(409).json({ error: `PR is already ${pr.status}` });

    try {
      const updated = await approvePr(pr.id, req.body?.actorEmail ?? null);
      res.json(updated);
    } catch (err) {
      res.status(422).json({ error: (err as Error).message });
    }
  })
);

prsRouter.post<PrParams>("/:prId/reject", (req, res) => {
  const repo = reposRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: "repo not found" });
  const pr = prRepo.get(req.params.prId);
  if (!pr || pr.repo_id !== repo.id) return res.status(404).json({ error: "pull request not found" });
  if (pr.status !== "open") return res.status(409).json({ error: `PR is already ${pr.status}` });

  const updated = rejectPr(pr.id, req.body?.actorEmail ?? null, req.body?.comment ?? null);
  res.json(updated);
});

prsRouter.post<PrParams>("/:prId/comments", (req, res) => {
  const repo = reposRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: "repo not found" });
  const pr = prRepo.get(req.params.prId);
  if (!pr || pr.repo_id !== repo.id) return res.status(404).json({ error: "pull request not found" });
  if (!req.body?.comment) return res.status(400).json({ error: "comment is required" });

  const updated = addComment(pr.id, req.body?.actorEmail ?? null, req.body.comment);
  res.json({ pr: updated, events: eventsRepo.listForPr(pr.id) });
});
