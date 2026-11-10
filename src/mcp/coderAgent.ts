import { AUDIT_MODEL, extractJsonBlock, getGroq } from './auditor.js';
import { buildFileTree, injectCodeFiles, runWorkspaceCommand, validateInjectPath } from './workspaceTools.js';

/**
 * Autonomous Developer Agent ("AntiGravity-Lite") - prompt-driven loop:
 *
 *   1. PLAN the architecture (file tree).
 *   2. WRITE source files iteratively (max 2 per turn to respect free-tier TPM).
 *   3. RUN package installation / build checks through the hardened sandbox.
 *   4. SELF-CORRECT when commands return errors (fix + re-run).
 *   5. FINISH only once install/build verification has passed.
 *
 * The agent speaks a strict JSON action protocol; this module executes the
 * actions and feeds compact results back into the next turn. All file writes
 * are jailed, all shell commands run through the hardened sandbox, and the
 * audit engine's own files (src/, package.json, ...) are protected.
 */

const CODER_SYSTEM = `You are the AUTO DEVELOPER agent of the HyperDev workspace builder.
You build runnable software projects step by step inside the current workspace.

IMPORTANT WRITING RULES:
- Write ALL project files under the "generated_app/" directory (never touch the
  audit engine's own files: src/, package.json, tsconfig.json, .env, .github).
- Target a project that runs WITHOUT user interaction (no servers waiting on
  prompts you cannot respond to). CLI/node scripts and small web servers are ideal.
- Node.js + TypeScript/JavaScript is the preferred stack (npm install works here).

RESPOND ONLY WITH ONE JSON OBJECT, no markdown fences, in exactly this shape:
{
  "action": "plan" | "write_files" | "shell" | "finish" | "abort",
  "summary": "one short line about what you are doing / did",
  "files": [ { "path": "generated_app/<file>", "content": "<full file content>" } ],
  "command": "<one shell command, e.g. npm --prefix generated_app install>",
  "reason": "<why you are finishing or aborting>"
}

ACTION RULES:
1. "plan": first turn - lay out the full file list and architecture in summary.
2. "write_files": AT MOST 2 files per turn, each under ~150 lines; full file content.
3. "shell": ONE command per turn. Use npm --prefix <dir> install / npm --prefix <dir> run build,
   node <file>, npx tsc --noEmit --ignoreConfig ... for syntax checks. No interactive tools.
   The sandbox is a strict jail: command chains (&& or |) and file-reading helpers (cat, ls)
   may be rejected - stick to SINGLE npm/npx/node/tsc commands with no quotes tricks.
4. After installing dependencies, ALWAYS run a build/syntax check before "finish".
5. If a command fails, READ the error output, fix the files, and re-run (self-correct).
6. "finish" only when install AND verification succeeded (or explain in reason why not possible).
7. "abort" if the request is impossible or unsafe - explain in reason.`;

type AgentAction = 'plan' | 'write_files' | 'shell' | 'finish' | 'abort';

interface AgentTurn {
  action?: AgentAction;
  summary?: string;
  files?: Array<{ path?: string; content?: string }>;
  command?: string;
  reason?: string;
}

export interface CheckResult {
  command: string;
  passed: boolean;
  output: string;
}

export interface CoderResult {
  completed: boolean;
  aborted: boolean;
  stepsUsed: number;
  filesWritten: string[];
  commandsRun: string[];
  finalCheck?: CheckResult;
  notes: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_FILES_PER_TURN = 2;
const MAX_FILE_CHARS = 8_000;
const COMMAND_ALLOWLIST = /^(npm\b|npx\b|node\b|git\b|tsc\b|ls\b|dir\b|echo\b)/;
/** Same failing command twice in a row = change approach, don't hammer. */
const MAX_REPEAT_FAILURES = 2;

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : `...${text.slice(-chars)}`;
}

/**
 * Some models double-escape nested file content ("{\n \"name\": ...") leaving
 * literal `\n` sequences inside the written file. When the payload contains
 * ONLY escaped sequences (no real newlines anywhere), restore real breaks.
 */
function normalizeEscapedContent(content: string): string {
  if (!content.includes('\n') && /\\n/.test(content)) {
    return content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  }
  return content;
}

