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
  if (method === 'white_v1') return [255, 255, 255];
  if (method === 'dark_v1') return [0, 0, 0];
  return [0, 255, 0];
}

function median(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

/**
 * AI-generated "white background" assets are commonly warm gray rather than
 * RGB(255,255,255). Sample a narrow border band so the key follows the actual
 * generated plate while avoiding most of the centered subject.
 */
function borderCandidate(data, info, side) {
  const { width, height, channels } = info;
  const band = Math.max(2, Math.round(Math.min(width, height) * 0.025));
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 300));
  const samples = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (x >= band && x < width - band && y >= band && y < height - band) continue;
      const offset = (y * width + x) * channels;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      // white_v1 intentionally targets a light plate. Excluding dark edge
      // pixels prevents a subject touching one border from polluting the key.
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (side === 'light' ? luminance < 128 : luminance >= 128) continue;
      samples.push([r, g, b]);
    }
  }
  if (!samples.length) return null;
  const key = [0, 1, 2].map((channel) => median(samples.map((sample) => sample[channel])));
  const variance = samples.reduce((sum, sample) => {
    const distance = colorDistance(sample[0], sample[1], sample[2], key);
    return sum + distance * distance;
  }, 0) / samples.length;
  return { side, key, sample_count: samples.length, variance, deviation: Math.sqrt(variance) };
}

function estimateBorderKey(data, info, mode = 'auto') {
  const light = borderCandidate(data, info, 'light');
  const dark = borderCandidate(data, info, 'dark');
  const total = Number(light?.sample_count || 0) + Number(dark?.sample_count || 0);
  let selected;
  if (mode === 'white_v1') selected = light;
  else if (mode === 'dark_v1') selected = dark;
  else {
    const eligible = [light, dark].filter((candidate) => candidate
      && candidate.sample_count >= Math.max(64, total * 0.35));
    selected = eligible.sort((left, right) => (
      (left.variance + (1 - left.sample_count / Math.max(1, total)) * 64)
      - (right.variance + (1 - right.sample_count / Math.max(1, total)) * 64)
    ))[0] || [light, dark].filter(Boolean).sort((left, right) => right.sample_count - left.sample_count)[0];
  }
  const fallback = mode === 'dark_v1' ? [0, 0, 0] : [255, 255, 255];
  const key = selected?.key || fallback;
  const sampleCount = Number(selected?.sample_count || 0);
  const deviation = Number(selected?.deviation || 0);
  const alternate = selected === light ? dark : light;
  const keySeparation = selected && alternate
    ? colorDistance(selected.key[0], selected.key[1], selected.key[2], alternate.key)
    : null;
  return {
    key,
    mode: selected?.side === 'dark' ? 'dark_v1' : 'white_v1',
    sample_count: sampleCount,
    deviation: Number(deviation.toFixed(4)),
    key_separation: keySeparation == null ? null : Number(keySeparation.toFixed(4)),
    review_recommended: sampleCount < 500 || deviation > 24 || (keySeparation != null && keySeparation < 24),
    candidates: [light, dark].filter(Boolean).map((candidate) => ({
      mode: candidate.side === 'dark' ? 'dark_v1' : 'white_v1',
      sample_count: candidate.sample_count,
      deviation: Number(candidate.deviation.toFixed(4)),
    })),
  };
}

function estimateBorderKeyColor(data, info) {
  return estimateBorderKey(data, info, 'white_v1').key;
}

function alphaForPixel(r, g, b, a, key, threshold, softness) {
  if (a === 0) return 0;
  const distance = colorDistance(r, g, b, key);
  if (distance <= threshold) return 0;
  if (distance >= threshold + softness) return a;
  return Math.round(a * ((distance - threshold) / softness));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

function isChromaGreenKey(key) {
  return Array.isArray(key)
    && Number(key[1]) >= 180
    && Number(key[1]) - Number(key[0]) >= 80
    && Number(key[1]) - Number(key[2]) >= 80;
}

function contractAlphaEdges(data, info, options = {}) {
  const { width, height } = info;
  const pixels = width * height;
  const radius = Math.max(0, Math.min(3, Math.round(Number(options.edge_contract_px ?? 1))));
  const featherRatio = Math.max(0, Math.min(1, Number(options.edge_feather_ratio ?? 0.35)));
  if (!radius || !pixels) {
    return { applied: false, radius, feather_ratio: featherRatio, contracted_pixels: 0, alpha_removed: 0 };
  }
  const sourceAlpha = Buffer.allocUnsafe(pixels);
  for (let pixel = 0; pixel < pixels; pixel += 1) sourceAlpha[pixel] = data[pixel * 4 + 3];
  let contractedPixels = 0;
  let alphaRemoved = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const current = sourceAlpha[pixel];
      if (!current) continue;
      let eroded = current;
      for (let nearbyY = Math.max(0, y - radius); nearbyY <= Math.min(height - 1, y + radius); nearbyY += 1) {
        for (let nearbyX = Math.max(0, x - radius); nearbyX <= Math.min(width - 1, x + radius); nearbyX += 1) {
          eroded = Math.min(eroded, sourceAlpha[nearbyY * width + nearbyX]);
        }
      }
      if (eroded >= current) continue;
      const feathered = clampByte(eroded + ((current - eroded) * featherRatio));
      data[pixel * 4 + 3] = feathered;
      contractedPixels += 1;
      alphaRemoved += current - feathered;
    }
  }
  return {
    applied: contractedPixels > 0,
    radius,
    feather_ratio: featherRatio,
    contracted_pixels: contractedPixels,
    alpha_removed: alphaRemoved,
  };
}

