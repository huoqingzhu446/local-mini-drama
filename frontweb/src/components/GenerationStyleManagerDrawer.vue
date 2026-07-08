<template>
  <el-drawer
    :model-value="modelValue"
    title="自定义风格库"
    size="720px"
    destroy-on-close
    class="generation-style-drawer"
    @update:model-value="emit('update:modelValue', $event)"
    @open="loadStyles"
  >
    <div class="gs-toolbar">
      <el-input
        v-model="keyword"
        clearable
        placeholder="搜索名称、说明或提示词"
        class="gs-search"
        @keyup.enter="loadStyles"
        @clear="loadStyles"
      />
      <el-button size="small" @click="loadStyles">查询</el-button>
      <el-button size="small" type="primary" @click="startCreate">
        <el-icon><Plus /></el-icon>
        新增风格
      </el-button>
    </div>

    <div v-if="formVisible" class="gs-editor">
      <el-steps :active="stepIndex" finish-status="success" simple class="gs-steps">
        <el-step title="基础信息" />
        <el-step title="全局画风" />
        <el-step title="视觉圣经" />
        <el-step title="高级覆盖" />
      </el-steps>

      <el-form label-width="92px" class="gs-form">
        <template v-if="stepIndex === 0">
          <el-form-item label="名称">
            <el-input v-model="form.name" maxlength="80" show-word-limit placeholder="例如：新中式悬疑写实" />
          </el-form-item>
          <el-form-item label="说明">
            <el-input v-model="form.description" maxlength="300" show-word-limit placeholder="一句话说明这套风格适合什么题材" />
          </el-form-item>
          <el-form-item label="启用">
            <el-switch v-model="form.enabled" />
            <el-input-number v-model="form.sort_order" :min="0" :step="10" size="small" class="gs-sort" />
            <span class="gs-sort-hint">排序</span>
          </el-form-item>
        </template>

        <template v-else-if="stepIndex === 1">
          <el-form-item label="中文风格">
            <el-input
              v-model="form.style_prompt_zh"
              type="textarea"
              :rows="4"
              maxlength="4000"
              show-word-limit
              placeholder="写整体画风、质感、构图、材质、色彩倾向。角色/场景/道具/视频都会先继承这套全局风格。"
            />
          </el-form-item>
          <el-form-item label="英文风格">
            <el-input
              v-model="form.style_prompt_en"
              type="textarea"
              :rows="4"
              maxlength="4000"
              show-word-limit
              placeholder="建议填写英文版本，图片/视频模型通常更稳定。"
            />
          </el-form-item>
          <div class="gs-tip">
            这一步只定义“全局风格”。如果角色、场景、道具或视频需要额外偏向，放到最后一步再补。
          </div>
        </template>

        <template v-else-if="stepIndex === 2">
          <el-form-item label="配色">
            <el-input v-model="form.visual_bible_struct.palette" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="例如：冷青灰主色，局部暗金点缀，低饱和，避免荧光色。" />
          </el-form-item>
          <el-form-item label="光线">
            <el-input v-model="form.visual_bible_struct.lighting" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="例如：硬侧光克制，潮湿空气感，体积雾轻微，避免糖水柔光。" />
          </el-form-item>
          <el-form-item label="材质">
            <el-input v-model="form.visual_bible_struct.texture" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="例如：保留金属磨损、皮肤真实纹理、木头旧化与纸张纤维感。" />
          </el-form-item>
          <el-form-item label="构图">
            <el-input v-model="form.visual_bible_struct.composition" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="例如：偏电影构图，留出呼吸空间，主体清晰，不要居中证件照式摆放。" />
          </el-form-item>
          <el-form-item label="禁忌元素">
            <el-input v-model="form.visual_bible_struct.negative" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="例如：禁止过饱和霓虹、塑料皮肤、廉价 HDR、水印、随机文字。" />
          </el-form-item>
          <el-form-item label="补充说明">
            <el-input v-model="form.visual_bible_struct.notes" type="textarea" :rows="2" maxlength="800" show-word-limit placeholder="可选，补充特殊要求。" />
          </el-form-item>
          <div v-if="visualBiblePreview" class="gs-bible-preview">
            <div class="gs-bible-preview__title">预览</div>
            <pre>{{ visualBiblePreview }}</pre>
          </div>
        </template>

        <template v-else>
          <div class="gs-tip">
            留空代表“只继承全局风格”。只有当某一类素材确实需要额外偏向时才填写。
          </div>
          <el-form-item label="角色补充">
            <el-input v-model="form.character_style_prompt_zh" type="textarea" :rows="2" maxlength="3000" show-word-limit placeholder="例如：人物五官写实克制，服装层次更精细，避免表情过度夸张。" />
          </el-form-item>
          <el-form-item label="角色英文">
            <el-input v-model="form.character_style_prompt_en" type="textarea" :rows="2" maxlength="3000" show-word-limit placeholder="可选英文版本。" />
          </el-form-item>
          <el-form-item label="场景补充">
            <el-input v-model="form.scene_style_prompt_zh" type="textarea" :rows="2" maxlength="3000" show-word-limit placeholder="例如：场景更强调空间纵深、旧化痕迹、天气与空气层次。" />
          </el-form-item>
          <el-form-item label="场景英文">
            <el-input v-model="form.scene_style_prompt_en" type="textarea" :rows="2" maxlength="3000" show-word-limit placeholder="可选英文版本。" />
          </el-form-item>
          <el-form-item label="道具补充">
            <el-input v-model="form.prop_style_prompt_zh" type="textarea" :rows="2" maxlength="3000" show-word-limit placeholder="例如：单道具棚拍主图，强调材质与真实比例，禁止戏剧化背景。" />
          </el-form-item>
          <el-form-item label="道具英文">
            <el-input v-model="form.prop_style_prompt_en" type="textarea" :rows="2" maxlength="3000" show-word-limit placeholder="可选英文版本。" />
          </el-form-item>
          <el-form-item label="视频补充">
            <el-input v-model="form.video_style_prompt_zh" type="textarea" :rows="2" maxlength="3000" show-word-limit placeholder="例如：视频段落强调运镜呼吸感、空间连续性、情绪推进与镜头语言。" />
          </el-form-item>
          <el-form-item label="视频英文">
            <el-input v-model="form.video_style_prompt_en" type="textarea" :rows="2" maxlength="3000" show-word-limit placeholder="可选英文版本。" />
          </el-form-item>
        </template>
      </el-form>

      <div class="gs-editor-actions">
        <el-button size="small" @click="cancelEdit">取消</el-button>
        <el-button size="small" :disabled="stepIndex === 0" @click="stepIndex--">上一步</el-button>
        <el-button v-if="stepIndex < 3" size="small" type="primary" @click="goNextStep">下一步</el-button>
        <el-button v-else size="small" type="primary" :loading="saving" @click="submit">保存风格</el-button>
      </div>
    </div>

    <div v-loading="loading" class="gs-list">
      <div v-if="!loading && styles.length === 0" class="gs-empty">还没有自定义风格</div>
      <div v-for="item in styles" :key="item.id" class="gs-item">
        <div class="gs-item-main">
          <div class="gs-item-head">
            <strong>{{ item.name }}</strong>
            <el-tag size="small" :type="item.enabled ? 'success' : 'info'" effect="plain">
              {{ item.enabled ? '启用' : '停用' }}
            </el-tag>
            <el-tag v-if="item.character_style_prompt_zh || item.character_style_prompt_en" size="small" effect="plain">角色+</el-tag>
            <el-tag v-if="item.scene_style_prompt_zh || item.scene_style_prompt_en" size="small" effect="plain">场景+</el-tag>
            <el-tag v-if="item.prop_style_prompt_zh || item.prop_style_prompt_en" size="small" effect="plain">道具+</el-tag>
            <el-tag v-if="item.video_style_prompt_zh || item.video_style_prompt_en" size="small" effect="plain">视频+</el-tag>
          </div>
          <div v-if="item.description" class="gs-item-desc">{{ item.description }}</div>
          <div class="gs-item-preview">{{ item.style_prompt_zh || item.style_prompt_en }}</div>
        </div>
        <div class="gs-item-actions">
          <el-button size="small" plain @click="startEdit(item)">编辑</el-button>
          <el-button size="small" type="danger" plain @click="remove(item)">删除</el-button>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { generationStylesAPI } from '@/api/generationStyles'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'changed'])

