import { existsSync, readFileSync } from 'node:fs';
import { createOrUpdateFile, readFileContent } from '../engine/fileSystem.js';
import { executeCommand } from '../engine/sandbox.js';
import { AUDIT_MODEL, extractJsonBlock, getGroq, type AuditFinding } from './auditor.js';

/**
 * Auto-Fixer agent (self-healing).
 *
 * Flow:
 *   1. Receives findings; considers Critical / High severity actionable.
 *   2. For each finding asks the Groq LLM (`openai/gpt-oss-120b`) for a minimally
 *      edited, fully patched file (strict JSON contract).
 *   3. Applies the patch via `createOrUpdateFile`.
 *   4. Verifies the fix compiled with `npx tsc --noEmit` through the hardened
 *      sandbox - on failure the patch is rolled back to the previous content.
 *   5. Optionally runs `npm test` when a test script exists.
 *   6. Optionally commits the patched files to git (skipped in CI where the
 *      pull_request token cannot push).
 */

export type FixStatus = 'fixed' | 'unchanged' | 'failed' | 'rolledback';

export interface FixOutcome {
  severity: string;
  title: string;
  file: string;
  status: FixStatus;
  explanation?: string;
}

export interface AutoFixResult {
  attempted: number;
  fixed: number;
  unchanged: number;
  failed: number;
  rolledback: number;
  compilesAfterFixes: boolean;
  testsAttempted: boolean;
  testsPassed: boolean;
  committed: boolean;
  commitMessage?: string;
  outcomes: FixOutcome[];
  notes: string[];
}

const AUTO_FIX_SYSTEM = `You are the AUTO-FIXER agent in the HyperDev multi-agent PR pipeline.
You receive an audit finding and the FULL current content of one source file.
Produce the corrected version of that file.

STRICT RULES:
1. Respond ONLY with a JSON object, no markdown fences, exactly:
   { "patchedFile": "<the complete corrected file content>", "explanation": "<what you changed and why>" }
2. Make MINIMAL edits - only what is needed to resolve the finding. Do not reformat unrelated code.
3. Never introduce new hardcoded secrets, new dependencies, or new vulnerabilities.
4. Keep existing exports and function signatures intact so the rest of the codebase keeps compiling.
5. Fix security issues with idiomatic solutions: parameterized queries, DOMPurify/textContent,
   execFile/spawn with argument arrays, bcrypt/argon2, process.env for secrets, try/catch where warranted.`;

interface PatchResponse {
  patchedFile?: string;
  explanation?: string;
}

async function generatePatchedFile(
  finding: AuditFinding,
  originalContent: string
): Promise<{ patchedFile: string; explanation: string } | null> {
  const groq = getGroq();
  if (!groq) return null;

  const userPayload =
    `AUDIT FINDING:\n` +
    `- severity: ${finding.severity}\n` +
    `- title: ${finding.title}\n` +
    `- file: ${finding.file}\n` +
    `- lines: ${finding.lines ?? 'n/a'}\n` +
    `- description: ${finding.description}\n` +
    `- suggestedFix: ${finding.suggestedFix ?? 'n/a'}\n\n` +
    `CURRENT FILE CONTENT (${finding.file}):\n\n${originalContent.slice(0, 9_000)}`;

  const response = await groq.chat.completions.create({
    model: AUDIT_MODEL,
    messages: [
      { role: 'system', content: AUTO_FIX_SYSTEM },
      { role: 'user', content: userPayload },
    ],
    temperature: 0.1,
  });

  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = extractJsonBlock(raw) as PatchResponse | null;
  if (!parsed || typeof parsed.patchedFile !== 'string' || parsed.patchedFile.trim() === '') return null;

  return { patchedFile: parsed.patchedFile, explanation: parsed.explanation ?? '' };
}

/** Compile-verification through the hardened sandbox. */
async function verifyBuild(file: string): Promise<{ ok: boolean; output: string }> {
  const tsc = await executeCommand('npx tsc --noEmit', 180_000);
  if (tsc.exitCode !== 0) {
    return { ok: false, output: `${tsc.stdout}\n${tsc.stderr}`.slice(-2_000) };
  }

  // Files outside src/ are not covered by the project tsconfig `include`,
  // so compile them explicitly to keep the fixture-style code checked too.
  // `--ignoreConfig` is required by TS 7 when files are given on the CLI.
  const underSrc = file.replace(/\\/g, '/').includes('/src/');
  if (!underSrc) {
    const single = await executeCommand(
      `npx tsc --noEmit --ignoreConfig --strict --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext --types node ${file}`,
      180_000
    );
    return { ok: single.exitCode === 0, output: `${single.stdout}\n${single.stderr}`.slice(-2_000) };
  }

  return { ok: true, output: '' };
}

