import 'dotenv/config';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { collectGitSnapshot, collectCiSnapshot, runGitStatus, runGitLog, type GitSnapshot } from './mcp/gitTools.js';
import { ensureAuditFixture, FIXTURE_MANIFEST } from './mcp/auditFixture.js';
import { readFileContent } from './engine/fileSystem.js';
import {
  runSecurityAuditor,
  runQualityReviewer,
  runDependencyChecker,
  runStaticSecurityScan,
  runStaticQualityScan,
  runStaticDependencyScan,
  mergeFindings,
  type AuditFinding,
  type PersonaAudit,
  type ReviewedFile,
} from './mcp/auditor.js';
import { renderMarkdownReport, writeReport, resolveMergeStatus, REPORT_FILENAME } from './mcp/reporter.js';
import { postOrUpdateAuditComment, extractVerdict } from './mcp/githubCommenter.js';
import { runAutoFixer, isStaleDependencyFinding, type AutoFixResult } from './mcp/autofixer.js';
import { runCoderAgent } from './mcp/coderAgent.js';
import { listWorkspaceFiles } from './mcp/workspaceTools.js';

/**
 * Multi-Agent PR Reviewer & Security Auditor - end-to-end pipeline.
 *
 * LOCAL mode (default):
 *   Audits the real latest commit (diff HEAD~1) -> agents -> report.
 *   On a fresh repo - or with `--demo` - a vulnerable 2-commit fixture
 *   history is seeded instead.
 *   Pass `--auto-fix` (or env HYPERDEV_AUTO_FIX=true) to attempt self-healing
 *   of Critical/High findings, then re-scan and re-issue the final report.
 *
 * CI mode (GITHUB_ACTIONS=true):
 *   Diffs HEAD against origin/<GITHUB_BASE_REF>, audits the PR, posts the
 *   report as a PR comment, and exits 1 when the final verdict is BLOCK.
 *
 * DEV MODE (--dev-mode | --build "<prompt>"):
 *   Autonomous workspace builder ("AntiGravity-Lite"): plans a file tree,
 *   writes the project under generated_app/, installs dependencies, runs
 *   build checks through the sandbox, and self-corrects on errors.
 */

const IS_CI = process.env.GITHUB_ACTIONS === 'true';

const DEFAULT_DEV_REQUEST =
  'Build a small runnable Node.js + Express TODO API inside generated_app/: ' +
  'package.json (express dependency, start script), server file exposing ' +
  'list/create/complete/delete endpoints with in-memory storage, and a README.md.';

/** Everything the coder agent writes lands exclusively in this folder. */
const GENERATED_DIR = 'generated_app';

/** DEV-MODE audit - load every generated file (untracked, so no git diff here). */
async function loadGeneratedFiles(dir: string): Promise<ReviewedFile[]> {
  const relFiles = (await listWorkspaceFiles(dir, { maxDepth: 6, maxEntries: 200 })).filter((f) => !f.endsWith('/'));
  const reviewed: ReviewedFile[] = [];
  for (const rel of relFiles) {
    try {
      reviewed.push({ path: rel, content: await readFileContent(rel) });
    } catch (err) {
      console.warn(`[DevAudit] skip ${rel}: ${(err as Error).message}`);
    }
  }
  return reviewed;
}

/** Deterministic scans over generated code (fast, LLM-independent). */
async function staticScanGenerated(reviewed: ReviewedFile[]): Promise<AuditFinding[]> {
  const manifestFile = reviewed.find((f) => f.path.endsWith('package.json'));
  const manifest = manifestFile
    ? await readFileContent(manifestFile.path).catch(() => '{"dependencies":{}}')
    : '{"dependencies":{}}';
  const sec = runStaticSecurityScan(reviewed);
  const qual = runStaticQualityScan(reviewed);
  const dep = manifestFile ? runStaticDependencyScan(manifestFile.path, manifest) : [];
  return [...sec, ...qual, ...dep].sort(severityComparer);
}

