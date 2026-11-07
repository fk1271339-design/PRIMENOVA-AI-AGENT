import { executeCommand, type ExecutionResult } from '../engine/sandbox.js';

/**
 * Git tooling for the audit pipeline.
 *
 * All git operations run THROUGH the hardened sandbox (`executeCommand`), so they are
 * jailed to the workspace root, have a 30s hard timeout, and get automatic process-tree
 * cleanup just like every other tool call.
 */

export interface GitSnapshot {
  /** Was a usable git history found (or created)? */
  available: boolean;
  status: string;
  /** Unified diff of the latest commit (`git diff HEAD~1`). */
  diff: string;
  log: string;
  /** Parsed per-file patches extracted from the diff. */
  changedFiles: DiffFile[];
}

export interface DiffFile {
  path: string;
  patch: string;
}

async function git(command: string): Promise<ExecutionResult> {
  return executeCommand(`git ${command}`);
}

export async function runGitStatus(): Promise<ExecutionResult> {
  return git('status');
}

export async function runGitDiffHead1(): Promise<ExecutionResult> {
  return git('diff HEAD~1 --stat');
}

export async function runGitLog(count: number = 5): Promise<ExecutionResult> {
  return git(`log -n ${count} --oneline`);
}

export async function runGitDiffHead1Full(): Promise<ExecutionResult> {
  return git('diff HEAD~1 --unified=3');
}

/**
 * Parses a unified diff into per-file patch objects.
 * A patch is everything from the `diff --git` header up to (but excluding) the next header.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const sections = diffText.split(/^diff --git /m).filter((s) => s.trim() !== '');

  for (const section of sections) {
    const lines = section.split('\n');
    // Prefer the b/ path (post image); fall back to the a/ path for pure deletions.
    const bLine = lines.find((l) => l.startsWith('+++ b/'));
    const aLine = lines.find((l) => l.startsWith('--- '));
    let filePath = bLine ? bLine.slice('+++ b/'.length).trim() : aLine ? aLine.slice('--- '.length).trim() : 'unknown';

    // Normalize the /dev/null delete-case and strip any quoted paths.
    filePath = filePath.replace(/^"(.*)"$/, '$1').replace(/\t.*$/, '');

    files.push({ path: filePath, patch: `diff --git ${section.trimEnd()}` });
  }

  return files;
}

/** Collects a full snapshot through the sandbox. Returns `available: false` if git is unusable. */
export async function collectGitSnapshot(): Promise<GitSnapshot> {
  const [status, diffFull, log] = await Promise.all([
    runGitStatus(),
    runGitDiffHead1Full(),
    runGitLog(5),
  ]);

  const available = status.exitCode === 0 && log.exitCode === 0 && diffFull.exitCode === 0;
  const diff = available ? diffFull.stdout : '';

  return {
    available,
    status: status.stdout,
    diff,
    log: log.stdout,
    changedFiles: available ? parseUnifiedDiff(diff) : [],
  };
}