const loading = ref(false)
const saving = ref(false)
const keyword = ref('')
const styles = ref([])
const formVisible = ref(false)
const stepIndex = ref(0)

const createEmptyForm = () => ({
  id: null,
  name: '',
  description: '',
  style_prompt_zh: '',
  style_prompt_en: '',
  visual_bible_struct: {
    palette: '',
    lighting: '',
    texture: '',
    composition: '',
    negative: '',
    notes: '',
  },
  character_style_prompt_zh: '',
  character_style_prompt_en: '',
  scene_style_prompt_zh: '',
  scene_style_prompt_en: '',
  prop_style_prompt_zh: '',
  prop_style_prompt_en: '',
  video_style_prompt_zh: '',
  video_style_prompt_en: '',
  enabled: true,
  sort_order: 0,
})

const form = reactive(createEmptyForm())

const visualBiblePreview = computed(() => {
  const map = [
    ['Palette', form.visual_bible_struct.palette],
    ['Lighting', form.visual_bible_struct.lighting],
    ['Texture', form.visual_bible_struct.texture],
    ['Composition', form.visual_bible_struct.composition],
    ['Negative', form.visual_bible_struct.negative],
    ['Notes', form.visual_bible_struct.notes],
  ]
  return map
    .map(([label, value]) => ((value || '').toString().trim() ? `${label}: ${String(value).trim()}` : ''))
    .filter(Boolean)
    .join('\n')
})

