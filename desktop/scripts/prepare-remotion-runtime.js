/*
 * Stage the optional Remotion browser for an offline desktop build.
 *
 * Remotion keeps Chrome Headless Shell in node_modules/.remotion. That cache is
 * intentionally not assumed to exist on every developer machine, so this
 * script is best-effort by default and leaves a machine-readable manifest for
 * the desktop doctor. Set REMOTION_DOWNLOAD_BROWSER=1 to let Remotion download
 * the tested browser during a production build, or provide
 * REMOTION_BROWSER_SOURCE / REMOTION_BROWSER_EXECUTABLE explicitly.
 */
const fs = require('fs');
const path = require('path');

const desktopRoot = path.join(__dirname, '..');
const runtimeRoot = path.join(desktopRoot, 'remotion-runtime');
const browserRoot = path.join(runtimeRoot, 'browser');
const currentPlatformKey = `${process.platform}-${process.arch}`;

function executableNames() {
  if (process.platform === 'win32') return ['chrome-headless-shell.exe', 'headless_shell.exe', 'chrome.exe'];
  if (process.platform === 'darwin') return ['chrome-headless-shell', 'headless_shell', 'Google Chrome for Testing', 'chrome'];
  return ['chrome-headless-shell', 'headless_shell', 'chrome'];
}

function findExecutable(root, depth = 0) {
  if (!root || depth > 7 || !fs.existsSync(root)) return null;
  let stat;
  try { stat = fs.statSync(root); } catch (_) { return null; }
  if (stat.isFile() && executableNames().includes(path.basename(root))) return root;
  if (!stat.isDirectory()) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return null; }
  for (const name of executableNames()) {
    const direct = path.join(root, name);
    if (fs.existsSync(direct)) return direct;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const found = findExecutable(path.join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function remotionCacheRoot() {
  return path.join(desktopRoot, 'node_modules', '.remotion', 'chrome-headless-shell');
}

function remotionCachePlatform(targetPlatformKey) {
  return {
    'darwin-arm64': 'mac-arm64',
    'darwin-x64': 'mac-x64',
    'win32-x64': 'win64',
    'linux-x64': 'linux64',
    'linux-arm64': 'linux-arm64',
  }[targetPlatformKey] || null;
}

function sourceEnvName(targetPlatformKey) {
  return `REMOTION_BROWSER_SOURCE_${targetPlatformKey.replace(/-/g, '_').toUpperCase()}`;
}

function explicitSourceRoot(explicitPath, executable) {
  let cursor = path.dirname(executable);
  if (process.platform === 'darwin') {
    while (cursor !== path.dirname(cursor)) {
      if (path.basename(cursor).endsWith('.app')) return cursor;
      cursor = path.dirname(cursor);
    }
  }
  try { if (fs.statSync(explicitPath).isDirectory()) return explicitPath; } catch (_) {}
  return path.dirname(executable);
}

function resolveSource(targetPlatformKey) {
  const archSpecific = process.env[sourceEnvName(targetPlatformKey)];
  const generic = targetPlatformKey === currentPlatformKey
    ? (process.env.REMOTION_BROWSER_SOURCE || process.env.REMOTION_BROWSER_EXECUTABLE)
    : null;
  const explicit = archSpecific || generic;
  if (explicit) {
    const explicitPath = path.resolve(explicit);
    const executable = findExecutable(explicitPath);
    if (!executable) throw new Error(`未找到 ${sourceEnvName(targetPlatformKey)} / REMOTION_BROWSER_SOURCE: ${explicit}`);
    return { executable, root: explicitSourceRoot(explicitPath, executable), source: 'environment' };
  }
  const cachePlatform = remotionCachePlatform(targetPlatformKey);
  if (!cachePlatform) return null;
  const cache = path.join(remotionCacheRoot(), cachePlatform);
  const executable = findExecutable(cache);
  if (!executable) return null;
  // Copy the platform folder (rather than only the executable) so helper
  // libraries shipped beside Headless Shell remain available after packaging.
  let root = path.dirname(executable);
  while (root !== cache && path.dirname(root) !== cache) root = path.dirname(root);
  return { executable, root, source: 'remotion-cache' };
}

function targetPlatformKeys() {
  // The mac builder emits separate x64 and arm64 DMGs. Stage both whenever
  // their caches or explicit sources are available; the matching app will
  // select its own directory at runtime.
  return process.platform === 'darwin' ? ['darwin-arm64', 'darwin-x64'] : [currentPlatformKey];
}

function stageBrowser(targetPlatformKey, resolved) {
  const target = path.join(browserRoot, targetPlatformKey);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(resolved.root, target, { recursive: true });
  const copiedExecutable = path.join(target, path.relative(resolved.root, resolved.executable));
  if (process.platform !== 'win32') {
    try { fs.chmodSync(copiedExecutable, 0o755); } catch (_) {}
  }
  fs.writeFileSync(path.join(browserRoot, `${targetPlatformKey}.json`), JSON.stringify({
    platform: targetPlatformKey,
    source: resolved.source,
    executable: path.relative(runtimeRoot, copiedExecutable).replace(/\\/g, '/'),
    prepared_at: new Date().toISOString(),
  }, null, 2) + '\n');
  console.log(`[remotion-runtime] staged ${targetPlatformKey} browser: ${copiedExecutable}`);
}

async function maybeDownload() {
  if (process.env.REMOTION_DOWNLOAD_BROWSER !== '1') return;
  const renderer = require('@remotion/renderer');
  await renderer.ensureBrowser({ chromeMode: 'headless-shell', logLevel: 'warn' });
}

async function main() {
  // Remotion's browser cache is resolved relative to the nearest package.json;
  // normalize it so invoking this script from the repository root and from
  // desktop/ produces the same staging layout.
  process.chdir(desktopRoot);
  fs.mkdirSync(browserRoot, { recursive: true });
  await maybeDownload();
  const missing = [];
  for (const targetPlatformKey of targetPlatformKeys()) {
    const resolved = resolveSource(targetPlatformKey);
    if (resolved) stageBrowser(targetPlatformKey, resolved);
    else {
      missing.push(targetPlatformKey);
      console.warn(`[remotion-runtime] ${targetPlatformKey} Chrome Headless Shell 未找到；该架构 doctor.offline_ready=false。`);
      console.warn(`[remotion-runtime] 设置 ${sourceEnvName(targetPlatformKey)}，当前架构也可使用 REMOTION_DOWNLOAD_BROWSER=1。`);
    }
  }
  if (missing.length && process.env.REMOTION_REQUIRE_OFFLINE_RUNTIME === '1') {
    throw new Error(`正式离线包缺少浏览器架构: ${missing.join(', ')}`);
  }
}

main().catch((error) => {
  console.error(`[remotion-runtime] ${error.message}`);
  process.exitCode = 1;
});
