import { Command } from "commander";
import { initDataDir, getDataDir } from "@gitlaw/core";

export function registerInit(program: Command) {
  program
    .command("init")
    .description("Initialize the local Git Law data directory (~/.git-law by default)")
    .option("-p, --port <port>", "port the Git Law server will listen on", "4127")
    .option(
      "--public-url <url>",
      'the URL other machines reach this server at (e.g. "http://34.204.201.203"), used to print working git clone commands — safe to re-run just to set this on an already-initialized install'
    )
    .action((opts) => {
      const config = initDataDir(Number(opts.port), opts.publicUrl);
      console.log(`Git Law initialized at ${getDataDir()}`);
      console.log(`Server port: ${config.port}`);
      if (config.publicUrl) console.log(`Public URL: ${config.publicUrl}`);
    });
}
