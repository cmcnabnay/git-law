import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GitLawConfig {
  dataDir: string;
  port: number;
  /** The URL other machines reach this server at (e.g. "http://34.204.201.203"
   * or a real domain) — used only to print working `git clone` commands.
   * Unset on a fresh local install, where localhost is the right default. */
  publicUrl?: string;
}

const DEFAULT_PORT = 4127;

export function getDataDir(): string {
  const override = process.env.GITLAW_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), ".git-law");
}

export function getReposDir(): string {
  return path.join(getDataDir(), "repos");
}

export function getDbPath(): string {
  return path.join(getDataDir(), "gitlaw.db");
}

export function getConfigPath(): string {
  return path.join(getDataDir(), "config.json");
}

export function loadConfig(): GitLawConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(`Git Law is not initialized at ${getDataDir()} — run "gitlaw init" first.`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

/** Re-running this on an already-initialized data dir is safe: an explicit
 * `publicUrl` updates the stored config (so it can be set after the fact,
 * once you know the server's public address), everything else about an
 * existing config is left untouched. */
export function initDataDir(port: number = DEFAULT_PORT, publicUrl?: string): GitLawConfig {
  const dataDir = getDataDir();
  fs.mkdirSync(getReposDir(), { recursive: true });
  const configPath = getConfigPath();
  let config: GitLawConfig;
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (publicUrl && publicUrl !== config.publicUrl) {
      config.publicUrl = publicUrl;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  } else {
    config = { dataDir, port, publicUrl };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  return config;
}

export function apiBaseUrl(config: GitLawConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

/** The URL to hand out for `git clone`/push — the configured public
 * address if set, otherwise localhost (the right default for a
 * single-machine dev install). */
export function repoCloneUrl(config: GitLawConfig, repoId: string): string {
  const base = (config.publicUrl ?? `http://localhost:${config.port}`).replace(/\/$/, "");
  return `${base}/repos/${repoId}.git`;
}
