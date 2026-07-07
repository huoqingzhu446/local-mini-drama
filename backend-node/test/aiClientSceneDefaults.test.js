const test = require('node:test');
const assert = require('node:assert/strict');

const { applySceneKeyOptionDefaults } = require('../src/services/aiClient');
const { applyDeepSeekChatOptions } = require('../src/services/deepseekConfig');

test('disables DeepSeek thinking for image prompt polish scene by default', () => {
  const options = applySceneKeyOptionDefaults({
    scene_key: 'image_polish',
    max_tokens: 300,
  });

  assert.equal(options.deepseek_thinking, 'disabled');
  assert.equal(options.max_tokens, 300);
});

test('keeps explicit DeepSeek thinking option for polish scene', () => {
  const options = applySceneKeyOptionDefaults({
    scene_key: 'image_polish',
    deepseek_thinking: 'enabled',
  });

  assert.equal(options.deepseek_thinking, 'enabled');
});

test('leaves reasoning-oriented scenes unchanged', () => {
  const original = {
    scene_key: 'storyboard_extraction',
    max_tokens: 16384,
  };
  const options = applySceneKeyOptionDefaults(original);

  assert.equal(options, original);
  assert.equal(options.deepseek_thinking, undefined);
});

test('scene defaults override globally enabled DeepSeek thinking when building body', () => {
  const options = applySceneKeyOptionDefaults({
    scene_key: 'image_polish',
  });
  const body = applyDeepSeekChatOptions(
    {
      provider: 'deepseek',
      settings: JSON.stringify({
        deepseek_thinking: 'enabled',
        deepseek_reasoning_effort: 'max',
      }),
    },
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '润色提示词' }],
      temperature: 0.3,
      max_tokens: 300,
    },
    options
  );

  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.temperature, 0.3);
});
