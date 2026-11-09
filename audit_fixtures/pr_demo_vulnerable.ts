/**
 * ⚠️ INTENTIONALLY VULNERABLE - DEMO FILE ONLY ⚠️
 *
 * This file exists purely to give the multi-agent audit pipeline (GitHub
 * Actions workflow `pr-audit.yml`) meaningful findings to report on this
 * test pull request. It must NEVER be merged into main, imported by any
 * real module, or copied into production code.
 */

import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';

// Hardcoded secret material (looks like a live API key).
const SUPER_ADMIN_TOKEN = 'gsk_demo_secret_token_1234567890';

// Credential-like literal binding.
const adminPassword = 'super_secret_admin_password_2024';

// Weak hashing for security-sensitive data.
function legacyPasswordHash(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

// Classic SQL string concatenation.
export function buildUserLookup(userId: string): string {
  const sql = 'SELECT * FROM users WHERE id = ' + userId;
  return sql;
}

// Command injection via shell string building.
export function purgeDownloads(folder: string): void {
  exec('rm -rf ' + folder, (err) => {
    if (err) console.error(err);
  });
}

// DOM XSS pattern (demo context - no DOM available at runtime).
export function renderBanner(userInput: string): string {
  const markup = `<div class="banner">${userInput}</div>`;
  const fakeElement = { innerHTML: '' } as { innerHTML: string };
  fakeElement.innerHTML = markup;
  return markup;
}

// Wire everything together with the fake credentials ("use" them).
export function adminSession() {
  return {
    token: SUPER_ADMIN_TOKEN,
    password: adminPassword,
    hash: legacyPasswordHash(adminPassword),
  };
}
