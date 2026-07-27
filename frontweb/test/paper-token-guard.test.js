// U1 字号守门测试（方案 11.2 / 11.6）：
// paper-studio 相关组件禁止出现 <11px 的字号字面量；
// 违反即失败，防止"蚂蚁字"回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const targets = [
  join(root, 'views', 'PaperStudio.vue'),
  ...readdirSync(join(root, 'components', 'paper-studio'))
    .filter((name) => name.endsWith('.vue'))
    .map((name) => join(root, 'components', 'paper-studio', name)),
]

const MIN_PX = 11

function violations(source) {
  const found = []
  // font-size: 8px  以及 font: 700 8px/1.4 ... 两种写法都拦截
  const patterns = [
    /font-size:\s*([0-9.]+)px/g,
    /font:\s*[^;{}]*?([0-9.]+)px/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const size = Number(match[1])
      if (Number.isFinite(size) && size < MIN_PX) found.push(match[0].trim())
    }
  }
  return found
}

test('paper-studio 组件无 <11px 字号字面量', () => {
  const report = []
  for (const file of targets) {
    const bad = violations(readFileSync(file, 'utf8'))
    if (bad.length) report.push(`${file}: ${bad.join(' | ')}`)
  }
  assert.equal(report.length, 0, `发现过小字号，请改用 paper-tokens.css 字阶变量：\n${report.join('\n')}`)
})

test('paper-tokens.css 存在且定义了完整字阶', () => {
  const css = readFileSync(join(root, 'styles', 'paper-tokens.css'), 'utf8')
  for (const token of ['--paper-fs-xs', '--paper-fs-sm', '--paper-fs-base', '--paper-fs-lg', '--paper-fs-xl', '--paper-fs-display', '--paper-hit-min']) {
    assert.ok(css.includes(token), `缺少令牌 ${token}`)
  }
})
