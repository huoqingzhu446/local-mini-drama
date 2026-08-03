import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

test('paper studio restores latest script content and exposes safe continuation generation', () => {
  const view = readFileSync(join(root, 'views', 'PaperStudio.vue'), 'utf8')
  const workbench = readFileSync(join(root, 'components', 'paper-studio', 'PaperScriptWorkbench.vue'), 'utf8')
  const store = readFileSync(join(root, 'stores', 'paperStudioStore.js'), 'utf8')

  assert.match(view, /activeScriptLoadToken/)
  assert.match(view, /store\.loadScriptContent\(scriptId\)/)
  assert.match(view, /:existing-shot-count="storyboards\.length"/)
  assert.match(workbench, /续写追加/)
  assert.match(workbench, /只追加新分镜/)
  assert.match(workbench, /generation_mode: generationMode\.value/)
  assert.match(workbench, /新增镜数/)
  assert.match(workbench, /watch\(\(\) => props\.activeScript,[\s\S]*?\}, \{ immediate: true \}\)/)
  assert.doesNotMatch(workbench, /\.next-steps button\s*\{/)
  assert.match(workbench, /\.gen-button \{[^}]*cursor: pointer/)
  assert.match(store, /generation_mode: params\.generation_mode/)
})
