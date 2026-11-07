/**
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
