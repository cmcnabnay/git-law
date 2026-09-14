import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitlaw-prservice-test-"));
process.env.GITLAW_HOME = tmp;

const { initDataDir } = await import("../config.js");
const { createRepo } = await import("../repoService.js");
const { participantsRepo, prRepo } = await import("../db/repositories.js");
const { createOrUpdatePr, rejectPr } = await import("./prService.js");

initDataDir(4600);

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Seeds an initial commit on `main` via plumbing (no working tree needed),
 * matching every real repo's state after Party 1's first push. */
function seedMain(barePath: string): void {
  const commitSha = execFileSync(
    "git",
    ["-C", barePath, "commit-tree", EMPTY_TREE_SHA, "-m", "seed"],
    { encoding: "utf8" }
  ).trim();
  execFileSync("git", ["-C", barePath, "update-ref", "refs/heads/main", commitSha]);
}

test("push to a branch with no PR creates one; a second push to the same branch updates it", () => {
  const repo = createRepo({ name: "test-repo" });
  seedMain(repo.bare_path);
  participantsRepo.add({ repoId: repo.id, displayName: "Alice", email: "alice@example.com" });
  participantsRepo.add({ repoId: repo.id, displayName: "Bob", email: "bob@example.com" });

  const created = createOrUpdatePr(repo.id, "feature", "a".repeat(40));
  assert.ok(created);
  assert.equal(created!.status, "open");

  const allForBranch1 = prRepo.listForRepo(repo.id).filter((p) => p.branch === "feature");
  assert.equal(allForBranch1.length, 1);

  const updated = createOrUpdatePr(repo.id, "feature", "b".repeat(40));
  assert.equal(updated!.id, created!.id, "second push must update the same PR");
  assert.equal(updated!.head_sha, "b".repeat(40));

  const allForBranch2 = prRepo.listForRepo(repo.id).filter((p) => p.branch === "feature");
  assert.equal(allForBranch2.length, 1, "still exactly one PR row for the branch");
});

test("a rejected PR flips back to open (not duplicated) on the next push", () => {
  const repo = createRepo({ name: "test-repo-2" });
  seedMain(repo.bare_path);
  const pr = createOrUpdatePr(repo.id, "feature", "c".repeat(40))!;
  rejectPr(pr.id, "alice@example.com", "needs work");
  assert.equal(prRepo.get(pr.id)!.status, "rejected");

  const reopened = createOrUpdatePr(repo.id, "feature", "d".repeat(40));
  assert.equal(reopened!.id, pr.id);
  assert.equal(reopened!.status, "open");

  const allForBranch = prRepo.listForRepo(repo.id).filter((p) => p.branch === "feature");
  assert.equal(allForBranch.length, 1);
});

test("deleting a branch (all-zero sha) closes its open PR instead of corrupting head_sha", () => {
  const repo = createRepo({ name: "test-repo-4" });
  seedMain(repo.bare_path);
  const pr = createOrUpdatePr(repo.id, "feature", "f".repeat(40))!;

  const zeroSha = "0".repeat(40);
  const closed = createOrUpdatePr(repo.id, "feature", zeroSha);
  assert.equal(closed!.id, pr.id);
  assert.equal(closed!.status, "closed");
  assert.equal(closed!.head_sha, "f".repeat(40), "head_sha must keep the last real commit, not the zero sha");

  const allForBranch = prRepo.listForRepo(repo.id).filter((p) => p.branch === "feature");
  assert.equal(allForBranch.length, 1);
});

test("deleting a branch that never had a PR is a no-op", () => {
  const repo = createRepo({ name: "test-repo-5" });
  seedMain(repo.bare_path);
  const result = createOrUpdatePr(repo.id, "never-pushed", "0".repeat(40));
  assert.equal(result, null);
  assert.equal(prRepo.listForRepo(repo.id).length, 0);
});

test("a branch stacked on another branch diffs against that branch, not main", () => {
  const repo = createRepo({ name: "test-repo-6" });
  seedMain(repo.bare_path);

  const mainSha = execFileSync("git", ["-C", repo.bare_path, "rev-parse", "main"], { encoding: "utf8" }).trim();

  const buyersSha = execFileSync(
    "git",
    ["-C", repo.bare_path, "commit-tree", EMPTY_TREE_SHA, "-p", mainSha, "-m", "buyers edit"],
    { encoding: "utf8" }
  ).trim();
  execFileSync("git", ["-C", repo.bare_path, "update-ref", "refs/heads/buyers_changes_1", buyersSha]);
  const buyersPr = createOrUpdatePr(repo.id, "buyers_changes_1", buyersSha)!;
  assert.equal(buyersPr.base_sha, mainSha, "first branch off main diffs against main");
  assert.equal(buyersPr.base_branch, "main");

  const sellersSha = execFileSync(
    "git",
    ["-C", repo.bare_path, "commit-tree", EMPTY_TREE_SHA, "-p", buyersSha, "-m", "sellers edit"],
    { encoding: "utf8" }
  ).trim();
  execFileSync("git", ["-C", repo.bare_path, "update-ref", "refs/heads/sellers_changes_1", sellersSha]);
  const sellersPr = createOrUpdatePr(repo.id, "sellers_changes_1", sellersSha)!;
  assert.equal(sellersPr.base_sha, buyersSha, "branch stacked on buyers_changes_1 diffs against it, not main");
  assert.equal(sellersPr.base_branch, "buyers_changes_1");
  assert.equal(sellersPr.target_branch, "main", "still merges into main regardless of diff base");
});

test("push to the default branch never creates a PR", () => {
  const repo = createRepo({ name: "test-repo-3" });
  const result = createOrUpdatePr(repo.id, repo.default_branch, "e".repeat(40));
  assert.equal(result, null);
  assert.equal(prRepo.listForRepo(repo.id).length, 0);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
