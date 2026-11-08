import { readFileContent } from '../engine/fileSystem.js';
import { REPORT_FILENAME } from './reporter.js';

/**
 * GitHub PR Commenter (CI integration).
 *
 * Posts the generated `PR_SECURITY_AUDIT_REPORT.md` as a PR comment using the
 * native `fetch` API - no SDK dependency. Re-runs UPDATE the same comment
 * (idempotent, via an embedded HTML marker) instead of spamming new ones.
 *
 * Safety rules:
 *   - Comment-posting failures NEVER fail the CI run (warn + report result).
 *   - Merge enforcement (exit 1 on BLOCK) is handled by the orchestrator
 *     (`src/index.ts`), not here.
 *   - Outside a `pull_request` context the CLI simply skips.
 */

const COMMENT_MARKER = '<!-- hyperdev-multi-agent-pr-audit -->';
/** GitHub hard-truncates comments at ~65,536 chars - stay safely under. */
const MAX_COMMENT_CHARS = 65_000;

export interface GitHubPrContext {
  /** `owner/repo` from `GITHUB_REPOSITORY`. */
  repository: string;
  /** PR number parsed out of `GITHUB_REF` (`refs/pull/<n>/merge`). */
  prNumber: number;
  token: string;
}

/** Derives PR coordinates from GitHub Actions env vars; null outside a PR run. */
export function getPrContext(): GitHubPrContext | null {
  const repository = process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_REF;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !ref || !token) return null;

  const match = ref.match(/^refs\/pull\/(\d+)(?:\/(head|merge))?$/);
  if (!match) return null; // push/tag event, not a pull_request run
  return { repository, prNumber: Number(match[1]), token };
}

/** Extracts the merge verdict the report ends with. */
export function extractVerdict(markdown: string): 'PASS' | 'BLOCK' | null {
  if (/🚫\s*\**\s*BLOCK\b/i.test(markdown)) return 'BLOCK';
  if (/🟢\s*\**\s*PASS\b/i.test(markdown)) return 'PASS';
  return null;
}

function githubHeaders(ctx: GitHubPrContext): Record<string, string> {
  return {
    Authorization: `Bearer ${ctx.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'hyperdev-multi-agent-pr-audit',
  };
}

/** Finds the comment that already carries our marker (so we update, not spam). */
async function findExistingCommentId(ctx: GitHubPrContext): Promise<number | null> {
  const url = `https://api.github.com/repos/${ctx.repository}/issues/${ctx.prNumber}/comments?per_page=100`;
  const res = await fetch(url, { headers: githubHeaders(ctx) });
  if (!res.ok) return null;

  const comments = (await res.json()) as Array<{ id: number; body?: string }>;
  for (const comment of comments) {
    if ((comment.body ?? '').includes(COMMENT_MARKER)) return comment.id;
  }
  return null;
}

async function createComment(ctx: GitHubPrContext, body: string): Promise<boolean> {
  const url = `https://api.github.com/repos/${ctx.repository}/issues/${ctx.prNumber}/comments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: githubHeaders(ctx),
    body: JSON.stringify({ body }),
  });
  return res.ok;
}

async function updateComment(ctx: GitHubPrContext, commentId: number, body: string): Promise<boolean> {
  const url = `https://api.github.com/repos/${ctx.repository}/issues/${ctx.prNumber}/comments/${commentId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: githubHeaders(ctx),
    body: JSON.stringify({ body }),
  });
  return res.ok;
}

function clampForGitHub(markdown: string): string {
  if (markdown.length <= MAX_COMMENT_CHARS) return markdown;
  return (
    `${markdown.slice(0, MAX_COMMENT_CHARS)}\n\n` +
    `> ⚠️ Report truncated for the PR comment - see the full \`PR_SECURITY_AUDIT_REPORT.md\` in the job artifacts/log.`
  );
}

export interface CommentPostResult {
  posted: boolean;
  created: boolean;
  updated: boolean;
  reason?: string;
}

/**
 * Posts or updates the audit-report PR comment. ALWAYS non-fatal: returns a
 * result object with a reason instead of throwing, so a GitHub API error
 * cannot fail the whole CI pipeline.
 */
export async function postOrUpdateAuditComment(markdown: string): Promise<CommentPostResult> {
  const ctx = getPrContext();
  if (!ctx) {
    return { posted: false, created: false, updated: false, reason: 'Not a GitHub PR context (skipping comment).' };
  }

  const body = `${COMMENT_MARKER}\n${clampForGitHub(markdown)}`;

  try {
    const existingId = await findExistingCommentId(ctx);

    if (existingId !== null) {
      const ok = await updateComment(ctx, existingId, body);
      return ok
        ? { posted: true, created: false, updated: true }
        : { posted: false, created: false, updated: false, reason: `GitHub API rejected comment update (id ${existingId}).` };
    }

    const ok = await createComment(ctx, body);
    return ok
      ? { posted: true, created: true, updated: false }
      : { posted: false, created: false, updated: false, reason: 'GitHub API rejected comment creation (check GITHUB token scopes - needs `pull-requests: write`).' };
  } catch (err) {
    return { posted: false, created: false, updated: false, reason: `GitHub comment step failed: ${(err as Error).message}` };
  }
}

/** Fallback notice used by the CI `if: failure()` step when the pipeline crashed mid-run. */
function fallbackNotice(): string {
  return [
    '# ⚠️ Multi-agent audit pipeline failed',
    '',
    'The HyperDev Multi-Agent PR Auditor crashed before producing the full report.',
    'Check the workflow logs for the error, then re-run the job.',
    '',
    '_This placeholder is replaced automatically by the next successful audit run._',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let markdown: string;
  if (args.includes('--fallback')) {
    markdown = fallbackNotice();
  } else {
    try {
      markdown = await readFileContent(REPORT_FILENAME);
    } catch (err) {
      // Report missing = pipeline did not get far enough. Post the fallback notice instead.
      console.warn(`[Commenter] Could not read ${REPORT_FILENAME}: ${(err as Error).message}`);
      console.log('[Commenter] Posting the fallback failure notice instead...');
      markdown = fallbackNotice();
    }
  }

  if (!getPrContext()) {
    console.log('Not a GitHub PR context (skipping comment). Local mode - report file remains the output.');
    process.exitCode = 0;
    return;
  }

  const result = await postOrUpdateAuditComment(markdown);
  if (result.posted) {
    console.log(`[Commenter] ${result.created ? 'Created' : 'Updated'} the PR audit comment.`);
  } else {
    console.warn(`[Commenter] ${result.reason}`);
  }

  const verdict = extractVerdict(markdown);
  if (verdict) console.log(`[Commenter] Report verdict: ${verdict === 'BLOCK' ? '🚫 BLOCK' : '🟢 PASS'}`);
}

// Suffix-based CLI gate: run main() only when THIS module is the entry script,
// never when merely imported (the orchestrator imports the functions).
const scriptArg = process.argv[1] ?? '';
const invokedFile = scriptArg.replace(/\\/g, '/').split('/').pop() ?? '';
const isDirectRun = invokedFile !== '' && import.meta.url.endsWith(`/${invokedFile}`);

if (isDirectRun) {
  // Drain via exitCode instead of process.exit(): an abrupt exit amid pending
  // libuv handles (open fetch sockets) can crash with a UV assertion.
  main().catch((err) => {
    console.error('Fatal error in PR commenter:', err);
    process.exitCode = 1;
  });
}