/** One full audit pass over the generated workspace (static + all LLM personas). */
async function auditGeneratedCode(
  dir: string
): Promise<{ findings: AuditFinding[]; llmAudits: Array<PersonaAudit | null> }> {
  const reviewed = await loadGeneratedFiles(dir);
  console.log(`[DevAudit] ${reviewed.length} generated file(s) under review.`);

  const staticFindings = await staticScanGenerated(reviewed);
  console.log(`[DevAudit] Static scans: ${staticFindings.length} finding(s).`);

  console.log('[DevAudit] Running LLM personas on the generated code...');
  const security = await runSecurityAuditor('(newly generated files - full contents below)', reviewed);
  const quality = await runQualityReviewer('(newly generated files - full contents below)', reviewed);
  const manifestFile = reviewed.find((f) => f.path.endsWith('package.json'));
  const dependency = manifestFile
    ? await runDependencyChecker([{ path: manifestFile.path, content: manifestFile.content }])
    : null;

  const llmFindings = mergeFindings([security, quality, dependency]).filter((f) => !isStaleDependencyFinding(f));
  console.log(`[DevAudit] LLM personas: ${llmFindings.length} finding(s).`);

  return {
    findings: [...staticFindings, ...llmFindings].sort(severityComparer),
    llmAudits: [security, quality, dependency],
  };
}

/** Post-fix refresh: static re-scan of fresh files + stale LLM findings for untouched files. */
async function refreshDevFindings(
  dir: string,
  llmAudits: Array<PersonaAudit | null>,
  fixedFiles: Set<string>
): Promise<AuditFinding[]> {
  const fresh = await staticScanGenerated(await loadGeneratedFiles(dir));
  const staleLlm = mergeFindings(llmAudits).filter(
    (f) => !fixedFiles.has(f.file) && !isStaleDependencyFinding(f)
  );
  return [...staleLlm, ...fresh].sort(severityComparer);
}

/** Writes the dev-mode audit report with the same enterprise format. */
async function writeDevReport(findings: AuditFinding[], autoFixNote?: string): Promise<void> {
  const files = await listWorkspaceFiles(GENERATED_DIR, { maxDepth: 6, maxEntries: 200 });
  await writeReport(
    renderMarkdownReport(findings, {
      generatedAt: new Date(),
      reviewedFiles: files,
      personasRan: [
        ...new Set([
          ...findings.map((f) => f.persona),
          'Security Auditor',
          'Code Quality Reviewer',
          'Dependency Checker',
        ]),
      ],
      autoFixNote,
    })
  );
}

/** Dev-mode entry: autonomous code generation instead of the audit pipeline. */
async function runDevMode(prompt: string, autoFixRequested: boolean = false): Promise<void> {
  console.log('=========================================================');
  console.log(' HyperDev Autonomous Developer Agent - DEV MODE');
  console.log('=========================================================');
  console.log(` Request: ${prompt}\n`);

  if (!process.env.GROQ_API_KEY) {
    console.error('[DevMode] GROQ_API_KEY is required for the autonomous developer - set it in .env first.');
    process.exitCode = 1;
    return;
  }

  // --- Clean slate: every build starts from an empty generated_app/ ---------
  // Stale files from previous runs (different prompts, abandoned attempts)
  // otherwise pollute the DevAudit review set and trigger false Criticals.
  // generated_app/ is git-ignored and disposable by design.
  try {
    await rm(path.join(process.cwd(), GENERATED_DIR), { recursive: true, force: true });
    console.log('[DevMode] Cleaned generated_app/ - building on a fresh slate.\n');
  } catch (err) {
    console.warn(`[DevMode] Could not clean generated_app/ (${(err as Error).message}) - continuing.`);
  }

  const result = await runCoderAgent(prompt);

  console.log('\n=========================================================');
  console.log(` DEV RUN ${result.completed ? 'COMPLETE ✅' : result.aborted ? 'ABORTED 🟠' : 'INCOMPLETE 🔶'}`);
  console.log('=========================================================');
  console.log(` Steps used:      ${result.stepsUsed}`);
  console.log(` Files written:   ${result.filesWritten.length}`);
  for (const file of result.filesWritten) console.log(`   - ${file}`);
  console.log(` Commands run:    ${result.commandsRun.length}`);
  if (result.finalCheck) {
    console.log(` Final check:     ${result.finalCheck.command} -> ${result.finalCheck.passed ? 'PASSED ✅' : 'FAILED ❌'}`);
  }
  for (const note of result.notes) console.log(` note: ${note}`);

  if (!result.completed) {
    for (const note of result.notes) console.log(` note: ${note}`);
    process.exitCode = 1;
    return;
  }

  // --- Instant Security Audit + opt-in self-healing of the generated code ---
  console.log('\n=========================================================');
  console.log(' DevAudit - Security Auditor on the freshly generated code');
  console.log('=========================================================');

  const firstPass = await auditGeneratedCode(GENERATED_DIR);
  let findings = firstPass.findings;
  await writeDevReport(findings);

  let verdict = resolveMergeStatus(findings);
  console.log(` DevAudit verdict: ${verdict.verdict === 'BLOCK' ? '🚫 BLOCK' : '🟢 PASS'} - ${verdict.reason}`);

  const hasBlocking = findings.some((f) => f.severity === 'Critical' || f.severity === 'High');
  if (autoFixRequested && hasBlocking) {
    console.log('\n[DevAudit] --auto-fix active - self-healing the generated code...');
    const fixResult = await runAutoFixer(findings);

    for (const outcome of fixResult.outcomes) {
      const icon =
        outcome.status === 'fixed' ? '✅' :
        outcome.status === 'rolledback' ? '↩️' :
        outcome.status === 'unchanged' ? '➖' : '❌';
      console.log(`[DevAudit] ${icon} [${outcome.severity}] ${outcome.title} (${outcome.file}) -> ${outcome.status}`);
    }

    if (fixResult.fixed > 0) {
      const fixedFiles = new Set(fixResult.outcomes.filter((o) => o.status === 'fixed').map((o) => o.file));
      findings = await refreshDevFindings(GENERATED_DIR, firstPass.llmAudits, fixedFiles);
      await writeDevReport(
        findings,
        `${fixResult.fixed} fix(es) applied, ${fixResult.rolledback} rolled back, ${fixResult.failed} failed.`
      );
      verdict = resolveMergeStatus(findings);
      console.log(`\n DevAudit post-fix verdict: ${verdict.verdict === 'BLOCK' ? '🚫 BLOCK' : '🟢 PASS'} - ${verdict.reason}`);
    }
  } else if (autoFixRequested) {
    console.log('\n[DevAudit] Nothing to auto-fix (no Critical/High findings).');
  }

  console.log('\n=========================================================');
  if (verdict.verdict === 'BLOCK') {
    console.log(' SECURE DELIVERY BLOCKED 🚫 - fix the findings above before shipping.');
    process.exitCode = 1;
  } else {
    console.log(' SECURE DELIVERY COMPLETE ✅ - generated code passed the audit.');
    console.log(' Report: PR_SECURITY_AUDIT_REPORT.md | Files: generated_app/');
  }
  console.log('=========================================================');
}

