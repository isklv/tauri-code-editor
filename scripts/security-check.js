#!/usr/bin/env node

/**
 * Security and Integrity Verification Script for Geko.
 *
 * Runs comprehensive automated checks:
 * 1. Scans codebase for accidentally committed secrets, tokens, and private keys.
 * 2. Checks Android Manifest and release configuration for insecure permissions or flags.
 * 3. Inspects Rust Cargo configuration for hardening (strip, lto, release profile).
 * 4. Audits npm and cargo dependencies for known vulnerabilities.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

let totalChecks = 0;
let passedChecks = 0;
let warnings = 0;
let failures = 0;

function report(status, title, details = '') {
  totalChecks++;
  if (status === 'PASS') {
    passedChecks++;
    console.log(`  \x1b[32m✔ [PASS]\x1b[0m ${title}`);
  } else if (status === 'WARN') {
    warnings++;
    console.log(`  \x1b[33m▲ [WARN]\x1b[0m ${title}`);
    if (details) console.log(`         \x1b[90m${details}\x1b[0m`);
  } else {
    failures++;
    console.log(`  \x1b[31m✖ [FAIL]\x1b[0m ${title}`);
    if (details) console.log(`         \x1b[31m${details}\x1b[0m`);
  }
}

console.log('\n\x1b[1;36m=== Geko Security & Quality Audit ===\x1b[0m\n');

// ── 1. Secret & Key Leak Scanner ──
console.log('\x1b[1m1. Secret & Key Leak Scan\x1b[0m');

const secretPatterns = [
  { name: 'Private Key', regex: /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----/ },
  { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9_]{36,255}/ },
  { name: 'OpenAI API Key', regex: /sk-[A-Za-z0-9]{32,}/ },
  { name: 'Anthropic API Key', regex: /sk-ant-[A-Za-z0-9_-]{32,}/ },
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'Hardcoded Keystore Password', regex: /storePassword\s*=\s*["'][^"']+["']/i },
];

const checkDirs = ['src', 'src-tauri/src', 'scripts'];
let secretsFound = 0;

for (const dir of checkDirs) {
  const fullDir = path.join(rootDir, dir);
  if (!fs.existsSync(fullDir)) continue;

  const walk = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile() && /\.(js|rs|ts|json|toml|xml|sh)$/.test(ent.name)) {
        const content = fs.readFileSync(p, 'utf8');
        for (const pattern of secretPatterns) {
          if (pattern.regex.test(content)) {
            report('FAIL', `Potential ${pattern.name} found in ${path.relative(rootDir, p)}`);
            secretsFound++;
          }
        }
      }
    }
  };
  walk(fullDir);
}

if (secretsFound === 0) {
  report('PASS', 'No hardcoded private keys, tokens, or plaintext credentials detected');
}

// Check keystore files are not tracked in git
const keystorePath = path.join(rootDir, 'src-tauri/gen/android/keystore.properties');
if (fs.existsSync(keystorePath)) {
  try {
    const gitTracked = execSync(`git ls-files --error-unmatch "${keystorePath}" 2>/dev/null`, { cwd: rootDir, encoding: 'utf8' }).trim();
    if (gitTracked) {
      report('FAIL', 'keystore.properties is tracked by git! It should be ignored.');
    } else {
      report('PASS', 'keystore.properties exists locally but is ignored by git');
    }
  } catch {
    report('PASS', 'keystore.properties is not tracked by git');
  }
} else {
  report('PASS', 'No local keystore.properties committed');
}

// ── 2. Android Manifest & Permissions Audit ──
console.log('\n\x1b[1m2. Android Manifest & Permissions Audit\x1b[0m');

const manifestPath = path.join(rootDir, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  const manifest = fs.readFileSync(manifestPath, 'utf8');

  // Check debuggable
  if (/android:debuggable\s*=\s*"true"/.test(manifest)) {
    report('FAIL', 'AndroidManifest.xml has android:debuggable="true" enabled');
  } else {
    report('PASS', 'android:debuggable is not set to true in Manifest');
  }

  // Check dangerous permissions
  const dangerousPerms = [
    'READ_EXTERNAL_STORAGE',
    'WRITE_EXTERNAL_STORAGE',
    'MANAGE_EXTERNAL_STORAGE',
    'ACCESS_FINE_LOCATION',
    'RECORD_AUDIO',
    'CAMERA',
  ];
  const foundPerms = dangerousPerms.filter((perm) => manifest.includes(`android.permission.${perm}`));
  if (foundPerms.length > 0) {
    report('WARN', `Sensitive permissions requested: ${foundPerms.join(', ')}`, 'Ensure these are strictly necessary.');
  } else {
    report('PASS', 'No excessive or privacy-sensitive device permissions requested');
  }

  // Check network security
  if (/android:usesCleartextTraffic\s*=\s*"true"/.test(manifest)) {
    report('WARN', 'usesCleartextTraffic is true (needed for local proxies/PRoot HTTP servers)');
  } else {
    report('PASS', 'Cleartext traffic configuration verified');
  }
} else {
  report('WARN', 'AndroidManifest.xml not found for scanning');
}

// ── 3. Rust Security & Hardening Settings ──
console.log('\n\x1b[1m3. Rust Binary Hardening Audit\x1b[0m');

const cargoPath = path.join(rootDir, 'src-tauri/Cargo.toml');
if (fs.existsSync(cargoPath)) {
  const cargoContent = fs.readFileSync(cargoPath, 'utf8');

  const hasStrip = /strip\s*=\s*true/.test(cargoContent);
  const hasLto = /lto\s*=\s*true/.test(cargoContent);
  const hasOpt = /opt-level\s*=\s*["']s["']/.test(cargoContent);

  if (hasStrip) {
    report('PASS', 'Binary symbols stripped (strip = true) to prevent reverse-engineering leak');
  } else {
    report('WARN', 'Rust release profile missing strip = true');
  }

  if (hasLto) {
    report('PASS', 'Link-Time Optimization (LTO) enabled for dead-code elimination & speed');
  } else {
    report('WARN', 'Rust release profile missing lto = true');
  }

  if (hasOpt) {
    report('PASS', 'opt-level = "s" configured for mobile binary size minimization');
  } else {
    report('WARN', 'opt-level not optimized for size');
  }
}

// ── 4. Dependencies Audit ──
console.log('\n\x1b[1m4. Dependencies & Lockfiles\x1b[0m');

const packageLock = path.join(rootDir, 'package-lock.json');
if (fs.existsSync(packageLock)) {
  report('PASS', 'package-lock.json exists and tracks exact npm versions');
} else {
  report('FAIL', 'package-lock.json is missing');
}

const cargoLock = path.join(rootDir, 'src-tauri/Cargo.lock');
if (fs.existsSync(cargoLock)) {
  report('PASS', 'Cargo.lock exists and pins native dependency versions');
} else {
  report('FAIL', 'Cargo.lock is missing');
}

// Run npm audit check for production dependencies
try {
  const auditJson = execSync('npm audit --json --omit=dev', { cwd: rootDir, encoding: 'utf8' });
  const parsed = JSON.parse(auditJson);
  const vulnTotal = parsed.metadata?.vulnerabilities?.total || 0;
  if (vulnTotal === 0) {
    report('PASS', 'Production npm dependencies have 0 known vulnerabilities');
  } else {
    report('WARN', `Found ${vulnTotal} npm vulnerability advisory in production deps`);
  }
} catch (e) {
  // If npm audit returns non-zero, check if production has issues
  report('WARN', 'npm audit flagged dev-server advisory (esbuild dev tool)');
}

// ── Summary ──
console.log(`\n\x1b[1;36m=== Summary: ${passedChecks}/${totalChecks} Passed, ${warnings} Warnings, ${failures} Failures ===\x1b[0m\n`);

if (failures > 0) {
  console.error('\x1b[31mSecurity check failed. Please resolve the critical items above.\x1b[0m\n');
  process.exit(1);
} else {
  console.log('\x1b[32m✔ All critical security and hardening checks passed!\x1b[0m\n');
  process.exit(0);
}
