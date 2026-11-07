import 'dotenv/config';
import { collectGitSnapshot, runGitStatus, runGitLog, type DiffFile } from './mcp/gitTools.js';
import { ensureAuditFixture, FIXTURE_FILE, FIXTURE_MANIFEST } from './mcp/auditFixture.js';
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
  type ReviewedFile,
} from './mcp/auditor.js';
import { renderMarkdownReport, writeReport, resolveMergeStatus, REPORT_FILENAME } from './mcp/reporter.js';

/**
 * Multi-Agent PR Reviewer & Security Auditor - end-to-end pipeline:
 *
 *   1. Fixture   : create a real 2-commit git history (vulnerable patch at HEAD).
 *   2. Git tools : status / diff HEAD~1 / log via the hardened sandbox.
 *   3. Agents    : Security Auditor, Code Quality Reviewer, Dependency Checker
 *                  (LLM personas) + deterministic static scanners.
 *   4. Reporter  : PR_SECURITY_AUDIT_REPORT.md with Executive Summary, severity
 *                  breakdown, suggested fixes and a PASS/BLOCK merge verdict.
 */

async function loadReviewedFiles(changedFiles: DiffFile[]): Promise<ReviewedFile[]> {
  const reviewed: ReviewedFile[] = [];
  for (const changed of changedFiles) {
    if (changed.path.endsWith('package-lock.json')) continue; // lockfiles are noise for reviewers
    try {
      reviewed.push({ path: changed.path, content: await readFileContent(changed.path) });
    } catch (err) {
      console.warn(`[Pipeline] Could not read changed file ${changed.path}:`, (err as Error).message);
    }
  }
  return reviewed;
}

async function main(): Promise<void> {
  console.log('=========================================================');
  console.log(' HyperDev Multi-Agent PR Reviewer & Security Auditor');
  console.log('=========================================================');

  if (!process.env.GROQ_API_KEY) {
    console.warn('[Warning] GROQ_API_KEY missing - LLM personas will be skipped, static scanners only.');
  }

  // --- Step 1: fixture -----------------------------------------------------
  await ensureAuditFixture();

  // --- Step 2: git snapshot via sandboxed git tools ------------------------
  console.log('\n[Git] Collecting snapshot (status / diff HEAD~1 / log -n 5)...');
  const snapshot = await collectGitSnapshot();
  if (!snapshot.available) {
    throw new Error('Git snapshot unavailable - cannot run the audit pipeline.');
  }

  const status = await runGitStatus();
  const log = await runGitLog(5);
  console.log(`\n[Git] status:\n${status.stdout.trim()}`);
  console.log(`\n[Git] recent history:\n${log.stdout.trim()}`);
  console.log(`\n[Git] ${snapshot.changedFiles.length} file(s) changed in HEAD:`);
  for (const f of snapshot.changedFiles) console.log(`      - ${f.path}`);
  console.log(`\n[Git] diff size: ${snapshot.diff.length} chars`);

  // --- Step 3: audits -------------------------------------------------------
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

  const findings: AuditFinding[] = mergeFindings([security, quality, dependency]);
  findings.unshift(...[...staticSec, ...staticQual, ...staticDep]);
  // Re-sort so the unshifted static findings join the right priority order.
  findings.sort((a, b) => {
    const order = { Critical: 0, High: 1, Medium: 2, Low: 3 } as const;
    return order[a.severity] - order[b.severity];
  });

  console.log(`\n[Auditor] Total merged findings: ${findings.length}`);

  // --- Step 4: report ---------------------------------------------------------
  const markdown = renderMarkdownReport(findings, {
    generatedAt: new Date(),
    reviewedFiles: snapshot.changedFiles.map((f) => f.path),
    personasRan: [
      ...new Set([
        ...findings.map((f) => f.persona),
        'Security Auditor',
        'Code Quality Reviewer',
        'Dependency Checker',
      ]),
    ],
  });
  const reportPath = await writeReport(markdown);
  console.log(`\n[Reporter] Report written: ${reportPath}`);

  const status_ = resolveMergeStatus(findings);
  console.log('\n=========================================================');
  console.log(` AUDIT COMPLETE - VERDICT: ${status_.verdict === 'BLOCK' ? '🚫 BLOCK' : '🟢 PASS'}`);
  console.log(` ${status_.reason}`);
  console.log(` Full report: ${REPORT_FILENAME}`);
  console.log('=========================================================');
}

main().catch((err) => {
  console.error('Fatal error in audit pipeline:', err);
  process.exit(1);
});
