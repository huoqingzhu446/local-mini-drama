const fs = require('fs');
const path = require('path');
const { getDb } = require('./index.js');
const { loadConfig } = require('../config/index.js');

function stripLeadingComments(sql) {
  return sql
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('--');
    })
    .join('\n')
    .trim();
}

function runOne(database, sql, file, index) {
  const s = stripLeadingComments(sql);
  if (!s) return;
  try {
    database.exec(s);
    console.log('Ran migration:', file + (index >= 0 ? ' #' + (index + 1) : ''));
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    if (err.code === 'SQLITE_ERROR' && (msg.includes('duplicate column') || msg.includes('already exists'))) {
      console.log('Skip (already exists):', file + (index >= 0 ? ' #' + (index + 1) : ''));
    } else if (err.code === 'SQLITE_ERROR' && (
      msg.includes('no such table')
      || (file === '42_paper_studio_generation_attempt_ledger.sql' && msg.includes('no such column'))
    )) {
      // Legacy partial schemas are completed by ensureAllColumns below. Index
      // creation is replayed after those columns exist.
      console.warn('Skip migration (schema dependency will be ensured later):', file, '-', err.message);
    } else {
      throw err;
    }
  }
}

function runMigrations(database) {
  const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.log('Migrations dir missing, skipping:', migrationsDir);
    return;
  }
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    // Migration 45 includes schema, backfill and integrity assertions that
    // must commit as one unit. It is applied only by the dedicated reviewed
    // executor, never by this per-statement compatibility runner.
    if (file === '45_paper_storyboard_history_fork.sql') continue;
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (statements.length <= 1) {
      runOne(database, sql, file, -1);
    } else {
      statements.forEach((stmt, i) => runOne(database, stmt + ';', file, i));
    }
  }
}

function ensurePaperHistoryForkSchema(database) {
  const migrationId = '45_paper_storyboard_history_fork';
  const migrationPath = path.join(__dirname, '..', '..', 'migrations', `${migrationId}.sql`);
  if (!fs.existsSync(migrationPath)) throw new Error(`Migration definition missing: ${migrationPath}`);
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  if (!tables.has('paper_storyboards') || !tables.has('paper_storyboard_revisions')) {
    throw new Error('Migration 45 requires paper_storyboards and paper_storyboard_revisions');
  }
  let report;
  database.transaction(() => {
    const storyboardColumns = tableColumns(database, 'paper_storyboards');
    if (!storyboardColumns.has('working_copy_base_revision_id')) {
      database.exec('ALTER TABLE paper_storyboards ADD COLUMN working_copy_base_revision_id INTEGER');
    }
    if (!storyboardColumns.has('working_copy_fork_audit_id')) {
      database.exec('ALTER TABLE paper_storyboards ADD COLUMN working_copy_fork_audit_id INTEGER');
    }

    const sql = fs.readFileSync(migrationPath, 'utf8');
    for (const raw of sql.split(';').map((statement) => statement.trim()).filter(Boolean)) {
      const statement = stripLeadingComments(raw);
      if (!/^CREATE\s+(?:TABLE|INDEX)/i.test(statement)) continue;
      database.exec(`${statement};`);
    }

    database.prepare(
      `UPDATE paper_storyboards
       SET working_copy_base_revision_id = current_revision_id
       WHERE working_copy_base_revision_id IS NULL AND current_revision_id IS NOT NULL`,
    ).run();

    const missingBase = Number(database.prepare(
      `SELECT COUNT(*) AS count FROM paper_storyboards
       WHERE deleted_at IS NULL AND current_revision_id IS NOT NULL
         AND working_copy_base_revision_id IS NULL`,
    ).get().count || 0);
    const crossStoryboardBase = Number(database.prepare(
      `SELECT COUNT(*) AS count
       FROM paper_storyboards ps
       LEFT JOIN paper_storyboard_revisions psr
         ON psr.id = ps.working_copy_base_revision_id
        AND psr.paper_storyboard_id = ps.id
       WHERE ps.working_copy_base_revision_id IS NOT NULL AND psr.id IS NULL`,
    ).get().count || 0);
    if (missingBase || crossStoryboardBase) {
      throw new Error(`Migration 45 integrity failed: missing_base=${missingBase}, cross_storyboard_base=${crossStoryboardBase}`);
    }
    const appliedAt = new Date().toISOString();
    const storyboardCount = Number(database.prepare('SELECT COUNT(*) AS count FROM paper_storyboards').get().count || 0);
    const details = {
      storyboard_count: storyboardCount,
      missing_working_copy_base: missingBase,
      cross_storyboard_base: crossStoryboardBase,
    };
    database.prepare(
      `INSERT INTO paper_schema_migrations (migration_id, applied_at, details_json)
       VALUES (?, ?, ?)
       ON CONFLICT(migration_id) DO UPDATE SET details_json = excluded.details_json`,
    ).run(migrationId, appliedAt, JSON.stringify(details));
    report = { migration_id: migrationId, applied_at: appliedAt, ...details };
  })();
  return report;
}

/**
 * 通用：确保某张表存在指定列，不存在则 ALTER TABLE ADD COLUMN。
 * @param {object} database - better-sqlite3 实例
 * @param {string} table - 表名
 * @param {Array<{name:string, type:string}>} columns - 要确保存在的列
 */
