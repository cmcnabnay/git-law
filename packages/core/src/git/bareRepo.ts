import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function createBareRepo(barePath: string, defaultBranch: string = "main"): void {
  fs.mkdirSync(path.dirname(barePath), { recursive: true });
  execFileSync("git", ["init", "--bare", "-b", defaultBranch, barePath]);
}

/**
 * Installs a dependency-free Node.js post-receive hook (no bash/curl) that
 * notifies the Git Law API of every ref update. The hook never fails the
 * push, even if the API is unreachable — it only logs a warning to stderr,
 * since a contract negotiation shouldn't be blocked by the review server
 * being down.
 */
export function installPostReceiveHook(barePath: string, repoId: string, apiBaseUrl: string): void {
  const hookPath = path.join(barePath, "hooks", "post-receive");
  const url = `${apiBaseUrl}/api/repos/${repoId}/hook-notify`;
  const script = `#!/usr/bin/env node
const http = require("node:http");

let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  const lines = input.trim().split("\\n").filter(Boolean);
  const requests = lines.map((line) => {
    const [oldSha, newSha, refname] = line.trim().split(" ");
    if (!refname || !refname.startsWith("refs/heads/")) return Promise.resolve();
    const branch = refname.slice("refs/heads/".length);
    const body = JSON.stringify({ branch, oldSha, newSha });
    return new Promise((resolve) => {
      const req = http.request(
        ${JSON.stringify(url)},
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => { res.resume(); resolve(); }
      );
      req.on("error", (err) => {
        process.stderr.write("gitlaw: warning - could not reach Git Law API (" + err.message + "); push succeeded but the PR may not have been registered.\\n");
        resolve();
      });
      req.write(body);
      req.end();
    });
  });
  Promise.all(requests).then(() => process.exit(0));
});
`;
  fs.writeFileSync(hookPath, script, { mode: 0o755 });
}

export function commitAuthorEmail(barePath: string, sha: string): string | null {
  try {
    const out = execFileSync("git", ["-C", barePath, "log", "-1", "--format=%ae", sha], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}
