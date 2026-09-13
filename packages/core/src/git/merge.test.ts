import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBareRepo } from "./bareRepo.js";
import { mergeBranchIntoMain } from "./merge.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

test("mergeBranchIntoMain replaces main's content with the branch's (theirs), then cleans up", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitlaw-merge-test-"));
  const barePath = path.join(tmp, "repo.git");
  createBareRepo(barePath, "main");

  const seedDir = path.join(tmp, "seed");
  git(tmp, "clone", barePath, seedDir);
  git(seedDir, "config", "user.email", "test@example.com");
  git(seedDir, "config", "user.name", "Test");

  fs.writeFileSync(path.join(seedDir, "file.txt"), "main content\n");
  git(seedDir, "add", "file.txt");
  git(seedDir, "commit", "-m", "main commit");
  git(seedDir, "push", "origin", "main");

  git(seedDir, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(seedDir, "file.txt"), "feature content\n");
  git(seedDir, "add", "file.txt");
  git(seedDir, "commit", "-m", "feature commit");
  git(seedDir, "push", "origin", "feature");

  const { mergeCommitSha } = await mergeBranchIntoMain(barePath, "feature", "main");
  assert.match(mergeCommitSha, /^[0-9a-f]{40}$/);

  const mainContent = execFileSync("git", ["-C", barePath, "show", "main:file.txt"], { encoding: "utf8" });
  assert.equal(mainContent, "feature content\n");

  const worktreeList = git(barePath, "worktree", "list", "--porcelain");
  assert.equal(worktreeList.trim().split("\n\n").length, 1, "no leftover worktrees after merge");

  fs.rmSync(tmp, { recursive: true, force: true });
});
