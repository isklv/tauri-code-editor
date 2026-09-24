#!/usr/bin/env bun

/**
 * Version management script for Geko.
 *
 * Keeps version in sync across:
 * - package.json
 * - src-tauri/Cargo.toml
 * - src-tauri/tauri.conf.json
 *
 * Usage:
 *   node scripts/version.js              # Print current version
 *   node scripts/version.js patch        # Bump patch (0.1.0 -> 0.1.1)
 *   node scripts/version.js minor        # Bump minor (0.1.0 -> 0.2.0)
 *   node scripts/version.js major        # Bump major (0.1.0 -> 1.0.0)
 *   node scripts/version.js 0.2.5        # Set exact version
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const pkgPath = path.join(rootDir, 'package.json');
const cargoPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version;

const arg = process.argv[2];

if (!arg) {
  console.log(`Current version: ${currentVersion}`);
  process.exit(0);
}

function parseSemver(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4],
    build: m[5],
  };
}

let nextVersion;
const parsed = parseSemver(currentVersion);

if (arg === 'patch') {
  if (!parsed) throw new Error(`Cannot parse current semver: ${currentVersion}`);
  nextVersion = `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
} else if (arg === 'minor') {
  if (!parsed) throw new Error(`Cannot parse current semver: ${currentVersion}`);
  nextVersion = `${parsed.major}.${parsed.minor + 1}.0`;
} else if (arg === 'major') {
  if (!parsed) throw new Error(`Cannot parse current semver: ${currentVersion}`);
  nextVersion = `${parsed.major + 1}.0.0`;
} else {
  nextVersion = arg.startsWith('v') ? arg.slice(1) : arg;
  if (!parseSemver(nextVersion)) {
    console.error(`Error: Invalid semver version '${arg}'`);
    process.exit(1);
  }
}

console.log(`Updating version: ${currentVersion} -> ${nextVersion}`);

// 1. package.json
pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`✔ Updated package.json`);

// 2. Cargo.toml
if (fs.existsSync(cargoPath)) {
  let cargo = fs.readFileSync(cargoPath, 'utf8');
  cargo = cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${nextVersion}"`);
  fs.writeFileSync(cargoPath, cargo);
  console.log(`✔ Updated src-tauri/Cargo.toml`);
}

// 3. tauri.conf.json (if version is not using "../package.json")
if (fs.existsSync(tauriConfPath)) {
  const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  if (conf.version && !conf.version.endsWith('package.json')) {
    conf.version = nextVersion;
    fs.writeFileSync(tauriConfPath, JSON.stringify(conf, null, 2) + '\n');
    console.log(`✔ Updated src-tauri/tauri.conf.json`);
  }
}

console.log(`\nVersion successfully set to ${nextVersion}`);
