import Groq from 'groq-sdk';
import { readFileContent } from '../engine/fileSystem.js';

/**
 * Multi-agent auditor.
 *
 * Three specialist personas review the change-set:
 *   1. Security Auditor   - hardcoded secrets, OWASP Top 10 (SQLi/XSS/Command Injection),
 *                           unsafe dependency usage, weak auth / weak crypto.
 *   2. Code Quality Reviewer - performance, missing error handling, type safety, cleanliness.
 *   3. Dependency Checker - unsafe dependency versions / risky usage in manifests.
 *
 * Each persona runs as a Groq LLM call with a strict JSON contract (with a salvage
 * parser for token-truncated responses), PLUS deterministic static scanners
 * (always run, even when the LLM layer is unavailable) so the pipeline never
 * reports an empty audit because of API issues.
 */

export const AUDIT_MODEL = 'openai/gpt-oss-120b';

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';

export interface AuditFinding {
  persona: string;
  severity: Severity;
  title: string;
  file: string;
  lines?: string;
  description: string;
  suggestedFix?: string;
  codeSnippet?: string;
}

export interface PersonaAudit {
  persona: string;
  summary: string;
  findings: Array<Partial<AuditFinding>>;
}

export interface ReviewedFile {
  path: string;
  content: string;
}

const SEVERITIES: Severity[] = ['Critical', 'High', 'Medium', 'Low'];

// ---------------------------------------------------------------------------
// LLM personas
// ---------------------------------------------------------------------------

const SECURITY_AUDITOR_SYSTEM = `You are the SECURITY AUDITOR in a multi-agent PR review team.
You analyze code changes for security vulnerabilities. You MUST check for:
1. Hardcoded secrets, API keys, tokens, passwords (flag ALL of them, even demo ones).
2. OWASP Top 10 issues: SQL Injection, Cross-Site Scripting (XSS), Command Injection,
   insecure deserialization, broken authentication/authorization.
3. Unsafe dependency usage (eval, child_process with untrusted input, unsafe deserialization).
4. Weak auth patterns: plaintext password comparison, weak hashes (md5/sha1), hardcoded tokens.
Respond ONLY with a JSON object, no markdown fences, in exactly this shape:
{
  "summary": "one paragraph",
  "findings": [
    {
      "severity": "Critical" | "High" | "Medium" | "Low",
      "title": "short title",
      "file": "path",
      "lines": "approximate line numbers or 'n/a'",
      "description": "what the problem is and its impact",
      "suggestedFix": "how to fix it",
      "codeSnippet": "short code example of the vulnerable line or the fix"
    }
  ]
}`;

const QUALITY_REVIEWER_SYSTEM = `You are the CODE QUALITY REVIEWER in a multi-agent PR review team.
You analyze code changes for quality problems. You MUST check for:
1. Performance bottlenecks (O(n^2)+ loops in hot paths, sync I/O on request paths, N+1 queries).
2. Missing error handling (unawaited promises, missing try/catch around I/O, no input validation).
3. Type safety (TypeScript): 'any' usage, unsafe casts, unchecked non-null assertions.
4. Code cleanliness: dead code, magic constants, missing comments on tricky logic.
Respond ONLY with a JSON object, no markdown fences, in exactly this shape:
{
  "summary": "one paragraph",
  "findings": [
    {
      "severity": "Critical" | "High" | "Medium" | "Low",
      "title": "short title",
      "file": "path",
      "lines": "approximate line numbers or 'n/a'",
      "description": "what the problem is",
      "suggestedFix": "how to fix it",
      "codeSnippet": "short code example"
    }
  ]
}`;

const DEPENDENCY_CHECKER_SYSTEM = `You are the DEPENDENCY CHECKER in a multi-agent PR review team.
You analyze package manifests and dependency usage for supply-chain and versioning risk. You MUST check for:
1. Unsafe dependency versions: floating ranges ("*", "latest"), missing 'devDependencies' separation, known-risky deps.
2. Dependencies that add attack surface for what the code does (e.g. a CLI app pulling a web framework).
3. Update/lockfile hygiene issues visible in the manifest.
Respond ONLY with a JSON object, no markdown fences, in exactly this shape:
{
  "summary": "one paragraph",
  "findings": [
    {
      "severity": "Critical" | "High" | "Medium" | "Low",
      "title": "short title",
      "file": "path",
      "lines": "approximately the dependency line or 'n/a'",
      "description": "what the problem is",
      "suggestedFix": "how to fix it",
      "codeSnippet": "short code example"
    }
  ]
}`;

