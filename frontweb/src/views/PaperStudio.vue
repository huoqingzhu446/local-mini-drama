<template>
  <div class="paper-studio" :class="{ 'is-loading': loading, 'has-recovery': restoreLabel && !taskDrawerOpen, 'has-error': Boolean(error) }">
    <PaperStudioHeader
      :drama="drama"
      :project="project"
      :doctor="doctor"
      :task-center="taskCenter"
      :busy="loading"
      @back="goBack"
      @legacy="openLegacy"
      @refresh="refreshWorkspace"
      @tasks="openTaskCenter"
    />

    <div v-if="restoreLabel && !taskDrawerOpen" class="recovery-strip">
      <span>已恢复上次位置</span>
      <strong>{{ restoreLabel }}</strong>
      <button type="button" @click="openTaskCenter('attention')">查看任务</button>
      <button type="button" aria-label="关闭恢复提示" @click="dismissRestore">×</button>
    </div>

    <div v-if="error" class="error-banner" role="alert" aria-live="assertive">
      <div class="error-banner-copy">
        <strong>当前操作未完成</strong>
        <span>{{ error }}</span>
      </div>
      <div class="error-banner-actions">
        <button v-if="transitionRecovery" type="button" class="solution-action" @click="solutionDialogOpen = true">查看解决方案</button>
        <button type="button" class="reload-action" @click="refreshWorkspace">重新加载</button>
      </div>
    </div>

    <div class="studio-layout" :class="{ 'rail-collapsed': railCollapsed }">
      <aside class="left-rail" :class="{ collapsed: railCollapsed }">
        <button type="button" class="rail-collapse-toggle" :aria-label="railCollapsed ? '展开左栏' : '收起左栏'" @click="railCollapsed = !railCollapsed">
          <template v-if="railCollapsed"><span>⟩</span><i>{{ storyboards.length }}</i></template>
          <template v-else><span>⟨</span> 收起面板</template>
        </button>
        <PaperEpisodeRail
          :episodes="episodes"
          :selected-id="selectedEpisodeId"
          @select="selectEpisode"
          @create="createEpisode"
        />
        <PaperStoryboardRail
          :episode-id="selectedEpisodeId"
          :storyboards="storyboards"
          :current-id="currentPaperStoryboard?.id"
          :selected-ids="selectedStoryboardIds"
          :busy="authoring"
          @create="createStoryboard"
          @select="selectStoryboard"
          @toggle="toggleStoryboard"
          @move="moveStoryboard"
          @history="openStoryboardHistory"
        />

        <div class="rail-secondary-actions">
          <button type="button" :disabled="!selectedEpisodeId || !legacyEpisodes.length || authoring" @click="importLegacy">
            从旧工作台导入
          </button>
          <small>单向复制，不会建立运行时依赖</small>
        </div>

        <details class="run-history" :open="Boolean(currentRun)">
          <summary>
            <span>生产版本</span>
            <i>{{ currentEpisodeRuns.length }}</i>
          </summary>
          <button
            v-if="unpublishedResumeRun && Number(unpublishedResumeRun.id) !== Number(currentRun?.id)"
            type="button"
            class="run-resume-card"
            @click="resumeUnpublishedRun"
          >
            <span>继续未发布版本</span>
            <strong>R{{ String(unpublishedResumeRun.run_number).padStart(2, '0') }} · {{ unpublishedRunResumeLabel(unpublishedResumeRun) }}</strong>
            <small>已保存到数据库，刷新不会删除 · {{ unpublishedResumeRun.progress }}%</small>
          </button>
          <button
            v-for="runItem in currentEpisodeRuns"
            :key="runItem.id"
            type="button"
            class="run-item"
            :class="{ active: Number(runItem.id) === Number(currentRun?.id) }"
            @click="openRun(runItem.id)"
          >
            <span class="run-number">R{{ String(runItem.run_number).padStart(2, '0') }}</span>
            <span class="run-copy">
              <strong>{{ runStatusLabel(runItem.status) }}</strong>
              <small>{{ runItem.paper_episode_id ? '独立纸片源' : '历史兼容源' }} · {{ runItem.shot_count }} 镜</small>
            </span>
            <span>{{ runItem.progress }}%</span>
          </button>
          <p v-if="!currentEpisodeRuns.length">当前分集还没有生产版本</p>
          <details v-if="historicalRuns.length" class="legacy-runs">
            <summary>历史兼容版本（{{ historicalRuns.length }}）</summary>
            <button v-for="runItem in historicalRuns" :key="runItem.id" type="button" class="run-item" @click="openRun(runItem.id)">
              <span class="run-number">R{{ String(runItem.run_number).padStart(2, '0') }}</span>
              <span class="run-copy"><strong>{{ runStatusLabel(runItem.status) }}</strong><small>历史兼容源 · {{ runItem.shot_count }} 镜</small></span>
              <span>{{ runItem.progress }}%</span>
            </button>
          </details>
        </details>
      </aside>

      <main class="workspace">
        <template v-if="currentRun">
          <div class="production-heading">
            <button type="button" @click="returnToAuthoring">← 返回分镜创作</button>
            <div>
              <span>PRODUCTION RUN</span>
              <strong>R{{ String(currentRun.run_number).padStart(2, '0') }} · {{ runStatusLabel(currentRun.status) }}</strong>
            </div>
            <button v-if="currentShot?.paper_storyboard_id" type="button" class="history-entry" @click="openStoryboardHistory(currentShot.paper_storyboard_id)">查看该分镜全部历史</button>
          </div>
          <PaperShotRail
            mode="run"
            :run-shots="currentRun.shots || []"
            :current-shot-id="currentShot?.id"
            @select-shot="openShot"
          />
          <PaperRunOverview
            :run="currentRun"
            :shot="currentShot"
            :acting="acting"
            :actions="actions"
            :regenerating-slot-id="regeneratingSlotId"
            @approve-asset="approveAsset"
            @rematte-asset="rematteAsset"
            @reject-asset="rejectAsset"
            @regenerate-asset="regenerateAsset"
            @upload-asset="uploadAsset"
            @patch-asset-mask="patchAssetMask"
            @reject-preview="rejectPreview"
            @save-blueprint="saveBlueprint"
            @confirm-blueprint="confirmBlueprint"
            @revise-motion="reviseMotionFromEvidence"
            @edit-audio="editShotAudio"
          />
        </template>

        <template v-else>
          <nav class="workspace-modes" aria-label="纸片工作区">
            <button type="button" :class="{ active: workspaceMode === 'script' }" @click="showScript">
              剧本与实体
              <i>{{ scripts.length }}</i>
            </button>
            <button type="button" :class="{ active: workspaceMode === 'authoring' }" @click="showAuthoring">分镜创作</button>
            <button type="button" :class="{ active: workspaceMode === 'delivery' }" @click="showDelivery">
              分集交付
              <i>{{ episodeDelivery?.ready_count || 0 }}/{{ episodeDelivery?.total_count || 0 }}</i>
            </button>
          </nav>

          <div v-if="workspaceMode === 'script'" class="script-stage">
            <PaperScriptWorkbench
              :episode="currentEpisode"
              :scripts="scripts"
              :latest="latestScript"
              :active-script="activeScript"
              :busy="authoring"
              :saving="savingScript"
              :draft="storyboardDraft"
              :generating-storyboards="storyboardGenerating"
              :applying="applyingStoryboards"
              :repairing="storyboardRepairing"
              :repair-preview="storyboardRepairPreview"
              :can-generate-storyboards="scripts.length > 0 && Boolean(library?.entities?.length)"
              :has-entities="Boolean(library?.entities?.length)"
              :existing-shot-count="storyboards.length"
              @save="onSaveScript"
              @select-version="onSelectScriptVersion"
              @generate-storyboards="onGenerateStoryboards"
              @repair-storyboards="onRepairStoryboards"
              @accept-repairs="onAcceptStoryboardRepairs"
              @discard-repairs="store.clearStoryboardRepairPreview"
              @apply-storyboards="onApplyStoryboards"
              @discard-draft="store.clearStoryboardDraft"
            />
            <PaperEntityWorkbench
              :library="library"
              :extraction="extractionResult"
              :extracting="extracting"
              :confirming="confirmingEntities"
              :can-extract="Boolean(latestScript) && Boolean(currentEpisode)"
              :generating="identityGenerating"
              :provider-ready="Boolean(selectedProvider?.ready)"
              :busy="authoring"
              @extract="onExtractEntities"
              @confirm="onConfirmEntities"
              @discard="store.clearExtraction"
              @update-entity="onUpdateEntity"
              @archive="onArchiveEntity"
              @save-style-anchor="onSaveStyleAnchor"
              @generate-identities="onGenerateIdentities"
              @review-identity="onReviewIdentity"
            />
          </div>

          <PaperDeliveryBoard
            v-else-if="workspaceMode === 'delivery'"
            :delivery="episodeDelivery"
            :busy="authoring"
            @fix="fixDeliveryBlocker"
            @merge="mergeEpisode"
            @refresh="refreshDelivery"
          />

          <PaperStoryboardEditor
            v-else
            :storyboard="currentPaperStoryboard"
            :episode="currentEpisode"
            :busy="authoring || currentStoryboardRepairing"
            :save-state="saveStateByStoryboardId[currentPaperStoryboard?.id] || 'saved'"
            :references="referenceCandidates"
            :reference-ready="currentStoryboardReady && Boolean(selectedProvider?.ready)"
            :storyboard-complete="currentStoryboardReady"
            :can-repair="Boolean(latestScript)"
            :repairing="currentStoryboardRepairing"
            :repair-preview="currentStoryboardRepairPreview"
            :audio="currentAudio"
            :fps="Number(currentEpisode?.fps || 30)"
            @save="saveStoryboard"
            @draft-change="onDraftChange"
            @duplicate="duplicateStoryboard"
            @delete="deleteStoryboard"
            @repair="onRepairCurrentStoryboard"
            @accept-repair="onAcceptCurrentStoryboardRepair"
            @discard-repair="store.clearCurrentStoryboardRepairPreview"
            @create-storyboard="createStoryboard"
            @create-episode="createEpisode"
            @generate-reference="generateReference"
            @upload-reference="uploadReference"
            @select-reference="selectReference"
            @save-reference-constraints="saveReferenceConstraints"
            @synthesize-audio="synthesizeAudio"
            @upload-audio="uploadAudio"
            @revise-audio="reviseAudio"
            @set-audio-policy="setAudioPolicy"
          />
        </template>
      </main>

      <aside class="inspector">
        <template v-if="currentRun">
          <section class="inspector-section next-action">
            <div class="inspector-heading"><span>当前生产步骤</span><i>{{ currentRun.progress }}%</i></div>
            <strong>{{ currentActionLabel }}</strong>
            <p>{{ nextActionDescription }}</p>
            <button v-if="canRunCurrentAction" type="button" class="primary-action" :disabled="currentActionBusy || currentActionType === 'wait_for_render'" @click="runCurrentAction">
              {{ currentActionButtonLabel }}
            </button>
            <button v-if="canAdvanceRun" type="button" class="secondary-action" :disabled="acting" @click="advanceRun">
              {{ acting ? '批量执行中…' : batchActionLabel }}
            </button>
            <small v-if="canAdvanceRun">批量推进会在人工素材审核和预览批准点停下。</small>
            <button type="button" class="secondary-action" :disabled="acting" @click="downloadRunReport">导出生产报告</button>
            <div v-if="canControlRun" class="run-controls">
              <button v-if="!currentRun.paused" type="button" class="secondary-action" :disabled="acting" @click="pauseRun">暂停后续任务</button>
              <button v-else type="button" class="secondary-action" :disabled="acting" @click="resumeRun">恢复生产</button>
              <button type="button" class="danger-action" :disabled="acting" @click="cancelRun">取消生产版本</button>
            </div>
          </section>

          <section v-if="runEvents.length" class="inspector-section event-stream">
            <div class="inspector-heading"><span>生产事件</span><i>{{ runEvents.length }}</i></div>
            <article v-for="event in runEvents.slice(0, 5)" :key="event.id" :class="event.severity">
              <strong>{{ event.title }}</strong>
              <p>{{ event.message }}</p>
              <small>{{ new Date(event.created_at).toLocaleString() }}</small>
            </article>
          </section>

          <section v-if="canReviseMotion" class="inspector-section">
            <div class="inspector-heading"><span>动作修订</span><i>SAFE DSL</i></div>
            <textarea v-model="motionRevision" rows="4" maxlength="500" placeholder="例如：主体动作再大一点，遮挡提前一些" />
            <button type="button" class="secondary-action" :disabled="acting || motionRevision.trim().length < 2" @click="applyMotionRevision">
              应用并重新执行门禁
            </button>
          </section>
        </template>

        <template v-else>
          <section class="inspector-section">
            <div class="inspector-heading"><span>参考图图片 API</span><i>{{ selectedProvider?.ready ? 'READY' : 'BLOCKED' }}</i></div>
            <select v-model.number="imageProviderConfigId" aria-label="参考图图片 API">
              <option :value="null" disabled>选择图片 API</option>
              <option v-for="provider in providers" :key="provider.id" :value="provider.id" :disabled="!provider.ready">
                {{ provider.name }} · {{ provider.model || '未选模型' }}
              </option>
            </select>
            <div v-if="selectedProvider" class="provider-facts">
              <span>{{ selectedProvider.capabilities.reference_images ? '支持参考图' : '不支持参考图' }}</span>
              <span>{{ selectedProvider.capabilities.transparent_background ? '支持透明输出' : '后续本地 Alpha' }}</span>
            </div>
            <p v-for="warning in selectedProvider?.warnings || []" :key="warning.code" class="warning-copy">{{ warning.message }}</p>
            <small>主工作区中的“调用图片 API 生成”会使用这里的配置；上传本地参考图不消耗图片调用。</small>
            <small v-if="currentPaperStoryboard && !currentStoryboardReady" class="blocking-copy">请先补齐并保存画面描述，以及主体动作（纯环境镜头除外）。</small>
          </section>

          <section class="inspector-section production-setup">
            <div class="inspector-heading"><span>开始制作</span><i>{{ selectedStoryboardIds.length }} SHOTS</i></div>
            <div class="tier-selector">
              <button v-for="tier in tiers" :key="tier.value" type="button" :class="{ active: qualityTier === tier.value }" @click="qualityTier = tier.value">
                <strong>{{ tier.label }}</strong>
                <small>{{ tier.images }} 图上限</small>
              </button>
            </div>
            <p>{{ productionReadinessMessage }}</p>
            <button
              type="button"
              class="primary-action"
              :disabled="creatingRun || !selectedStoryboardsReady || !doctor?.ok || !selectedProvider?.ready"
              @click="createRun"
            >
              {{ creatingRun ? '正在冻结版本…' : '创建生产版本' }}
            </button>
          </section>

          <section class="inspector-section episode-output">
            <div class="inspector-heading"><span>分集交付</span><i>{{ episodeDelivery?.ready_count || 0 }}/{{ episodeDelivery?.total_count || 0 }}</i></div>
            <p>{{ deliverySummary }}</p>
            <button type="button" class="secondary-action" :disabled="authoring || !currentEpisode" @click="showDelivery">打开四镜交付看板</button>
            <a v-if="latestMerge?.status === 'completed' && latestMerge.merged_url" :href="mediaUrl(latestMerge.merged_url)" target="_blank">播放最新整集 ↗</a>
            <a v-if="latestMerge?.status === 'completed' && latestMerge.subtitle_url" :href="mediaUrl(latestMerge.subtitle_url)" download>下载整集字幕</a>
            <span v-else-if="latestMerge" class="merge-state">{{ mergeStatusLabel(latestMerge.status) }}</span>
          </section>

          <section class="inspector-section legacy-sync">
            <div class="inspector-heading"><span>旧工作台</span><i>OPTIONAL</i></div>
            <p>纸片分镜默认只保存在这里。只有点击下面按钮并确认目标分集，才会复制到旧工作台。</p>
            <button type="button" class="secondary-action" :disabled="authoring || !currentPaperStoryboard || !legacyEpisodes.length" @click="syncToLegacy">
              显式同步当前分镜
            </button>
          </section>

          <section class="inspector-section environment-check">
            <div class="inspector-heading"><span>环境</span><i :class="doctor?.ok ? 'ok' : 'blocked'">{{ doctor?.ok ? 'READY' : 'BLOCKED' }}</i></div>
            <p v-for="item in doctor?.blocking || []" :key="item.code" class="blocking-copy">{{ item.message }}</p>
            <p v-if="doctor?.ok">独立数据表、Schema 与存储检查通过。</p>
          </section>
        </template>
      </aside>
    </div>

    <div v-if="loading" class="loading-layer" aria-live="polite">
      <span></span>
      <strong>正在装载纸片工作台</strong>
    </div>

    <PaperTaskCenter
      v-model:section="taskSection"
      :open="taskDrawerOpen"
      :center="taskCenter"
      :loading="taskCenterLoading"
      :onboarding="onboardingChecklist"
      :restore-label="restoreLabel"
      :can-create-example="episodes.length === 0"
      :example-busy="authoring"
      @close="taskDrawerOpen = false"
      @refresh="store.loadTaskCenter"
      @navigate="navigateTask"
      @control="controlTask"
      @create-example="createExampleDraft"
      @dismiss-restore="dismissRestore"
    />
    <PaperImpactDialog
      :open="impactDialog.open"
      :title="impactDialog.title"
      :description="impactDialog.description"
      :impact="impactDialog.impact"
      :confirm-label="impactDialog.confirmLabel"
      :cancel-label="impactDialog.cancelLabel"
      :tone="impactDialog.tone"
      :busy="impactDialog.busy"
      @confirm="resolveImpact(true)"
      @cancel="resolveImpact(false)"
    />
    <PaperHistoryReuseReviewDialog
      :open="reuseReviewOpen"
      :preview="reuseReviewPreview"
      :busy="reuseReviewBusy"
      @confirm="resolveHistoryReuseReview"
      @cancel="reuseReviewOpen = false"
    />
    <PaperStoryboardHistoryDrawer
      :open="historyDrawerOpen"
      :storyboard-id="historyStoryboardId"
      @close="historyDrawerOpen = false"
      @open-center="openHistoryCenter"
    />
    <PaperStoryboardHistoryCenter
      :open="historyCenterOpen"
      :storyboard-id="historyStoryboardId"
      :initial-selection="historyCenterSelection"
      @close="historyCenterOpen = false"
      @forked="handleHistoryForked"
    />

    <div v-if="solutionDialogOpen && transitionRecovery" class="solution-overlay" @click.self="solutionDialogOpen = false">
      <section class="solution-dialog" role="dialog" aria-modal="true" aria-labelledby="transition-solution-title">
        <header>
          <div>
            <span>CONTINUITY RECOVERY</span>
            <h2 id="transition-solution-title">{{ transitionRecovery.title }}</h2>
          </div>
          <button type="button" aria-label="关闭解决方案" @click="solutionDialogOpen = false">×</button>
        </header>

        <div class="solution-context">
          <strong v-if="transitionRecovery.context.shot_number || transitionRecovery.context.title">
            分镜 {{ String(transitionRecovery.context.shot_number || currentShot?.shot_index + 1 || '').padStart(2, '0') }}
            <template v-if="transitionRecovery.context.title"> · {{ transitionRecovery.context.title }}</template>
          </strong>
          <p>{{ transitionRecovery.summary }}</p>
        </div>

        <ol class="solution-list">
          <li v-for="item in transitionRecovery.visibleFailures" :key="item.key">
            <span>{{ item.message }}</span>
            <strong>建议：{{ item.advice }}</strong>
          </li>
        </ol>
        <p v-if="transitionRecovery.hiddenFailureCount" class="solution-more">另有 {{ transitionRecovery.hiddenFailureCount }} 项同类问题，可先按以上建议修改后重新检查。</p>

        <div class="solution-steps">
          <span>接下来</span>
          <p>旧计划和所有历史图片都会保留。若只调整动作、转场或时间，可在当前生产版本内预览零调用修复；只有主体、地点或脚本事实变化时才需要新建生产版本，未变化图片仍会先进入复用预检。</p>
        </div>

        <footer>
          <button v-if="currentShot?.motion_plan" type="button" class="solution-primary" :disabled="continuityRepairing" @click="previewContinuityRepair">
            {{ continuityRepairing ? '正在校验…' : '预览零调用修复' }}
          </button>
          <button type="button" class="solution-secondary" @click="openStoryboardHistory(transitionRecovery.context.paper_storyboard_id)">查看全部历史图片</button>
          <button type="button" class="solution-secondary" @click="editTransitionStoryboard">脚本事实已变化，定位原分镜</button>
          <button type="button" class="solution-secondary" @click="solutionDialogOpen = false">留在当前页面</button>
        </footer>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import PaperStudioHeader from '@/components/paper-studio/PaperStudioHeader.vue'
