<template>
  <div class="paper-page">
    <header class="paper-page__top">
      <el-button @click="goBack">返回分镜</el-button>
      <span>纸片分层动画编辑器</span>
    </header>
    <PaperLayerEditor v-if="storyboardId" :storyboard-id="storyboardId" :drama-id="dramaId" />
    <el-empty v-else description="缺少 storyboard_id" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PaperLayerEditor from '@/components/paper/PaperLayerEditor.vue'

const route = useRoute()
const router = useRouter()
const dramaId = computed(() => route.params.id || null)
const storyboardId = computed(() => route.query.storyboard_id || route.query.storyboard || null)
function goBack() { router.push({ path: `/film/${dramaId.value}`, query: route.query.episode ? { episode: route.query.episode } : {} }) }
</script>

<style scoped>
.paper-page { min-height:100vh; background:#f7f8fb; }
.paper-page__top { height:54px; display:flex; align-items:center; gap:14px; padding:0 22px; background:#fff; border-bottom:1px solid #e5e7eb; font-weight:700; color:#334155; }
</style>