const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 } as const;

function severityComparer(a: AuditFinding, b: AuditFinding): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
}

async function loadReviewedFiles(changedFiles: { path: string }[]): Promise<ReviewedFile[]> {
  const reviewed: ReviewedFile[] = [];
  for (const changed of changedFiles) {
    // Never review our own generated artifacts - the report contains matched
    // vulnerability patterns and would only produce self-referential noise.
    if (changed.path.endsWith('package-lock.json') || changed.path === REPORT_FILENAME) continue;
    try {
      reviewed.push({ path: changed.path, content: await readFileContent(changed.path) });
    } catch (err) {
      console.warn(`[Pipeline] Could not read changed file ${changed.path}:`, (err as Error).message);
    }
  }
  return reviewed;
}

async function collectSnapshot(): Promise<GitSnapshot> {
  if (IS_CI) {
    const baseRef = process.env.GITHUB_BASE_REF || 'main';
    console.log(`\n[Git] CI mode: diffing HEAD against origin/${baseRef}...`);
    return collectCiSnapshot(baseRef);
  }
  // Local: audits the real latest commit by default; `--demo` re-seeds the
  // vulnerable fixture pair instead.
  const args = process.argv.slice(2);
  await ensureAuditFixture(args.includes('--demo'));
  console.log('\n[Git] Collecting snapshot (status / diff HEAD~1 / log -n 5)...');
  return collectGitSnapshot();
}

