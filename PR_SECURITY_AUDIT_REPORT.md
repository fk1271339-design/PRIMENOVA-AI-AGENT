# 🔒 Multi-Agent PR Security & Quality Audit Report

**Generated:** 2026-11-07T10:39:04.426Z
**Reviewed files:** audit_fixtures/vulnerable_demo.ts
**Audit agents:** Security Auditor (static), Security Auditor, Code Quality Reviewer, Dependency Checker, Code Quality Reviewer (static)

## 📌 Executive Summary

| Severity | Count |
|----------|------:|
| Critical | 7 |
| High | 10 |
| Medium | 5 |
| Low | 3 |
| **Total** | **25** |

🔴 **Overall risk level: Critical.** This change-set is **NOT ready to merge** - resolve the Findings highlighted below.

## 🐞 Vulnerability Breakdown

| # | Severity | Title | File | Reported by |
|---|----------|-------|------|-------------|
| 1 | 🔴 Critical | Hardcoded secret / API key detected | `audit_fixtures/vulnerable_demo.ts` :25 | Security Auditor (static) |
| 2 | 🔴 Critical | Password/token assigned a literal string | `audit_fixtures/vulnerable_demo.ts` :24 | Security Auditor (static) |
| 3 | 🔴 Critical | SQL Injection via string concatenation | `audit_fixtures/vulnerable_demo.ts` :13 | Security Auditor (static) |
| 4 | 🔴 Critical | Command Injection via shell string building | `audit_fixtures/vulnerable_demo.ts` :36 | Security Auditor (static) |
| 5 | 🔴 Critical | SQL Injection via string concatenation | `audit_fixtures/vulnerable_demo.ts` :15-18 | Security Auditor |
| 6 | 🔴 Critical | Command Injection via child_process.exec | `audit_fixtures/vulnerable_demo.ts` :44-46 | Security Auditor |
| 7 | 🔴 Critical | Command injection via exec | `audit_fixtures/vulnerable_demo.ts` :31-34 | Code Quality Reviewer |
| 8 | 🟠 High | Possible Cross-Site Scripting (innerHTML / document.write) | `audit_fixtures/vulnerable_demo.ts` :30 | Security Auditor (static) |
| 9 | 🟠 High | Weak hash for security-sensitive data | `audit_fixtures/vulnerable_demo.ts` :41 | Security Auditor (static) |
| 10 | 🟠 High | Hard‑coded session secret | `audit_fixtures/vulnerable_demo.ts` :31 | Security Auditor |
| 11 | 🟠 High | Hard‑coded API token | `audit_fixtures/vulnerable_demo.ts` :32 | Security Auditor |
| 12 | 🟠 High | Cross‑Site Scripting (XSS) via innerHTML | `audit_fixtures/vulnerable_demo.ts` :36-40 | Security Auditor |
| 13 | 🟠 High | Insecure authorization logic with hard‑coded token | `audit_fixtures/vulnerable_demo.ts` :53-55 | Security Auditor |
| 14 | 🟠 High | SQL injection risk in findUserQuery | `audit_fixtures/vulnerable_demo.ts` :13-16 | Code Quality Reviewer |
| 15 | 🟠 High | Hard‑coded secrets in source code | `audit_fixtures/vulnerable_demo.ts` :22-23 | Code Quality Reviewer |
| 16 | 🟠 High | Unsafe HTML injection with any type | `audit_fixtures/vulnerable_demo.ts` :25-30 | Code Quality Reviewer |
| 17 | 🟠 High | Missing lockfile for deterministic builds | `package.json` | Dependency Checker |
| 18 | 🟡 Medium | Weak password hashing (MD5) | `audit_fixtures/vulnerable_demo.ts` :48-51 | Security Auditor |
| 19 | 🟡 Medium | Potential Server‑Side Request Forgery (SSRF) | `audit_fixtures/vulnerable_demo.ts` :71-74 | Security Auditor |
| 20 | 🟡 Medium | Inefficient O(n²) aggregation algorithm | `audit_fixtures/vulnerable_demo.ts` :41-48 | Code Quality Reviewer |
| 21 | 🟡 Medium | Insecure password hashing (MD5) | `audit_fixtures/vulnerable_demo.ts` :35-38 | Code Quality Reviewer |
| 22 | 🟡 Medium | Floating version ranges in dependencies | `package.json` :"@modelcontextprotocol/sdk": "^1.32.2", "dotenv": "^18.0.9", "groq-sdk": "^1.6.0" | Dependency Checker |
| 23 | 🟢 Low | Usage of ': any' weakens type safety | `audit_fixtures/vulnerable_demo.ts` :28 | Code Quality Reviewer (static) |
| 24 | 🟢 Low | Missing error handling in fetchRemoteData | `audit_fixtures/vulnerable_demo.ts` :53-56 | Code Quality Reviewer |
| 25 | 🟢 Low | Use of any type defeats TypeScript safety | `audit_fixtures/vulnerable_demo.ts` :25 | Code Quality Reviewer |

