import { Command } from "commander";
import { reposRepo, prRepo } from "@gitlaw/core";

export function registerRepoList(repoCmd: Command) {
  repoCmd
    .command("list")
    .description("List Git Law repos")
    .action(() => {
      const repos = reposRepo.list();
      if (repos.length === 0) {
        console.log("No repos yet — create one with `gitlaw repo create <name>`.");
        return;
      }
      for (const repo of repos) {
        const openPrs = prRepo.listForRepo(repo.id, "open").length;
        console.log(`${repo.name}  (id: ${repo.id}, ${openPrs} open PR${openPrs === 1 ? "" : "s"})`);
        console.log(`  ${repo.bare_path}`);
      }
    });
}
