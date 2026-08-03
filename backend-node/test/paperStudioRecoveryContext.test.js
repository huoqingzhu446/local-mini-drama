const test = require('node:test');
const assert = require('node:assert/strict');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const { PaperStudioError } = require('../src/services/paper-studio/paperStudioUtils');

test('transition gate failures retain report details and identify the storyboard to repair', () => {
  const error = new PaperStudioError(
    'PAPER_STUDIO_TRANSITION_GATE_FAILED',
    '场景或主体切换过于突兀',
    { failures: [{ key: 'event_density', message: '主要事件过密' }] },
    422,
  );
  const enriched = analyzerService.withTransitionRecoveryContext(
    error,
    { id: 31, paper_storyboard_id: 17, shot_index: 2 },
    { storyboard: { id: 17, title: '城门转场' } },
  );

  assert.equal(enriched, error);
  assert.equal(enriched.details.failures[0].key, 'event_density');
  assert.deepEqual(enriched.details.recovery_context, {
    shot_id: 31,
    paper_storyboard_id: 17,
    shot_number: 3,
    title: '城门转场',
  });
});

test('unrelated errors are not rewritten as continuity recovery errors', () => {
  const error = new PaperStudioError('OTHER_ERROR', '其它错误', { source: 'test' }, 422);
  const result = analyzerService.withTransitionRecoveryContext(error, { id: 2 }, {});
  assert.equal(result, error);
  assert.deepEqual(result.details, { source: 'test' });
});