async function runTestsIfDefined(): Promise<{ attempted: boolean; passed: boolean; output: string }> {
  try {
    const manifestRaw = await readFileContent('package.json');
    const manifest = JSON.parse(manifestRaw) as { scripts?: { test?: string } };
    if (!manifest.scripts?.test) {
      return { attempted: false, passed: false, output: 'No npm test script defined - skipped.' };
    }
    const res = await executeCommand('npm test', 180_000);
    return {
      attempted: true,
      passed: res.exitCode === 0,
      output: `${res.stdout}\n${res.stderr}`.slice(-2_000),
    };
  } catch (err) {
    return { attempted: false, passed: false, output: `Test step skipped: ${(err as Error).message}` };
  }
}

async function commitAutoFix(files: string[]): Promise<{ committed: boolean; commitMessage?: string; note?: string }> {
  if (process.env.GITHUB_ACTIONS === 'true') {
    return {
      committed: false,
      note: 'Running in CI (pull_request) - push access is not assumed; patched files were left in the working tree instead.',
    };
  }

  const insideWorkTree = await executeCommand('git rev-parse --is-inside-work-tree', 15_000);
  if (insideWorkTree.exitCode !== 0 || !insideWorkTree.stdout.includes('true')) {
    return { committed: false, note: 'Not a git work tree - patched files were left uncommitted.' };
  }

  const identity = '-c user.name=HyperDevAutoFixer -c user.email=autofixer@hyperdev.local';
  const message = `autofix_self_healing_patch_${Date.now()}`;

  const add = await executeCommand(`git add ${files.join(' ')}`, 30_000);
  if (add.exitCode !== 0) {
    return { committed: false, note: `git add failed: ${add.stderr.trim()}` };
  }

  const commit = await executeCommand(`git ${identity} commit -m ${message}`, 30_000);
  if (commit.exitCode !== 0) {
    return { committed: false, note: `git commit failed: ${commit.stdout.trim()} ${commit.stderr.trim()}` };
  }

  return { committed: true, commitMessage: message };
}

function isAutoFixable(finding: AuditFinding): boolean {
  const criticalOrHigh = finding.severity === 'Critical' || finding.severity === 'High';
  const hasTarget =
    !!finding.file && finding.file !== 'n/a' && finding.file !== 'package.json' && finding.file !== 'unknown';
  return criticalOrHigh && hasTarget;
}

