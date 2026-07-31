import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

test('paper storyboard repair API and store preserve a confirmation preview before mutating the draft', () => {
  const api = readFileSync(join(root, 'api', 'paperStudio.js'), 'utf8')
  const store = readFileSync(join(root, 'stores', 'paperStudioStore.js'), 'utf8')
  assert.match(api, /repair-generated-storyboards/)
  assert.match(store, /storyboardRepairPreview\.value = response/)
  assert.match(store, /function acceptStoryboardRepairPreview\(\)/)
  assert.match(store, /shots: storyboardRepairPreview\.value\.shots/)
  assert.match(store, /async function repairCurrentPaperStoryboard\(\)/)
  assert.match(store, /async function acceptCurrentStoryboardRepairPreview\(\)/)
})

test('paper storyboard draft exposes missing fields, AI repair action and apply gate', () => {
  const component = readFileSync(join(root, 'components', 'paper-studio', 'PaperScriptWorkbench.vue'), 'utf8')
  assert.match(component, /AI 补全缺失内容/)
  assert.match(component, /缺少画面描述/)
  assert.match(component, /缺少主体动作/)
  assert.match(component, /AI 补全建议/)
  assert.match(component, /接受并写入草稿/)
  assert.match(component, /draftIssues\.length > 0/)
  assert.match(component, /图片 API 0 次/)

  const editor = readFileSync(join(root, 'components', 'paper-studio', 'PaperStoryboardEditor.vue'), 'utf8')
  assert.match(editor, /AI 补全本镜/)
  assert.match(editor, /接受并保存/)
  assert.match(editor, /新的分镜版本/)
})

test('paper studio repair flow discloses text-model cost before requesting repair', () => {
  const view = readFileSync(join(root, 'views', 'PaperStudio.vue'), 'utf8')
  assert.match(view, /AI 补全 \$\{issues\.length\} 个不完整分镜/)
  assert.match(view, /不会改写已有内容、对白、时长、实体绑定和镜头顺序/)
  assert.match(view, /0 次图片 API/)
  assert.match(view, /repairGeneratedStoryboardsDraft/)
  assert.match(view, /onRepairCurrentStoryboard/)
  assert.match(view, /acceptCurrentStoryboardRepairPreview/)
})