### Critical severity (7)

#### Hardcoded secret / API key detected
- **File:** `audit_fixtures/vulnerable_demo.ts:25`
- **Reported by:** Security Auditor (static)
- **Description:** An API key or secret material is committed in source. Anyone with repo access (or any build log) can steal it and act as this identity. Matched: "'sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'"
- **Suggested fix:** Load the value from process.env / a secret manager and rotate the exposed credential immediately.

#### Password/token assigned a literal string
- **File:** `audit_fixtures/vulnerable_demo.ts:24`
- **Reported by:** Security Auditor (static)
- **Description:** A credential-like name is bound to a literal string, which usually means a hardcoded credential in disguise. Matched: "SECRET = 's3cr3t_fallback_value_9f2b7c5d'"
- **Suggested fix:** Replace with environment configuration and add this file to a secrets scanner (gitleaks/trufflehog).

#### SQL Injection via string concatenation
- **File:** `audit_fixtures/vulnerable_demo.ts:13`
- **Reported by:** Security Auditor (static)
- **Description:** A SQL statement is built by concatenating untrusted input - classic OWASP A03 SQL Injection. Matched: "SELECT id, name, email FROM users WHERE id = ' +"
- **Suggested fix:** Use parameterized queries / prepared statements (e.g. WHERE id = ?) and never concatenate user input into SQL.

#### Command Injection via shell string building
- **File:** `audit_fixtures/vulnerable_demo.ts:36`
- **Reported by:** Security Auditor (static)
- **Description:** A shell command is built from untrusted input and passed to exec/sechenov - OWASP A03 Command Injection. Matched: "exec('maintenance-run --target ' + userInput"
- **Suggested fix:** Use spawn with an args-array (no shell), or a vetted library API; validate input against an allowlist.

#### SQL Injection via string concatenation
- **File:** `audit_fixtures/vulnerable_demo.ts:15-18`
- **Reported by:** Security Auditor
- **Description:** The function builds a SQL query by concatenating the raw `userId` directly into the statement. An attacker can inject malicious SQL, leading to data leakage or modification.
- **Suggested fix:** Use parameterised queries / prepared statements provided by the database driver instead of string concatenation.

```
return 'SELECT id, name, email FROM users WHERE id = ' + userId; // replace with prepared statement
```

#### Command Injection via child_process.exec
- **File:** `audit_fixtures/vulnerable_demo.ts:44-46`
- **Reported by:** Security Auditor
- **Description:** User‑controlled `userInput` is concatenated into a shell command executed with `exec`. An attacker can inject additional commands or arguments, leading to remote code execution on the server.
- **Suggested fix:** Validate/whitelist the input and use `execFile` or spawn with argument array to avoid shell interpretation.

```
return exec('maintenance-run --target ' + userInput).toString(); // replace with execFile('maintenance-run', ['--target', sanitizedInput])
```

#### Command injection via exec
- **File:** `audit_fixtures/vulnerable_demo.ts:31-34`
- **Reported by:** Code Quality Reviewer
- **Description:** runMaintenanceTask builds a shell command by concatenating untrusted userInput and passes it to child_process.exec, allowing an attacker to execute arbitrary commands.
- **Suggested fix:** Validate and whitelist allowed values for userInput, or use execFile/spawn with argument array to avoid shell interpolation.

