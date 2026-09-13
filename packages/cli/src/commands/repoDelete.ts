import { Command } from "commander";
import readline from "node:readline/promises";
import { deleteRepo } from "@gitlaw/core";

export function registerRepoDelete(repoCmd: Command) {
  repoCmd
    .command("delete <repoIdOrName>")
    .description("Permanently delete a Git Law repo (its bare git data and all PR history)")
    .option("-y, --yes", "skip the confirmation prompt")
    .action(async (repoIdOrName: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(
          `This permanently deletes "${repoIdOrName}" and all its history — this cannot be undone.\nType the repo name to confirm: `
        );
        rl.close();
        if (answer !== repoIdOrName) {
          console.log("Aborted — input did not match.");
          process.exitCode = 1;
          return;
        }
      }
      try {
        const repo = deleteRepo(repoIdOrName);
        console.log(`Deleted repo "${repo.name}" (id: ${repo.id}).`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
}
