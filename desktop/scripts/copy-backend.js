const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const src = path.join(repoRoot, 'backend-node');
const dest = path.join(__dirname, '..', 'backend-app');

const dirsToCopy = ['src', 'configs', 'scripts', 'migrations'];

if (!fs.existsSync(src)) {
  console.error('backend-node not found at', src);
  process.exit(1);
}

if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
fs.mkdirSync(dest, { recursive: true });

for (const dir of dirsToCopy) {
  const from = path.join(src, dir);
  const to = path.join(dest, dir);
  if (fs.existsSync(from)) {
    fs.cpSync(from, to, { recursive: true });
  }
}

// Fail early when a packaging copy accidentally omits the Remotion entrypoint
// or its public media. These files are loaded from backend-app at runtime and
// must be present even though the npm modules themselves live in desktop/
// node_modules.
const requiredRemotionFiles = [
  path.join(dest, 'scripts', 'render-paper-storyboard.mjs'),
  path.join(dest, 'src', 'paper-renderer', 'entry.jsx'),
  path.join(dest, 'src', 'paper-renderer', 'public'),
];
const missingRemotionFiles = requiredRemotionFiles.filter((file) => !fs.existsSync(file));
if (missingRemotionFiles.length) {
  console.error('Remotion renderer files missing after backend copy:', missingRemotionFiles);
  process.exit(1);
}
fs.writeFileSync(path.join(dest, 'remotion-runtime.json'), `${JSON.stringify({
  renderer: 'remotion',
  renderer_version: '4.0.491',
  entrypoint: 'scripts/render-paper-storyboard.mjs',
  public_dir: 'src/paper-renderer/public',
  generated_at: new Date().toISOString(),
}, null, 2)}\n`);

// 合并 desktop 自带的初始迁移（保证 01_init、02_add_default_model 等存在）
const migrationsDest = path.join(dest, 'migrations');
const initialMigrations = path.join(__dirname, 'initial-migrations');
if (!fs.existsSync(migrationsDest)) fs.mkdirSync(migrationsDest, { recursive: true });
if (fs.existsSync(initialMigrations)) {
  for (const f of fs.readdirSync(initialMigrations)) {
    if (f.endsWith('.sql')) {
      fs.copyFileSync(path.join(initialMigrations, f), path.join(migrationsDest, f));
    }
  }
  console.log('Merged initial-migrations -> desktop/backend-app/migrations');
}

console.log('Copied backend-node (src, configs, scripts, migrations) -> desktop/backend-app');