```
const { exec } = require('child_process');
return exec('maintenance-run --target ' + userInput).toString();
```

### High severity (10)

#### Possible Cross-Site Scripting (innerHTML / document.write)
- **File:** `audit_fixtures/vulnerable_demo.ts:30`
- **Reported by:** Security Auditor (static)
- **Description:** Unsanitized data is written into the DOM, enabling stored/reflected XSS (OWASP A03). Matched: ".innerHTML ="
- **Suggested fix:** Use textContent, or sanitize with DOMPurify before injecting HTML into the DOM.

#### Weak hash for security-sensitive data
- **File:** `audit_fixtures/vulnerable_demo.ts:41`
- **Reported by:** Security Auditor (static)
- **Description:** md5/sha1 are broken for passwords and signatures (OWASP A02 Cryptographic Failures). Matched: "createHash('md5'"
- **Suggested fix:** Use bcrypt/argon2/scrypt for passwords and SHA-256+ for integrity checks.

#### Hard‑coded session secret
- **File:** `audit_fixtures/vulnerable_demo.ts:31`
- **Reported by:** Security Auditor
- **Description:** A static session secret is embedded in source code, making it discoverable in version control and binaries. If leaked, attackers can forge or tamper with session data.
- **Suggested fix:** Load the secret from a secure environment variable or secret manager at runtime; never commit defaults to source.

```
const SESSION_SECRET = 's3cr3t_fallback_value_9f2b7c5d'; // replace with process.env.SESSION_SECRET
```

#### Hard‑coded API token
- **File:** `audit_fixtures/vulnerable_demo.ts:32`
- **Reported by:** Security Auditor
- **Description:** An API token is hard‑coded and exposed in the repository, allowing anyone with code access to call the dashboard API with full privileges.
- **Suggested fix:** Store the token in a protected environment variable or secret vault and reference it at runtime.

```
const DASHBOARD_API_TOKEN = 'sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'; // replace with process.env.DASHBOARD_API_TOKEN
```

#### Cross‑Site Scripting (XSS) via innerHTML
- **File:** `audit_fixtures/vulnerable_demo.ts:36-40`
- **Reported by:** Security Auditor
- **Description:** `loadDashboardTemplate` injects untrusted `rawHtml` into `innerHTML` of the page, allowing an attacker to execute arbitrary JavaScript in the browser context.
- **Suggested fix:** Sanitise the HTML with a library like DOMPurify or, better, avoid injecting raw HTML and use safe templating.

```
el.getElementById('root').innerHTML = rawHtml; // replace with safe rendering
```

#### Insecure authorization logic with hard‑coded token
- **File:** `audit_fixtures/vulnerable_demo.ts:53-55`
- **Reported by:** Security Auditor
- **Description:** Authorization checks a cookie value against a static string `'admin_public_token'`. Anyone who can set this cookie gains admin rights, and the token is effectively a backdoor.
- **Suggested fix:** Implement proper session management and role‑based access control, verifying signed JWTs or server‑side session identifiers.

```
return request.cookies?.role === 'admin_public_token'; // replace with proper auth check
```

#### SQL injection risk in findUserQuery
- **File:** `audit_fixtures/vulnerable_demo.ts:13-16`
- **Reported by:** Code Quality Reviewer
- **Description:** The function concatenates the raw userId into the SQL string, enabling injection attacks.
- **Suggested fix:** Use parameterized queries or a query builder; return the query with a placeholder and bind the value separately.

```
return 'SELECT id, name, email FROM users WHERE id = ' + userId;
```

#### Hard‑coded secrets in source code
- **File:** `audit_fixtures/vulnerable_demo.ts:22-23`
- **Reported by:** Code Quality Reviewer
- **Description:** SESSION_SECRET and DASHBOARD_API_TOKEN are stored in plain text, exposing them to source‑code leaks.
- **Suggested fix:** Move secrets to environment variables or a secure secret manager and reference them at runtime.

