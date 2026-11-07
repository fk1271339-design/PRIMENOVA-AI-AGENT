/**
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
