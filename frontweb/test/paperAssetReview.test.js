import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canManuallyApprovePaperAsset,
  paperAssetHasReviewableAlpha,
  paperAssetNeedsAlpha,
  paperAssetReviewState,
} from '../src/utils/paperAssetReview.js'

test('paper asset review identifies transparent asset types', () => {
  assert.equal(paperAssetNeedsAlpha({ asset_type: 'prop_state' }), true)
  assert.equal(paperAssetNeedsAlpha({ asset_type: 'rig_part' }), true)
  assert.equal(paperAssetNeedsAlpha({ asset_type: 'background_plate' }), false)
})

test('paper asset review requires real alpha before manual approval', () => {
  const base = {
    id: 3,
    asset_type: 'prop_state',
    status: 'needs_review',
    matte_quality: 'pass',
    local_path: 'projects/boat.png',
    processing_json: { has_alpha: false },
  }
  assert.equal(paperAssetHasReviewableAlpha(base), false)
  assert.equal(canManuallyApprovePaperAsset(base), false)
  assert.equal(paperAssetReviewState(base).label, '需要抠图')

  const transparent = { ...base, processing_json: { has_alpha: true } }
  assert.equal(paperAssetHasReviewableAlpha(transparent), true)
  assert.equal(canManuallyApprovePaperAsset(transparent), true)
  assert.equal(paperAssetReviewState(transparent).label, '等待确认')
})

test('matte output can be manually approved after visual review', () => {
  const asset = {
    asset_type: 'prop_state',
    status: 'needs_review',
    matte_quality: 'warning',
    local_path: 'projects/boat.png',
    cutout_local_path: 'projects/paper/boat-cutout.png',
    processing_json: '{"has_alpha":true}',
  }
  assert.equal(canManuallyApprovePaperAsset(asset), true)
  assert.equal(paperAssetReviewState({ ...asset, status: 'ready' }).label, '审核通过')
})

test('near-zero transparency cannot be manually approved', () => {
  const asset = {
    asset_type: 'prop_state',
    status: 'needs_review',
    matte_quality: 'warning',
    local_path: 'projects/boat.png',
    cutout_local_path: 'projects/paper/boat-cutout.png',
    processing_json: { transparent_ratio: 0.000301, visible_ratio: 0.999699 },
  }
  assert.equal(paperAssetHasReviewableAlpha(asset), false)
  assert.equal(canManuallyApprovePaperAsset(asset), false)
  assert.equal(paperAssetReviewState(asset).label, '抠图失败')
  assert.equal(paperAssetReviewState({ ...asset, status: 'ready' }).label, '抠图失败')
})