function ensureColumns(database, table, columns) {
  let existing;
  try {
    existing = database.prepare(`PRAGMA table_info(${table})`).all();
  } catch (err) {
    if ((err.message || '').toLowerCase().includes('no such table')) {
      console.log(`ensureColumns: table ${table} not found, skip`);
      return;
    }
    throw err;
  }
  const names = new Set(existing.map((r) => r.name));
  for (const col of columns) {
    if (names.has(col.name)) continue;
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`);
      console.log(`ensureColumns: added ${table}.${col.name} (${col.type})`);
    } catch (e) {
      if ((e.message || '').toLowerCase().includes('duplicate column')) {
        // already exists (race / concurrent)
      } else {
        console.warn(`ensureColumns: failed to add ${table}.${col.name}:`, e.message);
      }
    }
  }
}

// A few legacy desktop databases were created without running every SQL
// migration (for example, when an update was interrupted).  Keep the paper
// tables self-healing in the same way as the older business tables.  We only
// replay CREATE statements here; ALTER statements are handled by the normal
// migration runner/ensureColumns path and remain idempotent.
function ensureMigrationCreateStatements(database, filename) {
  const migrationPath = path.join(__dirname, '..', '..', 'migrations', filename);
  if (!fs.existsSync(migrationPath)) return;
  const sql = fs.readFileSync(migrationPath, 'utf8');
  for (const rawStatement of sql.split(';').map((item) => item.trim()).filter(Boolean)) {
    const statement = stripLeadingComments(rawStatement);
    if (!/^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)/i.test(statement)) continue;
    try { database.exec(`${statement};`); } catch (err) {
      console.warn(`ensureMigrationCreateStatements: failed ${filename}:`, err.message);
    }
  }
}

function ensurePaperTables(database) {
  ensureMigrationCreateStatements(database, '30_paper_layer_animation.sql');
}

function ensurePaperStudioTables(database) {
  ensureMigrationCreateStatements(database, '31_paper_studio_v3.sql');
  ensureMigrationCreateStatements(database, '32_paper_studio_motion_continuity.sql');
  ensureMigrationCreateStatements(database, '33_paper_studio_independent_authoring.sql');
  ensureMigrationCreateStatements(database, '34_paper_studio_business_ux_phase0.sql');
  ensureMigrationCreateStatements(database, '39_paper_studio_audio_delivery.sql');
  ensureMigrationCreateStatements(database, '40_paper_studio_product_experience.sql');
  ensureMigrationCreateStatements(database, '44_paper_studio_plan_history_reuse.sql');
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function uniqueIndexColumns(database, table) {
  return database.prepare(`PRAGMA index_list(${table})`).all()
    .filter((index) => Number(index.unique) === 1)
    .map((index) => database.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all().map((column) => column.name));
}

function hasUniqueColumns(database, table, expected) {
  return uniqueIndexColumns(database, table).some((columns) => (
    columns.length === expected.length && columns.every((column, index) => column === expected[index])
  ));
}

function ensureInitialPlanRevisions(database) {
  const shots = database.prepare(
    `SELECT id, blueprint_revision_id, current_plan_revision_id, plan_summary_json,
            status, created_at, updated_at
     FROM paper_studio_shots`,
  ).all();
  const insert = database.prepare(
    `INSERT INTO paper_plan_revisions
      (shot_id, revision_number, blueprint_revision_id, plan_hash, status,
       transition_report_json, created_from, created_at, confirmed_at)
     VALUES (?, 1, ?, ?, ?, '{}', 'migration_44', ?, ?)`,
  );
  const updateShot = database.prepare(
    'UPDATE paper_studio_shots SET current_plan_revision_id = ? WHERE id = ?',
  );
  for (const shot of shots) {
    if (shot.current_plan_revision_id) continue;
    const existing = database.prepare(
      'SELECT id FROM paper_plan_revisions WHERE shot_id = ? ORDER BY revision_number DESC, id DESC LIMIT 1',
    ).get(Number(shot.id));
    let revisionId = existing?.id == null ? null : Number(existing.id);
    if (!revisionId) {
      let summary = {};
      try { summary = JSON.parse(shot.plan_summary_json || '{}'); } catch (_) { summary = {}; }
      const fallbackHash = require('crypto').createHash('sha256')
        .update(JSON.stringify({ shot_id: Number(shot.id), summary }))
        .digest('hex');
      const planHash = String(summary.plan_hash || fallbackHash);
      const confirmed = !['pending', 'analyzed'].includes(String(shot.status || ''));
      const result = insert.run(
        Number(shot.id),
        shot.blueprint_revision_id == null ? null : Number(shot.blueprint_revision_id),
        planHash,
        confirmed ? 'confirmed' : 'draft',
        shot.created_at || shot.updated_at || new Date().toISOString(),
        confirmed ? (shot.updated_at || shot.created_at || new Date().toISOString()) : null,
      );
      revisionId = Number(result.lastInsertRowid);
    }
    updateShot.run(revisionId, Number(shot.id));
  }
  database.prepare(
    `UPDATE paper_source_families
     SET plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = paper_source_families.shot_id)
     WHERE plan_revision_id IS NULL`,
  ).run();
  database.prepare(
    `UPDATE paper_composition_nodes
     SET plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = paper_composition_nodes.shot_id)
     WHERE plan_revision_id IS NULL`,
  ).run();
  database.prepare(
    `UPDATE paper_motion_plans
     SET plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = paper_motion_plans.shot_id)
     WHERE plan_revision_id IS NULL`,
  ).run();
  database.prepare(
    `UPDATE paper_job_steps
     SET plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = paper_job_steps.shot_id)
     WHERE shot_id IS NOT NULL AND plan_revision_id IS NULL`,
  ).run();
}

function rebuildPlanOwnedTables(database) {
  const rebuildFamilies = !hasUniqueColumns(database, 'paper_source_families', ['plan_revision_id', 'family_key']);
  const rebuildNodes = !hasUniqueColumns(database, 'paper_composition_nodes', ['plan_revision_id', 'node_key']);
  const rebuildMotion = !hasUniqueColumns(database, 'paper_motion_plans', ['plan_revision_id']);
  if (!rebuildFamilies && !rebuildNodes && !rebuildMotion) return;
  database.transaction(() => {
    if (rebuildFamilies) {
      database.exec('ALTER TABLE paper_source_families RENAME TO paper_source_families_h44_legacy');
      database.exec(`CREATE TABLE paper_source_families (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shot_id INTEGER NOT NULL,
        plan_revision_id INTEGER NOT NULL,
        family_key TEXT NOT NULL,
        pattern TEXT NOT NULL,
        registration_canvas_json TEXT NOT NULL DEFAULT '{}',
        contract_json TEXT NOT NULL DEFAULT '{}',
        layout_master_version_id INTEGER,
        context_snapshot_id TEXT,
        provider_signature TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(plan_revision_id, family_key)
      )`);
      database.exec(`INSERT INTO paper_source_families
        SELECT id, shot_id, plan_revision_id, family_key, pattern,
               registration_canvas_json, contract_json, layout_master_version_id,
               context_snapshot_id, provider_signature, status, version,
               created_at, updated_at, deleted_at
        FROM paper_source_families_h44_legacy`);
      database.exec('DROP TABLE paper_source_families_h44_legacy');
      database.exec('CREATE INDEX idx_paper_source_families_shot ON paper_source_families(shot_id, plan_revision_id, status)');
    }
    if (rebuildNodes) {
      database.exec('ALTER TABLE paper_composition_nodes RENAME TO paper_composition_nodes_h44_legacy');
      database.exec(`CREATE TABLE paper_composition_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shot_id INTEGER NOT NULL,
        plan_revision_id INTEGER NOT NULL,
        node_key TEXT NOT NULL,
        parent_node_id INTEGER,
        node_kind TEXT NOT NULL,
        pattern TEXT,
        slot TEXT,
        asset_version_id INTEGER,
        transform_json TEXT NOT NULL DEFAULT '{}',
        relation_json TEXT NOT NULL DEFAULT '{}',
        clip_json TEXT NOT NULL DEFAULT '{}',
        local_z INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(plan_revision_id, node_key)
      )`);
      database.exec(`INSERT INTO paper_composition_nodes
        SELECT id, shot_id, plan_revision_id, node_key, parent_node_id, node_kind,
               pattern, slot, asset_version_id, transform_json, relation_json,
               clip_json, local_z, status, version, created_at, updated_at, deleted_at
        FROM paper_composition_nodes_h44_legacy`);
      database.exec('DROP TABLE paper_composition_nodes_h44_legacy');
      database.exec('CREATE INDEX idx_paper_composition_nodes_shot ON paper_composition_nodes(shot_id, plan_revision_id, parent_node_id, local_z)');
    }
    if (rebuildMotion) {
      database.exec('ALTER TABLE paper_motion_plans RENAME TO paper_motion_plans_h44_legacy');
      database.exec(`CREATE TABLE paper_motion_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shot_id INTEGER NOT NULL,
        plan_revision_id INTEGER NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL DEFAULT 1,
        semantic_contract_hash TEXT NOT NULL,
        timing_hash TEXT,
        plan_json TEXT NOT NULL,
        compiled_tracks_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'draft',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      database.exec(`INSERT INTO paper_motion_plans
        SELECT id, shot_id, plan_revision_id, schema_version, semantic_contract_hash,
               timing_hash, plan_json, compiled_tracks_json, status, version,
               created_at, updated_at
        FROM paper_motion_plans_h44_legacy`);
      database.exec('DROP TABLE paper_motion_plans_h44_legacy');
      database.exec('CREATE INDEX idx_paper_motion_plans_shot ON paper_motion_plans(shot_id, plan_revision_id, status)');
    }
  })();
}

