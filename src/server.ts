import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import express from 'express';
import { WORKSPACE_ROOT } from './engine/sandbox.js';
import { readFileContent } from './engine/fileSystem.js';
import { listWorkspaceFiles } from './mcp/workspaceTools.js';
import { REPORT_FILENAME } from './mcp/reporter.js';

/**
 * HyperDev Workspace UI - Express backend.
 *
 * The dashboard launches the full unified pipeline (coder agent + instant
 * security audit + auto-fix) as the SAME production CLI subprocess
 * (`npx tsx src/index.ts --build "<prompt>" --auto-fix`) and streams its
 * terminal output to the browser over Server-Sent Events. Everything the
 * pipeline does stays inside the hardened sandbox exactly as in the CLI,
 * and the generated project is git-ignored under `generated_app/`.
 *
 * Endpoints:
 *   POST /api/build  { prompt, autoFix? }  - start a run (409 if busy)
 *   GET  /api/stream                       - SSE: live log + status events
 *   GET  /api/status                       - current run state
 *   GET  /api/tree                         - generated_app file hierarchy
 *   GET  /api/file?path=...                - one generated source file
 *   GET  /api/report                       - PR_SECURITY_AUDIT_REPORT.md
 */

const GENERATED_DIR = 'generated_app';
const PORT = Number(process.env.PORT ?? 3_000);
const MAX_REPORT_CHARS = 400_000;

type RunStatus = 'idle' | 'running' | 'done' | 'failed';

interface RunState {
  status: RunStatus;
  prompt?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
}

let current: RunState = { status: 'idle' };
let child: ChildProcess | null = null;
/** Replayed to freshly (re)connecting SSE clients so nothing is lost on refresh. */
const logHistory: string[] = [];
const MAX_HISTORY_LINES = 800;

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

type SseClient = import('express').Response;
const sseClients = new Set<SseClient>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client); // dead connection - drop it
    }
  }
}

function pushLog(line: string): void {
  logHistory.push(line);
  if (logHistory.length > MAX_HISTORY_LINES) logHistory.shift();
  broadcast('log', line);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(WORKSPACE_ROOT, 'public', 'index.html'));
});

/** Live event stream (with replay for reconnects). */
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: status\ndata: ${JSON.stringify(current)}\n\n`);
  for (const line of logHistory) res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/status', (_req, res) => {
  res.json(current);
});

/** Starts the unified build + audit pipeline as the production CLI subprocess. */
app.post('/api/build', (req, res) => {
  const body = req.body as { prompt?: unknown; autoFix?: unknown };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    res.status(400).json({ error: 'A non-empty "prompt" is required.' });
    return;
  }
  if (current.status === 'running' || child !== null) {
    res.status(409).json({ error: 'A build is already running - wait for it to finish.' });
    return;
  }

  const autoFix = body.autoFix !== false; // opt-out only
  // Defensive strip: with no shell involved argv needs no quoting, but keeping
  // prompts shell-clean also keeps downstream logs/reports tidy.
  const safePrompt = prompt.replace(/["`$]/g, ' ').trim();

  // Spawn node.exe directly on tsx's CLI entry - NEVER npx.cmd with shell:true.
  // The workspace folder name contains "&" ("Multi-Agent PR Reviewer & Security
  // Auditor"); cmd.exe parses that as a command separator and mangles the whole
  // launch line. Spawning a real .exe with plain argv avoids cmd.exe entirely
  // (and the Node 24 DEP0190 args-with-shell deprecation).
  const tsxEntry = path.join(WORKSPACE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const args = [tsxEntry, 'src/index.ts', '--build', safePrompt];
  if (autoFix) args.push('--auto-fix');

  logHistory.length = 0;
  current = { status: 'running', prompt, startedAt: new Date().toISOString() };
  broadcast('status', current);
  pushLog(`$ node ${path.relative(WORKSPACE_ROOT, tsxEntry)} src/index.ts --build "${safePrompt}"${autoFix ? ' --auto-fix' : ''}`);
  res.json({ started: true, pid: null });

  try {
    child = spawn(process.execPath, args, {
      cwd: WORKSPACE_ROOT,
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    child = null;
    current = { ...current, status: 'failed', finishedAt: new Date().toISOString() };
    broadcast('status', current);
    pushLog(`[server] failed to spawn pipeline: ${(err as Error).message}`);
    return;
  }

  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const lines = readline.createInterface({ input: stream });
    lines.on('line', (line) => pushLog(line));
  }

  child.on('error', (err) => {
    pushLog(`[server] failed to spawn pipeline: ${err.message}`);
    current = { ...current, status: 'failed', finishedAt: new Date().toISOString() };
    broadcast('status', current);
    child = null;
  });

  child.on('close', (code) => {
    const exitCode = code ?? -1;
    pushLog(`[server] pipeline exited with code ${exitCode}`);
    current = {
      ...current,
      status: exitCode === 0 ? 'done' : 'failed',
      finishedAt: new Date().toISOString(),
      exitCode,
    };
    broadcast('status', current);
    child = null;
  });
});

/** Generated project hierarchy for the file-tree explorer. */
app.get('/api/tree', async (_req, res) => {
  try {
    const files = await listWorkspaceFiles(GENERATED_DIR, { maxDepth: 6, maxEntries: 300 });
    res.json({ dir: GENERATED_DIR, files });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Serves a single generated source file (jail: only under generated_app/). */
app.get('/api/file', async (req, res) => {
  const rel = String(req.query.path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const safeDir = `${GENERATED_DIR}/`;
  if (!rel.startsWith(safeDir) || rel.split('/').includes('..') || rel === GENERATED_DIR) {
    res.status(400).json({ error: `Only files under ${safeDir} can be served.` });
    return;
  }
  try {
    const content = await readFileContent(rel);
    res.type('text/plain; charset=utf-8').send(content.slice(0, 400_000));
  } catch {
    res.status(404).json({ error: `File not found: ${rel}` });
  }
});

/** The latest audit report (written by the pipeline's DevAudit stage). */
app.get('/api/report', async (_req, res) => {
  try {
    const markdown = await readFile(path.join(WORKSPACE_ROOT, REPORT_FILENAME), 'utf-8');
    res.type('text/markdown; charset=utf-8').send(markdown.slice(0, MAX_REPORT_CHARS));
  } catch {
    res.status(404).json({ error: `No ${REPORT_FILENAME} yet - run a build first.` });
  }
});

const server = app.listen(PORT, () => {
  console.log(`HyperDev Workspace UI ready -> http://localhost:${PORT}`);
  console.log('Open the URL in your browser, type a feature prompt, press "Build & Secure".');
});

function shutdown(): void {
  if (child) {
    child.kill();
    child = null;
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
