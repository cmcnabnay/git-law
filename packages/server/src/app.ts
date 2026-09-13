import express from "express";
import cors from "cors";
import { reposRouter } from "./routes/repos.js";
import { prsRouter } from "./routes/prs.js";
import { hookNotifyRouter } from "./routes/hookNotify.js";

export function createApp() {
  const app = express();
  app.use(cors());
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
