import { execFileSync } from "node:child_process";

export interface BranchInfo {
  name: string;
  headSha: string;
  lastCommitMessage: string;
  lastCommitAuthorEmail: string;
  lastCommitDate: string;
}

export function listBranches(barePath: string): BranchInfo[] {
  const out = execFileSync("git", [
    "-C",
    barePath,
    "for-each-ref",
    "--format=%(refname:short)|%(objectname)|%(committerdate:iso-strict)|%(authoremail:trim)|%(subject)",
    "refs/heads/",
  ]).toString();

  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, headSha, lastCommitDate, lastCommitAuthorEmail, ...rest] = line.split("|");
      return {
        name,
        headSha,
        lastCommitDate,
        lastCommitAuthorEmail,
        lastCommitMessage: rest.join("|"),
      };
    });
}

export function branchHeadSha(barePath: string, branch: string): string {
  return execFileSync("git", ["-C", barePath, "rev-parse", branch]).toString().trim();
}

export function branchExists(barePath: string, branch: string): boolean {
  try {
    branchHeadSha(barePath, branch);
    return true;
  } catch {
    return false;
  }
}
