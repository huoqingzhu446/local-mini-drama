const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const storageLayout = require('./storageLayout');
const {
  PaperError,
  nowIso,
  resolveStorageRoot,
  resolveStorageFile,
  sha256File,
  asPublicStaticPath,
  normalizeRelativePath,
  isPathInsideReal,
} = require('./paperUtils');

function colorDistance(r, g, b, key) {
  const dr = r - key[0];
  const dg = g - key[1];
  const db = b - key[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function chooseKeyColor(method, options) {
  if (Array.isArray(options.key_color) && options.key_color.length >= 3) return options.key_color.slice(0, 3).map(Number);
  return method === 'white_v1' ? [255, 255, 255] : [0, 255, 0];
}

function alphaForPixel(r, g, b, a, key, threshold, softness) {
  if (a === 0) return 0;
  const distance = colorDistance(r, g, b, key);
  if (distance <= threshold) return 0;
  if (distance >= threshold + softness) return a;
  return Math.round(a * ((distance - threshold) / softness));
}

async function process(db, cfg, asset, options = {}) {
  const sourceRel = normalizeRelativePath(asset.local_path || asset.image_url?.replace(/^\/static\//, ''));
  const source = resolveStorageFile(cfg, sourceRel);
  if (!source || !fs.existsSync(source) || !isPathInsideReal(resolveStorageRoot(cfg), source)) {
    throw new PaperError('PAPER_ASSET_PATH_INVALID', '抠图源文件不存在或路径非法', { asset_id: asset.id, local_path: sourceRel }, 422);
  }
  const method = options.method || 'green_screen_v1';
  const threshold = Number(options.threshold ?? (method === 'white_v1' ? 34 : 72));
  const softness = Math.max(1, Number(options.softness ?? 22));
  const input = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(input.data);
  let transparent = 0;
  let visible = 0;
  let minX = input.info.width;
  let minY = input.info.height;
  let maxX = -1;
  let maxY = -1;
  const key = chooseKeyColor(method, options);
  for (let y = 0; y < input.info.height; y += 1) {
    for (let x = 0; x < input.info.width; x += 1) {
      const i = (y * input.info.width + x) * 4;
      const alpha = alphaForPixel(data[i], data[i + 1], data[i + 2], data[i + 3], key, threshold, softness);
      data[i + 3] = alpha;
      if (alpha < 12) {
        transparent += 1;
      } else {
        visible += 1;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
  }
  const total = input.info.width * input.info.height;
  const transparentRatio = total ? transparent / total : 0;
  const visibleRatio = total ? visible / total : 0;
  const bbox = maxX >= 0 ? {
    x: minX / input.info.width,
    y: minY / input.info.height,
    width: (maxX - minX + 1) / input.info.width,
    height: (maxY - minY + 1) / input.info.height,
  } : {};
  const greenEdgeRatio = method === 'green_screen_v1' ? transparentRatio : 0;
  const diagnostics = {
    schema_version: 1,
    method,
    source_hash: sha256File(source),
    width: input.info.width,
    height: input.info.height,
    alpha_bbox: bbox,
    transparent_ratio: Number(transparentRatio.toFixed(6)),
    visible_ratio: Number(visibleRatio.toFixed(6)),
    green_edge_ratio: Number(greenEdgeRatio.toFixed(6)),
    safety_margin: Number(options.safety_margin ?? 0.04),
  };
  const reviewPass = visibleRatio > 0.01 && visibleRatio < 0.99 && (method !== 'green_screen_v1' || greenEdgeRatio > 0.02);
  diagnostics.review = { status: reviewPass ? 'pass' : 'warning', operator: 'system', at: nowIso() };

  const project = storageLayout.getProjectStorageSubdir(db, asset.drama_id);
  const baseName = path.basename(sourceRel || `asset-${asset.id}`, path.extname(sourceRel || '.png'));
  const outputRel = `${project}/paper/assets/${baseName}-cutout-${asset.id}.png`.replace(/\\/g, '/');
  const output = resolveStorageFile(cfg, outputRel);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await sharp(data, { raw: input.info }).png().toFile(output);
  const outputHash = sha256File(output);
  diagnostics.output_hash = outputHash;

  const update = db.prepare(
    `UPDATE paper_assets
     SET cutout_local_path = ?, image_url = ?, processing_json = ?, content_bbox_json = ?, alpha_bbox_json = ?,
         asset_hash = ?, matte_quality = ?, status = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`
  ).run(
    outputRel,
    asPublicStaticPath(outputRel),
    JSON.stringify(diagnostics),
    JSON.stringify(bbox),
    JSON.stringify(bbox),
    outputHash,
    reviewPass ? 'pass' : 'warning',
    reviewPass ? 'ready' : 'needs_review',
    nowIso(),
    asset.id
  );
  if (!update.changes) throw new PaperError('PAPER_NOT_FOUND', '纸片资产不存在或已删除', { id: asset.id }, 404);
  require('./paperAssetService').markReferencingCompositionsStale(db, asset.id, 'matte output changed');
  return {
    ok: reviewPass,
    status: reviewPass ? 'ready' : 'needs_review',
    asset_id: asset.id,
    cutout_local_path: outputRel,
    cutout_url: asPublicStaticPath(outputRel),
    diagnostics,
  };
}

module.exports = { process, colorDistance, alphaForPixel };
