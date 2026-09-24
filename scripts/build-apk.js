#!/usr/bin/env bun
 
/**
 * Builds an optimized release APK for Geko.
 *
 * Defaults to `aarch64` (arm64-v8a) which produces an optimized ~12 MB APK
 * for modern Android devices.
 *
 * Options:
 *   --target aarch64       (default: arm64-v8a ~12MB)
 *   --universal / --all    (builds fat APK with all 4 ABIs ~40MB)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const isUniversal = args.includes('--universal') || args.includes('--all');
const targetArgIdx = args.indexOf('--target');
const target = isUniversal
  ? null
  : (targetArgIdx >= 0 && args[targetArgIdx + 1]) || 'aarch64';

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;

console.log(`\n\x1b[1;36m=== Building Optimized Geko APK v${version} ===\x1b[0m\n`);
console.log(`Target: \x1b[1m${isUniversal ? 'Universal (All 4 ABIs ~40MB)' : `Optimized ${target} (arm64-v8a ~12MB)`}\x1b[0m\n`);

// 1. Build frontend first
console.log('\x1b[34m[1/3] Building frontend assets (Vite via Bun)...\x1b[0m');
execSync('bun run build', { cwd: rootDir, stdio: 'inherit' });

// 2. Build Android APK via Tauri
console.log('\n\x1b[34m[2/3] Compiling Rust & Gradle Android APK...\x1b[0m');
const tauriCmd = target
  ? `bunx tauri android build --apk --target ${target}`
  : `bunx tauri android build --apk`;

console.log(`Running: ${tauriCmd}\n`);
execSync(tauriCmd, { cwd: rootDir, stdio: 'inherit' });

// 3. Locate built APK
console.log('\n\x1b[34m[3/3] Packaging and verifying release artifact...\x1b[0m');
const outputsDir = path.join(rootDir, 'src-tauri/gen/android/app/build/outputs/apk');

function findApk(dir) {
  let matched = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith('.apk') && ent.name.includes('release')) {
        matched.push(p);
      }
    }
  };
  walk(dir);
  return matched;
}

const apks = findApk(outputsDir);
if (apks.length === 0) {
  console.error('\x1b[31mError: No release APK found in outputs directory.\x1b[0m');
  process.exit(1);
}

// Sort by mtime descending to get the most recent build
apks.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
const rawApk = apks[0];

const distApkDir = path.join(rootDir, 'dist-apk');
if (!fs.existsSync(distApkDir)) {
  fs.mkdirSync(distApkDir, { recursive: true });
}

const abiSuffix = isUniversal ? 'universal' : 'arm64';
const destFileName = `geko-v${version}-${abiSuffix}.apk`;
const destPath = path.join(distApkDir, destFileName);

fs.copyFileSync(rawApk, destPath);

// Calculate SHA-256
const fileBuffer = fs.readFileSync(destPath);
const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
fs.writeFileSync(`${destPath}.sha256`, `${sha256}  ${destFileName}\n`);

const stat = fs.statSync(destPath);
const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);

console.log(`\n\x1b[32m✔ Release APK ready:\x1b[0m`);
console.log(`  File:    \x1b[1m${destPath}\x1b[0m`);
console.log(`  Size:    \x1b[1;33m${sizeMb} MB\x1b[0m`);
console.log(`  SHA256:  \x1b[90m${sha256}\x1b[0m\n`);
