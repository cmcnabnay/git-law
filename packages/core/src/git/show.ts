import { execFileSync } from "node:child_process";

export function readBlob(barePath: string, rev: string, filePath: string): Buffer {
  return execFileSync("git", ["-C", barePath, "show", `${rev}:${filePath}`], {
    maxBuffer: 1024 * 1024 * 50,
  });
}

export function revParse(barePath: string, ref: string): string {
  return execFileSync("git", ["-C", barePath, "rev-parse", ref]).toString().trim();
}