/** Free-tier Groq TPM caps are tight (8k tokens/min) - keep request sizes well inside. */
const PAYLOAD_LIMITS = { diffChars: 4_000, filesChars: 7_000 };

function personaPayload(
  diff: string,
  files: ReviewedFile[],
  limits: { diffChars: number; filesChars: number } = PAYLOAD_LIMITS
): string {
  const trimmedFiles = files.map((f) => `### FILE: ${f.path}\n${f.content}`).join('\n\n');
  return `Unified diff of the change under review:\n\n${diff.slice(0, limits.diffChars)}\n\n` +
    `Full contents of the changed files:\n\n${trimmedFiles.slice(0, limits.filesChars)}`;
}

/** Shared Groq client factory; returns null when credentials are unavailable. */
export function getGroq(): Groq | null {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  return new Groq({ apiKey });
}

/** Extracts the first JSON object from an LLM response (with or without ``` fences). */
export function extractJsonBlock(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    // Truncated / malformed output (e.g. hit the token cap mid-array):
    // salvage every fully-closed {...} fragment that carries a finding.
    return salvageFindingsFromText(candidate);
  }
}

function salvageFindingsFromText(text: string): unknown | null {
  const objects: Array<Record<string, unknown>> = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && objStart !== -1) {
          try {
            const obj = JSON.parse(text.slice(objStart, i + 1)) as Record<string, unknown>;
            if (obj && typeof obj === 'object' && ('title' in obj || 'findings' in obj)) {
              objects.push(obj);
            }
          } catch {
            // skip invalid fragment
          }
        }
      }
    }
  }

  const usable = objects.filter((o) => Array.isArray(o.findings));
  if (usable.length > 0) {
    const merged = usable.flatMap((o) => o.findings as unknown[]);
    return { summary: '', findings: merged };
  }
  if (objects.length > 0) return { summary: '', findings: objects };
  return null;
}

async function runPersona(
  persona: string,
  systemPrompt: string,
  buildPayload: (limits: { diffChars: number; filesChars: number }) => string
): Promise<PersonaAudit | null> {
  const groq = getGroq();
  if (!groq) {
    console.warn(`[Auditor] GROQ_API_KEY missing - ${persona} (LLM) skipped; static scanners still ran.`);
    return null;
  }

  const create = async (payload: string) =>
    groq.chat.completions.create({
      model: AUDIT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: payload },
      ],
      temperature: 0.1,
    });

  let response;
  try {
    response = await create(buildPayload(PAYLOAD_LIMITS));
  } catch (err) {
    // Free-tier TPM limits (e.g. 413 "Request too large") - retry once with a halved payload.
    if ((err as { status?: number }).status === 413) {
      console.warn(`[Auditor] Payload too large for ${persona} - retrying with a halved payload...`);
      const halved = {
        diffChars: Math.floor(PAYLOAD_LIMITS.diffChars / 2),
        filesChars: Math.floor(PAYLOAD_LIMITS.filesChars / 2),
      };
      response = await create(buildPayload(halved));
    } else {
      throw err;
    }
  }

  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = extractJsonBlock(raw) as PersonaAudit | null;

  if (parsed && Array.isArray(parsed.findings)) {
    return { persona, summary: typeof parsed.summary === 'string' ? parsed.summary : '', findings: parsed.findings };
  }

  // JSON contract failed - keep the raw text as one Low finding so nothing is silently lost.
  console.warn(`[Auditor] ${persona} did not return valid JSON; capturing raw output.`);
  return {
    persona,
    summary: raw.slice(0, 400),
    findings: [
      {
        severity: 'Low',
        title: `${persona} output could not be parsed as structured findings`,
        file: 'n/a',
        description: raw.slice(0, 1_500),
      },
    ],
  };
}

export async function runSecurityAuditor(diff: string, files: ReviewedFile[]): Promise<PersonaAudit | null> {
  return runPersona('Security Auditor', SECURITY_AUDITOR_SYSTEM, (limits) => personaPayload(diff, files, limits));
}

export async function runQualityReviewer(diff: string, files: ReviewedFile[]): Promise<PersonaAudit | null> {
  return runPersona('Code Quality Reviewer', QUALITY_REVIEWER_SYSTEM, (limits) => personaPayload(diff, files, limits));
}

export async function runDependencyChecker(manifests: ReviewedFile[]): Promise<PersonaAudit | null> {
  return runPersona('Dependency Checker', DEPENDENCY_CHECKER_SYSTEM, (limits) => {
    const payload = `Package manifest(s) under review:\n\n${manifests.map((f) => `### FILE: ${f.path}\n${f.content}`).join('\n\n')}`;
    return payload.slice(0, limits.filesChars + limits.diffChars + 200);
  });
}

