<template>
  <section id="paper-audio-workbench" class="audio-workbench" data-workbench="audio">
    <header class="audio-heading">
      <div>
        <span>SOUND &amp; CAPTIONS</span>
        <h3>声音与字幕</h3>
        <p>对白和旁白分别保存版本，并固定到下一次预览和正式视频。</p>
      </div>
      <strong class="readiness" :class="audio?.ready ? 'ready' : 'attention'">
        {{ readinessLabel }}
      </strong>
    </header>

    <div class="policy-row" role="radiogroup" aria-label="声音策略">
      <button
        v-for="policy in policies"
        :key="policy.value"
        type="button"
        role="radio"
        :aria-checked="audioMode === policy.value"
        :class="{ active: audioMode === policy.value }"
        :disabled="busy"
        @click="requestPolicy(policy.value)"
      >
        <strong>{{ policy.label }}</strong>
        <small>{{ policy.help }}</small>
      </button>
    </div>

    <div v-if="audio?.missing?.length" class="audio-attention" role="status">
      <strong>正式制作前还差：</strong>
      <span v-for="item in audio.missing" :key="`${item.kind}-${item.reason}`">{{ item.reason }}</span>
    </div>

    <div v-if="audio?.ready && audio?.duration_extended" class="duration-notice" role="status">
      <strong>画面将按完整语音自动延长</strong>
      <span>原定 {{ formatSeconds(audio.authored_duration_seconds) }}，语音 {{ formatSeconds(audio.speech_end_seconds) }}，生产时使用 {{ formatSeconds(audio.effective_duration_seconds) }}（含尾帧停留）。</span>
    </div>

    <div v-if="audioMode === 'silent'" class="silent-state">
      <div class="silent-mark" aria-hidden="true">∿</div>
      <div>
        <strong>当前分镜将明确以静音方式制作</strong>
        <p>已有声音版本和历史视频会保留，但下一次 snapshot 不会带入音轨或字幕。</p>
      </div>
      <button type="button" :disabled="busy" @click="$emit('set-policy', 'auto')">恢复按文本配音</button>
    </div>

    <div v-else class="audio-tracks">
      <article v-for="track in tracks" :key="track.kind" class="audio-track">
        <header>
          <div class="track-title">
            <i :class="track.kind" aria-hidden="true"></i>
            <div>
              <span>{{ track.kicker }}</span>
              <h4>{{ track.label }}</h4>
            </div>
          </div>
          <strong class="track-status" :class="track.version ? 'ready' : track.text ? 'attention' : 'empty'">
            {{ track.version ? `版本 ${track.version.version_number}` : track.text ? '缺少音频' : '未填写文本' }}
          </strong>
        </header>

        <blockquote v-if="track.text">{{ track.text }}</blockquote>
        <p v-else class="empty-copy">先在上方脚本中填写{{ track.label }}并保存，才能生成或上传音频。</p>

        <audio
          v-if="track.version?.audio_url"
          :key="track.version.id"
          class="audio-player"
          controls
          preload="metadata"
          :src="mediaUrl(track.version.audio_url)"
        />

        <div class="track-actions">
          <button type="button" :disabled="busy || !track.text" @click="synthesize(track.kind)">
            {{ track.version ? '重新生成配音' : '生成配音' }}
          </button>
          <button type="button" :disabled="busy || !track.text" @click="triggerUpload(track.kind)">上传音频</button>
          <input
            :ref="(element) => setFileInput(track.kind, element)"
            class="file-input"
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm"
            @change="upload(track.kind, $event)"
          />
          <a v-if="track.version?.subtitle_url" :href="mediaUrl(track.version.subtitle_url)" download>下载本镜字幕</a>
        </div>

        <div class="track-settings">
          <label>
            <span>声音标识</span>
            <input v-model.trim="settings[track.kind].voiceId" :disabled="busy" placeholder="可选，使用默认声音" />
          </label>
          <label>
            <span>语速</span>
            <input v-model.number="settings[track.kind].speed" :disabled="busy" type="number" min="0.5" max="2" step="0.05" />
          </label>
          <label>
            <span>开始时间</span>
            <div class="unit-field">
              <input v-model.number="settings[track.kind].startSeconds" :disabled="busy" type="number" min="0" :max="duration" step="0.1" />
              <i>秒</i>
            </div>
          </label>
          <label>
            <span>音量 {{ Math.round(settings[track.kind].volume * 100) }}%</span>
            <input v-model.number="settings[track.kind].volume" :disabled="busy" type="range" min="0" max="1.5" step="0.05" />
          </label>
          <label class="caption-toggle">
            <input v-model="settings[track.kind].captionsEnabled" :disabled="busy" type="checkbox" />
            <span>烧录字幕并生成 SRT</span>
          </label>
          <label class="caption-copy">
            <span>字幕文本</span>
            <textarea
              v-model="settings[track.kind].captionText"
              :disabled="busy || !settings[track.kind].captionsEnabled"
              rows="3"
              maxlength="8000"
              :placeholder="track.text || `${track.label}字幕`"
            />
          </label>
        </div>

        <footer>
          <span v-if="track.version">
            {{ sourceLabel(track.version.source_kind) }} · {{ formatDuration(track.version.duration_ms) }} · {{ track.version.captions_json?.length || 0 }} 段字幕
          </span>
          <span v-else>生成和上传都会建立不可变版本，不覆盖历史文件。</span>
          <button
            v-if="track.version"
            type="button"
            :disabled="busy || !trackDirty(track.kind)"
            @click="revise(track.kind)"
          >
            保存时间、音量与字幕
          </button>
        </footer>
      </article>
    </div>

    <details v-if="audio?.history?.length" class="audio-history">
      <summary>声音版本历史（{{ audio.history.length }}）</summary>
      <div class="history-list">
        <div v-for="version in audio.history" :key="version.id">
          <span>{{ version.audio_kind === 'dialogue' ? '对白' : '旁白' }} V{{ version.version_number }}</span>
          <strong>{{ sourceLabel(version.source_kind) }}</strong>
          <i :class="version.status">{{ statusLabel(version.status) }}</i>
          <time>{{ formatTime(version.created_at) }}</time>
        </div>
      </div>
    </details>

    <p class="impact-note">修改声音、开始时间、音量或字幕会使当前未发布的预览和正式渲染失效；历史发布版本仍会保留。</p>
  </section>
