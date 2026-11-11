import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_ROOT, executeCommand, type ExecutionResult } from '../engine/sandbox.js';
import { createOrUpdateFile } from '../engine/fileSystem.js';

/**
 * Workspace execution & injection tools for the autonomous developer agent.
 *
 * Every shell command runs THROUGH the hardened sandbox (`executeCommand`):
 * jailed to the workspace root, path-scoped, hard timeout, process-tree cleanup,
 * secret-scrubbed child environment. File writes go through the jailed
 * `createOrUpdateFile` helper - both layers keep the agent inside this repo.
 */

const DIR_IGNORE_LIST = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '.venv', '__pycache__',
]);

/**
 * Safe command prefixes for the autonomous agent's shell actions.
 * Inspection commands (cat/type/dir/ls) are deliberately allowed: on a strict
 * sandbox they may exit non-zero, but the agent gets the real error output
 * back instead of a hard block - no wasted turns guessing why.
 */
export const SAFE_COMMAND_ALLOWLIST =
  /^(npm\b|npx\b|node\b|git\b|tsc\b|cat\b|type\b|dir\b|ls\b|echo\b)/;

/** Runs a command in the workspace through the hardened sandbox. */
export async function runWorkspaceCommand(command: string, timeoutMs: number = 120_000): Promise<ExecutionResult> {
  console.log(`[Workspace] $ ${command}`);
  const result = await executeCommand(command, timeoutMs);
  if (result.exitCode !== 0) {
    console.warn(`[Workspace] exit=${result.exitCode}`);
  }
  return result;
}

export interface TreeOptions {
  /** How deep to descend from the start directory. */
  maxDepth?: number;
  /** Safety cap on listed entries. */
  maxEntries?: number;
}

/** Lists all files/directories under `relDir`, ignoring build/vendor noise. */
export async function listWorkspaceFiles(relDir: string = '.', opts: TreeOptions = {}): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 4;
  const maxEntries = opts.maxEntries ?? 400;
  const out: string[] = [];

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable/missing dir - skip silently
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (DIR_IGNORE_LIST.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        await walk(path.join(dir, entry.name), rel, depth + 1);
      } else {
        out.push(rel);
      }
    }
  }

  await walk(path.resolve(WORKSPACE_ROOT, relDir), relDir === '.' ? '' : relDir.replace(/\/+$/, ''), 1);
  return out;
}

/** Renders the workspace as an indented-ish flat tree string (for LLM context). */
export async function buildFileTree(relDir: string = '.', opts: TreeOptions = {}): Promise<string> {
  const files = await listWorkspaceFiles(relDir, opts);
  return files.length > 0 ? files.join('\n') : '(workspace empty)';
}

export interface InjectedFile {
  path: string;
  content: string;
}

export interface InjectResult {
  path: string;
  ok: boolean;
  error?: string;
}

/** Writes files through the jailed file-system helper. One bad path never aborts the batch. */
export async function injectCodeFiles(files: InjectedFile[]): Promise<InjectResult[]> {
  const results: InjectResult[] = [];
  for (const file of files) {
    try {
      await createOrUpdateFile(file.path, file.content);
      results.push({ path: file.path, ok: true });
    } catch (err) {
      results.push({ path: file.path, ok: false, error: (err as Error).message });
    }
  }
  return results;
}

/**
 * Paths the autonomous agent must never touch: the audit engine itself,
 * the package manifest / tsconfig that keep this codebase compiling, and
 * environment / secret files.
 */
export function isProtectedEnginePath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (norm === '' ) return true;
  if (norm === 'package.json' || norm === 'package-lock.json' || norm === 'tsconfig.json' || norm === 'tsconfig.tsbuildinfo') return true;
  if (norm === '.gitignore' || norm.startsWith('.env')) return true;
  return /^(src|\.github|node_modules|\.git)\//.test(norm);
}

/**
 * Guards injected file paths: no absolute paths, no `..` traversal, no
 * protected engine files. Returns a rejection reason or null when safe.
 */
export function validateInjectPath(relPath: string): string | null {
  const norm = relPath.replace(/\\/g, '/');
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(norm)) return 'absolute paths are not allowed';
  if (norm.split('/').includes('..')) return 'path traversal (..) is not allowed';
  if (isProtectedEnginePath(norm)) return 'this path is protected (audit engine files)';
  return null;
}