async function callAgentTurn(originalPayload: string): Promise<AgentTurn | null> {
  const groq = getGroq();
  if (!groq) return null;

  let payload = originalPayload;
  let jsonMode = true; // Groq JSON mode first - prevents the strongest failure mode below.

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await groq.chat.completions.create({
        model: AUDIT_MODEL,
        messages: [
          { role: 'system', content: CODER_SYSTEM },
          { role: 'user', content: payload },
        ],
        temperature: 0.2,
        ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      });
      const raw = response.choices[0]?.message?.content ?? '';
      return (extractJsonBlock(raw) as AgentTurn | null) ?? null;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      const message = (err as { message?: string }).message ?? '';
      if (status === 429 || status === 503) {
        const waitMs = 25_000 * (attempt + 1); // free-tier TPM: back off and retry
        console.warn(`[Coder] Groq rate limit (${status}) - waiting ${waitMs / 1000}s then retrying...`);
        await sleep(waitMs);
        continue;
      }
      // gpt-oss models are tool-calling-trained: they sometimes emit a native
      // tool call (e.g. "container.exec") instead of plain JSON, and Groq
      // answers 400 "tool choice is none, but model called a tool". Retry once
      // without JSON mode plus an explicit no-tools reminder.
      if (status === 400 && /tool/i.test(message)) {
        console.warn('[Coder] Model attempted a native tool call - retrying with an explicit plain-JSON reminder...');
        // Keep JSON mode ON: dropping it derails the model from the protocol.
        payload = `${originalPayload}\n\nREMINDER: You have NO tools available in this conversation. Do NOT attempt to call any tool or function. Respond ONLY with plain-text JSON matching the required shape.`;
        continue;
      }
      if (status === 400 && /response_format/i.test(message)) {
        console.warn('[Coder] JSON mode not supported - retrying with plain prompting...');
        jsonMode = false;
        continue;
      }
      // Transient strict-JSON misformat from the model (empty/invalid
      // generation) - a short pause plus a direct retry usually recovers.
      if (status === 400 && /json_validate|failed_generation/i.test(message)) {
        console.warn('[Coder] Model emitted unusable JSON - retrying after a short pause...');
        await sleep(4_000);
        continue;
      }
      console.error(`[Coder] LLM call failed: ${message}`);
      return null;
    }
  }
  return null;
}

