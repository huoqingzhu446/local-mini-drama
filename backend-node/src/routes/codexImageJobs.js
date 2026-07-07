const response = require('../response');
const codexImageJobService = require('../services/codexImageJobService');

function routes(db, cfg, log) {
  return {
    list: (req, res) => {
      try {
        const { items, total, page, pageSize } = codexImageJobService.listJobs(db, req.query || {});
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('codex-image-jobs list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    get: (req, res) => {
      try {
        const job = codexImageJobService.getJobById(db, req.params.id);
        if (!job) return response.notFound(res, 'Codex 生图任务不存在');
        response.success(res, { job });
      } catch (err) {
        log.error('codex-image-jobs get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const out = codexImageJobService.createJob(db, log, cfg, req.body || {});
        if (!out.ok) return response.badRequest(res, out.error);
        response.created(res, out);
      } catch (err) {
        log.error('codex-image-jobs create', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    pendingExport: (req, res) => {
      try {
        const manifest = codexImageJobService.exportPending(db, cfg);
        response.success(res, manifest);
      } catch (err) {
        log.error('codex-image-jobs pending-export', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    importResults: (req, res) => {
      try {
        const out = codexImageJobService.importResults(db, log, cfg, req.body || {});
        response.success(res, out);
      } catch (err) {
        log.error('codex-image-jobs import-results', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    use: (req, res) => {
      try {
        const out = codexImageJobService.useCandidate(db, log, cfg, req.params.id, req.body || {});
        if (!out.ok) {
          if (out.error === 'job not found') return response.notFound(res, 'Codex 生图任务不存在');
          return response.badRequest(res, out.error);
        }
        response.success(res, out);
      } catch (err) {
        log.error('codex-image-jobs use', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    cancel: (req, res) => {
      try {
        const out = codexImageJobService.cancelJob(db, cfg, req.params.id);
        if (!out.ok) {
          if (out.error === 'job not found') return response.notFound(res, 'Codex 生图任务不存在');
          return response.badRequest(res, out.error);
        }
        response.success(res, out);
      } catch (err) {
        log.error('codex-image-jobs cancel', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = routes;
