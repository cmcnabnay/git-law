import { execFileSync } from "node:child_process";

/**
 * The list of changed paths only — using git's tree-level diff, not its
 * content diff (which is meaningless for binary .docx files). Content
 * diffing happens separately in the diff/ module.
 */
export function changedFiles(barePath: string, baseSha: string, headSha: string): string[] {
  const out = execFileSync("git", [
    "-C",
    barePath,
    "diff",
    "--name-only",
    `${baseSha}..${headSha}`,
  ]).toString();
  return out.split("\n").filter(Boolean);
}
