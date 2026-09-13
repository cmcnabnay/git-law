import { Command } from "commander";
import { createRepo, loadConfig, repoCloneUrl } from "@gitlaw/core";

function parseParticipant(spec: string): { displayName: string; email: string } {
  const match = spec.match(/^(.*)<(.+)>$/);
  if (!match) {
    throw new Error(`Invalid --participant "${spec}" — expected format: "Display Name <email>"`);
  }
  return { displayName: match[1].trim(), email: match[2].trim() };
}

export function registerRepoCreate(repoCmd: Command) {
  repoCmd
    .command("create <name>")
    .description("Create a new Git Law repo (a bare git repo acting as the remote)")
    .option(
      "--participant <spec...>",
      'a participant as "Display Name <email>" (repeatable)'
    )
    .action((name: string, opts: { participant?: string[] }) => {
      const participants = (opts.participant ?? []).map(parseParticipant);
      const repo = createRepo({ name, participants });
      const cloneUrl = repoCloneUrl(loadConfig(), repo.id);
      console.log(`Created repo "${repo.name}" (id: ${repo.id})`);
      console.log(`\nTo clone it:\n  git clone ${cloneUrl} ${repo.name}`);
      if (participants.length > 0) {
        console.log(`\nEach participant should set their identity inside their own clone, e.g.:`);
        for (const p of participants) {
          console.log(`  (as ${p.displayName}) git config user.email "${p.email}"`);
        }
      }
    });
}
