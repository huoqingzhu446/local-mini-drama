const response = require('../response');
const generationStyleService = require('../services/generationStyleService');

function routes(db, log) {
  return {
    list: (req, res) => {
      try {
        response.success(res, {
          styles: generationStyleService.listStyles(db, req.query || {}),
        });
      } catch (err) {
        log.error('generation styles list', { error: err.message });
        response.internalError(res, err.message || '获取生成风格失败');
      }
    },
    get: (req, res) => {
      try {
        const item = generationStyleService.getStyle(db, req.params.id);
        if (!item) return response.notFound(res, '生成风格不存在');
        response.success(res, item);
      } catch (err) {
        log.error('generation styles get', { error: err.message });
        response.internalError(res, err.message || '获取生成风格失败');
      }
    },
    create: (req, res) => {
      try {
        const item = generationStyleService.createStyle(db, req.body || {});
        log.info('generation style created', { id: item.id });
        response.created(res, item);
      } catch (err) {
        if (err.code === 'BAD_REQUEST') return response.badRequest(res, err.message);
        log.error('generation styles create', { error: err.message });
        response.internalError(res, err.message || '创建生成风格失败');
      }
    },
    update: (req, res) => {
      try {
        const item = generationStyleService.updateStyle(db, req.params.id, req.body || {});
        if (!item) return response.notFound(res, '生成风格不存在');
        log.info('generation style updated', { id: item.id });
        response.success(res, item);
      } catch (err) {
        if (err.code === 'BAD_REQUEST') return response.badRequest(res, err.message);
        log.error('generation styles update', { error: err.message });
        response.internalError(res, err.message || '更新生成风格失败');
      }
    },
    delete: (req, res) => {
      try {
        const ok = generationStyleService.deleteStyle(db, req.params.id);
        if (!ok) return response.notFound(res, '生成风格不存在');
        log.info('generation style deleted', { id: req.params.id });
        response.success(res, { ok: true });
      } catch (err) {
        log.error('generation styles delete', { error: err.message });
        response.internalError(res, err.message || '删除生成风格失败');
      }
    },
  };
}

module.exports = { routes };
