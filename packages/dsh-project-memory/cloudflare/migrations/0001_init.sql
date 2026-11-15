-- Initial D1 schema for the DSH project-memory shared backend.
-- All timestamps are Unix milliseconds. JSON columns store text.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  identity_source TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_note_at INTEGER,
  summary_version INTEGER NOT NULL DEFAULT 0,
  summary_updated_at INTEGER,
  summary_updated_by TEXT,
  summary_chars INTEGER NOT NULL DEFAULT 0,
  path_hints TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS notes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  author_role TEXT NOT NULL,
  author_id TEXT,
  machine_id TEXT NOT NULL,
  title TEXT NOT NULL,
  tags TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  project_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  chars INTEGER NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  client_op_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summary_versions (
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  chars INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  client_op_id TEXT NOT NULL,
  PRIMARY KEY (project_id, version)
);

CREATE INDEX IF NOT EXISTS idx_notes_project_seq ON notes (project_id, seq);
CREATE INDEX IF NOT EXISTS idx_notes_project_at ON notes (project_id, at);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects (updated_at);
