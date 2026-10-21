#!/usr/bin/env node
/**
 * 用本机会话日志反推 k，并（可选）写成本地标定文件。
 *
 *   node calibrate.mjs              # 看最近 8 个会话的实测 k，不写盘
 *   node calibrate.mjs --n 20       # 多看几个
 *   node calibrate.mjs --write      # 写 data/calibration.local.json，插件下次启动就用它
 *   node calibrate.mjs --show       # 只看当前生效的 k 和它的来源
 *
 * 原理：k = 原始 token（解码后按 4 字符≈1 token 估） ÷ 日志字节数。
 * 每个会话的 k 不完全一样（内容类型不同），取中位数比取平均更稳。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSession, formatTokens } from './lib/decode.mjs';
import {
  DEFAULT_K,
  LOCAL_K_FILE,
  estimate,
  listSessionFiles,
  localK,
  resolveK,
} from './lib/estimate.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes('--' + name);

const HERE = dirname(fileURLToPath(import.meta.url));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

if (has('show')) {
  const local = localK();
  const resolved = resolveK(undefined);
  console.log(`当前生效 k = ${resolved.k.toFixed(3)}（来源：${resolved.source}）`);
  console.log(`出厂值 ${DEFAULT_K}  ·  标定文件 ${local ? LOCAL_K_FILE : '（还没有，跑一次 --write 生成）'}`);
  if (local) console.log(`标定于 ${local.generatedAt ?? '未知时间'}，样本 ${local.samples ?? '?'} 个`);
  process.exit(0);
}

const days = Number(flag('days', 60));
const want = Number(flag('n', 8));
const since = Date.now() - days * 86400_000;

const candidates = listSessionFiles()
  .filter((r) => r.mtime >= since && r.bytes > 64 * 1024)
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, want);

if (candidates.length === 0) {
  console.log('最近没有足够大的会话日志，无法标定。');
  process.exit(1);
}

const rows = [];
for (const c of candidates) {
  try {
    const d = decodeSession(c.file);
    if (d.originalTokens < 2000) continue;
    rows.push({ ...d, id: c.id, k: d.originalTokens / d.bytes });
  } catch (error) {
    console.error(`跳过 ${c.id}：${error.message}`);
  }
}

if (rows.length === 0) {
  console.log('解出来的会话都太小，无法标定。');
  process.exit(1);
}

rows.sort((a, b) => b.originalTokens - a.originalTokens);

// 掉队样本：k 明显偏低的通常是图多/二进制多的会话，会把中位数带偏，单列出来不算。
const MIN_K = 0.25;
const kept = rows.filter((r) => r.k >= MIN_K);
const dropped = rows.filter((r) => r.k < MIN_K);
if (kept.length === 0) {
  console.log('所有样本的 k 都低于 0.25，可能是这批会话以图片/二进制内容为主，无法标定。');
  process.exit(1);
}
const ks = kept.map((r) => r.k);
const k = median(ks);
const lo = Math.min(...ks);
const hi = Math.max(...ks);

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('会话', 10) + pad('日志', 9) + pad('原始', 9) + pad('压缩后', 9) + pad('倍率', 7) + 'k');
console.log('-'.repeat(52));
for (const r of rows) {
  const mark = r.k < MIN_K ? '  ← 偏图文，不计入' : '';
  console.log(
    pad(r.id, 10) +
    pad((r.bytes / 1048576).toFixed(2) + 'MB', 9) +
    pad(formatTokens(r.originalTokens), 9) +
    pad(formatTokens(r.sentTokens), 9) +
    pad(r.ratio === null ? '-' : r.ratio.toFixed(1) + '×', 7) +
    r.k.toFixed(3) +
    mark,
  );
}
console.log('');
console.log(`样本 ${kept.length} 个计入 · k 中位数 ${k.toFixed(3)} · 区间 ${lo.toFixed(3)} ~ ${hi.toFixed(3)}` +
  (dropped.length ? ` · 另有 ${dropped.length} 个偏图文样本未计入` : ''));

const preview = estimate({ bytes: 8 * 1024 * 1024, k, window: 1048576 });
console.log(`按这个 k，8MB 的会话 ≈ ${formatTokens(preview.tokens)} tokens（${preview.percent.toFixed(0)}% 窗口，${preview.band}）`);

if (has('write')) {
  mkdirSync(dirname(LOCAL_K_FILE), { recursive: true });
  const payload = {
    k: Number(k.toFixed(4)),
    samples: kept.length,
    dropped: dropped.length,
    range: [Number(lo.toFixed(4)), Number(hi.toFixed(4))],
    generatedAt: new Date().toISOString(),
    note: '由 node calibrate.mjs --write 生成；删掉本文件即回到出厂值。',
  };
  writeFileSync(LOCAL_K_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`已写入 ${LOCAL_K_FILE}（插件下次启动生效）`);
} else {
  console.log('没写盘。确认数值合理后加 --write 应用。');
}
