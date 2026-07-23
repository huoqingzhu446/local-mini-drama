const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isGptImageModel,
  normalizeGptImageSize,
  normalizeGptImageQuality,
  mergeGptImageNegativePrompt,
} = require('../src/services/imageClient');

describe('GPT Image 请求参数归一化', () => {
  it('识别 GPT Image 模型且不误判其他图片模型', () => {
    assert.equal(isGptImageModel('gpt-image-2'), true);
    assert.equal(isGptImageModel('GPT-IMAGE-1.5'), true);
    assert.equal(isGptImageModel('agnes-image-2.1-flash'), false);
  });

  it('将项目尺寸映射到 GPT Image 支持的横竖方枚举', () => {
    assert.equal(normalizeGptImageSize('1792x1024'), '1536x1024');
    assert.equal(normalizeGptImageSize('1440*2560'), '1024x1536');
    assert.equal(normalizeGptImageSize('1920x1920'), '1024x1024');
    assert.equal(normalizeGptImageSize('16:9'), '1536x1024');
    assert.equal(normalizeGptImageSize('1536x1024'), '1536x1024');
  });

  it('将 DALL·E 画质枚举映射到 GPT Image 枚举', () => {
    assert.equal(normalizeGptImageQuality('hd'), 'high');
    assert.equal(normalizeGptImageQuality('standard'), 'medium');
    assert.equal(normalizeGptImageQuality('auto'), 'auto');
    assert.equal(normalizeGptImageQuality('unknown'), '');
  });

  it('保留正向提示词并将负向约束合并到末尾', () => {
    assert.equal(
      mergeGptImageNegativePrompt('原始提示词', '不要文字，不要水印'),
      '原始提示词\n\nAvoid the following: 不要文字，不要水印'
    );
    assert.equal(mergeGptImageNegativePrompt('原始提示词', ''), '原始提示词');
  });
});
