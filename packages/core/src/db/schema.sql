CREATE TABLE IF NOT EXISTS repos (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  bare_path      TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS participants (
  id           TEXT PRIMARY KEY,
  repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'party',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_id, email)
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch        TEXT NOT NULL,
  target_branch TEXT NOT NULL DEFAULT 'main',
  status        TEXT NOT NULL DEFAULT 'open',
  title         TEXT,
  author_email  TEXT,
  turn_email    TEXT,
  head_sha      TEXT NOT NULL,
  base_sha      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Only one OPEN pull request per (repo, branch) — a push to a branch with an
-- open PR must update that row rather than create a duplicate. A merged or
-- rejected-and-since-superseded PR does not block a fresh one on the same
-- branch name (rejected PRs are flipped back to 'open' on a new push instead
-- of creating a new row, so in practice this only ever allows a new row once
-- the previous one reached 'merged').
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_open_branch
  ON pull_requests(repo_id, branch)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS pr_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id       TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  actor_email TEXT,
  sha         TEXT,
  comment     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pr_repo ON pull_requests(repo_id);
CREATE INDEX IF NOT EXISTS idx_events_pr ON pr_events(pr_id, created_at);
