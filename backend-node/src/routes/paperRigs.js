const response = require('../response');
const service = require('../services/paperRigService');
function errOut(res, err) { response.error(res, Number(err.status) || 500, err.code || 'INTERNAL_ERROR', err.message || 'rig 操作失败', err.details); }
module.exports = function paperRigRoutes(db) {
  return {
    list(req, res) { try { response.success(res, { rigs: service.list(db, req.query || {}) }); } catch (err) { errOut(res, err); } },
    get(req, res) { try { const out = service.get(db, req.params.id); if (!out) return response.notFound(res, 'rig 不存在'); response.success(res, out); } catch (err) { errOut(res, err); } },
    create(req, res) { try { response.created(res, service.create(db, req.body || {})); } catch (err) { errOut(res, err); } },
    update(req, res) { try { const body = req.body || {}; response.success(res, service.update(db, req.params.id, body, body.expected_version ?? body.version)); } catch (err) { errOut(res, err); } },
    delete(req, res) { try { response.success(res, service.softDelete(db, req.params.id, req.body?.expected_version ?? req.body?.version)); } catch (err) { errOut(res, err); } },
  };
};