import PaperEpisodeRail from '@/components/paper-studio/PaperEpisodeRail.vue'
import PaperStoryboardRail from '@/components/paper-studio/PaperStoryboardRail.vue'
import PaperStoryboardEditor from '@/components/paper-studio/PaperStoryboardEditor.vue'
import PaperDeliveryBoard from '@/components/paper-studio/PaperDeliveryBoard.vue'
import PaperScriptWorkbench from '@/components/paper-studio/PaperScriptWorkbench.vue'
import PaperEntityWorkbench from '@/components/paper-studio/PaperEntityWorkbench.vue'
import PaperShotRail from '@/components/paper-studio/PaperShotRail.vue'
import PaperRunOverview from '@/components/paper-studio/PaperRunOverview.vue'
import PaperTaskCenter from '@/components/paper-studio/PaperTaskCenter.vue'
import PaperImpactDialog from '@/components/paper-studio/PaperImpactDialog.vue'
import PaperHistoryReuseReviewDialog from '@/components/paper-studio/PaperHistoryReuseReviewDialog.vue'
import PaperStoryboardHistoryDrawer from '@/components/paper-studio/PaperStoryboardHistoryDrawer.vue'
import PaperStoryboardHistoryCenter from '@/components/paper-studio/PaperStoryboardHistoryCenter.vue'
import { paperStudioAPI } from '@/api/paperStudio'
import { usePaperStudioStore } from '@/stores/paperStudioStore'
import {
  buildPaperRestoreLabel,
  hasExplicitPaperRoute,
  loadPaperStudioContext,
  paperStudioOnboardingKey,
  savePaperStudioContext,
} from '@/utils/paperStudioExperience'
import {
  findBestUnpublishedRun,
  isEnvironmentProductionShot,
  paperProductionActionDescription,
  paperProductionActionLabel,
  unpublishedRunResumeLabel,
} from '@/utils/paperStudioProduction'
import { mergeStatusLabel, runStatusLabel } from '@/utils/paperStudioLabels'
import { buildTransitionGateRecovery } from '@/utils/paperStudioRecovery'

const route = useRoute()
const router = useRouter()
const store = usePaperStudioStore()
const {
  drama, project, runs, providers, actions, currentRun, currentShot, currentPaperStoryboard,
  selectedEpisodeId, selectedStoryboardIds, doctor, loading, creatingRun, acting,
  authoring, error, errorContext, episodes, legacyEpisodes, currentEpisode, storyboards, episodeMerges,
  runEvents, draftByStoryboardId, saveStateByStoryboardId, hasUnsavedDrafts,
  referenceCandidates, currentAudio, episodeDelivery, taskCenter, taskCenterLoading,
  scripts, latestScript, library, extractionResult, extracting,
  identityGenerating, storyboardDraft, storyboardGenerating, storyboardRepairing, storyboardRepairPreview,
  currentStoryboardRepairing, currentStoryboardRepairPreview,
} = storeToRefs(store)

