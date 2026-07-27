const response = require('../response');
const projectService = require('../services/paper-studio/paperStudioProjectService');
const runService = require('../services/paper-studio/paperStudioRunService');
const shotService = require('../services/paper-studio/paperStudioShotService');
const doctorService = require('../services/paper-studio/paperStudioDoctorService');
const analyzerService = require('../services/paper-studio/paperStudioAnalyzerService');
const assetProductionService = require('../services/paper-studio/paperAssetProductionService');
const assetReviewService = require('../services/paper-studio/paperAssetReviewService');
const assetWorkspaceService = require('../services/paper-studio/paperAssetWorkspaceService');
const motionGateService = require('../services/paper-studio/paperMotionGateService');
const renderService = require('../services/paper-studio/paperStudioRenderService');
const runControlService = require('../services/paper-studio/paperRunControlService');
const providerCapabilityService = require('../services/paper-studio/paperProviderCapabilityService');
const runAdvanceService = require('../services/paper-studio/paperRunAdvanceService');
const motionRevisionService = require('../services/paper-studio/paperMotionRevisionService');
const continuityService = require('../services/paper-studio/paperContinuityService');
const actionCatalogService = require('../services/paper-studio/paperActionCatalogService');
const runReportService = require('../services/paper-studio/paperRunReportService');
const episodeService = require('../services/paper-studio/paperStudioEpisodeService');
const storyboardService = require('../services/paper-studio/paperStoryboardService');
const scriptService = require('../services/paper-studio/paperScriptService');
const entityExtractionService = require('../services/paper-studio/paperEntityExtractionService');
const libraryService = require('../services/paper-studio/paperLibraryService');
const identityProductionService = require('../services/paper-studio/paperIdentityProductionService');
const storyboardGenerationService = require('../services/paper-studio/paperStoryboardGenerationService');
const storyboardAudioService = require('../services/paper-studio/paperStoryboardAudioService');
const referenceService = require('../services/paper-studio/paperStoryboardReferenceService');
const episodeMergeService = require('../services/paper-studio/paperEpisodeMergeService');
const legacySyncService = require('../services/paper-studio/paperLegacySyncService');
const generationAuthorizationService = require('../services/paper-studio/paperGenerationAuthorizationService');
const eventService = require('../services/paper-studio/paperStudioEventService');
const taskCenterService = require('../services/paper-studio/paperTaskCenterService');
const productEventService = require('../services/paper-studio/paperProductEventService');
const exampleDraftService = require('../services/paper-studio/paperExampleDraftService');

function sendError(res, error) {
  response.error(
    res,
    Number(error.status) || 500,
    error.code || 'PAPER_STUDIO_INTERNAL_ERROR',
    error.message || '纸片工作室操作失败',
    error.details,
  );
}

