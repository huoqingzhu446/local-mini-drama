const fs = require('fs');
const os = require('os');
const path = require('path');
const response = require('../response');
const service = require('../services/paperAssetService');

function sendError(res, err) { response.error(res, Number(err.status) || 500, err.code || 'INTERNAL_ERROR', err.message || '纸片资产操作失败', err.details); }

module.exports = function paperAssetRoutes(db, cfg, log, uploadMiddleware) {
  return {
    list(req, res) { try { response.success(res, { assets: service.list(db, req.query || {}) }); } catch (err) { sendError(res, err); } },
    get(req, res) { try { const asset = service.get(db, req.params.id); if (!asset) return response.notFound(res, '纸片资产不存在'); response.success(res, asset); } catch (err) { sendError(res, err); } },
    create(req, res) { try { response.created(res, service.create(db, req.body || {})); } catch (err) { sendError(res, err); } },
    update(req, res) { try { const body = req.body || {}; response.success(res, service.update(db, req.params.id, body, body.expected_version ?? body.version)); } catch (err) { sendError(res, err); } },
    delete(req, res) { try { response.success(res, service.softDelete(db, req.params.id, req.body?.expected_version ?? req.body?.version)); } catch (err) { sendError(res, err); } },
    source(req, res) {
      const file = req.file;
      if (!file?.buffer) return response.badRequest(res, '请选择纸片素材文件');
      const temp = path.join(os.tmpdir(), `paper-asset-${Date.now()}-${Math.random().toString(16).slice(2)}.upload`);
      try {
        fs.writeFileSync(temp, file.buffer);
        service.attachSource(db, cfg, req.params.id, temp, { status: req.body?.status }).then((out) => response.created(res, out)).catch((err) => sendError(res, err)).finally(() => { try { fs.unlinkSync(temp); } catch (_) {} });
      } catch (err) { try { fs.unlinkSync(temp); } catch (_) {} sendError(res, err); }
    },
    matte(req, res) {
      try {
        service.matte(db, cfg, req.params.id, req.body || {}).then((out) => response.accepted(res, out)).catch((err) => sendError(res, err));
      } catch (err) { sendError(res, err); }
    },
  };
};
