const crypto = require('crypto');

class PaperStudioError extends Error {
  constructor(code, message, details = null, status = 400) {
    super(message);
    this.name = 'PaperStudioError';
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
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return `sha256:${crypto.createHash('sha256').update(input).digest('hex')}`;
}

function assertExpectedVersion(current, expected, label) {
  const actual = Number(current);
  const wanted = Number(expected);
  if (!Number.isInteger(wanted) || wanted < 1) {
    throw new PaperStudioError(
      'PAPER_STUDIO_VERSION_REQUIRED',
      `${label || '记录'}缺少有效 expected_version`,
      { current_version: actual },
      400,
    );
  }
  if (actual !== wanted) {
    throw new PaperStudioError(
      'PAPER_STUDIO_VERSION_CONFLICT',
      `${label || '记录'}已被更新，请刷新后重试`,
      { current_version: actual, expected_version: wanted },
      409,
    );
  }
}

function placeholders(items) {
  return items.map(() => '?').join(', ');
}

module.exports = {
  PaperStudioError,
  nowIso,
  parseJson,
  canonicalize,
  canonicalJson,
  sha256,
  assertExpectedVersion,
  placeholders,
};
