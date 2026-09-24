#!/usr/bin/env bun

/**
 * Master Local Release Pipeline for Geko.
 *
 * Runs full CI/CD locally without GitHub Actions:
 * 1. (Optional) Bumps version in package.json, Cargo.toml, tauri.conf.json.
 * 2. Security audit (credentials scan, permissions, dependencies).
 * 3. Code formatting & linting (cargo fmt, clippy).
 * 4. Backend unit & integration test suite (cargo test).
 * 5. Frontend production build (Vite via Bun).
 * 6. Optimized Android APK compilation (arm64-v8a ~12MB).
 * 7. Checksum calculation & release artifact summary.
 *
 * Usage:
 *   bun scripts/release.js               # Run release pipeline on current version
 *   bun scripts/release.js patch         # Bump patch (0.1.0 -> 0.1.1) and release
 *   bun scripts/release.js minor         # Bump minor (0.1.0 -> 0.2.0) and release
 *   bun scripts/release.js 0.2.0         # Set specific version and release
 *   bun scripts/release.js --no-apk      # Run checks & tests without building APK
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const skipApk = args.includes('--no-apk') || args.includes('--skip-apk');
const versionArg = args.find((a) => !a.startsWith('--'));

console.log('\n\x1b[1;35m================================================\x1b[0m');
console.log('\x1b[1;35m       🚀 GEKO LOCAL RELEASE PIPELINE          \x1b[0m');
console.log('\x1b[1;35m================================================\x1b[0m\n');

function step(num, total, name) {
  console.log(`\n\x1b[1;34m[${num}/${total}] ${name}\x1b[0m`);
  console.log('\x1b[90m' + '─'.repeat(45) + '\x1b[0m');
}

const totalSteps = skipApk ? 5 : 6;
let currentStep = 1;

// 1. Version Bump (if requested)
if (versionArg) {
  step(currentStep++, totalSteps, `Bumping version (${versionArg})...`);
  execSync(`bun scripts/version.js ${versionArg}`, { cwd: rootDir, stdio: 'inherit' });
}

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
console.log(`\x1b[1mRelease Target Version: v${pkg.version}\x1b[0m\n`);

// 2. Security Check
step(currentStep++, totalSteps, 'Security & Integrity Auditing...');
execSync('bun scripts/security-check.js', { cwd: rootDir, stdio: 'inherit' });

// 3. Code Style & Lint
step(currentStep++, totalSteps, 'Rust Formatting & Clippy Linter...');
console.log('Checking cargo fmt...');
execSync('cargo fmt --manifest-path src-tauri/Cargo.toml --check', { cwd: rootDir, stdio: 'inherit' });
console.log('\x1b[32m✔ Code formatting is clean\x1b[0m');

console.log('Running cargo clippy...');
execSync('cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings', { cwd: rootDir, stdio: 'inherit' });
console.log('\x1b[32m✔ Clippy passed with 0 warnings\x1b[0m');

// 4. Backend Tests
step(currentStep++, totalSteps, 'Running Backend Unit & Integration Tests...');
execSync('cargo test --manifest-path src-tauri/Cargo.toml', { cwd: rootDir, stdio: 'inherit' });
console.log('\x1b[32m✔ All Rust tests passed successfully\x1b[0m');

// 5. Frontend Build Verification
step(currentStep++, totalSteps, 'Building Web Frontend Assets (Vite via Bun)...');
execSync('bun run build', { cwd: rootDir, stdio: 'inherit' });
console.log('\x1b[32m✔ Frontend bundle compiled\x1b[0m');

// 6. Build Optimized APK
if (!skipApk) {
  step(currentStep++, totalSteps, 'Compiling Optimized Release APK (arm64-v8a)...');
  execSync('bun scripts/build-apk.js', { cwd: rootDir, stdio: 'inherit' });
}

console.log('\n\x1b[1;32m================================================\x1b[0m');
console.log(`\x1b[1;32m  ✔ RELEASE v${pkg.version} SUCCESSFULLY CREATED!       \x1b[0m`);
console.log('\x1b[1;32m================================================\x1b[0m\n');
console.log('Ready for deployment and distribution.');
