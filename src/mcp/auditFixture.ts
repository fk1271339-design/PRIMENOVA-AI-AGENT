import { executeCommand } from '../engine/sandbox.js';
import { createOrUpdateFile, readFileContent } from '../engine/fileSystem.js';

/**
 * Audit fixture: creates a REAL git history with two commits so that
 * `git diff HEAD~1` returns an authentic patch:
 *
 *   commit 1: baseline  - clean prior revision of the demo service
 *   commit 2: bug patch - introduces the vulnerable/quality issues
 *
 * The fixture lives in `audit_fixtures/` and is never executed - it exists
 * purely to be reviewed by the auditor agents.
 */

export const FIXTURE_FILE = 'audit_fixtures/vulnerable_demo.ts';
export const FIXTURE_MANIFEST = 'package.json';

const BASELINE = `/**
 * Demo service module - revision 1 (baseline, pre-PR).
 */

export interface UserRecord {
  id: string;
  name: string;
  email: string;
}

export function findUserQuery(userId: string): string {
  // TODO standard call
  return 'SELECT id, name, email FROM users WHERE id = ?';
}

export function formatGreeting(name: string): string {
  return 'Hello, ' + name + '!';
}
`;

const BUGGY_PATCHED = `/**
 * Demo service module - revision 2 (the PR under audit).
 */

export interface UserRecord {
  id: string;
  name: string;
  email: string;
}

export function findUserQuery(userId: string): string {
  // Admin console needs the raw id appended for quick filtering
  return 'SELECT id, name, email FROM users WHERE id = ' + userId;
}

export function formatGreeting(name: string): string {
  return 'Hello, ' + name + '!';
}

// ---------------------------------------------------------------------------
// New dashboard feature (this section contains the intentional issues)
// ---------------------------------------------------------------------------

const SESSION_SECRET = 's3cr3t_fallback_value_9f2b7c5d';
const DASHBOARD_API_TOKEN = 'sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';

export function loadDashboardTemplate(rawHtml: string): void {
  const el: any = (globalThis as unknown as { document?: any }).document;
  if (el && el.getElementById('root')) {
    el.getElementById('root').innerHTML = rawHtml;
  }
}

export function runMaintenanceTask(userInput: string): string {
  const { exec } = require('child_process');
  return exec('maintenance-run --target ' + userInput).toString();
}

export function hashPassword(password: string): string {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(password).digest('hex');
}

export function authorize(request: { cookies?: Record<string, string> }): boolean {
  return request.cookies?.role === 'admin_public_token';
}

export function sumAggregates(rows: number[]): number {
  let total = 0;
  for (const r of rows) {
    for (const s of rows) {
      if (r === s) total += 1;
    }
  }
  return total;
}

export async function fetchRemoteData(url: string): Promise<any> {
  const response = await fetch(url);
  return response.json();
}
`;

const GIT_IDENTITY = '-c user.name=HyperDevAgent -c user.email=hyperdev@localhost';

async function git(command: string) {
  return executeCommand(`git ${command}`);
}

/** True when the repo already has 2+ commits AND the fixture is at the buggy revision. */
async function fixtureAlreadyReady(): Promise<boolean> {
  const probe = await git('rev-parse -q --verify HEAD~1');
  if (probe.exitCode !== 0) return false;
  try {
    const content = await readFileContent(FIXTURE_FILE);
    return content.includes('md5');
  } catch {
    return false;
  }
}

/**
 * Ensures the workspace contains the two-commit audit history.
 * Idempotent: skips setup when the fixture history already exists.
 */
export async function ensureAuditFixture(): Promise<void> {
  if (await fixtureAlreadyReady()) {
    console.log('[Fixture] Audit history already present - skipping setup.');
    return;
  }

  console.log('[Fixture] Setting up two-commit audit history (git init + commits)...');

  const init = await git('init');
  if (init.exitCode !== 0 && !init.stdout.includes('already exists')) {
    throw new Error(`git init failed: ${init.stderr}`);
  }

  // Revision 1 (clean baseline)
  await createOrUpdateFile(FIXTURE_FILE, BASELINE);
  const add1 = await git('add .');
  if (add1.exitCode !== 0) throw new Error(`git add failed: ${add1.stderr}`);
  const commit1 = await executeCommand(`git ${GIT_IDENTITY} commit -m baseline_prior_revision_of_demo_service`);
  if (commit1.exitCode !== 0) throw new Error(`git commit (1) failed: ${commit1.stdout} ${commit1.stderr}`);

  // Revision 2 (the buggy PR)
  await createOrUpdateFile(FIXTURE_FILE, BUGGY_PATCHED);
  const add2 = await git('add .');
  if (add2.exitCode !== 0) throw new Error(`git add failed: ${add2.stderr}`);
  const commit2 = await executeCommand(`git ${GIT_IDENTITY} commit -m feat_dashboard_and_maintenance_utilities`);
  if (commit2.exitCode !== 0) throw new Error(`git commit (2) failed: ${commit2.stdout} ${commit2.stderr}`);

  console.log('[Fixture] Audit history ready: 2 commits, vulnerable patch is HEAD~1..HEAD.');
}
