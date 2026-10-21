/**
 * dsh-context-debt —— 让用户看见「这个会话已经被压缩到什么程度」。
 *
 * 压缩插件（billion-context 等）的提醒都以「当前占用」为指标，压一次占用就掉回去，
 * 所以它们没法告诉用户：这个会话已经吃掉了几份完整上下文。本插件只看会话日志的
 * 体积（一次 stat，O(1)），在每轮开始时给出一个累积债务估计，超过阈值就注入一条提醒。
 *
 * 设计约束：
 *  - 零依赖（只用 node 内置模块），不 import 任何 @deepseek-ai/*，避免解析风险；
 *  - 不做任何解码/解析，纯 stat；
 *  - 每轮最多注入一次，同一条带只提醒一次（单调升级，不重复刷屏）；
 *  - 任何异常都吞掉，绝不影响主流程。
 */

import { appendFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_K,
  DEFAULT_WINDOW,
  estimate,
  findSessionFile,
  noticeText,
  statusText,
} from './lib/estimate.mjs';

export const name = 'context-debt';

/** 每轮开始时的注入源，UI 用 form=notice 渲染成提示而不是用户消息。 */
const SOURCE_KIND = 'context-debt';

/** 启动标记：插件每次被真正加载都会往这里追加一行，用来确认「装上了没有」。 */
const BOOT_LOG = join(tmpdir(), 'dsh-context-debt.boot.log');

function markBoot(config) {
  try {
    const line = `${new Date().toISOString()} loaded pid=${process.pid} ${JSON.stringify(config)}\n`;
    appendFileSync(BOOT_LOG, line, 'utf8');
  } catch { /* 标记失败不影响主流程 */ }
}

const DEFAULTS = {
  enabled: true,
  /** 超过窗口这个百分比才提醒 */
  warnPercent: 200,
  /** 超过这个百分比升级为「别接着做了」 */
  dangerPercent: 350,
  /** 无模型窗口信息时按这个算 */
  window: DEFAULT_WINDOW,
  /** tok/byte 标定值 */
  k: DEFAULT_K,
  /**
   * 报告节奏：
   *  - 'session'（默认）每个会话第一轮报一次 + 跨档时告警
   *  - 'always'   每轮都报一行（约 30 字，几乎不占上下文）
   *  - 'warn'     只在跨档时告警，平时完全静默
   */
  report: 'session',
};

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined && value !== null && key in DEFAULTS) cfg[key] = value;
    }
  }
  return cfg;
}

function windowOf(ctx, session, fallback) {
  try {
    const state = ctx.sessionProjections?.stateOf?.(session, 'contextPressure');
    const win = state?.contextWindow;
    if (typeof win === 'number' && win > 0) return win;
  } catch { /* 没有投影就退回配置值 */ }
  return fallback;
}

function makeNotice(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'notice', summary: '上下文债务' },
  });
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig);
  markBoot(cfg);
  if (cfg.enabled === false) return;

  /** sessionId -> { file, lastBand } */
  const seen = new Map();

  const measure = (agent) => {
    const sessionId = agent?.session?.id;
    if (!sessionId) return undefined;
    let entry = seen.get(sessionId);
    if (entry === undefined) {
      const file = findSessionFile(sessionId);
      if (file === undefined) return undefined;
      entry = { file, lastBand: 'normal', reported: false };
      seen.set(sessionId, entry);
    }
    let bytes;
    try { bytes = statSync(entry.file).size; } catch { return undefined; }
    const window = windowOf(ctx, agent.session, cfg.window);
    return { entry, est: estimate({ bytes, k: cfg.k, window }) };
  };

  ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
    const decision = await next();
    try {
      if (step !== 1) return decision; // 每轮只在第一步判断
      if (decision?.kind === 'reject' || !Array.isArray(decision?.messages)) return decision;
      const measured = measure(agent);
      if (measured === undefined) return decision;
      const { entry, est } = measured;
      const threshold = est.band === 'danger' ? cfg.dangerPercent : cfg.warnPercent;
      const crossing = est.percent >= threshold && entry.lastBand !== est.band;

      let text;
      if (crossing) {
        text = noticeText(est); // 跨档：说清楚该怎么办
      } else if (cfg.report === 'always') {
        text = statusText(est); // 每轮一行
      } else if (cfg.report === 'session' && !entry.reported) {
        text = statusText(est); // 每个会话第一次开口时报一次
      }

      entry.lastBand = est.band;
      entry.reported = true;
      if (text === undefined) return decision;

      const notice = makeNotice(text);
      const lastClaimed = decision.messages.findLastIndex((message) => messages.includes(message));
      const at = lastClaimed >= 0 ? lastClaimed + 1 : decision.messages.length;
      return { ...decision, messages: decision.messages.toSpliced(at, 0, notice) };
    } catch {
      return decision;
    }
  });
}
