const fs = require('fs');
const path = require('path');

function packageName() {
  if (process.platform === 'darwin') return `@remotion/compositor-darwin-${process.arch}`;
  if (process.platform === 'win32') return `@remotion/compositor-win32-${process.arch}-msvc`;
  return `@remotion/compositor-linux-${process.arch}-gnu`;
}

function binary(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function esbuildBinaryName() {
  const platform = process.platform === 'win32' ? 'win32' : process.platform;
  return `@esbuild/${platform}-${process.arch}`;
}

function browserCachePlatform() {
  const key = `${process.platform}-${process.arch}`;
  return {
    'darwin-arm64': 'mac-arm64',
    'darwin-x64': 'mac-x64',
    'win32-x64': 'win64',
    'linux-x64': 'linux64',
    'linux-arm64': 'linux-arm64',
  }[key] || null;
}

function exists(filePath) {
  try { return Boolean(filePath && fs.existsSync(filePath)); } catch (_) { return false; }
}

function findBrowser(root, depth = 0) {
  if (!root || depth > 7 || !exists(root)) return null;
  const names = process.platform === 'win32'
    ? ['chrome-headless-shell.exe', 'headless_shell.exe', 'chrome.exe']
    : ['chrome-headless-shell', 'headless_shell', 'chrome', 'Google Chrome for Testing'];
  let stat;
  try { stat = fs.statSync(root); } catch (_) { return null; }
  if (stat.isFile() && names.includes(path.basename(root))) return root;
  if (!stat.isDirectory()) return null;
  for (const name of names) {
    const direct = path.join(root, name);
    if (exists(direct)) return direct;
  }
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const found = findBrowser(path.join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function bundledBrowserPath() {
  if (process.env.REMOTION_BROWSER_EXECUTABLE && exists(process.env.REMOTION_BROWSER_EXECUTABLE)) {
    return { path: process.env.REMOTION_BROWSER_EXECUTABLE, source: 'configured' };
  }
  const runtimeRoots = [
    process.env.REMOTION_RUNTIME_ROOT,
    process.resourcesPath ? path.join(process.resourcesPath, 'remotion-runtime') : null,
    path.join(process.cwd(), 'remotion-runtime'),
    path.resolve(__dirname, '..', '..', 'remotion-runtime'),
  ].filter(Boolean);
  for (const runtimeRoot of [...new Set(runtimeRoots)]) {
    const root = path.join(runtimeRoot, 'browser', `${process.platform}-${process.arch}`);
    const found = findBrowser(root);
    if (found) return { path: found, source: 'bundled' };
  }
  // A developer may have run `remotion browser ensure` without staging an
  // Electron resource yet. Report that cache as a usable local source too.
  const cacheRoots = [
    path.join(process.cwd(), 'node_modules', '.remotion', 'chrome-headless-shell'),
    path.resolve(__dirname, '..', '..', 'node_modules', '.remotion', 'chrome-headless-shell'),
  ];
  const cachePlatform = browserCachePlatform();
  for (const root of [...new Set(cacheRoots)]) {
    const found = cachePlatform ? findBrowser(path.join(root, cachePlatform)) : findBrowser(root);
    if (found) return { path: found, source: 'remotion-cache' };
  }
  return null;
}

function compositorDir() {
  const required = [binary('remotion'), binary('ffmpeg'), binary('ffprobe')];
  const candidates = [process.env.REMOTION_BINARIES_DIRECTORY];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', packageName()));
  try {
    const packageJson = require.resolve(`${packageName()}/package.json`);
    candidates.push(path.dirname(packageJson));
  } catch (_) {}
  for (const candidate of candidates.filter(Boolean)) {
    if (required.every((name) => exists(path.join(candidate, name)))) return candidate;
  }
  return null;
}

function esbuildPath() {
  if (process.env.ESBUILD_BINARY_PATH && exists(process.env.ESBUILD_BINARY_PATH)) return process.env.ESBUILD_BINARY_PATH;
  try {
    const subpath = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
    return require.resolve(`${esbuildBinaryName()}/${subpath}`);
  } catch (_) { return null; }
}

/**
 * Decorate the legacy paper-render doctor result with the resources that are
 * actually used by a packaged/offline Electron render. This lives outside
 * paperRenderService so the renderer implementation remains unchanged.
 */
function decorateDoctor(base = {}) {
  const browser = bundledBrowserPath();
  const compositor = compositorDir();
  const esbuild = esbuildPath();
  const rendererAvailable = Boolean(base.remotion_bundle?.available && exists(base.remotion_bundle.path));
  const storageWritable = Boolean(base.storage?.writable);
  const offlineReady = Boolean(rendererAvailable && browser?.path && compositor && esbuild && storageWritable);
  const result = {
    ...base,
    browser: browser
      ? { ...(base.browser || {}), available: true, path: browser.path, source: browser.source }
      : { ...(base.browser || {}), source: base.browser?.available ? 'system' : 'missing' },
    compositor: {
      available: Boolean(compositor),
      path: compositor,
      renderer: compositor ? path.join(compositor, binary('remotion')) : null,
      ffmpeg: compositor ? path.join(compositor, binary('ffmpeg')) : base.ffmpeg?.path || null,
      ffprobe: compositor ? path.join(compositor, binary('ffprobe')) : base.ffprobe?.path || null,
      source: compositor ? (process.env.REMOTION_BINARIES_DIRECTORY ? 'configured' : 'package') : 'missing',
    },
    esbuild: { available: Boolean(esbuild), path: esbuild, source: esbuild ? (process.env.ESBUILD_BINARY_PATH ? 'configured' : 'package') : 'missing' },
    offline: {
      ready: offlineReady,
      browser: Boolean(browser?.path),
      compositor: Boolean(compositor),
      esbuild: Boolean(esbuild),
      renderer: rendererAvailable,
      storage_writable: storageWritable,
      reason: offlineReady ? null : '需要已打包的 Chrome Headless Shell、Remotion compositor、esbuild 和可写存储目录',
    },
    offline_ready: offlineReady,
  };
  // Keep the old system-browser result compatible, while allowing a packaged
  // build with no system Chrome to pass when all offline resources are present.
  result.ok = base.enabled === false ? false : Boolean(result.ok || offlineReady);
  return result;
}

module.exports = { decorateDoctor, bundledBrowserPath, compositorDir };
