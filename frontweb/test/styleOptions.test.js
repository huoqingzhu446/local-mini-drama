import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGenerationStyleOptions,
  generationStyleSelectionMetadata,
  getStylePromptEn,
  generationStyleLabel,
} from '../src/constants/styleOptions.js'

const customStyle = {
  id: 12,
  name: '自定义港风夜景',
  style_prompt_zh: '港风夜景，潮湿街道反光，低饱和霓虹点缀。',
  style_prompt_en: 'Hong Kong night mood, wet street reflections, restrained neon accents',
  visual_bible: 'Palette: 冷蓝与暗红\nNegative: 禁止廉价 HDR',
  character_style_prompt_en: 'grounded facial realism',
  video_style_prompt_en: 'continuous camera breathing',
}

test('builds custom generation style group and resolves prompt metadata', () => {
  const groups = buildGenerationStyleOptions([customStyle])
  assert.equal(groups[0].label, '自定义风格')
  assert.equal(groups[0].options[0].value, 'custom:12')

  const meta = generationStyleSelectionMetadata('custom:12', [customStyle])
  assert.equal(meta.generation_style_id, 12)
  assert.equal(meta.generation_style_name, '自定义港风夜景')
  assert.equal(meta.character_style_prompt_en, 'grounded facial realism')
  assert.equal(meta.video_style_prompt_en, 'continuous camera breathing')
})

test('static and custom labels/prompts resolve correctly', () => {
  assert.match(getStylePromptEn('ink wash'), /traditional Chinese ink wash painting/)
  assert.equal(generationStyleLabel('custom:12', [customStyle]), '自定义港风夜景')
})
