import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { getDbPath, initDataDir } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

// schema.sql's CREATE TABLE IF NOT EXISTS only shapes brand-new databases —
// a database file created before a column was added needs it bolted on
// explicitly. Add one guarded ALTER TABLE per such column here.
function migrate(database: Database.Database): void {
  const participantColumns = database.prepare(`PRAGMA table_info(participants)`).all() as { name: string }[];
  if (!participantColumns.some((c) => c.name === "password_hash")) {
    database.exec(`ALTER TABLE participants ADD COLUMN password_hash TEXT`);
  }

  const prColumns = database.prepare(`PRAGMA table_info(pull_requests)`).all() as { name: string }[];
  if (!prColumns.some((c) => c.name === "base_branch")) {
    database.exec(`ALTER TABLE pull_requests ADD COLUMN base_branch TEXT`);
  }
}

export function getDb(): Database.Database {
  if (db) return db;
  initDataDir();
  const dbPath = getDbPath();
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  migrate(db);
  return db;
}

export function resetDbForTests(): void {
  if (db) {
    db.close();
    db = null;
  }
}
