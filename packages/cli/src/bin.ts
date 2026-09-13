#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerRepoCreate } from "./commands/repoCreate.js";
import { registerRepoList } from "./commands/repoList.js";
import { registerParticipantAdd } from "./commands/participantAdd.js";
import { registerServe } from "./commands/serve.js";
import { registerRepairHooks } from "./commands/repairHooks.js";

const program = new Command();
program.name("gitlaw").description("GitHub-style version control for contract documents");

const repoCmd = program.command("repo").description("Manage Git Law repos");
const participantCmd = program.command("participant").description("Manage repo participants");

registerInit(program);
registerRepoCreate(repoCmd);
registerRepoList(repoCmd);
registerParticipantAdd(participantCmd);
registerServe(program);
registerRepairHooks(program);

program.parse(process.argv);
