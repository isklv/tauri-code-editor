#!/usr/bin/env bun

/**
 * GitHub Release Publisher for Geko.
 *
 * Creates a GitHub Release, tags the commit, and uploads optimized release artifacts (APKs and checksums).
 *
 * Authentication:
 *   Uses GITHUB_TOKEN environment variable, or extracts credentials from ~/.git-credentials.
 *
 * Usage:
 *   bun scripts/publish-release.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// 1. Get GitHub Token
function getGitHubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  const credPath = path.join(process.env.HOME || '', '.git-credentials');
  if (fs.existsSync(credPath)) {
    const lines = fs.readFileSync(credPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/https:\/\/(?:[^:]+:)?([^@]+)@github\.com/);
      if (match && match[1]) {
        // match[1] could be token or user:token
        const tokenPart = match[1].includes(':') ? match[1].split(':')[1] : match[1];
        if (tokenPart.startsWith('gho_') || tokenPart.startsWith('ghp_') || tokenPart.startsWith('github_pat_')) {
          return tokenPart;
        }
      }
    }
  }
  return null;
}

const token = getGitHubToken();
if (!token) {
  console.error('\x1b[31mError: No GitHub token found in GITHUB_TOKEN or ~/.git-credentials.\x1b[0m');
  process.exit(1);
}

// 2. Read package.json & Git info
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;
const tagName = `v${version}`;

let repoOwner = 'isklv';
let repoName = 'tauri-code-editor';

try {
  const remoteUrl = execSync('git config --get remote.origin.url', { cwd: rootDir, encoding: 'utf8' }).trim();
  const repoMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (repoMatch) {
    repoOwner = repoMatch[1];
    repoName = repoMatch[2];
  }
} catch {
  // Use fallback
}

console.log(`\n\x1b[1;36m=== Publishing Geko Release ${tagName} ===\x1b[0m\n`);
console.log(`Repository: \x1b[1m${repoOwner}/${repoName}\x1b[0m`);
console.log(`Tag:        \x1b[1m${tagName}\x1b[0m\n`);

// 3. Ensure local tag exists and is pushed
console.log('\x1b[34m[1/4] Tagging and pushing to origin...\x1b[0m');
try {
  const existingTags = execSync('git tag -l', { cwd: rootDir, encoding: 'utf8' }).split('\n');
  if (!existingTags.includes(tagName)) {
    execSync(`git tag -a ${tagName} -m "Release ${tagName}"`, { cwd: rootDir, stdio: 'inherit' });
  }
  execSync(`git push origin ${tagName}`, { cwd: rootDir, stdio: 'inherit' });
  console.log(`\x1b[32m✔ Tag ${tagName} pushed to GitHub\x1b[0m`);
} catch (err) {
  console.log(`\x1b[33mTag ${tagName} already pushed or up-to-date\x1b[0m`);
}

// 4. Generate release notes
const releaseBody = `## Geko ${tagName}

### What's Changed
- Optimized mobile Android build architecture (\`arm64-v8a\` standalone APK ~12 MB).
- Vector SVG icons throughout file explorer, tabs, search, and topbar.
- Markdown preview activation on tab click.
- Proxy Manager popup visibility and UI enhancements.
- Migration to Bun runtime for local builds and release automation.
- Security and integrity test pipeline (dependency audit, permissions, binary hardening).

### Downloads & Checksums
See attached APK and SHA-256 verification files below.
`;

// 5. Create or get existing GitHub Release
console.log('\n\x1b[34m[2/4] Creating GitHub Release via API...\x1b[0m');

async function apiRequest(endpoint, method = 'GET', body = null, headers = {}) {
  const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}${endpoint}`, {
    method,
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Geko-Release-Bot',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

let release = null;
const getReleaseRes = await apiRequest(`/releases/tags/${tagName}`);
if (getReleaseRes.ok) {
  release = getReleaseRes.data;
  console.log(`Found existing release ID: ${release.id}`);
} else {
  const createRes = await apiRequest('/releases', 'POST', {
    tag_name: tagName,
    target_commitish: 'main',
    name: tagName,
    body: releaseBody,
    draft: false,
    prerelease: false,
  });

  if (!createRes.ok) {
    console.error(`\x1b[31mFailed to create release: ${JSON.stringify(createRes.data)}\x1b[0m`);
    process.exit(1);
  }
  release = createRes.data;
  console.log(`\x1b[32m✔ Release ${tagName} created (ID: ${release.id})\x1b[0m`);
}

// 6. Find Release Assets to Upload
console.log('\n\x1b[34m[3/4] Preparing release assets for upload...\x1b[0m');
const distApkDir = path.join(rootDir, 'dist-apk');
const filesToUpload = [];

if (fs.existsSync(distApkDir)) {
  const entries = fs.readdirSync(distApkDir);
  for (const file of entries) {
    if (file.includes(version)) {
      filesToUpload.push(path.join(distApkDir, file));
    }
  }
}

if (filesToUpload.length === 0) {
  console.warn('\x1b[33mWarning: No APK files found matching current version in dist-apk/.\x1b[0m');
  console.warn('Run `bun run build:apk` before publishing to include the APK.\x1b[0m');
}

// 7. Upload Assets
console.log('\n\x1b[34m[4/4] Uploading artifacts to GitHub...\x1b[0m');

// Get existing assets to avoid 422 duplicates
const existingAssets = release.assets || [];

for (const filePath of filesToUpload) {
  const fileName = path.basename(filePath);
  const existing = existingAssets.find((a) => a.name === fileName);

  if (existing) {
    console.log(`  Deleting existing asset ${fileName} (ID: ${existing.id})...`);
    await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/releases/assets/${existing.id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'Geko-Release-Bot',
      },
    });
  }

  const fileData = fs.readFileSync(filePath);
  const isApk = fileName.endsWith('.apk');
  const contentType = isApk ? 'application/vnd.android.package-archive' : 'text/plain';

  console.log(`  Uploading \x1b[1m${fileName}\x1b[0m (${(fileData.length / (1024 * 1024)).toFixed(2)} MB)...`);

  const uploadUrl = `https://uploads.github.com/repos/${repoOwner}/${repoName}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': contentType,
      'User-Agent': 'Geko-Release-Bot',
    },
    body: fileData,
  });

  if (uploadRes.ok) {
    console.log(`  \x1b[32m✔ Uploaded ${fileName}\x1b[0m`);
  } else {
    const errText = await uploadRes.text();
    console.error(`  \x1b[31m✖ Failed to upload ${fileName}: ${errText}\x1b[0m`);
  }
}

console.log('\n\x1b[1;32m================================================\x1b[0m');
console.log(`\x1b[1;32m  🎉 RELEASE ${tagName} PUBLISHED SUCCESSFULLY!       \x1b[0m`);
console.log('\x1b[1;32m================================================\x1b[0m\n');
console.log(`Release URL: \x1b[1;34m${release.html_url}\x1b[0m\n`);
