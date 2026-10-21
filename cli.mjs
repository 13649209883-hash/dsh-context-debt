#!/usr/bin/env node
/**
 * 命令行版上下文债务表。和插件同一套估算，不需要 DSH 在跑。
 *
 *   node cli.mjs                 # 最近改动的会话
 *   node cli.mjs --all           # 全部会话，按债务降序
 *   node cli.mjs --top 10        # 最近 7 天里债务最高的 10 个
 *   node cli.mjs --kw <id>       # 指定会话 id 片段
 *   node cli.mjs --json          # 机器可读
 *   node cli.mjs --fast          # 不解码（不给压缩后/倍率，快很多）
 *
 * 默认会解码，输出三个数：原始 token / 压缩后 token / 倍率。
 * 退出码：0 正常；1 有会话越过 warn 阈值。
 */

import { createHash } from 'node:crypto';
import { decodeSession, formatTokens } from './lib/decode.mjs';
import {
  BAND_LABEL,
  DEFAULT_WINDOW,
  estimate,
  estimateFromTokens,
  listSessionFiles,
  resolveK,
} from './lib/estimate.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes('--' + name);

const window = Number(flag('window', DEFAULT_WINDOW));
const resolved = resolveK(has('k') ? Number(flag('k')) : undefined);
const k = resolved.k;
const warn = Number(flag('warn', 200));
const danger = Number(flag('danger', 350));
const days = Number(flag('days', 7));
const fast = has('fast');
/** --anon：不打印真实会话 id（换成稳定别名）。 */
const anon = has('anon');
const alias = (() => {
  const cache = new Map();
  return (id) => {
    if (!anon) return id;
    if (!cache.has(id)) cache.set(id, 's' + createHash('sha1').update(id).digest('hex').slice(0, 7));
    return cache.get(id);
  };
})();

let rows = listSessionFiles();

if (has('kw')) {
  const kw = String(flag('kw')).toLowerCase();
  rows = rows.filter((r) => r.file.toLowerCase().includes(kw));
}
if (has('top')) {
  const since = Date.now() - days * 86400_000;
  rows = rows.filter((r) => r.mtime >= since);
}
if (!has('all') && !has('top') && !has('kw')) {
  rows.sort((a, b) => b.mtime - a.mtime);
  rows = rows.slice(0, 1);
}

const result = rows
  .map((r) => {
    let real = null;
    if (!fast) {
      try { real = decodeSession(r.file); } catch { real = null; }
    }
    const est = real
      ? estimateFromTokens({ tokens: real.originalTokens, window, bytes: r.bytes })
      : estimate({ bytes: r.bytes, k, window });
    return { ...r, est, real };
  })
  .sort((a, b) => b.est.percent - a.est.percent);

if (has('top')) result.splice(Number(flag('top', 10)));

if (has('json')) {
  console.log(JSON.stringify(result.map((r) => ({
    id: alias(r.id),
    file: r.file,
    bytes: r.bytes,
    tokens: Math.round(r.est.tokens),
    percent: Number(r.est.percent.toFixed(1)),
    band: r.est.band,
    originalTokens: r.real?.originalTokens ?? null,
    sentTokens: r.real?.sentTokens ?? null,
    ratio: r.real?.ratio ? Number(r.real.ratio.toFixed(2)) : null,
    mtime: new Date(r.mtime).toISOString(),
  })), null, 2));
} else if (result.length === 0) {
  console.log('没有匹配的会话日志。');
} else {
  for (const r of result) {
    const parts = [`[context-debt] ${alias(r.id)}`, `日志 ${(r.bytes / 1048576).toFixed(2)}MB`];
    if (fast) {
      parts.push(`堆积≈${formatTokens(r.est.tokens)}`);
    } else {
      parts.push(`原始 ${formatTokens(r.real?.originalTokens ?? r.est.tokens)}`);
      parts.push(`压缩后 ${formatTokens(r.real?.sentTokens)}`);
      parts.push(r.real?.ratio ? r.real.ratio.toFixed(1) + '×' : '倍率 -');
    }
    parts.push(`${r.est.percent.toFixed(0)}% ${BAND_LABEL[r.est.band]}`);
    console.log(parts.join('  '));
  }
}

const worst = result[0];
const exceed = result.some((r) => r.est.percent >= warn);
if (!has('json') && worst && worst.est.percent >= danger) {
  console.log('提示：最上面的会话已越过危险线 —— 长任务请换新会话，把结论带过去比继续硬聊稳。');
}
process.exitCode = exceed ? 1 : 0;