function ensurePaperPlanRevisionSchema(database) {
  const required = ['paper_plan_revisions', 'paper_studio_shots', 'paper_source_families', 'paper_composition_nodes', 'paper_motion_plans', 'paper_job_steps'];
  const present = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  if (!required.every((table) => present.has(table))) return;
  ensureInitialPlanRevisions(database);
  rebuildPlanOwnedTables(database);
  database.exec('DROP INDEX IF EXISTS idx_paper_job_steps_idempotency');
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_job_steps_idempotency
    ON paper_job_steps(run_id, COALESCE(shot_id, 0), COALESCE(plan_revision_id, 0), step_key, input_hash, attempt)`);
  database.exec('CREATE INDEX IF NOT EXISTS idx_paper_job_steps_plan_revision ON paper_job_steps(plan_revision_id, status, updated_at)');
  require('../services/paper-studio/paperAssetReuseFingerprintService').backfillReuseFingerprints(database);
}

/**
 * 全量兜底补列：覆盖所有表的所有业务列。
 * 对于旧数据库（用更早版本的 init 脚本创建、缺少部分列），
 * 在每次启动时自动补齐，避免 "no such column" 运行时错误。
 *
 * SQLite 不支持 ALTER TABLE ADD COLUMN ... NOT NULL（无默认值），
 * 所以原 schema 中 NOT NULL 的列在这里用 DEFAULT 兜底。
 */
function ensureAllColumns(database) {
  ensurePaperTables(database);
  ensurePaperStudioTables(database);
  ensureColumns(database, 'paper_studio_runs', [
    { name: 'paper_episode_id', type: 'INTEGER' },
    { name: 'legacy_episode_id', type: 'INTEGER' },
    { name: 'paused_at', type: 'TEXT' },
    { name: 'attention_required', type: "TEXT NOT NULL DEFAULT 'none'" },
    { name: 'active_authorization_id', type: 'INTEGER' },
  ]);
  ensureColumns(database, 'paper_studio_shots', [
    { name: 'paper_storyboard_id', type: 'INTEGER' },
    { name: 'paper_storyboard_revision_id', type: 'INTEGER' },
    { name: 'legacy_storyboard_id', type: 'INTEGER' },
    { name: 'source_kind', type: "TEXT NOT NULL DEFAULT 'legacy'" },
    { name: 'attention_required', type: "TEXT NOT NULL DEFAULT 'none'" },
    { name: 'current_plan_revision_id', type: 'INTEGER' },
  ]);
  ensureColumns(database, 'paper_source_families', [
    { name: 'plan_revision_id', type: 'INTEGER' },
  ]);
  ensureColumns(database, 'paper_composition_nodes', [
    { name: 'plan_revision_id', type: 'INTEGER' },
  ]);
  ensureColumns(database, 'paper_motion_plans', [
    { name: 'plan_revision_id', type: 'INTEGER' },
  ]);
  ensureColumns(database, 'paper_asset_slots', [
    { name: 'reuse_fingerprint', type: 'TEXT' },
  ]);
  ensureColumns(database, 'paper_asset_versions', [
    { name: 'reuse_fingerprint', type: 'TEXT' },
  ]);
  ensureColumns(database, 'paper_studio_episodes', [
    { name: 'request_id', type: 'TEXT' },
  ]);
  ensureColumns(database, 'paper_storyboards', [
    { name: 'request_id', type: 'TEXT' },
    { name: 'environment_only', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'current_dialogue_audio_version_id', type: 'INTEGER' },
    { name: 'current_narration_audio_version_id', type: 'INTEGER' },
    { name: 'audio_mode', type: "TEXT NOT NULL DEFAULT 'auto'" },
    { name: 'audio_mix_json', type: "TEXT NOT NULL DEFAULT '{}'" },
    { name: 'audio_status', type: "TEXT NOT NULL DEFAULT 'empty'" },
  ]);
  ensureColumns(database, 'paper_job_steps', [
    { name: 'authorization_id', type: 'INTEGER' },
    { name: 'blocked_reason', type: 'TEXT' },
    { name: 'user_visible_status', type: 'TEXT' },
    { name: 'cancel_requested_at', type: 'TEXT' },
    { name: 'plan_revision_id', type: 'INTEGER' },
  ]);
  // --- dramas ---
  ensureColumns(database, 'dramas', [
    { name: 'title',          type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'description',    type: 'TEXT' },
    { name: 'genre',          type: 'TEXT' },
    { name: 'style',          type: 'TEXT DEFAULT \'realistic\'' },
    { name: 'tags',           type: 'TEXT' },
    { name: 'thumbnail',      type: 'TEXT' },
    { name: 'total_episodes', type: 'INTEGER DEFAULT 1' },
    { name: 'total_duration', type: 'INTEGER DEFAULT 0' },
    { name: 'status',         type: 'TEXT DEFAULT \'draft\'' },
    { name: 'metadata',       type: 'TEXT' },
    { name: 'active_visual_style_version_id', type: 'INTEGER' },
    { name: 'active_visual_style_signature', type: 'TEXT' },
    { name: 'created_at',     type: 'TEXT' },
    { name: 'updated_at',     type: 'TEXT' },
    { name: 'deleted_at',     type: 'TEXT' },
  ]);

  // --- episodes ---
  ensureColumns(database, 'episodes', [
    { name: 'drama_id',       type: 'INTEGER DEFAULT 0' },
    { name: 'episode_number', type: 'INTEGER DEFAULT 0' },
    { name: 'title',          type: 'TEXT DEFAULT \'\'' },
    { name: 'script_content', type: 'TEXT' },
    { name: 'description',    type: 'TEXT' },
    { name: 'duration',       type: 'INTEGER DEFAULT 0' },
    { name: 'video_url',      type: 'TEXT' },
    { name: 'thumbnail',      type: 'TEXT' },
    { name: 'status',         type: 'TEXT DEFAULT \'draft\'' },
    { name: 'created_at',     type: 'TEXT' },
    { name: 'updated_at',     type: 'TEXT' },
    { name: 'deleted_at',     type: 'TEXT' },
  ]);

  // --- storyboards ---
  ensureColumns(database, 'storyboards', [
    { name: 'episode_id',        type: 'INTEGER DEFAULT 0' },
    { name: 'scene_id',          type: 'INTEGER' },
    { name: 'storyboard_number', type: 'INTEGER DEFAULT 0' },
    { name: 'title',             type: 'TEXT' },
    { name: 'description',       type: 'TEXT' },
    { name: 'layout_description', type: 'TEXT' },   // 画面布局与人物站位（首尾帧模式空间合同）
    { name: 'location',          type: 'TEXT' },
    { name: 'time',              type: 'TEXT' },
    { name: 'duration',          type: 'REAL' },
    { name: 'dialogue',          type: 'TEXT' },
    { name: 'narration',         type: 'TEXT' },
    { name: 'action',            type: 'TEXT' },
    { name: 'atmosphere',        type: 'TEXT' },
    { name: 'image_prompt',      type: 'TEXT' },
    { name: 'video_prompt',      type: 'TEXT' },
    { name: 'characters',        type: 'TEXT' },
    { name: 'shot_type',         type: 'TEXT' },
    { name: 'angle',             type: 'TEXT' },
    { name: 'movement',          type: 'TEXT' },
    { name: 'image_url',         type: 'TEXT' },
    { name: 'local_path',        type: 'TEXT' },
    { name: 'main_panel_idx',    type: 'INTEGER' },
    { name: 'video_url',         type: 'TEXT' },
    { name: 'composed_image',    type: 'TEXT' },
    { name: 'result',            type: 'TEXT' },
    { name: 'emotion',           type: 'TEXT' },               // 当前情绪（兴奋/悲伤/紧张等）
    { name: 'emotion_intensity', type: 'INTEGER' },            // 情绪强度 3/2/1/0/-1
    { name: 'error_msg',         type: 'TEXT' },
    { name: 'segment_index',     type: 'INTEGER DEFAULT 0' },  // 剧情段落索引（0-based）
    { name: 'segment_title',     type: 'TEXT' },               // 剧情段落名称
    { name: 'angle_h',           type: 'TEXT' },               // 水平方向（front/left/back/right...）
    { name: 'angle_v',           type: 'TEXT' },               // 俯仰角度（worm/low/eye_level/high）
    { name: 'angle_s',           type: 'TEXT' },               // 景别（close_up/medium/wide）
    { name: 'lighting_style',    type: 'TEXT' },               // 灯光风格（natural/side/dramatic/golden_hour 等）
    { name: 'depth_of_field',    type: 'TEXT' },               // 景深（shallow/medium/deep/extreme_shallow）
    { name: 'polished_prompt',        type: 'TEXT' },               // 文字AI润色后的图片生成提示词（可编辑，生图时优先使用）
    { name: 'polished_prompt_style_signature', type: 'TEXT' },      // polished_prompt 对应的统一视觉风格签名
    { name: 'prompt_state',      type: 'TEXT DEFAULT \'current\'' }, // current | stale_style | stale_scene | stale_reference | manual_override
    { name: 'continuity_snapshot',   type: 'TEXT' },               // JSON: 连戏状态快照 {characters:{name:{position,clothing,expression,props}},lighting}
    { name: 'audio_local_path',      type: 'TEXT' },               // 对白 TTS 本地路径
    { name: 'narration_audio_local_path', type: 'TEXT' },         // 解说旁白 TTS 本地路径
    { name: 'creation_mode',     type: 'TEXT DEFAULT \'classic\'' }, // classic | universal
    { name: 'universal_segment_text', type: 'TEXT' },              // 全能模式片段描述（@ 引用等）
    { name: 'first_frame_image_id', type: 'INTEGER' },
    { name: 'last_frame_image_id',  type: 'INTEGER' },
    { name: 'last_frame_image_url', type: 'TEXT' },
    { name: 'last_frame_local_path', type: 'TEXT' },
    { name: 'video_render_mode', type: "TEXT DEFAULT 'ai_video'" },
    { name: 'status',            type: 'TEXT DEFAULT \'draft\'' },
    { name: 'created_at',        type: 'TEXT' },
    { name: 'updated_at',        type: 'TEXT' },
    { name: 'deleted_at',        type: 'TEXT' },
  ]);

  // --- characters ---
  ensureColumns(database, 'characters', [
    { name: 'drama_id',          type: 'INTEGER DEFAULT 0' },
    { name: 'name',              type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'role',              type: 'TEXT' },
    { name: 'description',       type: 'TEXT' },
    { name: 'personality',       type: 'TEXT' },
    { name: 'appearance',        type: 'TEXT' },
    { name: 'image_url',         type: 'TEXT' },
    { name: 'local_path',        type: 'TEXT' },
    { name: 'extra_images',      type: 'TEXT' },
    { name: 'voice_style',       type: 'TEXT' },
    { name: 'sort_order',        type: 'INTEGER DEFAULT 0' },
    { name: 'error_msg',         type: 'TEXT' },
    { name: 'identity_anchors',  type: 'TEXT' },   // JSON: 6层视觉锚点（骨相/五官/辨识标记/色值/皮肤/发型）
    { name: 'style_tokens',      type: 'TEXT' },   // 风格词 token 列表
    { name: 'color_palette',     type: 'TEXT' },   // JSON: Hex 色值数组
    { name: 'four_view_image_url', type: 'TEXT' }, // 四视图参考图 URL
    { name: 'polished_prompt',   type: 'TEXT' },   // 文字AI润色后的完整图片生成提示词（可编辑，生图时直接使用）
    { name: 'polished_prompt_style_signature', type: 'TEXT' }, // polished_prompt 对应的统一视觉风格签名
    { name: 'prompt_state',      type: 'TEXT DEFAULT \'current\'' },
    { name: 'ref_image',         type: 'TEXT' },   // 用户上传的参考图（本地相对路径或 URL），独立于 AI 生成的主图
    { name: 'stages',            type: 'TEXT' },   // JSON: 多阶段造型 [{episode_range:[1,3], appearance:"..."}]
    { name: 'seedance2_asset', type: 'TEXT' },   // JSON: 即梦/Seedance2 素材库认证 hub_asset_id / asset_url 等
    { name: 'seedance2_voice_asset', type: 'TEXT' }, // JSON: Seedance 2.0 音色参考音频（仅 SD2 模型有效）
    { name: 'negative_prompt', type: 'TEXT' },
    { name: 'created_at',        type: 'TEXT' },
    { name: 'updated_at',        type: 'TEXT' },
    { name: 'deleted_at',        type: 'TEXT' },
  ]);

  // --- scenes ---
  ensureColumns(database, 'scenes', [
    { name: 'drama_id',         type: 'INTEGER DEFAULT 0' },
    { name: 'episode_id',       type: 'INTEGER' },
    { name: 'location',         type: 'TEXT' },
    { name: 'time',             type: 'TEXT' },
    { name: 'prompt',           type: 'TEXT' },
    { name: 'polished_prompt',  type: 'TEXT' },  // 文字AI润色后的完整四视图图片提示词，生图时直接使用
    { name: 'polished_prompt_style_signature', type: 'TEXT' }, // polished_prompt 对应的统一视觉风格签名
    { name: 'polished_prompt_single', type: 'TEXT' }, // 文字AI润色后的完整单图图片提示词，Codex/单图生图优先使用
    { name: 'polished_prompt_single_style_signature', type: 'TEXT' }, // polished_prompt_single 对应的统一视觉风格签名
    { name: 'polished_prompt_nine', type: 'TEXT' }, // 场景九宫格参考板完整图片提示词
    { name: 'polished_prompt_nine_style_signature', type: 'TEXT' }, // polished_prompt_nine 对应的统一视觉风格签名
    { name: 'prompt_state',     type: 'TEXT DEFAULT \'current\'' },
    { name: 'image_url',        type: 'TEXT' },
    { name: 'local_path',       type: 'TEXT' },
    { name: 'reference_grid_image_url', type: 'TEXT' }, // 场景九宫格参考板 URL，不覆盖主图
    { name: 'reference_grid_local_path', type: 'TEXT' }, // 场景九宫格参考板本地路径
    { name: 'extra_images',     type: 'TEXT' },
    { name: 'ref_image',        type: 'TEXT' },  // 用户上传的参考图（本地相对路径或 URL）
    { name: 'negative_prompt',  type: 'TEXT' },
    { name: 'storyboard_count', type: 'INTEGER DEFAULT 0' },
    { name: 'error_msg',        type: 'TEXT' },
    { name: 'status',           type: 'TEXT DEFAULT \'draft\'' },
    { name: 'created_at',       type: 'TEXT' },
    { name: 'updated_at',       type: 'TEXT' },
    { name: 'deleted_at',       type: 'TEXT' },
  ]);

  // --- props ---
  ensureColumns(database, 'props', [
    { name: 'drama_id',    type: 'INTEGER DEFAULT 0' },
    { name: 'episode_id',  type: 'INTEGER' },
    { name: 'name',        type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'type',        type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'prompt',      type: 'TEXT' },
    { name: 'prompt_style_signature', type: 'TEXT' }, // prompt 对应的统一视觉风格签名
    { name: 'prompt_state', type: 'TEXT DEFAULT \'current\'' },
    { name: 'image_url',    type: 'TEXT' },
    { name: 'local_path',   type: 'TEXT' },
    { name: 'extra_images', type: 'TEXT' },
    { name: 'ref_image',    type: 'TEXT' },  // 用户上传的参考图（本地相对路径或 URL）
    { name: 'negative_prompt', type: 'TEXT' },
    { name: 'error_msg',    type: 'TEXT' },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'updated_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
  ]);

  // --- ai_service_configs ---（兜底建表：旧版 01_init.sql 可能未包含此表）
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS ai_service_configs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type  TEXT NOT NULL DEFAULT 'text',
      provider      TEXT DEFAULT '',
      name          TEXT DEFAULT '',
      base_url      TEXT DEFAULT '',
      api_key       TEXT,
      model         TEXT,
      default_model TEXT,
      endpoint      TEXT,
      query_endpoint TEXT,
      priority      INTEGER DEFAULT 0,
      is_default    INTEGER DEFAULT 0,
      is_active     INTEGER DEFAULT 1,
      settings      TEXT,
      created_at    TEXT,
      updated_at    TEXT,
      deleted_at    TEXT
    )`);
  } catch (_) {}
  ensureColumns(database, 'ai_service_configs', [
    { name: 'service_type',   type: 'TEXT NOT NULL DEFAULT \'text\'' },
    { name: 'provider',       type: 'TEXT DEFAULT \'\'' },
    { name: 'name',           type: 'TEXT DEFAULT \'\'' },
    { name: 'base_url',       type: 'TEXT DEFAULT \'\'' },
    { name: 'api_key',        type: 'TEXT' },
    { name: 'model',          type: 'TEXT' },
    { name: 'default_model',  type: 'TEXT' },
    { name: 'endpoint',       type: 'TEXT' },
    { name: 'query_endpoint', type: 'TEXT' },
    { name: 'priority',       type: 'INTEGER DEFAULT 0' },
    { name: 'is_default',     type: 'INTEGER DEFAULT 0' },
    { name: 'is_active',      type: 'INTEGER DEFAULT 1' },
    { name: 'settings',       type: 'TEXT' },
    { name: 'created_at',     type: 'TEXT' },
    { name: 'updated_at',     type: 'TEXT' },
    { name: 'deleted_at',     type: 'TEXT' },
  ]);

  // --- async_tasks ---
  ensureColumns(database, 'async_tasks', [
    { name: 'type',         type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'status',       type: 'TEXT NOT NULL DEFAULT \'pending\'' },
    { name: 'progress',     type: 'INTEGER DEFAULT 0' },
    { name: 'message',      type: 'TEXT' },
    { name: 'resource_id',  type: 'TEXT' },
    { name: 'completed_at', type: 'TEXT' },
    { name: 'error',        type: 'TEXT' },
    { name: 'result',       type: 'TEXT' },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'updated_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
  ]);

  // --- image_generations ---
  ensureColumns(database, 'image_generations', [
    { name: 'storyboard_id',    type: 'INTEGER' },
    { name: 'drama_id',         type: 'INTEGER' },
    { name: 'episode_id',       type: 'INTEGER' },
    { name: 'scene_id',         type: 'INTEGER' },
    { name: 'character_id',     type: 'INTEGER' },
    { name: 'prop_id',          type: 'INTEGER' },
    { name: 'provider',         type: 'TEXT' },
    { name: 'prompt',           type: 'TEXT' },
    { name: 'negative_prompt',  type: 'TEXT' },
    { name: 'model',            type: 'TEXT' },
    { name: 'frame_type',       type: 'TEXT' },
    { name: 'reference_images', type: 'TEXT' },
    { name: 'use_first_frame_layout_lock', type: 'INTEGER' },
    { name: 'size',             type: 'TEXT' },
    { name: 'quality',          type: 'TEXT' },
    { name: 'style_version_id', type: 'INTEGER' },
    { name: 'context_snapshot_id', type: 'TEXT' },
    { name: 'prompt_hash',      type: 'TEXT' },
    { name: 'reference_pack',   type: 'TEXT' },
    { name: 'compiler_version', type: 'TEXT' },
    { name: 'image_url',        type: 'TEXT' },
    { name: 'local_path',       type: 'TEXT' },
    { name: 'width',            type: 'INTEGER' },
    { name: 'height',           type: 'INTEGER' },
    { name: 'status',           type: 'TEXT' },
    { name: 'task_id',          type: 'TEXT' },
    { name: 'completed_at',     type: 'TEXT' },
    { name: 'error_msg',        type: 'TEXT' },
    { name: 'generation_kind',  type: "TEXT DEFAULT 'standard'" },
    { name: 'paper_asset_version_id', type: 'INTEGER' },
    { name: 'generation_purpose', type: 'TEXT' },
    { name: 'request_fingerprint', type: 'TEXT' },
    { name: 'provider_task_id', type: 'TEXT' },
    { name: 'paper_storyboard_id', type: 'INTEGER' },
    { name: 'paper_studio_run_id', type: 'INTEGER' },
    { name: 'paper_studio_shot_id', type: 'INTEGER' },
    { name: 'paper_asset_slot_id', type: 'INTEGER' },
    { name: 'generation_authorization_id', type: 'INTEGER' },
    { name: 'provider_attempted_at', type: 'TEXT' },
    { name: 'provider_call_count', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'created_at',       type: 'TEXT' },
    { name: 'updated_at',       type: 'TEXT' },
    { name: 'deleted_at',       type: 'TEXT' },
  ]);

  // --- video_generations ---
  ensureColumns(database, 'video_generations', [
    { name: 'drama_id',             type: 'INTEGER' },
    { name: 'storyboard_id',        type: 'INTEGER' },
    { name: 'provider',             type: 'TEXT' },
    { name: 'prompt',               type: 'TEXT' },
    { name: 'model',                type: 'TEXT' },
    { name: 'duration',             type: 'REAL' },
    { name: 'aspect_ratio',         type: 'TEXT' },
    { name: 'resolution',           type: 'TEXT' },
    { name: 'seed',                 type: 'INTEGER' },
    { name: 'camera_fixed',         type: 'INTEGER' },
    { name: 'watermark',            type: 'INTEGER' },
    { name: 'image_url',            type: 'TEXT' },
    { name: 'first_frame_url',      type: 'TEXT' },
    { name: 'last_frame_url',       type: 'TEXT' },
    { name: 'reference_image_urls', type: 'TEXT' },
    { name: 'video_url',            type: 'TEXT' },
    { name: 'local_path',           type: 'TEXT' },
    { name: 'status',               type: 'TEXT' },
    { name: 'task_id',              type: 'TEXT' },
    { name: 'provider_task_id',     type: 'TEXT' },
    { name: 'scene_id',             type: 'INTEGER' },
    { name: 'completed_at',         type: 'TEXT' },
    { name: 'error_msg',            type: 'TEXT' },
    { name: 'generation_kind',      type: "TEXT DEFAULT 'ai'" },
    { name: 'paper_composition_id', type: 'INTEGER' },
    { name: 'render_snapshot',      type: 'TEXT' },
    { name: 'render_hash',          type: 'TEXT' },
    { name: 'renderer_version',     type: 'TEXT' },
    { name: 'paper_studio_shot_id', type: 'INTEGER' },
    { name: 'paper_snapshot_id',    type: 'INTEGER' },
    { name: 'paper_storyboard_id',  type: 'INTEGER' },
    { name: 'created_at',           type: 'TEXT' },
    { name: 'updated_at',           type: 'TEXT' },
    { name: 'deleted_at',           type: 'TEXT' },
  ]);

  // --- video_merges ---
  ensureColumns(database, 'video_merges', [
    { name: 'episode_id',   type: 'INTEGER' },
    { name: 'paper_episode_id', type: 'INTEGER' },
    { name: 'drama_id',     type: 'INTEGER' },
    { name: 'title',        type: 'TEXT' },
    { name: 'provider',     type: 'TEXT' },
    { name: 'model',        type: 'TEXT' },
    { name: 'status',       type: 'TEXT' },
    { name: 'scenes',       type: 'TEXT' },
    { name: 'merge_options', type: 'TEXT' },
    { name: 'task_id',      type: 'TEXT' },
    { name: 'merged_url',   type: 'TEXT' },
    { name: 'duration',     type: 'INTEGER' },
    { name: 'completed_at', type: 'TEXT' },
    { name: 'error_msg',    type: 'TEXT' },
    { name: 'subtitle_local_path', type: 'TEXT' },
    { name: 'delivery_hash', type: 'TEXT' },
    { name: 'source_manifest_json', type: "TEXT NOT NULL DEFAULT '{}'" },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
  ]);

  // --- assets ---
  ensureColumns(database, 'assets', [
    { name: 'drama_id',     type: 'INTEGER' },
    { name: 'name',         type: 'TEXT' },
    { name: 'type',         type: 'TEXT' },
    { name: 'category',     type: 'TEXT' },
    { name: 'url',          type: 'TEXT' },
    { name: 'local_path',   type: 'TEXT' },
    { name: 'file_size',    type: 'INTEGER' },
    { name: 'mime_type',    type: 'TEXT' },
    { name: 'width',        type: 'INTEGER' },
    { name: 'height',       type: 'INTEGER' },
    { name: 'duration',     type: 'REAL' },
    { name: 'image_gen_id', type: 'INTEGER' },
    { name: 'video_gen_id', type: 'INTEGER' },
    { name: 'created_at',   type: 'TEXT' },
    { name: 'updated_at',   type: 'TEXT' },
    { name: 'deleted_at',   type: 'TEXT' },
  ]);

  // --- character_libraries ---
  ensureColumns(database, 'character_libraries', [
    { name: 'drama_id',          type: 'INTEGER' },   // NULL = 全局素材库；有值 = 本剧专属
    { name: 'name',              type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'category',          type: 'TEXT' },
    { name: 'image_url',         type: 'TEXT' },
    { name: 'local_path',        type: 'TEXT' },
    { name: 'description',       type: 'TEXT' },
    { name: 'appearance',        type: 'TEXT' },
    { name: 'tags',              type: 'TEXT' },
    { name: 'source_type',       type: 'TEXT' },
    { name: 'source_id',         type: 'TEXT' },
    { name: 'identity_anchors',  type: 'TEXT' },   // JSON: 6层视觉锚点（骨相/五官/辨识标记/色值/皮肤/发型）
    { name: 'style_tokens',      type: 'TEXT' },   // 风格词 token 列表
    { name: 'color_palette',     type: 'TEXT' },   // JSON: Hex 色值数组
    { name: 'four_view_image_url', type: 'TEXT' }, // 四视图参考图 URL（分镜图生图参考用）
    { name: 'created_at',        type: 'TEXT' },
    { name: 'updated_at',        type: 'TEXT' },
    { name: 'deleted_at',        type: 'TEXT' },
  ]);

  // --- scene_libraries ---
  ensureColumns(database, 'scene_libraries', [
    { name: 'drama_id',    type: 'INTEGER' },   // NULL = 全局素材库
    { name: 'location',    type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'time',        type: 'TEXT' },
    { name: 'prompt',      type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'image_url',   type: 'TEXT' },
    { name: 'local_path',  type: 'TEXT' },
    { name: 'category',    type: 'TEXT' },
    { name: 'tags',        type: 'TEXT' },
    { name: 'source_type', type: 'TEXT' },
    { name: 'source_id',   type: 'TEXT' },
    { name: 'created_at',  type: 'TEXT' },
    { name: 'updated_at',  type: 'TEXT' },
    { name: 'deleted_at',  type: 'TEXT' },
  ]);

  // --- prop_libraries ---
  ensureColumns(database, 'prop_libraries', [
    { name: 'drama_id',    type: 'INTEGER' },   // NULL = 全局素材库
    { name: 'name',        type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'description', type: 'TEXT' },
    { name: 'prompt',      type: 'TEXT' },
    { name: 'image_url',   type: 'TEXT' },
    { name: 'local_path',  type: 'TEXT' },
    { name: 'category',    type: 'TEXT' },
    { name: 'tags',        type: 'TEXT' },
    { name: 'source_type', type: 'TEXT' },
    { name: 'source_id',   type: 'TEXT' },
    { name: 'created_at',  type: 'TEXT' },
    { name: 'updated_at',  type: 'TEXT' },
    { name: 'deleted_at',  type: 'TEXT' },
  ]);

  // --- image_proxy_cache ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS image_proxy_cache (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key  TEXT NOT NULL UNIQUE,
      proxy_url  TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  } catch (_) {}
  ensureColumns(database, 'image_proxy_cache', [
    { name: 'cache_key',  type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'proxy_url',  type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'created_at', type: 'TEXT NOT NULL DEFAULT \'\'' },
  ]);

  // --- ai_model_map（业务场景→模型路由映射表） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS ai_model_map (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      key            TEXT NOT NULL UNIQUE,
      service_type   TEXT NOT NULL DEFAULT 'text',
      config_id      INTEGER,
      model_override TEXT,
      description    TEXT,
      created_at     TEXT NOT NULL DEFAULT '',
      updated_at     TEXT NOT NULL DEFAULT ''
    )`);
  } catch (_) {}
  ensureColumns(database, 'ai_model_map', [
    { name: 'key',            type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'service_type',   type: 'TEXT NOT NULL DEFAULT \'text\'' },
    { name: 'config_id',      type: 'INTEGER' },
    { name: 'model_override', type: 'TEXT' },
    { name: 'description',    type: 'TEXT' },
    { name: 'created_at',     type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'updated_at',     type: 'TEXT NOT NULL DEFAULT \'\'' },
  ]);

  // --- prompt_styles（用户自定义提示词风格约束） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS prompt_styles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      description TEXT,
      enabled     INTEGER DEFAULT 1,
      sort_order  INTEGER DEFAULT 0,
      created_at  TEXT,
      updated_at  TEXT,
      deleted_at  TEXT
    )`);
  } catch (_) {}
  ensureColumns(database, 'prompt_styles', [
    { name: 'name',        type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'content',     type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'description', type: 'TEXT' },
    { name: 'enabled',     type: 'INTEGER DEFAULT 1' },
    { name: 'sort_order',  type: 'INTEGER DEFAULT 0' },
    { name: 'role',        type: 'TEXT DEFAULT \'constraint\'' },
    { name: 'medium',      type: 'TEXT' },
    { name: 'compatibility_tags', type: 'TEXT' },
    { name: 'priority',    type: 'INTEGER DEFAULT 50' },
    { name: 'created_at',  type: 'TEXT' },
    { name: 'updated_at',  type: 'TEXT' },
    { name: 'deleted_at',  type: 'TEXT' },
  ]);
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS prompt_style_tags (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      style_id   INTEGER NOT NULL,
      tag        TEXT NOT NULL DEFAULT '',
      created_at TEXT
    )`);
  } catch (_) {}
  ensureColumns(database, 'prompt_style_tags', [
    { name: 'style_id',   type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'tag',        type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'created_at', type: 'TEXT' },
  ]);
  try {
    database.exec('CREATE INDEX IF NOT EXISTS idx_prompt_styles_deleted_enabled ON prompt_styles(deleted_at, enabled)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_prompt_style_tags_style ON prompt_style_tags(style_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_prompt_style_tags_tag ON prompt_style_tags(tag)');
  } catch (_) {}

  // --- generation_styles（用户自定义全局生成风格 + 角色/场景/道具/视频高级覆盖） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS generation_styles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      description TEXT,
      style_prompt_zh TEXT,
      style_prompt_en TEXT,
      visual_bible TEXT,
      visual_bible_struct TEXT,
      character_style_prompt_zh TEXT,
      character_style_prompt_en TEXT,
      scene_style_prompt_zh TEXT,
      scene_style_prompt_en TEXT,
      prop_style_prompt_zh TEXT,
      prop_style_prompt_en TEXT,
      video_style_prompt_zh TEXT,
      video_style_prompt_en TEXT,
      enabled INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    )`);
  } catch (_) {}
  ensureColumns(database, 'generation_styles', [
    { name: 'name', type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'description', type: 'TEXT' },
    { name: 'style_prompt_zh', type: 'TEXT' },
    { name: 'style_prompt_en', type: 'TEXT' },
    { name: 'visual_bible', type: 'TEXT' },
    { name: 'visual_bible_struct', type: 'TEXT' },
    { name: 'character_style_prompt_zh', type: 'TEXT' },
    { name: 'character_style_prompt_en', type: 'TEXT' },
    { name: 'scene_style_prompt_zh', type: 'TEXT' },
    { name: 'scene_style_prompt_en', type: 'TEXT' },
    { name: 'prop_style_prompt_zh', type: 'TEXT' },
    { name: 'prop_style_prompt_en', type: 'TEXT' },
    { name: 'video_style_prompt_zh', type: 'TEXT' },
    { name: 'video_style_prompt_en', type: 'TEXT' },
    { name: 'style_family', type: 'TEXT' },
    { name: 'medium', type: 'TEXT' },
    { name: 'compatibility_tags', type: 'TEXT' },
    { name: 'enabled', type: 'INTEGER DEFAULT 1' },
    { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'updated_at', type: 'TEXT' },
    { name: 'deleted_at', type: 'TEXT' },
  ]);
  try {
    database.exec('CREATE INDEX IF NOT EXISTS idx_generation_styles_deleted_enabled ON generation_styles(deleted_at, enabled)');
  } catch (_) {}

  // --- storyboard_characters（分镜与角色库的关联表） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS storyboard_characters (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id  INTEGER NOT NULL,
      character_id   INTEGER NOT NULL,
      created_at     TEXT NOT NULL DEFAULT ''
    )`);
  } catch (_) {}

  // --- global_settings（全局键值设置表） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS global_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )`);
  } catch (_) {}

  // --- codex_image_jobs（Codex 开发辅助生图队列） ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS codex_image_jobs (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id INTEGER NOT NULL DEFAULT 0,
      drama_id INTEGER,
      episode_id INTEGER,
      frame_type TEXT DEFAULT 'main',
      status TEXT NOT NULL DEFAULT 'pending',
      prompt TEXT,
      negative_prompt TEXT,
      aspect_ratio TEXT,
      style TEXT,
      source_snapshot TEXT,
      candidates TEXT,
      selected_candidate_id TEXT,
      applied_image_url TEXT,
      applied_local_path TEXT,
      error_msg TEXT,
      manifest_path TEXT,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT,
      used_at TEXT,
      deleted_at TEXT
    )`);
    database.exec('CREATE INDEX IF NOT EXISTS idx_codex_image_jobs_entity ON codex_image_jobs(entity_type, entity_id, status)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_codex_image_jobs_drama ON codex_image_jobs(drama_id, status, updated_at)');
  } catch (_) {}
  ensureColumns(database, 'codex_image_jobs', [
    { name: 'entity_type',           type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'entity_id',             type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'drama_id',              type: 'INTEGER' },
    { name: 'episode_id',            type: 'INTEGER' },
    { name: 'frame_type',            type: 'TEXT DEFAULT \'main\'' },
    { name: 'status',                type: 'TEXT NOT NULL DEFAULT \'pending\'' },
    { name: 'prompt',                type: 'TEXT' },
    { name: 'negative_prompt',       type: 'TEXT' },
    { name: 'aspect_ratio',          type: 'TEXT' },
    { name: 'quality',               type: 'TEXT DEFAULT \'standard\'' },
    { name: 'style',                 type: 'TEXT' },
    { name: 'style_version_id',      type: 'INTEGER' },
    { name: 'context_snapshot_id',   type: 'TEXT' },
    { name: 'prompt_hash',           type: 'TEXT' },
    { name: 'reference_pack',        type: 'TEXT' },
    { name: 'compiler_version',      type: 'TEXT' },
    { name: 'stale_reason',          type: 'TEXT' },
    { name: 'source_snapshot',       type: 'TEXT' },
    { name: 'candidates',            type: 'TEXT' },
    { name: 'selected_candidate_id', type: 'TEXT' },
    { name: 'applied_image_url',     type: 'TEXT' },
    { name: 'applied_local_path',    type: 'TEXT' },
    { name: 'error_msg',             type: 'TEXT' },
    { name: 'manifest_path',         type: 'TEXT' },
    { name: 'created_at',            type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'updated_at',            type: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'completed_at',          type: 'TEXT' },
    { name: 'used_at',               type: 'TEXT' },
    { name: 'deleted_at',            type: 'TEXT' },
  ]);

  // --- 统一视觉风格版本与不可变生成上下文 ---
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS drama_visual_style_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      name TEXT NOT NULL DEFAULT '',
      style_prompt_zh TEXT,
      style_prompt_en TEXT,
      visual_bible TEXT,
      visual_bible_struct TEXT,
      scope_overrides TEXT,
      prompt_style_ids TEXT,
      style_family TEXT,
      medium TEXT,
      signature TEXT NOT NULL,
      compiler_version TEXT NOT NULL DEFAULT 'v2',
      source TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      superseded_at TEXT,
      UNIQUE(drama_id, version)
    )`);
    database.exec('CREATE INDEX IF NOT EXISTS idx_visual_style_versions_drama ON drama_visual_style_versions(drama_id, version)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_visual_style_versions_status ON drama_visual_style_versions(drama_id, status)');
  } catch (_) {}

  try {
    database.exec(`CREATE TABLE IF NOT EXISTS generation_context_snapshots (
      id TEXT PRIMARY KEY,
      drama_id INTEGER,
      episode_id INTEGER,
      scene_id INTEGER,
      storyboard_id INTEGER,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      frame_type TEXT,
      style_version_id INTEGER,
      style_signature TEXT NOT NULL,
      prompt_source TEXT,
      source_prompt TEXT,
      compiled_prompt TEXT NOT NULL,
      compiled_negative_prompt TEXT,
      reference_pack TEXT,
      source_snapshot TEXT,
      prompt_hash TEXT NOT NULL,
      reference_hash TEXT,
      compiler_version TEXT NOT NULL DEFAULT 'v2',
      diagnostics TEXT,
      created_at TEXT NOT NULL
    )`);
    database.exec('CREATE INDEX IF NOT EXISTS idx_generation_context_entity ON generation_context_snapshots(entity_type, entity_id, frame_type, created_at)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_generation_context_drama ON generation_context_snapshots(drama_id, style_version_id, created_at)');
  } catch (_) {}
}

/** 对已打开的 database 执行迁移与兜底补列（供 app 启动时调用） */
function runMigrationsAndEnsure(database) {
  runMigrations(database);
  ensureAllColumns(database);
  ensureMigrationCreateStatements(database, '42_paper_studio_generation_attempt_ledger.sql');
  const stageMigration = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '43_paper_studio_asset_stage_state_machine.sql'), 'utf8');
  stageMigration.split(';').map((statement) => statement.trim()).filter(Boolean)
    .forEach((statement, index) => runOne(database, `${statement};`, '43_paper_studio_asset_stage_state_machine.sql', index));
  ensurePaperPlanRevisionSchema(database);
}

function main() {
  const config = loadConfig();
  const database = getDb(config.database);
  runMigrationsAndEnsure(database);
  console.log('Migrations complete.');
}

if (require.main === module) {
  main();
}

module.exports = {
  runMigrationsAndEnsure,
  ensureColumns,
  ensurePaperPlanRevisionSchema,
  ensurePaperHistoryForkSchema,
};
