import { execFileSync } from "node:child_process";

export interface TreeEntry {
  path: string;
  size: number;
}

/** Lists every file (recursively) at a given ref, with byte size. */
export function listTree(barePath: string, ref: string): TreeEntry[] {
  const out = execFileSync("git", ["-C", barePath, "ls-tree", "-r", "-l", ref]).toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // format: "<mode> <type> <sha>  <size>\t<path>"
      const match = line.match(/^\S+ \S+ \S+\s+(\d+|-)\t(.+)$/);
      if (!match) return null;
      return { path: match[2], size: match[1] === "-" ? 0 : Number(match[1]) };
    })
    .filter((entry): entry is TreeEntry => entry !== null);
}