export async function runAutoFixer(findings: AuditFinding[]): Promise<AutoFixResult> {
  const notes: string[] = [];
  const outcomes: FixOutcome[] = [];

  const fixable = findings.filter(isAutoFixable);
  if (fixable.length === 0) {
    return {
      attempted: 0, fixed: 0, unchanged: 0, failed: 0, rolledback: 0,
      compilesAfterFixes: true, testsAttempted: false, testsPassed: false,
      committed: false, outcomes, notes: ['No Critical/High findings with a concrete file to auto-fix.'],
    };
  }

  if (!getGroq()) {
    notes.push('GROQ_API_KEY missing - Auto-Fixer LLM fixes cannot run.');
    return {
      attempted: fixable.length, fixed: 0, unchanged: 0, failed: fixable.length, rolledback: 0,
      compilesAfterFixes: true, testsAttempted: false, testsPassed: false,
      committed: false, outcomes, notes,
    };
  }

  // Rollback snapshots: original content per touched file.
  const originals = new Map<string, string>();
  const touched = new Set<string>();

  for (const finding of fixable) {
    const maxFixes = 25;
    if (outcomes.length >= maxFixes) {
      notes.push(`Reached the ${maxFixes} fix-attempt cap; remaining findings skipped.`);
      break;
    }

    let currentContent: string;
    try {
      currentContent = await readFileContent(finding.file);
    } catch (err) {
      outcomes.push({
        severity: finding.severity, title: finding.title, file: finding.file,
        status: 'failed', explanation: `Could not read file: ${(err as Error).message}`,
      });
      continue;
    }

    if (!originals.has(finding.file)) originals.set(finding.file, currentContent);

    let patched: { patchedFile: string; explanation: string } | null;
    try {
      patched = await generatePatchedFile(finding, currentContent);
    } catch (err) {
      patched = null;
      notes.push(`LLM call failed for "${finding.title}": ${(err as Error).message}`);
    }

    if (!patched) {
      outcomes.push({ severity: finding.severity, title: finding.title, file: finding.file, status: 'failed' });
      continue;
    }
    if (patched.patchedFile.trim() === currentContent.trim()) {
      outcomes.push({
        severity: finding.severity, title: finding.title, file: finding.file,
        status: 'unchanged', explanation: patched.explanation,
      });
      continue;
    }

    await createOrUpdateFile(finding.file, patched.patchedFile);
    touched.add(finding.file);

    const verification = await verifyBuild(finding.file);
    if (!verification.ok) {
      // Rollback this file to the original snapshot and re-verify.
      const snapshot = originals.get(finding.file) ?? currentContent;
      await createOrUpdateFile(finding.file, snapshot);
      const after = await verifyBuild(finding.file);
      outcomes.push({
        severity: finding.severity, title: finding.title, file: finding.file,
        status: 'rolledback',
        explanation:
          `Patch broke the build and was rolled back.\n` +
          `compiler: ${verification.output || '(no output)'}\n` +
          (after.ok ? 'Rollback verified: build compiles again.' : `Rollback still failing: ${after.output}`),
      });
      continue;
    }

    outcomes.push({
      severity: finding.severity, title: finding.title, file: finding.file,
      status: 'fixed', explanation: patched.explanation,
    });
  }

  const fixedFiles = [...new Set(outcomes.filter((o) => o.status === 'fixed').map((o) => o.file))];

  let compiles = true;
  if (touched.size > 0) {
    const final = await executeCommand('npx tsc --noEmit', 180_000);
    compiles = final.exitCode === 0;
    if (!compiles) {
      notes.push(`Final compile check failed even after rollbacks: ${`${final.stdout}${final.stderr}`.slice(-500)}`);
    }
  }

  const tests = await runTestsIfDefined();
  if (tests.output) notes.push(`Tests: ${tests.output.trim()}`);

  let committed = false;
  let commitMessage: string | undefined;
  if (fixedFiles.length > 0 && compiles) {
    const commit = await commitAutoFix(fixedFiles);
    committed = commit.committed;
    commitMessage = commit.commitMessage;
    if (commit.note) notes.push(commit.note);
  }

  const status = (s: FixStatus) => outcomes.filter((o) => o.status === s).length;

  return {
    attempted: fixable.length,
    fixed: status('fixed'),
    unchanged: status('unchanged'),
    failed: status('failed'),
    rolledback: status('rolledback'),
    compilesAfterFixes: compiles,
    testsAttempted: tests.attempted,
    testsPassed: tests.passed,
    committed,
    commitMessage,
    outcomes,
    notes,
  };
}

/**
 * Guards against known LLM false-positive patterns on the manifest:
 *  1. "Missing lockfile" claims when `package-lock.json` actually exists on disk.
 *  2. "Impossible / non-existent version" claims for packages whose claimed
 *     version IS installed locally in node_modules (model knowledge cutoffs age fast).
 */
export function isStaleDependencyFinding(finding: AuditFinding): boolean {
  if (finding.file !== 'package.json') return false;

  if (/lockfile/i.test(finding.title) && existsSync('package-lock.json')) return true;

  const impossibleVersion =
    /(?:impossible|nonexistent|non-existent|does not exist|invalid version|unreal)/i
      .test(`${finding.title} ${finding.description}`);
  if (impossibleVersion) {
    // Finding payload embeds the dependency spec, e.g. `"typescript": "^7.0.2"`.
    const spec =
      (finding.lines ?? '').match(/"([^"]+)"\s*:\s*"([^"]+)"/) ??
      finding.description.match(/"([^"]+)"\s*:\s*"([^"]+)"/);
    if (spec) {
      const [, name, version] = spec;
      const wanted = version.replace(/^[\^~>=<\s]+/, '');
      try {
        const installedPkg = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf-8')) as { version?: string };
        if (installedPkg.version && installedPkg.version.startsWith(wanted)) {
          return true; // local node_modules proves the version installs fine
        }
      } catch {
        // package truly not installed - the LLM finding stands
      }
    }
  }

  return false;
}
