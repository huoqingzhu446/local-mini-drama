import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { dramaAPI } from '@/api/drama'
import { paperStudioAPI } from '@/api/paperStudio'

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const value = Math.floor(Math.random() * 16)
    const nibble = token === 'x' ? value : ((value & 0x3) | 0x8)
    return nibble.toString(16)
  })
}

export const usePaperStudioStore = defineStore('paperStudio', () => {
  const drama = ref(null)
  const project = ref(null)
  const runs = ref([])
  const providers = ref([])
  const actions = ref([])
  const paperEpisodes = ref([])
  const paperStoryboards = ref([])
  const episodeMerges = ref([])
  const scripts = ref([])
  const latestScript = ref(null)
  const library = ref(null)
  const extractionResult = ref(null)
  const extracting = ref(false)
  const identityGenerating = ref(false)
  const storyboardDraft = ref(null)
  const storyboardGenerating = ref(false)
  const storyboardRepairing = ref(false)
  const storyboardRepairPreview = ref(null)
  const currentStoryboardRepairing = ref(false)
  const currentStoryboardRepairPreview = ref(null)
  const episodeDelivery = ref(null)
  const taskCenter = ref(null)
  const taskCenterLoading = ref(false)
  const runEvents = ref([])
  const referenceCandidates = ref([])
  const currentAudio = ref(null)
  const draftByStoryboardId = ref({})
  const draftDirtyByStoryboardId = ref({})
  const saveStateByStoryboardId = ref({})
  const currentRun = ref(null)
  const currentShot = ref(null)
  const currentPaperStoryboard = ref(null)
  const selectedEpisodeId = ref(null)
  const selectedStoryboardIds = ref([])
  const doctor = ref(null)
  const loading = ref(false)
  const creatingRun = ref(false)
  const acting = ref(false)
  const authoring = ref(false)
  const error = ref(null)
  const errorContext = ref(null)

  watch(error, (message) => {
    if (!message) errorContext.value = null
  }, { flush: 'sync' })

  function captureErrorContext(cause) {
    const code = cause?.apiCode || cause?.code || null
    const details = cause?.apiDetails || cause?.details || null
    errorContext.value = code || details ? { code, details } : null
  }

  const episodes = computed(() => paperEpisodes.value)
  const legacyEpisodes = computed(() => drama.value?.episodes || [])
  const currentEpisode = computed(() => (
    episodes.value.find((episode) => Number(episode.id) === Number(selectedEpisodeId.value)) || null
  ))
  const storyboards = computed(() => paperStoryboards.value)
  const hasUnsavedDrafts = computed(() => Object.values(draftDirtyByStoryboardId.value).some(Boolean))

  function setStoryboardDraft(storyboardId, payload, dirty) {
    const id = Number(storyboardId)
    if (!id) return
    draftByStoryboardId.value = { ...draftByStoryboardId.value, [id]: payload }
    draftDirtyByStoryboardId.value = { ...draftDirtyByStoryboardId.value, [id]: Boolean(dirty) }
    if (dirty && Number(currentStoryboardRepairPreview.value?.paper_storyboard_id) === id) {
      currentStoryboardRepairPreview.value = null
    }
    if (dirty && saveStateByStoryboardId.value[id] !== 'saving') {
      saveStateByStoryboardId.value = { ...saveStateByStoryboardId.value, [id]: 'unsaved' }
    } else if (!dirty && saveStateByStoryboardId.value[id] !== 'saving') {
      saveStateByStoryboardId.value = { ...saveStateByStoryboardId.value, [id]: 'saved' }
    }
  }

  async function ensureProject(dramaId) {
    const response = await paperStudioAPI.createProject(dramaId, { request_id: requestId() })
    project.value = response.project
    return project.value
  }

  async function loadRuns({ taskCenterSilent = false } = {}) {
    if (!project.value) {
      runs.value = []
      return []
    }
    const response = await paperStudioAPI.listRuns({
      project_id: project.value.id,
    })
    runs.value = response.runs || []
    await loadTaskCenter({ silent: taskCenterSilent })
    return runs.value
  }

  async function loadTaskCenter({ silent = false } = {}) {
    if (!project.value?.id) {
      taskCenter.value = null
      return null
    }
    if (!silent) taskCenterLoading.value = true
    try {
      const response = await paperStudioAPI.getTaskCenter(project.value.id)
      taskCenter.value = response.task_center || null
      return taskCenter.value
    } catch (_) {
      return taskCenter.value
    } finally {
      if (!silent) taskCenterLoading.value = false
    }
  }

  async function recordProductEvent(eventName, context = {}, ids = {}) {
    if (!project.value?.id) return null
    try {
      return await paperStudioAPI.recordProductEvent(project.value.id, {
        event_name: eventName,
        paper_episode_id: ids.paper_episode_id ?? selectedEpisodeId.value ?? undefined,
        paper_storyboard_id: ids.paper_storyboard_id ?? currentPaperStoryboard.value?.id ?? currentShot.value?.paper_storyboard_id ?? undefined,
        run_id: ids.run_id ?? currentRun.value?.id ?? undefined,
        shot_id: ids.shot_id ?? currentShot.value?.id ?? undefined,
        context,
      })
    } catch (_) {
      return null
    }
  }

  async function loadEpisodeStoryboards(episodeId) {
    if (!episodeId) {
      paperStoryboards.value = []
      currentPaperStoryboard.value = null
      selectedStoryboardIds.value = []
      referenceCandidates.value = []
      currentAudio.value = null
      return []
    }
    const response = await paperStudioAPI.listPaperStoryboards(episodeId)
    paperStoryboards.value = response.storyboards || []
    const currentId = Number(currentPaperStoryboard.value?.id || 0)
    currentPaperStoryboard.value = paperStoryboards.value.find((item) => Number(item.id) === currentId)
      || paperStoryboards.value[0]
      || null
    const available = new Set(paperStoryboards.value.map((item) => Number(item.id)))
    selectedStoryboardIds.value = selectedStoryboardIds.value.filter((id) => available.has(Number(id)))
    if (!selectedStoryboardIds.value.length) selectedStoryboardIds.value = paperStoryboards.value.map((shot) => Number(shot.id))
    return paperStoryboards.value
  }

  async function loadReferenceCandidates(storyboardId = currentPaperStoryboard.value?.id) {
    if (!storyboardId) {
      referenceCandidates.value = []
      return []
    }
    const response = await paperStudioAPI.listPaperStoryboardReferences(storyboardId)
    if (Number(currentPaperStoryboard.value?.id) === Number(storyboardId)) {
      referenceCandidates.value = response.references || []
    }
    return response.references || []
  }

  async function loadStoryboardAudio(storyboardId = currentPaperStoryboard.value?.id) {
    if (!storyboardId) {
      currentAudio.value = null
      return null
    }
    const response = await paperStudioAPI.getPaperStoryboardAudio(storyboardId)
    if (Number(currentPaperStoryboard.value?.id) === Number(storyboardId)) currentAudio.value = response.audio || null
    return response.audio || null
  }

  async function loadPaperEpisodes(preferredId = null) {
    if (!project.value) return []
    const response = await paperStudioAPI.listPaperEpisodes(project.value.id)
    paperEpisodes.value = response.episodes || []
    if (preferredId && paperEpisodes.value.some((item) => Number(item.id) === Number(preferredId))) {
      selectedEpisodeId.value = Number(preferredId)
      loadScripts(Number(preferredId)).catch(() => {})
    }
    return paperEpisodes.value
  }

  async function loadEpisodeMerges() {
    if (!selectedEpisodeId.value) {
      episodeMerges.value = []
      return []
    }
    const response = await paperStudioAPI.listPaperEpisodeMerges(selectedEpisodeId.value)
    episodeMerges.value = response.merges || []
    return episodeMerges.value
  }

  async function loadEpisodeDelivery() {
    if (!selectedEpisodeId.value) {
      episodeDelivery.value = null
      return null
    }
    const response = await paperStudioAPI.getPaperEpisodeDelivery(selectedEpisodeId.value)
    episodeDelivery.value = response.delivery || null
    if (episodeDelivery.value?.merges) episodeMerges.value = episodeDelivery.value.merges
    return episodeDelivery.value
  }

  async function selectEpisode(episodeId) {
    selectedEpisodeId.value = Number(episodeId)
    currentRun.value = null
    currentShot.value = null
    await loadEpisodeStoryboards(episodeId)
    await Promise.all([loadEpisodeMerges(), loadEpisodeDelivery(), loadScripts(episodeId)])
    await Promise.all([loadReferenceCandidates(), loadStoryboardAudio()])
  }

  async function loadWorkspace(dramaId, options = {}) {
    loading.value = true
    error.value = null
    try {
      const [dramaResult, doctorResult, providerResult, actionResult] = await Promise.all([
        dramaAPI.get(dramaId),
        paperStudioAPI.doctor(),
        paperStudioAPI.listProviders(),
        paperStudioAPI.listActions(),
      ])
      drama.value = dramaResult
      doctor.value = doctorResult
      providers.value = providerResult.providers || []
      actions.value = actionResult.actions || []
      await ensureProject(dramaId)
      await Promise.all([loadPaperEpisodes(), loadRuns(), loadLibrary()])
      const requestedEpisode = Number(options.episodeId)
      const initialEpisode = episodes.value.find((episode) => Number(episode.id) === requestedEpisode)
        || episodes.value[0]
      if (initialEpisode) await selectEpisode(initialEpisode.id)
      else await loadEpisodeStoryboards(null)
      if (options.storyboardId && paperStoryboards.value.some((item) => Number(item.id) === Number(options.storyboardId))) {
        await selectPaperStoryboard(options.storyboardId)
      }
      if (options.runId && runs.value.some((item) => Number(item.id) === Number(options.runId))) {
        await openRun(options.runId, options.shotId)
      } else if (options.shotId && currentRun.value?.shots?.some((item) => Number(item.id) === Number(options.shotId))) {
        await openShot(options.shotId)
      }
      void recordProductEvent('workspace_opened', {
        surface: 'paper_studio',
        entry_point: options.entryPoint || 'direct',
        resumed: Boolean(options.resumed),
        stage: options.stage || (currentRun.value ? 'production' : 'authoring'),
      })
    } catch (cause) {
      error.value = cause.message || '纸片动画工作室加载失败'
      throw cause
    } finally {
      loading.value = false
    }
  }

  function toggleStoryboard(storyboardId) {
    const id = Number(storyboardId)
    if (selectedStoryboardIds.value.includes(id)) {
      selectedStoryboardIds.value = selectedStoryboardIds.value.filter((value) => value !== id)
    } else {
      selectedStoryboardIds.value = [...selectedStoryboardIds.value, id]
    }
  }

  async function createRun({ qualityTier = 'balanced', imageProviderConfigId = null } = {}) {
    if (!project.value || !selectedEpisodeId.value || !selectedStoryboardIds.value.length) return null
    creatingRun.value = true
    error.value = null
    try {
      await ensureDraftsSaved(selectedStoryboardIds.value)
      const revisionMap = Object.fromEntries(selectedStoryboardIds.value.map((id) => {
        const storyboard = paperStoryboards.value.find((item) => Number(item.id) === Number(id))
        return [String(id), Number(storyboard?.current_revision_id || 0)]
      }))
      const response = await paperStudioAPI.createRun({
        request_id: requestId(),
        project_id: project.value.id,
        paper_episode_id: selectedEpisodeId.value,
        paper_storyboard_ids: selectedStoryboardIds.value,
        expected_paper_storyboard_revisions: revisionMap,
        quality_tier: qualityTier,
        image_provider_config_id: imageProviderConfigId || project.value.config_json?.image_provider_config_id || null,
        budget: {
          max_images: qualityTier === 'draft' ? 12 : qualityTier === 'full-depth' ? 48 : 24,
          max_auto_retries_per_slot: qualityTier === 'draft' ? 1 : 2,
        },
      })
      currentRun.value = response.run
      currentShot.value = response.run?.shots?.[0] || null
      await loadRuns()
      void recordProductEvent('production_run_created', {
        surface: 'paper_studio', stage: 'production', total_count: response.run?.shots?.length || 0,
      })
      return currentRun.value
    } catch (cause) {
      error.value = cause.message || '创建生产版本失败'
      throw cause
    } finally {
      creatingRun.value = false
    }
  }

  async function createPaperEpisode(payload = {}) {
    if (!project.value || authoring.value) return null
    authoring.value = true
    error.value = null
    try {
      const response = await paperStudioAPI.createPaperEpisode(project.value.id, {
        request_id: requestId(),
        title: String(payload.title || `纸片分集 ${paperEpisodes.value.length + 1}`).trim(),
        description: payload.description || '',
        aspect_ratio: payload.aspect_ratio || '16:9',
        fps: Number(payload.fps || project.value.config_json?.fps || 30),
        default_duration: Number(payload.default_duration || 6),
      })
      await loadPaperEpisodes(response.episode.id)
      await selectEpisode(response.episode.id)
      return response.episode
    } catch (cause) {
      error.value = cause.message || '创建纸片分集失败'
      throw cause
    } finally {
      authoring.value = false
    }
  }

  async function createExampleDraft() {
    if (!project.value || authoring.value || paperEpisodes.value.length) return null
    authoring.value = true
    error.value = null
    try {
      const response = await paperStudioAPI.createExampleDraft(project.value.id, {
        request_id: requestId(),
        confirmed: true,
      })
      await loadPaperEpisodes(response.episode.id)
      await selectEpisode(response.episode.id)
      selectedStoryboardIds.value = paperStoryboards.value.map((item) => Number(item.id))
      currentPaperStoryboard.value = paperStoryboards.value[0] || null
      await loadTaskCenter()
      void recordProductEvent('example_draft_created', {
        surface: 'paper_studio', stage: 'authoring', item_count: paperStoryboards.value.length,
        estimated_calls: 0,
      }, { paper_episode_id: response.episode.id, paper_storyboard_id: currentPaperStoryboard.value?.id })
      return response
    } catch (cause) {
      error.value = cause.message || '创建示例草稿失败'
      throw cause
    } finally {
      authoring.value = false
    }
  }

  async function createPaperStoryboard(payload = {}) {
    if (!selectedEpisodeId.value || authoring.value) return null
    authoring.value = true
    error.value = null
    try {
      const response = await paperStudioAPI.createPaperStoryboard(selectedEpisodeId.value, {
        request_id: requestId(),
        title: String(payload.title || `分镜 ${paperStoryboards.value.length + 1}`).trim(),
        description: payload.description || '',
        action: payload.action || '',
        dialogue: payload.dialogue || '',
        narration: payload.narration || '',
        duration: Number(payload.duration || currentEpisode.value?.default_duration || 6),
        visual_prompt: payload.visual_prompt || '',
        negative_prompt: payload.negative_prompt || '',
      })
      await loadEpisodeStoryboards(selectedEpisodeId.value)
      await Promise.all([loadPaperEpisodes(selectedEpisodeId.value), loadEpisodeMerges(), loadEpisodeDelivery(), loadTaskCenter()])
      currentPaperStoryboard.value = paperStoryboards.value.find((item) => Number(item.id) === Number(response.storyboard.id)) || response.storyboard
      await loadStoryboardAudio(currentPaperStoryboard.value.id)
      if (!selectedStoryboardIds.value.includes(Number(response.storyboard.id))) selectedStoryboardIds.value.push(Number(response.storyboard.id))
      return currentPaperStoryboard.value
    } catch (cause) {
      error.value = cause.message || '创建纸片分镜失败'
      throw cause
    } finally {
      authoring.value = false
    }
  }

  async function selectPaperStoryboard(storyboardId) {
    currentRun.value = null
    currentShot.value = null
    currentStoryboardRepairPreview.value = null
    currentPaperStoryboard.value = paperStoryboards.value.find((item) => Number(item.id) === Number(storyboardId)) || null
    await Promise.all([
      loadReferenceCandidates(currentPaperStoryboard.value?.id),
      loadStoryboardAudio(currentPaperStoryboard.value?.id),
    ])
    return currentPaperStoryboard.value
  }

  async function savePaperStoryboard(payload = {}, storyboardId = currentPaperStoryboard.value?.id) {
    const source = paperStoryboards.value.find((item) => Number(item.id) === Number(storyboardId))
    if (!source || authoring.value) return null
    authoring.value = true
    error.value = null
    saveStateByStoryboardId.value = { ...saveStateByStoryboardId.value, [source.id]: 'saving' }
    try {
      const response = await paperStudioAPI.updatePaperStoryboard(source.id, {
        request_id: requestId(),
        expected_version: Number(source.version),
        ...payload,
      })
      await loadEpisodeStoryboards(selectedEpisodeId.value)
      await Promise.all([loadPaperEpisodes(selectedEpisodeId.value), loadEpisodeMerges(), loadEpisodeDelivery(), loadTaskCenter()])
      const saved = paperStoryboards.value.find((item) => Number(item.id) === Number(response.storyboard.id)) || response.storyboard
      if (Number(currentPaperStoryboard.value?.id) === Number(saved.id)) currentPaperStoryboard.value = saved
      if (Number(currentPaperStoryboard.value?.id) === Number(saved.id)) await loadStoryboardAudio(saved.id)
      draftByStoryboardId.value = { ...draftByStoryboardId.value, [source.id]: saved }
      draftDirtyByStoryboardId.value = { ...draftDirtyByStoryboardId.value, [source.id]: false }
      saveStateByStoryboardId.value = { ...saveStateByStoryboardId.value, [source.id]: 'saved' }
      return saved
    } catch (cause) {
      error.value = cause.message || '保存纸片分镜失败'
      saveStateByStoryboardId.value = { ...saveStateByStoryboardId.value, [source.id]: 'failed' }
      throw cause
    } finally {
      authoring.value = false
    }
  }

  async function ensureDraftSaved(storyboardId) {
    const id = Number(storyboardId)
    if (!draftDirtyByStoryboardId.value[id]) return paperStoryboards.value.find((item) => Number(item.id) === id) || null
    const payload = draftByStoryboardId.value[id]
    if (!payload) return null
    return savePaperStoryboard(payload, id)
  }

  async function ensureDraftsSaved(storyboardIds = Object.keys(draftDirtyByStoryboardId.value)) {
    for (const id of storyboardIds.map(Number)) {
      if (draftDirtyByStoryboardId.value[id]) await ensureDraftSaved(id)
    }
    return true
  }

  async function duplicatePaperStoryboard(storyboardId) {
    const source = paperStoryboards.value.find((item) => Number(item.id) === Number(storyboardId))
    if (!source || authoring.value) return null
    authoring.value = true
    try {
      const response = await paperStudioAPI.duplicatePaperStoryboard(source.id, {
        request_id: requestId(), expected_version: Number(source.version),
      })
      await loadEpisodeStoryboards(selectedEpisodeId.value)
      currentPaperStoryboard.value = paperStoryboards.value.find((item) => Number(item.id) === Number(response.storyboard.id)) || response.storyboard
      await Promise.all([loadReferenceCandidates(currentPaperStoryboard.value?.id), loadStoryboardAudio(currentPaperStoryboard.value?.id)])
      await loadPaperEpisodes(selectedEpisodeId.value)
      await Promise.all([loadEpisodeMerges(), loadEpisodeDelivery()])
      return currentPaperStoryboard.value
    } finally {
      authoring.value = false
    }
  }

  async function deletePaperStoryboard(storyboardId) {
    const source = paperStoryboards.value.find((item) => Number(item.id) === Number(storyboardId))
    if (!source || authoring.value) return false
    authoring.value = true
    try {
      await paperStudioAPI.deletePaperStoryboard(source.id, {
        request_id: requestId(), expected_version: Number(source.version),
      })
      await loadEpisodeStoryboards(selectedEpisodeId.value)
      await Promise.all([loadPaperEpisodes(selectedEpisodeId.value), loadEpisodeMerges(), loadEpisodeDelivery(), loadTaskCenter()])
      await Promise.all([
        loadReferenceCandidates(currentPaperStoryboard.value?.id),
        loadStoryboardAudio(currentPaperStoryboard.value?.id),
      ])
      return true
    } finally {
      authoring.value = false
    }
  }

  async function reorderPaperStoryboards(storyboardIds) {
    const response = await paperStudioAPI.reorderPaperStoryboards(selectedEpisodeId.value, {
      request_id: requestId(), storyboard_ids: storyboardIds.map(Number),
    })
    paperStoryboards.value = response.storyboards || []
    await Promise.all([loadPaperEpisodes(selectedEpisodeId.value), loadEpisodeMerges(), loadEpisodeDelivery(), loadTaskCenter()])
    return paperStoryboards.value
  }

  async function loadScripts(episodeId = selectedEpisodeId.value) {
    if (!episodeId) {
      scripts.value = []
      latestScript.value = null
      return []
    }
    const response = await paperStudioAPI.listScripts(episodeId)
    scripts.value = response.scripts || []
    latestScript.value = response.latest || null
    return scripts.value
  }

  async function loadScriptContent(scriptId) {
    if (!selectedEpisodeId.value || !scriptId) return null
    const response = await paperStudioAPI.getScript(selectedEpisodeId.value, scriptId)
    return response.script || null
  }

  async function saveScript(content, sourceKind = 'manual') {
    if (!selectedEpisodeId.value) throw new Error('请先选择纸片分集')
    const response = await paperStudioAPI.createScript(selectedEpisodeId.value, {
      request_id: requestId(),
      content,
      source_kind: sourceKind,
    })
    await loadScripts()
    return response
  }

  async function loadLibrary() {
    if (!project.value?.id) {
      library.value = null
      return null
    }
    const response = await paperStudioAPI.getLibrary(project.value.id)
    library.value = response.library || null
    return library.value
  }

  async function extractEntities(scriptVersionId = null) {
    if (!selectedEpisodeId.value) throw new Error('请先选择纸片分集')
    extracting.value = true
    try {
      const response = await paperStudioAPI.extractEntities(selectedEpisodeId.value, {
        request_id: requestId(),
        ...(scriptVersionId ? { script_version_id: Number(scriptVersionId) } : {}),
      })
      extractionResult.value = response
      return response
    } finally {
      extracting.value = false
    }
  }

  function clearExtraction() {
    extractionResult.value = null
  }

  async function confirmEntities(items) {
    if (!project.value?.id) throw new Error('纸片项目未就绪')
    const response = await paperStudioAPI.confirmLibrary(project.value.id, {
      request_id: requestId(),
      items,
    })
    library.value = response.library || library.value
    extractionResult.value = null
    return response.summary
  }

  async function updateLibraryEntity(entityId, body) {
    const response = await paperStudioAPI.updateLibraryEntity(entityId, body)
    await loadLibrary()
    return response.entity
  }

  async function setStyleAnchor(anchorText) {
    if (!project.value?.id) throw new Error('纸片项目未就绪')
    await paperStudioAPI.setStyleAnchor(project.value.id, { request_id: requestId(), anchor_text: anchorText })
    await loadLibrary()
    return library.value?.style_anchor || null
  }

  async function generateIdentities(entityIds, imageProviderConfigId = null) {
    if (!project.value?.id) throw new Error('纸片项目未就绪')
    identityGenerating.value = true
    try {
      const response = await paperStudioAPI.generateIdentities(project.value.id, {
        request_id: requestId(),
        entity_ids: entityIds.map(Number),
        ...(imageProviderConfigId ? { image_provider_config_id: Number(imageProviderConfigId) } : {}),
      })
      library.value = response.library || library.value
      return response
    } finally {
      identityGenerating.value = false
    }
  }

  async function reviewIdentityVersion(versionId, decision) {
    const response = await paperStudioAPI.reviewIdentityVersion(versionId, {
      request_id: requestId(),
      decision,
    })
    await loadLibrary()
    return response
  }

  async function generateStoryboardsDraft(params = {}) {
    if (!selectedEpisodeId.value) throw new Error('请先选择纸片分集')
    storyboardGenerating.value = true
    storyboardRepairPreview.value = null
    try {
      const response = await paperStudioAPI.generateStoryboardsFromScript(selectedEpisodeId.value, {
        request_id: requestId(),
        ...(params.script_version_id ? { script_version_id: Number(params.script_version_id) } : {}),
        ...(params.generation_mode ? { generation_mode: params.generation_mode } : {}),
        ...(params.target_shot_count ? { target_shot_count: Number(params.target_shot_count) } : {}),
      })
      storyboardDraft.value = response
      return response
    } finally {
      storyboardGenerating.value = false
    }
  }

  function clearStoryboardDraft() {
    storyboardDraft.value = null
    storyboardRepairPreview.value = null
  }

  async function repairGeneratedStoryboardsDraft() {
    if (!selectedEpisodeId.value || !storyboardDraft.value?.shots?.length) throw new Error('没有可补全的分镜草稿')
    storyboardRepairing.value = true
    storyboardRepairPreview.value = null
    try {
      const response = await paperStudioAPI.repairGeneratedStoryboards(selectedEpisodeId.value, {
        request_id: requestId(),
        ...(storyboardDraft.value.script?.id ? { script_version_id: Number(storyboardDraft.value.script.id) } : {}),
        shots: storyboardDraft.value.shots,
      })
      storyboardRepairPreview.value = response
      return response
    } finally {
      storyboardRepairing.value = false
    }
  }

  function acceptStoryboardRepairPreview() {
    if (!storyboardDraft.value || !storyboardRepairPreview.value?.shots?.length) return false
    storyboardDraft.value = {
      ...storyboardDraft.value,
      shots: storyboardRepairPreview.value.shots,
      issues: storyboardRepairPreview.value.issues || [],
    }
    storyboardRepairPreview.value = null
    return true
  }

  function clearStoryboardRepairPreview() {
    storyboardRepairPreview.value = null
  }

  async function repairCurrentPaperStoryboard() {
    const source = currentPaperStoryboard.value
    if (!selectedEpisodeId.value || !source) throw new Error('没有可补全的当前分镜')
    currentStoryboardRepairing.value = true
    currentStoryboardRepairPreview.value = null
    try {
      const response = await paperStudioAPI.repairGeneratedStoryboards(selectedEpisodeId.value, {
        request_id: requestId(),
        ...(latestScript.value?.id ? { script_version_id: Number(latestScript.value.id) } : {}),
        shots: [{
          title: source.title || '',
          description: source.description || '',
          action: source.action || '',
          dialogue: source.dialogue || '',
          narration: source.narration || '',
          duration: Number(source.duration || currentEpisode.value?.default_duration || 6),
          shot_type: source.shot_type || null,
          camera_motion: source.camera_motion || null,
          environment_only: Boolean(source.environment_only),
        }],
      })
      if (Number(currentPaperStoryboard.value?.id) !== Number(source.id)) return { ...response, stale: true }
      currentStoryboardRepairPreview.value = {
        ...response,
        paper_storyboard_id: Number(source.id),
        source_version: Number(source.version),
        patches: (response.patches || []).map((patch) => ({
          ...patch,
          shot_number: Number(source.shot_number),
          title: source.title,
        })),
      }
      return currentStoryboardRepairPreview.value
    } finally {
      currentStoryboardRepairing.value = false
    }
  }

  async function acceptCurrentStoryboardRepairPreview() {
    const preview = currentStoryboardRepairPreview.value
    const source = currentPaperStoryboard.value
    if (!preview?.patches?.length || Number(preview.paper_storyboard_id) !== Number(source?.id)) return null
    if (Number(preview.source_version) !== Number(source.version)) {
      currentStoryboardRepairPreview.value = null
      throw new Error('分镜内容已更新，AI 补全建议已失效，请重新生成')
    }
    const payload = Object.fromEntries(preview.patches.map((patch) => [patch.field, patch.after]))
    const saved = await savePaperStoryboard(payload, source.id)
    currentStoryboardRepairPreview.value = null
    return saved
  }

  function clearCurrentStoryboardRepairPreview() {
    currentStoryboardRepairPreview.value = null
  }

  async function applyGeneratedStoryboards(mode = 'append') {
    if (!selectedEpisodeId.value || !storyboardDraft.value?.shots?.length) throw new Error('没有可应用的分镜草稿')
    const response = await paperStudioAPI.applyGeneratedStoryboards(selectedEpisodeId.value, {
      request_id: requestId(),
      mode,
      shots: storyboardDraft.value.shots,
    })
    storyboardDraft.value = null
    storyboardRepairPreview.value = null
    paperStoryboards.value = response.storyboards || []
    currentPaperStoryboard.value = paperStoryboards.value[0] || null
    selectedStoryboardIds.value = paperStoryboards.value.map((item) => Number(item.id))
    await Promise.all([loadPaperEpisodes(selectedEpisodeId.value), loadEpisodeDelivery(), loadLibrary()])
    return response
  }

  async function importLegacyStoryboards(legacyEpisodeId, storyboardIds = null) {
    const response = await paperStudioAPI.importLegacyStoryboards(selectedEpisodeId.value, {
      request_id: requestId(),
      legacy_episode_id: Number(legacyEpisodeId),
      ...(storyboardIds?.length ? { storyboard_ids: storyboardIds.map(Number) } : {}),
    })
    paperStoryboards.value = response.storyboards || []
    currentPaperStoryboard.value = paperStoryboards.value[0] || null
    selectedStoryboardIds.value = paperStoryboards.value.map((item) => Number(item.id))
    await Promise.all([loadPaperEpisodes(selectedEpisodeId.value), loadEpisodeMerges(), loadEpisodeDelivery(), loadTaskCenter()])
    await Promise.all([
      loadReferenceCandidates(currentPaperStoryboard.value?.id),
      loadStoryboardAudio(currentPaperStoryboard.value?.id),
    ])
    return response
  }

  async function generateReference({ imageProviderConfigId, prompt = '', negativePrompt = '' } = {}) {
    if (!currentPaperStoryboard.value || authoring.value) return null
    authoring.value = true
    try {
      if (draftDirtyByStoryboardId.value[currentPaperStoryboard.value.id]) {
        authoring.value = false
        await ensureDraftSaved(currentPaperStoryboard.value.id)
        authoring.value = true
      }
      const response = await paperStudioAPI.generatePaperStoryboardReference(currentPaperStoryboard.value.id, {
        request_id: requestId(),
        expected_version: Number(currentPaperStoryboard.value.version),
        image_provider_config_id: imageProviderConfigId ? Number(imageProviderConfigId) : null,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(negativePrompt.trim() ? { negative_prompt: negativePrompt.trim() } : {}),
      })
      currentPaperStoryboard.value = response.storyboard
      await loadEpisodeStoryboards(selectedEpisodeId.value)
      await Promise.all([loadPaperEpisodes(selectedEpisodeId.value), loadEpisodeMerges()])
      currentPaperStoryboard.value = paperStoryboards.value.find((item) => Number(item.id) === Number(response.storyboard.id)) || response.storyboard
      referenceCandidates.value = response.references || await loadReferenceCandidates(response.storyboard.id)
      return response
    } finally {
      authoring.value = false
    }
  }

  async function uploadReference(file) {
    if (!currentPaperStoryboard.value || !file || authoring.value) return null
    authoring.value = true
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('request_id', requestId())
      formData.append('expected_version', String(currentPaperStoryboard.value.version))
      formData.append('select', 'true')
      const response = await paperStudioAPI.uploadPaperStoryboardReference(currentPaperStoryboard.value.id, formData)
      currentPaperStoryboard.value = response.storyboard
      referenceCandidates.value = response.references || []
      await loadEpisodeStoryboards(selectedEpisodeId.value)
      currentPaperStoryboard.value = paperStoryboards.value.find((item) => Number(item.id) === Number(response.storyboard.id)) || response.storyboard
      await Promise.all([loadPaperEpisodes(selectedEpisodeId.value), loadEpisodeMerges()])
      return response
    } finally {
      authoring.value = false
    }
  }

  async function selectReference(referenceId) {
    if (!currentPaperStoryboard.value || authoring.value) return null
    authoring.value = true
    try {
      const response = await paperStudioAPI.selectPaperStoryboardReference(currentPaperStoryboard.value.id, referenceId, {
        request_id: requestId(), expected_version: Number(currentPaperStoryboard.value.version),
      })
      currentPaperStoryboard.value = response.storyboard
      referenceCandidates.value = response.references || []
      await loadEpisodeStoryboards(selectedEpisodeId.value)
      currentPaperStoryboard.value = paperStoryboards.value.find((item) => Number(item.id) === Number(response.storyboard.id)) || response.storyboard
      return response
    } finally {
      authoring.value = false
    }
  }

  async function saveReferenceConstraints(referenceId, constraints) {
    if (!currentPaperStoryboard.value || authoring.value) return null
    authoring.value = true
    try {
      const response = await paperStudioAPI.updatePaperStoryboardReferenceConstraints(currentPaperStoryboard.value.id, referenceId, {
        request_id: requestId(), expected_version: Number(currentPaperStoryboard.value.version), constraints,
      })
      currentPaperStoryboard.value = response.storyboard
      referenceCandidates.value = response.references || []
      await loadEpisodeStoryboards(selectedEpisodeId.value)
      currentPaperStoryboard.value = paperStoryboards.value.find((item) => Number(item.id) === Number(response.storyboard.id)) || response.storyboard
      return response
    } finally {
      authoring.value = false
    }
  }

  async function refreshAfterAudioChange(storyboardId, response) {
    const id = Number(storyboardId)
    await loadEpisodeStoryboards(selectedEpisodeId.value)
    await Promise.all([loadPaperEpisodes(selectedEpisodeId.value), loadEpisodeMerges(), loadEpisodeDelivery(), loadTaskCenter()])
    if (Number(currentPaperStoryboard.value?.id) === id) {
      currentPaperStoryboard.value = paperStoryboards.value.find((item) => Number(item.id) === id) || response.storyboard || currentPaperStoryboard.value
      currentAudio.value = response.audio || await loadStoryboardAudio(id)
    }
    if (Number(currentShot.value?.paper_storyboard_id || 0) === id) await openShot(currentShot.value.id)
    if (currentRun.value?.id) await loadRuns()
    return response
  }

  async function synthesizePaperAudio(storyboardId, audioKind, options = {}) {
    const source = paperStoryboards.value.find((item) => Number(item.id) === Number(storyboardId))
    if (!source || authoring.value) return null
    authoring.value = true
    error.value = null
    try {
      const response = await paperStudioAPI.synthesizePaperStoryboardAudio(source.id, {
        request_id: requestId(), expected_version: Number(source.version), audio_kind: audioKind,
        ...(options.voiceId ? { voice_id: options.voiceId } : {}),
        speed: Number(options.speed || 1), volume: Number(options.volume == null ? 1 : options.volume),
        start_seconds: Number(options.startSeconds || 0),
        captions_enabled: options.captionsEnabled !== false,
        ...(options.captionText == null ? {} : { caption_text: options.captionText }),
      })
      return await refreshAfterAudioChange(source.id, response)
    } catch (cause) {
      error.value = cause.message || '生成纸片配音失败'
      throw cause
    } finally {
      authoring.value = false
    }
  }

  async function uploadPaperAudio(storyboardId, audioKind, file, options = {}) {
    const source = paperStoryboards.value.find((item) => Number(item.id) === Number(storyboardId))
    if (!source || !file || authoring.value) return null
    authoring.value = true
    error.value = null
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('request_id', requestId())
      formData.append('expected_version', String(source.version))
      formData.append('audio_kind', audioKind)
      formData.append('volume', String(options.volume == null ? 1 : options.volume))
      formData.append('start_seconds', String(options.startSeconds || 0))
      formData.append('captions_enabled', String(options.captionsEnabled !== false))
      if (options.captionText != null) formData.append('caption_text', options.captionText)
      const response = await paperStudioAPI.uploadPaperStoryboardAudio(source.id, formData)
      return await refreshAfterAudioChange(source.id, response)
    } catch (cause) {
      error.value = cause.message || '上传纸片音频失败'
      throw cause
    } finally {
      authoring.value = false
    }
  }

  async function revisePaperAudio(storyboardId, audioVersionId, options = {}) {
    const source = paperStoryboards.value.find((item) => Number(item.id) === Number(storyboardId))
    if (!source || !audioVersionId || authoring.value) return null
    authoring.value = true
    error.value = null
    try {
      const response = await paperStudioAPI.revisePaperStoryboardAudio(source.id, audioVersionId, {
        request_id: requestId(), expected_version: Number(source.version),
        volume: Number(options.volume == null ? 1 : options.volume),
        start_seconds: Number(options.startSeconds || 0),
        captions_enabled: options.captionsEnabled !== false,
        ...(options.captionText == null ? {} : { caption_text: options.captionText }),
      })
      return await refreshAfterAudioChange(source.id, response)
    } catch (cause) {
      error.value = cause.message || '更新音频时间与字幕失败'
      throw cause
    } finally {
      authoring.value = false
    }
  }

  async function setPaperAudioPolicy(storyboardId, audioMode) {
    const source = paperStoryboards.value.find((item) => Number(item.id) === Number(storyboardId))
    if (!source || authoring.value) return null
    authoring.value = true
    error.value = null
    try {
      const response = await paperStudioAPI.updatePaperStoryboardAudioPolicy(source.id, {
        request_id: requestId(), expected_version: Number(source.version), audio_mode: audioMode,
      })
      return await refreshAfterAudioChange(source.id, response)
    } catch (cause) {
      error.value = cause.message || '更新声音策略失败'
      throw cause
    } finally {
      authoring.value = false
    }
  }

  async function mergePaperEpisode() {
    if (!currentEpisode.value || authoring.value) return null
    authoring.value = true
    error.value = null
    try {
      const response = await paperStudioAPI.mergePaperEpisode(currentEpisode.value.id, {
        request_id: requestId(), expected_version: Number(currentEpisode.value.version),
      })
      await Promise.all([loadPaperEpisodes(currentEpisode.value.id), loadEpisodeMerges(), loadEpisodeDelivery(), loadTaskCenter()])
      void recordProductEvent('episode_merge_started', {
        surface: 'paper_studio', stage: 'delivery', total_count: episodeDelivery.value?.total_count || 0,
      })
      return response
    } catch (cause) {
      error.value = cause.message || '整集合并任务创建失败'
      throw cause
    } finally {
      authoring.value = false
    }
  }

  async function syncToLegacy({ legacyEpisodeId, legacyStoryboardId = null } = {}) {
    if (!currentPaperStoryboard.value || authoring.value) return null
    authoring.value = true
    try {
      const response = await paperStudioAPI.syncPaperStoryboardToLegacy(currentPaperStoryboard.value.id, {
        request_id: requestId(),
        expected_version: Number(currentPaperStoryboard.value.version),
        legacy_episode_id: Number(legacyEpisodeId),
        legacy_storyboard_id: legacyStoryboardId ? Number(legacyStoryboardId) : null,
        confirmed: true,
        sync_reference_image: true,
        sync_published_video: true,
      })
      await loadEpisodeStoryboards(selectedEpisodeId.value)
      currentPaperStoryboard.value = paperStoryboards.value.find((item) => Number(item.id) === Number(response.storyboard.id)) || response.storyboard
      return response
    } finally {
      authoring.value = false
    }
  }

  async function openRun(runId, preferredShotId = null) {
    const existingRunId = Number(currentRun.value?.id || 0)
    const existingShotId = Number(currentShot.value?.id || 0)
    const response = await paperStudioAPI.getRun(runId)
    const nextRun = response.run
    const requestedShotId = Number(preferredShotId || (existingRunId === Number(runId) ? existingShotId : 0))
    const preferred = nextRun?.shots?.find((shot) => Number(shot.id) === requestedShotId)
      || nextRun?.shots?.[0]
      || null
    let nextShot = preferred
    if (preferred?.id) {
      const detail = await paperStudioAPI.getShot(preferred.id)
      nextShot = detail.shot
      const index = nextRun.shots.findIndex((shot) => Number(shot.id) === Number(preferred.id))
      if (index >= 0) nextRun.shots[index] = detail.shot
    }
    if (nextRun?.paper_episode_id) {
      selectedEpisodeId.value = Number(nextRun.paper_episode_id)
      await Promise.all([loadEpisodeStoryboards(selectedEpisodeId.value), loadEpisodeMerges(), loadEpisodeDelivery(), loadScripts(selectedEpisodeId.value)])
    }
    // Commit the run and detailed shot together. Assigning the lightweight shot
    // first briefly removes families and remounts the asset workbench, which
    // loses the user's selected slot, zoom and transparent-background check.
    currentRun.value = nextRun
    currentShot.value = nextShot
    await loadRunEvents()
    return currentRun.value
  }

  async function loadRunEvents() {
    if (!currentRun.value?.id) {
      runEvents.value = []
      return []
    }
    const response = await paperStudioAPI.listEvents(currentRun.value.id)
    runEvents.value = response.events || []
    return runEvents.value
  }

  async function openShot(shotId) {
    const response = await paperStudioAPI.getShot(shotId)
    currentShot.value = response.shot
    const index = currentRun.value?.shots?.findIndex((shot) => Number(shot.id) === Number(shotId)) ?? -1
    if (index >= 0) currentRun.value.shots[index] = response.shot
    return currentShot.value
  }

  async function refreshActiveRun() {
    if (!currentRun.value?.id || acting.value || ['delivered', 'stale', 'cancelled'].includes(currentRun.value.status)) return currentRun.value
    const runId = Number(currentRun.value.id)
    const shotId = Number(currentShot.value?.id || 0)
    const previousDeliverySignature = JSON.stringify((currentRun.value.shots || []).map((shot) => [
      shot.id, shot.status, shot.published_video_generation_id,
    ]))
    const previousRunSignature = JSON.stringify([
      currentRun.value.version, currentRun.value.status, currentRun.value.progress, currentRun.value.attention_required,
    ])
    const response = await paperStudioAPI.getRun(runId)
    const nextRun = response.run
    const preferred = nextRun?.shots?.find((shot) => Number(shot.id) === shotId)
      || nextRun?.shots?.[0]
      || null
    let nextShot = preferred
    const previousShotSignature = JSON.stringify([
      currentShot.value?.id, currentShot.value?.status, currentShot.value?.version,
      currentShot.value?.published_video_generation_id,
    ])
    const preferredShotSignature = JSON.stringify([
      preferred?.id, preferred?.status, preferred?.version, preferred?.published_video_generation_id,
    ])
    if (preferred?.id && previousShotSignature !== preferredShotSignature) {
      const detail = await paperStudioAPI.getShot(preferred.id)
      nextShot = detail.shot
      const index = nextRun.shots.findIndex((shot) => Number(shot.id) === Number(preferred.id))
      if (index >= 0) nextRun.shots[index] = detail.shot
    } else if (preferred?.id && Number(currentShot.value?.id) === Number(preferred.id)) {
      nextShot = currentShot.value
      const index = nextRun.shots.findIndex((shot) => Number(shot.id) === Number(preferred.id))
      if (index >= 0) nextRun.shots[index] = currentShot.value
    }
    if (Number(currentRun.value?.id) !== runId) return currentRun.value
    if (Number(currentShot.value?.id || 0) !== shotId) {
      const selectedIndex = nextRun.shots.findIndex((shot) => Number(shot.id) === Number(currentShot.value?.id))
      if (selectedIndex >= 0) nextRun.shots[selectedIndex] = currentShot.value
      currentRun.value = nextRun
    } else {
      currentRun.value = nextRun
      currentShot.value = nextShot
    }
    const nextDeliverySignature = JSON.stringify((nextRun.shots || []).map((shot) => [
      shot.id, shot.status, shot.published_video_generation_id,
    ]))
    const nextRunSignature = JSON.stringify([
      nextRun.version, nextRun.status, nextRun.progress, nextRun.attention_required,
    ])
    if (previousRunSignature !== nextRunSignature) {
      await Promise.all([loadRuns({ taskCenterSilent: true }), loadRunEvents()])
    }
    if (previousDeliverySignature !== nextDeliverySignature) {
      await Promise.all([
        loadPaperEpisodes(selectedEpisodeId.value),
        loadEpisodeStoryboards(selectedEpisodeId.value),
        loadEpisodeDelivery(),
      ])
    }
    return currentRun.value
  }

  async function getGenerationQuote({ shotIds = null, slotIds = null } = {}) {
    if (!currentRun.value || acting.value) return null
    const response = await paperStudioAPI.generationQuote(currentRun.value.id, {
      request_id: requestId(),
      expected_version: Number(currentRun.value.version),
      ...(shotIds?.length ? { shot_ids: shotIds.map(Number) } : {}),
      ...(slotIds?.length ? { slot_ids: slotIds.map(Number) } : {}),
    })
    return response.quote
  }

  async function authorizeAndStartGeneration(quote) {
    if (!currentRun.value || !quote || acting.value) return null
    acting.value = true
    error.value = null
    try {
      const authorized = await paperStudioAPI.authorizeGeneration(currentRun.value.id, {
        request_id: requestId(),
        expected_version: Number(currentRun.value.version),
        quote_fingerprint: quote.quote_fingerprint,
        confirmed: true,
        shot_ids: quote.shot_ids,
        ...(quote.requested_slot_ids?.length ? { slot_ids: quote.requested_slot_ids } : {}),
      })
      const response = await paperStudioAPI.executeGenerationAuthorization(authorized.authorization.id, {
        request_id: requestId(),
        expected_version: Number(authorized.authorization.version),
      })
      currentRun.value = response.run
      const currentId = Number(currentShot.value?.id || 0)
      currentShot.value = currentRun.value.shots.find((shot) => Number(shot.id) === currentId) || currentRun.value.shots[0] || null
      if (currentShot.value?.id) await openShot(currentShot.value.id)
      await Promise.all([loadRuns(), loadRunEvents()])
      void recordProductEvent('image_generation_authorized', {
        surface: 'paper_studio', stage: 'assets', estimated_calls: Number(quote.estimated_image_count || 0),
      })
      return response
    } catch (cause) {
      error.value = cause.message || '图片生成授权失败'
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function controlRun(action) {
    if (!currentRun.value || acting.value) return null
    acting.value = true
    error.value = null
    try {
      const body = { request_id: requestId(), expected_version: Number(currentRun.value.version) }
      const response = action === 'pause'
        ? await paperStudioAPI.pauseRun(currentRun.value.id, body)
        : action === 'resume'
          ? await paperStudioAPI.resumeRun(currentRun.value.id, body)
          : await paperStudioAPI.cancelRun(currentRun.value.id, body)
      currentRun.value = response.run
      currentShot.value = response.run?.shots?.find((shot) => Number(shot.id) === Number(currentShot.value?.id)) || response.run?.shots?.[0] || null
      if (currentShot.value?.id) await openShot(currentShot.value.id)
      await Promise.all([loadRuns(), loadRunEvents()])
      return response.run
    } catch (cause) {
      error.value = cause.message || '生产版本控制失败'
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function saveBlueprint(blueprint) {
    if (!currentShot.value?.id || !blueprint || acting.value) return null
    acting.value = true
    error.value = null
    const shotId = Number(currentShot.value.id)
    const runId = Number(currentRun.value.id)
    try {
      const response = await paperStudioAPI.updateBlueprint(shotId, {
        request_id: requestId(),
        expected_version: Number(currentShot.value.version),
        blueprint,
      })
      currentRun.value = response.run
      await openShot(shotId)
      await Promise.all([loadRuns(), loadRunEvents()])
      return response.blueprint
    } catch (cause) {
      error.value = cause.message || '保存生产蓝图失败'
      captureErrorContext(cause)
      try { await openRun(runId); await openShot(shotId) } catch (_) {}
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function confirmBlueprint() {
    if (!currentShot.value?.id || acting.value) return null
    acting.value = true
    error.value = null
    const shotId = Number(currentShot.value.id)
    const runId = Number(currentRun.value.id)
    try {
      const response = await paperStudioAPI.confirmBlueprint(shotId, {
        request_id: requestId(),
        expected_version: Number(currentShot.value.version),
      })
      currentRun.value = response.run
      await openShot(shotId)
      await Promise.all([loadRuns(), loadRunEvents()])
      return response
    } catch (cause) {
      error.value = cause.message || '确认生产蓝图失败'
      captureErrorContext(cause)
      try { await openRun(runId); await openShot(shotId) } catch (_) {}
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function runNextAction() {
    if (!currentRun.value || acting.value) return null
    acting.value = true
    error.value = null
    try {
      const runBody = {
        request_id: requestId(),
        expected_version: Number(currentRun.value.version),
        ...(currentShot.value?.id ? { shot_ids: [Number(currentShot.value.id)] } : {}),
      }
      const action = currentShot.value?.next_action?.type || currentRun.value.next_action?.type
      let response
      if (action === 'analyze_shot' || action === 'analyze_run') {
        response = await paperStudioAPI.analyzeRun(currentRun.value.id, runBody)
      } else if (action === 'confirm_shot_plan' || action === 'confirm_plan') {
        response = await paperStudioAPI.confirmPlan(currentRun.value.id, runBody)
      } else if (action === 'generate_assets' || action === 'retry_failed_asset') {
        response = await paperStudioAPI.generateAssets(currentShot.value.id, {
          request_id: requestId(),
          expected_version: Number(currentShot.value.version),
        })
      } else if (action === 'review_assets') {
        return { noop: true, attention_required: 'review_assets', action, shot: currentShot.value }
      } else if (action === 'plan_motion' || action === 'revise_motion') {
        response = await paperStudioAPI.planMotion(currentShot.value.id, {
          request_id: requestId(),
          expected_version: Number(currentShot.value.version),
        })
      } else if (action === 'run_proof' || action === 'inspect_evidence') {
        response = await paperStudioAPI.proof(currentShot.value.id, {
          request_id: requestId(), expected_version: Number(currentShot.value.version),
        })
      } else if (action === 'render_preview') {
        response = await paperStudioAPI.preview(currentShot.value.id, {
          request_id: requestId(), expected_version: Number(currentShot.value.version),
        })
      } else if (action === 'approve_preview') {
        response = await paperStudioAPI.approvePreview(currentShot.value.id, {
          request_id: requestId(), expected_version: Number(currentShot.value.version),
        })
      } else if (action === 'render_formal' || action === 'retry_render') {
        response = await paperStudioAPI.renderFormal(currentShot.value.id, {
          request_id: requestId(), expected_version: Number(currentShot.value.version),
        })
      } else if (action === 'publish_video') {
        response = await paperStudioAPI.publish(currentShot.value.id, {
          request_id: requestId(), expected_version: Number(currentShot.value.version),
        })
      } else {
        return { noop: true, action, reason: 'no_client_handler' }
      }
      if (response.run) currentRun.value = response.run
      if (response.shot) {
        const runResult = await paperStudioAPI.getRun(currentRun.value.id)
        currentRun.value = runResult.run
      }
      const currentId = Number(currentShot.value?.id)
      currentShot.value = currentRun.value?.shots?.find((shot) => Number(shot.id) === currentId)
        || currentRun.value?.shots?.[0]
        || null
      if (currentShot.value?.id) {
        const detail = await paperStudioAPI.getShot(currentShot.value.id)
        currentShot.value = detail.shot
        const index = currentRun.value.shots.findIndex((shot) => Number(shot.id) === Number(detail.shot.id))
        if (index >= 0) currentRun.value.shots[index] = detail.shot
      }
      await loadRuns()
      if (action === 'publish_video' && selectedEpisodeId.value) {
        await Promise.all([loadEpisodeStoryboards(selectedEpisodeId.value), loadPaperEpisodes(selectedEpisodeId.value), loadEpisodeMerges()])
      }
      return response
    } catch (cause) {
      error.value = cause.message || '执行纸片动画步骤失败'
      captureErrorContext(cause)
      try {
        if (currentRun.value?.id) await openRun(currentRun.value.id)
        if (currentShot.value?.id) await openShot(currentShot.value.id)
        await loadRuns()
      } catch (_) {}
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function advanceRun() {
    if (!currentRun.value || acting.value) return null
    acting.value = true
    error.value = null
    const currentShotId = Number(currentShot.value?.id || 0)
    try {
      const response = await paperStudioAPI.advanceRun(currentRun.value.id, {
        request_id: requestId(),
        expected_version: Number(currentRun.value.version),
      })
      currentRun.value = response.run
      const preferred = currentRun.value?.shots?.find((shot) => Number(shot.id) === currentShotId)
        || currentRun.value?.shots?.find((shot) => !['published', 'cancelled'].includes(shot.status))
        || currentRun.value?.shots?.[0]
        || null
      currentShot.value = preferred
      if (preferred?.id) await openShot(preferred.id)
      await loadRuns()
      if (selectedEpisodeId.value) {
        await Promise.all([loadEpisodeStoryboards(selectedEpisodeId.value), loadPaperEpisodes(selectedEpisodeId.value), loadEpisodeMerges()])
      }
      return response
    } catch (cause) {
      error.value = cause.message || '批量推进纸片生产失败'
      captureErrorContext(cause)
      try {
        await openRun(currentRun.value.id)
        await loadRuns()
      } catch (_) {}
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function reviseMotion(instruction) {
    const text = String(instruction || '').trim()
    if (!currentShot.value?.id || !text || acting.value) return null
    acting.value = true
    error.value = null
    const shotId = Number(currentShot.value.id)
    const runId = Number(currentRun.value.id)
    try {
      const response = await paperStudioAPI.reviseMotion(shotId, {
        request_id: requestId(),
        expected_version: Number(currentShot.value.version),
        instruction: text,
      })
      await openRun(runId)
      await openShot(shotId)
      await loadRuns()
      return response
    } catch (cause) {
      error.value = cause.message || '自然语言动作修订失败'
      try { await openShot(shotId) } catch (_) {}
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function syncAudioTiming() {
    if (!currentShot.value?.id || acting.value) return null
    acting.value = true
    error.value = null
    const shotId = Number(currentShot.value.id)
    const runId = Number(currentRun.value.id)
    try {
      const response = await paperStudioAPI.syncAudioTiming(shotId, {
        request_id: requestId(),
        expected_version: Number(currentShot.value.version),
      })
      await openRun(runId)
      await openShot(shotId)
      await Promise.all([loadRuns(), loadEpisodeDelivery()])
      return response
    } catch (cause) {
      error.value = cause.message || '按完整声音重排镜头失败'
      try { await openShot(shotId) } catch (_) {}
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function reviewAssets(action, assetVersionIds = [], reason = '') {
    if (!currentShot.value?.id || acting.value) return null
    acting.value = true
    error.value = null
    const shotId = Number(currentShot.value.id)
    const runId = Number(currentRun.value.id)
    try {
      const response = await paperStudioAPI.reviewAssets(shotId, {
        request_id: requestId(),
        expected_version: Number(currentShot.value.version),
        action,
        asset_version_ids: assetVersionIds.map(Number),
        ...(action === 'reject' ? { reason } : {}),
      })
      await openRun(runId)
      await openShot(shotId)
      await loadRuns()
      return response
    } catch (cause) {
      error.value = cause.message || '独立素材语义审核失败'
      try { await openShot(shotId) } catch (_) {}
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function uploadAssetReplacement(slotId, file) {
    if (!currentShot.value?.id || !slotId || !file || acting.value) return null
    acting.value = true
    error.value = null
    const shotId = Number(currentShot.value.id)
    const runId = Number(currentRun.value.id)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('request_id', requestId())
      formData.append('expected_version', String(currentShot.value.version))
      const response = await paperStudioAPI.uploadAssetReplacement(shotId, slotId, formData)
      await openRun(runId)
      await openShot(shotId)
      await loadRuns()
      return response
    } catch (cause) {
      error.value = cause.message || '上传替换素材失败'
      try { await openShot(shotId) } catch (_) {}
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function patchAssetMask(assetVersionId, points, feather = 0.35) {
    if (!currentShot.value?.id || !assetVersionId || !points?.length || acting.value) return null
    acting.value = true
    error.value = null
    const shotId = Number(currentShot.value.id)
    const runId = Number(currentRun.value.id)
    try {
      const response = await paperStudioAPI.patchAssetMask(shotId, assetVersionId, {
        request_id: requestId(), expected_version: Number(currentShot.value.version),
        points, feather: Number(feather),
      })
      await openRun(runId)
      await openShot(shotId)
      await loadRuns()
      return response
    } catch (cause) {
      error.value = cause.message || 'Mask 修正失败'
      try { await openShot(shotId) } catch (_) {}
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function rematteAsset(assetVersionId) {
    if (!currentShot.value?.id || acting.value) return null
    acting.value = true
    error.value = null
    const shotId = Number(currentShot.value.id)
    const runId = Number(currentRun.value.id)
    try {
      const response = await paperStudioAPI.rematteAssets(shotId, {
        request_id: requestId(),
        expected_version: Number(currentShot.value.version),
        asset_version_ids: [Number(assetVersionId)],
      })
      await openRun(runId)
      await openShot(shotId)
      await loadRuns()
      return response
    } catch (cause) {
      error.value = cause.message || '重新抠图失败'
      try { await openShot(shotId) } catch (_) {}
      throw cause
    } finally {
      acting.value = false
    }
  }

  async function rejectPreview(reason) {
    const text = String(reason || '').trim()
    if (!currentShot.value?.id || text.length < 2 || acting.value) return null
    acting.value = true
    error.value = null
    const shotId = Number(currentShot.value.id)
    const runId = Number(currentRun.value.id)
    try {
      const response = await paperStudioAPI.rejectPreview(shotId, {
        request_id: requestId(),
        expected_version: Number(currentShot.value.version),
        reason: text,
      })
      await openRun(runId)
      await openShot(shotId)
      await loadRuns()
      return response
    } catch (cause) {
      error.value = cause.message || '预览退回失败'
      try { await openShot(shotId) } catch (_) {}
      throw cause
    } finally {
      acting.value = false
    }
  }

  function closeRun() {
    currentRun.value = null
    currentShot.value = null
    runEvents.value = []
    if (!currentPaperStoryboard.value) currentPaperStoryboard.value = paperStoryboards.value[0] || null
  }

  async function refreshDoctor() {
    doctor.value = await paperStudioAPI.doctor()
    return doctor.value
  }

  return {
    drama,
    project,
    runs,
    providers,
    actions,
    paperEpisodes,
    paperStoryboards,
    episodeMerges,
    episodeDelivery,
    taskCenter,
    taskCenterLoading,
    runEvents,
    referenceCandidates,
    currentAudio,
    draftByStoryboardId,
    draftDirtyByStoryboardId,
    saveStateByStoryboardId,
    currentRun,
    currentShot,
    currentPaperStoryboard,
    selectedEpisodeId,
    selectedStoryboardIds,
    doctor,
    loading,
    creatingRun,
    acting,
    authoring,
    error,
    errorContext,
    episodes,
    legacyEpisodes,
    currentEpisode,
    storyboards,
    hasUnsavedDrafts,
    setStoryboardDraft,
    loadWorkspace,
    selectEpisode,
    loadPaperEpisodes,
    loadEpisodeStoryboards,
    loadEpisodeMerges,
    loadEpisodeDelivery,
    loadTaskCenter,
    recordProductEvent,
    loadReferenceCandidates,
    loadStoryboardAudio,
    toggleStoryboard,
    createPaperEpisode,
    createExampleDraft,
    createPaperStoryboard,
    selectPaperStoryboard,
    savePaperStoryboard,
    ensureDraftSaved,
    ensureDraftsSaved,
    duplicatePaperStoryboard,
    deletePaperStoryboard,
    reorderPaperStoryboards,
    importLegacyStoryboards,
    scripts,
    latestScript,
    loadScripts,
    loadScriptContent,
    saveScript,
    library,
    extractionResult,
    extracting,
    loadLibrary,
    extractEntities,
    clearExtraction,
    confirmEntities,
    updateLibraryEntity,
    setStyleAnchor,
    identityGenerating,
    storyboardDraft,
    storyboardGenerating,
    storyboardRepairing,
    storyboardRepairPreview,
    currentStoryboardRepairing,
    currentStoryboardRepairPreview,
    generateIdentities,
    reviewIdentityVersion,
    generateStoryboardsDraft,
    clearStoryboardDraft,
    repairGeneratedStoryboardsDraft,
    acceptStoryboardRepairPreview,
    clearStoryboardRepairPreview,
    repairCurrentPaperStoryboard,
    acceptCurrentStoryboardRepairPreview,
    clearCurrentStoryboardRepairPreview,
    applyGeneratedStoryboards,
    generateReference,
    uploadReference,
    selectReference,
    saveReferenceConstraints,
    synthesizePaperAudio,
    uploadPaperAudio,
    revisePaperAudio,
    setPaperAudioPolicy,
    mergePaperEpisode,
    syncToLegacy,
    createRun,
    openRun,
    openShot,
    refreshActiveRun,
    loadRunEvents,
    getGenerationQuote,
    authorizeAndStartGeneration,
    controlRun,
    saveBlueprint,
    confirmBlueprint,
    runNextAction,
    advanceRun,
    syncAudioTiming,
    reviseMotion,
    reviewAssets,
    uploadAssetReplacement,
    patchAssetMask,
    rematteAsset,
    rejectPreview,
    closeRun,
    refreshDoctor,
  }
})
