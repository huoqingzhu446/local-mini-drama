const Ajv = require('ajv');
const { PaperStudioError } = require('./paperStudioUtils');

const schemas = {
  apiProjectCreate: require('../../paper-studio-schema/api-project-create.schema.json'),
  apiProjectUpdate: require('../../paper-studio-schema/api-project-update.schema.json'),
  apiRunCreate: require('../../paper-studio-schema/api-run-create.schema.json'),
  apiRunAction: require('../../paper-studio-schema/api-run-action.schema.json'),
  apiGenerationAuthorization: require('../../paper-studio-schema/api-generation-authorization.schema.json'),
  apiGenerationAuthorizationExecute: require('../../paper-studio-schema/api-generation-authorization-execute.schema.json'),
  apiShotAction: require('../../paper-studio-schema/api-shot-action.schema.json'),
  apiAssetReview: require('../../paper-studio-schema/api-asset-review.schema.json'),
  apiAssetRematte: require('../../paper-studio-schema/api-asset-rematte.schema.json'),
  apiPreviewReject: require('../../paper-studio-schema/api-preview-reject.schema.json'),
  apiMotionRevise: require('../../paper-studio-schema/api-motion-revise.schema.json'),
  apiPaperEpisodeCreate: require('../../paper-studio-schema/api-paper-episode-create.schema.json'),
  apiPaperExampleDraft: require('../../paper-studio-schema/api-paper-example-draft.schema.json'),
  apiPaperEpisodeUpdate: require('../../paper-studio-schema/api-paper-episode-update.schema.json'),
  apiPaperScriptCreate: require('../../paper-studio-schema/api-paper-script-create.schema.json'),
  apiPaperEntityExtract: require('../../paper-studio-schema/api-paper-entity-extract.schema.json'),
  apiPaperLibraryConfirm: require('../../paper-studio-schema/api-paper-library-confirm.schema.json'),
  apiPaperEntityUpdate: require('../../paper-studio-schema/api-paper-entity-update.schema.json'),
  apiPaperStyleAnchor: require('../../paper-studio-schema/api-paper-style-anchor.schema.json'),
  apiPaperIdentityGenerate: require('../../paper-studio-schema/api-paper-identity-generate.schema.json'),
  apiPaperIdentityReview: require('../../paper-studio-schema/api-paper-identity-review.schema.json'),
  apiPaperStoryboardGenerate: require('../../paper-studio-schema/api-paper-storyboard-generate.schema.json'),
  apiPaperStoryboardsApply: require('../../paper-studio-schema/api-paper-storyboards-apply.schema.json'),
  apiPaperStoryboardCreate: require('../../paper-studio-schema/api-paper-storyboard-create.schema.json'),
  apiPaperStoryboardUpdate: require('../../paper-studio-schema/api-paper-storyboard-update.schema.json'),
  apiPaperStoryboardReorder: require('../../paper-studio-schema/api-paper-storyboard-reorder.schema.json'),
  apiPaperImportLegacy: require('../../paper-studio-schema/api-paper-import-legacy.schema.json'),
  apiPaperReferenceGenerate: require('../../paper-studio-schema/api-paper-reference-generate.schema.json'),
  apiPaperReferenceUpload: require('../../paper-studio-schema/api-paper-reference-upload.schema.json'),
  apiPaperReferenceSelect: require('../../paper-studio-schema/api-paper-reference-select.schema.json'),
  apiPaperReferenceConstraints: require('../../paper-studio-schema/api-paper-reference-constraints.schema.json'),
  apiPaperEpisodeMerge: require('../../paper-studio-schema/api-paper-episode-merge.schema.json'),
  apiPaperAudioTts: require('../../paper-studio-schema/api-paper-audio-tts.schema.json'),
  apiPaperAudioUpload: require('../../paper-studio-schema/api-paper-audio-upload.schema.json'),
  apiPaperAudioRevise: require('../../paper-studio-schema/api-paper-audio-revise.schema.json'),
  apiPaperAudioPolicy: require('../../paper-studio-schema/api-paper-audio-policy.schema.json'),
  apiPaperSyncLegacy: require('../../paper-studio-schema/api-paper-sync-legacy.schema.json'),
  paperBlueprint: require('../../paper-studio-schema/paper-blueprint.schema.json'),
  apiBlueprintUpdate: require('../../paper-studio-schema/api-blueprint-update.schema.json'),
  apiAssetUpload: require('../../paper-studio-schema/api-asset-upload.schema.json'),
  apiAssetMaskPatch: require('../../paper-studio-schema/api-asset-mask-patch.schema.json'),
  semanticContract: require('../../paper-studio-schema/semantic-contract.schema.json'),
  sourceFamily: require('../../paper-studio-schema/source-family.schema.json'),
  compositionNode: require('../../paper-studio-schema/composition-node.schema.json'),
  motionPlan: require('../../paper-studio-schema/motion-plan.schema.json'),
  proofTarget: require('../../paper-studio-schema/proof-target.schema.json'),
  renderSnapshotV3: require('../../paper-studio-schema/render-snapshot-v3.schema.json'),
};

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
for (const schema of Object.values(schemas)) ajv.addSchema(schema);

const validators = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.getSchema(schema.$id)]),
);

function normalizeErrors(errors) {
  return (errors || []).map((error) => ({
    code: error.keyword,
    path: error.instancePath || '/',
    message: error.message || 'schema validation failed',
    params: error.params,
  }));
}

function validate(name, value) {
  const validator = validators[name];
  if (!validator) throw new Error(`Unknown paper studio schema: ${name}`);
  const valid = validator(value);
  return { valid: Boolean(valid), errors: normalizeErrors(validator.errors) };
}

function assertValid(name, value, message = '纸片工作室数据不符合 Schema') {
  const result = validate(name, value);
  if (!result.valid) {
    throw new PaperStudioError(
      'PAPER_STUDIO_SCHEMA_INVALID',
      message,
      { schema: name, errors: result.errors },
      400,
    );
  }
  return value;
}

function doctor() {
  return {
    ok: Object.values(validators).every((validator) => typeof validator === 'function'),
    schema_count: Object.keys(validators).length,
    schemas: Object.keys(validators),
    ajv_version: require('ajv/package.json').version,
  };
}

module.exports = { validate, assertValid, doctor, schemas };