export async function runCoderAgent(userRequest: string, maxSteps: number = 14): Promise<CoderResult> {
  const notes: string[] = [];
  const filesWritten: string[] = [];
  const commandsRun: string[] = [];
  let finalCheck: CheckResult | undefined;
  let completed = false;
  let aborted = false;
  let abortReason: string | undefined;
  let lastFailedCommand: string | undefined;
  let repeatFailures = 0;

  const initialTree = await buildFileTree('.', { maxDepth: 3, maxEntries: 120 });
  console.log(`[Coder] Workspace tree:\n${initialTree.split('\n').slice(0, 40).join('\n')}${initialTree.split('\n').length > 40 ? '\n...' : ''}`);

  let progress = '';

  const lastWritten = new Map<string, string>();
  let pendingVerification: string | undefined;

  /**
   * Shared shell executor used both by agent-commanded turns and the
   * verify-after-write policy. Tracks repeat failures and the command that
   * still needs re-verification after file edits.
   */
  const runShellCommand = async (label: string, command: string): Promise<CheckResult> => {
    const result = await runWorkspaceCommand(command, 300_000);
    commandsRun.push(command);
    const output = tail(`${result.stdout}\n${result.stderr}`.trim(), 3_000).trim();
    progress += `${label}\n$ ${command}\nexit=${result.exitCode}\n${output || '(no output)'}\n`;

    const passed = result.exitCode === 0;
    finalCheck = { command, passed, output };

    if (passed) {
      repeatFailures = 0;
      lastFailedCommand = undefined;
      pendingVerification = undefined;
    } else {
      if (command === lastFailedCommand) {
        repeatFailures++;
        if (repeatFailures >= MAX_REPEAT_FAILURES) {
          notes.push(`Command failed ${repeatFailures}x identically: ${command} - hint given to change approach.`);
          progress += 'HINT: this exact command already failed repeatedly - change the approach or explain in "reason".\n';
        }
      } else {
        repeatFailures = 1;
        lastFailedCommand = command;
      }
      pendingVerification = command;
    }
    return { command, passed, output };
  };

  let step = 1;
  for (; step <= maxSteps; step++) {
    const payload = [
      `USER REQUEST:\n${userRequest}`,
      `CURRENT WORKSPACE FILE TREE:\n${initialTree}`,
      progress ? `PROGRESS LOG (chronological):\n${progress}` : 'No actions taken yet - start by planning.',
      'Choose the next SINGLE action and respond with JSON only.',
    ].join('\n\n');

    const turn = await callAgentTurn(tail(payload, 12_000));
    if (!turn?.action) {
      notes.push('Agent returned no usable action (LLM/JSON failure) - stopping.');
      break;
    }

    console.log(`\n[Coder] Step ${step}/${maxSteps} - ${turn.action.toUpperCase()}: ${(turn.summary ?? turn.reason ?? '').slice(0, 160)}`);
    const stamp = `--- step ${step} (${turn.action}) ---`;

    switch (turn.action) {
      case 'plan': {
        progress += `${stamp}\nPLAN: ${(turn.summary ?? '').slice(0, 1_200)}\n`;
        break;
      }

      case 'write_files': {
        const requested = turn.files ?? [];
        if (requested.length === 0) {
          progress += `${stamp}\nRESULT: no files provided.\n`;
          break;
        }

        const accepted: Array<{ path: string; content: string }> = [];
        for (const file of requested.slice(0, MAX_FILES_PER_TURN)) {
          if (typeof file.path !== 'string' || typeof file.content !== 'string') continue;
          const rejection = validateInjectPath(file.path);
          if (rejection) {
            notes.push(`Rejected write to ${file.path}: ${rejection}`);
            progress += `${stamp}\nREJECTED ${file.path}: ${rejection}\n`;
            continue;
          }
          const normalized = normalizeEscapedContent(file.content.slice(0, MAX_FILE_CHARS));
          if (lastWritten.get(file.path) === normalized) {
            progress += `SKIPPED ${file.path}: identical rewrite (re-run the failing command to verify instead).\n`;
            continue;
          }
          lastWritten.set(file.path, normalized);
          accepted.push({ path: file.path, content: normalized });
        }

        const injected = await injectCodeFiles(accepted);
        let wroteAny = false;
        for (const result of injected) {
          if (result.ok) {
            filesWritten.push(result.path);
            wroteAny = true;
            console.log(`[Coder]   wrote ${result.path}`);
            progress += `WROTE ${result.path} (ok)\n`;
          } else {
            progress += `WRITE_FAILED ${result.path}: ${result.error}\n`;
          }
        }

        // Verify-after-write policy: if a shell command failed earlier, re-run
        // it now so the agent VALIDATES its fix instead of rewriting blindly.
        if (wroteAny && pendingVerification) {
          progress += 'AUTO-VERIFY: re-running the previously failed command after the file edits...\n';
          await runShellCommand(`${stamp} (auto-verify)`, pendingVerification);
        }
        break;
      }

      case 'shell': {
        const command = (turn.command ?? '').trim();
        if (!command) {
          progress += `${stamp}\nRESULT: empty command ignored.\n`;
          break;
        }
        if (!COMMAND_ALLOWLIST.test(command)) {
          notes.push(`Blocked command outside the allowlist: ${command}`);
          progress += `${stamp}\nBLOCKED (allowlist): ${command}\nUse npm/npx/node/git/tsc only.\n`;
          break;
        }
        // Allowlist only validates the PREFIX - a "npm ... && rm ..." chain
        // would sneak past it. Chains are rejected outright.
        if (/&&|\|\||[;|]/.test(command)) {
          notes.push(`Blocked chained command: ${command}`);
          progress += `${stamp}\nBLOCKED (chains are not allowed): ${command}\nRun ONE command per turn.\n`;
          break;
        }
        await runShellCommand(stamp, command);
        break;
      }

      case 'finish': {
        completed = true;
        if (turn.reason) progress += `${stamp}\nFINISH: ${turn.reason}\n`;
        console.log('[Coder] Agent declared the build complete.');
        break;
      }

      case 'abort': {
        aborted = true;
        abortReason = turn.reason;
        console.warn(`[Coder] Agent aborted: ${turn.reason ?? '(no reason reported)'}`);
        break;
      }
    }

    if (completed || aborted) break;
  }

  if (!completed && !aborted && step > maxSteps) {
    notes.push(`Reached the ${maxSteps}-step limit before the agent declared completion.`);
  }

  return {
    completed,
    aborted,
    stepsUsed: Math.min(step, maxSteps),
    filesWritten: [...new Set(filesWritten)],
    commandsRun,
    finalCheck,
    notes: [...notes, ...(aborted && abortReason ? [`Agent abort reason: ${abortReason}`] : [])],
  };
}
