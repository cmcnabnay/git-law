import { Router } from "express";
import {
  reposRepo,
  listTree,
  isGitWorkingRepo,
  currentLocalBranch,
  listLocalBranches,
  hasUncommittedChanges,
  checkoutLocalBranch,
  addAndCommitAll,
  pushBranch,
  syncFromRemote,
  createLocalBranch,
  type Repo,
} from "@gitlaw/core";
import { asyncHandler } from "../asyncHandler.js";

export const localRepoRouter = Router({ mergeParams: true });

interface RepoParams {
  repoId: string;
}

type Linked = { repo: Repo & { local_path: string } };
type LinkError = { error: { status: number; message: string } };

function getLinkedRepo(repoId: string): Linked | LinkError {
  const repo = reposRepo.get(repoId);
  if (!repo) return { error: { status: 404, message: "repo not found" } };
  if (!repo.local_path) {
    return { error: { status: 409, message: "No local clone linked yet — set a local clone path first." } };
  }
  if (!isGitWorkingRepo(repo.local_path)) {
    return { error: { status: 409, message: `"${repo.local_path}" is not a git working directory.` } };
  }
  return { repo: repo as Linked["repo"] };
}

function statusFor(localPath: string) {
  return {
    linked: true,
    localPath,
    valid: true,
    currentBranch: currentLocalBranch(localPath),
    dirty: hasUncommittedChanges(localPath),
    branches: listLocalBranches(localPath),
  };
}

localRepoRouter.get<RepoParams>("/", (req, res) => {
  const repo = reposRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: "repo not found" });
  if (!repo.local_path) {
    return res.json({ linked: false, localPath: null, valid: false, currentBranch: null, dirty: false, branches: [] });
  }
  if (!isGitWorkingRepo(repo.local_path)) {
    return res.json({
      linked: true,
      localPath: repo.local_path,
      valid: false,
      error: `"${repo.local_path}" is not a git working directory.`,
      currentBranch: null,
      dirty: false,
      branches: [],
    });
  }
  res.json(statusFor(repo.local_path));
});

localRepoRouter.get<RepoParams>("/tree", (req, res) => {
  const linked = getLinkedRepo(req.params.repoId);
  if ("error" in linked) return res.status(linked.error.status).json({ error: linked.error.message });
  const branch = (req.query.branch as string) || currentLocalBranch(linked.repo.local_path) || undefined;
  if (!branch) return res.status(400).json({ error: "branch is required" });
  try {
    res.json(listTree(linked.repo.local_path, branch));
  } catch (err) {
    res.status(404).json({ error: `could not list files at ${branch}: ${(err as Error).message}` });
  }
});

localRepoRouter.post<RepoParams>("/checkout", (req, res) => {
  const linked = getLinkedRepo(req.params.repoId);
  if ("error" in linked) return res.status(linked.error.status).json({ error: linked.error.message });
  const { branch } = req.body ?? {};
  if (!branch) return res.status(400).json({ error: "branch is required" });
  try {
    checkoutLocalBranch(linked.repo.local_path, branch);
    res.json(statusFor(linked.repo.local_path));
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

localRepoRouter.post<RepoParams>("/commit", (req, res) => {
  const linked = getLinkedRepo(req.params.repoId);
  if ("error" in linked) return res.status(linked.error.status).json({ error: linked.error.message });
  const message = (req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "commit message is required" });
  try {
    addAndCommitAll(linked.repo.local_path, message);
    res.json(statusFor(linked.repo.local_path));
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
});

localRepoRouter.post<RepoParams>(
  "/push",
  asyncHandler(async (req, res) => {
    const linked = getLinkedRepo(req.params.repoId);
    if ("error" in linked) return res.status(linked.error.status).json({ error: linked.error.message });
    const branch = req.body?.branch || currentLocalBranch(linked.repo.local_path);
    if (!branch) return res.status(400).json({ error: "branch is required" });
    try {
      await pushBranch(linked.repo.local_path, branch);
      res.json(statusFor(linked.repo.local_path));
    } catch (err) {
      res.status(422).json({ error: (err as Error).message });
    }
  })
);

localRepoRouter.post<RepoParams>(
  "/sync",
  asyncHandler(async (req, res) => {
    const linked = getLinkedRepo(req.params.repoId);
    if ("error" in linked) return res.status(linked.error.status).json({ error: linked.error.message });
    try {
      const { created } = await syncFromRemote(linked.repo.local_path);
      res.json({ created, ...statusFor(linked.repo.local_path) });
    } catch (err) {
      res.status(422).json({ error: (err as Error).message });
    }
  })
);

localRepoRouter.post<RepoParams>("/branches", (req, res) => {
  const linked = getLinkedRepo(req.params.repoId);
  if ("error" in linked) return res.status(linked.error.status).json({ error: linked.error.message });
  const name = (req.body?.name ?? "").trim();
  const from = req.body?.from;
  if (!name) return res.status(400).json({ error: "branch name is required" });
  if (!from) return res.status(400).json({ error: "source branch is required" });
  try {
    createLocalBranch(linked.repo.local_path, name, from);
    res.json(statusFor(linked.repo.local_path));
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
});
