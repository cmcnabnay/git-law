import { Router } from "express";
import { createOrUpdatePr } from "@gitlaw/core";

export const hookNotifyRouter = Router({ mergeParams: true });

// Internal endpoint — called only by each repo's post-receive hook, never
// by the web UI. No auth token for this local single-machine prototype
// (the server is bound to 127.0.0.1); would need one if this ever became
// multi-machine.
hookNotifyRouter.post<{ repoId: string }>("/", (req, res) => {
  const { branch, newSha } = req.body ?? {};
  if (!branch || !newSha) return res.status(400).json({ error: "branch and newSha are required" });
  try {
    const pr = createOrUpdatePr(req.params.repoId, branch, newSha);
    res.json({ ok: true, pr });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