const dramaId = computed(() => Number(route.params.id || route.params.dramaId))
const qualityTier = ref('balanced')
const imageProviderConfigId = ref(null)
const motionRevision = ref('')
const regeneratingSlotId = ref(null)
const solutionDialogOpen = ref(false)
const historyDrawerOpen = ref(false)
const historyStoryboardId = ref(null)
const historyCenterOpen = ref(false)
const historyCenterSelection = ref(null)
const reuseReviewOpen = ref(false)
const reuseReviewPreview = ref(null)
const reuseReviewBusy = ref(false)
const continuityRepairing = ref(false)
const taskDrawerOpen = ref(false)
const railCollapsed = ref(false)
const taskSection = ref('attention')
const restoredContext = ref(null)
const restoreLabel = ref('')
const impactDialog = reactive({
  open: false, title: '', description: '', impact: {}, confirmLabel: '确认继续',
  cancelLabel: '取消', tone: 'warning', busy: false,
})
let impactResolver = null
const WORKSPACE_STAGES = ['script', 'authoring', 'delivery']
const workspaceMode = ref(WORKSPACE_STAGES.includes(route.query.stage) ? route.query.stage : 'authoring')
watch(() => route.query.stage, (stage) => {
  if (!currentRun.value) workspaceMode.value = WORKSPACE_STAGES.includes(stage) ? stage : 'authoring'
})
const tiers = [
  { value: 'draft', label: '草稿', images: 12 },
  { value: 'balanced', label: '标准', images: 24 },
  { value: 'full-depth', label: '精细', images: 48 },
]
const selectedProvider = computed(() => providers.value.find((provider) => Number(provider.id) === Number(imageProviderConfigId.value)) || null)
const onboardingChecklist = computed(() => [
  {
    key: 'episode', label: '建立独立纸片分集',
    detail: '纸片分集与旧工作台隔离，只有显式导入或同步才会复制。',
    done: episodes.value.length > 0,
  },
  {
    key: 'storyboard', label: '补齐并保存分镜脚本',
    detail: '标题、画面描述和主体动作是正式生产的最小输入。',
    done: storyboards.value.some((item) => storyboardReady(item)),
  },
  {
    key: 'provider', label: '选择可用的图片 API',
    detail: '确认蓝图不会调用图片，正式生成前还会单独展示数量。',
    done: Boolean(selectedProvider.value?.ready),
  },
  {
    key: 'delivery', label: '完成正式发布与整集交付',
    detail: '每镜脚本、素材、动作、声音和正式视频都通过后才能合并。',
    done: Boolean(episodeDelivery.value?.ready && episodeDelivery.value?.total_count),
  },
])
const latestMerge = computed(() => episodeDelivery.value?.latest_merge || episodeMerges.value[0] || null)
const deliverySummary = computed(() => {
  if (!episodeDelivery.value?.total_count) return '新建分镜后，这里会显示脚本、动作、声音和正式视频是否就绪。'
  if (episodeDelivery.value.ready) return '当前声音版本已进入所有正式视频，可以合并并下载有声整集。'
  const blockers = episodeDelivery.value.blockers || []
  const first = blockers[0]
  if (!first) return '正在检查当前分集的交付状态。'
  return `还差 ${blockers.length} 项；先处理分镜 ${String(first.shot_number).padStart(2, '0')}：${first.label}。`
})
const currentEpisodeRuns = computed(() => runs.value.filter((item) => Number(item.paper_episode_id) === Number(selectedEpisodeId.value)))
const historicalRuns = computed(() => runs.value.filter((item) => !item.paper_episode_id))
const unpublishedResumeRun = computed(() => findBestUnpublishedRun(currentEpisodeRuns.value, {
  paperEpisodeId: selectedEpisodeId.value,
}))
const transitionRecovery = computed(() => buildTransitionGateRecovery(errorContext.value, {
  shot_id: currentShot.value?.id,
  paper_storyboard_id: currentShot.value?.paper_storyboard_id,
  shot_number: Number(currentShot.value?.shot_index || 0) + 1,
  title: currentShot.value?.storyboard?.title || '',
}))
watch(transitionRecovery, (recovery) => {
  if (!recovery) solutionDialogOpen.value = false
})
function storyboardForm(storyboard) {
  return draftByStoryboardId.value[storyboard?.id] || storyboard || {}
}
function storyboardReady(storyboard) {
  const value = storyboardForm(storyboard)
  return Boolean(String(value.title || '').trim()
    && String(value.description || '').trim()
    && (Boolean(value.environment_only) || String(value.action || '').trim()))
}
const currentStoryboardReady = computed(() => storyboardReady(currentPaperStoryboard.value))
const selectedStoryboardsReady = computed(() => selectedStoryboardIds.value.length > 0 && selectedStoryboardIds.value.every((id) => {
  const storyboard = storyboards.value.find((item) => Number(item.id) === Number(id))
  return storyboardReady(storyboard)
}))
const productionReadinessMessage = computed(() => {
  if (!selectedStoryboardIds.value.length) return '请先勾选至少一个分镜。'
  if (!selectedStoryboardsReady.value) return '所选分镜仍缺画面描述或主体动作，补齐并保存后才能创建生产版本。'
  if (hasUnsavedDrafts.value) return '草稿将在创建前自动保存；保存失败时不会冻结生产版本。'
  return '创建版本只冻结已保存的分镜 revision、风格和预算，不会调用图片 API。'
})
const currentActionType = computed(() => currentShot.value?.next_action?.type || currentRun.value?.next_action?.type)
const currentActionLabel = computed(() => paperProductionActionLabel(
  currentShot.value,
  currentShot.value?.next_action?.label || currentRun.value?.next_action?.label || '继续生产',
))
const actionStepKeys = {
  plan_motion: 'plan_motion',
  revise_motion: 'plan_motion',
  run_proof: 'render_proof',
  inspect_evidence: 'render_proof',
  render_preview: 'render_preview',
  render_formal: 'render_formal',
  retry_render: 'render_formal',
  publish_video: 'publish_video',
}
const currentActionStep = computed(() => {
  const stepKey = actionStepKeys[currentActionType.value]
  if (!stepKey) return null
  return (currentShot.value?.steps || []).find((step) => step.step_key === stepKey) || null
})
const currentActionQueueState = computed(() => (
  ['queued', 'running'].includes(currentActionStep.value?.status) ? currentActionStep.value.status : null
))
const currentActionBusy = computed(() => Boolean(acting.value || currentActionQueueState.value))
const currentActionButtonLabel = computed(() => {
  if (acting.value || currentActionQueueState.value === 'running') return '正在执行…'
  if (currentActionQueueState.value === 'queued') return '已排队，等待后台执行'
  return currentActionLabel.value
})
const runnableStates = new Set(['draft', 'analyzing', 'plan_review', 'awaiting_generation_authorization', 'assets_generating', 'assets_processing', 'motion_planning', 'proofing', 'preview_ready', 'approved', 'rendering', 'partial', 'failed'])
const nonExecutableActions = new Set(['review_source_changes', 'review_assets', 'review_preview', 'generate_assets', 'retry_failed_asset', 'wait_for_render'])
const canRunCurrentAction = computed(() => Boolean(currentActionType.value)
  && !nonExecutableActions.has(currentActionType.value)
  && !currentActionType.value.startsWith('wait_for_')
  && runnableStates.has(currentRun.value?.status))
const batchableStates = new Set(['draft', 'analyzing', 'plan_review', 'assets_generating', 'assets_processing', 'motion_planning', 'proofing', 'preview_ready', 'approved', 'rendering', 'partial', 'failed'])
const canAdvanceRun = computed(() => Boolean(currentRun.value?.id) && batchableStates.has(currentRun.value.status) && (currentRun.value.shots || []).some((shot) => !['published', 'cancelled', 'stale'].includes(shot.status)))
const revisableStates = new Set(['analyzed', 'plan_confirmed', 'asset_failed', 'asset_ready', 'motion_failed', 'motion_ready', 'proof_failed', 'proof_ready', 'preview_ready', 'approved', 'render_failed', 'rendered'])
const canReviseMotion = computed(() => Boolean(currentShot.value?.motion_plan) && revisableStates.has(currentShot.value?.status))
const canControlRun = computed(() => Boolean(currentRun.value?.id) && !['delivered', 'cancelled', 'stale'].includes(currentRun.value.status))
const batchActionLabel = computed(() => {
  const shots = currentRun.value?.shots || []
  const statuses = new Set(shots.map((shot) => shot.status))
  const environmentOnly = shots.length > 0 && shots.every(isEnvironmentProductionShot)
  const activeShots = shots.filter((shot) => !['published', 'cancelled', 'stale'].includes(shot.status))
  const previewFailures = activeShots.filter((shot) => shot.last_error_json?.step_key === 'render_preview'
    && ['proof_ready', 'proof_failed'].includes(shot.status))
  if (statuses.has('pending')) return '批量分析全部分镜'
  if (statuses.has('analyzed')) return '批量确认全部计划'
  if (statuses.has('plan_confirmed') || statuses.has('asset_failed')) return environmentOnly ? '批量生成／修复环境底板' : '批量生成／重试素材'
  if (statuses.has('asset_ready') || statuses.has('motion_failed')) return environmentOnly ? '批量生成／修复环境动态' : '批量规划主体动作'
  if (activeShots.length > 0 && previewFailures.length === activeShots.length) return '批量重试预览渲染'
  if (statuses.has('motion_ready') || statuses.has('proof_failed')) return environmentOnly ? '批量检查环境动态' : '批量执行动态门禁'
  if (statuses.has('proof_ready')) return '批量渲染预览'
  if (statuses.has('approved') || statuses.has('render_failed')) return '批量渲染正式视频'
  if (statuses.has('rendered')) return '批量发布到纸片分镜'
  return '批量推进本阶段'
})
const nextActionDescription = computed(() => paperProductionActionDescription(currentShot.value, ({
  analyze_shot: '提取通用场景边界、主体、状态和动作目标；不调用图片 API。',
  analyze_run: '分析所选纸片分镜的独立层和动作关系；不调用图片 API。',
  confirm_shot_plan: '只冻结素材与动作蓝图，不会调用图片 API。确认后仍需查看费用并单独授权。',
  confirm_plan: '只冻结素材与动作蓝图，不会调用图片 API。确认后仍需查看费用并单独授权。',
  authorize_generation: '查看模型、素材数量、最大尝试次数和范围；只有再次确认后才会调用图片 API。',
  generate_assets: '调用已选图片 API，生成干净背景、角色和道具独立候选层。',
  retry_failed_asset: '只重试未通过的素材槽位，保留已接受版本。',
  review_assets: '逐张检查背景和透明主体层；批准后才允许动作规划。',
  plan_motion: '校验主体动作幅度、状态变化和遮挡关系，通过后冻结 snapshot。',
  revise_motion: '动作未通过门禁，需要修改主体动作或关系，不能用运镜替代。',
  run_proof: '渲染证明帧，生成 ROI、像素差和遮挡证据。',
  inspect_evidence: '检查失败证据后局部修订动作计划。',
  render_preview: '复用已通过的动态证明和同一 snapshot 重试低清预览，不调用图片 API。',
  approve_preview: '批准并绑定 snapshot、render hash 和 proof hash。',
  render_formal: '用已批准 snapshot 渲染正式 H.264。',
  retry_render: '复用同一 snapshot 重试正式渲染。',
  wait_for_render: '正式渲染已在后台执行；可以离开当前分镜，完成后会自动发布。',
  publish_video: '正式视频只写回独立纸片分镜，可继续参与纸片整集合并。',
  review_source_changes: '这是失效或历史兼容版本，请返回创作区创建新的独立生产版本。',
}[currentActionType.value] || '按持久化工作流执行当前步骤。')))

let pollTimer = null
let autoSaveTimer = null

const MANUAL_POLL_ACTIONS = new Set([
  'confirm_shot_plan', 'confirm_plan', 'authorize_generation', 'review_assets',
  'inspect_evidence', 'approve_preview', 'review_preview', 'review_source_changes',
])
const MANUAL_POLL_STATUSES = new Set([
  'plan_review', 'awaiting_generation_authorization', 'assets_processing', 'proof_ready', 'preview_ready',
])

function activePollDelay() {
  if (currentRun.value?.id && !['delivered', 'stale', 'cancelled'].includes(currentRun.value.status)) {
    return MANUAL_POLL_ACTIONS.has(currentActionType.value) || MANUAL_POLL_STATUSES.has(currentRun.value.status)
      ? 8000
      : 2500
  }
  if (latestMerge.value && ['pending', 'processing'].includes(latestMerge.value.status)) return 2500
  if (taskDrawerOpen.value && Number(taskCenter.value?.summary?.processing || 0) > 0) return 2500
  return null
}

function schedulePoll(delay = activePollDelay()) {
  if (pollTimer || delay == null) return
  pollTimer = window.setTimeout(runPoll, Math.max(0, Number(delay)))
}

async function runPoll() {
  pollTimer = null
  if (document.visibilityState === 'visible' && !acting.value && !authoring.value) {
    try {
      if (currentRun.value?.id && !['delivered', 'stale', 'cancelled'].includes(currentRun.value.status)) await store.refreshActiveRun()
      else if (latestMerge.value && ['pending', 'processing'].includes(latestMerge.value.status)) {
        await Promise.all([store.loadPaperEpisodes(selectedEpisodeId.value), store.loadEpisodeMerges(), store.loadEpisodeDelivery()])
      }
      if (taskDrawerOpen.value && Number(taskCenter.value?.summary?.processing || 0) > 0) {
        await store.loadTaskCenter({ silent: true })
      }
    } catch (_) {}
  }
  schedulePoll()
}

watch(
  () => [currentRun.value?.id, currentRun.value?.status, currentActionType.value, latestMerge.value?.status, taskDrawerOpen.value, taskCenter.value?.summary?.processing],
  () => schedulePoll(0),
)

function currentContext() {
  return {
    paper_episode_id: selectedEpisodeId.value,
    paper_storyboard_id: currentRun.value ? currentShot.value?.paper_storyboard_id : currentPaperStoryboard.value?.id,
    run_id: currentRun.value?.id,
    shot_id: currentShot.value?.id,
    stage: currentRun.value ? 'production' : workspaceMode.value,
  }
}

function updateRestoreLabel() {
  if (!restoredContext.value) return
  const context = currentContext()
  const restoredTargetExists = restoredContext.value.run_id
    ? Number(context.run_id) === Number(restoredContext.value.run_id)
    : restoredContext.value.paper_storyboard_id
      ? Number(context.paper_storyboard_id) === Number(restoredContext.value.paper_storyboard_id)
      : Number(context.paper_episode_id) === Number(restoredContext.value.paper_episode_id)
  if (!restoredTargetExists) {
    restoredContext.value = null
    restoreLabel.value = ''
    return
  }
  restoreLabel.value = buildPaperRestoreLabel(context, {
    episodeTitle: currentEpisode.value?.title,
    storyboardTitle: currentPaperStoryboard.value?.title,
    runLabel: currentRun.value ? `R${String(currentRun.value.run_number).padStart(2, '0')}` : '',
    shotLabel: currentShot.value ? `分镜 ${String((currentShot.value.shot_index || 0) + 1).padStart(2, '0')}` : '',
  })
}

function requestImpact(options = {}) {
  if (impactResolver) impactResolver(false)
  Object.assign(impactDialog, {
    open: true,
    title: options.title || '确认当前操作？',
    description: options.description || '',
    impact: options.impact || {},
    confirmLabel: options.confirmLabel || '确认继续',
    cancelLabel: options.cancelLabel || '取消',
    tone: options.tone || 'warning',
    busy: false,
  })
  return new Promise((resolve) => { impactResolver = resolve })
}

function resolveImpact(confirmed) {
  impactDialog.open = false
  const resolve = impactResolver
  impactResolver = null
  if (resolve) resolve(Boolean(confirmed))
}

function openTaskCenter(section = 'attention') {
  taskSection.value = section === 'attention'
    && !taskCenter.value?.summary?.attention
    && taskCenter.value?.summary?.failed
    ? 'failed'
    : section
  taskDrawerOpen.value = true
  void store.recordProductEvent('task_center_opened', {
    surface: 'paper_studio', category: section, stage: currentRun.value ? 'production' : workspaceMode.value,
  })
}

