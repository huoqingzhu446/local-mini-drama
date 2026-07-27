const fs = require('fs');
const path = require('path');
const schemaService = require('./paperStudioSchemaService');
const paperRuntimeService = require('../paperRuntimeService');

const REQUIRED_TABLES = [
  'paper_studio_projects',
  'paper_studio_episodes',
  'paper_storyboards',
  'paper_storyboard_revisions',
  'paper_studio_runs',
  'paper_studio_shots',
  'paper_blueprint_revisions',
  'paper_storyboard_entities',
  'paper_action_contracts',
  'paper_storyboard_reference_versions',
  'paper_source_families',
  'paper_asset_slots',
  'paper_asset_versions',
  'paper_asset_review_decisions',
  'paper_asset_mask_edits',
  'paper_composition_nodes',
  'paper_motion_plans',
  'paper_motion_revisions',
  'paper_continuity_contracts',
  'paper_render_snapshots',
  'paper_proof_runs',
  'paper_proof_evidence',
  'paper_job_steps',
  'paper_scripts',
  'paper_library_entities',
  'paper_library_identity_versions',
  'paper_storyboard_entity_links',
  'paper_style_anchors',
];

function storageRoot(cfg) {
  const configured = cfg?.storage?.local_path || path.join('data', 'storage');
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function hasColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  return {
    ok: columns.every((column) => existing.has(column)),
    missing: columns.filter((column) => !existing.has(column)),
  };
}

