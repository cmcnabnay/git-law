import { Command } from "commander";
import { startServer } from "@gitlaw/server";

export function registerServe(program: Command) {
  program
    .command("serve")
    .description("Start the Git Law API server (also receives post-receive hook notifications)")
    .option("-p, --port <port>", "override the configured port")
    .action(async (opts: { port?: string }) => {
      await startServer(opts.port ? Number(opts.port) : undefined);
    });
}