</template>

<script setup>
import { computed, reactive, watch } from 'vue'
import { audioStatusLabel } from '@/utils/paperStudioLabels'

const props = defineProps({
  storyboard: { type: Object, required: true },
  audio: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  fps: { type: Number, default: 30 },
})

const emit = defineEmits(['synthesize', 'upload', 'revise', 'set-policy'])

const policies = [
  { value: 'auto', label: '按文本配音', help: '填写了对白或旁白就必须补齐对应音频' },
  { value: 'required', label: '必须有声', help: '没有声音文本也会阻止正式制作' },
  { value: 'silent', label: '明确静音', help: '主动确认本镜不需要任何声音和字幕' },
]
const audioMode = computed(() => props.audio?.audio_mode || props.storyboard?.audio_mode || 'auto')
const duration = computed(() => Math.max(1, Number(props.storyboard?.duration || 6)))
const readinessLabel = computed(() => {
  if (!props.audio?.ready) return '等待处理'
  if (props.audio?.audio_mode === 'silent') return '已确认静音'
  if (props.audio?.duration_extended) return `声音已就绪 · 画面 ${formatSeconds(props.audio.effective_duration_seconds)}`
  return '声音已就绪'
})
const fileInputs = {}
const settings = reactive({ dialogue: emptySettings(), narration: emptySettings() })
const baseline = reactive({ dialogue: '', narration: '' })
let syncedKey = ''

const tracks = computed(() => [
  {
    kind: 'dialogue', kicker: 'DIALOGUE', label: '对白',
    text: String(props.storyboard?.dialogue || '').trim(), version: props.audio?.dialogue || null,
  },
  {
    kind: 'narration', kicker: 'NARRATION', label: '旁白',
    text: String(props.storyboard?.narration || '').trim(), version: props.audio?.narration || null,
  },
])

watch(() => [
  props.storyboard?.id,
  props.storyboard?.dialogue,
  props.storyboard?.narration,
  props.audio?.dialogue?.id,
  props.audio?.narration?.id,
  props.fps,
], () => {
  const key = [
    props.storyboard?.id,
    props.storyboard?.dialogue || '',
    props.storyboard?.narration || '',
    props.audio?.dialogue?.id || 0,
    props.audio?.narration?.id || 0,
    props.fps,
  ].join(':')
  if (key === syncedKey) return
  syncedKey = key
  syncSettings('dialogue', props.audio?.dialogue)
  syncSettings('narration', props.audio?.narration)
}, { immediate: true })

function emptySettings() {
  return { voiceId: '', speed: 1, volume: 1, startSeconds: 0, captionsEnabled: true, captionText: '' }
}

function syncSettings(kind, version) {
  const text = String(props.storyboard?.[kind] || '').trim()
  const next = {
    voiceId: version?.voice_id || '',
    speed: Number(version?.speed || 1),
    volume: Number(version?.volume == null ? 1 : version.volume),
    startSeconds: Number(((Number(version?.start_frame || 0)) / Math.max(1, Number(props.fps || 30))).toFixed(2)),
    captionsEnabled: version ? Boolean(version.captions_json?.length) : true,
    captionText: version?.captions_json?.length ? version.captions_json.map((item) => item.text).join('\n') : text,
  }
  Object.assign(settings[kind], next)
  baseline[kind] = JSON.stringify(next)
}

