/**
 * 插件级自检：用假的 ctx 跑一遍 pre-step，覆盖三种报告节奏。
 * node test/plugin-dryrun.mjs
 */

import assert from 'node:assert';
import { apply } from '../index.js';
import { DEFAULT_WINDOW, estimate, listSessionFiles } from '../lib/estimate.mjs';

function fakeCtx(window = DEFAULT_WINDOW) {
  const handlers = new Map();
  return {
    handlers,
    on(event, fn) { handlers.set(event, fn); },
    sessionProjections: { stateOf: () => ({ contextWindow: window }) },
  };
}

const sessions = listSessionFiles().sort((a, b) => b.bytes - a.bytes);
const heavy = sessions.find((s) => estimate({ bytes: s.bytes }).percent >= 350);
const light = sessions.find((s) => estimate({ bytes: s.bytes }).percent < 100);
assert.ok(heavy, '需要一个高债务样本会话');
assert.ok(light, '需要一个低债务样本会话');

const next = async () => ({ messages: ['m-user'] });
const call = (ctx, id, step) =>
  ctx.handlers.get('agent/pre-step')({ agent: { session: { id } }, messages: [], step }, next);

// 1. 高债务 + 默认 session 节奏：第一轮给告警（跨档），同一轮第二步不重复
{
  const ctx = fakeCtx();
  apply(ctx, {});
  const first = await call(ctx, heavy.id, 1);
  const injected = first.messages[1];
  assert.equal(first.messages.length, 2, '高债务首轮应注入');
  assert.equal(injected.source.kind, 'context-debt');
  assert.ok(injected.content[0].text.includes('上下文债务'), '跨档应给告警而不是简报');
  console.log('告警文本:', injected.content[0].text);

  assert.equal((await call(ctx, heavy.id, 2)).messages.length, 1, 'step!=1 不注入');
  assert.equal((await call(ctx, heavy.id, 1)).messages.length, 1, '同档不重复提醒');
}

// 2. 低债务 + session 节奏：首轮给一行简报，之后静默
{
  const ctx = fakeCtx();
  apply(ctx, {});
  const first = await call(ctx, light.id, 1);
  assert.equal(first.messages.length, 2, 'session 节奏下首轮应报一次');
  assert.ok(first.messages[1].content[0].text.includes('【上下文】'), '应是简报格式');
  console.log('简报文本:', first.messages[1].content[0].text);
  assert.equal((await call(ctx, light.id, 1)).messages.length, 1, 'session 节奏只在本会话首轮报一次');
}

// 3. warn 节奏：低债务完全静默
{
  const ctx = fakeCtx();
  apply(ctx, { report: 'warn' });
  assert.equal((await call(ctx, light.id, 1)).messages.length, 1, 'warn 节奏低债务不应注入');
  assert.equal((await call(ctx, heavy.id, 1)).messages.length, 2, 'warn 节奏高债务仍告警');
}

// 4. always 节奏：每轮都有一行
{
  const ctx = fakeCtx();
  apply(ctx, { report: 'always' });
  for (let turn = 0; turn < 3; turn += 1) {
    const d = await call(ctx, light.id, 1);
    assert.equal(d.messages.length, 2, `always 第 ${turn + 1} 轮应报`);
    assert.ok(d.messages[1].content[0].text.startsWith('【上下文】'));
  }
}

// 5. 关掉开关：不注册监听
{
  const ctx = fakeCtx();
  apply(ctx, { enabled: false });
  assert.equal(ctx.handlers.has('agent/pre-step'), false, 'enabled=false 不应注册监听');
}

// 6. 未知会话：静默
{
  const ctx = fakeCtx();
  apply(ctx, {});
  assert.equal((await call(ctx, 'no-such-session', 1)).messages.length, 1, '找不到日志应静默');
}

console.log('ok — 告警/简报/去重/warn/always/开关/未知会话 七组用例通过');
