import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Hardened command sandbox.
 *
 * Guarantees (best-effort, process-level):
 *  1. Directory jail   - commands are always executed with `cwd` = workspace root and any
 *                        command referencing an absolute path OUTSIDE the workspace root
 *                        is rejected before execution.
 *  2. Process-tree kill- the spawned shell is cleaned up together with every descendant
 *                        process it created (taskkill /F /T on Windows, process-group
 *                        SIGKILL on Unix) on timeout, on error AND after normal exit,
 *                        so orphaned servers can never linger or lock ports.
 *  3. Execution timeout- commands are hard-capped at 30 seconds by default.
 *
 * NOTE: This is process-level isolation, NOT an OS-level/container jail. Determined
 * prompt injection can still reach files under the workspace root. For hostile input
 * run this inside Docker/VM.
 */

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Jail root: every command and every absolute path target must resolve inside here. */
export const WORKSPACE_ROOT = process.cwd();

/** Default hard cap for single command executions. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Exit code used when the sandbox itself terminates a command (timeout / block / error). */
export const SANDBOX_EXIT_CODES = {
  BLOCKED: -1,
  TIMEOUT: -999,
} as const;

/** True if `target` resolves strictly inside WORKSPACE_ROOT (not equal to it). */
function isInsideWorkspaceRoot(target: string, allowRootItself = true): boolean {
  const resolved = path.resolve(target);
  const rel = path.relative(WORKSPACE_ROOT, resolved);
  if (rel === '') return allowRootItself;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Detects absolute paths (Windows drive letters, UNC shares, Unix system dirs)
 * that point outside the workspace root.
 */
function referencesPathOutsideRoot(command: string): boolean {
  // Windows drive paths, e.g.  C:\Windows  or  D:/Users/...
  const drivePathRegex = /(?<![\w.])[A-Za-z]:[\\/][^\s"'&|<>]*/g;
  for (const match of command.matchAll(drivePathRegex)) {
    if (!isInsideWorkspaceRoot(match[0])) return true;
  }

  // UNC shares, e.g.  \\\\server\\share
  if (/\\\\[^\s"']+/.test(command)) return true;

  // Unix absolute paths into system directories (anything else starting with "/" can be
  // a legit subshell construct like $(...), so we only jail well-known system roots).
  if (
    /(?:^|[\s"'&(])\/(?:bin|boot|dev|etc|home|lib|lib64|media|mnt|opt|proc|root|run|sbin|srv|sys|tmp|usr|var)(?:[\\/\s"'&)<|]|$)/.test(
      command
    )
  ) {
    return true;
  }

  return false;
}

const DANGEROUS_PATTERNS = [
  /rm\s+-[rf]/i,
  /rmdir\s+\/s\s+\/q/i,
  /format\s+[a-z]:/i,
  /mkfs/i,
  /mkfs\.[a-z0-9]+/i,
  />\s*\/dev\/sd[a-z]/i,
  /dd\s+if=.*of=\/dev\//i,
  /:()\s*{\s*:\s*\|\s*:\s*&\s*}\s*;/i, // fork bomb
  /del\s+\/f\s+\/s\s+\/q/i,
  // PowerShell destructive equivalents
  /remove-item\s+.*-recurse.*-force/i,
  /rd\s+\/s\s+\/q/i,
  // Sandbox / audit-evasion attempts
  /taskkill\s+\/?f?\s*\/im\s+node\.exe/i, // mass-killing unrelated node processes
  /\bshutdown\b/i,
  /\breboot\b/i,
];

/**
 * PowerShell cleanup script: BFS the full process tree by walking Win32_Process
 * ParentProcessId links (works even after the root shell has already EXITED, unlike
 * taskkill /T), then force-kill every discovered PID.
 */
function buildWindowsCleanupScript(rootPid: number): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$targets = [System.Collections.Generic.List[int]]::new()
$targets.Add(${rootPid})
$stack = [System.Collections.Generic.Stack[int]]::new()
$stack.Push(${rootPid})
$seen = [System.Collections.Generic.HashSet[int]]::new([int[]]@(${rootPid}))
$byParent = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $pp = [int]$_.ParentProcessId
  $cid = [int]$_.ProcessId
  if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = @() }
  $byParent[$pp] += $cid
}
while ($stack.Count -gt 0) {
  $cur = $stack.Pop()
  if ($byParent.ContainsKey($cur)) {
    foreach ($child in $byParent[$cur]) {
      if ($seen.Add($child)) { $stack.Push($child); $targets.Add($child) }
    }
  }
}
foreach ($id in $targets) { taskkill /F /PID $id 2>$null | Out-Null }
`.trim();
}

/** Kill the process and its whole descendant tree (best effort, never throws). */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;

  try {
    if (os.platform() === 'win32') {
      // Fast path: kills the tree while the root shell is still alive.
      try {
        spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
      } catch {}

      // Sweep path: taskkill /T fails once the parent shell has exited, leaving
      // orphans behind (e.g. `start /B node server.js`). So we also walk the
      // Win32_Process parent links from the (dead) shell PID and kill each node.
      try {
        spawn(
          'powershell',
          ['-NoProfile', '-Command', buildWindowsCleanupScript(pid)],
          { windowsHide: true, stdio: 'ignore' }
        );
      } catch {}
    } else {
      // Spawned with detached:true -> we own a process group; negative PID kills the
      // whole group even after the shell itself has exited.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    // Process already gone - nothing to clean up.
  }
}

export function executeCommand(command: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    // --- Guard 1: directory jail -------------------------------------------
    if (referencesPathOutsideRoot(command)) {
      return resolve({
        stdout: '',
        stderr: `[Security Error] Command blocked by sandbox: it references an absolute path outside the workspace root. Only operations within the project directory are permitted.`,
        exitCode: SANDBOX_EXIT_CODES.BLOCKED,
      });
    }

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return resolve({
          stdout: '',
          stderr: `[Security Error] Command blocked by sandbox safety filter: matched dangerous pattern.`,
          exitCode: SANDBOX_EXIT_CODES.BLOCKED,
        });
      }
    }

    const isWin = os.platform() === 'win32';
    const shell = isWin ? 'cmd.exe' : '/bin/sh';
    const args = isWin ? ['/c', command] : ['-c', command];

    // Never leak API keys/secrets into the child environment.
    const childEnv = { ...process.env };
    delete childEnv.GROQ_API_KEY;

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (result: ExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // --- Guard 2: process-tree cleanup -----------------------------------
      // Even after a normal exit, descendants that outlived the shell (e.g.
      // `start /B node server.js`) are terminated so no orphans/locked ports remain.
      killProcessTree(child);
      resolve(result);
    };

    const child = spawn(shell, args, {
      cwd: WORKSPACE_ROOT, // --- Guard 1: always run inside the jail ---
      windowsHide: true,
      env: childEnv,
      detached: !isWin, // Unix: create its own process group so we can tree-kill
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // --- Guard 3: execution timeout -----------------------------------------
    const timer = setTimeout(() => {
      stderr += `\n[Sandbox Error] Command exceeded the ${timeoutMs}ms execution timeout and has been terminated.`;
      killProcessTree(child);
      settle({ stdout, stderr, exitCode: SANDBOX_EXIT_CODES.TIMEOUT });
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('exit', (code) => {
      // Grandchildren may hold our stdio pipes open and delay 'close' indefinitely
      // (e.g. `start /B node server.js`), so settle shortly after the shell exits.
      setTimeout(() => {
        settle({ stdout, stderr, exitCode: code ?? 0 });
      }, 150);
    });

    // Immediate settle if the streams actually close first.
    child.on('close', (code) => {
      settle({ stdout, stderr, exitCode: code ?? 0 });
    });

    child.on('error', (err) => {
      stderr += `\n[Sandbox Error] ${err.message}`;
      settle({ stdout, stderr, exitCode: SANDBOX_EXIT_CODES.BLOCKED });
    });
  });
}