function assignForm(payload) {
  Object.assign(form, createEmptyForm(), payload || {})
  form.visual_bible_struct = {
    ...createEmptyForm().visual_bible_struct,
    ...(payload?.visual_bible_struct || {}),
  }
}

async function loadStyles() {
  loading.value = true
  try {
    const res = await generationStylesAPI.list({ keyword: keyword.value || undefined })
    styles.value = Array.isArray(res?.styles) ? res.styles : []
  } catch (e) {
    styles.value = []
    ElMessage.error(e.message || '加载风格失败')
  } finally {
    loading.value = false
  }
}

function startCreate() {
  assignForm({ enabled: true, sort_order: ((styles.value[0]?.sort_order || 0) + 10) })
  stepIndex.value = 0
  formVisible.value = true
}

function startEdit(item) {
  assignForm(item)
  stepIndex.value = 0
  formVisible.value = true
}

function cancelEdit() {
  formVisible.value = false
  stepIndex.value = 0
  assignForm()
}

function goNextStep() {
  if (stepIndex.value === 0 && !String(form.name || '').trim()) {
    ElMessage.warning('请先填写风格名称')
    return
  }
  if (stepIndex.value === 1 && !String(form.style_prompt_zh || '').trim() && !String(form.style_prompt_en || '').trim()) {
    ElMessage.warning('中文或英文全局风格至少填写一项')
    return
  }
  stepIndex.value += 1
}

function buildPayload() {
  return {
    name: form.name,
    description: form.description,
    style_prompt_zh: form.style_prompt_zh,
    style_prompt_en: form.style_prompt_en,
    visual_bible_struct: { ...form.visual_bible_struct },
    character_style_prompt_zh: form.character_style_prompt_zh,
    character_style_prompt_en: form.character_style_prompt_en,
    scene_style_prompt_zh: form.scene_style_prompt_zh,
    scene_style_prompt_en: form.scene_style_prompt_en,
    prop_style_prompt_zh: form.prop_style_prompt_zh,
    prop_style_prompt_en: form.prop_style_prompt_en,
    video_style_prompt_zh: form.video_style_prompt_zh,
    video_style_prompt_en: form.video_style_prompt_en,
    enabled: !!form.enabled,
    sort_order: form.sort_order,
  }
}

async function submit() {
  saving.value = true
  try {
    const body = buildPayload()
    if (form.id) await generationStylesAPI.update(form.id, body)
    else await generationStylesAPI.create(body)
    ElMessage.success('风格已保存')
    cancelEdit()
    await loadStyles()
    emit('changed')
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function remove(item) {
  try {
    await ElMessageBox.confirm(`确定删除风格「${item.name}」吗？`, '删除风格', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await generationStylesAPI.delete(item.id)
    ElMessage.success('已删除')
    if (form.id === item.id) cancelEdit()
    await loadStyles()
    emit('changed')
  } catch (e) {
    ElMessage.error(e.message || '删除失败')
  }
}

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) {
      keyword.value = ''
      cancelEdit()
    }
  }
)
</script>

<style scoped>
.gs-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.gs-search {
  flex: 1;
}

.gs-editor {
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  padding: 14px;
  background: var(--el-fill-color-lighter);
  margin-bottom: 14px;
}

.gs-steps {
  margin-bottom: 14px;
}

.gs-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}

.gs-sort {
  margin-left: 12px;
}

.gs-sort-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.gs-bible-preview {
  border-radius: 10px;
  border: 1px solid var(--el-border-color-light);
  padding: 10px 12px;
  background: var(--el-fill-color-blank);
}

.gs-bible-preview__title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}

.gs-bible-preview pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}

.gs-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.gs-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gs-empty {
  padding: 20px 0;
  text-align: center;
  color: var(--el-text-color-secondary);
}

.gs-item {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  align-items: flex-start;
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  padding: 12px 14px;
  background: var(--el-fill-color-blank);
}

.gs-item-main {
  min-width: 0;
  flex: 1;
}

.gs-item-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.gs-item-desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}

.gs-item-preview {
  font-size: 12px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.gs-item-actions {
  display: flex;
  gap: 8px;
}
</style>