/**
 * Alpha alone is not enough for a chroma-backed cutout. The RGB values under
 * antialiased edge pixels still contain the matte colour and become a bright
 * outline when composited on another background. First unmix the sampled
 * plate colour from partial-alpha pixels, then suppress residual green only
 * on the alpha boundary. Interior colours are deliberately left untouched.
 */
function defringeRgba(data, info, key, options = {}) {
  const { width, height } = info;
  const pixels = width * height;
  const alpha = Buffer.allocUnsafe(pixels);
  const chromaGreen = isChromaGreenKey(key);
  const applyUnmix = options.apply_unmix !== false;
  const radius = Math.max(1, Math.min(4, Math.round(Number(options.edge_radius || 2))));
  const greenTolerance = Math.max(0, Number(options.green_tolerance ?? 8));
  let transparentRgbCleared = 0;
  let unmixedPixels = 0;

  // Some image providers return a PNG with "transparent" checkerboard noise
  // baked into the alpha channel: the subject is opaque, but hundreds of
  // thousands of background pixels sit around alpha 10..60. Normal antialias
  // edges occupy only a narrow band, so a large diffuse low-alpha population
  // is a reliable signal that this is background noise rather than detail.
  const lowAlphaThreshold = Math.max(8, Math.min(96, Math.round(Number(options.low_alpha_threshold || 64))));
  let lowAlphaCandidates = 0;
  let opaquePixels = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const a = data[pixel * 4 + 3];
    if (a > 1 && a <= lowAlphaThreshold) lowAlphaCandidates += 1;
    if (a >= 245) opaquePixels += 1;
  }
  const lowAlphaCandidateRatio = pixels ? lowAlphaCandidates / pixels : 0;
  const opaqueRatio = pixels ? opaquePixels / pixels : 0;
  const lowAlphaCleanupApplied = options.cleanup_low_alpha !== false
    && lowAlphaCandidateRatio >= Number(options.low_alpha_noise_ratio || 0.06)
    && opaqueRatio >= 0.02;
  let lowAlphaCleared = 0;
  if (lowAlphaCleanupApplied) {
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const offset = pixel * 4;
      if (data[offset + 3] <= 1 || data[offset + 3] > lowAlphaThreshold) continue;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 0;
      lowAlphaCleared += 1;
    }
  }

  const edgeContraction = contractAlphaEdges(data, info, options);

  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 4;
    const a = data[offset + 3];
    alpha[pixel] = a;
    if (a <= 1) {
      if (data[offset] || data[offset + 1] || data[offset + 2]) transparentRgbCleared += 1;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      continue;
    }
    if (!applyUnmix || a >= 254) continue;
    const normalizedAlpha = Math.max(1 / 255, a / 255);
    const backgroundWeight = 1 - normalizedAlpha;
    for (let channel = 0; channel < 3; channel += 1) {
      data[offset + channel] = clampByte(
        (data[offset + channel] - Number(key[channel] || 0) * backgroundWeight) / normalizedAlpha,
      );
    }
    unmixedPixels += 1;
  }

  let edgePixels = 0;
  let spillPixelsBefore = 0;
  let despilledPixels = 0;
  if (chromaGreen) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        const a = alpha[pixel];
        if (a < 12) continue;
        let minNeighborAlpha = 255;
        const minY = Math.max(0, y - radius);
        const maxY = Math.min(height - 1, y + radius);
        const minX = Math.max(0, x - radius);
        const maxX = Math.min(width - 1, x + radius);
        for (let nearbyY = minY; nearbyY <= maxY; nearbyY += 1) {
          for (let nearbyX = minX; nearbyX <= maxX; nearbyX += 1) {
            minNeighborAlpha = Math.min(minNeighborAlpha, alpha[nearbyY * width + nearbyX]);
          }
        }
        if (a >= 254 && minNeighborAlpha >= 245) continue;
        edgePixels += 1;
        const offset = pixel * 4;
        const maxRedBlue = Math.max(data[offset], data[offset + 2]);
        const excess = data[offset + 1] - maxRedBlue;
        if (excess <= greenTolerance) continue;
        spillPixelsBefore += 1;
        const edgeStrength = Math.max((255 - a) / 255, (255 - minNeighborAlpha) / 255);
        const targetGreen = maxRedBlue + greenTolerance;
        const correction = Math.min(1, 0.7 + edgeStrength * 0.3);
        data[offset + 1] = clampByte(data[offset + 1] + (targetGreen - data[offset + 1]) * correction);
        despilledPixels += 1;
      }
    }
  }

  let residualKeyEdgePixels = 0;
  if (chromaGreen && edgePixels) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        const a = alpha[pixel];
        if (a < 12) continue;
        let minNeighborAlpha = 255;
        for (let nearbyY = Math.max(0, y - radius); nearbyY <= Math.min(height - 1, y + radius); nearbyY += 1) {
          for (let nearbyX = Math.max(0, x - radius); nearbyX <= Math.min(width - 1, x + radius); nearbyX += 1) {
            minNeighborAlpha = Math.min(minNeighborAlpha, alpha[nearbyY * width + nearbyX]);
          }
        }
        if (a >= 254 && minNeighborAlpha >= 245) continue;
        const offset = pixel * 4;
        if (data[offset + 1] > Math.max(data[offset], data[offset + 2]) + greenTolerance + 4) {
          residualKeyEdgePixels += 1;
        }
      }
    }
  }

  return {
    version: 'edge-defringe-v3',
    key_color: key.map((value) => clampByte(value)),
    chroma_green: chromaGreen,
    unmixed_pixels: unmixedPixels,
    transparent_rgb_cleared: transparentRgbCleared,
    edge_pixels: edgePixels,
    spill_pixels_before: spillPixelsBefore,
    despilled_pixels: despilledPixels,
    residual_key_edge_pixels: residualKeyEdgePixels,
    residual_key_edge_ratio: edgePixels ? Number((residualKeyEdgePixels / edgePixels).toFixed(6)) : 0,
    edge_contraction: edgeContraction,
    low_alpha_cleanup: {
      applied: lowAlphaCleanupApplied,
      threshold: lowAlphaThreshold,
      candidate_pixels: lowAlphaCandidates,
      candidate_ratio: Number(lowAlphaCandidateRatio.toFixed(6)),
      opaque_ratio: Number(opaqueRatio.toFixed(6)),
      cleared_pixels: lowAlphaCleared,
    },
  };
}