function dismissRestore() {
  restoreLabel.value = ''
  restoredContext.value = null
}

async function navigateTask(task) {
  if (!task) return
  if (!(await flushDrafts())) return
  try {
    if (task.run_id) {
      await store.openRun(task.run_id, task.shot_id)
    } else {
      if (Number(selectedEpisodeId.value) !== Number(task.paper_episode_id)) {
        await store.selectEpisode(task.paper_episode_id)
      }
      await store.selectPaperStoryboard(task.paper_storyboard_id)
      workspaceMode.value = 'authoring'
    }
    taskDrawerOpen.value = false
    syncRoute()
    void store.recordProductEvent('task_center_item_opened', {
      surface: 'paper_studio', category: task.category,
      stage: task.run_id ? 'production' : 'authoring', shot_status: task.status,
    }, { paper_episode_id: task.paper_episode_id, paper_storyboard_id: task.paper_storyboard_id, run_id: task.run_id, shot_id: task.shot_id })
  } catch (cause) {
    ElMessage.error(cause?.message || '无法打开这条任务，请刷新后重试')
  }
}

async function controlTask(task, action) {
  if (!task?.run_id || !['pause', 'resume', 'cancel'].includes(action)) return
  if (!(await flushDrafts())) return
  if (action === 'cancel') {
    const confirmed = await requestImpact({
      title: `取消 R${String(task.run_number).padStart(2, '0')} 生产版本？`,
      description: '取消后不再领取新的生产任务；已经完成的素材、证据和历史版本仍会保留。',
      impact: {
        preserves: '已保存脚本、已返回素材、审核记录和历史生产证据',
        invalidates: '当前版本尚未开始的任务；远程晚到结果不会写入当前版本',
        cost: '取消本身 0 次外部调用',
      },
      confirmLabel: '确认取消版本', cancelLabel: '继续生产', tone: 'danger',
    })
    if (!confirmed) return
  }
  try {
    if (Number(currentRun.value?.id) !== Number(task.run_id)) await store.openRun(task.run_id, task.shot_id)
    await store.controlRun(action)
    await store.loadTaskCenter({ silent: true })
    syncRoute()
    ElMessage[action === 'pause' ? 'warning' : 'success'](action === 'pause' ? '已暂停，不会领取新任务' : action === 'resume' ? '生产已恢复' : '生产版本已取消')
  } catch (cause) {
    ElMessage.error(cause?.message || '任务控制失败，请刷新后重试')
  }
}

async function createExampleDraft() {
  if (episodes.value.length || authoring.value) return
  try {
    const response = await store.createExampleDraft()
    if (!response) return
    workspaceMode.value = 'authoring'
    taskDrawerOpen.value = false
    syncRoute()
    ElMessage.success('已复制 4 镜示例草稿，未创建生产版本，也没有调用图片 API')
  } catch (cause) {
    ElMessage.error(cause?.message || '示例草稿创建失败')
  }
}

function beforeUnload(event) {
  if (!hasUnsavedDrafts.value) return
  event.preventDefault()
  event.returnValue = ''
}

onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  if (!hasExplicitPaperRoute(route.query)) {
    restoredContext.value = loadPaperStudioContext(window.localStorage, dramaId.value)
    if (restoredContext.value?.stage === 'delivery') workspaceMode.value = 'delivery'
  }
  await refreshWorkspace()
  if (restoredContext.value) {
    updateRestoreLabel()
    if (restoreLabel.value) {
      taskDrawerOpen.value = true
      syncRoute()
      void store.recordProductEvent('workspace_context_restored', {
        surface: 'paper_studio', stage: currentRun.value ? 'production' : workspaceMode.value, resumed: true,
      })
    }
  } else if (!window.localStorage.getItem(paperStudioOnboardingKey(dramaId.value))) {
    taskDrawerOpen.value = true
    window.localStorage.setItem(paperStudioOnboardingKey(dramaId.value), new Date().toISOString())
    void store.recordProductEvent('onboarding_checklist_opened', { surface: 'paper_studio', stage: 'authoring' })
  }
  schedulePoll(0)
})

onUnmounted(() => {
  if (pollTimer) window.clearTimeout(pollTimer)
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  if (impactResolver) resolveImpact(false)
  window.removeEventListener('beforeunload', beforeUnload)
})

onBeforeRouteLeave(async () => {
  if (!hasUnsavedDrafts.value) return true
  try {
    await store.ensureDraftsSaved()
    return true
  } catch (_) {
    ElMessage.error('草稿保存失败，已阻止离开。请重试保存或复制内容。')
    return false
  }
})

async function refreshWorkspace() {
  try {
    const context = !hasExplicitPaperRoute(route.query) ? restoredContext.value : null
    await store.loadWorkspace(dramaId.value, {
      episodeId: route.query.paper_episode || route.query.episode || context?.paper_episode_id,
      storyboardId: route.query.storyboard || context?.paper_storyboard_id,
      runId: route.query.run || context?.run_id,
      shotId: route.query.shot || context?.shot_id,
      stage: route.query.stage || context?.stage,
      resumed: Boolean(context),
      entryPoint: context ? 'local_context' : 'direct',
    })
    if (!currentRun.value && context?.stage === 'delivery') workspaceMode.value = 'delivery'
    qualityTier.value = project.value?.default_tier || 'balanced'
    const configured = Number(project.value?.config_json?.image_provider_config_id || 0)
    const preferred = providers.value.find((provider) => provider.ready && Number(provider.id) === configured)
      || providers.value.find((provider) => provider.ready && provider.is_default)
      || providers.value.find((provider) => provider.ready)
    imageProviderConfigId.value = preferred?.id || null
  } catch (_) {}
}

async function goBack() { if (await flushDrafts()) router.push(`/drama/${dramaId.value}`) }
async function openLegacy() {
  if (!(await flushDrafts())) return
  router.push({ path: `/film/${dramaId.value}/paper`, query: { storyboard_id: currentPaperStoryboard.value?.legacy_storyboard_id || undefined } })
}

async function createEpisode() {
  try {
    const { value } = await ElMessageBox.prompt('纸片分集独立于旧工作台，可直接在这里新增分镜。', '新建纸片分集', {
      inputPlaceholder: `例如：第 ${episodes.value.length + 1} 集`, inputValue: `纸片分集 ${episodes.value.length + 1}`, confirmButtonText: '创建', cancelButtonText: '取消',
      inputValidator: (text) => String(text || '').trim().length > 0 || '请输入分集标题',
    })
    const episode = await store.createPaperEpisode({ title: value.trim() })
    syncRoute()
    ElMessage.success(`已创建「${episode.title}」`)
  } catch (cause) { if (cause !== 'cancel' && cause !== 'close') ElMessage.error(cause.message || '创建失败') }
}

async function createStoryboard() {
  if (!selectedEpisodeId.value) return createEpisode()
  try {
    if (!(await flushDrafts())) return
    const shot = await store.createPaperStoryboard({ title: `分镜 ${storyboards.value.length + 1}` })
    syncRoute()
    ElMessage.success(`已创建分镜 ${shot.shot_number}`)
  } catch (_) {}
}

async function selectEpisode(id) { if (!(await flushDrafts())) return; await store.selectEpisode(id); syncRoute() }
async function selectStoryboard(id) {
  if (!(await flushDrafts())) return
  await store.selectPaperStoryboard(id)
  workspaceMode.value = 'authoring'
  syncRoute()
}
function toggleStoryboard(id) { store.toggleStoryboard(id) }

async function moveStoryboard(id, direction) {
  const ids = storyboards.value.map((item) => Number(item.id))
  const index = ids.indexOf(Number(id))
  const target = index + Number(direction)
  if (index < 0 || target < 0 || target >= ids.length) return
  ;[ids[index], ids[target]] = [ids[target], ids[index]]
  await store.reorderPaperStoryboards(ids)
}

async function saveStoryboard(payload) {
  try { await store.savePaperStoryboard(payload); ElMessage.success('分镜已保存') } catch (_) {}
}
function onDraftChange({ storyboardId, payload, dirty }) {
  store.setStoryboardDraft(storyboardId, payload, dirty)
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  if (!dirty) return
  autoSaveTimer = window.setTimeout(async () => {
    try { await store.ensureDraftSaved(storyboardId) } catch (_) {}
  }, 800)
}

async function flushDrafts() {
  try {
    await store.ensureDraftsSaved()
    return true
  } catch (_) {
    ElMessage.error('分镜保存失败，操作已停止。请重试保存。')
    return false
  }
}
async function duplicateStoryboard(id) {
  try { await store.duplicatePaperStoryboard(id); syncRoute(); ElMessage.success('已复制为独立分镜') } catch (_) {}
}
async function deleteStoryboard(id) {
  try {
    if (!(await requestImpact({
      title: '删除当前纸片分镜？',
      description: '删除只影响纸片工作室中的当前草稿，不会跨模式修改旧工作台。',
      impact: { preserves: '已有历史生产版本、正式视频与旧工作台内容', invalidates: '当前纸片分镜及其未发布编辑入口', cost: '0 次外部调用' },
      confirmLabel: '删除分镜', tone: 'danger',
    }))) return
    await store.deletePaperStoryboard(id)
    syncRoute()
    ElMessage.success('分镜已删除')
  } catch (_) {}
}

async function importLegacy() {
  const options = legacyEpisodes.value.map((item) => `${item.id}: 第${item.episode_number || item.id}集 ${item.title || ''}`).join('\n')
  try {
    const { value } = await ElMessageBox.prompt(`输入要复制的旧分集 ID（将复制该集全部分镜）：\n${options}`, '从旧工作台单向导入', {
      inputValue: String(legacyEpisodes.value[0]?.id || ''), confirmButtonText: '复制分镜', cancelButtonText: '取消',
      inputValidator: (text) => Number(text) > 0 || '请输入有效的旧分集 ID',
    })
    const result = await store.importLegacyStoryboards(Number(value))
    ElMessage.success(`已导入 ${result.imported?.length || 0} 条，跳过 ${result.skipped?.length || 0} 条`)
  } catch (_) {}
}

async function generateReference() {
  if (!currentPaperStoryboard.value || !selectedProvider.value?.ready) return
  try {
    if (!(await requestImpact({
      title: '生成 1 张构图参考图？',
      description: `将调用「${selectedProvider.value.name} / ${selectedProvider.value.model}」。参考图只约束构图，不会自动成为正式纸片素材。`,
      impact: { preserves: '当前脚本、已有参考图与正式素材审核状态', invalidates: '不会使已有内容失效；新图会成为当前构图参考', cost: '1 次图片 API 调用' },
      confirmLabel: '确认生成 1 张',
    }))) return
    await store.generateReference({ imageProviderConfigId: imageProviderConfigId.value })
    ElMessage.success('参考图已生成并保存到当前纸片分镜')
  } catch (cause) { if (cause?.message && cause !== 'cancel') ElMessage.error(cause.message) }
}

