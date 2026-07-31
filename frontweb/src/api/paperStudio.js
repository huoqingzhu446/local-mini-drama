import request from '@/utils/request'

export const paperStudioAPI = {
  getProject(dramaId) {
    return request.get(`/paper-studio/projects/${dramaId}`)
  },
  createProject(dramaId, body) {
    return request.post(`/paper-studio/projects/${dramaId}`, body)
  },
  updateProject(projectId, body) {
    return request.put(`/paper-studio/projects/${projectId}`, body)
  },
  getTaskCenter(projectId) {
    return request.get(`/paper-studio/projects/${projectId}/task-center`)
  },
  recordProductEvent(projectId, body) {
    return request.post(`/paper-studio/projects/${projectId}/events`, body)
  },
  createExampleDraft(projectId, body) {
    return request.post(`/paper-studio/projects/${projectId}/example-draft`, body)
  },
  listPaperEpisodes(projectId) {
    return request.get(`/paper-studio/projects/${projectId}/episodes`)
  },
  createPaperEpisode(projectId, body) {
    return request.post(`/paper-studio/projects/${projectId}/episodes`, body)
  },
  getPaperEpisode(episodeId) {
    return request.get(`/paper-studio/episodes/${episodeId}`)
  },
  updatePaperEpisode(episodeId, body) {
    return request.put(`/paper-studio/episodes/${episodeId}`, body)
  },
  deletePaperEpisode(episodeId, body) {
    return request.delete(`/paper-studio/episodes/${episodeId}`, { data: body })
  },
  listPaperStoryboards(episodeId) {
    return request.get(`/paper-studio/episodes/${episodeId}/storyboards`)
  },
  createPaperStoryboard(episodeId, body) {
    return request.post(`/paper-studio/episodes/${episodeId}/storyboards`, body)
  },
  getPaperStoryboard(storyboardId) {
    return request.get(`/paper-studio/storyboards/${storyboardId}`)
  },
  updatePaperStoryboard(storyboardId, body) {
    return request.put(`/paper-studio/storyboards/${storyboardId}`, body)
  },
  getPaperStoryboardAudio(storyboardId) {
    return request.get(`/paper-studio/storyboards/${storyboardId}/audio`)
  },
  synthesizePaperStoryboardAudio(storyboardId, body) {
    return request.post(`/paper-studio/storyboards/${storyboardId}/audio/tts`, body)
  },
  uploadPaperStoryboardAudio(storyboardId, formData) {
    return request.post(`/paper-studio/storyboards/${storyboardId}/audio/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  revisePaperStoryboardAudio(storyboardId, audioVersionId, body) {
    return request.post(`/paper-studio/storyboards/${storyboardId}/audio/${audioVersionId}/revise`, body)
  },
  updatePaperStoryboardAudioPolicy(storyboardId, body) {
    return request.put(`/paper-studio/storyboards/${storyboardId}/audio-policy`, body)
  },
  deletePaperStoryboard(storyboardId, body) {
    return request.delete(`/paper-studio/storyboards/${storyboardId}`, { data: body })
  },
  duplicatePaperStoryboard(storyboardId, body) {
    return request.post(`/paper-studio/storyboards/${storyboardId}/duplicate`, body)
  },
  reorderPaperStoryboards(episodeId, body) {
    return request.post(`/paper-studio/episodes/${episodeId}/storyboards/reorder`, body)
  },
  listScripts(episodeId) {
    return request.get(`/paper-studio/episodes/${episodeId}/scripts`)
  },
  getScript(episodeId, scriptId) {
    return request.get(`/paper-studio/episodes/${episodeId}/scripts/${scriptId}`)
  },
  createScript(episodeId, body) {
    return request.post(`/paper-studio/episodes/${episodeId}/scripts`, body)
  },
  extractEntities(episodeId, body) {
    return request.post(`/paper-studio/episodes/${episodeId}/extract-entities`, body, { timeout: 300000 })
  },
  getLibrary(projectId) {
    return request.get(`/paper-studio/projects/${projectId}/library`)
  },
  confirmLibrary(projectId, body) {
    return request.post(`/paper-studio/projects/${projectId}/library/confirm`, body)
  },
  updateLibraryEntity(entityId, body) {
    return request.put(`/paper-studio/library/entities/${entityId}`, body)
  },
  setStyleAnchor(projectId, body) {
    return request.put(`/paper-studio/projects/${projectId}/style-anchor`, body)
  },
  generateIdentities(projectId, body) {
    return request.post(`/paper-studio/projects/${projectId}/library/identity/generate`, body, { timeout: 1800000 })
  },
  reviewIdentityVersion(versionId, body) {
    return request.post(`/paper-studio/library/identity-versions/${versionId}/review`, body)
  },
  generateStoryboardsFromScript(episodeId, body) {
    return request.post(`/paper-studio/episodes/${episodeId}/generate-storyboards`, body, { timeout: 300000 })
  },
  repairGeneratedStoryboards(episodeId, body) {
    return request.post(`/paper-studio/episodes/${episodeId}/repair-generated-storyboards`, body, { timeout: 300000 })
  },
  applyGeneratedStoryboards(episodeId, body) {
    return request.post(`/paper-studio/episodes/${episodeId}/apply-generated-storyboards`, body)
  },
  listStoryboardEntityLinks(storyboardId) {
    return request.get(`/paper-studio/storyboards/${storyboardId}/entity-links`)
  },
  importLegacyStoryboards(episodeId, body) {
    return request.post(`/paper-studio/episodes/${episodeId}/import-legacy`, body)
  },
  listPaperEpisodeMerges(episodeId) {
    return request.get(`/paper-studio/episodes/${episodeId}/merges`)
  },
  getPaperEpisodeDelivery(episodeId) {
    return request.get(`/paper-studio/episodes/${episodeId}/delivery`)
  },
  mergePaperEpisode(episodeId, body) {
    return request.post(`/paper-studio/episodes/${episodeId}/merge`, body)
  },
  generatePaperStoryboardReference(storyboardId, body) {
    return request.post(`/paper-studio/storyboards/${storyboardId}/reference/generate`, body)
  },
  listPaperStoryboardReferences(storyboardId) {
    return request.get(`/paper-studio/storyboards/${storyboardId}/references`)
  },
  uploadPaperStoryboardReference(storyboardId, formData) {
    return request.post(`/paper-studio/storyboards/${storyboardId}/reference/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  selectPaperStoryboardReference(storyboardId, referenceId, body) {
    return request.post(`/paper-studio/storyboards/${storyboardId}/references/${referenceId}/select`, body)
  },
  updatePaperStoryboardReferenceConstraints(storyboardId, referenceId, body) {
    return request.put(`/paper-studio/storyboards/${storyboardId}/references/${referenceId}/constraints`, body)
  },
  syncPaperStoryboardToLegacy(storyboardId, body) {
    return request.post(`/paper-studio/storyboards/${storyboardId}/sync-to-legacy`, body)
  },
  listRuns(params = {}) {
    return request.get('/paper-studio/runs', { params })
  },
  listProviders() {
    return request.get('/paper-studio/providers')
  },
  listActions() {
    return request.get('/paper-studio/actions')
  },
  createRun(body) {
    return request.post('/paper-studio/runs', body)
  },
  getRun(runId) {
    return request.get(`/paper-studio/runs/${runId}`)
  },
  analyzeRun(runId, body) {
    return request.post(`/paper-studio/runs/${runId}/analyze`, body)
  },
  confirmPlan(runId, body) {
    return request.post(`/paper-studio/runs/${runId}/confirm-plan`, body)
  },
  generationQuote(runId, body) {
    return request.post(`/paper-studio/runs/${runId}/generation-quote`, body)
  },
  authorizeGeneration(runId, body) {
    return request.post(`/paper-studio/runs/${runId}/generation-authorizations`, body)
  },
  executeGenerationAuthorization(authorizationId, body) {
    return request.post(`/paper-studio/generation-authorizations/${authorizationId}/execute`, body)
  },
  cancelGenerationAuthorization(authorizationId, body) {
    return request.post(`/paper-studio/generation-authorizations/${authorizationId}/cancel`, body)
  },
  advanceRun(runId, body) {
    return request.post(`/paper-studio/runs/${runId}/advance`, body)
  },
  recoverRun(runId, body) {
    return request.post(`/paper-studio/runs/${runId}/recover`, body)
  },
  cancelRun(runId, body) {
    return request.post(`/paper-studio/runs/${runId}/cancel`, body)
  },
  pauseRun(runId, body) {
    return request.post(`/paper-studio/runs/${runId}/pause`, body)
  },
  resumeRun(runId, body) {
    return request.post(`/paper-studio/runs/${runId}/resume`, body)
  },
  listSteps(runId) {
    return request.get(`/paper-studio/runs/${runId}/steps`)
  },
  listEvents(runId) {
    return request.get(`/paper-studio/runs/${runId}/events`)
  },
  listContinuity(runId) {
    return request.get(`/paper-studio/runs/${runId}/continuity`)
  },
  getRunReport(runId) {
    return request.get(`/paper-studio/runs/${runId}/report`)
  },
  getShot(shotId) {
    return request.get(`/paper-studio/shots/${shotId}`)
  },
  getBlueprint(shotId) {
    return request.get(`/paper-studio/shots/${shotId}/blueprint`)
  },
  updateBlueprint(shotId, body) {
    return request.put(`/paper-studio/shots/${shotId}/blueprint`, body)
  },
  confirmBlueprint(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/blueprint/confirm`, body)
  },
  generateAssets(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/generate-assets`, body)
  },
  rematteAssets(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/rematte-assets`, body)
  },
  uploadAssetReplacement(shotId, slotId, formData) {
    return request.post(`/paper-studio/shots/${shotId}/slots/${slotId}/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  patchAssetMask(shotId, assetVersionId, body) {
    return request.post(`/paper-studio/shots/${shotId}/assets/${assetVersionId}/mask-patch`, body)
  },
  reviewAssets(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/review-assets`, body)
  },
  planMotion(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/plan-motion`, body)
  },
  syncAudioTiming(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/sync-audio-timing`, body)
  },
  reviseMotion(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/revise`, body)
  },
  listRevisions(shotId) {
    return request.get(`/paper-studio/shots/${shotId}/revisions`)
  },
  getEvidence(shotId) {
    return request.get(`/paper-studio/shots/${shotId}/evidence`)
  },
  proof(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/proof`, body)
  },
  preview(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/preview`, body)
  },
  approvePreview(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/approve-preview`, body)
  },
  rejectPreview(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/reject-preview`, body)
  },
  renderFormal(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/render`, body)
  },
  publish(shotId, body) {
    return request.post(`/paper-studio/shots/${shotId}/publish`, body)
  },
  doctor() {
    return request.get('/paper-studio/doctor')
  },
}
