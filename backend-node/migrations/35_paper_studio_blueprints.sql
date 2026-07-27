-- Paper Studio Phase 1: editable, versioned production blueprints.

CREATE TABLE IF NOT EXISTS paper_blueprint_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  paper_storyboard_revision_id INTEGER,
  revision_number INTEGER NOT NULL,
  source_revision_hash TEXT NOT NULL,
  blueprint_json TEXT NOT NULL,
  blueprint_hash TEXT NOT NULL,
  compiled_plan_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_from TEXT NOT NULL DEFAULT 'analysis',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  superseded_at TEXT,
  UNIQUE(shot_id, revision_number),
  UNIQUE(shot_id, blueprint_hash)
);

CREATE TABLE IF NOT EXISTS paper_storyboard_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  paper_storyboard_id INTEGER,
  paper_storyboard_revision_id INTEGER,
  blueprint_revision_id INTEGER NOT NULL,
  entity_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'subject',
  identity_version_id INTEGER,
  source_library_type TEXT,
  source_library_id INTEGER,
  independent_layer INTEGER NOT NULL DEFAULT 1,
  reusable INTEGER NOT NULL DEFAULT 0,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(blueprint_revision_id, entity_key)
);

CREATE TABLE IF NOT EXISTS paper_action_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  paper_storyboard_revision_id INTEGER,
  blueprint_revision_id INTEGER NOT NULL,
  contract_json TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  superseded_at TEXT,
  UNIQUE(blueprint_revision_id)
);

ALTER TABLE paper_studio_shots ADD COLUMN blueprint_revision_id INTEGER;
ALTER TABLE paper_studio_shots ADD COLUMN action_contract_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_paper_blueprint_revisions_shot
  ON paper_blueprint_revisions(shot_id, revision_number DESC, status);
CREATE INDEX IF NOT EXISTS idx_paper_storyboard_entities_blueprint
  ON paper_storyboard_entities(blueprint_revision_id, entity_type, entity_key);
CREATE INDEX IF NOT EXISTS idx_paper_action_contracts_shot
  ON paper_action_contracts(shot_id, status, created_at DESC);
