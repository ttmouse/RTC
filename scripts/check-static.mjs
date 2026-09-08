import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'index.html',
  'playground.html',
  'playground-settings.html',
];

for (const file of files) {
  const htmlPath = path.join(root, file);
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf8');

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const seen = new Set();
  const duplicates = [];
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.push(id);
    } else {
      seen.add(id);
    }
  }
  if (duplicates.length > 0) {
    throw new Error(`${file}: duplicate ids: ${[...new Set(duplicates)].join(', ')}`);
  }

  if (/value=["']sk-(?!x{4})[A-Za-z0-9_-]{12,}["']/.test(html)) {
    throw new Error(`${file}: hardcoded API key value detected`);
  }

  if (file === 'index.html') {
    const inline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
      .find((match) => match[2].trim());
    if (inline) throw new Error('index.html: inline script body found');
    if (!html.includes('rel="stylesheet" href="css/style.css"')) {
      throw new Error('index.html: external stylesheet missing');
    }
    if (!html.includes('<script type="module" src="js/main.js"></script>')) {
      throw new Error('index.html: module entry missing');
    }
  }
}

const jsDir = path.join(root, 'js');
const jsFiles = fs.readdirSync(jsDir)
  .filter(file => file.endsWith('.js'))
  .map(file => path.join('js', file))
  .sort();

for (const file of jsFiles) {
  const filePath = path.join(root, file);
  if (!fs.existsSync(filePath)) continue;
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${file}: ${result.stderr}`);
  }
}

console.log('static frontend checks passed');
