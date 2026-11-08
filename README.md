<div align="center">

# 🛡️ HyperDev — Multi-Agent PR Reviewer & Security Auditor Engine

**A self-healing, Multi-Agent AI audit engine that reviews pull-request diffs for security vulnerabilities & code-quality regressions — and can repair them autonomously.**

Using the Groq-hosted **`openai/gpt-oss-120b`** LLM · TypeScript · Hardened sandbox · GitHub Actions native.

[![Security Audit](https://img.shields.io/badge/Security-Audit-ready-red)](. " ")
[![Agent Type](https://img.shields.io/badge/Agents-3%20Personas%20%2B%20AutoFixer-blue)](#-architecture " ")
[![Sandbox](https://img.shields.io/badge/Sandbox-Hardened--Process--Isolation-green)](#-hardened-sandbox " ")
[![CI/CD](https://img.shields.io/badge/GitHub%20Actions-integrated-2088FF?logo=githubactions&logoColor=white)](.github/workflows/pr-audit.yml " ")
[![Report](https://img.shields.io/badge/Output-PR_SECURITY_AUDIT_REPORT.md-yellow)](PR_SECURITY_AUDIT_REPORT.md " ")
[![TypeScript](https://img.shields.io/badge/Type%3A-ES2022%20%2F%20NodeNext%20Strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json " ")
[![LLM](https://img.shields.io/badge/LLM-Groq%20%2F%20gpt--oss--120b-orange)](https://console.groq.com " ")
[![License](https://img.shields.io/badge/License-ISC-lightgrey)](LICENSE " ")

</div>

---

## 📑 Table of Contents

1. [Architecture Overview](#-architecture-overview)
2. [Core Features](#-core-features)
3. [Quick Start & Installation](#-quick-start--installation)
4. [CLI Usage & Modes](#-cli-usage--modes)
5. [GitHub Actions CI/CD Integration](#-github-actions-cicd-integration)
6. [The Audit Report](#-the-audit-report)
7. [Modular Reference](#-modular-reference)
8. [Safety Model & Limits](#️-safety-model--limits)
9. [Troubleshooting](#-troubleshooting)

---

## 🏛️ Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                        Orchestrator (src/index.ts)                 │
│   mode: GitHub-Actions (GITHUB_ACTIONS=true) or Local CLI          │
└──────────┬───────────────────────────┬────────────────────────────┘
           │ 1. GIT SNAPSHOT           │
│ ┌────────▼────────────────┐      │
│ │  gitTools.ts            │      │   (all git commands run INSIDE the
│ │  status / diff HEAD~1   │──────┘    sandbox: jailed cwd, path checks,
│ │  log -n 5, PR-ci diff   │           30s timeout, process-tree kill)
│ └────────┬────────────────┘
│ 2. AUDIT │  3 LLM Personas (parallel single-agent calls)
│ ┌────────▼────────┐  ┌───────────────────┐  ┌───────────────────┐
│ │ Security Auditor│  │ Quality Reviewer  │  │ Dependency Checker│
│ │  secrets, OWASP │  │  perf, err-hdl    │  │  pinning, lock    │
│ │  SQLi/XSS/CMDi  │  │  TS type-safety   │  │  supply-chain     │
│ └────────┬────────┘  └──────┬────────────┘  └────────┬──────────┘
│          │  ▲ deterministic static scanners (always-on fallback) ▲ │
│ 3. MERGE │  └──────────── findings merge + dedupe ──────────────┘ │
│ ┌────────▼───────────────┐
│ │ reporter.ts            │  PR_SECURITY_AUDIT_REPORT.md
│ │ exec summary / sev.    │  Critical/High → verdict BLOCK
│ └────────┬───────────────┘
│ 4. FLOW  ▼
│ ┌────────────────────────┐    BLOCK + --auto-fix?
│ │ autofixer.ts           │──Yes──▶ per-finding LLM patch
│ │  self-healing loop     │        → apply → npx tsc --noEmit
│ │  rollback verification │        → pass? commit / fail? ROLLBACK
│ └────────┬───────────────┘        → re-scan → new verdict
│          │ 5. CI INTEGRATION
│ ┌────────▼───────────────┐
│ │ githubCommenter.ts     │  post / update PR comment (idempotent marker)
│ │  fetch vs Octokit-free │  exit 1 when verdict BLOCK (merge gate)
│ └────────────────────────┘
```

### 🔒 Hardened Sandbox (`src/engine/sandbox.ts`)

Every terminal command executed by agents travels through one hardened gateway:

- **Directory Jail — path scoping.** `WORKSPACE_ROOT` = `process.cwd()`. Commands *referencing absolute paths outside the root* (Windows drive letters, UNC shares, Unix system dirs like `/etc`, `/usr`, `/var`) are rejected *before* execution, and the spawned shell's `cwd` is forced to the root. URLs (`http://…`) are excluded from the drive-path check via lookbehind, so they are not falsely jailed.
- **Process-Tree BFS cleanup.** On timeout, error, *and after each normal exit*, the sandbox kills the entire descendant tree. It uses a two-layer strategy: a fast `taskkill /F /T /PID` sweep while the shell is alive, then a PowerShell `Win32_Process` **parent-link BFS** that also finds processes whose parent shell has already exited (e.g., `start /B node server.js` orphans that lock ports). Includes a raw `[int]` hashtable-key cast because `Win32_Process` PIDs are `UInt32` and PowerShell's boxed lookup fails silently on `Int32`.
- **Execution Timeout.** Hard default **30 s per command** (`exitCode: -999` on timeout).
- **Secret hygiene.** `GROQ_API_KEY` is stripped from child-process environments, so shell commands cannot ex-filtrate it.

> Process-level isolation is *not* an OS-container jail. For untrusted repo input, run inside Docker or a VM.

### 🤖 Three Specialist LLM Personas (`src/mcp/auditor.ts`)

| Persona | Focus |
|---|---|
| **Security Auditor** | Hardcoded secrets / API keys; OWASP Top 10 — SQL Injection, XSS, Command(In)jection; unsafe dependency usage; weak auth & cryptography (md5/sha1, plaintext compare) |
| **Code Quality Reviewer** | Performance bottlenecks (O(n²)+), missing error handling, TypeScript type-safety (`any`, unsafe casts), code cleanliness |
| **Dependency Checker** | Unsafe / floating dependency versions, lockfile hygiene, supply-chain risk |

- All personas emit **strict JSON** (`{ summary, findings[] }`) — with a balanced-brace salvage parser for truncated responses.
- **Deterministic static scanners** (secrets, SQLi, exec-payload patterns, weak auth, clause-aware softening of DOMPurify-sanitized `innerHTML`, dep pinning) always run — the pipeline is *LLM-failure-proof*.
- Findings are **merged, deduplicated, severity-ranked**, and a *hallucination guard* drops stale "missing lockfile" / "impossible dependency-version" claims when the repo locally proves otherwise (lockfile present / version installed in `node_modules`).

### 🩹 Auto-Fixer with Rollback Safety (`src/mcp/autofixer.ts`)

For each Critical/High finding:

1. Prompts the LLM with the **complete file** + finding for a *minimal edit* patch.
2. Applies the patch via `createOrUpdateFile`.
3. **Verifies:** `npx tsc --noEmit` (plus per-file strict compile for files outside the project's tsconfig `include`).
4. **Rolls back** the file to its snapshot *if the build breaks*, and re-verifies the rollback.
5. Optionally runs `npm test` when a test script exists.
6. Commits patched files locally as `autofix_self_healing_patch_<ts>` (skipped in CI, where the pull_request token cannot push).

### ☁️ CI/CD PR Commenter (`src/mcp/githubCommenter.ts`)

- Posts/updates the Markdown audit report as a **PR comment** using the GitHub REST API via plain `fetch` — **no SDK dependency**.
- Embedded HTML marker (`<!-- hyperdev-multi-agent-pr-audit -->`) makes re-runs **update the same comment**, never spam.
- Truncates safely against GitHub's 65k-char comment limit; non-fatal on fork/permission errors.
- CLI mode parses `GITHUB_REPOSITORY` / `GITHUB_REF` (`refs/pull/123/merge`) + `GITHUB_TOKEN`, and exits `1` when the report verdict is `BLOCK` — making the workflow job **fail and thereby block the merge** (once the check is marked *Required* in branch protection).

---

## ✨ Core Features

- 🔐 **Hardened process sandbox** — path-scoped directory jail, dangerous-pattern blocklist, 30 s execution cap, full process-tree cleanup (Windows BFS reaper + Unix process groups), secret-scrubbed child environments.
- 🤖 **Three specialist LLM personas** over Groq (`openai/gpt-oss-120b`) with strict-JSON contracts, payload-size self-trimming, and automatic retry with halved payloads on tier **413 rate limits**.
- 🎯 **Deterministic static security & quality scanners** — always-on, zero-API fallback layer for OWASP-style issues (hardcoded keys, SQLi, command injection, XSS, weak hashing/auth, `any` usage, dep pinning).
- 🧩 **Multi-agent finding fusion** — merge, dedupe, severity ordering, and *hallucination guards* for LLM manifest claims.
- 🩹 **Self-healing Auto-Fixer** — minimal-edit patches verified by the TypeScript compiler, with automatic rollback on breakage and optional test execution.
- 📊 **Enterprise audit report** — `PR_SECURITY_AUDIT_REPORT.md` with Executive Summary, severity tables (🔴 Critical / 🟠 High / 🟡 Medium / 🟢 Low), per-finding remediation, diff fix snippets, and a final **PASS 🟢 / BLOCK 🚫** merge verdict.
- ☁️ **GitHub Actions native** — `pull_request` webhook triggers (`opened`, `synchronize`, `reopened`), Node cache-friendly install (`npm ci`), idempotent PR comments and merge gating.
- 🧪 **Idempotent local demo** — seeds a real two-commit git history with an intentionally vulnerable patch so `git diff HEAD~1` is authentic.
- 🛠️ **Strict TypeScript** — `ES2022`, `NodeNext`, `strict: true`.

---

## 🚀 Quick Start & Installation

### Prerequisites

| Requirement | How to get it |
|---|---|
| **Node.js ≥ 20** (Built & tested on Node 24, TypeScript 7) | [nodejs.org](https://nodejs.org) |
| **Groq API key** (free tier works) | [console.groq.com](https://console.groq.com/keys) |
| **Git** available on PATH | [git-scm.com](https://git-scm.com) |
| *(CI only)* GitHub repository + Actions | — |

### Setup

```bash
git clone <your-repo-url> multi-agent-pr-reviewer
cd multi-agent-pr-reviewer

npm install

# 1. Configure your Groq key
echo "GROQ_API_KEY=gsk_your_real_key_here" > .env
```

> ⚠️ **Never commit `.env`.** It is already listed in `.gitignore`; treat keys in any source file or any history as *leaked* and rotate immediately.

### Run the audit engine

```bash
# Full pipeline on your latest commit (status / diff / agents / report)
npx tsx src/index.ts

# Demo mode — seeds a fresh vulnerable two-commit history and audits that patch
npx tsx src/index.ts --demo

# Self-healing mode — BLOCK verdicts trigger per-finding LLM patches with
# compiler verification + rollback, then refresh the report and verdict
npx tsx src/index.ts --auto-fix

# Demo + self-healing end-to-end
npx tsx src/index.ts --demo --auto-fix
```

Designated environment overrides:

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | Groq credentials (`.env` or CI secret) |
| `HYPERDEV_AUTO_FIX=true` | Equivalent to passing `--auto-fix` (useful in CI) |

Optional helper scripts (when installed): `npm run build` (`tsc`) · `npm start` / `npm run dev` (via `tsx`, legacy alias to the local agent loop).

---

## ☁️ GitHub Actions CI/CD Integration

`.github/workflows/pr-audit.yml` automatically runs the full audit on every pull request.

### One-time repository setup

1. **Add the LLM secret** — *Repo Settings → Secrets and variables → Actions → New repository secret*
   - Name: `GROQ_API_KEY`
   - Value: your Groq key (`gsk_…`)
2. The workflow already passes `GITHUB_TOKEN: ${{ github.token }}`; only grant the workflow file's declared permission set:
   - `contents: read`
   - `pull-requests: write`
3. (Optional, for true merge-gating) — *Settings → Branches → Branch protection rules → Require status checks to pass before merging* ✅ select **`audit`**.

### How it runs

Pull Request `opened`, `synchronize` or `reopened` →

1. `git checkout` full history → `actions/setup-node` (Node 24) → `npm ci`
2. `npx tsx src/index.ts`
   - Diffs `HEAD` against `origin/${GITHUB_BASE_REF}` (validated, injected-injection safe)
   - Runs all personas + static scanners + build verification
   - Writes `PR_SECURITY_AUDIT_REPORT.md`
   - **Posts/updates the audit report as a PR comment** (idempotent)
   - Exits `1` if the verdict is `BLOCK` → job ✗ → merge is blocked by the required status check
3. If the pipeline itself crashes mid-run, an `if: failure()` step posts a fallback notice so reviewers are never left in silence.

Concurrency is capped at one run per PR (`cancel-in-progress: true`) — force-pushes supersede stale audits.

### PR Comment behavior

Each pipeline run has a dedicated audit comment:

- One comment per PR, continuously updated with a `<!-- hyperdev-multi-agent-pr-audit -->` marker
- Contains the entire executive summary, severity breakdown, remediation suggestions, and verdict
- If the LLM ("merge gates") so desired — Bot-comment kicks off the same voice, but FAIL-safe: after a forked/permission-limited state it only logs a warning rather than failing the entire CI on GitHub-API errors.

---

## 📊 The Audit Report

`PR_SECURITY_AUDIT_REPORT.md` sections:

- **Executive Summary** — severity distribution matrix, date stamp, highlight of overall risk level with radical ☢️ risk icons
- **Vulnerability Breakdown** — numbered table sorted Critical → Low plus a per-finding description block with a file, line number, reporting persona, and issue link
- **Suggested Code Fixes** — wide table of affected files plus `diff`-styled code-repair snippets
- **Final Merge Status** — consolidated verdict line
  - `🚫 BLOCK` — if *any* Critical or High severity issue remains open
  - `🟢 PASS` — if only Medium/Low-issue noise is left; bootstraps follow-up tickets

Every merge-gate export passes through the same reporting function; the report author in the pipeline loops CI, CLI, and IDE are consistent.

---

## 🧱 Modular Reference

| Module | Responsibility |
|---|---|
| `src/index.ts` | Orchestrates mode selection, pipeline order, auto-fix gate & CI exit codes |
| `src/mcp/gitTools.ts` | Sandboxed git snapshot (`status`, `diff HEAD~1` / PR base diff, `log`), unified-diff parsing |
| `src/mcp/auditor.ts` | Persona prompts, JSON merge/dedupe, static scanners, hypothesis-guard rails |
| `src/mcp/autofixer.ts` | self-healing patches, compile verification, rollback, test+commit |
| `src/mcp/reporter.ts` | Markdown report rendering & writing |
| `src/mcp/githubCommenter.ts` | PR comment create/update, verdict extraction, CLI merge gate |
| `src/mcp/auditFixture.ts` | Local vulnerable demo (two-commit git seeding, `--demo`) |
| `src/engine/sandbox.ts` | Executed loader: jail, dangerous-pattern detection, timeouts, tree-kill |
| `src/engine/fileSystem.ts` | Jailed file read / create / list helpers |
| `.github/workflows/pr-audit.yml` | CI pipeline definition |

---

## ⚠️ Safety Model & Limits

| Layer | Protection | Boundary |
|---|---|---|
| Terminal commands | Path jail + blocklist + timeout + tree-kill + secret scrub | Process-level only — *determined* attacks can still touch in-root files; use Docker/VM for hostile inputs |
| LLM calls | Strict JSON parsing, capped payloads, retry on 413, JSON salvage for truncation | LLM output is patching intelligence only, not a trust authority |
| File patches | Compiler verification + automatic rollback | Full-apply formatting & intent cannot be guaranteed — always read-the-diff before merging |
| Report | Merge verdict strictly derived from aggregated agent severity, not opinion | Static scanners are heuristics; treat BLOCK as “review first”, not auto-reject |

---

## 🩺 Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `GROQ_API_KEY is missing…` at startup | Populate `.env` or set the secret — LLM personas skip and only static scanners run |
| `413 Request too large …` from Groq | Handled internally (halved retry); for larger repos consider paid tier for bigger diffs |
| `BLOCK` verdicts that no visible finding justifies | One of the LLM personas emitted a stray claim — check the reporter table; hallucination guards already drop provably-stale findings, e.g. a lockfile that exists |
| Auto-Fixer says `rolledback` | That patch broke `tsc --noEmit`; the file was restored exactly to its pre-fix snapshot — read the compiler output in the finding explanation |
| PR comment didn't appear | `GITHUB_TOKEN` missing *Actions* write-permission scope (`pull-requests: write`) or the run was on a non-`pull_request` event |
| Windows console errors about `'Security'` | A quoting artifact when the containing folder name embeds `&` — e.g. `... Reviewer & Security Auditor ...`. Prefer running from your terminal directly, or use the short 8.3 path variant (`DOCUME~1\MULTI-~1`) |

---

<div align="center">

**Built with HyperDev** — a self-healing autonomous agent core, hardened for real-world engineering teams.

*Report issues, contribute fixes, and add danger patterns: PRs are welcome — and yes, the pipeline will audit them first.* 🔁

</div>
