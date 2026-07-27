const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');

const aiConfigService = require('../src/services/aiConfigService');
const ttsService = require('../src/services/ttsService');

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Kokoro-FastAPI TTS integration', () => {
  it('tests a local Kokoro connection without requiring an API key', async (t) => {
    t.mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8880/v1/audio/voices');
      assert.equal(options.method, 'GET');
      assert.deepEqual(options.headers, {});
      return {
        ok: true,
        json: async () => ({ voices: [{ id: 'zf_xiaobei' }] }),
      };
    });

    await aiConfigService.testConnection({
      service_type: 'tts',
      provider: 'kokoro',
      base_url: 'http://127.0.0.1:8880/v1',
      api_key: '',
      model: ['kokoro'],
    });
  });

  it('uses Kokoro defaults and stores the returned MP3 locally', async (t) => {
    let requestBody = null;
    const audio = Buffer.from('fake-mp3-audio');
    t.mock.method(http, 'request', (options, callback) => {
      assert.equal(options.method, 'POST');
      assert.equal(options.hostname, '127.0.0.1');
      assert.equal(options.port, '8880');
      assert.equal(options.path, '/v1/audio/speech');
      assert.equal(options.headers.Authorization, undefined);
      const req = new EventEmitter();
      const chunks = [];
      req.write = (chunk) => chunks.push(Buffer.from(chunk));
      req.destroy = () => req.emit('error', new Error('request destroyed'));
      req.end = () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        process.nextTick(() => {
          res.emit('data', audio);
          res.emit('end');
          req.emit('close');
        });
      };
      return req;
    });
    const storageBase = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-kokoro-'));
    tempDirs.push(storageBase);

    const result = await ttsService.synthesize(null, { info() {} }, {
      text: '欢迎使用本地短剧助手。',
      storyboard_id: 7,
      storage_base: storageBase,
      config: {
        provider: 'kokoro',
        base_url: 'http://127.0.0.1:8880/v1',
        api_key: '',
        model: ['kokoro'],
        settings: '{}',
      },
    });

    assert.deepEqual(requestBody, {
      model: 'kokoro',
      input: '欢迎使用本地短剧助手。',
      voice: 'zf_xiaobei',
      response_format: 'mp3',
      speed: 1,
    });
    assert.match(result.local_path, /^audio\/tts_sb7_[a-f0-9]{8}\.mp3$/);
    assert.deepEqual(fs.readFileSync(path.join(storageBase, result.local_path)), audio);
  });
});
