// P5：实体库素材 → 生产槽位的零调用复用（C1/C4）。
// 提供纯查询能力：根据分镜实体绑定和实体的已批准形象，为素材槽位解析本地复用来源。
// 命中后走 paperAssetProductionService.importSource（derivation: source_import），不消耗图片 API。

function approvedIdentityForEntity(db, entityId) {
  return db.prepare(
    `SELECT iv.id AS identity_version_id, iv.version_number, iv.source_local_path, iv.alpha_local_path,
            ple.id AS entity_id, ple.name, ple.entity_type
     FROM paper_library_entities ple
     JOIN paper_library_identity_versions iv ON iv.id = ple.current_identity_version_id AND iv.status = 'approved'
     WHERE ple.id = ? AND ple.deleted_at IS NULL`,
  ).get(Number(entityId)) || null;
}

function approvedLinks(db, paperStoryboardId) {
  return db.prepare(
    `SELECT link.role, link.sort_order, ple.id AS entity_id, ple.name, ple.entity_type, ple.aliases_json,
            iv.id AS identity_version_id, iv.source_local_path, iv.alpha_local_path
     FROM paper_storyboard_entity_links link
     JOIN paper_library_entities ple ON ple.id = link.entity_id AND ple.deleted_at IS NULL
     LEFT JOIN paper_library_identity_versions iv
       ON iv.id = ple.current_identity_version_id AND iv.status = 'approved'
     WHERE link.paper_storyboard_id = ?
     ORDER BY link.sort_order, link.id`,
  ).all(Number(paperStoryboardId));
}

function toSource(row, preferAlpha) {
  const localPath = preferAlpha ? (row.alpha_local_path || row.source_local_path) : (row.source_local_path || row.alpha_local_path);
  if (!localPath || !row.identity_version_id) return null;
  return {
    local_path: localPath,
    source_kind: 'paper_library',
    source_id: Number(row.entity_id),
    identity_version_id: Number(row.identity_version_id),
    entity_name: row.name,
  };
}

/**
 * 为素材槽位解析实体库复用来源；不命中返回 null（回落到原有 image_api 流程）。
 * 命中规则：
 * - 槽位约束里带 source_paper_entity_id（蓝图编译时由绑定实体写入）→ 直接按实体查已批准形象；
 * - clean_plate 环境槽位 → 分镜绑定的场景实体（唯一 scene 角色链接）；
 * - 角色/道具 cutout 槽位 → 按约束 identity 文本与绑定实体名称/别名匹配；仅有一个候选时直接采用。
 */
function sourceForSlot(db, shot, slot) {
  const constraints = slot.constraints_json || slot.constraints || {};
  if (constraints.allow_source_import === false) return null;

  if (constraints.source_paper_entity_id) {
    const row = approvedIdentityForEntity(db, constraints.source_paper_entity_id);
    if (row) return toSource(row, row.entity_type !== 'scene');
  }

  const paperStoryboardId = Number(shot?.paper_storyboard_id || 0);
  if (!paperStoryboardId) return null;
  const links = approvedLinks(db, paperStoryboardId);
  if (!links.length) return null;

  const assetType = String(slot.asset_type || '');
  if (assetType === 'environment') {
    const scene = links.find((link) => link.entity_type === 'scene' && link.identity_version_id);
    return scene ? toSource(scene, false) : null;
  }

  const wantedType = /prop/.test(assetType) ? 'prop' : (/character|subject/.test(assetType) ? 'character' : null);
  if (!wantedType) return null;
  const candidates = links.filter((link) => link.entity_type === wantedType && link.identity_version_id);
  if (!candidates.length) return null;

  const identity = String(constraints.identity || '').normalize('NFKC');
  if (identity) {
    const hit = candidates.find((link) => {
      if (identity.includes(link.name) || link.name.includes(identity)) return true;
      try {
        return JSON.parse(link.aliases_json || '[]').some((alias) => alias && identity.includes(alias));
      } catch (_) {
        return false;
      }
    });
    if (hit) return toSource(hit, true);
  }
  // 没有身份文本可匹配时，仅在无歧义（只有一个候选）时复用
  return candidates.length === 1 ? toSource(candidates[0], true) : null;
}

module.exports = { sourceForSlot, approvedLinks, approvedIdentityForEntity };
