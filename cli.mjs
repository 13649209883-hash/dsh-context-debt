#!/usr/bin/env node
/**
 * 命令行版上下文债务表。和插件用同一套估算，不需要 DSH 在跑。
 *
 *   node cli.mjs                 # 最近改动的会话
 *   node cli.mjs --all           # 全部会话，按债务降序
 *   node cli.mjs --top 10        # 最近 7 天里债务最高的 10 个
 *   node cli.mjs --kw <id>       # 指定会话 id 片段
 *   node cli.mjs --json          # 机器可读
 *
 * 退出码：0 正常；1 有会话越过 warn 阈值。
 */

import {
  DEFAULT_K,
  DEFAULT_WINDOW,
  estimate,
  formatLine,
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
const warn = Number(flag('warn', 200));
const danger = Number(flag('danger', 350));
const days = Number(flag('days', 7));

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
  .map((r) => ({ ...r, est: estimate({ bytes: r.bytes, k, window }) }))
  .sort((a, b) => b.est.percent - a.est.percent);

if (has('top')) result.splice(Number(flag('top', 10)));

if (has('json')) {
  console.log(JSON.stringify(result.map((r) => ({
    id: r.id,
    file: r.file,
    bytes: r.bytes,
    tokens: Math.round(r.est.tokens),
    percent: Number(r.est.percent.toFixed(1)),
    band: r.est.band,
    mtime: new Date(r.mtime).toISOString(),
  })), null, 2));
} else if (result.length === 0) {
  console.log('没有匹配的会话日志。');
} else {
  for (const r of result) console.log(formatLine(r.id, r.est));
}

const worst = result[0];
const exceed = result.some((r) => r.est.percent >= warn);
if (!has('json') && worst && worst.est.percent >= danger) {
  console.log('提示：最上面的会话已越过危险线 —— 长任务请换新会话，把结论带过去比继续硬聊稳。');
}
process.exitCode = exceed ? 1 : 0;
