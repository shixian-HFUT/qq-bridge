import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildStickerContext, buildStickerStrategyHint } from '../src/sticker-lib.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('sticker summaries carry directly usable IDs and preserve the untrusted-data boundary', () => {
  const text = buildStickerContext([{ id: 'fixture-happy', desc: '开心', url: 'https://private.invalid/image', tags: ['庆祝'] }]);
  assert.match(text, /stickerId="fixture-happy"/);
  assert.match(text, /开心/);
  assert.match(text, /只是表情的标签资料/);
  assert(!text.includes('https://private.invalid'));
  const strange = buildStickerContext([{ id: 'https://private.invalid/ref', desc: 'fallback-label' }]);
  assert(!strange.includes('https://private.invalid'));
});

test('ordinary wakes keep an actionable expression reminder and respect the existing off switches', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    for (const reason of ['continuation', 'atMention', 'nameMention']) {
      const prompt = h.buildWakePromptV2('group:456', reason);
      assert.match(prompt, /【表情习惯】/);
      assert.match(prompt, /同一批调用/);
      assert.match(prompt, /2~4轮/);
    }
    h.cfg.socialV2.sticker = { ...h.cfg.socialV2.sticker, enabled: false };
    assert.doesNotMatch(h.buildWakePromptV2('group:456', 'continuation'), /【表情习惯】/);
    h.cfg.socialV2.sticker = { enabled: true, includeInPrompt: false };
    assert.doesNotMatch(h.buildWakePromptV2('group:456', 'continuation'), /【表情习惯】/);
  } finally { await h.close(); }
});

test('sticker instructions allow brief sticker-only replies and same-batch text plus sticker', () => {
  const hint = buildStickerStrategyHint();
  assert.match(hint, /同一批工具调用/);
  assert.match(hint, /只回一张/);
  assert.match(hint, /emoji/);
  assert.match(hint, /严肃/);
  assert.match(hint, /不能在同一气泡里附带文字/);
});

test('the updated role stays inside the actual injection limit and removes the conflicting pure-text rule', () => {
  const role = fs.readFileSync(fileURLToPath(new URL('../roles/阿米娅.md', import.meta.url)), 'utf8');
  assert(role.length <= 7500);
  assert.match(role, /自然用表情/);
  assert.doesNotMatch(role, /绝大多数时候纯文字/);
  assert.match(role, /只按真实 userId 认人/);
  assert.match(role, /同一批调用/);
});
