import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GitLawConfig {
  dataDir: string;
  port: number;
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

export function initDataDir(port: number = DEFAULT_PORT): GitLawConfig {
  const dataDir = getDataDir();
  fs.mkdirSync(getReposDir(), { recursive: true });
  const configPath = getConfigPath();
  let config: GitLawConfig;
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } else {
    config = { dataDir, port };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  return config;
}

export function apiBaseUrl(config: GitLawConfig): string {
  return `http://127.0.0.1:${config.port}`;
}
