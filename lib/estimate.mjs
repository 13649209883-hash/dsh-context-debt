/**
 * 上下文债务：估算一个会话累计「吃掉了多少 token」。
 *
 * 思路：会话日志 session.v4.jsonl.zstd 的压缩体积与累计 token 近似成正比，
 * 所以只需要 fs.stat，不解码、不解析、不占内存 —— O(1)，毫秒级。
 *
 * 这个数回答的是「压缩插件回答不了」的问题：当前占用（压完就归零）看不出
 * 一个会话已经被压缩过多少代；累计堆积才和「越聊越笨」相关。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** tok/byte 标定值：4 个真实会话反推 0.62 / 0.64 / 0.75 / 0.86，取中位。 */
export const DEFAULT_K = 0.71;
export const DEFAULT_WINDOW = 1048576;
const LOG_NAME = 'session.v4.jsonl.zstd';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 本地标定文件（`node calibrate.mjs --write` 生成，不进仓库）。 */
export const LOCAL_K_FILE = join(HERE, '..', 'data', 'calibration.local.json');

/**
 * 少数几个样本的中位数会随样本换一批就漂，所以给个门槛：
 * 少于 3 个不下结论（继续用出厂值），3 个算初步，5 个算可用，10 个以上算较稳。
 */
export const MIN_SAMPLES = 3;

/** 样本量 → 置信档位；`不足` 表示不该拿它当结论。 */
export function kLevel(samples) {
  const n = Number(samples) || 0;
  if (n >= 10) return '较稳';
  if (n >= 5) return '可用';
  if (n >= MIN_SAMPLES) return '初步';
  return '不足';
}

/** 读本地标定；没有或读坏了就返回 undefined。`filePath` 只为测试可替换。 */
export function localK(filePath = LOCAL_K_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const k = Number(parsed?.k);
    const samples = Number(parsed?.samples) || 0;
    if (Number.isFinite(k) && k > 0.1 && k < 3) {
      return {
        k,
        samples,
        level: kLevel(samples),
        usable: samples >= MIN_SAMPLES,
        range: Array.isArray(parsed.range) && parsed.range.length === 2 ? parsed.range.map(Number) : null,
        generatedAt: parsed.generatedAt ?? null,
      };
    }
  } catch { /* 没有标定文件是常态 */ }
  return undefined;
}

/**
 * 决定用哪个 k：配置里明确写了就用配置，否则用本地标定，再否则用出厂值。
 * 返回 { k, source }，source 会写进启动日志，方便事后追。
 */
export function resolveK(configured, filePath = LOCAL_K_FILE) {
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return { k: configured, source: 'config' };
  }
  const local = localK(filePath);
  if (local?.usable) {
    return { k: local.k, source: `local/${local.samples}样本/${local.level}`, samples: local.samples, level: local.level, range: local.range };
  }
  if (local) {
    return {
      k: DEFAULT_K,
      source: `default（本地只标定过 ${local.samples} 个样本，需 ≥${MIN_SAMPLES} 才采用）`,
      samples: local.samples,
      level: '不足',
    };
  }
  return { k: DEFAULT_K, source: 'default' };
}


/** 一条估算结果。 */
export function estimate({ bytes, k = DEFAULT_K, window = DEFAULT_WINDOW }) {
  return estimateFromTokens({ tokens: bytes * k, window, bytes });
}

/** 已经有实测 token 时用这个（解码出来的数比字节×k 更准）。 */
export function estimateFromTokens({ tokens, window = DEFAULT_WINDOW, bytes = 0 }) {
  const percent = (tokens / window) * 100;
  const extra = Math.max(0, tokens / window - 1);
  const band = percent < 100 ? 'normal' : percent < 200 ? 'large' : percent < 350 ? 'warn' : 'danger';
  return { tokens, percent, extra, band, window, bytes };
}

/** 给人看的一行。 */
export function formatLine(id, e) {
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : (n / 1e3).toFixed(0) + 'K');
  const label = { normal: '正常', large: '偏大', warn: '警戒', danger: '危险' }[e.band];
  return `[context-debt] ${id}  日志 ${(e.bytes / 1048576).toFixed(2)}MB  →  堆积≈${fmt(e.tokens)} (${e.percent.toFixed(0)}% of ${fmt(e.window)})  ${label}`;
}