module.exports = function paperStudioRoutes(db, cfg, log) {
  function handle(label, fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (error) {
        if (log) log.error(label, { error: error.message, code: error.code, details: error.details });
        sendError(res, error);
      }
    };
  }

  return {
    getProjectByDrama: handle('paper studio project get', (req, res) => {
      response.success(res, { project: projectService.getByDrama(db, req.params.drama_id) });
    }),
    createProject: handle('paper studio project create', (req, res) => {
      const result = projectService.create(db, log, req.params.drama_id, req.body || {});
      if (result.created) return response.created(res, result);
      response.success(res, result);
    }),
    updateProject: handle('paper studio project update', (req, res) => {
      response.success(res, { project: projectService.update(db, log, req.params.id, req.body || {}) });
    }),
    getTaskCenter: handle('paper studio task center get', (req, res) => {
      response.success(res, { task_center: taskCenterService.build(db, req.params.project_id) });
    }),
    recordProductEvent: handle('paper studio product event record', (req, res) => {
      response.created(res, { event: productEventService.record(db, req.params.project_id, req.body || {}) });
    }),
    createExampleDraft: handle('paper studio example draft create', (req, res) => {
      const result = exampleDraftService.create(db, log, req.params.project_id, req.body || {});
      if (result.created) return response.created(res, result);
      response.success(res, result);
    }),
    listEpisodes: handle('paper studio episodes list', (req, res) => {
      response.success(res, { episodes: episodeService.list(db, req.params.project_id) });
    }),
    createEpisode: handle('paper studio episode create', (req, res) => {
      const result = episodeService.create(db, log, req.params.project_id, req.body || {});
      if (result.created) return response.created(res, result);
      response.success(res, result);
    }),
    getEpisode: handle('paper studio episode get', (req, res) => {
      response.success(res, { episode: episodeService.get(db, req.params.id), storyboards: storyboardService.list(db, req.params.id) });
    }),
    updateEpisode: handle('paper studio episode update', (req, res) => {
      response.success(res, { episode: episodeService.update(db, log, req.params.id, req.body || {}) });
    }),
    deleteEpisode: handle('paper studio episode delete', (req, res) => {
      response.success(res, episodeService.remove(db, log, req.params.id, req.body || {}));
    }),
    listStoryboards: handle('paper storyboards list', (req, res) => {
      response.success(res, { storyboards: storyboardService.list(db, req.params.episode_id) });
    }),
    createStoryboard: handle('paper storyboard create', (req, res) => {
      const result = storyboardService.create(db, log, req.params.episode_id, req.body || {});
      if (result.created) return response.created(res, result);
      response.success(res, result);
    }),
    getStoryboard: handle('paper storyboard get', (req, res) => {
      response.success(res, { storyboard: storyboardService.get(db, req.params.id) });
    }),
    updateStoryboard: handle('paper storyboard update', (req, res) => {
      response.success(res, { storyboard: storyboardService.update(db, log, req.params.id, req.body || {}) });
    }),
    getStoryboardAudio: handle('paper storyboard audio get', (req, res) => {
      response.success(res, { audio: storyboardAudioService.workspace(db, cfg, req.params.id) });
    }),
    synthesizeStoryboardAudio: handle('paper storyboard audio tts', async (req, res) => {
      response.success(res, await storyboardAudioService.synthesize(db, cfg, log, req.params.id, req.body || {}));
    }),
    uploadStoryboardAudio: handle('paper storyboard audio upload', async (req, res) => {
      response.success(res, await storyboardAudioService.upload(db, cfg, log, req.params.id, req.body || {}, req.file));
    }),
    reviseStoryboardAudio: handle('paper storyboard audio revise', (req, res) => {
      response.success(res, storyboardAudioService.revise(db, cfg, log, req.params.id, req.params.audio_version_id, req.body || {}));
    }),
    updateStoryboardAudioPolicy: handle('paper storyboard audio policy', (req, res) => {
      response.success(res, storyboardAudioService.setPolicy(db, cfg, log, req.params.id, req.body || {}));
    }),
    deleteStoryboard: handle('paper storyboard delete', (req, res) => {
      response.success(res, storyboardService.remove(db, log, req.params.id, req.body || {}));
    }),
    duplicateStoryboard: handle('paper storyboard duplicate', (req, res) => {
      const result = storyboardService.duplicate(db, log, req.params.id, req.body || {});
      if (result.created) return response.created(res, result);
      response.success(res, result);
    }),
    reorderStoryboards: handle('paper storyboards reorder', (req, res) => {
      response.success(res, { storyboards: storyboardService.reorder(db, log, req.params.episode_id, req.body || {}) });
    }),
    listScripts: handle('paper scripts list', (req, res) => {
      response.success(res, { scripts: scriptService.list(db, req.params.episode_id), latest: scriptService.latest(db, req.params.episode_id) });
    }),
    getScript: handle('paper script get', (req, res) => {
      response.success(res, { script: scriptService.getForEpisode(db, req.params.episode_id, req.params.script_id) });
    }),
    createScript: handle('paper script create', (req, res) => {
      const result = scriptService.create(db, log, req.params.episode_id, req.body || {});
      if (result.created) return response.created(res, result);
      response.success(res, result);
    }),
    extractEntities: handle('paper entities extract', async (req, res) => {
      response.success(res, await entityExtractionService.extract(db, cfg, log, req.params.episode_id, req.body || {}));
    }),
    getLibrary: handle('paper library get', (req, res) => {
      response.success(res, { library: libraryService.library(db, req.params.project_id, { includeArchived: req.query?.include_archived === '1' }) });
    }),
    confirmLibrary: handle('paper library confirm', (req, res) => {
      response.success(res, libraryService.confirm(db, log, req.params.project_id, req.body || {}));
    }),
    updateLibraryEntity: handle('paper library entity update', (req, res) => {
      response.success(res, { entity: libraryService.updateEntity(db, log, req.params.id, req.body || {}) });
    }),
    setStyleAnchor: handle('paper style anchor set', (req, res) => {
      response.success(res, libraryService.setStyleAnchor(db, log, req.params.project_id, req.body || {}));
    }),
    generateIdentities: handle('paper identities generate', async (req, res) => {
      response.success(res, await identityProductionService.generate(db, cfg, log, req.params.project_id, req.body || {}));
    }),
    reviewIdentityVersion: handle('paper identity review', (req, res) => {
      response.success(res, identityProductionService.review(db, log, req.params.id, req.body || {}));
    }),
    generateStoryboardsFromScript: handle('paper storyboards generate', async (req, res) => {
      response.success(res, await storyboardGenerationService.generate(db, cfg, log, req.params.episode_id, req.body || {}));
    }),
    applyGeneratedStoryboards: handle('paper storyboards apply', (req, res) => {
      response.success(res, storyboardGenerationService.apply(db, log, req.params.episode_id, req.body || {}));
    }),
    listStoryboardEntityLinks: handle('paper storyboard entity links', (req, res) => {
      response.success(res, { links: storyboardGenerationService.listEntityLinks(db, req.params.id) });
    }),
    importLegacyStoryboards: handle('paper storyboards legacy import', (req, res) => {
      response.success(res, storyboardService.importLegacy(db, log, req.params.episode_id, req.body || {}));
    }),
    listEpisodeMerges: handle('paper episode merges list', (req, res) => {
      response.success(res, { merges: episodeMergeService.list(db, req.params.id) });
    }),
    getEpisodeDelivery: handle('paper episode delivery get', (req, res) => {
      response.success(res, { delivery: episodeMergeService.deliveryBoard(db, cfg, req.params.id) });
    }),
    mergeEpisode: handle('paper episode merge', (req, res) => {
      response.created(res, episodeMergeService.create(db, cfg, log, req.params.id, req.body || {}));
    }),
    generateStoryboardReference: handle('paper storyboard reference generate', async (req, res) => {
      response.success(res, await referenceService.generate(db, cfg, log, req.params.id, req.body || {}));
    }),
    listStoryboardReferences: handle('paper storyboard references list', (req, res) => {
      response.success(res, { references: referenceService.list(db, req.params.id) });
    }),
    uploadStoryboardReference: handle('paper storyboard reference upload', async (req, res) => {
      response.success(res, await referenceService.upload(db, cfg, log, req.params.id, req.body || {}, req.file));
    }),
    selectStoryboardReference: handle('paper storyboard reference select', (req, res) => {
      response.success(res, referenceService.select(db, log, req.params.id, req.params.reference_id, req.body || {}));
    }),
    updateStoryboardReferenceConstraints: handle('paper storyboard reference constraints update', (req, res) => {
      response.success(res, referenceService.updateConstraints(db, log, req.params.id, req.params.reference_id, req.body || {}));
    }),
    syncStoryboardToLegacy: handle('paper storyboard legacy sync', (req, res) => {
      response.success(res, legacySyncService.sync(db, log, req.params.id, req.body || {}));
    }),
    listRuns: handle('paper studio runs list', (req, res) => {
      response.success(res, { runs: runService.list(db, req.query || {}) });
    }),
    listProviders: handle('paper studio providers list', (req, res) => {
      response.success(res, { providers: providerCapabilityService.list(db) });
    }),
    listActions: handle('paper studio actions list', (req, res) => {
      response.success(res, { actions: actionCatalogService.list() });
    }),
    createRun: handle('paper studio run create', (req, res) => {
      const result = runService.create(db, log, req.body || {});
      if (result.created) return response.created(res, result);
      response.success(res, result);
    }),
    getRun: handle('paper studio run get', (req, res) => {
      response.success(res, { run: runService.get(db, req.params.id) });
    }),
    analyzeRun: handle('paper studio run analyze', (req, res) => {
      response.success(res, analyzerService.analyzeRun(db, log, req.params.id, req.body || {}, {
        fps: cfg?.paper_studio?.fps || 30,
      }));
    }),
    confirmPlan: handle('paper studio plan confirm', (req, res) => {
      response.success(res, analyzerService.confirmPlan(db, log, req.params.id, req.body || {}));
    }),
    generationQuote: handle('paper studio generation quote', (req, res) => {
      response.success(res, { quote: generationAuthorizationService.buildQuote(db, req.params.id, req.body || {}) });
    }),
    authorizeGeneration: handle('paper studio generation authorize', (req, res) => {
      const result = generationAuthorizationService.authorize(db, log, req.params.id, req.body || {});
      if (result.created) return response.created(res, result);
      response.success(res, result);
    }),
    executeGenerationAuthorization: handle('paper studio generation execute', (req, res) => {
      response.success(res, generationAuthorizationService.execute(db, log, req.params.id, req.body || {}));
    }),
    cancelGenerationAuthorization: handle('paper studio generation authorization cancel', (req, res) => {
      response.success(res, generationAuthorizationService.cancel(db, log, req.params.id, req.body || {}));
    }),
    advanceRun: handle('paper studio run advance', async (req, res) => {
      response.success(res, await runAdvanceService.advance(db, cfg, log, req.params.id, req.body || {}));
    }),
    recoverRun: handle('paper studio run recover', (req, res) => {
      response.success(res, runControlService.recover(db, log, req.params.id, req.body || {}));
    }),
    cancelRun: handle('paper studio run cancel', (req, res) => {
      response.success(res, runControlService.cancel(db, log, req.params.id, req.body || {}));
    }),
    pauseRun: handle('paper studio run pause', (req, res) => {
      response.success(res, runControlService.pause(db, log, req.params.id, req.body || {}));
    }),
    resumeRun: handle('paper studio run resume', (req, res) => {
      response.success(res, runControlService.resume(db, log, req.params.id, req.body || {}));
    }),
    listSteps: handle('paper studio run steps', (req, res) => {
      response.success(res, { steps: runControlService.steps(db, req.params.id) });
    }),
    listEvents: handle('paper studio run events', (req, res) => {
      runService.get(db, req.params.id);
      response.success(res, { events: eventService.list(db, req.params.id, req.query || {}) });
    }),
    listContinuity: handle('paper studio continuity list', (req, res) => {
      runService.get(db, req.params.id);
      response.success(res, { continuity: continuityService.listForRun(db, req.params.id) });
    }),
    getRunReport: handle('paper studio run report', (req, res) => {
      response.success(res, { report: runReportService.build(db, req.params.id) });
    }),
    getShot: handle('paper studio shot get', (req, res) => {
      const shot = shotService.get(db, req.params.id);
      if (shot.paper_storyboard_id) shot.audio = storyboardAudioService.workspace(db, cfg, shot.paper_storyboard_id, shot.storyboard);
      response.success(res, { shot });
    }),
    getBlueprint: handle('paper studio blueprint get', (req, res) => {
      response.success(res, { blueprint: analyzerService.getBlueprint(db, req.params.id) });
    }),
    updateBlueprint: handle('paper studio blueprint update', (req, res) => {
      response.success(res, analyzerService.updateBlueprint(db, log, req.params.id, req.body || {}, {
        fps: cfg?.paper_studio?.fps || 30,
      }));
    }),
    confirmBlueprint: handle('paper studio blueprint confirm', (req, res) => {
      response.success(res, analyzerService.confirmBlueprint(db, log, req.params.id, req.body || {}));
    }),
    generateAssets: handle('paper studio assets generate', async (req, res) => {
      response.success(res, await assetProductionService.generateAssets(db, cfg, log, req.params.id, req.body || {}));
    }),
    rematteAssets: handle('paper studio assets rematte', async (req, res) => {
      response.success(res, await assetProductionService.rematteAssets(db, cfg, log, req.params.id, req.body || {}));
    }),
    uploadAssetReplacement: handle('paper studio asset replacement upload', async (req, res) => {
      response.success(res, await assetWorkspaceService.uploadReplacement(db, cfg, log, req.params.id, req.params.slot_id, req.body || {}, req.file));
    }),
    patchAssetMask: handle('paper studio asset mask patch', async (req, res) => {
      response.success(res, await assetWorkspaceService.patchMask(db, cfg, log, req.params.id, req.params.asset_version_id, req.body || {}));
    }),
    reviewAssets: handle('paper studio assets review', (req, res) => {
      response.success(res, assetReviewService.review(db, log, req.params.id, req.body || {}));
    }),
    planMotion: handle('paper studio motion plan', (req, res) => {
      response.success(res, motionGateService.planMotion(db, cfg, log, req.params.id, req.body || {}));
    }),
    reviseMotion: handle('paper studio motion revise', (req, res) => {
      response.success(res, motionRevisionService.revise(db, cfg, log, req.params.id, req.body || {}));
    }),
    listRevisions: handle('paper studio motion revisions list', (req, res) => {
      shotService.get(db, req.params.id);
      response.success(res, { revisions: motionRevisionService.list(db, req.params.id) });
    }),
    getEvidence: handle('paper studio evidence get', (req, res) => {
      const shot = shotService.get(db, req.params.id);
      response.success(res, { evidence: shot.evidence, proof_runs: shot.proof_runs });
    }),
    proof: handle('paper studio proof', async (req, res) => {
      response.success(res, await renderService.proof(db, cfg, log, req.params.id, req.body || {}));
    }),
    preview: handle('paper studio preview', async (req, res) => {
      response.success(res, await renderService.preview(db, cfg, log, req.params.id, req.body || {}));
    }),
    approvePreview: handle('paper studio preview approve', (req, res) => {
      response.success(res, renderService.approvePreview(db, cfg, log, req.params.id, req.body || {}));
    }),
    rejectPreview: handle('paper studio preview reject', (req, res) => {
      response.success(res, renderService.rejectPreview(db, cfg, log, req.params.id, req.body || {}));
    }),
    renderFormal: handle('paper studio formal render', async (req, res) => {
      response.success(res, await renderService.renderFormal(db, cfg, log, req.params.id, req.body || {}));
    }),
    publish: handle('paper studio publish', (req, res) => {
      response.success(res, renderService.publish(db, cfg, log, req.params.id, req.body || {}));
    }),
    doctor: handle('paper studio doctor', (req, res) => {
      response.success(res, doctorService.doctor(db, cfg));
    }),
  };
};