```
const SESSION_SECRET = 's3cr3t_fallback_value_9f2b7c5d';
const DASHBOARD_API_TOKEN = 'sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';
```

#### Unsafe HTML injection with any type
- **File:** `audit_fixtures/vulnerable_demo.ts:25-30`
- **Reported by:** Code Quality Reviewer
- **Description:** loadDashboardTemplate inserts rawHtml directly into innerHTML without sanitization and uses the any type, opening XSS vectors and losing type safety.
- **Suggested fix:** Sanitize rawHtml using a library like DOMPurify, and type the document object properly (e.g., Document | undefined).

```
const el: any = (globalThis as unknown as { document?: any }).document;
if (el && el.getElementById('root')) {
  el.getElementById('root').innerHTML = rawHtml;
}
```

#### Missing lockfile for deterministic builds
- **File:** `package.json`
- **Reported by:** Dependency Checker
- **Description:** Without a lockfile (package-lock.json, yarn.lock, pnpm-lock.yaml), the exact resolved versions of transitive dependencies are not recorded, making builds non‑deterministic and increasing supply‑chain risk.
- **Suggested fix:** Generate and commit a lockfile using the package manager in use (e.g., `npm install --package-lock` or `yarn install`). Ensure CI enforces lockfile consistency.

```
// After installing dependencies
npm install   // creates package-lock.json
// Commit the generated lockfile to version control
```

### Medium severity (5)

#### Weak password hashing (MD5)
- **File:** `audit_fixtures/vulnerable_demo.ts:48-51`
- **Reported by:** Security Auditor
- **Description:** Passwords are hashed with MD5, which is fast and vulnerable to collision and rainbow‑table attacks. This does not provide adequate protection for stored credentials.
- **Suggested fix:** Use a strong password‑hashing algorithm such as bcrypt, Argon2, or PBKDF2 with a per‑user salt.

```
return crypto.createHash('md5').update(password).digest('hex'); // replace with bcrypt.hash(password, saltRounds)
```

#### Potential Server‑Side Request Forgery (SSRF)
- **File:** `audit_fixtures/vulnerable_demo.ts:71-74`
- **Reported by:** Security Auditor
- **Description:** `fetchRemoteData` fetches any URL supplied by the caller without validation. An attacker could cause the server to request internal services or metadata endpoints.
- **Suggested fix:** Validate the URL against an allow‑list of trusted domains or use a proxy that restricts outbound requests.

```
const response = await fetch(url); // replace with validation before fetch
```

#### Inefficient O(n²) aggregation algorithm
- **File:** `audit_fixtures/vulnerable_demo.ts:41-48`
- **Reported by:** Code Quality Reviewer
- **Description:** sumAggregates uses a nested loop over the same array to count equal pairs, resulting in quadratic time complexity for potentially large datasets.
- **Suggested fix:** Use a hashmap to count occurrences in O(n) time, then compute the aggregate based on counts.

```
for (const r of rows) {
  for (const s of rows) {
    if (r === s) total += 1;
  }
}
```

#### Insecure password hashing (MD5)
- **File:** `audit_fixtures/vulnerable_demo.ts:35-38`
- **Reported by:** Code Quality Reviewer
- **Description:** hashPassword uses MD5, which is cryptographically broken and unsuitable for password storage.
- **Suggested fix:** Replace MD5 with a strong password‑hashing algorithm such as bcrypt, scrypt, or Argon2.

```
return crypto.createHash('md5').update(password).digest('hex');
```

#### Floating version ranges in dependencies
- **File:** `package.json:"@modelcontextprotocol/sdk": "^1.32.2", "dotenv": "^18.0.9", "groq-sdk": "^1.6.0"`
- **Reported by:** Dependency Checker
- **Description:** Caret ranges allow automatic upgrades to any compatible minor/patch version, which can introduce breaking changes or vulnerable code without explicit review.
- **Suggested fix:** Pin exact versions (e.g., "1.32.2") and regularly audit updates. Use a tool like npm‑ci or npm‑audit to manage upgrades.

```
"@modelcontextprotocol/sdk": "1.32.2",
"dotenv": "18.0.9",
"groq-sdk": "1.6.0"
```

