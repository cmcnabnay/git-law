import { execFileSync } from "node:child_process";

export interface TreeEntry {
  path: string;
  size: number;
  /** The most recent commit that touched this path — empty if none is
   * found (shouldn't happen for a path that's actually in the tree, but
   * defensive since history parsing is best-effort text scraping). */
  lastCommitSha: string;
  lastCommitMessage: string;
  lastCommitDate: string;
}

const RECORD_SEP = "\x01";
const FIELD_SEP = "\x02";

interface CommitTouch {
  sha: string;
  date: string;
  message: string;
  files: string[];
}

/** One pass over `ref`'s full history, each commit paired with the paths it
 * changed — so attributing "last touched by" to every file in the tree is
 * a single `git log`, not one process spawn per file. */
function commitHistory(barePath: string, ref: string): CommitTouch[] {
  const out = execFileSync(
    "git",
    ["-C", barePath, "log", `--format=${RECORD_SEP}%H${FIELD_SEP}%cI${FIELD_SEP}%s`, "--name-only", ref],
    { maxBuffer: 1024 * 1024 * 50 }
  ).toString();

  return out
    .split(RECORD_SEP)
    .filter(Boolean)
    .map((block) => {
      const [header, ...rest] = block.split("\n");
      const [sha, date, message] = header.split(FIELD_SEP);
      return { sha, date, message, files: rest.map((l) => l.trim()).filter(Boolean) };
    });
}

/** Lists every file (recursively) at a given ref, with byte size and the
 * most recent commit that touched each path — like GitHub's file browser. */
export function listTree(barePath: string, ref: string): TreeEntry[] {
  const out = execFileSync("git", ["-C", barePath, "ls-tree", "-r", "-l", ref]).toString();
  const entries = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // format: "<mode> <type> <sha>  <size>\t<path>"
      const match = line.match(/^\S+ \S+ \S+\s+(\d+|-)\t(.+)$/);
      if (!match) return null;
      return { path: match[2], size: match[1] === "-" ? 0 : Number(match[1]) };
    })
    .filter((entry): entry is { path: string; size: number } => entry !== null);

  const lastTouch = new Map<string, Omit<CommitTouch, "files">>();
  for (const commit of commitHistory(barePath, ref)) {
    for (const file of commit.files) {
      if (!lastTouch.has(file)) lastTouch.set(file, commit);
    }
  }

  return entries.map((e) => {
    const touch = lastTouch.get(e.path);
    return {
      ...e,
      lastCommitSha: touch?.sha ?? "",
      lastCommitMessage: touch?.message ?? "",
      lastCommitDate: touch?.date ?? "",
    };
  });
}
