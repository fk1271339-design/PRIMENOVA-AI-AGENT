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

/**
 * Ensures the workspace is audit-ready:
 *
 * - Default local mode (`force=false`): if the repo already has a HEAD~1 commit,
 *   the real latest commit IS the diff under review -> no fixture needed (skip).
 *   On a fresh repo without history, creates the 2-commit demo (baseline -> buggy PR).
 * - `force=true` (`--demo` flag): appends a fresh baseline->buggy commit pair so
 *   the demo can be re-run even on top of real user commits.
 */
export async function ensureAuditFixture(force: boolean = false): Promise<void> {
  const headProbe = await executeCommand('git rev-parse -q --verify HEAD~1', 15_000);
  const hasHistory = headProbe.exitCode === 0;

  const buggyContentPresent = await (async () => {
    try {
      const content = await readFileContent(FIXTURE_FILE);
      return content.includes('md5');
    } catch {
      return false;
    }
  })();

  if (!force && hasHistory && buggyContentPresent) {
    console.log('[Fixture] Repo has HEAD~1 - auditing the real latest commit (pass --demo for the tour).');
    return;
  }

  if (force) {
    console.log('[Fixture] --demo requested - creating a fresh baseline -> vulnerable PR commit pair...');
    await ensureDemoCommitsWithUniqueMessages();
    return;
  }

  // Fresh repo (no HEAD~1): create the classic 2-commit demo history.
  if (!hasHistory) {
    console.log('[Fixture] Fresh repo - creating two-commit audit history (git init + commits)...');
    await runInitialDemoHistory();
    return;
  }

  // History exists but the buggy fixture file is gone (e.g. user's own repo).
  console.log('[Fixture] HEAD~1 exists but fixture content changed - auditing the real latest commit.');
}

async function ensureDemoCommitsWithUniqueMessages(): Promise<void> {
  await runInitialDemoHistory(true);
  console.log('[Fixture] Demo history ready: vulnerable patch is at HEAD.');
}

async function runInitialDemoHistory(withUniqueSuffix: boolean = false): Promise<void> {
  const init = await git('init');
  if (init.exitCode !== 0 && !init.stdout.includes('already exists')) {
    throw new Error(`git init failed: ${init.stderr}`);
  }

  const suffix = withUniqueSuffix ? `_${Date.now()}` : '';

  // Revision 1 (clean baseline)
  await createOrUpdateFile(FIXTURE_FILE, BASELINE);
  const add1 = await git('add .');
  if (add1.exitCode !== 0) throw new Error(`git add failed: ${add1.stderr}`);
  const commit1 = await executeCommand(`git ${GIT_IDENTITY} commit -m baseline_prior_revision_of_demo_service_${suffix}`);
  const baselineCommitted = commit1.exitCode === 0;
  if (!baselineCommitted && !commit1.stderr.includes('nothing to commit') && !commit1.stdout.includes('nothing to commit')) {
    throw new Error(`git commit (baseline) failed: ${commit1.stdout} ${commit1.stderr}`);
  }

  // Revision 2 (the buggy PR)
  await createOrUpdateFile(FIXTURE_FILE, BUGGY_PATCHED);
  const add2 = await git('add .');
  if (add2.exitCode !== 0) throw new Error(`git add failed: ${add2.stderr}`);
  const commit2 = await executeCommand(`git ${GIT_IDENTITY} commit -m feat_dashboard_and_maintenance_utilities_${suffix}`);
  if (commit2.exitCode !== 0) throw new Error(`git commit (buggy PR) failed: ${commit2.stdout} ${commit2.stderr}`);
}
