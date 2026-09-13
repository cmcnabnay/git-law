import { Router } from "express";
import {
  createRepo,
  deleteRepo,
  reposRepo,
  participantsRepo,
  prRepo,
  listBranches,
  readBlob,
  listTree,
  readWordDocument,
} from "@gitlaw/core";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
};

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export const reposRouter = Router();

reposRouter.post("/", (req, res) => {
  const { name, participants } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  const repo = createRepo({ name, participants });
  res.status(201).json({ ...repo, clonePath: repo.bare_path });
});

reposRouter.get("/", (_req, res) => {
  const repos = reposRepo.list().map((r) => ({
    ...r,
    openPrCount: prRepo.listForRepo(r.id, "open").length,
  }));
  res.json(repos);
});

reposRouter.get("/:repoId", (req, res) => {
  const repo = reposRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: "repo not found" });
  res.json({
    ...repo,
    participants: participantsRepo.listForRepo(repo.id),
    branches: listBranches(repo.bare_path),
    clonePath: repo.bare_path,
  });
});

reposRouter.delete("/:repoId", (req, res) => {
  try {
    const repo = deleteRepo(req.params.repoId);
    res.json({ ok: true, deleted: repo });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

reposRouter.get("/:repoId/branches", (req, res) => {
  const repo = reposRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: "repo not found" });
  res.json(listBranches(repo.bare_path));
});

reposRouter.get("/:repoId/tree", (req, res) => {
  const repo = reposRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: "repo not found" });
  const ref = (req.query.ref as string) || repo.default_branch;
  try {
    res.json(listTree(repo.bare_path, ref));
  } catch (err) {
    res.status(404).json({ error: `could not list files at ${ref}: ${(err as Error).message}` });
  }
});

reposRouter.get("/:repoId/preview", async (req, res) => {
  const repo = reposRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: "repo not found" });
  const rev = req.query.rev as string;
  const filePath = req.query.path as string;
  if (!rev || !filePath) return res.status(400).json({ error: "rev and path are required" });
  try {
    const buf = readBlob(repo.bare_path, rev, filePath);
    const { html } = await readWordDocument(buf, filePath);
    res.json({ html });
  } catch (err) {
    res.status(404).json({ error: `could not preview ${filePath} at ${rev}: ${(err as Error).message}` });
  }
});

reposRouter.get("/:repoId/blob", (req, res) => {
  const repo = reposRepo.get(req.params.repoId);
  if (!repo) return res.status(404).json({ error: "repo not found" });
  const rev = req.query.rev as string;
  const filePath = req.query.path as string;
  if (!rev || !filePath) return res.status(400).json({ error: "rev and path are required" });
  try {
    const buf = readBlob(repo.bare_path, rev, filePath);
    res.setHeader("Content-Type", contentTypeFor(filePath));
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
    res.send(buf);
  } catch (err) {
    res.status(404).json({ error: `could not read ${filePath} at ${rev}: ${(err as Error).message}` });
  }
});
