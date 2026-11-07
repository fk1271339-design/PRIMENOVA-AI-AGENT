import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_ROOT } from '../engine/sandbox.js';
import { type AuditFinding, type Severity } from './auditor.js';

/**
 * Report generation.
 *
 * Renders the structured Markdown audit report and writes it as
 * `PR_SECURITY_AUDIT_REPORT.md` into the workspace root.
 */

export const REPORT_FILENAME = 'PR_SECURITY_AUDIT_REPORT.md';

const SEVERITY_ORDER: Severity[] = ['Critical', 'High', 'Medium', 'Low'];

function countBySeverity(findings: AuditFinding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function resolveMergeStatus(findings: AuditFinding[]): { verdict: 'PASS' | 'BLOCK'; reason: string } {
  const counts = countBySeverity(findings);
  if (counts.Critical > 0) {
    return { verdict: 'BLOCK', reason: `${counts.Critical} Critical issue(s) must be fixed before merge.` };
  }
  if (counts.High > 0) {
    return { verdict: 'BLOCK', reason: `${counts.High} High-severity issue(s) must be reviewed/fixed before merge.` };
  }
  if (counts.Medium + counts.Low > 0) {
    return {
      verdict: 'PASS',
      reason: `Merge allowed with ${counts.Medium} Medium and ${counts.Low} Low issue(s) - create follow-up tickets.`,
    };
  }
  return { verdict: 'PASS', reason: 'No issues found by any personas.' };
}

export interface ReportMeta {
  generatedAt: Date;
  reviewedFiles: string[];
  personasRan: string[];
}

export function renderMarkdownReport(findings: AuditFinding[], meta: ReportMeta): string {
  const counts = countBySeverity(findings);
  const status = resolveMergeStatus(findings);
  const maxSeverity = SEVERITY_ORDER.find((s) => counts[s] > 0) ?? 'None';
  const riskIcon = { Critical: '🔴', High: '🟠', Medium: '🟡', Low: '🟢', None: '✅' }[maxSeverity];

  const lines: string[] = [];

  lines.push('# 🔒 Multi-Agent PR Security & Quality Audit Report');
  lines.push('');
  lines.push(`**Generated:** ${meta.generatedAt.toISOString()}`);
  lines.push(`**Reviewed files:** ${meta.reviewedFiles.length ? meta.reviewedFiles.join(', ') : 'n/a'}`);
  lines.push(`**Audit agents:** ${meta.personasRan.join(', ')}`);
  lines.push('');

  // -- Executive Summary -----------------------------------------------------
  lines.push('## 📌 Executive Summary');
  lines.push('');
  lines.push(`| Severity | Count |`);
  lines.push(`|----------|------:|`);
  for (const s of SEVERITY_ORDER) {
    lines.push(`| ${s} | ${counts[s]} |`);
  }
  lines.push(`| **Total** | **${findings.length}** |`);
  lines.push('');
  lines.push(
    `${riskIcon} **Overall risk level: ${maxSeverity}.** ` +
      (status.verdict === 'BLOCK'
        ? 'This change-set is **NOT ready to merge** - resolve the Findings highlighted below.'
        : 'No Critical or High issues - the change-set is mergeable.')
  );
  lines.push('');

  // -- Vulnerability Breakdown ----------------------------------------------
  lines.push('## 🐞 Vulnerability Breakdown');
  lines.push('');
  if (findings.length === 0) {
    lines.push('_No findings reported by any agent._');
    lines.push('');
  } else {
    lines.push('| # | Severity | Title | File | Reported by |');
    lines.push('|---|----------|-------|------|-------------|');
    findings.forEach((f, i) => {
      const badge = { Critical: '🔴', High: '🟠', Medium: '🟡', Low: '🟢' }[f.severity];
      lines.push(`| ${i + 1} | ${badge} ${f.severity} | ${escapeTable(f.title)} | \`${f.file}\`${f.lines && f.lines !== 'n/a' ? ` :${f.lines}` : ''} | ${f.persona} |`);
    });
    lines.push('');

    for (const severity of SEVERITY_ORDER) {
      const group = findings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;
      lines.push(`### ${severity} severity (${group.length})`);
      lines.push('');
      for (const f of group) {
        lines.push(`#### ${f.title}`);
        if (f.lines && f.lines !== 'n/a') lines.push(`- **File:** \`${f.file}:${f.lines}\``);
        else lines.push(`- **File:** \`${f.file}\``);
        lines.push(`- **Reported by:** ${f.persona}`);
        if (f.description) lines.push(`- **Description:** ${f.description}`);
        if (f.suggestedFix) lines.push(`- **Suggested fix:** ${f.suggestedFix}`);
        if (f.codeSnippet) {
          lines.push('');
          lines.push('```');
          lines.push(f.codeSnippet.trim());
          lines.push('```');
        }
        lines.push('');
      }
    }
  }

  // -- Suggested Code Fixes --------------------------------------------------
  lines.push('## 🛠️ Suggested Code Fixes');
  lines.push('');
  const fixable = findings.filter((f) => f.suggestedFix || f.codeSnippet);
  if (fixable.length === 0) {
    lines.push('_No actionable fix suggestions._');
    lines.push('');
  } else {
    lines.push('| File | Issue | Recommended fix |');
    lines.push('|------|-------|-----------------|');
    for (const f of fixable) {
      lines.push(`| \`${f.file}${f.lines && f.lines !== 'n/a' ? `:${f.lines}` : ''}\` | ${escapeTable(f.title)} | ${escapeTable(f.suggestedFix ?? '')} |`);
    }
    lines.push('');
    const withDiff = fixable.filter((f) => f.codeSnippet);
    if (withDiff.length > 0) {
      lines.push('### Diff snippets');
      lines.push('');
      for (const f of withDiff) {
        lines.push(`**${f.title}** — \`${f.file}\``);
        lines.push('');
        lines.push(createDiffSnippet(f));
        lines.push('');
      }
    }
  }

  // -- Final Merge Status -----------------------------------------------------
  lines.push('## ✅ Final Merge Status');
  lines.push('');
  lines.push(status.verdict === 'BLOCK' ? '# 🚫 BLOCK' : '# 🟢 PASS');

  lines.push('');
  lines.push(status.reason);
  lines.push('');
  lines.push('---');
  lines.push('_Report generated by the HyperDev Multi-Agent PR Reviewer & Security Auditor pipeline._');
  lines.push('');

  return lines.join('\n');
}

function createDiffSnippet(f: AuditFinding): string {
  // Show the flagged code as context (' '), and the recommendation as an added fix ('+').
  const refLines = (f.codeSnippet ?? '').slice(0, 400).split('\n').map((l) => ` ${l}`);
  const fixLines = (f.suggestedFix ?? '').slice(0, 200).split('\n').map((l) => `+ ${l}`);
  return ['```diff', ...refLines, '', ...fixLines, '```'].join('\n');
}

function escapeTable(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export async function writeReport(markdown: string): Promise<string> {
  const reportPath = path.join(WORKSPACE_ROOT, REPORT_FILENAME);
  await writeFile(reportPath, markdown, 'utf-8');
  return reportPath;
}
