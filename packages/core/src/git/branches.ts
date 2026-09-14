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

function mergeBase(barePath: string, a: string, b: string): string | null {
  try {
    return execFileSync("git", ["-C", barePath, "merge-base", a, b]).toString().trim();
  } catch {
    return null; // unrelated histories, or one side isn't a real commit
  }
}

function ancestorCount(barePath: string, sha: string): number {
  try {
    return parseInt(execFileSync("git", ["-C", barePath, "rev-list", "--count", sha]).toString().trim(), 10);
  } catch {
    return 0;
  }
}

/**
 * Finds which existing branch a newly-pushed branch was most likely created
 * from, so its PR can diff against that branch instead of always `main`.
 *
 * A candidate branch B qualifies if `pushedSha` is a descendant of B (B's
 * entire history is contained in it) — checked via `merge-base(pushedSha, B)
 * === B`. Both `main` and, say, an intermediate branch it was stacked on
 * will usually qualify at once, so among qualifiers this picks the deepest
 * one (most commits reachable from it) since that's the nearest, most
 * specific ancestor rather than the root.
 *
 * Falls back to `defaultBranch` (matching pre-feature behavior) whenever
 * nothing else qualifies — including when `pushedSha` isn't a real object in
 * this repo yet, which happens in tests that fake pushes with synthetic
 * shas; real pushes always land the object before the hook runs.
 */
export function detectParentBranch(
  barePath: string,
  pushedBranch: string,
  pushedSha: string,
  defaultBranch: string
): { branch: string; sha: string } {
  const fallback = { branch: defaultBranch, sha: branchHeadSha(barePath, defaultBranch) };

  let best: { branch: string; sha: string; depth: number } | null = null;
  for (const candidate of listBranches(barePath)) {
    if (candidate.name === pushedBranch || candidate.headSha === pushedSha) continue;
    const base = mergeBase(barePath, pushedSha, candidate.headSha);
    if (base !== candidate.headSha) continue;
    const depth = ancestorCount(barePath, candidate.headSha);
    if (!best || depth > best.depth) {
      best = { branch: candidate.name, sha: candidate.headSha, depth };
    }
  }

  return best ? { branch: best.branch, sha: best.sha } : fallback;
}
