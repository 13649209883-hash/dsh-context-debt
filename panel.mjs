#!/usr/bin/env node
/**
 * 上下文面板：一张表看清所有会话压到哪一档了。
 *
 *   node panel.mjs                # 快照（前 12 个，按债务降序）
 *   node panel.mjs --all          # 全部会话
 *   node panel.mjs --watch 5      # 每 5 秒刷新一次（终端里）
 *   node panel.mjs --serve        # 起一个网页看板 http://127.0.0.1:7788/
 *   node panel.mjs --serve 7799   # 换端口
 *   node panel.mjs --window 200000
 *   node panel.mjs --fast         # 不解码，只给估算（更快，但少了「压缩后/倍率」）
 *
 * 默认会解码每个会话，拿到「原始 token / 压缩后 token / 倍率」三个实测量；
 * 解码结果按「文件 + 修改时间 + 大小」缓存，--watch 时不会重复解。
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
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

function gather() {
  return listSessionFiles()
    .map((r) => {
      const real = measured(r);
      const est = real
        ? estimateFromTokens({ tokens: real.originalTokens, window, bytes: r.bytes })
        : estimate({ bytes: r.bytes, k, window });
      return { ...r, est, real };
    })
    .sort((a, b) => b.est.percent - a.est.percent)
    .slice(0, limit);
}

function snapshot() {
  const rows = gather();

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

// ---------------------------------------------------------------- --serve

function payload() {
  const rows = gather();
  return {
    generatedAt: Date.now(),
    window,
    k: Number(k.toFixed(4)),
    kSource: resolved.source,
    rows: rows.map((r) => ({
      id: alias(r.id),
      bytes: r.bytes,
      mtime: r.mtime,
      original: r.real ? r.real.originalTokens : r.est.tokens,
      sent: r.real ? r.real.sentTokens : null,
      ratio: r.real?.ratio ?? null,
      percent: Number(r.est.percent.toFixed(1)),
      band: r.est.band,
      bandLabel: BAND_LABEL[r.est.band],
    })),
  };
}

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>上下文债务表</title>
<style>
 :root{color-scheme:light dark}
 body{font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei",sans-serif;margin:24px;max-width:900px}
 h1{font-size:16px;margin:0 0 4px} .sub{opacity:.65;font-size:12px;margin-bottom:16px}
 table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
 th,td{text-align:right;padding:6px 8px;border-bottom:1px solid rgba(128,128,128,.25)}
 th:first-child,td:first-child{text-align:left}
 th{font-weight:600;font-size:12px;opacity:.7}
 .normal{color:#8a8a8a}.large{color:#b58900}.warn{color:#d2691e}.danger{color:#d03030;font-weight:600}
 td.band{font-weight:600}
 .worst{margin-top:14px;font-size:12px;opacity:.7}
</style>
<h1>上下文债务表</h1>
<div class="sub" id="sub">加载中…</div>
<table><thead><tr>
 <th>会话</th><th>日志</th><th>原始</th><th>压缩后</th><th>倍率</th><th>占窗口</th><th>档位</th><th>最后改动</th>
</tr></thead><tbody id="rows"></tbody></table>
<div class="worst" id="worst"></div>
<script>
const fmt=(n)=>n==null?'—':n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(Math.round(n));
const ago=(ms)=>{const s=Math.max(0,Math.round((Date.now()-ms)/1000));
 if(s<90)return s+' 秒前'; if(s<5400)return Math.round(s/60)+' 分钟前';
 if(s<129600)return Math.round(s/3600)+' 小时前'; return Math.round(s/86400)+' 天前';};
async function tick(){
 try{
  const r=await fetch('/api.json',{cache:'no-store'}); const d=await r.json();
  document.getElementById('sub').textContent=
    d.rows.length+' 个会话 · 窗口 '+(d.window/1048576).toFixed(0)+'M · k='+d.k.toFixed(3)+'（'+d.kSource+'）· 更新于 '+new Date(d.generatedAt).toLocaleTimeString();
  document.getElementById('rows').innerHTML=d.rows.map(x=>'<tr>'+
   '<td>'+x.id+'</td><td>'+(x.bytes/1048576).toFixed(2)+'MB</td><td>'+fmt(x.original)+'</td>'+
   '<td>'+(x.sent==null?'—':fmt(x.sent))+'</td><td>'+(x.ratio?x.ratio.toFixed(1)+'×':'—')+'</td>'+
   '<td>'+(x.percent>=100?'':'')+x.percent.toFixed(0)+'%</td>'+
   '<td class="band '+x.band+'">'+x.bandLabel+'</td><td>'+ago(x.mtime)+'</td></tr>').join('');
  const w=d.rows[0];
  document.getElementById('worst').textContent=w?('最重 '+w.id+' '+w.percent.toFixed(0)+'% '+w.bandLabel):'没有找到会话日志。';
 }catch(e){ document.getElementById('sub').textContent='读取失败：'+e.message; }
}
tick(); setInterval(tick,5000);
</script></html>`;

function startServer(port) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api.json')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload()));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`上下文债务表面板：http://127.0.0.1:${port}/  （每 5 秒刷新，Ctrl+C 退出）`);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 被占用，换一个：node panel.mjs --serve 7799`);
      process.exit(1);
    }
    throw e;
  });
  return server;
}

if (has('serve')) {
  startServer(Number(flag('serve', 7788)));
} else if (watch > 0) {
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