/** 注入给模型/用户看的一段话（尽量短，只在超阈值时才出现）。 */
export function noticeText(e) {
  const parts = [`【上下文债务】${e.percent.toFixed(0)}% 窗口`, metricsText(e)];
  if (e.extra > 0.3) parts.push(`相当于把 ${e.extra.toFixed(1)} 份完整上下文压成了摘要`);
  parts.push(e.band === 'danger'
    ? '继续做长任务会跳规则、改错代码、甚至编造已经做过的事，建议换新会话接着做（把结论贴过去）'
    : '复杂推理会开始漂，长任务建议尽快收尾或开新会话');
  return parts.join('，') + '。';
}

/** 三个数：日志体积 / 原始 tokens / 压缩后 tokens / 倍率。有实测就用实测，没有就标注「估算」。 */
export function metricsText(e) {
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : (n / 1e3).toFixed(1) + 'K');
  const real = e.real ?? null;
  const parts = [`日志 ${(e.bytes / 1048576).toFixed(2)}MB`];
  parts.push(`原始 ${fmt(real ? real.originalTokens : e.tokens)}${real ? '' : '（估算）'}`);
  if (real && Number.isFinite(real.sentTokens) && real.sentTokens > 0) {
    parts.push(`压缩后 ${fmt(real.sentTokens)}`);
    if (Number.isFinite(real.ratio) && real.ratio > 0) parts.push(`${real.ratio.toFixed(1)}×`);
  }
  return parts.join(' · ');
}

/**
 * 一行状态简报（每次会话 / 每轮都给时用）。刻意压到一行，
 * 不占用多少上下文，但足够回答「现在压到哪一档、还剩多少是原文」。
 */
export function statusText(e) {
  const label = BAND_LABEL[e.band];
  return `【上下文】${e.percent.toFixed(0)}% ${label} · ${metricsText(e)}`;
}

export const BAND_LABEL = { normal: '正常', large: '偏大', warn: '警戒', danger: '危险' };

/** 会话日志根目录。 */
export function sessionsRoot() {
  const home = process.env.USERPROFILE || process.env.HOME;
  return join(home, '.dsh', 'sessions');
}

/** 按会话 id 找日志文件；找到返回路径，找不到返回 undefined。 */
export function findSessionFile(sessionId, root = sessionsRoot()) {
  if (!sessionId) return undefined;
  // DSH 的 session.id 自带 `session-` 前缀（日志头里就是 `session-<uuid>`），
  // 而目录名也是 `session-<uuid>`；两种写法都要认，否则永远找不到文件、静默失效。
  const raw = String(sessionId);
  const core = raw.replace(/^session-/, '');
  const needles = [...new Set([raw, `session-${core}`])].filter(Boolean);
  const matches = (name) => needles.some((needle) => name.includes(needle));
  let top;
  try { top = readdirSync(root, { withFileTypes: true }); } catch { return undefined; }
  // 布局：sessions/<workspace>/session-<id>/session.v4.jsonl.zstd（workspace 层可能缺省）
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    const direct = join(root, entry.name, LOG_NAME);
    if (matches(entry.name) && existsSync(direct)) return direct;
  }
  for (const entry of top) {
    if (!entry.isDirectory() || matches(entry.name)) continue;
    let inner;
    try { inner = readdirSync(join(root, entry.name), { withFileTypes: true }); } catch { continue; }
    for (const sub of inner) {
      if (!sub.isDirectory() || !matches(sub.name)) continue;
      const file = join(root, entry.name, sub.name, LOG_NAME);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

/** 列出所有会话日志（CLI 用）。 */
export function listSessionFiles(root = sessionsRoot()) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === LOG_NAME) out.push(p);
    }
  };
  walk(root);
  return out.map((file) => {
    const st = statSync(file);
    return { file, id: file.split(/[\\/]/).at(-2).replace(/^.*?session-/, '').slice(0, 8), bytes: st.size, mtime: st.mtimeMs };
  });
}