function doctor(db, cfg) {
  const blocking = [];
  const warnings = [];
  const enabled = cfg?.paper_studio?.enabled !== false;
  if (!enabled) blocking.push({ code: 'PAPER_STUDIO_DISABLED', message: 'paper_studio.enabled 已关闭' });

  const existingTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  const missingTables = REQUIRED_TABLES.filter((table) => !existingTables.has(table));
  if (missingTables.length) {
    blocking.push({
      code: 'PAPER_STUDIO_MIGRATION_INCOMPLETE',
      message: '纸片工作室数据库迁移不完整',
      details: { missing_tables: missingTables },
    });
  }

  const imageColumns = hasColumns(db, 'image_generations', [
    'generation_kind', 'paper_asset_version_id', 'generation_purpose',
    'request_fingerprint', 'provider_task_id', 'paper_storyboard_id',
  ]);
  const videoColumns = hasColumns(db, 'video_generations', [
    'paper_studio_shot_id', 'paper_snapshot_id', 'paper_storyboard_id',
  ]);
  if (!imageColumns.ok || !videoColumns.ok) {
    blocking.push({
      code: 'PAPER_STUDIO_SHARED_COLUMNS_MISSING',
      message: '共享生成表缺少纸片工作室字段',
      details: { image_generations: imageColumns.missing, video_generations: videoColumns.missing },
    });
  }

  const root = storageRoot(cfg);
  let storageWritable = false;
  try {
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
    storageWritable = true;
  } catch (error) {
    blocking.push({
      code: 'PAPER_STUDIO_STORAGE_UNWRITABLE',
      message: '纸片工作室存储目录不可写',
      details: { storage_root: root, error: error.message },
    });
  }

  let activeImageProviders = 0;
  try {
    activeImageProviders = Number(db.prepare(
      `SELECT COUNT(*) AS count FROM ai_service_configs
       WHERE deleted_at IS NULL AND is_active = 1
         AND service_type IN ('image', 'image_generation')`,
    ).get()?.count || 0);
  } catch (_) {
    activeImageProviders = 0;
  }
  if (!activeImageProviders) {
    warnings.push({
      code: 'PAPER_STUDIO_IMAGE_PROVIDER_MISSING',
      message: '尚未检测到启用的图片生成配置；可以创建工作台，但不能开始素材生产',
    });
  }

  try {
    const quotaFailure = db.prepare(
      `SELECT error_msg, updated_at FROM image_generations
       WHERE generation_kind = 'paper_studio_asset' AND status = 'failed'
         AND (error_msg LIKE '%额度已用尽%' OR error_msg LIKE '%usage_limit_reached%' OR error_msg LIKE '%usage limit%')
       ORDER BY id DESC LIMIT 1`,
    ).get();
    if (quotaFailure) warnings.push({
      code: 'PAPER_STUDIO_PROVIDER_QUOTA_EXHAUSTED',
      message: '最近一次纸片素材生成因图片 API 额度用尽失败；已完成版本会保留，额度恢复后可局部重试',
      details: { updated_at: quotaFailure.updated_at },
    });
  } catch (_) {}

  const schema = schemaService.doctor();
  if (!schema.ok) {
    blocking.push({ code: 'PAPER_STUDIO_SCHEMA_UNAVAILABLE', message: 'Ajv Schema 未正确加载' });
  }

  const rendererRoot = path.resolve(__dirname, '..', '..', 'paper-studio-renderer');
  const rendererFiles = ['entry.jsx', 'Root.jsx', 'PaperStudioComposition.jsx', 'RecursiveNode.jsx', 'AssetNode.jsx', 'ProceduralLayer.jsx'];
  const missingRendererFiles = rendererFiles.filter((file) => !fs.existsSync(path.join(rendererRoot, file)));
  let remotionVersions = {};
  try {
    remotionVersions = {
      remotion: require('remotion/package.json').version,
      bundler: require('@remotion/bundler/package.json').version,
      renderer: require('@remotion/renderer/package.json').version,
      media: require('@remotion/media/package.json').version,
    };
  } catch (_) {}
  const versionValues = Object.values(remotionVersions);
  const rendererVersionLocked = versionValues.length === 4 && new Set(versionValues).size === 1;
  let runtime = paperRuntimeService.bundledBrowserPath();
  if (!runtime && process.platform === 'darwin') {
    const systemChrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((candidate) => fs.existsSync(candidate));
    if (systemChrome) runtime = { path: systemChrome, source: 'system' };
  }
  const compositor = paperRuntimeService.compositorDir();
  const rendererReady = missingRendererFiles.length === 0 && rendererVersionLocked && Boolean(runtime?.path) && Boolean(compositor);
  if (!rendererReady) warnings.push({
    code: 'PAPER_STUDIO_RENDERER_RUNTIME_INCOMPLETE',
    message: 'v3 renderer 源码已安装，但当前运行时缺少浏览器、compositor 或一致版本依赖',
    details: { missing_files: missingRendererFiles, versions: remotionVersions, browser: runtime?.path || null, compositor },
  });
  let matteReady = false;
  try { matteReady = Boolean(require.resolve('sharp')); } catch (_) {}

  return {
    ok: blocking.length === 0,
    phase: 1,
    schema_version: 3,
    renderer_version: cfg?.paper_studio?.renderer_version || 'paper-studio-v3.1',
    blocking,
    warnings,
    checks: {
      enabled,
      legacy_v2_enabled: cfg?.paper_studio?.legacy_v2_enabled !== false,
      migrations: { ok: missingTables.length === 0, required_tables: REQUIRED_TABLES.length, missing_tables: missingTables },
      shared_columns: { ok: imageColumns.ok && videoColumns.ok },
      schema,
      storage: { ok: storageWritable, root },
      image_provider: { ok: activeImageProviders > 0, active_count: activeImageProviders },
      renderer: {
        ok: rendererReady,
        status: rendererReady ? 'ready' : 'runtime_incomplete',
        versions: remotionVersions,
        browser: runtime?.path || null,
        compositor,
        missing_files: missingRendererFiles,
      },
      matte: { ok: matteReady, status: matteReady ? 'alpha_or_border_matte_ready' : 'sharp_missing' },
    },
  };
}

module.exports = { doctor, REQUIRED_TABLES };
