const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isVolcengineAudioCapableModel,
  shouldRouteVolcengineSeedance2ToOmni,
  resolveVolcengineGenerateAudio,
  callVolcengineOmniVideoApi,
} = require('../src/services/videoClient');

test('recognizes Seedance models that support native audio generation', () => {
  assert.equal(isVolcengineAudioCapableModel('doubao-seedance-1-5-pro-251215'), true);
  assert.equal(isVolcengineAudioCapableModel('doubao-seedance-2-0-260128'), true);
  assert.equal(isVolcengineAudioCapableModel('doubao-seedance-1-0-pro-250528'), false);
});

test('uses the official native-audio default and respects saved settings', () => {
  const model = 'doubao-seedance-2-0-260128';
  assert.equal(resolveVolcengineGenerateAudio({}, model), true);
  assert.equal(
    resolveVolcengineGenerateAudio({ settings: '{"volcengine_generate_audio":false}' }, model),
    false
  );
  assert.equal(
    resolveVolcengineGenerateAudio({ settings: '{"generate_audio":"on"}' }, model),
    true
  );
  assert.equal(
    resolveVolcengineGenerateAudio(
      { settings: '{"volcengine_generate_audio":false}' },
      'doubao-seedance-1-0-pro-250528'
    ),
    undefined
  );
});

test('routes official Ark Seedance 2.0 configs to the Omni multi-reference API', () => {
  const config = { base_url: 'https://ark.cn-beijing.volces.com/api/v3' };
  assert.equal(
    shouldRouteVolcengineSeedance2ToOmni(config, 'volcengine', 'doubao-seedance-2-0-260128'),
    true
  );
  assert.equal(
    shouldRouteVolcengineSeedance2ToOmni(
      { base_url: 'https://example-proxy.com/v1' },
      'volcengine',
      'doubao-seedance-2-0-260128'
    ),
    false
  );
  assert.equal(
    shouldRouteVolcengineSeedance2ToOmni(config, 'volcengine', 'doubao-seedance-1-5-pro-251215'),
    false
  );
});

test('builds an Ark Seedance 2.0 request body compatible with the official Omni API', async () => {
  const originalFetch = global.fetch;
  let requestUrl;
  let requestBody;
  global.fetch = async (url, init) => {
    requestUrl = url;
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      text: async () => JSON.stringify({ id: 'cgt-test-task' }),
    };
  };

  try {
    const result = await callVolcengineOmniVideoApi(
      {
        provider: 'volcengine',
        base_url: 'https://ark.cn-beijing.volces.com/api/v3',
        api_key: 'test-key',
        model: ['doubao-seedance-2-0-260128'],
        default_model: 'doubao-seedance-2-0-260128',
      },
      { info() {}, warn() {} },
      {
        prompt: 'test prompt',
        duration: 11,
        aspect_ratio: '16:9',
        image_url: 'https://cdn.example.com/image-1.png',
        reference_urls: ['https://cdn.example.com/image-2.png'],
        voice_reference_url: 'https://cdn.example.com/voice.mp3',
        seed: 123,
        camera_fixed: true,
        video_gen_id: 1,
      }
    );

    assert.deepEqual(result, { task_id: 'cgt-test-task', status: 'processing' });
    assert.equal(requestUrl, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
    assert.equal(requestBody.model, 'doubao-seedance-2-0-260128');
    assert.equal(requestBody.generate_audio, true);
    assert.equal(requestBody.ratio, '16:9');
    assert.equal(requestBody.duration, 11);
    assert.equal(requestBody.watermark, false);
    assert.equal(requestBody.task_type, undefined);
    assert.equal(requestBody.seed, undefined);
    assert.equal(requestBody.camera_fixed, undefined);
    assert.deepEqual(requestBody.content, [
      { type: 'text', text: 'test prompt' },
      {
        type: 'image_url',
        image_url: { url: 'https://cdn.example.com/image-1.png' },
        role: 'reference_image',
      },
      {
        type: 'image_url',
        image_url: { url: 'https://cdn.example.com/image-2.png' },
        role: 'reference_image',
      },
      {
        type: 'audio_url',
        audio_url: { url: 'https://cdn.example.com/voice.mp3' },
        role: 'reference_audio',
      },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});
