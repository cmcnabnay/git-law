import express from "express";
import cors from "cors";
import { reposRouter } from "./routes/repos.js";
import { prsRouter } from "./routes/prs.js";
import { hookNotifyRouter } from "./routes/hookNotify.js";
import { gitHttpRouter } from "./routes/gitHttp.js";

export function createApp() {
  const app = express();
  app.use(cors());

  // Mounted ahead of express.json(): git's smart-HTTP requests carry raw
  // pkt-line/binary bodies, not JSON, and this route needs the untouched
  // stream to pipe straight into `git-upload-pack`/`git-receive-pack`.
  app.use("/repos", gitHttpRouter);

  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/repos/:repoId/prs", prsRouter);
  app.use("/api/repos/:repoId/hook-notify", hookNotifyRouter);
  app.use("/api/repos", reposRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });

  return app;
}
