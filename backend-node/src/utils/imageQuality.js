const IMAGE_QUALITY_STANDARD = 'standard';
const IMAGE_QUALITY_HD = 'hd';

function normalizeImageQuality(value, fallback = IMAGE_QUALITY_STANDARD) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === IMAGE_QUALITY_HD || raw === 'high' || raw === 'high_quality') {
    return IMAGE_QUALITY_HD;
  }
  if (raw === IMAGE_QUALITY_STANDARD || raw === 'default' || raw === 'medium') {
    return IMAGE_QUALITY_STANDARD;
  }
  if (fallback === '' || fallback == null) return '';
  if (fallback === IMAGE_QUALITY_HD || fallback === IMAGE_QUALITY_STANDARD) return fallback;
  return normalizeImageQuality(fallback, '');
}

function codexQualityInstruction(value) {
  return normalizeImageQuality(value) === IMAGE_QUALITY_HD
    ? 'Quality target: HD / premium-detail render with crisp textures, refined lighting, and stronger material detail.'
    : 'Quality target: standard concept-art fidelity with clean readability and controlled detail.'
}

module.exports = {
  IMAGE_QUALITY_STANDARD,
  IMAGE_QUALITY_HD,
  normalizeImageQuality,
  codexQualityInstruction,
};
