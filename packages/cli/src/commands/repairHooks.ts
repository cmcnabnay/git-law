import { Command } from "commander";
import { repairHooks } from "@gitlaw/core";

export function registerRepairHooks(program: Command) {
  program
    .command("repair-hooks")
    .description("Reinstall the post-receive hook on every repo against the current config port")
    .action(() => {
      repairHooks();
      console.log("Hooks reinstalled.");
    });
}
