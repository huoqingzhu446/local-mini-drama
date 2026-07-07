const response = require('../response');
const promptStyleService = require('../services/promptStyleService');

function routes(db, log) {
  return {
    list: (req, res) => {
      try {
        response.success(res, {
          styles: promptStyleService.listStyles(db, req.query || {}),
        });
      } catch (err) {
        log.error('prompt styles list', { error: err.message });
        response.internalError(res, err.message || '获取提示词风格失败');
      }
    },
    tags: (_req, res) => {
      try {
        response.success(res, { tags: promptStyleService.listTags(db) });
      } catch (err) {
        log.error('prompt styles tags', { error: err.message });
        response.internalError(res, err.message || '获取标签失败');
      }
    },
    get: (req, res) => {
      try {
        const item = promptStyleService.getStyle(db, req.params.id);
        if (!item) return response.notFound(res, '提示词风格不存在');
        response.success(res, item);
      } catch (err) {
        log.error('prompt styles get', { error: err.message });
        response.internalError(res, err.message || '获取提示词风格失败');
      }
    },
    create: (req, res) => {
      try {
        const item = promptStyleService.createStyle(db, req.body || {});
        log.info('prompt style created', { id: item.id });
        response.created(res, item);
      } catch (err) {
        if (err.code === 'BAD_REQUEST') return response.badRequest(res, err.message);
        log.error('prompt styles create', { error: err.message });
        response.internalError(res, err.message || '创建提示词风格失败');
      }
    },
    update: (req, res) => {
      try {
        const item = promptStyleService.updateStyle(db, req.params.id, req.body || {});
        if (!item) return response.notFound(res, '提示词风格不存在');
        log.info('prompt style updated', { id: item.id });
        response.success(res, item);
      } catch (err) {
        if (err.code === 'BAD_REQUEST') return response.badRequest(res, err.message);
        log.error('prompt styles update', { error: err.message });
        response.internalError(res, err.message || '更新提示词风格失败');
      }
    },
    delete: (req, res) => {
      try {
        const ok = promptStyleService.deleteStyle(db, req.params.id);
        if (!ok) return response.notFound(res, '提示词风格不存在');
        log.info('prompt style deleted', { id: req.params.id });
        response.success(res, { ok: true });
      } catch (err) {
        log.error('prompt styles delete', { error: err.message });
        response.internalError(res, err.message || '删除提示词风格失败');
      }
    },
  };
}

module.exports = { routes };
