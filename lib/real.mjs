/**
 * 实测数字的缓存层：把「原始 / 压缩后 / 倍率」带进对话里的那一行。
 *
 * 解码一份 8MB 的会话日志约 200ms，每轮都解会明显拖慢 pre-step。
 * 所以这里做两层节流：
 *  - 同一个文件 60 秒内不重复解；
 *  - 硬下限 15 秒（文件涨得再快也不会每轮都解）；
 *  - 文件相比上次解码长大了 25%（且至少 1MB）才提前重解。
 * 中间那些轮次用的是上一次的结果，数字会滞后一两轮，但代价可控。
 */

import { decodeSession } from './decode.mjs';

const MIN_AGE_MS = 15_000;
const MAX_AGE_MS = 60_000;
const GROWTH_RATIO = 0.25;
const GROWTH_FLOOR = 1 << 20; // 1MB
const MAX_BYTES = 128 * 1024 * 1024;

/** file -> { bytes, at, value } */
const cache = new Map();

/**
 * @param {string} file 会话日志路径
 * @param {number} bytes 当前文件大小（调用方已经 stat 过）
 * @returns {{originalTokens:number, sentTokens:number|null, ratio:number|null, turns:number, steps:number}|null}
 */
export function realStats(file, bytes) {
  const prev = cache.get(file);
  const now = Date.now();
  if (prev !== undefined) {
    const age = now - prev.at;
    const grew = bytes - prev.bytes >= Math.max(prev.bytes * GROWTH_RATIO, GROWTH_FLOOR);
    const stale = age >= MAX_AGE_MS || (age >= MIN_AGE_MS && grew);
    if (!stale) return prev.value;
  }

  let value = null;
  if (bytes > 0 && bytes <= MAX_BYTES) {
    try { value = decodeSession(file); } catch { value = null; }
  }
  cache.set(file, { bytes, at: now, value });
  return value;
}

/** 测试用：清空缓存。 */
export function resetRealCache() {
  cache.clear();
}
