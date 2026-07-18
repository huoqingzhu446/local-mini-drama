'use strict';

const response = require('../response');
const visualStyleVersionService = require('../services/visualStyleVersionService');
const promptCompiler = require('../services/promptCompiler');

function routes(db, cfg, log) {
  function getDramaId(req) { return Number(req.params.id || req.params.drama_id); }
  return {
    get: (req, res) => {
      try {
        const dramaId = getDramaId(req);
        const active = visualStyleVersionService.ensureActiveVersion(db, dramaId);
        if (!active) return response.notFound(res, '剧本不存在');
        response.success(res, {
          active,
          versions: visualStyleVersionService.listVersions(db, dramaId),
          impact: visualStyleVersionService.impact(db, dramaId),
        });
      } catch (err) {
        log.error('visual style get', { error: err.message });
        response.internalError(res, err.message || '获取视觉风格失败');
      }
    },
    draft: (req, res) => {
      try {
        const dramaId = getDramaId(req);
        const item = visualStyleVersionService.createDraft(db, dramaId, req.body || {});
        if (!item) return response.notFound(res, '剧本不存在');
        response.created(res, { version: item, impact: visualStyleVersionService.impact(db, dramaId) });
      } catch (err) {
        log.error('visual style draft create', { error: err.message });
        response.internalError(res, err.message || '创建视觉风格草稿失败');
      }
    },
    draftUpdate: (req, res) => {
      try {
        const dramaId = getDramaId(req);
        const item = visualStyleVersionService.updateDraft(db, dramaId, req.params.version_id, req.body || {});
        if (!item) return response.notFound(res, '视觉风格草稿不存在');
        response.success(res, { version: item, impact: visualStyleVersionService.impact(db, dramaId) });
      } catch (err) {
        log.error('visual style draft update', { error: err.message });
        response.internalError(res, err.message || '更新视觉风格草稿失败');
      }
    },
    activate: (req, res) => {
      try {
        const dramaId = getDramaId(req);
        const versionId = Number(req.body?.version_id || req.body?.id || req.params.version_id);
        if (!versionId) return response.badRequest(res, '缺少 version_id');
        const item = visualStyleVersionService.activateVersion(db, log, dramaId, versionId);
        if (!item) return response.notFound(res, '视觉风格版本不存在');
        response.success(res, { active: item, impact: visualStyleVersionService.impact(db, dramaId) });
      } catch (err) {
        log.error('visual style activate', { error: err.message });
        response.internalError(res, err.message || '激活视觉风格失败');
      }
    },
    impact: (req, res) => {
      try { response.success(res, visualStyleVersionService.impact(db, getDramaId(req))); }
      catch (err) { response.internalError(res, err.message || '获取风格影响范围失败'); }
    },
    storyboardPreview: (req, res) => {
      try {
        const body = req.body || {};
        const storyboardId = Number(req.params.id);
        const result = promptCompiler.compile(db, cfg, {
          ...body,
          entity_type: 'storyboard',
          entity_id: storyboardId,
          frame_type: body.frame_type || 'main',
          style_version_id: body.style_version_id || body.version_id,
        });
        if (!result.ok) return response.badRequest(res, result.error);
        response.success(res, {
          prompt: result.compiled_prompt,
          negative_prompt: result.compiled_negative_prompt,
          prompt_source: result.prompt_source,
          style_version_id: result.style_version_id,
          style_version: result.style_version,
          style_signature: result.style_signature,
          prompt_state: result.prompt_state,
          reference_pack: result.reference_pack,
          diagnostics: result.diagnostics,
          prompt_hash: result.prompt_hash,
          compiler_version: result.compiler_version,
        });
      } catch (err) {
        log.error('storyboard image prompt preview', { error: err.message });
        response.internalError(res, err.message || '生成提示词预览失败');
      }
    },
  };
}

module.exports = routes;