async function process(db, cfg, asset, options = {}) {
  const sourceRel = normalizeRelativePath(asset.local_path || asset.image_url?.replace(/^\/static\//, ''));
  const source = resolveStorageFile(cfg, sourceRel);
  if (!source || !fs.existsSync(source) || !isPathInsideReal(resolveStorageRoot(cfg), source)) {
    throw new PaperError('PAPER_ASSET_PATH_INVALID', '抠图源文件不存在或路径非法', { asset_id: asset.id, local_path: sourceRel }, 422);
  }
  const method = options.method || 'green_screen_v1';
  const threshold = Number(options.threshold ?? (['white_v1', 'dark_v1', 'auto'].includes(method) ? 34 : 72));
  const softness = Math.max(1, Number(options.softness ?? 22));
  const input = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(input.data);
  const explicitKey = Array.isArray(options.key_color) && options.key_color.length >= 3;
  const borderEstimate = ['white_v1', 'dark_v1', 'auto'].includes(method) && !explicitKey
    ? estimateBorderKey(data, input.info, method)
    : null;
  const key = borderEstimate?.key || chooseKeyColor(method, options);
  for (let y = 0; y < input.info.height; y += 1) {
    for (let x = 0; x < input.info.width; x += 1) {
      const i = (y * input.info.width + x) * 4;
      const alpha = alphaForPixel(data[i], data[i + 1], data[i + 2], data[i + 3], key, threshold, softness);
      data[i + 3] = alpha;
    }
  }
  const defringe = defringeRgba(data, input.info, key, { apply_unmix: true });
  let transparent = 0;
  let visible = 0;
  let minX = input.info.width;
  let minY = input.info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < input.info.height; y += 1) {
    for (let x = 0; x < input.info.width; x += 1) {
      const alpha = data[(y * input.info.width + x) * 4 + 3];
      if (alpha < 12) transparent += 1;
      else {
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
  const greenEdgeRatio = method === 'green_screen_v1' ? defringe.residual_key_edge_ratio : 0;
  const diagnostics = {
    schema_version: 1,
    method,
    key_color: key,
    key_color_source: explicitKey ? 'manual' : (borderEstimate?.mode === 'white_v1' ? 'border_median' : borderEstimate ? `border_${borderEstimate.mode}` : 'preset'),
    key_confidence: borderEstimate,
    source_hash: sha256File(source),
    width: input.info.width,
    height: input.info.height,
    alpha_bbox: bbox,
    transparent_ratio: Number(transparentRatio.toFixed(6)),
    visible_ratio: Number(visibleRatio.toFixed(6)),
    green_edge_ratio: Number(greenEdgeRatio.toFixed(6)),
    defringe,
    safety_margin: Number(options.safety_margin ?? 0.04),
  };
  const reviewPass = visibleRatio > 0.01 && visibleRatio < 0.99 && (method !== 'green_screen_v1' || greenEdgeRatio <= 0.02);
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

module.exports = {
  process,
  colorDistance,
  alphaForPixel,
  estimateBorderKeyColor,
  estimateBorderKey,
  isChromaGreenKey,
  contractAlphaEdges,
  defringeRgba,
};