### Low severity (3)

#### Usage of ': any' weakens type safety
- **File:** `audit_fixtures/vulnerable_demo.ts:28`
- **Reported by:** Code Quality Reviewer (static)
- **Description:** Explicit any disables TypeScript checking for this value. Matched: ": any"
- **Suggested fix:** Use specific types/interfaces, generics, or unknown + narrowing.

#### Missing error handling in fetchRemoteData
- **File:** `audit_fixtures/vulnerable_demo.ts:53-56`
- **Reported by:** Code Quality Reviewer
- **Description:** The async function fetchRemoteData does not catch network or JSON parsing errors, which could cause unhandled promise rejections.
- **Suggested fix:** Wrap the fetch and response.json() calls in try/catch and propagate or handle errors appropriately.

```
const response = await fetch(url);
return response.json();
```

#### Use of any type defeats TypeScript safety
- **File:** `audit_fixtures/vulnerable_demo.ts:25`
- **Reported by:** Code Quality Reviewer
- **Description:** The variable el is typed as any, bypassing compile‑time checks and hiding potential null/undefined errors.
- **Suggested fix:** Define a proper type for the global document (e.g., Document | undefined) and avoid any.

```
const el: any = (globalThis as unknown as { document?: any }).document;
```

## 🛠️ Suggested Code Fixes

| File | Issue | Recommended fix |
|------|-------|-----------------|
| `audit_fixtures/vulnerable_demo.ts:25` | Hardcoded secret / API key detected | Load the value from process.env / a secret manager and rotate the exposed credential immediately. |
| `audit_fixtures/vulnerable_demo.ts:24` | Password/token assigned a literal string | Replace with environment configuration and add this file to a secrets scanner (gitleaks/trufflehog). |
| `audit_fixtures/vulnerable_demo.ts:13` | SQL Injection via string concatenation | Use parameterized queries / prepared statements (e.g. WHERE id = ?) and never concatenate user input into SQL. |
| `audit_fixtures/vulnerable_demo.ts:36` | Command Injection via shell string building | Use spawn with an args-array (no shell), or a vetted library API; validate input against an allowlist. |
| `audit_fixtures/vulnerable_demo.ts:15-18` | SQL Injection via string concatenation | Use parameterised queries / prepared statements provided by the database driver instead of string concatenation. |
| `audit_fixtures/vulnerable_demo.ts:44-46` | Command Injection via child_process.exec | Validate/whitelist the input and use `execFile` or spawn with argument array to avoid shell interpretation. |
| `audit_fixtures/vulnerable_demo.ts:31-34` | Command injection via exec | Validate and whitelist allowed values for userInput, or use execFile/spawn with argument array to avoid shell interpolation. |
| `audit_fixtures/vulnerable_demo.ts:30` | Possible Cross-Site Scripting (innerHTML / document.write) | Use textContent, or sanitize with DOMPurify before injecting HTML into the DOM. |
| `audit_fixtures/vulnerable_demo.ts:41` | Weak hash for security-sensitive data | Use bcrypt/argon2/scrypt for passwords and SHA-256+ for integrity checks. |
| `audit_fixtures/vulnerable_demo.ts:31` | Hard‑coded session secret | Load the secret from a secure environment variable or secret manager at runtime; never commit defaults to source. |
| `audit_fixtures/vulnerable_demo.ts:32` | Hard‑coded API token | Store the token in a protected environment variable or secret vault and reference it at runtime. |
| `audit_fixtures/vulnerable_demo.ts:36-40` | Cross‑Site Scripting (XSS) via innerHTML | Sanitise the HTML with a library like DOMPurify or, better, avoid injecting raw HTML and use safe templating. |
| `audit_fixtures/vulnerable_demo.ts:53-55` | Insecure authorization logic with hard‑coded token | Implement proper session management and role‑based access control, verifying signed JWTs or server‑side session identifiers. |
| `audit_fixtures/vulnerable_demo.ts:13-16` | SQL injection risk in findUserQuery | Use parameterized queries or a query builder; return the query with a placeholder and bind the value separately. |
| `audit_fixtures/vulnerable_demo.ts:22-23` | Hard‑coded secrets in source code | Move secrets to environment variables or a secure secret manager and reference them at runtime. |
| `audit_fixtures/vulnerable_demo.ts:25-30` | Unsafe HTML injection with any type | Sanitize rawHtml using a library like DOMPurify, and type the document object properly (e.g., Document \| undefined). |
| `package.json` | Missing lockfile for deterministic builds | Generate and commit a lockfile using the package manager in use (e.g., `npm install --package-lock` or `yarn install`). Ensure CI enforces lockfile consistency. |
| `audit_fixtures/vulnerable_demo.ts:48-51` | Weak password hashing (MD5) | Use a strong password‑hashing algorithm such as bcrypt, Argon2, or PBKDF2 with a per‑user salt. |
| `audit_fixtures/vulnerable_demo.ts:71-74` | Potential Server‑Side Request Forgery (SSRF) | Validate the URL against an allow‑list of trusted domains or use a proxy that restricts outbound requests. |
| `audit_fixtures/vulnerable_demo.ts:41-48` | Inefficient O(n²) aggregation algorithm | Use a hashmap to count occurrences in O(n) time, then compute the aggregate based on counts. |
| `audit_fixtures/vulnerable_demo.ts:35-38` | Insecure password hashing (MD5) | Replace MD5 with a strong password‑hashing algorithm such as bcrypt, scrypt, or Argon2. |
| `package.json:"@modelcontextprotocol/sdk": "^1.32.2", "dotenv": "^18.0.9", "groq-sdk": "^1.6.0"` | Floating version ranges in dependencies | Pin exact versions (e.g., "1.32.2") and regularly audit updates. Use a tool like npm‑ci or npm‑audit to manage upgrades. |
| `audit_fixtures/vulnerable_demo.ts:28` | Usage of ': any' weakens type safety | Use specific types/interfaces, generics, or unknown + narrowing. |
| `audit_fixtures/vulnerable_demo.ts:53-56` | Missing error handling in fetchRemoteData | Wrap the fetch and response.json() calls in try/catch and propagate or handle errors appropriately. |
| `audit_fixtures/vulnerable_demo.ts:25` | Use of any type defeats TypeScript safety | Define a proper type for the global document (e.g., Document \| undefined) and avoid any. |

