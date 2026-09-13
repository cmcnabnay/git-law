import { Command } from "commander";
import { reposRepo, participantsRepo, generatePassword } from "@gitlaw/core";

export function registerParticipantAdd(participantCmd: Command) {
  participantCmd
    .command("add <repoIdOrName> <displayName> <email>")
    .description("Register a participant (party) on a repo")
    .option(
      "--password <password>",
      "credential for git/API auth (default: a random one is generated and printed)"
    )
    .action((repoIdOrName: string, displayName: string, email: string, opts: { password?: string }) => {
      const repo = reposRepo.get(repoIdOrName) ?? reposRepo.findByName(repoIdOrName);
      if (!repo) {
        console.error(`No repo found matching "${repoIdOrName}"`);
        process.exitCode = 1;
        return;
      }
      const password = opts.password ?? generatePassword();
      participantsRepo.add({ repoId: repo.id, displayName, email, password });
      console.log(`Added ${displayName} <${email}> to "${repo.name}".`);
      console.log(`\nCredential for git clone/push and the API (shown once — it is not stored anywhere retrievable):`);
      console.log(`  username: ${email}`);
      console.log(`  password: ${password}`);
      console.log(`\nThey should also set their identity inside their own clone:`);
      console.log(`  git config user.email "${email}"`);
    });
}
