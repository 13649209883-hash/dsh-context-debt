#!/usr/bin/env node
/**
 * 上下文面板：一张表看清所有会话压到哪一档了。
 *
 *   node panel.mjs                # 快照（前 12 个，按债务降序）
 *   node panel.mjs --all          # 全部会话
 *   node panel.mjs --watch 5      # 每 5 秒刷新一次
 *   node panel.mjs --window 200000
 *   node panel.mjs --fast         # 不解码，只给估算（更快，但少了「压缩后/倍率」）
 *
 * 默认会解码每个会话，拿到「原始 token / 压缩后 token / 倍率」三个实测量；
 * 解码结果按「文件 + 修改时间 + 大小」缓存，--watch 时不会重复解。
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
const watch = has('watch') ? Number(flag('watch', 5)) : 0;
const limit = has('all') ? Infinity : Number(flag('top', 12));
const fast = has('fast');
/** --anon：输出里不出现真实会话 id（换成稳定别名，仍然能对上同一个会话）。 */
const anon = has('anon');
const alias = (() => {
  const cache = new Map();
  return (id) => {
    if (!anon) return id;
    if (!cache.has(id)) {
      const hex = createHash('sha1').update(id).digest('hex');
      cache.set(id, 's' + hex.slice(0, 7));
    }
    return cache.get(id);
  };
})();

const COLOR = {
  normal: '\x1b[38;5;245m',
  large: '\x1b[38;5;220m',
  warn: '\x1b[38;5;208m',
  danger: '\x1b[38;5;196m',
};
const RESET = '\x1b[0m';

const fmtAgo = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return s + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  if (s < 129600) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
};
/** 中文按两列宽估算，保证表能对齐。 */
const width = (s) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** 解码缓存：key = 文件 + 修改时间 + 大小。 */
const cache = new Map();
function measured(row) {
  if (fast) return null;
  const key = `${row.file}:${row.mtime}:${row.bytes}`;
  if (cache.has(key)) return cache.get(key);
  let value = null;
  try { value = decodeSession(row.file); } catch { value = null; }
  cache.set(key, value);
  return value;
}

function snapshot() {
  const rows = listSessionFiles()
    .map((r) => {
      const real = measured(r);
      const est = real
        ? estimateFromTokens({ tokens: real.originalTokens, window, bytes: r.bytes })
        : estimate({ bytes: r.bytes, k, window });
      return { ...r, est, real };
    })
    .sort((a, b) => b.est.percent - a.est.percent)
    .slice(0, limit);

  const cols = [pad('会话', 10), pad('日志', 8), pad('原始', 7), pad('压缩后', 8), pad('倍率', 6), pad('占窗口', 7), pad('档位', 6), '最后改动'];
  const head = cols.join('  ');
  const lines = [head, '-'.repeat(width(strip(head)))];

  for (const r of rows) {
    const band = r.est.band;
    const paint = (s) => COLOR[band] + s + RESET;
    const original = r.real ? formatTokens(r.real.originalTokens) : formatTokens(r.est.tokens);
    const sent = r.real ? formatTokens(r.real.sentTokens) : (fast ? '—' : '-');
    const ratio = r.real?.ratio ? r.real.ratio.toFixed(1) + '×' : (fast ? '—' : '-');
    lines.push([
      pad(alias(r.id), 10),
      pad((r.bytes / 1048576).toFixed(2) + 'MB', 8),
      pad(original, 7),
      pad(sent, 8),
      pad(ratio, 6),
      pad(r.est.percent.toFixed(0) + '%', 7),
      pad(paint(BAND_LABEL[band]), 6),
      fmtAgo(r.mtime) + ' 前',
    ].join('  '));
  }

  const worst = rows[0];
  if (worst) {
    lines.push('', `${rows.length} 个会话 · 最重 ${alias(worst.id)} ${worst.est.percent.toFixed(0)}% ${BAND_LABEL[worst.est.band]} · k=${k.toFixed(3)}（${resolved.source}）`);
    lines.push('原始 = 会话累计写入；压缩后 = 最近一次实际发出；倍率 = 原始 ÷ 压缩后');
  } else {
    lines.push('没有找到会话日志。');
  }
  return lines.join('\n');
}

if (watch > 0) {
  const tick = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(snapshot() + '\n');
    process.stdout.write(`\n每 ${watch}s 刷新 · Ctrl+C 退出\n`);
  };
  tick();
  setInterval(tick, watch * 1000);
} else {
  console.log(snapshot());
}
