const { PaperStudioError, parseJson } = require('./paperStudioUtils');

function models(row) {
  if (!row?.model) return row?.default_model ? [String(row.default_model)] : [];
  const parsed = parseJson(row.model, null);
  const list = Array.isArray(parsed) ? parsed : [row.model];
  const normalized = list.map(String).map((item) => item.trim()).filter(Boolean);
  if (row.default_model && !normalized.includes(String(row.default_model))) normalized.unshift(String(row.default_model));
  return normalized;
}

function inferredProtocol(row) {
  const explicit = String(row?.api_protocol || '').trim().toLowerCase();
  if (explicit) return explicit;
  const provider = String(row?.provider || '').toLowerCase();
  const model = models(row)[0]?.toLowerCase() || '';
  if (/gemini|google/.test(provider)) return 'gemini';
  if (/nano.?banana/.test(provider) || /nano.?banana/.test(model)) return 'nano_banana';
  if (/dashscope|qwen/.test(provider)) return 'dashscope';
  if (/kling/.test(provider)) return 'kling';
  if (/volc|seedream|doubao/.test(`${provider} ${model}`)) return 'volcengine';
  return 'openai';
}

function overrideCapabilities(row) {
  const settings = parseJson(row?.settings, {});
  return settings.paper_studio_capabilities
    || settings.capabilities?.paper_studio
    || settings.capabilities
    || {};
}

function inferCapabilities(row) {
  const protocol = inferredProtocol(row);
  const model = models(row)[0] || '';
  const provider = String(row?.provider || '').toLowerCase();
  const referenceImages = ['gemini', 'nano_banana', 'dashscope', 'kling', 'volcengine'].includes(protocol)
    || /gpt-image|seedream|doubao|qwen-image|flux-kontext|kontext/i.test(model)
    || /openai|agnes/.test(provider);
  const transparentBackground = /gpt-image/i.test(model);
  const imageEdit = ['gemini', 'nano_banana'].includes(protocol)
    || /gpt-image|kontext|seedream/i.test(model);
  const asyncGeneration = ['nano_banana', 'dashscope', 'kling'].includes(protocol);
  const defaults = {
    reference_images: referenceImages,
    transparent_background: transparentBackground,
    image_edit: imageEdit,
    async_generation: asyncGeneration,
    max_reference_images: referenceImages ? (protocol === 'gemini' ? 9 : 4) : 0,
    local_matte_fallback: true,
    registered_canvas: true,
  };
  const override = overrideCapabilities(row);
  return {
    ...defaults,
    ...Object.fromEntries(Object.entries(override).filter(([key]) => key in defaults)),
  };
}

function describe(row) {
  const capabilities = inferCapabilities(row);
  const modelList = models(row);
  const blocking = [];
  const warnings = [];
  if (!row?.is_active) blocking.push({ code: 'PROVIDER_INACTIVE', message: '图片配置未启用' });
  if (!String(row?.base_url || '').trim()) blocking.push({ code: 'PROVIDER_BASE_URL_MISSING', message: '图片配置缺少 Base URL' });
  if (!modelList.length) blocking.push({ code: 'PROVIDER_MODEL_MISSING', message: '图片配置尚未选择模型' });
  if (!capabilities.reference_images) warnings.push({ code: 'REFERENCE_IMAGES_UNSUPPORTED', message: '该配置不能传入角色/场景参考图，同源状态身份稳定性会降低' });
  if (!capabilities.transparent_background) warnings.push({ code: 'TRANSPARENT_OUTPUT_UNSUPPORTED', message: '该配置不保证透明输出，将使用本地 Alpha 处理并执行边缘门禁' });
  if (!capabilities.image_edit) warnings.push({ code: 'IMAGE_EDIT_UNSUPPORTED', message: '该配置不支持局部编辑，失败槽位只能重新生成而不能定点修复' });
  return {
    id: Number(row.id),
    name: row.name || `${row.provider || 'image'} ${modelList[0] || ''}`.trim(),
    provider: row.provider || '',
    api_protocol: inferredProtocol(row),
    model: row.default_model || modelList[0] || null,
    models: modelList,
    is_default: Boolean(row.is_default),
    is_active: Boolean(row.is_active),
    capabilities,
    ready: blocking.length === 0,
    blocking,
    warnings,
  };
}

function list(db) {
  return db.prepare(
    `SELECT * FROM ai_service_configs
     WHERE service_type IN ('image','storyboard_image') AND deleted_at IS NULL
     ORDER BY is_default DESC, priority DESC, id ASC`,
  ).all().map(describe);
}

function select(db, configId = null) {
  const providers = list(db);
  const selected = configId == null
    ? providers.find((item) => item.ready && item.is_default) || providers.find((item) => item.ready)
    : providers.find((item) => Number(item.id) === Number(configId));
  if (!selected) {
    throw new PaperStudioError(
      'PAPER_STUDIO_IMAGE_PROVIDER_MISSING',
      '没有可用于纸片工作室的图片配置，请先在 AI 配置中启用图片模型',
      { image_provider_config_id: configId == null ? null : Number(configId) },
      409,
    );
  }
  if (!selected.ready) {
    throw new PaperStudioError(
      'PAPER_STUDIO_IMAGE_PROVIDER_NOT_READY',
      '所选图片配置尚未就绪',
      { image_provider_config_id: Number(selected.id), blocking: selected.blocking },
      409,
    );
  }
  return selected;
}

module.exports = { models, inferredProtocol, inferCapabilities, describe, list, select };
