/**
 * 把会话日志解出来，拿三个数：
 *
 *   原始 token   会话里累计写进去的原文（message + tool 事件，按 4 字符≈1 token 估）
 *   压缩后 token 最近一次真正发出去的 prompt 规模（上游 usage 实报）
 *   压缩倍率     原始 ÷ 压缩后
 *
 * 只在命令行里用（calibrate / panel / cli）。插件本身的请求路径**不解码**，
 * 仍然是 stat，成本 O(1)。
 */

import { readFileSync, statSync } from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 一个文件里可能有多个 zstd 帧，逐帧解再拼起来。 */
export function decodeFrames(buf) {
  const offsets = [];
  let i = 0;
  for (;;) {
    const at = buf.indexOf(MAGIC, i);
    if (at < 0) break;
    offsets.push(at);
    i = at + 1;
  }
  const parts = [];
  for (let n = 0; n < offsets.length; n += 1) {
    const start = offsets[n];
    const end = n + 1 < offsets.length ? offsets[n + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end))); } catch { /* 坏帧跳过 */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

const textOf = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join(' ');
  if (value.content !== undefined) return textOf(value.content);
  if (value.text !== undefined) return String(value.text);
  return '';
};

/** token 一律以百万为单位：1M ≈ 一个窗口，原始和压缩后才能直接比。 */
const fmt = (n) => (n === null || n === undefined || Number.isNaN(n) ? '-' : (n / 1e6).toFixed(2) + 'M');

/**
 * @param {string} file  session.v4.jsonl.zstd 的路径
 * @returns {{file:string,bytes:number,mtime:number,turns:number,steps:number,toolEvents:number,
 *            originalTokens:number,sentTokens:number|null,window:number|null,ratio:number|null,model:string|null}}
 */
export function decodeSession(file) {
  const st = statSync(file);
  const text = decodeFrames(readFileSync(file));
  let turns = 0;
  let steps = 0;
  let toolEvents = 0;
  let accChars = 0;
  let sentTokens = null;
  let window = null;
  let model = null;

  for (const line of text.split('\n')) {
    if (!line) continue;
    const kind = /"type":"([^"]+)"/.exec(line)?.[1];
    if (!kind) continue;

    if (kind === 'turn/start') { turns += 1; continue; }
    if (kind === 'step/start') { steps += 1; continue; }
    if (kind.startsWith('tool/')) { toolEvents += 1; accChars += line.length; continue; }
    if (kind === 'user/message' || kind === 'assistant/message' || kind === 'system/message') {
      accChars += line.length;
      if (kind === 'assistant/message') {
        try {
          const usage = JSON.parse(line)?.data?.usage;
          if (typeof usage?.totalTokens === 'number') sentTokens = usage.totalTokens;
        } catch { /* 坏行跳过 */ }
      }
      continue;
    }
    if (kind === 'request/context') {
      try {
        const data = JSON.parse(line)?.data ?? {};
        if (typeof data.contextWindow === 'number') window = data.contextWindow;
        if (data.model) model = data.model;
      } catch { /* 坏行跳过 */ }
    }
  }

  const bytes = st.size;
  const originalTokens = Math.round(accChars / 4);
  return {
    file,
    bytes,
    mtime: st.mtimeMs,
    turns,
    steps,
    toolEvents,
    originalTokens,
    sentTokens,
    window,
    model,
    ratio: sentTokens ? originalTokens / sentTokens : null,
  };
}

/** 原始/压缩后/倍率 三个数的一行文本。 */
export function tokenLine(id, d) {
  const ratio = d.ratio === null ? '-' : d.ratio.toFixed(1) + '×';
  return `[context-debt] ${id}  原始 ${fmt(d.originalTokens)}  压缩后 ${fmt(d.sentTokens)}  ${ratio}`;
}

export const formatTokens = fmt;
