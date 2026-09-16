#!/usr/bin/env node
/**
 * 外部分析结果写入器。
 * 用法：node scripts/meeting-board.mjs write-analysis analysis.json
 * APP 不调用 AI；外部工具完成分析后，通过这个入口把结构化结果交给白板。
 */
import fs from 'node:fs/promises';

const [command, input, sessionId] = process.argv.slice(2);
const baseUrl = process.env.RTC_URL || 'http://127.0.0.1:8931';

if (!command || !input || !['write-analysis', 'write-definition', 'write-document'].includes(command)) {
  console.error('用法：node scripts/meeting-board.mjs write-analysis <JSON文件> [会议场次ID]');
  console.error('或：node scripts/meeting-board.mjs write-definition <JSON文件> [会议场次ID]');
  console.error('或：node scripts/meeting-board.mjs write-document <Markdown文件> [会议场次ID]');
  process.exit(2);
}

let value;
try {
  value = command === 'write-document' ? { document: await fs.readFile(input, 'utf8') } : JSON.parse(await fs.readFile(input, 'utf8'));
} catch (error) {
  console.error(`无法读取${command === 'write-document' ? ' Markdown' : ' JSON'} 文件：${error.message}`);
  process.exit(1);
}

const endpoint = command === 'write-analysis'
  ? '/api/meeting-board/analysis'
  : (command === 'write-definition' ? '/api/meeting-board/definition' : '/api/meeting-board/document');
const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
const response = await fetch(baseUrl + endpoint + suffix, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});
const result = await response.json().catch(() => ({}));
if (!response.ok || !result.ok) {
  console.error(result.error || `写入失败：HTTP ${response.status}`);
  process.exit(1);
}
console.log(`已写入白板：${endpoint}`);
