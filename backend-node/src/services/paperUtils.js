const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PAPER_RENDERER_VERSION = 'paper-layer-v1';
const PAPER_SCHEMA_VERSION = 2;
const PAPER_PROOF_KINDS = ['first', 'anticipation', 'peak', 'settle', 'final_minus_hold', 'exact_final'];
const PAPER_MAX_LAYERS = 40;
const PAPER_MAX_RIG_PARTS = 12;

class PaperError extends Error {
  constructor(code, message, details, status = 400) {
    super(message);
    this.name = 'PaperError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function normalizeRelativePath(value) {
  if (!value || typeof value !== 'string') return null;
  let raw = value.replace(/\\/g, '/').trim();
  if (raw.startsWith('/static/')) raw = raw.slice('/static/'.length);
  if (raw.startsWith('static/')) raw = raw.slice('static/'.length);
  else if (raw.startsWith('/')) return null;
  raw = raw.replace(/^\/+/, '');
  if (!raw || raw.includes('\0')) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(raw) || /^[a-zA-Z]:\//.test(raw)) return null;
  if (path.posix.isAbsolute(raw)) return null;
  const storageMarker = 'data/storage/';
  const markerIndex = raw.indexOf(storageMarker);
  if (markerIndex >= 0) raw = raw.slice(markerIndex + storageMarker.length);
  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized.includes('/.')) return null;
  return normalized;
}

function resolveStorageRoot(cfg) {
  const configured = cfg?.storage?.local_path || path.join('data', 'storage');
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function resolveStorageFile(cfg, relativePath) {
  const rel = normalizeRelativePath(relativePath);
  if (!rel) return null;
  const root = resolveStorageRoot(cfg);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return null;
  return abs;
}

/** Conservative synchronous image preflight used by the paper gate. */
function inspectImageFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let data;
  try { data = fs.readFileSync(filePath); } catch (_) { return null; }
  if (data.length < 12) return null;
  let width = null;
  let height = null;
  let hasAlpha = false;
  const isPng = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (isPng && data.length >= 26) {
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
    const colorType = data[25];
    hasAlpha = colorType === 4 || colorType === 6;
    let offset = 8;
    while (offset + 12 <= data.length) {
      const size = data.readUInt32BE(offset);
      const type = data.toString('ascii', offset + 4, offset + 8);
      if (type === 'tRNS') hasAlpha = true;
      offset += 12 + size;
      if (type === 'IEND') break;
    }
  } else if (data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > data.length) break;
      const segmentLength = data.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > data.length) break;
      const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (sof && segmentLength >= 7) {
        height = data.readUInt16BE(offset + 3);
        width = data.readUInt16BE(offset + 5);
        break;
      }
      offset += segmentLength;
    }
  } else if (data.toString('ascii', 0, 6) === 'GIF89a' || data.toString('ascii', 0, 6) === 'GIF87a') {
    width = data.readUInt16LE(6);
    height = data.readUInt16LE(8);
    hasAlpha = true;
  } else if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = data.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && data.length >= 30) {
      width = 1 + data[24] + (data[25] << 8) + (data[26] << 16);
      height = 1 + data[27] + (data[28] << 8) + (data[29] << 16);
      hasAlpha = (data[20] & 0x10) !== 0;
    } else if (chunk === 'VP8 ' && data.length >= 30) {
      width = data.readUInt16LE(26) & 0x3fff;
      height = data.readUInt16LE(28) & 0x3fff;
    } else if (chunk === 'VP8L' && data.length >= 25) {
      const bits = data.readUInt32LE(21);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >>> 14) & 0x3fff);
      hasAlpha = true;
    }
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const bbox = { x: 0, y: 0, width: 1, height: 1 };
  return { width, height, has_alpha: Boolean(hasAlpha), content_bbox: bbox, alpha_bbox: bbox };
}

function isPathInsideReal(root, candidate) {
  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    const rel = path.relative(realRoot, realCandidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch (_) {
    return false;
  }
}

function relativeStoragePath(cfg, absolutePath) {
  const root = resolveStorageRoot(cfg);
  const abs = path.resolve(absolutePath);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return null;
  return path.relative(root, abs).split(path.sep).join('/');
}

function asNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseEntityIds(raw) {
  const parsed = parseJson(raw, raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => {
    if (typeof item === 'object' && item) return { id: asNumber(item.id), name: item.name || '' };
    return { id: asNumber(item), name: '' };
  }).filter((item) => item.id != null);
}

function assertExpectedVersion(actual, expected, resource = 'paper resource') {
  if (expected == null || expected === '') return;
  if (Number(expected) !== Number(actual)) {
    throw new PaperError(
      'PAPER_VERSION_CONFLICT',
      `${resource} 已被其他修改，当前版本为 ${actual}`,
      { expected_version: Number(expected), actual_version: Number(actual) },
      409
    );
  }
}

function asPublicStaticPath(relativePath) {
  return relativePath ? `/static/${String(relativePath).replace(/^\/+/, '')}` : null;
}

module.exports = {
  PAPER_RENDERER_VERSION,
  PAPER_SCHEMA_VERSION,
  PAPER_PROOF_KINDS,
  PAPER_MAX_LAYERS,
  PAPER_MAX_RIG_PARTS,
  PaperError,
  nowIso,
  parseJson,
  canonicalize,
  canonicalJson,
  sha256,
  sha256File,
  normalizeRelativePath,
  resolveStorageRoot,
  resolveStorageFile,
  inspectImageFile,
  isPathInsideReal,
  relativeStoragePath,
  asNumber,
  clamp,
  parseEntityIds,
  assertExpectedVersion,
  asPublicStaticPath,
};
