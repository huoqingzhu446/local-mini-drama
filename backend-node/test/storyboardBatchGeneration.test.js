const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeStoryboardBatchItems,
  createStoryboardBatchContext,
  buildStoryboardBatchPrompt,
  buildStoryboardBatchSystemSuffix,
} = require('../src/services/episodeStoryboardService');

function boards(from, to) {
  return Array.from({ length: to - from + 1 }, (_, index) => {
    const number = from + index;
    return {
      id: number,
      storyboard_number: number,
      title: `镜头${number}`,
      action: `动作${number}`,
      result: `结果${number}`,
      location: '城门',
    };
  });
}

test('storyboard batch context starts with 1-5 and ignores old rows when replacing', () => {
  const context = createStoryboardBatchContext(boards(1, 3), 37, 5, 'replace');

  assert.equal(context.mode, 'replace');
  assert.equal(context.startShotNumber, 1);
  assert.equal(context.endShotNumber, 5);
  assert.equal(context.expectedCount, 5);
  assert.deepEqual(context.existingStoryboards, []);
});

test('storyboard batch context appends the next five without replacing existing rows', () => {
  const existing = boards(1, 5);
  const context = createStoryboardBatchContext(existing, 37, 5, 'append');

  assert.equal(context.mode, 'append');
  assert.equal(context.startShotNumber, 6);
  assert.equal(context.endShotNumber, 10);
  assert.equal(context.expectedCount, 5);
  assert.equal(context.existingStoryboards, existing);
});

test('storyboard batch context shortens only the final batch', () => {
  const context = createStoryboardBatchContext(boards(1, 10), 12, 5, 'append');

  assert.equal(context.startShotNumber, 11);
  assert.equal(context.endShotNumber, 12);
  assert.equal(context.expectedCount, 2);
});

test('storyboard batch context refuses to append after reaching the total target', () => {
  assert.throws(
    () => createStoryboardBatchContext(boards(1, 12), 12, 5, 'append'),
    /已达到总目标 12/
  );
});

test('batch items are capped and renumbered continuously for append safety', () => {
  const normalized = normalizeStoryboardBatchItems(
    [
      { shot_number: 1, title: 'A' },
      { shot_number: 99, title: 'B' },
      { title: 'C' },
    ],
    6,
    2
  );

  assert.deepEqual(normalized.map((item) => item.shot_number), [6, 7]);
  assert.deepEqual(normalized.map((item) => item.storyboard_number), [6, 7]);
  assert.deepEqual(normalized.map((item) => item.title), ['A', 'B']);
});

test('batch prompts distinguish the whole-episode target from the current response range', () => {
  const existing = boards(1, 5);
  const context = createStoryboardBatchContext(existing, 37, 5, 'append');
  const userPrompt = buildStoryboardBatchPrompt('原始剧本', existing, context);
  const systemSuffix = buildStoryboardBatchSystemSuffix(context);

  assert.match(userPrompt, /整集最终规划目标仍为约 37 个分镜/);
  assert.match(userPrompt, /本次仅生成第 6～10 镜，共 5 个分镜/);
  assert.match(userPrompt, /不得为了在本批讲完剧本而合并、跳过、概括后续剧情/);
  assert.match(userPrompt, /1\. \[\] 镜头1/);
  assert.match(systemSuffix, /当前响应只能输出第 6～10 镜，共 5 条/);
  assert.match(systemSuffix, /总分镜数量.*所有批次的最终合计/);
});
