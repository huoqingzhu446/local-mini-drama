<template>
  <div v-if="images.length" class="codex-candidate-picker">
    <div
      v-for="candidate in images"
      :key="candidate.id || candidate.url"
      class="codex-candidate"
    >
      <button
        type="button"
        class="codex-candidate__image"
        title="预览候选图"
        @click="$emit('preview', candidate.url)"
      >
        <img :src="candidate.url" alt="" />
      </button>
      <el-button
        size="small"
        type="primary"
        plain
        :loading="usingCandidateId === candidate.id"
        :disabled="disabled"
        @click="$emit('use', candidate)"
      >
        使用
      </el-button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  job: { type: Object, default: null },
  usingCandidateId: { type: String, default: '' },
  disabled: { type: Boolean, default: false }
})

defineEmits(['use', 'preview'])

function candidateUrl(candidate) {
  if (!candidate) return ''
  if (candidate.url) return candidate.url
  if (candidate.local_path) return '/static/' + String(candidate.local_path).replace(/^\//, '')
  return candidate.image_url || ''
}

const images = computed(() => {
  const list = Array.isArray(props.job?.candidates) ? props.job.candidates : []
  return list
    .map((candidate) => ({ ...candidate, url: candidateUrl(candidate) }))
    .filter((candidate) => candidate.url)
})
</script>

<style scoped>
.codex-candidate-picker {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  padding: 6px 8px 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.codex-candidate {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.codex-candidate__image {
  width: 100%;
  aspect-ratio: 1;
  border: 1px solid rgba(139, 92, 246, 0.3);
  border-radius: 6px;
  padding: 0;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.18);
  cursor: pointer;
}

.codex-candidate__image img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.codex-candidate .el-button {
  width: 100%;
}
</style>