function options(kind) {
  return {
    voiceId: settings[kind].voiceId,
    speed: Number(settings[kind].speed || 1),
    volume: Number(settings[kind].volume == null ? 1 : settings[kind].volume),
    startSeconds: Math.max(0, Number(settings[kind].startSeconds || 0)),
    captionsEnabled: Boolean(settings[kind].captionsEnabled),
    captionText: settings[kind].captionText,
  }
}

function trackDirty(kind) {
  return baseline[kind] !== JSON.stringify(settings[kind])
}

function requestPolicy(value) {
  if (value !== audioMode.value) emit('set-policy', value)
}

function synthesize(kind) {
  emit('synthesize', { kind, options: options(kind) })
}

function revise(kind) {
  const version = props.audio?.[kind]
  if (version?.id) emit('revise', { kind, versionId: Number(version.id), options: options(kind) })
}

function setFileInput(kind, element) {
  if (element) fileInputs[kind] = element
}

function triggerUpload(kind) {
  fileInputs[kind]?.click()
}

function upload(kind, event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) emit('upload', { kind, file, options: options(kind) })
}

function sourceLabel(value) {
  return { tts: 'TTS 生成', upload: '本地上传', revision: '设置修订' }[value] || '声音版本'
}

function statusLabel(value) {
  return audioStatusLabel(value)
}

function formatDuration(milliseconds) {
  if (milliseconds == null) return '时长未知'
  return `${(Number(milliseconds) / 1000).toFixed(1)} 秒`
}

