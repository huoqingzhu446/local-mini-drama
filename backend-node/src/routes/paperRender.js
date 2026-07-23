const response = require('../response');
const renderService = require('../services/paperRenderService');
const runtimeService = require('../services/paperRuntimeService');
module.exports = function paperRenderRoutes(db, cfg) {
  return {
    doctor(req, res) {
      try { response.success(res, runtimeService.decorateDoctor(renderService.doctor(cfg))); }
      catch (err) { response.error(res, 500, err.code || 'PAPER_RENDER_FAILED', err.message, err.details); }
    },
  };
};
