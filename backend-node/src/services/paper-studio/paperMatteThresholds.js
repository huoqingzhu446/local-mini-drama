const ALPHA_GATE = Object.freeze({
  transparent_ratio_min: 0.05,
  visible_ratio_min: 0.005,
  visible_ratio_max: 0.92,
  residual_key_edge_ratio_max: 0.02,
});

function alphaGate({
  transparentRatio,
  visibleRatio,
  residualKeyEdgeRatio = 0,
  checkResidualKey = false,
}) {
  return Number(transparentRatio) >= ALPHA_GATE.transparent_ratio_min
    && Number(visibleRatio) >= ALPHA_GATE.visible_ratio_min
    && Number(visibleRatio) <= ALPHA_GATE.visible_ratio_max
    && (!checkResidualKey || Number(residualKeyEdgeRatio) <= ALPHA_GATE.residual_key_edge_ratio_max);
}

module.exports = { ALPHA_GATE, alphaGate };
