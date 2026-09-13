import { loadConfig, reposRepo, pruneWorktrees } from "@gitlaw/core";
import { createApp } from "./app.js";

export function startServer(port?: number): Promise<import("node:http").Server> {
  const config = loadConfig();
  const listenPort = port ?? config.port;

  for (const repo of reposRepo.list()) {
    pruneWorktrees(repo.bare_path);
  }

  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(listenPort, "127.0.0.1", () => {
      console.log(`Git Law server listening on http://127.0.0.1:${listenPort}`);
      resolve(server);
    });
  });
}
