/**
 * 解码与标定的自检：拿本机真会话跑一遍，验证三个数说得通。
 * node test/decode.mjs
 */

import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSession, formatTokens } from '../lib/decode.mjs';
import {
  DEFAULT_K,
  MIN_SAMPLES,
  estimate,
  kLevel,
  listSessionFiles,
  localK,
  resolveK,
} from '../lib/estimate.mjs';

// 0. 样本量门槛：少于 MIN_SAMPLES 不采用；3/5/10 分档
{
  assert.equal(MIN_SAMPLES, 3);
  assert.equal(kLevel(0), '不足');
  assert.equal(kLevel(2), '不足');
  assert.equal(kLevel(3), '初步');
  assert.equal(kLevel(5), '可用');
  assert.equal(kLevel(10), '较稳');

  const dir = mkdtempSync(join(tmpdir(), 'ctx-debt-'));
  const weakFile = join(dir, 'weak.json');
  const okFile = join(dir, 'ok.json');
  writeFileSync(weakFile, JSON.stringify({ k: 0.4, samples: 2 }), 'utf8');
  writeFileSync(okFile, JSON.stringify({ k: 0.4, samples: 4, range: [0.3, 0.5] }), 'utf8');

  const weak = resolveK(undefined, weakFile);
  assert.equal(weak.k, DEFAULT_K, `样本不足时应回退出厂值，实际 ${weak.k}`);
  assert.ok(weak.source.includes(String(MIN_SAMPLES)), `来源里应写清门槛：${weak.source}`);

  const ok = resolveK(undefined, okFile);
  assert.equal(ok.k, 0.4);
  assert.equal(ok.level, '初步');

  rmSync(dir, { recursive: true, force: true });
  console.log(`样本量门槛 ok：<${MIN_SAMPLES} 回退出厂 ${DEFAULT_K}，4 个样本采用并标「初步」`);
}

// 1. k 的优先级：配置 > 本地 > 出厂
{
  const fromConfig = resolveK(0.5);
  assert.equal(fromConfig.k, 0.5);
  assert.equal(fromConfig.source, 'config');

  const fromDefault = resolveK(undefined);
  assert.ok(fromDefault.k > 0.1 && fromDefault.k < 3, `k 应在合理区间：${fromDefault.k}`);
  console.log(`当前生效 k = ${fromDefault.k.toFixed(3)}（${fromDefault.source}）`);
}

// 2. 估算与档位
{
  const e = estimate({ bytes: 8 * 1024 * 1024, k: DEFAULT_K });
  assert.ok(e.percent > 400 && e.band === 'danger', `8MB 应判危险：${e.percent}`);
  assert.ok(formatTokens(1234) === '1.2K');
  assert.ok(formatTokens(2_500_000) === '2.50M');
}

// 3. 真会话解码：原始 ≈ 字节 × k 的量级，压缩后不超过原始
{
  const sessions = listSessionFiles()
    .filter((s) => s.bytes > 512 * 1024)
    .sort((a, b) => b.bytes - a.bytes);
  if (sessions.length === 0) {
    console.log('跳过解码用例：本机没有够大的会话日志');
  } else {
    const d = decodeSession(sessions[0].file);
    assert.ok(d.originalTokens > 10_000, `原始 token 太少：${d.originalTokens}`);
    assert.ok(d.bytes > 0);
    const kThis = d.originalTokens / d.bytes;
    assert.ok(kThis > 0.2 && kThis < 2, `单会话 k 偏离太远：${kThis.toFixed(3)}`);
    if (d.sentTokens !== null) {
      assert.ok(d.sentTokens > 0);
      assert.ok(d.ratio > 1, `压缩倍率应大于 1：${d.ratio}`);
      console.log(`样本 ${sessions[0].id}: 原始 ${formatTokens(d.originalTokens)} / 压缩后 ${formatTokens(d.sentTokens)} = ${d.ratio.toFixed(1)}×`);
    } else {
      console.log(`样本 ${sessions[0].id}: 原始 ${formatTokens(d.originalTokens)}，日志里没有上游 usage（-）`);
    }
  }
}

console.log('ok — k 优先级 / 估算 / 真会话解码 三组用例通过');