### Diff snippets

**SQL Injection via string concatenation** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# The function builds a SQL query by concatenating the raw `userId` directly into the statement. An attacker can inject malicious SQL, leading to data leakage or modification.
+ // FIX
+ return 'SELECT id, name, email FROM users WHERE id = ' + userId; // replace with prepared statement
```

**Command Injection via child_process.exec** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# User‑controlled `userInput` is concatenated into a shell command executed with `exec`. An attacker can inject additional commands or arguments, leading to remote code execution on the server.
+ // FIX
+ return exec('maintenance-run --target ' + userInput).toString(); // replace with execFile('maintenance-run', ['--target', sanitizedInput])
```

**Command injection via exec** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# runMaintenanceTask builds a shell command by concatenating untrusted userInput and passes it to child_process.exec, allowing an attacker to execute arbitrary commands.
+ // FIX
+ const { exec } = require('child_process');
+ return exec('maintenance-run --target ' + userInput).toString();
```

**Hard‑coded session secret** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# A static session secret is embedded in source code, making it discoverable in version control and binaries. If leaked, attackers can forge or tamper with session data.
+ // FIX
+ const SESSION_SECRET = 's3cr3t_fallback_value_9f2b7c5d'; // replace with process.env.SESSION_SECRET
```

**Hard‑coded API token** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# An API token is hard‑coded and exposed in the repository, allowing anyone with code access to call the dashboard API with full privileges.
+ // FIX
+ const DASHBOARD_API_TOKEN = 'sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'; // replace with process.env.DASHBOARD_API_TOKEN
```

**Cross‑Site Scripting (XSS) via innerHTML** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# `loadDashboardTemplate` injects untrusted `rawHtml` into `innerHTML` of the page, allowing an attacker to execute arbitrary JavaScript in the browser context.
+ // FIX
+ el.getElementById('root').innerHTML = rawHtml; // replace with safe rendering
```

