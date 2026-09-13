import { Command } from "commander";
import { initDataDir, getDataDir } from "@gitlaw/core";

export function registerInit(program: Command) {
  program
    .command("init")
    .description("Initialize the local Git Law data directory (~/.git-law by default)")
    .option("-p, --port <port>", "port the Git Law server will listen on", "4127")
    .action((opts) => {
      const config = initDataDir(Number(opts.port));
      console.log(`Git Law initialized at ${getDataDir()}`);
      console.log(`Server port: ${config.port}`);
    });
}
