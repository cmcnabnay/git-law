import { Command } from "commander";
import { reposRepo, participantsRepo } from "@gitlaw/core";

export function registerParticipantAdd(participantCmd: Command) {
  participantCmd
    .command("add <repoIdOrName> <displayName> <email>")
    .description("Register a participant (party) on a repo")
    .action((repoIdOrName: string, displayName: string, email: string) => {
      const repo = reposRepo.get(repoIdOrName) ?? reposRepo.findByName(repoIdOrName);
      if (!repo) {
        console.error(`No repo found matching "${repoIdOrName}"`);
        process.exitCode = 1;
        return;
      }
      participantsRepo.add({ repoId: repo.id, displayName, email });
      console.log(`Added ${displayName} <${email}> to "${repo.name}".`);
      console.log(`They should run this inside their own clone of the repo:`);
      console.log(`  git config user.email "${email}"`);
    });
}
