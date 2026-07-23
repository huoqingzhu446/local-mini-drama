const response = require('../response');
const service = require('../services/paperCompositionService');

function sendError(res, err) {
  const status = Number(err.status) || (err.code === 'PAPER_NOT_FOUND' ? 404 : 500);
  response.error(res, status, err.code || 'INTERNAL_ERROR', err.message || '纸片合成操作失败', err.details);
}

module.exports = function paperCompositionRoutes(db, cfg, log) {
  return {
    list(req, res) { try { response.success(res, { compositions: service.list(db, req.query || {}) }); } catch (err) { log.error('paper compositions list', { error: err.message }); sendError(res, err); } },
    plan(req, res) { try { const out = service.createOrPlan(db, cfg, log, req.params.id, req.body || {}); response.success(res, out); } catch (err) { log.error('paper composition plan', { error: err.message }); sendError(res, err); } },
    get(req, res) { try { response.success(res, service.get(db, req.params.id)); } catch (err) { sendError(res, err); } },
    update(req, res) { try { const body = req.body || {}; response.success(res, service.update(db, log, req.params.id, body, body.expected_version ?? body.version)); } catch (err) { sendError(res, err); } },
    validation(req, res) { try { response.success(res, service.validation(db, cfg, req.params.id, { readOnly: req.query?.read_only === 'true' })); } catch (err) { sendError(res, err); } },
    lockTiming(req, res) { try { const body = req.body || {}; response.success(res, service.lockTiming(db, cfg, req.params.id, body, body.expected_version ?? body.version)); } catch (err) { sendError(res, err); } },
    proofFrames(req, res) { try { response.accepted(res, service.requestProofFrames(db, cfg, log, req.params.id, req.body || {})); } catch (err) { sendError(res, err); } },
    render(req, res) { try { const out = service.requestRender(db, cfg, log, req.params.id, req.body || {}); if (out.deduplicated) return response.success(res, out); response.accepted(res, out); } catch (err) { sendError(res, err); } },
    duplicate(req, res) { try { response.created(res, service.duplicate(db, log, req.params.id, req.body || {})); } catch (err) { sendError(res, err); } },
    addLayer(req, res) { try { response.created(res, service.addLayer(db, req.params.id, req.body || {}, req.body?.expected_version ?? req.body?.version)); } catch (err) { sendError(res, err); } },
    updateLayer(req, res) { try { const body = req.body || {}; response.success(res, service.updateLayer(db, req.params.id, body, body.expected_version ?? body.version)); } catch (err) { sendError(res, err); } },
    deleteLayer(req, res) { try { response.success(res, service.deleteLayer(db, req.params.id, req.body?.expected_version ?? req.body?.version)); } catch (err) { sendError(res, err); } },
  };
};
