const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.join(__dirname, '..', '..');
const SOURCE_ROOTS = [
  path.join(REPOSITORY_ROOT, 'backend-node', 'src'),
  path.join(REPOSITORY_ROOT, 'frontweb', 'src'),
];
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.json', '.mjs', '.vue']);
const THEME_LEAK = /秦军|楚军|赵军|巨鹿|定陶|黄河|邯郸|粮车|粮袋|寒雾|王离|章邯|围城|破釜|沉船/;

function sourceFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [absolute] : [];
  });
}

test('paper studio production sources contain no fixture-specific theme vocabulary', () => {
  const leaks = SOURCE_ROOTS.flatMap(sourceFiles).flatMap((file) => {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return lines.flatMap((line, index) => THEME_LEAK.test(line)
      ? [{ file: path.relative(REPOSITORY_ROOT, file), line: index + 1, text: line.trim() }]
      : []);
  });
  assert.deepEqual(leaks, []);
});
