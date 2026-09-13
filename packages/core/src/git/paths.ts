import path from "node:path";
import { getReposDir } from "../config.js";

export function bareRepoPath(repoId: string): string {
  return path.join(getReposDir(), `${repoId}.git`);
}
