#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(root, 'docs');
const entry = path.join(docsRoot, 'README.md');

function markdownFiles(dir) {
  const result = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) result.push(...markdownFiles(full));
    else if (item.isFile() && item.name.endsWith('.md')) result.push(full);
  }
  return result;
}

function localMarkdownLinks(file) {
  const source = fs.readFileSync(file, 'utf8');
  const links = [];
  const pattern = /!?(?:\[[^\]]*\])\(([^)]+)\)/g;
  for (const match of source.matchAll(pattern)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+["']/)[0];
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const withoutAnchor = target.split('#')[0].split('?')[0];
    if (!withoutAnchor) continue;
    let decoded = withoutAnchor;
    try { decoded = decodeURIComponent(withoutAnchor); } catch {}
    links.push(path.resolve(path.dirname(file), decoded));
  }
  return links;
}

const files = markdownFiles(docsRoot);
const fileSet = new Set(files.map(file => path.normalize(file)));
const broken = [];

for (const file of [path.join(root, 'AGENTS.md'), path.join(root, 'README.md'), ...files]) {
  for (const target of localMarkdownLinks(file)) {
    if (!fs.existsSync(target)) {
      broken.push(`${path.relative(root, file)} -> ${path.relative(root, target)}`);
    }
  }
}

const reachable = new Set();
const queue = [entry];
while (queue.length) {
  const file = path.normalize(queue.shift());
  if (reachable.has(file) || !fileSet.has(file)) continue;
  reachable.add(file);
  for (const target of localMarkdownLinks(file)) {
    let candidate = path.normalize(target);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      candidate = path.join(candidate, 'README.md');
    }
    if (fileSet.has(candidate) && !reachable.has(candidate)) queue.push(candidate);
  }
}

const orphaned = files
  .filter(file => !reachable.has(path.normalize(file)))
  .map(file => path.relative(root, file));

if (broken.length || orphaned.length) {
  if (broken.length) {
    console.error('Broken local Markdown links:');
    for (const item of broken) console.error(`  - ${item}`);
  }
  if (orphaned.length) {
    console.error('Markdown files not reachable from docs/README.md:');
    for (const item of orphaned) console.error(`  - ${item}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed: ${files.length} indexed Markdown files, no broken local links.`);
}