**Insecure authorization logic with hard‑coded token** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# Authorization checks a cookie value against a static string `'admin_public_token'`. Anyone who can set this cookie gains admin rights, and the token is effectively a backdoor.
+ // FIX
+ return request.cookies?.role === 'admin_public_token'; // replace with proper auth check
```

**SQL injection risk in findUserQuery** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# The function concatenates the raw userId into the SQL string, enabling injection attacks.
+ // FIX
+ return 'SELECT id, name, email FROM users WHERE id = ' + userId;
```

**Hard‑coded secrets in source code** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# SESSION_SECRET and DASHBOARD_API_TOKEN are stored in plain text, exposing them to source‑code leaks.
+ // FIX
+ const SESSION_SECRET = 's3cr3t_fallback_value_9f2b7c5d';
+ const DASHBOARD_API_TOKEN = 'sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';
```

**Unsafe HTML injection with any type** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# loadDashboardTemplate inserts rawHtml directly into innerHTML without sanitization and uses the any type, opening XSS vectors and losing type safety.
+ // FIX
+ const el: any = (globalThis as unknown as { document?: any }).document;
+ if (el && el.getElementById('root')) {
+   el.getElementById('root').innerHTML = rawHtml;
+ }
```

**Missing lockfile for deterministic builds** — `package.json`

```diff
- // current (vulnerable)
# Without a lockfile (package-lock.json, yarn.lock, pnpm-lock.yaml), the exact resolved versions of transitive dependencies are not recorded, making builds non‑deterministic and increasing supply‑chain risk.
+ // FIX
+ // After installing dependencies
+ npm install   // creates package-lock.json
+ // Commit the generated lockfile to version control
```

**Weak password hashing (MD5)** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# Passwords are hashed with MD5, which is fast and vulnerable to collision and rainbow‑table attacks. This does not provide adequate protection for stored credentials.
+ // FIX
+ return crypto.createHash('md5').update(password).digest('hex'); // replace with bcrypt.hash(password, saltRounds)
```

**Potential Server‑Side Request Forgery (SSRF)** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# `fetchRemoteData` fetches any URL supplied by the caller without validation. An attacker could cause the server to request internal services or metadata endpoints.
+ // FIX
+ const response = await fetch(url); // replace with validation before fetch
```

**Inefficient O(n²) aggregation algorithm** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# sumAggregates uses a nested loop over the same array to count equal pairs, resulting in quadratic time complexity for potentially large datasets.
+ // FIX
+ for (const r of rows) {
+   for (const s of rows) {
+     if (r === s) total += 1;
+   }
+ }
```

**Insecure password hashing (MD5)** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# hashPassword uses MD5, which is cryptographically broken and unsuitable for password storage.
+ // FIX
+ return crypto.createHash('md5').update(password).digest('hex');
```

**Floating version ranges in dependencies** — `package.json`

```diff
- // current (vulnerable)
# Caret ranges allow automatic upgrades to any compatible minor/patch version, which can introduce breaking changes or vulnerable code without explicit review.
+ // FIX
+ "@modelcontextprotocol/sdk": "1.32.2",
+ "dotenv": "18.0.9",
+ "groq-sdk": "1.6.0"
```

**Missing error handling in fetchRemoteData** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# The async function fetchRemoteData does not catch network or JSON parsing errors, which could cause unhandled promise rejections.
+ // FIX
+ const response = await fetch(url);
+ return response.json();
```

**Use of any type defeats TypeScript safety** — `audit_fixtures/vulnerable_demo.ts`

```diff
- // current (vulnerable)
# The variable el is typed as any, bypassing compile‑time checks and hiding potential null/undefined errors.
+ // FIX
+ const el: any = (globalThis as unknown as { document?: any }).document;
```

## ✅ Final Merge Status

# 🚫 BLOCK

7 Critical issue(s) must be fixed before merge.

---
_Report generated by the HyperDev Multi-Agent PR Reviewer & Security Auditor pipeline._