async function uploadReference(file) {
  if (!file) return
  try {
    await store.uploadReference(file)
    ElMessage.success('参考图已上传并设为当前构图参考')
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

async function selectReference(referenceId) {
  try {
    await store.selectReference(referenceId)
    ElMessage.success('已切换当前参考图并创建新的分镜版本')
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

async function saveReferenceConstraints({ referenceId, constraints }) {
  try {
    await store.saveReferenceConstraints(referenceId, constraints)
    ElMessage.success('构图约束已保存到当前分镜版本')
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

async function synthesizeAudio({ kind, options }) {
  if (!currentPaperStoryboard.value || !(await flushDrafts())) return
  const label = kind === 'dialogue' ? '对白' : '旁白'
  try {
    if (!(await requestImpact({
      title: `生成${label}配音？`,
      description: `将使用当前 TTS 配置和「${options.voiceId || '默认声音'}」建立新的声音版本。`,
      impact: { preserves: `原${label}文件、历史声音版本和已发布历史视频`, invalidates: '当前未发布预览与待渲染快照', cost: '1 次 TTS 调用，0 次图片 API' },
      confirmLabel: '确认生成配音',
    }))) return
    await store.synthesizePaperAudio(currentPaperStoryboard.value.id, kind, options)
    ElMessage.success(`${label}配音已生成，可以直接试听`)
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close' && cause?.message) ElMessage.error(cause.message)
  }
}

async function uploadAudio({ kind, file, options }) {
  if (!currentPaperStoryboard.value || !file || !(await flushDrafts())) return
  const label = kind === 'dialogue' ? '对白' : '旁白'
  try {
    await store.uploadPaperAudio(currentPaperStoryboard.value.id, kind, file, options)
    ElMessage.success(`${label}音频已上传；本次没有调用 TTS`)
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

async function reviseAudio({ kind, versionId, options }) {
  if (!currentPaperStoryboard.value || !(await flushDrafts())) return
  const label = kind === 'dialogue' ? '对白' : '旁白'
  try {
    if (!(await requestImpact({
      title: `保存${label}设置？`,
      description: `将新建一版${label}时间、音量与字幕设置，不会覆盖原声音文件。`,
      impact: { preserves: `原${label}文件、历史设置版本和历史发布视频`, invalidates: '当前预览与正式视频需要重新渲染', cost: '0 次外部调用' },
      confirmLabel: '保存并使预览失效', cancelLabel: '继续编辑',
    }))) return
    await store.revisePaperAudio(currentPaperStoryboard.value.id, versionId, options)
    ElMessage.success(`${label}设置已保存为新版本`)
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close' && cause?.message) ElMessage.error(cause.message)
  }
}

async function setAudioPolicy(mode) {
  if (!currentPaperStoryboard.value || !(await flushDrafts())) return
  const silent = mode === 'silent'
  try {
    if (!(await requestImpact({
      title: silent ? '明确将当前分镜设为静音？' : '恢复按文本配音？',
      description: silent
        ? '下一次预览和正式视频将不带对白、旁白或字幕。'
        : '已填写的对白和旁白需要具有当前音频版本，才能再次进入预览与正式渲染。',
      impact: {
        preserves: '已有声音文件、声音历史版本与历史发布视频',
        invalidates: '当前预览与待交付正式视频状态',
        cost: '0 次外部调用',
      },
      confirmLabel: silent ? '确认静音' : '恢复配音', tone: silent ? 'danger' : 'warning',
    }))) return
    await store.setPaperAudioPolicy(currentPaperStoryboard.value.id, mode)
    ElMessage.success(silent ? '已明确设为静音' : '声音策略已更新')
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close' && cause?.message) ElMessage.error(cause.message)
  }
}

async function showDelivery() {
  if (!(await flushDrafts())) return
  await store.loadEpisodeDelivery()
  workspaceMode.value = 'delivery'
  syncRoute()
}

function showAuthoring() {
  workspaceMode.value = 'authoring'
  syncRoute()
}

function showScript() {
  workspaceMode.value = 'script'
  syncRoute()
}

const activeScript = ref(null)
const savingScript = ref(false)

async function onSaveScript(content, sourceKind) {
  if (savingScript.value) return
  savingScript.value = true
  try {
    const result = await store.saveScript(content, sourceKind)
    activeScript.value = result?.script || null
    if (result?.deduplicated) ElMessage.info(`内容与 v${result.script.version_number} 相同，未重复建版`)
    else ElMessage.success(`剧本已保存为 v${result?.script?.version_number}`)
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  } finally {
    savingScript.value = false
  }
}

async function onSelectScriptVersion(scriptId) {
  try {
    activeScript.value = await store.loadScriptContent(scriptId)
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

const confirmingEntities = ref(false)

async function onExtractEntities() {
  try {
    const result = await store.extractEntities(activeScript.value?.id || null)
    ElMessage.success(`提取到 ${result?.candidates?.length || 0} 个候选实体，请逐项确认`)
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

async function onConfirmEntities(items) {
  if (confirmingEntities.value) return
  confirmingEntities.value = true
  try {
    const summary = await store.confirmEntities(items)
    ElMessage.success(`已入库：新增 ${summary.created.length} · 合并 ${summary.merged.length} · 忽略 ${summary.ignored}`)
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  } finally {
    confirmingEntities.value = false
  }
}

async function onUpdateEntity(entity, changes) {
  try {
    await store.updateLibraryEntity(entity.id, { expected_version: entity.version, ...changes })
    ElMessage.success('实体已更新')
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

async function onArchiveEntity(entity) {
  try {
    if (!(await requestImpact({
      title: `归档「${entity.name}」？`,
      description: '归档后不再出现在实体库与分镜绑定选项中；已绑定的分镜不受影响。',
      impact: { preserves: '历史绑定与已生成形象', invalidates: '后续新分镜不能再绑定该实体', cost: '0 次调用' },
      confirmLabel: '确认归档',
    }))) return
    await store.updateLibraryEntity(entity.id, { expected_version: entity.version, status: 'archived' })
    ElMessage.success('已归档')
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

const applyingStoryboards = ref(false)

async function onGenerateIdentities(entityIds) {
  if (!selectedProvider.value?.ready) {
    ElMessage.warning('先在右栏选择可用的图片 API')
    return
  }
  const names = (library.value?.entities || []).filter((item) => entityIds.includes(item.id)).map((item) => item.name)
  try {
    if (!(await requestImpact({
      title: `生成 ${entityIds.length} 个实体形象？`,
      description: `将调用「${selectedProvider.value.name} / ${selectedProvider.value.model}」为 ${names.join('、')} 各生成 1 张形象图；角色与道具会自动抠成透明纸片素材，需逐张审核批准后才会成为正式形象。`,
      impact: { preserves: '已批准的旧形象版本与所有分镜', invalidates: '不会使任何内容失效；新形象为待审核候选', cost: `${entityIds.length} 次图片 API 调用` },
      confirmLabel: `确认生成 ${entityIds.length} 张`,
    }))) return
    const result = await store.generateIdentities(entityIds, imageProviderConfigId.value)
    if (result.failed > 0) ElMessage.warning(`完成 ${result.succeeded} 张，失败 ${result.failed} 张（可重新勾选失败实体重试）`)
    else ElMessage.success(`已生成 ${result.succeeded} 张形象，请在实体卡上逐张审核`)
  } catch (cause) {
    if (cause?.message && cause !== 'cancel') ElMessage.error(cause.message)
  }
}

async function onReviewIdentity(version, decision, entity) {
  try {
    await store.reviewIdentityVersion(version.id, decision)
    ElMessage.success(decision === 'approve' ? `「${entity.name}」形象 v${version.version_number} 已批准为正式形象` : '已退回，可重新生成')
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

async function onGenerateStoryboards(params) {
  try {
    const result = await store.generateStoryboardsDraft(params)
    if (result?.issues?.length) ElMessage.warning(`已生成 ${result.shots.length} 镜草稿，其中 ${result.issues.length} 镜不完整；请先使用 AI 补全`)
    else ElMessage.success(`已生成 ${result?.shots?.length || 0} 镜草稿，完整性检查已通过`)
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

function missingStoryboardDrafts() {
  return (storyboardDraft.value?.shots || []).flatMap((shot, index) => {
    const missingFields = []
    if (!String(shot?.description || '').trim()) missingFields.push('画面描述')
    if (!Boolean(shot?.environment_only) && !String(shot?.action || '').trim()) missingFields.push('主体动作')
    return missingFields.length ? [{ shot_number: index + 1, title: shot.title, missing_fields: missingFields }] : []
  })
}

async function onRepairStoryboards() {
  const issues = missingStoryboardDrafts()
  if (!issues.length) {
    ElMessage.success('当前分镜草稿完整，不需要补全')
    return
  }
  try {
    if (!(await requestImpact({
      title: `AI 补全 ${issues.length} 个不完整分镜？`,
      description: '只补充为空的画面描述或主体动作，不会改写已有内容、对白、时长、实体绑定和镜头顺序。补全结果会先展示差异，确认后才写回草稿。',
      impact: {
        preserves: '当前所有非空字段与实体绑定',
        invalidates: '不会使任何内容失效；可以放弃本次建议',
        cost: '通常 1 次文本模型请求；语义或网络异常时自动重试，最多 6 次请求；0 次图片 API',
      },
      confirmLabel: `开始补全 ${issues.length} 镜`,
    }))) return
    const result = await store.repairGeneratedStoryboardsDraft()
    if (result.issues?.length) ElMessage.warning(`已生成 ${result.patches.length} 项建议，仍有 ${result.issues.length} 镜需要继续补全`)
    else ElMessage.success(`已生成 ${result.patches.length} 项补全建议，请确认差异`)
  } catch (cause) {
    if (cause?.message && cause !== 'cancel') ElMessage.error(cause.message)
  }
}

function onAcceptStoryboardRepairs() {
  if (!store.acceptStoryboardRepairPreview()) return
  const remaining = missingStoryboardDrafts().length
  if (remaining) ElMessage.warning(`补全建议已写入草稿，仍有 ${remaining} 镜待补齐`)
  else ElMessage.success('补全建议已写入草稿，完整性检查已通过')
}

async function onRepairCurrentStoryboard() {
  if (!currentPaperStoryboard.value) return
  if (!latestScript.value) {
    ElMessage.warning('请先在“剧本与实体”页保存剧本版本，AI 才能按原剧情补全')
    return
  }
  try {
    if (!(await requestImpact({
      title: `AI 补全「${currentPaperStoryboard.value.title}」？`,
      description: '只补充当前镜头为空的画面描述或主体动作，已有内容不会被覆盖。结果会先展示差异，接受后保存为新的分镜版本。',
      impact: {
        preserves: '当前非空字段、参考图、实体绑定与历史分镜版本',
        invalidates: '不会使任何内容失效；可以放弃本次建议',
        cost: '通常 1 次文本模型请求；语义或网络异常时自动重试，最多 6 次请求；0 次图片 API',
      },
      confirmLabel: '开始补全本镜',
    }))) return
    if (!(await flushDrafts())) return
    const result = await store.repairCurrentPaperStoryboard()
    if (result.stale) ElMessage.warning('当前分镜已切换，本次补全建议未挂载')
    else ElMessage.success(`已生成 ${result.patches.length} 项建议，请确认差异`)
  } catch (cause) {
    if (cause?.message && cause !== 'cancel') ElMessage.error(cause.message)
  }
}

async function onAcceptCurrentStoryboardRepair() {
  try {
    const saved = await store.acceptCurrentStoryboardRepairPreview()
    if (saved) ElMessage.success('AI 补全已保存为新的分镜版本')
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

async function onApplyStoryboards(mode) {
  if (applyingStoryboards.value) return
  try {
    if (mode === 'replace') {
      const count = storyboards.value.filter((item) => !item.published_video_generation_id).length
      if (count && !(await requestImpact({
        title: `替换现有 ${count} 个未发布分镜？`,
        description: '已发布的分镜会保留；未发布的分镜将被归档，由生成的草稿替代。',
        impact: { preserves: '已发布分镜、实体库与剧本版本', invalidates: `${count} 个未发布分镜（含其草稿与参考图关联）`, cost: '0 次调用' },
        confirmLabel: '确认替换',
        tone: 'danger',
      }))) return
    }
    applyingStoryboards.value = true
    const result = await store.applyGeneratedStoryboards(mode)
    ElMessage.success(`已应用 ${result.created_count} 个分镜${result.replaced_count ? `，替换 ${result.replaced_count} 个` : ''}；实体绑定已写入`)
    workspaceMode.value = 'authoring'
    syncRoute()
  } catch (cause) {
    if (cause?.message && cause !== 'cancel') ElMessage.error(cause.message)
  } finally {
    applyingStoryboards.value = false
  }
}

async function onSaveStyleAnchor(anchorText) {
  try {
    await store.setStyleAnchor(anchorText)
    ElMessage.success('风格锚已保存，之后生成的实体形象都会应用')
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

let activeScriptLoadToken = 0
watch([
  selectedEpisodeId,
  () => latestScript.value?.id,
  () => latestScript.value?.paper_episode_id,
], async ([episodeId, scriptId, scriptEpisodeId]) => {
  const token = ++activeScriptLoadToken
  if (!episodeId || !scriptId || Number(scriptEpisodeId) !== Number(episodeId)) {
    activeScript.value = null
    return
  }
  if (Number(activeScript.value?.paper_episode_id) === Number(episodeId) && activeScript.value?.content != null) return
  try {
    const loaded = await store.loadScriptContent(scriptId)
    if (token === activeScriptLoadToken && Number(selectedEpisodeId.value) === Number(episodeId)) activeScript.value = loaded
  } catch (cause) {
    if (token === activeScriptLoadToken && cause?.message) ElMessage.error(`剧本正文加载失败：${cause.message}`)
  }
}, { immediate: true })

async function refreshDelivery() {
  try {
    await Promise.all([store.loadPaperEpisodes(selectedEpisodeId.value), store.loadEpisodeMerges(), store.loadEpisodeDelivery()])
    ElMessage.success('交付状态已更新')
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

async function fixDeliveryBlocker({ item, blocker }) {
  if (!item || !blocker) return
  if (blocker.key === 'audio_duration' && item.latest_run_id && item.latest_shot_id) {
    await store.openRun(item.latest_run_id, item.latest_shot_id)
    await store.syncAudioTiming()
    workspaceMode.value = 'production'
    syncRoute()
    ElMessage.success(`已按完整声音延长到 ${Number(item.effective_duration_seconds || item.duration || 0).toFixed(0)} 秒；请继续检查动态与预览。`)
    return
  }
  const authoringBlockers = new Set(['script', 'audio'])
  const activeProduction = !['not_started', 'published', 'cancelled', 'stale'].includes(item.production_status)
  if (!authoringBlockers.has(blocker.key) && activeProduction && item.latest_run_id) {
    await store.openRun(item.latest_run_id, item.latest_shot_id)
    syncRoute()
    return
  }
  await store.selectPaperStoryboard(item.paper_storyboard_id)
  workspaceMode.value = 'authoring'
  syncRoute()
  await nextTick()
  const selector = blocker.key === 'audio' ? '#paper-audio-workbench' : '.script-form'
  document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (blocker.key === 'production' && item.production_status === 'not_started') {
    ElMessage.info(item.environment_only ? '已定位纯环境分镜；勾选后从右侧创建生产版本。' : '已定位分镜；勾选后从右侧创建生产版本。')
  } else if (['video', 'video_file', 'audio_snapshot', 'audio_duration'].includes(blocker.key)) {
    ElMessage.info(blocker.key === 'audio_duration'
      ? '当前视频短于完整语音；请从右侧创建新的生产版本，系统会自动延长画面并复用可用素材。'
      : '当前正式视频不再匹配最新内容，请从右侧创建新的生产版本。历史视频仍会保留。')
  }
}

async function editShotAudio() {
  const storyboardId = Number(currentShot.value?.paper_storyboard_id || 0)
  if (!storyboardId) return
  store.closeRun()
  await store.selectPaperStoryboard(storyboardId)
  workspaceMode.value = 'authoring'
  syncRoute()
  await nextTick()
  document.querySelector('#paper-audio-workbench')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function editTransitionStoryboard() {
  const storyboardId = Number(transitionRecovery.value?.context?.paper_storyboard_id || currentShot.value?.paper_storyboard_id || 0)
  if (!storyboardId) {
    solutionDialogOpen.value = false
    ElMessage.warning('没有找到对应的原分镜，请从左侧分镜列表手动打开并修改。')
    return
  }
  store.closeRun()
  await store.selectPaperStoryboard(storyboardId)
  workspaceMode.value = 'authoring'
  solutionDialogOpen.value = false
  syncRoute()
  await nextTick()
  const field = transitionRecovery.value?.focusField || 'description'
  const selector = field === 'duration'
    ? '.script-form .duration-field input'
    : field === 'action'
      ? '.script-form .field.wide:nth-of-type(4) textarea'
      : '.script-form .field.wide:nth-of-type(3) textarea'
  const input = document.querySelector(selector) || document.querySelector('.script-form textarea')
  input?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  window.setTimeout(() => input?.focus(), 260)
  ElMessage.info('已定位问题分镜；若主体、地点或脚本事实发生变化，保存后创建新生产版本。旧图片不会丢失，并会先做零调用复用预检。')
}

async function previewContinuityRepair() {
  if (!currentShot.value?.id || !currentShot.value?.motion_plan?.plan_json || continuityRepairing.value) return
  continuityRepairing.value = true
  try {
    const motionPlan = currentShot.value.motion_plan.plan_json
    const response = await paperStudioAPI.continuityRepairPreview(currentShot.value.id, {
      expected_version: Number(currentShot.value.version),
      motion_plan: motionPlan,
    })
    const preview = response.preview
    if (preview.repairability && !preview.repairability.pass) {
      ElMessage.warning(preview.repairability.message || '当前生产状态暂时不能应用零调用修复')
      return
    }
    if (!preview.can_apply_zero_call) {
      ElMessage.warning(`当前动作计划仍有门禁问题，已保留 ${preview.asset_diff.preserved_asset_count} 张素材；请先在动作编辑器修正失败项，不需要重新生图。`)
      return
    }
    if (!(await requestImpact({
      title: '应用当前版本内的零调用连续性修复？',
      description: '系统会新增计划修订并重新映射未变化素材，原 run、shot、旧计划和旧图片全部保留。',
      impact: {
        preserves: `${preview.asset_diff.preserved_asset_count} 张素材及其文件哈希；旧计划仍可在历史抽屉查看`,
        invalidates: `${preview.asset_diff.invalidated_asset_count} 张；新增槽位 ${preview.asset_diff.added_slot_count} 个`,
        cost: `图片 API ${preview.asset_diff.image_api_calls} 次`,
      },
      confirmLabel: '应用零调用修复',
    }))) return
    await paperStudioAPI.continuityRepair(currentShot.value.id, {
      request_id: `paper-continuity-repair-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      expected_version: Number(currentShot.value.version),
      preview_fingerprint: preview.preview_fingerprint,
      motion_plan: motionPlan,
      confirmation: {
        actor: 'local_owner',
        reason: 'continuity_exact_reuse_confirmed',
        source_asset_version_ids: preview.asset_diff.slots
          .map((slot) => Number(slot.asset_version_id || 0))
          .filter(Boolean),
      },
    })
    await store.refreshActiveRun()
    solutionDialogOpen.value = false
    ElMessage.success('已在当前生产版本内新增计划修订，图片 API 调用数为 0')
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close' && cause?.message) ElMessage.error(cause.message)
  } finally {
    continuityRepairing.value = false
  }
}

async function createRun() {
  try {
    const selected = selectedStoryboardIds.value.map((id) => storyboards.value.find((item) => Number(item.id) === Number(id))).filter(Boolean)
    const existing = selected.length === selectedStoryboardIds.value.length && selected.length
      ? findBestUnpublishedRun(runs.value, {
          paperEpisodeId: selectedEpisodeId.value,
          storyboardIds: selectedStoryboardIds.value,
          revisionIds: selected.map((item) => item.current_revision_id),
        })
      : null
    if (existing) {
      await store.openRun(existing.id)
      syncRoute()
      ElMessage.success(`已恢复未发布版本 R${String(existing.run_number).padStart(2, '0')}：${unpublishedRunResumeLabel(existing)}`)
      return
    }
    const run = await store.createRun({ qualityTier: qualityTier.value, imageProviderConfigId: imageProviderConfigId.value })
    if (run) { syncRoute(); ElMessage.success(`已创建独立生产版本 R${String(run.run_number).padStart(2, '0')}`) }
  } catch (_) {}
}

async function resumeUnpublishedRun() {
  if (!unpublishedResumeRun.value?.id) return
  await store.openRun(unpublishedResumeRun.value.id)
  syncRoute()
  ElMessage.success(`已回到 R${String(unpublishedResumeRun.value.run_number).padStart(2, '0')}，未发布内容仍然完整保留`)
}

async function mergeEpisode() {
  try {
    if (!episodeDelivery.value?.ready) {
      await showDelivery()
      ElMessage.warning('还有分镜未满足交付条件，请先处理看板中的阻断项。')
      return
    }
    if (!(await requestImpact({
      title: '合并当前有声版本？',
      description: `将按当前 ${episodeDelivery.value.total_count} 条纸片分镜顺序合并整集，并生成对应 SRT。`,
      impact: { preserves: '全部单镜正式视频、声音版本与已有历史整集', invalidates: '不会写入或修改旧工作台', cost: '0 次图片 API；执行 1 次本地视频合并' },
      confirmLabel: '开始合并',
    }))) return
    const result = await store.mergePaperEpisode()
    ElMessage.success(result?.reused ? '当前内容已有相同整集版本，已直接复用' : '有声整集合并任务已创建')
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close' && cause?.message) ElMessage.error(cause.message)
  }
}

async function syncToLegacy() {
  const options = legacyEpisodes.value.map((item) => `${item.id}: 第${item.episode_number || item.id}集 ${item.title || ''}`).join('\n')
  try {
    const { value } = await ElMessageBox.prompt(`这是一次显式复制。请输入目标旧分集 ID：\n${options}`, '选择旧工作台目标', {
      inputValue: String(legacyEpisodes.value[0]?.id || ''), confirmButtonText: '下一步', cancelButtonText: '取消',
      inputValidator: (text) => Number(text) > 0 || '请输入有效的旧分集 ID',
    })
    if (!(await requestImpact({
      title: '确认同步到旧工作台？',
      description: '这是一次显式单向复制，完成后两个模式仍然独立，不会建立自动同步关系。',
      impact: { preserves: '纸片分镜、纸片生产版本和当前交付内容', invalidates: '目标旧分镜的同名同步字段可能被本次内容更新', cost: '0 次外部调用' },
      confirmLabel: '确认单向同步',
    }))) return
    const result = await store.syncToLegacy({ legacyEpisodeId: Number(value) })
    ElMessage.success(result.created ? '已在旧工作台创建对应分镜' : '已更新对应旧分镜')
  } catch (_) {}
}

async function openRun(id) { await store.openRun(id); syncRoute() }
async function openShot(id) { await store.openShot(id); syncRoute() }
function openStoryboardHistory(id) {
  const storyboardId = Number(id || currentShot.value?.paper_storyboard_id || currentPaperStoryboard.value?.id || 0)
  if (!storyboardId) return
  historyStoryboardId.value = storyboardId
  historyDrawerOpen.value = true
}
function openHistoryCenter(selection = {}) {
  const storyboardId = Number(selection.storyboardId || historyStoryboardId.value || 0)
  if (!storyboardId) return
  historyStoryboardId.value = storyboardId
  historyCenterSelection.value = selection.kind
    ? { kind: selection.kind, id: Number(selection.id) }
    : null
  historyDrawerOpen.value = false
  historyCenterOpen.value = true
}
async function handleHistoryForked(result) {
  if (result?.run?.id) {
    historyCenterOpen.value = false
    await store.loadRuns()
    await store.openRun(result.run.id)
    syncRoute()
    ElMessage.success(`已创建生产版本 R${String(result.run.run_number).padStart(2, '0')}；源版本和旧图全部保留，图片 API 0 次`)
    return
  }
  const storyboardId = Number(result?.storyboard?.id || historyStoryboardId.value || 0)
  if (!storyboardId) return
  historyCenterOpen.value = false
  store.closeRun()
  await store.loadEpisodeStoryboards(selectedEpisodeId.value)
  await store.selectPaperStoryboard(storyboardId)
  workspaceMode.value = 'authoring'
  syncRoute()
  ElMessage.success(`已基于历史版本创建工作副本；旧版本和图片全部保留，图片 API 0 次`)
}
function returnToAuthoring() { store.closeRun(); workspaceMode.value = 'authoring'; syncRoute() }

async function runCurrentAction() {
  if (currentActionType.value === 'authorize_generation') return authorizeGeneration()
  try {
    const result = await store.runNextAction()
    syncRoute()
    if (result?.noop) {
      await store.refreshActiveRun()
      return
    }
    ElMessage.success('当前生产步骤已完成')
  } catch (_) {}
}
async function saveBlueprint(blueprint) {
  try {
    if (currentRun.value?.status === 'awaiting_generation_authorization') {
      if (!(await requestImpact({
        title: '保存并重新编译蓝图？',
        description: '保存后会生成新的蓝图版本，必须基于新版本重新确认生成范围。',
        impact: { preserves: '已保存脚本、历史蓝图与已经返回的素材版本', invalidates: '旧图片生成授权与当前未执行计划', cost: '本次保存 0 次图片 API' },
        confirmLabel: '保存并重新编译', cancelLabel: '继续编辑',
      }))) return
    }
    await store.saveBlueprint(blueprint)
    syncRoute()
    ElMessage.success('生产蓝图已保存并重新编译')
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close' && cause?.message) ElMessage.error(cause.message)
  }
}
async function confirmBlueprint() {
  try {
    await store.confirmBlueprint()
    syncRoute()
    ElMessage.success('蓝图已确认；尚未调用图片 API，请先查看费用')
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}
async function authorizeGeneration() {
  try {
    const shotIds = currentShot.value?.id ? [Number(currentShot.value.id)] : null
    const reuseResponse = await paperStudioAPI.reusePreview(currentRun.value.id, {
      expected_version: Number(currentRun.value.version),
      ...(shotIds ? { shot_ids: shotIds } : {}),
    })
    if (Number(reuseResponse.preview?.history_review_count || 0) > 0) {
      reuseReviewPreview.value = reuseResponse.preview
      reuseReviewOpen.value = true
      return
    }
    let quote = await store.getGenerationQuote({ shotIds })
    if (Number(quote.history_reuse_count || 0) > 0) {
      const noPaidSlotsAfterReuse = Number(quote.estimated_image_count || 0) === 0
      if (!(await requestImpact({
        title: `先应用 ${quote.history_reuse_count} 张历史素材？`,
        description: '这些图片已通过审核、文件哈希一致且静态视觉合同完全相同。应用只会建立新的版本关联，不会调用图片 API。',
        impact: {
          preserves: '源生产版本、源图片文件、审核记录和所有淘汰版本',
          invalidates: '不会覆盖或删除任何历史图片',
          cost: `历史复用 ${quote.history_reuse_count} 张，0 次图片 API；应用后只对剩余差异槽位重新报价`,
        },
        confirmLabel: `应用 ${quote.history_reuse_count} 张（0 调用）`,
        cancelLabel: '先查看历史版本',
      }))) {
        openStoryboardHistory(currentShot.value?.paper_storyboard_id)
        return
      }
      await paperStudioAPI.applyReuse(currentRun.value.id, {
        request_id: `paper-history-reuse-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        expected_version: Number(currentRun.value.version),
        reuse_preview_fingerprint: quote.reuse_preview_fingerprint,
        shot_ids: quote.shot_ids,
        confirmation: {
          actor: 'local_owner',
          reason: 'historical_exact_reuse_confirmed',
          source_asset_version_ids: (quote.reuse_slots || [])
            .filter((slot) => slot.source_kind === 'historical_reuse')
            .map((slot) => Number(slot.source_asset_version_id)),
        },
      })
      await store.refreshActiveRun()
      if (noPaidSlotsAfterReuse) {
        ElMessage.success('历史与本地素材已全部应用，图片 API 调用数为 0')
        return
      }
      quote = await store.getGenerationQuote({ shotIds })
      ElMessage.success('历史素材已挂接，图片 API 调用数为 0；差异报价已重新计算')
    }
    if (Number(quote.estimated_image_count || 0) === 0) {
      const pendingZeroCall = Number(quote.current_reuse_count || 0)
        + Number(quote.library_reuse_count || 0)
        + Number(quote.local_derivation_count || 0)
      if (pendingZeroCall > 0) {
        if (!(await requestImpact({
          title: `应用 ${pendingZeroCall} 个零调用素材？`,
          description: '将挂接当前已采用素材、现有分镜参考图或实体库正式形象，并执行必要的本地 Mask/程序化派生，然后进入素材审核；不会建立图片生成授权。',
          impact: { preserves: '全部历史素材和当前蓝图', invalidates: '不会覆盖历史图片', cost: '0 次图片 API' },
          confirmLabel: '应用并进入审核',
        }))) return
        await paperStudioAPI.applyReuse(currentRun.value.id, {
          request_id: `paper-zero-call-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          expected_version: Number(currentRun.value.version),
          reuse_preview_fingerprint: quote.reuse_preview_fingerprint,
          shot_ids: quote.shot_ids,
        })
        await store.refreshActiveRun()
      }
      ElMessage.success('当前素材已通过复用或本地派生处理，不需要图片 API 授权')
      return
    }
    const requiredCount = quote.slots.filter((slot) => slot.required).length
    if (!(await requestImpact({
      title: '确认图片 API 数量与范围',
      description: `服务：${quote.provider} / ${quote.model}；范围：${quote.shot_ids.length} 个分镜。当前采用 ${quote.current_reuse_count || 0}、历史复用 ${quote.history_reuse_count || 0}、实体库 ${quote.library_reuse_count || 0}、本地派生 ${quote.local_derivation_count || 0} 均为 0 调用；仅剩 ${requiredCount} 个必需差异槽位需要图片 API。`,
      impact: { preserves: '当前蓝图、已接受素材和所有历史版本', invalidates: '新结果返回前不会替换当前采用素材', cost: `${quote.estimated_image_count} 张预计图片，最多 ${quote.max_authorized_calls} 次授权调用（含失败调用与自动重试）` },
      confirmLabel: `确认并生成 ${quote.estimated_image_count} 张`, cancelLabel: '返回修改蓝图',
    }))) return
    await store.authorizeAndStartGeneration(quote)
    ElMessage.success('已授权，正式素材开始生成')
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close' && cause?.message) ElMessage.error(cause.message)
  }
}
async function resolveHistoryReuseReview(decisions) {
  if (!reuseReviewPreview.value || reuseReviewBusy.value) return
  reuseReviewBusy.value = true
  try {
    await paperStudioAPI.applyReuse(currentRun.value.id, {
      request_id: `paper-history-review-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      expected_version: Number(currentRun.value.version),
      reuse_preview_fingerprint: reuseReviewPreview.value.reuse_preview_fingerprint,
      shot_ids: [...new Set(reuseReviewPreview.value.slots
        .filter((slot) => slot.source_kind === 'history_review_required')
        .map((slot) => Number(slot.shot_id)))],
      review_decisions: decisions,
      confirmation: { actor: 'local_owner', reason: 'historical_review_reuse_confirmed' },
    })
    reuseReviewOpen.value = false
    reuseReviewPreview.value = null
    await store.refreshActiveRun()
    ElMessage.success('历史候选处理完成，图片 API 调用数为 0；正在重新计算差异范围')
    await authorizeGeneration()
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  } finally {
    reuseReviewBusy.value = false
  }
}
async function pauseRun() {
  try { await store.controlRun('pause'); ElMessage.warning('已暂停，不会领取新任务') } catch (_) {}
}
async function resumeRun() {
  try { await store.controlRun('resume'); ElMessage.success('生产已恢复') } catch (_) {}
}
async function cancelRun() {
  try {
    if (!(await requestImpact({
      title: '取消当前生产版本？',
      description: '取消后不再领取新任务，此生产版本不能原地恢复。',
      impact: { preserves: '已保存脚本、已经接受的素材文件和历史生产证据', invalidates: '当前版本的未开始任务；远程晚到结果不会写入当前版本', cost: '取消本身 0 次外部调用' },
      confirmLabel: '确认取消版本', cancelLabel: '继续生产', tone: 'danger',
    }))) return
    await store.controlRun('cancel')
    ElMessage.warning('生产版本已取消')
  } catch (_) {}
}
async function advanceRun() {
  try {
    const result = await store.advanceRun(); syncRoute()
    if (result?.failed?.length) ElMessage.warning(`${result.failed.length} 个分镜仍需处理`)
    else ElMessage.success('本阶段批量推进完成')
  } catch (_) {}
}
async function applyMotionRevision() {
  try { await store.reviseMotion(motionRevision.value); motionRevision.value = ''; ElMessage.success('动作修订已保存') } catch (_) {}
}
async function reviseMotionFromEvidence(instruction) {
  if (!instruction) return
  try {
    await store.reviseMotion(instruction)
    ElMessage.success('已只修正失败动作项，并重新执行动态门禁')
  } catch (_) {}
}
async function rejectAsset(version) {
  try {
    const missingCompositionReference = version.asset_type === 'environment'
      && version.derivation_kind === 'image_api'
      && Number(version.quality_report_json?.reference_count || 0) < 1
    const { value } = await ElMessageBox.prompt('只会退回当前素材槽位，其它已接受版本会保留。', `退回 ${version.slot_key}`, {
      inputValue: missingCompositionReference
        ? '正式素材未携带已选构图参考，与当前分镜画面不一致'
        : version.asset_type === 'environment' ? '背景仍包含应当独立生成的主体' : '透明主体、边缘或姿态不符合当前镜头',
      confirmButtonText: '退回槽位', cancelButtonText: '取消',
      inputValidator: (text) => String(text || '').trim().length >= 2 || '请填写退回原因',
    })
    await store.reviewAssets('reject', [version.id], value.trim())
    ElMessage.warning('只退回了当前素材槽位')
  } catch (_) {}
}
async function approveAsset(version) {
  if (!version?.id) return
  try {
    const result = await store.reviewAssets('approve', [version.id])
    if (result?.progress?.complete) ElMessage.success('当前镜头的正式素材已全部逐张批准')
    else ElMessage.success(`已批准此素材，还需审核 ${result?.progress?.remaining ?? 0} 张`)
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}

async function regenerateAsset(slot) {
  if (!slot?.id || !currentShot.value?.id || regeneratingSlotId.value) return
  regeneratingSlotId.value = Number(slot.id)
  try {
    const quote = await store.getGenerationQuote({ shotIds: [Number(currentShot.value.id)], slotIds: [Number(slot.id)] })
    if (!quote) return
    if (!(await requestImpact({
      title: `重新生成 ${slot.slot_key}？`,
      description: `只会调用「${quote.provider} / ${quote.model}」处理当前槽位。`,
      impact: { preserves: '其它已生成、已批准素材与当前槽位原版本历史', invalidates: '新结果会成为当前待审核版本；通过人工审核后才能继续视频流程', cost: `${quote.estimated_image_count} 次预计图片 API 调用，最多 ${quote.max_authorized_calls} 次授权调用（含失败调用与自动重试）` },
      confirmLabel: `确认生成 ${quote.estimated_image_count} 张`,
    }))) return
    await store.authorizeAndStartGeneration(quote)
    ElMessage.success('已带上当前构图参考，重新生成任务已排队')
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close' && cause?.message) ElMessage.error(cause.message)
  } finally {
    regeneratingSlotId.value = null
  }
}

async function uploadAsset({ slot, file }) {
  if (!slot?.id || !file) return
  try {
    if (slot.asset_type !== 'environment') {
      if (!(await requestImpact({
        title: `上传替换 ${slot.slot_key}？`,
        description: '角色和道具替换图必须包含真实透明背景，上传后仍需逐张人工批准。',
        impact: { preserves: '当前槽位原版本与其它正式素材', invalidates: '当前槽位采用状态，直到新版本重新审核通过', cost: '0 次图片 API' },
        confirmLabel: '上传透明图',
      }))) return
    }
    await store.uploadAssetReplacement(slot.id, file)
    ElMessage.success('替换素材已写入新版本，图片 API 调用数为 0')
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close' && cause?.message) ElMessage.error(cause.message)
  }
}

async function patchAssetMask({ asset, points, feather }) {
  if (!asset?.id || !points?.length) return
  try {
    await store.patchAssetMask(asset.id, points, feather)
    ElMessage.success('Mask 修正已生成新素材版本，图片 API 调用数为 0')
  } catch (cause) {
    if (cause?.message) ElMessage.error(cause.message)
  }
}
async function rematteAsset(version) { if (version?.id) try { await store.rematteAsset(version.id) } catch (_) {} }
async function rejectPreview() {
  try {
    const { value } = await ElMessageBox.prompt('退回后旧 snapshot 与批准会失效。', '退回当前预览', {
      inputValue: '动作、层级或风格不符合当前分镜', confirmButtonText: '退回预览', cancelButtonText: '取消',
      inputValidator: (text) => String(text || '').trim().length >= 2 || '请填写退回原因',
    })
    await store.rejectPreview(value.trim())
    ElMessage.warning('预览已退回')
  } catch (_) {}
}

async function downloadRunReport() {
  if (!currentRun.value?.id) return
  try {
    const { report } = await paperStudioAPI.getRunReport(currentRun.value.id)
    const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = `paper-studio-run-${currentRun.value.id}-${report.report_hash.slice(-12)}.json`
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url)
  } catch (_) {}
}

function syncRoute() {
  savePaperStudioContext(window.localStorage, dramaId.value, currentContext())
  router.replace({
    path: route.path,
    query: {
      paper_episode: selectedEpisodeId.value || undefined,
      storyboard: currentRun.value ? undefined : currentPaperStoryboard.value?.id || undefined,
      run: currentRun.value?.id || undefined,
      shot: currentShot.value?.id || undefined,
      stage: !currentRun.value && workspaceMode.value === 'delivery' ? 'delivery' : undefined,
    },
  })
}

function mediaUrl(value) {
  if (!value) return ''
  if (/^(?:https?:)?\/\//.test(value) || value.startsWith('/static/')) return value
  return `/static/${String(value).replace(/^\/+/, '')}`
}
</script>

<style scoped>
.paper-studio {
  --paper-shell: #171816;
  --paper-workspace: #1b1c1a;
  --paper-panel: #20211f;
  --paper-text: #eee8dc;
  --paper-muted: #aaa397;
  --paper-dim: #6f6b63;
  --paper-line: #34342f;
  --paper-line-soft: #2a2b28;
  --paper-hover: #242522;
  --paper-active: #292924;
  --paper-accent: #d5a954;
  min-height: 100vh;
  background: var(--paper-workspace);
  color: var(--paper-text);
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.recovery-strip { min-height: 38px; display: flex; align-items: center; gap: 10px; padding: 0 18px; border-bottom: 1px solid #4d422c; background: #24221c; color: var(--paper-muted); font-size: var(--paper-fs-sm); }
.recovery-strip > span { color: var(--paper-accent); font-size: var(--paper-fs-xs); font-weight: 800; letter-spacing: .08em; }
.recovery-strip > strong { min-width: 0; overflow: hidden; color: var(--paper-text); font-size: var(--paper-fs-sm); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.recovery-strip button { margin-left: auto; border: 0; background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-xs); cursor: pointer; }
.recovery-strip button:last-child { margin-left: 2px; color: var(--paper-dim); font-size: var(--paper-fs-lg); }
.recovery-strip button:hover { color: var(--paper-accent); }
.studio-layout { min-height: calc(100vh - 72px); display: grid; grid-template-columns: 280px minmax(0, 1fr) 320px; }
.studio-layout.rail-collapsed { grid-template-columns: 64px minmax(0, 1fr) 320px; }
.rail-collapse-toggle { position: sticky; top: 0; z-index: 5; width: 100%; min-height: var(--paper-hit-min); display: flex; align-items: center; justify-content: center; gap: 6px; border: 0; border-bottom: 1px solid var(--paper-line); background: var(--paper-shell); color: var(--paper-dim); font-size: var(--paper-fs-sm); cursor: pointer; }
.rail-collapse-toggle:hover { color: var(--paper-accent); }
.rail-collapse-toggle i { display: grid; place-items: center; min-width: 20px; height: 20px; border: 1px solid var(--paper-line); border-radius: 50%; font-style: normal; font-size: var(--paper-fs-xs); }
.left-rail.collapsed > *:not(.rail-collapse-toggle) { display: none; }
.has-recovery .studio-layout { min-height: calc(100vh - 110px); }
.has-error .studio-layout { min-height: calc(100vh - 120px); }
.has-error.has-recovery .studio-layout { min-height: calc(100vh - 158px); }
.left-rail { min-width: 0; max-height: calc(100vh - 72px); overflow-y: auto; border-right: 1px solid var(--paper-line); background: var(--paper-shell); }
.has-recovery .left-rail, .has-recovery .workspace, .has-recovery .inspector { max-height: calc(100vh - 110px); }
.has-error .left-rail, .has-error .workspace, .has-error .inspector { max-height: calc(100vh - 120px); }
.has-error.has-recovery .left-rail, .has-error.has-recovery .workspace, .has-error.has-recovery .inspector { max-height: calc(100vh - 158px); }
.workspace { min-width: 0; max-height: calc(100vh - 72px); overflow-y: auto; background: var(--paper-workspace); }
.script-stage { display: flex; flex-direction: column; min-height: 100%; }
.workspace-modes { position: sticky; top: 0; z-index: 7; height: 48px; display: flex; align-items: stretch; padding: 0 20px; border-bottom: 1px solid var(--paper-line); background: rgb(23 24 22 / 96%); backdrop-filter: blur(12px); }
.workspace-modes button { position: relative; display: flex; align-items: center; gap: 8px; padding: 0 13px; border: 0; background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
.workspace-modes button::after { content: ''; position: absolute; right: 13px; bottom: -1px; left: 13px; height: 2px; background: transparent; }
.workspace-modes button.active { color: var(--paper-text); }
.workspace-modes button.active::after { background: var(--paper-accent); }
.workspace-modes i { display: grid; place-items: center; min-width: 26px; height: 20px; padding: 0 4px; border: 1px solid var(--paper-line); color: var(--paper-dim); font: 700 var(--paper-fs-xs) ui-monospace, monospace; font-style: normal; }
.workspace-modes button.active i { border-color: #6d5934; color: var(--paper-accent); }
.workspace-modes + :deep(.storyboard-editor) .editor-heading { top: 48px; }
.inspector { min-width: 0; max-height: calc(100vh - 72px); overflow-y: auto; border-left: 1px solid var(--paper-line); background: var(--paper-shell); }
.rail-secondary-actions { padding: 14px 18px; border-top: 1px solid var(--paper-line); }
.rail-secondary-actions button { width: 100%; padding: 9px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
.rail-secondary-actions button:hover:not(:disabled) { border-color: var(--paper-accent); color: var(--paper-accent); }
.rail-secondary-actions button:disabled { opacity: .35; cursor: not-allowed; }
.rail-secondary-actions small { display: block; margin-top: 7px; color: var(--paper-dim); font-size: var(--paper-fs-xs); text-align: center; }
.run-history { border-top: 1px solid var(--paper-line); }
.run-history summary { display: flex; align-items: center; justify-content: space-between; padding: 15px 18px; color: var(--paper-dim); font-size: var(--paper-fs-sm); font-weight: 700; letter-spacing: .1em; cursor: pointer; list-style: none; }
.run-history summary::-webkit-details-marker { display: none; }
.run-history summary i { display: grid; place-items: center; min-width: 19px; height: 19px; border: 1px solid var(--paper-line); border-radius: 50%; font-style: normal; }
.run-resume-card { width: calc(100% - 20px); display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin: 0 10px 8px; padding: 11px 12px; border: 1px solid #76602f; background: #282316; color: var(--paper-muted); text-align: left; cursor: pointer; }
.run-resume-card > span { color: var(--paper-accent); font-size: var(--paper-fs-xs); font-weight: 700; letter-spacing: .08em; }
.run-resume-card > strong { color: var(--paper-text); font-size: var(--paper-fs-sm); line-height: 1.45; }
.run-resume-card > small { color: #a99b79; font-size: var(--paper-fs-xs); line-height: 1.4; }
.run-resume-card:hover { border-color: var(--paper-accent); background: #302919; }
.run-item { width: calc(100% - 20px); min-height: var(--paper-hit-min); display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 10px; margin: 0 10px 4px; padding: 12px 10px; border: 0; background: transparent; color: var(--paper-muted); text-align: left; cursor: pointer; }
.run-item:hover, .run-item.active { background: var(--paper-hover); }
.run-number, .run-item > span:last-child { color: var(--paper-dim); font: 700 var(--paper-fs-xs) ui-monospace, monospace; }
.run-item.active .run-number { color: var(--paper-accent); }
.run-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.run-copy strong { color: var(--paper-text); font-size: var(--paper-fs-sm); }
.run-copy small { overflow: hidden; color: var(--paper-dim); font-size: var(--paper-fs-xs); text-overflow: ellipsis; white-space: nowrap; }
.run-history p { margin: 0; padding: 0 18px 16px; color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.legacy-runs { margin: 8px 10px 12px; border-top: 1px solid var(--paper-line-soft); }
.legacy-runs > summary { padding: 10px 8px; font-size: var(--paper-fs-xs); letter-spacing: .04em; }
.production-heading { min-height: 64px; display: flex; align-items: center; gap: 18px; padding: 0 20px; border-bottom: 1px solid var(--paper-line); }
.production-heading button { border: 0; background: transparent; color: var(--paper-muted); font-size: var(--paper-fs-sm); cursor: pointer; }
.production-heading button:hover { color: var(--paper-accent); }
.production-heading .history-entry { margin-left: auto; padding: 8px 11px; border: 1px solid var(--paper-line); color: var(--paper-accent); }
.production-heading div { display: flex; flex-direction: column; gap: 3px; }
.production-heading span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .12em; }
.production-heading strong { font-size: var(--paper-fs-base); }
.inspector-section { padding: 19px 18px; border-bottom: 1px solid var(--paper-line); }
.inspector-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 13px; color: var(--paper-dim); font-size: var(--paper-fs-sm); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.inspector-heading i { font-style: normal; font-size: var(--paper-fs-xs); }
.inspector-heading i.ok { color: #83a982; }
.inspector-heading i.blocked { color: #d17a69; }
.inspector-section > p { margin: 0 0 10px; color: var(--paper-muted); font-size: var(--paper-fs-sm); line-height: 1.65; }
.inspector-section > small { display: block; margin-top: 8px; color: var(--paper-dim); font-size: var(--paper-fs-xs); line-height: 1.55; }
.inspector-section select, .inspector-section textarea { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid var(--paper-line); outline: 0; resize: vertical; background: #131412; color: var(--paper-text); font: var(--paper-fs-base)/1.6 inherit; }
.inspector-section select:focus, .inspector-section textarea:focus { border-color: var(--paper-accent); }
.provider-facts { display: flex; gap: 5px; margin-top: 8px; }
.provider-facts span { padding: 5px 6px; border: 1px solid var(--paper-line-soft); color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.warning-copy { margin-top: 8px !important; color: #bd9c5d !important; font-size: var(--paper-fs-xs) !important; }
.blocking-copy { color: #d17a69 !important; }
.primary-action, .secondary-action, .danger-action { width: 100%; margin-top: 10px; padding: 10px 11px; border-radius: 2px; font-size: var(--paper-fs-sm); font-weight: 800; cursor: pointer; }
.primary-action { border: 0; background: var(--paper-accent); color: #211c13; }
.secondary-action { border: 1px solid var(--paper-line); background: transparent; color: var(--paper-text); }
.danger-action { border: 1px solid #663c34; background: transparent; color: #d48676; }
.primary-action:hover:not(:disabled) { filter: brightness(1.08); }
.secondary-action:hover:not(:disabled) { border-color: var(--paper-accent); color: var(--paper-accent); }
.primary-action:disabled, .secondary-action:disabled, .danger-action:disabled { opacity: .38; cursor: not-allowed; }
.run-controls { margin-top: 10px; padding-top: 2px; border-top: 1px solid var(--paper-line-soft); }
.event-stream article { margin-top: 8px; padding: 9px; border-left: 2px solid #59636b; background: #1b1c1a; }
.event-stream article.warning { border-left-color: #bd9c5d; }
.event-stream article.error { border-left-color: #d17a69; }
.event-stream article strong { color: var(--paper-text); font-size: var(--paper-fs-sm); }
.event-stream article p { margin: 4px 0; color: var(--paper-muted); font-size: var(--paper-fs-xs); line-height: 1.5; }
.event-stream article small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.next-action > strong { display: block; color: var(--paper-text); font: 500 17px Georgia, serif; }
.next-action > p { margin-top: 8px; color: var(--paper-dim); }
.tier-selector { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; border: 1px solid var(--paper-line); background: var(--paper-line); }
.tier-selector button { display: flex; flex-direction: column; gap: 4px; padding: 10px 6px; border: 0; background: var(--paper-panel); color: var(--paper-muted); cursor: pointer; }
.tier-selector button.active { background: #2d2a22; box-shadow: inset 0 2px var(--paper-accent); color: var(--paper-text); }
.tier-selector strong { font-size: var(--paper-fs-sm); }
.tier-selector small { color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.episode-output a { display: block; margin-top: 8px; color: var(--paper-accent); font-size: var(--paper-fs-sm); text-decoration: none; }
.merge-state { display: block; margin-top: 8px; color: var(--paper-muted); font-size: var(--paper-fs-sm); }
.error-banner { min-height: 48px; display: flex; align-items: center; gap: 18px; padding: 7px 18px; background: #482823; color: #ead5cf; font-size: var(--paper-fs-sm); }
.error-banner-copy { min-width: 0; display: flex; align-items: baseline; gap: 14px; }
.error-banner-copy strong { flex: 0 0 auto; }
.error-banner-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.error-banner-actions { display: flex; gap: 7px; margin-left: auto; }
.error-banner-actions button { min-height: 30px; padding: 5px 10px; cursor: pointer; }
.error-banner .solution-action { border: 0; background: #f2d48f; color: #382819; font-weight: 800; }
.error-banner .reload-action { border: 1px solid #a36e61; background: transparent; color: #e9c8c0; }
.solution-overlay { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 24px; background: rgb(7 8 7 / 76%); backdrop-filter: blur(7px); }
.solution-dialog { width: min(680px, calc(100vw - 32px)); max-height: min(760px, calc(100vh - 48px)); overflow-y: auto; border: 1px solid #665536; background: #1b1c19; box-shadow: 0 24px 80px rgb(0 0 0 / 55%); }
.solution-dialog > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 22px 24px 18px; border-bottom: 1px solid var(--paper-line); }
.solution-dialog > header span { color: var(--paper-accent); font: 700 var(--paper-fs-xs) ui-monospace, monospace; letter-spacing: .14em; }
.solution-dialog h2 { margin: 7px 0 0; color: var(--paper-text); font: 600 23px/1.25 Georgia, 'Songti SC', serif; }
.solution-dialog > header button { border: 0; background: transparent; color: var(--paper-dim); font-size: 24px; cursor: pointer; }
.solution-dialog > header button:hover { color: var(--paper-text); }
.solution-context { padding: 18px 24px 4px; }
.solution-context strong { color: var(--paper-accent); font-size: var(--paper-fs-sm); }
.solution-context p { margin: 8px 0 0; color: var(--paper-muted); font-size: var(--paper-fs-sm); line-height: 1.65; }
.solution-list { margin: 10px 24px 0; padding: 0; list-style: none; counter-reset: recovery; }
.solution-list li { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 13px 0 13px 34px; border-top: 1px solid var(--paper-line-soft); counter-increment: recovery; }
.solution-list li::before { content: counter(recovery, decimal-leading-zero); position: absolute; top: 14px; left: 0; color: var(--paper-dim); font: 700 var(--paper-fs-xs) ui-monospace, monospace; }
.solution-list span { color: #dbc0ba; font-size: var(--paper-fs-sm); line-height: 1.55; }
.solution-list strong { color: var(--paper-text); font-size: var(--paper-fs-sm); font-weight: 500; line-height: 1.65; }
.solution-more { margin: 10px 24px 0; color: var(--paper-dim); font-size: var(--paper-fs-xs); }
.solution-steps { margin: 18px 24px 0; padding: 13px 14px; border-left: 2px solid var(--paper-accent); background: #22211c; }
.solution-steps span { color: var(--paper-accent); font-size: var(--paper-fs-xs); font-weight: 800; letter-spacing: .1em; }
.solution-steps p { margin: 5px 0 0; color: var(--paper-muted); font-size: var(--paper-fs-sm); line-height: 1.6; }
.solution-dialog > footer { display: flex; gap: 9px; padding: 20px 24px 24px; }
.solution-dialog > footer button { min-height: 38px; padding: 0 15px; cursor: pointer; }
.solution-primary { border: 0; background: var(--paper-accent); color: #211c13; font-weight: 800; }
.solution-secondary { border: 1px solid var(--paper-line); background: transparent; color: var(--paper-muted); }
.loading-layer { position: fixed; inset: 72px 0 0; z-index: 20; display: grid; place-content: center; gap: 12px; background: rgb(23 24 22 / 84%); backdrop-filter: blur(8px); color: var(--paper-muted); font-size: var(--paper-fs-base); }
.loading-layer span { width: 48px; height: 2px; overflow: hidden; background: var(--paper-line); }
.loading-layer span::after { content: ''; display: block; width: 45%; height: 100%; background: var(--paper-accent); animation: loading 1s ease-in-out infinite alternate; }
@keyframes loading { from { transform: translateX(-100%); } to { transform: translateX(220%); } }
@media (max-width: 1180px) {
  .studio-layout, .studio-layout.rail-collapsed { grid-template-columns: 260px minmax(0, 1fr); }
  .inspector { position: fixed; z-index: 10; right: 0; top: 72px; bottom: 0; width: 360px; box-shadow: -18px 0 35px rgb(0 0 0 / 35%); }
  .workspace { padding-right: 360px; }
}
@media (max-width: 860px) {
  .studio-layout { grid-template-columns: 1fr; }
  .error-banner { align-items: flex-start; flex-direction: column; gap: 8px; }
  .error-banner-copy { align-items: flex-start; flex-direction: column; gap: 3px; }
  .error-banner-copy span { white-space: normal; }
  .error-banner-actions { width: 100%; margin-left: 0; }
  .solution-dialog > footer { align-items: stretch; flex-direction: column; }
  .left-rail { display: none; }
  .workspace { max-height: none; padding-right: 0; }
  .inspector { position: static; width: auto; max-height: none; border-top: 1px solid var(--paper-line); }
}
</style>