function formatSeconds(seconds) {
  const value = Number(seconds || 0)
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} 秒`
}

function formatTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString()
}

function mediaUrl(value) {
  if (!value) return ''
  if (/^(?:https?:)?\/\//.test(value) || value.startsWith('/static/')) return value
  return `/static/${String(value).replace(/^\/+/, '')}`
}
</script>

<style scoped>
.audio-workbench { margin-top: 34px; padding-top: 28px; border-top: 1px solid var(--paper-line); scroll-margin-top: 84px; }
.audio-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.audio-heading span { color: var(--paper-accent); font: 700 var(--paper-fs-sm) ui-monospace, monospace; letter-spacing: .14em; }
.audio-heading h3 { margin: 6px 0 4px; color: var(--paper-text); font: 600 22px/1.2 Georgia, 'Songti SC', serif; }
.audio-heading p { margin: 0; color: var(--paper-muted); font-size: var(--paper-fs-base); line-height: 1.6; }
.readiness { flex: none; padding: 7px 9px; border: 1px solid var(--paper-line); color: var(--paper-muted); font-size: var(--paper-fs-base); }
.readiness.ready { border-color: #4b654c; color: #9bc19a; }
.readiness.attention { border-color: #735d37; color: #d1ad69; }
.policy-row { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: 22px; border: 1px solid var(--paper-line); background: var(--paper-line); gap: 1px; }
.policy-row button { min-height: 70px; display: flex; flex-direction: column; align-items: flex-start; gap: 5px; padding: 13px 14px; border: 0; background: var(--paper-panel); color: var(--paper-muted); text-align: left; cursor: pointer; }
.policy-row button.active { background: #2d2a22; box-shadow: inset 0 2px var(--paper-accent); color: var(--paper-text); }
.policy-row button:disabled { opacity: .45; cursor: not-allowed; }
.policy-row strong { font-size: var(--paper-fs-base); }
.policy-row small { color: var(--paper-dim); font-size: var(--paper-fs-sm); line-height: 1.45; }
.audio-attention { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 14px; padding: 11px 13px; border-left: 2px solid #b58b43; background: #262219; color: #d6bd8a; font-size: var(--paper-fs-base); }
.duration-notice { display: grid; gap: 4px; margin-top: 14px; padding: 11px 13px; border-left: 2px solid #658566; background: #1d251d; color: #a9c5a8; font-size: var(--paper-fs-base); line-height: 1.5; }
.duration-notice strong { color: #c2d8c0; }
.silent-state { min-height: 132px; display: grid; grid-template-columns: 60px minmax(0, 1fr) auto; align-items: center; gap: 18px; margin-top: 18px; padding: 20px; border: 1px solid var(--paper-line); background: #191a18; }
.silent-mark { display: grid; place-items: center; width: 52px; height: 52px; border: 1px solid var(--paper-line); border-radius: 50%; color: var(--paper-dim); font-size: var(--paper-fs-display); }
.silent-state strong { color: var(--paper-text); font-size: var(--paper-fs-lg); }
.silent-state p { margin: 6px 0 0; color: var(--paper-muted); font-size: var(--paper-fs-base); line-height: 1.6; }
.silent-state button, .track-actions button, .track-settings + footer button { padding: 9px 11px; border: 1px solid var(--paper-line); background: transparent; color: var(--paper-text); font-size: var(--paper-fs-base); cursor: pointer; }
.silent-state button:hover:not(:disabled), .track-actions button:hover:not(:disabled), .track-settings + footer button:hover:not(:disabled) { border-color: var(--paper-accent); color: var(--paper-accent); }
.audio-tracks { margin-top: 18px; border-top: 1px solid var(--paper-line); }
.audio-track { padding: 23px 0; border-bottom: 1px solid var(--paper-line); }
.audio-track > header { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.track-title { display: flex; align-items: center; gap: 12px; }
.track-title i { width: 3px; height: 36px; background: #758998; }
.track-title i.narration { background: #a47f56; }
.track-title span { color: var(--paper-dim); font: 700 var(--paper-fs-sm) ui-monospace, monospace; letter-spacing: .12em; }
.track-title h4 { margin: 3px 0 0; color: var(--paper-text); font: 600 16px Georgia, 'Songti SC', serif; }
.track-status { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.track-status.ready { color: #90b28f; }
.track-status.attention { color: #d1ad69; }
.audio-track blockquote { margin: 17px 0 13px; padding-left: 13px; border-left: 1px solid var(--paper-line); color: #d9d1c4; font: 14px/1.7 Georgia, 'Songti SC', serif; }
.empty-copy { margin: 15px 0; color: var(--paper-dim); font-size: var(--paper-fs-base); }
.audio-player { width: 100%; height: 36px; margin: 4px 0 12px; color-scheme: dark; }
.track-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.track-actions button { padding: 8px 10px; }
.track-actions button:disabled, footer button:disabled, .silent-state button:disabled { opacity: .38; cursor: not-allowed; }
.track-actions a { margin-left: auto; color: var(--paper-accent); font-size: var(--paper-fs-sm); text-decoration: none; }
.file-input { display: none; }
.track-settings { display: grid; grid-template-columns: 1.2fr .7fr .7fr 1.4fr; gap: 14px; margin-top: 18px; }
.track-settings label { display: flex; flex-direction: column; gap: 7px; color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.track-settings input, .track-settings textarea { width: 100%; box-sizing: border-box; padding: 8px 0; border: 0; border-bottom: 1px solid var(--paper-line); outline: 0; resize: vertical; background: transparent; color: var(--paper-text); font: 11px/1.5 inherit; }
.track-settings input:focus, .track-settings textarea:focus { border-color: var(--paper-accent); }
.track-settings input[type='range'] { accent-color: var(--paper-accent); }
.unit-field { position: relative; }
.unit-field i { position: absolute; right: 0; bottom: 9px; color: var(--paper-dim); font-style: normal; }
.track-settings .caption-toggle { grid-column: 1 / 2; flex-direction: row; align-items: center; padding-top: 10px; color: var(--paper-muted); }
.caption-toggle input { width: auto; accent-color: var(--paper-accent); }
.track-settings .caption-copy { grid-column: 2 / -1; }
.audio-track footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 15px; }
.audio-track footer span { color: var(--paper-dim); font-size: var(--paper-fs-sm); }
.audio-history { margin-top: 18px; border-top: 1px solid var(--paper-line); }
.audio-history summary { padding: 15px 0; color: var(--paper-muted); font-size: var(--paper-fs-base); cursor: pointer; }
.history-list > div { display: grid; grid-template-columns: 100px 1fr 100px auto; gap: 12px; padding: 9px 0; border-top: 1px solid var(--paper-line-soft); color: var(--paper-muted); font-size: var(--paper-fs-sm); }
.history-list strong { color: var(--paper-text); }
.history-list i { color: var(--paper-dim); font-style: normal; }
.history-list i.ready { color: #90b28f; }
.history-list i.stale, .history-list i.failed { color: #d48676; }
.history-list time { color: var(--paper-dim); }
.impact-note { margin: 17px 0 0; color: #9f8c69; font-size: var(--paper-fs-sm); line-height: 1.6; }
@media (max-width: 760px) {
  .policy-row, .track-settings { grid-template-columns: 1fr; }
  .track-settings .caption-toggle, .track-settings .caption-copy { grid-column: 1; }
  .silent-state { grid-template-columns: 48px 1fr; }
  .silent-state button { grid-column: 1 / -1; }
  .history-list > div { grid-template-columns: 1fr 1fr; }
}
</style>
