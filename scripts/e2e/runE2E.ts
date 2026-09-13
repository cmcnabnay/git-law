/**
 * End-to-end acceptance test for Git Law's core workflow, run against a
 * scratch GITLAW_HOME so it never touches a real ~/.git-law. Exercises the
 * full loop: initial push, branch+push -> auto-created PR, redline diff,
 * approve -> merge (-X theirs), and reject -> re-edit-same-branch -> same
 * PR re-opened.
 *
 * Run with: npm run e2e
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { genFixture } from "./fixtures/genDocx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const PORT = 4599;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gitlaw-e2e-"));

const env = { ...process.env, GITLAW_HOME: HOME };
const tsx = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const cliEntry = path.join(REPO_ROOT, "packages", "cli", "src", "bin.ts");

function gitlaw(...args: string[]): string {
  return execFileSync(tsx, [cliEntry, ...args], { env, encoding: "utf8" });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy in time");
}

async function waitForOpenPr(repoId: string, branch: string): Promise<any> {
  for (let i = 0; i < 50; i++) {
    const prs = await apiGet(`/api/repos/${repoId}/prs`);
    const pr = prs.find((p: any) => p.branch === branch);
    if (pr) return pr;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`PR for branch ${branch} never appeared`);
}

let server: ChildProcess | undefined;

async function main() {
  console.log(`[e2e] GITLAW_HOME=${HOME}`);

  gitlaw("init", "--port", String(PORT));

  const createOut = gitlaw(
    "repo",
    "create",
    "nda",
    "--participant",
    "Alice <alice@example.com>",
    "--participant",
    "Bob <bob@example.com>"
  );
  const repoIdMatch = createOut.match(/id: (\w+)/);
  assert.ok(repoIdMatch, "expected repo id in create output");
  const repoId = repoIdMatch![1];
  const barePathMatch = createOut.match(/git clone (\S+) nda/);
  const barePath = barePathMatch![1];
  console.log(`[e2e] created repo ${repoId} at ${barePath}`);

  server = spawn(tsx, [cliEntry, "serve"], { env, stdio: "inherit" });
  await waitForHealth();
  console.log("[e2e] server healthy");

  const aliceDir = path.join(HOME, "workdir-alice");
  const bobDir = path.join(HOME, "workdir-bob");

  // --- Party 1 (Alice): initial push to main ---
  git(HOME, "clone", barePath, aliceDir);
  git(aliceDir, "config", "user.email", "alice@example.com");
  git(aliceDir, "config", "user.name", "Alice");
  await genFixture(path.join(aliceDir, "contract.docx"), [
    "This agreement is between Party A and Party B.",
    "The term of this agreement is one year.",
  ]);
  git(aliceDir, "add", "contract.docx");
  git(aliceDir, "commit", "-m", "initial draft");
  git(aliceDir, "push", "origin", "main");

  let prs = await apiGet(`/api/repos/${repoId}/prs`);
  assert.equal(prs.length, 0, "pushing to main must not create a PR");
  console.log("[e2e] initial push to main created no PR (expected)");

  // --- Party 2 (Bob): branch, edit, push ---
  git(HOME, "clone", barePath, bobDir);
  git(bobDir, "config", "user.email", "bob@example.com");
  git(bobDir, "config", "user.name", "Bob");
  git(bobDir, "checkout", "-b", "party2-edits");
  await genFixture(path.join(bobDir, "contract.docx"), [
    "This agreement is between Party A and Party B.",
    "The term of this agreement is TWO years.",
    "Party B shall pay a deposit of $500.",
  ]);
  git(bobDir, "add", "contract.docx");
  git(bobDir, "commit", "-m", "propose changes");
  git(bobDir, "push", "origin", "party2-edits");

  const pr1 = await waitForOpenPr(repoId, "party2-edits");
  console.log(`[e2e] PR auto-created for party2-edits: ${pr1.id}`);
  assert.equal(pr1.status, "open");

  const detail1 = await apiGet(`/api/repos/${repoId}/prs/${pr1.id}`);
  const redline1 = detail1.diffs[0].redline;
  const addedText = redline1.changes.filter((c: any) => c.added).map((c: any) => c.value).join("");
  const removedText = redline1.changes.filter((c: any) => c.removed).map((c: any) => c.value).join("");
  assert.match(addedText, /TWO/);
  assert.match(addedText, /deposit of \$500/);
  assert.match(removedText, /one/);
  console.log("[e2e] redline diff contains expected additions/removals");

  // --- Approve: merge should take Bob's content via -X theirs ---
  const approved = await apiPost(`/api/repos/${repoId}/prs/${pr1.id}/approve`, {
    actorEmail: "alice@example.com",
  });
  assert.equal(approved.status, "merged");
  // Compare raw bytes (not the text-decoding `git()` helper) since .docx is binary.
  const mainContent = execFileSync("git", ["-C", barePath, "show", "main:contract.docx"]);
  const bobContent = fs.readFileSync(path.join(bobDir, "contract.docx"));
  assert.ok(mainContent.equals(bobContent), "main must now byte-equal Bob's approved version");
  console.log("[e2e] approve merged branch into main (content matches)");

  // --- Reject-then-reedit loop on a second branch ---
  git(bobDir, "checkout", "-b", "party2-edits-2");
  await genFixture(path.join(bobDir, "contract.docx"), [
    "This agreement is between Party A and Party B.",
    "The term of this agreement is TWO years.",
    "Party B shall pay a deposit of $500.",
    "Party B may terminate with 30 days notice.",
  ]);
  git(bobDir, "add", "contract.docx");
  git(bobDir, "commit", "-m", "add termination clause");
  git(bobDir, "push", "origin", "party2-edits-2");

  const pr2 = await waitForOpenPr(repoId, "party2-edits-2");
  const rejected = await apiPost(`/api/repos/${repoId}/prs/${pr2.id}/reject`, {
    actorEmail: "alice@example.com",
    comment: "30 days is too short, needs to be 60.",
  });
  assert.equal(rejected.status, "rejected");
  console.log("[e2e] PR rejected with comment");

  git(aliceDir, "fetch", "origin", "party2-edits-2:party2-edits-2");
  git(aliceDir, "checkout", "party2-edits-2");
  await genFixture(path.join(aliceDir, "contract.docx"), [
    "This agreement is between Party A and Party B.",
    "The term of this agreement is TWO years.",
    "Party B shall pay a deposit of $500.",
    "Party B may terminate with 60 days notice.",
  ]);
  git(aliceDir, "add", "contract.docx");
  git(aliceDir, "commit", "-m", "counter: 60 days notice");
  git(aliceDir, "push", "origin", "party2-edits-2");

  // Poll until the existing PR flips back to open (not a new row).
  let reopened: any;
  for (let i = 0; i < 50; i++) {
    reopened = await apiGet(`/api/repos/${repoId}/prs/${pr2.id}`);
    if (reopened.pr.status === "open") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(reopened.pr.status, "open", "rejected PR must flip back to open on new push");
  assert.equal(reopened.pr.id, pr2.id, "must be the same PR id, not a duplicate");

  const allPrsForBranch = (await apiGet(`/api/repos/${repoId}/prs`)).filter(
    (p: any) => p.branch === "party2-edits-2"
  );
  assert.equal(allPrsForBranch.length, 1, "no duplicate PR row for the same branch");

  const eventTypes = reopened.events.map((e: any) => e.type);
  assert.deepEqual(eventTypes, ["created", "rejected", "pushed"]);
  console.log("[e2e] reject -> re-edit -> same PR re-opened, event log correct");

  console.log("\n[e2e] ALL CHECKS PASSED");
}

main()
  .catch((err) => {
    console.error("[e2e] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    server?.kill();
  });
