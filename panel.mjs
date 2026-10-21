#!/usr/bin/env node
/**
 * 上下文面板：一张表看清所有会话压到哪一档了。
 *
 *   node panel.mjs                # 快照（前 12 个，按债务降序）
 *   node panel.mjs --all          # 全部会话
 *   node panel.mjs --watch 5      # 每 5 秒刷新一次
 *   node panel.mjs --window 200000
 *
 * 只读：不解码、不解析，全部来自一次目录遍历 + stat。
 */

import {
  BAND_LABEL,
  DEFAULT_K,
  DEFAULT_WINDOW,
  estimate,
  listSessionFiles,
} from './lib/estimate.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes('--' + name);

const window = Number(flag('window', DEFAULT_WINDOW));
const k = Number(flag('k', DEFAULT_K));
const watch = has('watch') ? Number(flag('watch', 5)) : 0;
const limit = has('all') ? Infinity : Number(flag('top', 12));

const COLOR = {
  normal: '\x1b[38;5;245m',
  large: '\x1b[38;5;220m',
  warn: '\x1b[38;5;208m',
  danger: '\x1b[38;5;196m',
};
const RESET = '\x1b[0m';

const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : (n / 1e3).toFixed(0) + 'K');
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

function snapshot() {
  const rows = listSessionFiles()
    .map((r) => ({ ...r, est: estimate({ bytes: r.bytes, k, window }) }))
    .sort((a, b) => b.est.percent - a.est.percent)
    .slice(0, limit);

  const head = [
    pad('会话', 10),
    pad('日志', 8),
    pad('堆积', 8),
    pad('占窗口', 8),
    pad('档位', 6),
    '最后改动',
  ].join('  ');
  const lines = [head, '-'.repeat(width(head) + 4)];

  for (const r of rows) {
    const band = r.est.band;
    const paint = (s) => COLOR[band] + s + RESET;
    lines.push([
      pad(r.id, 10),
      pad((r.bytes / 1048576).toFixed(2) + 'MB', 8),
      pad(fmtTok(r.est.tokens), 8),
      pad(r.est.percent.toFixed(0) + '%', 8),
      pad(paint(BAND_LABEL[band]), 6 + (COLOR[band].length + RESET.length)),
      fmtAgo(r.mtime) + ' 前',
    ].join('  '));
  }

  const worst = rows[0];
  if (worst) {
    lines.push('', `${rows.length} 个会话 · 最重 ${worst.id} ${worst.est.percent.toFixed(0)}% ${BAND_LABEL[worst.est.band]}`);
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
