import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(root, 'demo');
const outputDir = resolve(root, 'chrome-extension', 'app');
const assets = [
  'index.html',
  'privacy.html',
  'app.js',
  'matcher.js',
  'account-catalog.js',
  'match-cache.js',
  'transfer-core.js',
  'transfer-engine.js',
  'transfer-safety.js',
  'transfer-job-store.js',
];
const checkOnly = process.argv.includes('--check');
const staleAssets = [];

for (const asset of assets) {
  const sourcePath = resolve(sourceDir, asset);
  const outputPath = resolve(outputDir, asset);
  if (checkOnly) {
    try {
      if (readFileSync(sourcePath).compare(readFileSync(outputPath)) !== 0) staleAssets.push(asset);
    } catch {
      staleAssets.push(asset);
    }
    continue;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  copyFileSync(sourcePath, outputPath);
}

if (staleAssets.length) {
  console.error(`Extension app bundle is out of date: ${staleAssets.join(', ')}`);
  process.exitCode = 1;
} else if (checkOnly) {
  console.log('Extension app bundle matches demo sources.');
} else {
  console.log(`Built extension app bundle (${assets.length} files).`);
}
