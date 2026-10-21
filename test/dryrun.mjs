/**
 * 无依赖自检：node test/dryrun.mjs
 * 验证分档、措辞、以及能否真的读到本机会话日志。
 */

import assert from 'node:assert';
import {
  DEFAULT_K,
  DEFAULT_WINDOW,
  estimate,
  findSessionFile,
  formatLine,
  listSessionFiles,
  noticeText,
  statusText,
} from '../lib/estimate.mjs';

// 1. 分档边界
const bands = [
  [0.5, 'normal'],
  [1.2, 'large'],
  [2.3, 'warn'],
  [4.7, 'danger'],
];
for (const [ratio, band] of bands) {
  const e = estimate({ bytes: (ratio * DEFAULT_WINDOW) / DEFAULT_K });
  assert.equal(e.band, band, `${ratio}× 窗口应为 ${band}，实得 ${e.band}`);
  assert.ok(Math.abs(e.percent - ratio * 100) < 0.01, '百分比换算');
}

// 2. 措辞：低档不谈「压成摘要」，高档要求换会话
const warnText = noticeText(estimate({ bytes: (2.3 * DEFAULT_WINDOW) / DEFAULT_K }));
assert.ok(warnText.includes('上下文债务'), '提醒应带标题');
assert.ok(warnText.includes('1.3 份'), `应报出压掉几份完整上下文：${warnText}`);
assert.ok(!warnText.includes('。。'), '措辞不应出现双句号');
const dangerText = noticeText(estimate({ bytes: (4.7 * DEFAULT_WINDOW) / DEFAULT_K }));
assert.ok(dangerText.includes('换新会话'), `危险档应建议换会话：${dangerText}`);

// 3. 实测数字：有 real 时简报里要出现「压缩后」和倍率
const withReal = estimate({ bytes: (2.3 * DEFAULT_WINDOW) / DEFAULT_K });
withReal.real = { originalTokens: 2300000, sentTokens: 84000, ratio: 27.4, turns: 3, steps: 40 };
const realLine = statusText(withReal);
assert.ok(realLine.includes('压缩后'), `应带压缩后：${realLine}`);
assert.ok(realLine.includes('27.4×'), `应带倍率：${realLine}`);
assert.ok(realLine.includes('日志'), `应带日志体积：${realLine}`);
const plainLine = statusText(estimate({ bytes: (2.3 * DEFAULT_WINDOW) / DEFAULT_K }));
assert.ok(plainLine.includes('（估算）'), `没有实测时应标注估算：${plainLine}`);

// 4. 真的能列出本机会话（没有会话日志时跳过）
const sessions = listSessionFiles();
if (sessions.length > 0) {
  const newest = sessions.sort((a, b) => b.mtime - a.mtime)[0];
  const e = estimate({ bytes: newest.bytes });
  console.log(formatLine(newest.id, e));
  assert.ok(e.percent > 0);
  assert.equal(newest.file, findSessionFile(newest.id, undefined) ?? newest.file);
} else {
  console.log('（本机没有会话日志，跳过读取用例）');
}

console.log('ok — 分档、措辞、实测数字、读取四组用例通过');