/** Post-fix refresh: LLM findings for untouched files + fresh deterministic scans. */
async function buildPostFixFindings(
  llmAudits: Array<PersonaAudit | null>,
  fixedFiles: Set<string>,
  changedFiles: { path: string }[],
  manifestPath: string
): Promise<AuditFinding[]> {
  const freshFiles = await loadReviewedFiles(changedFiles);

  const staleLlm = mergeFindings(llmAudits).filter((f) => !fixedFiles.has(f.file));
  const staticSec = runStaticSecurityScan(freshFiles);
  const staticQual = runStaticQualityScan(freshFiles);
  const staticDep = runStaticDependencyScan(manifestPath, manifestPath === 'package.json'
    ? await readFileContent(manifestPath).catch(() => '{"dependencies":{}}')
    : '{"dependencies":{}}');

  const merged = [...staleLlm, ...staticSec, ...staticQual, ...staticDep].filter(
    (f) => !isStaleDependencyFinding(f) // LLM manifest hallucination guard
  );

  merged.sort(severityComparer);
  return merged;
}

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  const buildFlagIdx = cliArgs.indexOf('--build');

  // --- Dev mode: autonomous workspace builder -------------------------------
  if (cliArgs.includes('--dev-mode') || buildFlagIdx !== -1) {
    const prompt =
      buildFlagIdx !== -1
        ? cliArgs.slice(buildFlagIdx + 1).join(' ').replace(/\s+--\w+.*$/, '').trim()
        : '';
    if (buildFlagIdx !== -1 && !prompt) {
      console.error('[DevMode] --build requires a prompt, e.g. --build "Build a TODO app".');
      process.exitCode = 1;
      return;
    }
    await runDevMode(
      prompt || DEFAULT_DEV_REQUEST,
      cliArgs.includes('--auto-fix') || process.env.HYPERDEV_AUTO_FIX === 'true'
    );
    return;
  }

  console.log('=========================================================');
  console.log(' HyperDev Multi-Agent PR Reviewer & Security Auditor');
  console.log(` Mode: ${IS_CI ? 'CI (GitHub Actions PR audit)' : 'Local (latest commit audit)'}`);
  console.log('=========================================================');

  const autoFixRequested = cliArgs.includes('--auto-fix') || process.env.HYPERDEV_AUTO_FIX === 'true';

  if (!process.env.GROQ_API_KEY) {
    console.warn('[Warning] GROQ_API_KEY missing - LLM personas will be skipped, static scanners only.');
  }

  // --- Step 1: git snapshot ------------------------------------------------
  const snapshot = await collectSnapshot();
  if (!snapshot.available) {
    throw new Error('Git snapshot unavailable - cannot run the audit pipeline.');
  }

  const status = await runGitStatus();
  const log = await runGitLog(5);
  console.log(`\n[Git] status:\n${status.stdout.trim()}`);
  console.log(`\n[Git] recent history:\n${log.stdout.trim()}`);
  console.log(`\n[Git] ${snapshot.changedFiles.length} file(s) changed:`);
  for (const f of snapshot.changedFiles) console.log(`      - ${f.path}`);
  console.log(`\n[Git] diff size: ${snapshot.diff.length} chars`);

  // --- Step 2: audits -------------------------------------------------------
  const reviewedFiles = await loadReviewedFiles(snapshot.changedFiles);
  const manifest = await readFileContent(FIXTURE_MANIFEST).catch(() => '{"dependencies":{}}');

  console.log('\n[Auditor] Running static security scan...');
  const staticSec = runStaticSecurityScan(reviewedFiles);
  console.log(`[Auditor] Static security scan: ${staticSec.length} finding(s).`);

  console.log('[Auditor] Running static quality scan...');
  const staticQual = runStaticQualityScan(reviewedFiles);
  console.log(`[Auditor] Static quality scan: ${staticQual.length} finding(s).`);

  console.log('[Auditor] Running static dependency scan...');
  const staticDep = runStaticDependencyScan(FIXTURE_MANIFEST, manifest);
  console.log(`[Auditor] Static dependency scan: ${staticDep.length} finding(s).`);

  console.log('\n[Auditor] Running LLM personas (Security Auditor)...');
  const security = await runSecurityAuditor(snapshot.diff, reviewedFiles);
  console.log(`[Auditor] Security Auditor: ${security?.findings.length ?? 0} finding(s). ${security?.summary ?? ''}`.trim());

  console.log('[Auditor] Running LLM personas (Code Quality Reviewer)...');
  const quality = await runQualityReviewer(snapshot.diff, reviewedFiles);
  console.log(`[Auditor] Code Quality Reviewer: ${quality?.findings.length ?? 0} finding(s). ${quality?.summary ?? ''}`.trim());

  console.log('[Auditor] Running LLM personas (Dependency Checker)...');
  const dependency = await runDependencyChecker([{ path: FIXTURE_MANIFEST, content: manifest }]);
  console.log(`[Auditor] Dependency Checker: ${dependency?.findings.length ?? 0} finding(s). ${dependency?.summary ?? ''}`.trim());

  let findings: AuditFinding[] = mergeFindings([security, quality, dependency]);
  findings.unshift(...[...staticSec, ...staticQual, ...staticDep]);
  findings.sort(severityComparer);
  findings = findings.filter((f) => !isStaleDependencyFinding(f));

  console.log(`\n[Auditor] Total merged findings: ${findings.length}`);

  // --- Step 3: report -------------------------------------------------------
  const renderReport = (fs: AuditFinding[], autoFixNote?: string): string =>
    renderMarkdownReport(fs, {
      generatedAt: new Date(),
      reviewedFiles: snapshot.changedFiles.map((f) => f.path),
      personasRan: [
        ...new Set([
          ...fs.map((f) => f.persona),
          'Security Auditor',
          'Code Quality Reviewer',
          'Dependency Checker',
        ]),
      ],
      autoFixNote,
    });

  let markdown = renderReport(findings);
  await writeReport(markdown);

  let verdict = resolveMergeStatus(findings);
  console.log('\n=========================================================');
  console.log(` AUDIT COMPLETE - VERDICT: ${verdict.verdict === 'BLOCK' ? '🚫 BLOCK' : '🟢 PASS'}`);
  console.log(` ${verdict.reason}`);
  console.log(` Full report: ${REPORT_FILENAME}`);
  console.log('=========================================================');

  // --- Step 4: opt-in Auto-Fixer self-healing -------------------------------
  const hasBlockingFindings = findings.some((f) => f.severity === 'Critical' || f.severity === 'High');
  if (autoFixRequested && hasBlockingFindings) {
    console.log('\n[Auto-Fixer] --auto-fix requested and blocking findings present - self-healing run starting...');
    const fixResult: AutoFixResult = await runAutoFixer(findings);

    for (const outcome of fixResult.outcomes) {
      const icon =
        outcome.status === 'fixed' ? '✅' :
        outcome.status === 'rolledback' ? '↩️' :
        outcome.status === 'unchanged' ? '➖' : '❌';
      console.log(`[Auto-Fixer] ${icon} [${outcome.severity}] ${outcome.title} (${outcome.file}) -> ${outcome.status}`);
      if (outcome.explanation) console.log(`    ${outcome.explanation.slice(0, 400)}`);
    }
    for (const note of fixResult.notes) console.log(`[Auto-Fixer] note: ${note}`);

    if (fixResult.committed) {
      console.log(`[Auto-Fixer] Committed patched files: ${fixResult.commitMessage}`);
    }

    if (fixResult.fixed > 0) {
      console.log('\n[Auto-Fixer] Re-scanning after fixes to refresh the verdict...');
      const fixedFiles = new Set(
        fixResult.outcomes.filter((o) => o.status === 'fixed').map((o) => o.file)
      );
      findings = await buildPostFixFindings(
        [security, quality, dependency],
        fixedFiles,
        snapshot.changedFiles,
        FIXTURE_MANIFEST
      );

      markdown = renderReport(
        findings,
        `${fixResult.fixed} fix(es) applied, ${fixResult.rolledback} rolled back, ${fixResult.failed} failed${
          fixResult.committed ? `; committed as ${fixResult.commitMessage}` : ''
        }.`
      );
      await writeReport(markdown);

      verdict = resolveMergeStatus(findings);
      console.log('\n=========================================================');
      console.log(` POST-FIX AUDIT - VERDICT: ${verdict.verdict === 'BLOCK' ? '🚫 BLOCK' : '🟢 PASS'}`);
      console.log(` ${verdict.reason}`);
      console.log('=========================================================');
    } else {
      console.log('\n[Auto-Fixer] No fixes could be applied - verdict unchanged.');
    }
  } else if (autoFixRequested) {
    console.log('\n[Auto-Fixer] Nothing to auto-fix (no Critical/High findings).');
  }

  // --- Step 5: CI integration (PR comment + merge enforcement) --------------
  if (IS_CI) {
    const comment = await postOrUpdateAuditComment(markdown);
    if (!comment.posted) console.warn(`[CI] PR comment step: ${comment.reason}`);

    const ciVerdict = extractVerdict(markdown) ?? verdict.verdict;
    if (ciVerdict === 'BLOCK') {
      console.error('\n[CI] Merge BLOCKED by the multi-agent audit (see the PR comment for details).');
      process.exitCode = 1;
      return;
    }
    console.log('\n[CI] Audit passed - merge allowed.');
  }
}

main().catch((err) => {
  console.error('Fatal error in audit pipeline:', err);
  // Use exitCode instead of process.exit(): an abrupt exit amid pending libuv
  // handles (sandbox pipes) can crash with a UV_HANDLE_CLOSING assertion.
  process.exitCode = 1;
});
