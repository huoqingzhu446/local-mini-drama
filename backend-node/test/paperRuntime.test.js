const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtime = require('../src/services/paperRuntimeService');

test('paper runtime doctor exposes an explicit offline gate', () => {
  const result = runtime.decorateDoctor({
    ok: false,
    remotion_bundle: { available: false, path: '/missing/render-paper.mjs' },
    browser: { available: false, path: null },
    storage: { writable: false, path: '/missing' },
  });

  assert.equal(result.offline.ready, false);
  assert.equal(result.offline_ready, false);
  assert.equal(result.offline.renderer, false);
  assert.equal(result.offline.storage_writable, false);
  assert.equal(typeof result.offline.reason, 'string');
  assert.ok(Object.hasOwn(result, 'compositor'));
});

test('paper runtime doctor accepts fully bundled offline resources', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-runtime-'));
  const exe = (name) => process.platform === 'win32' ? `${name}.exe` : name;
  const browser = path.join(temp, exe('chrome-headless-shell'));
  for (const name of [exe('chrome-headless-shell'), exe('remotion'), exe('ffmpeg'), exe('ffprobe'), exe('esbuild')]) {
    fs.writeFileSync(path.join(temp, name), 'fixture');
  }
  const previousBrowser = process.env.REMOTION_BROWSER_EXECUTABLE;
  const previousBinaries = process.env.REMOTION_BINARIES_DIRECTORY;
  const previousEsbuild = process.env.ESBUILD_BINARY_PATH;
  process.env.REMOTION_BROWSER_EXECUTABLE = browser;
  process.env.REMOTION_BINARIES_DIRECTORY = temp;
  process.env.ESBUILD_BINARY_PATH = path.join(temp, exe('esbuild'));
  try {
    const result = runtime.decorateDoctor({
      ok: false,
      remotion_bundle: { available: true, path: __filename },
      browser: { available: false, path: null },
      storage: { writable: true, path: temp },
    });
    assert.equal(result.offline_ready, true);
    assert.equal(result.ok, true);
    assert.equal(result.browser.path, browser);
    assert.equal(result.compositor.path, temp);
    assert.equal(result.esbuild.path, process.env.ESBUILD_BINARY_PATH);
  } finally {
    if (previousBrowser === undefined) delete process.env.REMOTION_BROWSER_EXECUTABLE;
    else process.env.REMOTION_BROWSER_EXECUTABLE = previousBrowser;
    if (previousBinaries === undefined) delete process.env.REMOTION_BINARIES_DIRECTORY;
    else process.env.REMOTION_BINARIES_DIRECTORY = previousBinaries;
    if (previousEsbuild === undefined) delete process.env.ESBUILD_BINARY_PATH;
    else process.env.ESBUILD_BINARY_PATH = previousEsbuild;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