// ---------------------------------------------------------------------------
// Deterministic static scanners
// ---------------------------------------------------------------------------

interface StaticRule {
  severity: Severity;
  title: string;
  regex: RegExp;
  description: string;
  fix: string;
  /** If the match context satisfies `softenIf`, downgrade to a softer severity/title. */
  softenIf?: { contextRegex: RegExp; severity: Severity; title: string };
}

const SECURITY_RULES: StaticRule[] = [
  {
    severity: 'Critical',
    title: 'Hardcoded secret / API key detected',
    regex: /(?:['"](?:gsk_|sk-|AKIA)[A-Za-z0-9_-]{10,}['"])|(?:-----BEGIN [A-Z ]*PRIVATE KEY)/,
    description: 'An API key or secret material is committed in source. Anyone with repo access (or any build log) can steal it and act as this identity.',
    fix: 'Load the value from process.env / a secret manager and rotate the exposed credential immediately.',
  },
  {
    severity: 'Critical',
    title: 'Password/token assigned a literal string',
    regex: /(?:password|passwd|secret|token|api_?key|apikey)\s*[:=]+\s*['"][^'"]{6,}['"]/i,
    description: 'A credential-like name is bound to a literal string, which usually means a hardcoded credential in disguise.',
    fix: 'Replace with environment configuration and add this file to a secrets scanner (gitleaks/trufflehog).',
  },
  {
    severity: 'Critical',
    title: 'SQL Injection via string concatenation',
    regex: /(?:\bSELECT\b|\bINSERT\s+INTO\b|\bUPDATE\b|\bDELETE\s+FROM\b)[^\n]*['"`]\s*\+/i,
    description: 'A SQL statement is built by concatenating untrusted input - classic OWASP A03 SQL Injection.',
    fix: 'Use parameterized queries / prepared statements (e.g. WHERE id = ?) and never concatenate user input into SQL.',
  },
  {
    severity: 'Critical',
    title: 'Command Injection via shell string building',
    regex: /\bexec(?:Sync)?\s*\([^)]*(?:\+\s*\w+|\$\{)/,
    description: 'A shell command is built from untrusted input and passed to exec/spawn - OWASP A03 Command Injection.',
    fix: 'Use spawn with an args-array (no shell), or a vetted library API; validate input against an allowlist.',
  },
  {
    severity: 'High',
    title: 'Possible Cross-Site Scripting (innerHTML / document.write)',
    regex: /\.(?:innerHTML|innerText)\s*=|document\.write\s*\(/,
    description: 'Unsanitized data is written into the DOM, enabling stored/reflected XSS (OWASP A03).',
    fix: 'Use textContent, or sanitize with DOMPurify before injecting HTML into the DOM.',
    softenIf: {
      // DOMPurify/textContent-style sanitization around the assignment -> downgrade to review note.
      contextRegex: /DOMPurify|textContent|sanitiz/i,
      severity: 'Low',
      title: 'Sanitized innerHTML assignment (verify sanitizer coverage)',
    },
  },
  {
    severity: 'High',
    title: 'Weak hash for security-sensitive data',
    regex: /createHash\(\s*['"](?:md5|sha1)['"]|\b(?:md5|sha1)\b\s*\(/i,
    description: 'md5/sha1 are broken for passwords and signatures (OWASP A02 Cryptographic Failures).',
    fix: 'Use bcrypt/argon2/scrypt for passwords and SHA-256+ for integrity checks.',
  },
  {
    severity: 'High',
    title: 'Weak authentication: direct secret comparison',
    regex: /(?:cookies?\.|session\.|headers\.)\S+\s*={2,3}\s*['"][^'"]{4,}['"]|password\s*={2,3}\s*['"][^'"]*['"]/i,
    description: 'Auth decisions compare user-controlled values against constants with plain equality, risking authentication bypass (OWASP A07).',
    fix: 'Use proper session validation (random tokens, server-side session store, timing-safe compare for secrets).',
  },
  {
    severity: 'Medium',
    title: 'Dangerous dynamic code execution (eval / new Function)',
    regex: /\beval\s*\(|new\s+Function\s*\(/,
    description: 'Dynamic code execution on possibly-attacker-controlled strings ends in Remote Code Execution.',
    fix: 'Remove eval entirely; if truly needed, use an allowlist mapping or a locked-down sandbox like vm2/worker.',
  },
];

const TYPE_SAFETY_RULES: StaticRule[] = [
  {
    severity: 'Low',
    title: "Usage of ': any' weakens type safety",
    regex: /:\s*any\b/,
    description: 'Explicit any disables TypeScript checking for this value.',
    fix: 'Use specific types/interfaces, generics, or unknown + narrowing.',
  },
  {
    severity: 'Low',
    title: 'console.log left in committed source',
    regex: /console\.log\s*\(/,
    description: 'Debug logging in committed code pollutes output and can leak data in production.',
    fix: 'Use a leveled logger (pino/debug) and remove ad-hoc logging.',
  },
];

function ruleLineNo(content: string, regex: RegExp): string | undefined {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) return String(i + 1);
  }
  const m = content.match(regex);
  return m ? 'n/a' : undefined;
}

function applyRules(persona: string, rules: StaticRule[], files: ReviewedFile[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const file of files) {
    for (const rule of rules) {
      const m = file.content.match(rule.regex);
      if (!m) continue;

      // Optional softening: sanitization context downgrades the raw-match severity.
      let severity = rule.severity;
      let title = rule.title;
      if (rule.softenIf) {
        const lines = file.content.split('\n');
        const lineNo = lines.findIndex((l) => rule.regex.test(l));
        if (lineNo !== -1) {
          const context = lines.slice(Math.max(0, lineNo - 3), lineNo + 4).join('\n');
          if (rule.softenIf.contextRegex.test(context)) {
            severity = rule.softenIf.severity;
            title = rule.softenIf.title;
          }
        }
      }

      findings.push({
        persona,
        severity,
        title,
        file: file.path,
        lines: ruleLineNo(file.content, rule.regex),
        description: `${rule.description} Matched: ${JSON.stringify(m[0].slice(0, 120))}`,
        suggestedFix: rule.fix,
        codeSnippet: undefined,
      });
    }
  }
  return findings;
}

/** Deterministic security scan - always runs, cascades safely when the LLM layer fails. */
export function runStaticSecurityScan(files: ReviewedFile[]): AuditFinding[] {
  return applyRules('Security Auditor (static)', SECURITY_RULES, files);
}

/** Deterministic quality scan (type-safety subset). */
export function runStaticQualityScan(files: ReviewedFile[]): AuditFinding[] {
  return applyRules('Code Quality Reviewer (static)', TYPE_SAFETY_RULES, files);
}

/** Deterministic manifest scan: floating dependency ranges. */
export function runStaticDependencyScan(manifestPath: string, packageJson: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  try {
    const parsed = JSON.parse(packageJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const sections: Array<[string, Record<string, string>]> = Object.entries({ dependencies: parsed.dependencies ?? {}, devDependencies: parsed.devDependencies ?? {} });
    for (const [section, deps] of sections) {
      for (const [name, version] of Object.entries(deps)) {
        if (version === '*' || version === 'latest' || !/^[\^~]?\d/.test(version)) {
          findings.push({
            persona: 'Dependency Checker (static)',
            severity: 'Medium',
            title: `Non-pinned / unsafe dependency version: ${name}@${version}`,
            file: manifestPath,
            description: `"${section}" entry ${name} uses version "${version}", which can silently pull unvetted releases (supply-chain risk).`,
            suggestedFix: `Pin an exact version or use a controlled range (e.g. "^1.2.3") and commit the lockfile.`,
          });
        }
      }
    }
  } catch {
    // Manifest unreadable/invalid - LLM Dependency Checker will still look at raw text.
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Merge / prioritize
// ---------------------------------------------------------------------------

export function mergeFindings(personaAudits: Array<PersonaAudit | null>): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const audit of personaAudits) {
    if (!audit) continue;
    for (const f of audit.findings) {
      const severity = normalizeSeverity(f.severity);
      if (!f.title) continue;
      findings.push({
        persona: audit.persona,
        severity,
        title: f.title,
        file: f.file ?? 'unknown',
        lines: f.lines ?? 'n/a',
        description: f.description ?? '',
        suggestedFix: f.suggestedFix,
        codeSnippet: f.codeSnippet,
      });
    }
  }

  // Deduplicate identical (file + title) findings across static + LLM passes.
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.file.toLocaleLowerCase()}|${f.title.toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

function normalizeSeverity(value: unknown): Severity {
  const str = String(value ?? '').toLocaleLowerCase();
  if (str.startsWith('crit')) return 'Critical';
  if (str.startsWith('high')) return 'High';
  if (str.startsWith('med')) return 'Medium';
  if (str.startsWith('low')) return 'Low';
  // Unknown severity from an LLM defaults to High (fail-safe: never under-report).
  return 'High';
}
