import { customAlphabet } from "nanoid";
import fs from "node:fs";

// Alphanumeric only — repo ids end up in filesystem paths, URLs, and (via
// bareRepoPath) directory names, so avoid characters that are awkward in
// any of those contexts (e.g. a leading '-' from the default nanoid alphabet).
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);
import { reposRepo, participantsRepo, type Repo } from "./db/repositories.js";
import { createBareRepo, installPostReceiveHook } from "./git/bareRepo.js";
import { bareRepoPath } from "./git/paths.js";
import { apiBaseUrl, loadConfig } from "./config.js";

export interface CreateRepoInput {
  name: string;
  participants?: { displayName: string; email: string }[];
}

/** Shared by the CLI (in-process) and the server (behind REST) so repo
 * creation logic never diverges between the two callers. */
export function createRepo(input: CreateRepoInput): Repo {
  const id = nanoid(10);
  const barePath = bareRepoPath(id);

  createBareRepo(barePath);
  const repo = reposRepo.create({ id, name: input.name, barePath });

  const config = loadConfig();
  installPostReceiveHook(barePath, repo.id, apiBaseUrl(config));

  for (const p of input.participants ?? []) {
    participantsRepo.add({ repoId: repo.id, displayName: p.displayName, email: p.email });
  }

  return repo;
}

/** Permanently deletes a repo: its DB row (participants, pull requests, and
 * pr_events cascade via ON DELETE CASCADE) and its bare git repo on disk —
 * unrecoverable, there is no soft-delete/undo. */
export function deleteRepo(repoIdOrName: string): Repo {
  const repo = reposRepo.get(repoIdOrName) ?? reposRepo.findByName(repoIdOrName);
  if (!repo) throw new Error(`No repo found matching "${repoIdOrName}"`);
  reposRepo.delete(repo.id);
  fs.rmSync(repo.bare_path, { recursive: true, force: true });
  return repo;
}

export function repairHooks(): void {
  const config = loadConfig();
  for (const repo of reposRepo.list()) {
    installPostReceiveHook(repo.bare_path, repo.id, apiBaseUrl(config));
  }
}
