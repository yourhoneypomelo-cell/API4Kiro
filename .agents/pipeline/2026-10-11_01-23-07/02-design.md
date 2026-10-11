# Design (rev 2): stop the startup "Unable to fetch account usage data: connect ECONNREFUSED 127.0.0.1:19811" toast

## Overview

kiro-agent activates before us because it is in our `extensionDependencies`. Its usage-limits handler hits the persisted CPS endpoint before our CPS has bound the port, gets ECONNREFUSED, and toasts. Three changes, all in TypeScript inside the existing extension (TypeScript 5.5, esbuild bundle, Node built-ins only, no new dependencies, no test framework; verification is a `node` script under `dev/`):

1. A new optional hook, "usageRetry", in kiro-agent `dist/extension.js`. It lives in `src/selectorStyle.ts`, in the same `planKiroAgentBackend` plan and the same file as the modelConfigProvider and ctxHost hooks. It retries the inner `send` on loopback ECONNREFUSED (500 ms steps, 10 s budget). If retries run out it logs `warn` instead of toasting. It follows the CTX/ROW pattern: pure insertions inside `/*a2k-usage:start*/…/*a2k-usage:end*/` segments, restored by deleting the segments. Its status is reported only through `extras.usageRetry`; it never changes `targets.backend`.
2. Early port binding. `activate()` starts both PortHolders in parallel immediately after `initConfig`, before `initIdentityKey`. Only the busy-port probe and identity-answer paths wait for the key. An activation gate holds the CPS model-list branch and all of KRS dispatch until the rest of `activate()` finishes. CPS profile/usage/passthrough stubs are not gated, so kiro-agent's early `GetUsageLimits` is answered as soon as the port is bound.
3. A one-shot `kiro.usageLimits.getUsageLimits` refresh, fired the first time CPS is OWNER in this host.

Facts verified on the installed build (`/Applications/Kiro.app/.../kiro.kiro-agent/dist/extension.js`, read-only; confirmed again by the design review):
- `"kiro.usageLimits.getUsageLimits",async` occurs once; `` `Unable to fetch account usage data `` occurs once, ~588 chars later.
- Exactly one `xW("GetUsageLimits",l,()=>u.send(d))` falls between the two (2 file-wide).
- `catch(f){let h=` ends exactly at the literal. The tail `?X.warn(h):(X.error(h),WEf(h))}` appears once, ~327 chars after the literal.
- `c(WEf,"showErrorToastRateLimited");` appears once.
- `xW` (withCpsTelemetry) rethrows the same error object, so a property set inside the thunk is visible in the handler's `catch(f)`.
- No `a2k-usage` exists yet; the file already contains `__kiroModelConfigProvider` and `a2k-ctx` hooks.
- The startup caller `Po("UsageMonitoring",()=>{e$a(t,…)})` does not await the handler; login and profile-watcher callers are event-driven. A retrying handler cannot block kiro-agent's activation (and therefore ours).

## 1. usageRetry hook (`src/selectorStyle.ts`)

### Patched shape

Original (current-build names; all captured structurally):

```js
let f=await xW("GetUsageLimits",l,()=>u.send(d)),h=GEf(f,l);...
}catch(f){let h=`Unable to fetch account usage data...`;...;HEf(f)?(...):VEf(f)?X.warn(h):(X.error(h),WEf(h))}
```

Insertion A wraps the thunk body, so the retry runs inside `xW` and telemetry counts once per handler call:

```js
()=>/*a2k-usage:start*/(USAGE_RETRY_FN)(()=>/*a2k-usage:end*/u.send(d)/*a2k-usage:start*/)/*a2k-usage:end*/
```

Insertion B goes right after the `:` preceding the error/toast branch:

```js
?X.warn(h):/*a2k-usage:start*/f&&f.__a2kLocalRefused?X.warn(h):/*a2k-usage:end*/(X.error(h),WEf(h))}
```

Ternary associativity gives `VEf(f)?X.warn(h):(f&&f.__a2kLocalRefused?X.warn(h):(X.error(h),WEf(h)))`. All other errors take the original path. FEATURE_NOT_SUPPORTED and throttling are tested earlier and are unaffected. The result object is built before the branch, so its shape is unchanged.

`USAGE_RETRY_FN` comes from `renderUsageRetry(delayMs = 500, budgetMs = 10000)`. It is exported for tests only; production uses the defaults. Every identifier it declares is `a2k`-prefixed and it references only globals (`Date`, `setTimeout`, `Promise`, `Object`, `String`), so `namesCollide` is not needed. The rendered text must not contain `*/` (asserted in the verify script).

```js
async a2kRun=>{
  const a2kLocal=a2kE=>{ if(!a2kE)return!1;
    const a2kM=String(a2kE.message||"");
    const a2kRefused=a2kE.code==="ECONNREFUSED"||/ECONNREFUSED/.test(a2kM);
    const a2kLoop=/^(?:127\.|::1$|::ffff:127\.|localhost$)/.test(String(a2kE.address||""))
      ||/(?:127(?:\.\d{1,3}){3}|localhost|\[?::1\]?):\d{1,5}/.test(a2kM);
    return a2kRefused&&a2kLoop };
  const a2kEnd=Date.now()+BUDGET;
  for(;;){ try{ return await a2kRun() }catch(a2kE){
    if(!a2kLocal(a2kE))throw a2kE;
    if(Date.now()+DELAY>a2kEnd){ try{Object.defineProperty(a2kE,"__a2kLocalRefused",{value:!0})}catch(a2kX){} throw a2kE }
    await new Promise(a2kR=>setTimeout(a2kR,DELAY)) } } }
```

- Any loopback host or port matches (A3), via `code`/`address` or the message, so it survives SDK error wrapping.
- If `defineProperty` fails on a frozen error, the toast shows as today (fail-open to original behavior).
- The retried thunk re-sends the same smithy `GetUsageLimitsCommand` instance. The SDK's serializer/deserializer/endpoint middleware are `override:!0`, so re-`use` on each send replaces rather than duplicates. This is not verifiable without a live Kiro; it is on the manual checklist (see Verification). The matcher (step 3) requires the thunk shape `()=>X.send(Y)` and additionally checks that `Y` is declared in the handler slice as `Y=new <ident>.GetUsageLimitsCommand(` or `Y=new <ident>(` preceded within the slice by the string `GetUsageLimitsCommand` — see step 3a.

### Matching: `findUsageHook(content): UsageHookHit | null`

All conditions must hold; otherwise null and the hook is skipped with no partial change.

1. `REG = '"kiro.usageLimits.getUsageLimits",async'` occurs exactly once, at index `r`.
2. `LIT = '`Unable to fetch account usage data'` occurs exactly once, at index `l`, with `r < l` and `l - r <= 1500`.
3. In `content.slice(r, l)`, the regex ``(?<![\w$])(I)\("GetUsageLimits",(I),\(\)=>((I)\.send\((I)\))\)`` (I = `IDENT_SRC`) matches exactly once. Group 3's absolute start/end are insertion A's prefix/suffix positions; group 5 is `cmdVar`.
   - 3a. In the same slice, `(?<![\w$])CMD=new ` (CMD = `escapeRe(cmdVar)`) matches at least once and the slice contains `GetUsageLimits`. This confirms `cmdVar` is a constructed Command. If the installed build fails 3a, the implementer drops 3a (it's a confidence check, not a correctness need) and notes it in the report; the R1 check settles which.
4. End-anchor check on the catch head: `` new RegExp(`catch\\((${IDENT_SRC})\\)\\{let (${IDENT_SRC})=$`).exec(content.slice(Math.max(0, l - 80), l)) `` matches. Captures `errVar` (f) and `msgVar` (h).
5. In `content.slice(l, l + 1200)`, ``\?(I)\.warn\(MSG\):\(\1\.error\(MSG\),(I)\(MSG\)\)\}`` matches exactly once (MSG = `escapeRe(msgVar)`). Insertion point is just after `:`. Captures `logger` and `toast`.
6. ``(?<![\w$])(I)\((I),"showErrorToastRateLimited"\);`` occurs exactly once file-wide and group 2 equals `toast`.

`applyUsageHook(content)` returns content unchanged when `findUsageHook` is null. Otherwise it splices from the highest offset down: B, A's suffix, A's prefix. `restoreUsageHook(content)` is `content.replace(USAGE_SEGMENT_RE, m => m.length <= USAGE_SEGMENT_MAX ? "" : m)` with `USAGE_SEGMENT_RE = /\/\*a2k-usage:start\*\/[\s\S]*?\/\*a2k-usage:end\*\//g` and `USAGE_SEGMENT_MAX = 4000`. Every insertion is delimited, so deletion restores the original byte-for-byte for any template version.

No `a2k-orig` base64 marker is used. That marker exists for whole-span replacements (the popover, the backend setter). CTX and ROW are pure insertions and use delimited segments; this hook is the same kind of change. This satisfies FR-1.5's "markers and/or start/end" clause.

### Plan integration (`planKiroAgentBackend`)

`FilePlan` gains an optional `log?: string` (commit-log override). `planKiroAgentBackend`:

```ts
let original: string;
try { original = await fs.promises.readFile(file, "utf8"); }
catch { return { status: "unavailable", files: [], extras: { usageRetry: "unchanged" } }; } // non-Kiro host: no drift log
await sweepStaleTmp(file);
let content = restoreUsageHook(restoreCtxHostHook(restoreBackendHook(original)));
if (enabled) {
  content = applyBackendHook(content);
  if (/__kiroModelConfigProvider=t/.test(content)) content = applyCtxHostHook(content);
  content = applyUsageHook(content);                       // independent of channel A (A2)
}
const mainHooked = /__kiroModelConfigProvider=t/.test(content);
// backend status ignores the usage segments (FR-1.7); ctx-only changes keep counting as applied/removed as today
const coreChanged = restoreUsageHook(content) !== restoreUsageHook(original);
const usageBefore = original.includes(USAGE_START), usageAfter = content.includes(USAGE_START);
const usageChanged = usageBefore !== usageAfter;
const status: TargetStatus = enabled
  ? (mainHooked ? (coreChanged ? "applied" : "unchanged") : "unavailable")
  : (coreChanged ? "removed" : "unchanged");
const extras = {
  ctxHost: ctxStatus(enabled, original.includes("__a2kSessionConfigOption"), content.includes("__a2kSessionConfigOption")),
  usageRetry: ctxStatus(enabled, usageBefore, usageAfter),
};
if (content === original) return { status, files: [], extras };
const usageLog = enabled ? "hooked kiroAgent usage-limits retry" : "restored kiroAgent usage-limits retry";
const log = !coreChanged ? usageLog : usageChanged ? `${status === "removed" ? TARGET_LOG.backend.off : TARGET_LOG.backend.on} + ${usageLog}` : undefined;
return { status, files: [{ file, original, next: content, ...(log ? { log } : {}) }], extras };
```

Behavior versus today:
- Main hook drifted + usage applies: file written for usage alone, `targets.backend = "unavailable"` (unchanged semantics), `extras.usageRetry = "applied"`, reload prompt shown (below).
- Main hook already present + usage newly added: `targets.backend = "unchanged"`, so the overall `status` is not flipped by usage; `extras.usageRetry = "applied"`; one reload prompt.
- Idempotence: restore-then-apply on an already-patched file yields `content === original`, no write.
- `TARGET_LOG` / `TargetKey` / `COMMIT_ORDER` stay three entries; usage rides in the backend plan's single `FilePlan`, so `commitPlans`' all-or-nothing rollback covers it automatically.

`commitPlans` change, one line: `info(fp.log ?? (plan.status === "removed" ? TARGET_LOG[key].off : TARGET_LOG[key].on), fp.file);`. The log now reflects the actual change. The existing comment about not misreporting (2026-09-15) is extended to mention `fp.log`.

### Types and reporting
- `export type ExtraKey = CtxTargetKey | "usageRetry"`; `export type SyncExtras = Record<ExtraKey, TargetStatus>`.
- `StyleSyncResult.extras: SyncExtras`; `TargetPlan.extras?: Partial<SyncExtras>`; `extraOf` takes `ExtraKey`. `CtxExtras` stays exported as an alias subset for existing callers.
- `syncGroupHeaderStyleUnlocked` adds `usageRetry: extraOf(backend, committed.backend, "usageRetry")`. A rollback/write failure (`unavailable` with detail) reports `usageRetry = "unavailable"` via the existing `extraOf` rule.
- Drift log, once per host: module-level `let usageDriftLogged = false`. Log `info("usage-limits retry hook (optional): unavailable — kiro-agent may still toast ECONNREFUSED on startup")` only when `enabled && extras.usageRetry === "unavailable" && !committed.backend.detail && !usageDriftLogged`, then set the flag. The read-failure branch returns `usageRetry: "unchanged"`, so plain VS Code hosts never log it. The ctx log stays separate and unchanged.
- The overall `status` computation is untouched. Because `targets.backend` no longer reflects usage-only changes, usage cannot flip it.
- `src/extension.ts` `afterStyleSync`:

  ```ts
  const coreApplied = t.style === "applied" || t.selectorScript === "applied" || t.backend === "applied";
  if (coreApplied) promptReload("已写入 Kiro 外观补丁与模型刷新钩子", "Kiro 才会加载新外观，左侧改模型才会即时同步到右侧选择器");
  else if (result.extras.usageRetry === "applied") promptReload("已写入 kiro-agent 用量重试钩子", "kiro-agent 启动时才会等待本地端口，不再弹 ECONNREFUSED 提示");
  ```

  `promptReload` is already deduplicated per host, so at most one prompt appears.
- Export `findUsageHook`, `applyUsageHook`, `restoreUsageHook`, `renderUsageRetry`, `USAGE_START`, `USAGE_END`, `USAGE_SEGMENT_RE` via `__selectorStyleInternals.matchers`.

### Error handling
| Failure | Recoverable? | Caller sees | Log |
|---|---|---|---|
| File read fails (non-Kiro host) | yes, skip | backend `unavailable`, no files, `usageRetry: unchanged` | none (existing) |
| Usage anchor drift | yes, skip hook only | `extras.usageRetry = unavailable`; other hooks unaffected | info, once per host |
| Write fails, enabled | yes, rollback | backend `unavailable` + detail, `usageRetry = unavailable`; `notifyStyleSync` warns | error (existing) |
| Write fails, disabled | best-effort | per-file detail as today | error (existing) |
| Retry exhausted in kiro-agent | yes | kiro-agent returns its original `{data:null,error}` shape, no toast | kiro-agent `warn` |

Restore runs on `syncGroupHeaderStyle(false)` (toggle-off and activation with proxy off) and when `groupHeaderStyle` is off — the same paths as the existing hooks.

## 2. Early bind (`src/extension.ts`, `src/proxyIdentity.ts`, `src/identityKey.ts`, new `src/activationGate.ts`, `src/krsServer.ts`, `src/cpsServer.ts`)

### Lazy identity key (`proxyIdentity.ts`, `identityKey.ts`)

```ts
let keyReady: Promise<void> = Promise.resolve();
let keyPending = false;
export function setIdentityKeyPending(p: Promise<unknown>): void {
  keyPending = true;
  keyReady = p.then(() => undefined, () => undefined).finally(() => { keyPending = false; });
}
export function identityKeyReady(): Promise<void> { return keyReady; }
```

- `probeIdentity` begins with `await keyReady` (becomes async, same resolved type). Both `tryAcquire` probes (identity check and yield request) go through it, so `bindOnce` never waits on the key.
- `serveIdentity` keeps its synchronous `boolean` contract. The path check stays synchronous. Everything after it moves verbatim into `function answerIdentity(params, res, role, headers): void` — including `verifyYield` and `identitySignature`, so both run only once the key exists. `serveIdentity` calls `answerIdentity(...)` synchronously when `!keyPending`, otherwise `void keyReady.then(() => { if (!res.destroyed && !res.writableEnded) answerIdentity(...); })`, and returns `true`. Tests that call `setIdentityKey` directly see today's behavior.
- Why defer: without a key, `sig` is omitted and peers ≥ `SIGNED_IDENTITY_SINCE` would classify us as foreign, and a legitimate signed yield would get 403. The key is a local file read of a few ms, well inside the peer's 1500 ms probe timeout.
- `identityKey.initIdentityKey` sets pending at the very top, before any I/O:

  ```ts
  export async function initIdentityKey(context): Promise<void> {
    let done!: () => void;
    setIdentityKeyPending(new Promise<void>((r) => (done = r)));   // first statement: runs synchronously on call
    try { /* existing body unchanged */ } finally { done(); }
  }
  ```

  It still never rejects (the existing body already swallows errors; the `finally` resolves pending in all cases).

### Activation gate (new `src/activationGate.ts`)

```ts
let state: "open" | "pending" | "failed" = "open";
let settle: ((ok: boolean) => void) | undefined;
let settled: Promise<boolean> = Promise.resolve(true);
export function beginActivationGate(): void            // state="pending"; settled = new Promise(r => settle = r)
export function settleActivationGate(ok: boolean): void // state = ok ? "open" : "failed"; settle?.(ok); settle = undefined
export function isActivationReady(): boolean           // state === "open"
export function whenActivationReady(timeoutMs = 10_000): Promise<boolean> {
  if (state !== "pending") return Promise.resolve(state === "open");
  return Promise.race([
    settled,
    new Promise<boolean>((r) => { const t = setTimeout(() => r(false), timeoutMs); t.unref?.(); void settled.then(() => clearTimeout(t)); }),
  ]);
}
```

- Defaults to open, so toggle paths, tests and any code that never calls `beginActivationGate` behave as today.
- `false` means timed out or activation failed. Callers then answer 503 and never dispatch.

Shared helper in `activationGate.ts`:

```ts
export function holdUntilReady(req, res, dispatch: () => void): void {
  if (isActivationReady()) { dispatch(); return; }
  void whenActivationReady().then((ok) => {
    if (res.destroyed || res.writableEnded || req.socket.destroyed) return;   // client gave up
    if (!ok) {
      warnEarlyOnce();                       // module flag: warn("request arrived before activation finished; answered 503")
      req.resume();
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "2" });
      res.end(JSON.stringify({ message: "API4Kiro is still initializing" }));
      return;
    }
    dispatch();
  });
}
```

### Handlers
- KRS: `KrsProxyServer.handleRequest` keeps guard → CORS headers → OPTIONS → identity. Everything after identity moves verbatim into `private dispatch(req, res, url, method)`, called via `holdUntilReady(req, res, () => this.dispatch(...))`. All KRS routes depend on tokens/providers/stores, so all are gated. The body stays paused while waiting; KRS's `close` listener is attached inside `dispatch`, and the destroyed check covers disconnects during the wait.
- CPS: only the model-list branch is gated. Inside `if (op === "listavailablemodels" || …)`, after `req.resume()` and before `buildModelList()`, wrap the existing body: `holdUntilReady(req, res, () => { const t0 = Date.now(); this.buildModelList()… })`. (`req.resume()` before waiting is fine; that branch never reads the body.) Profile, `getusagelimits` and passthrough stubs stay ungated.
- `requestGuard` and identity run before any gate, unchanged.

AC6 audit (goes into implementation notes):
- CPS profile / getusagelimits / passthrough: depend only on `isEnabled()` and constants; `initConfig` runs before the bind. Safe early.
- CPS listavailablemodels: depends on providers, tokenStore, catalogs, modelStore → gated.
- KRS everything: tokens, usageStore, promptStore, endpoints, imagePolicy, clientIdentity → gated.
- Identity endpoint: waits on the key only (above).

### `activate()` order

```ts
initLog(); initConfig(context);
info("activating, version", ...);                 // moved up so logs measure bind latency
usageRefreshFired = false;
let serversUp: Promise<boolean> | undefined;
if (isEnabled()) { beginActivationGate(); serversUp = startServers(context); }  // listen() issued first
// Safe to load the key after issuing listen(): no identity code (probeIdentity / serveIdentity) can run before
// the next event-loop turn, and initIdentityKey marks the key pending synchronously in this same turn.
const keyInit = initIdentityKey(context);
try {
  await keyInit;
  /* unchanged, same order: initEndpoints … initPromptStore, await initTokenStore, setOAuthClientVersion,
     dispose hooks, statusBar, sidebar + webview registration, registerCommands, registerSessionConfigHook,
     void checkForUpdate */
} catch (e) {
  settleActivationGate(false);                    // queued/early requests get 503, never half-initialized state
  if (serversUp) { await serversUp; await stopServers(); }
  throw e;                                        // activation fails exactly as today
}
settleActivationGate(true);
if (isEnabled()) {
  const ok = serversUp ? await serversUp : await startServers(context);   // enabled flipped mid-activation: bind now
  if (ok) await finishStartAndOverride(context, false);
  void syncGroupHeaderStyle(getGroupHeaderStyle()).then(afterStyleSync);
} else {
  if (serversUp) { await serversUp; await stopServers(); }               // disabled mid-activation
  await restoreAll(); void syncGroupHeaderStyle(false).then(notifyStyleSync); updateStatusBar();
}
/* watcher registration + updateStatusBar unchanged */
```

`startAndOverride` is split, with no body-semantics change:
- `startServers(context): Promise<boolean>` sets `krsPort`/`cpsPort`, constructs missing servers, and runs `await Promise.all([cps.start(), krs.start()])` (CPS first, parallel). The construction and the `start()` calls happen in the function's synchronous prefix (no `await` before them), so `listen()` is issued before `initIdentityKey` runs; the implementer must keep it that way. On throw: the existing catch (`error("failed to start servers:")`, `showErrorMessage`, `updateStatusBar()`), return `false`. `updateStatusBar` and `sidebar?.` are already undefined-safe before creation.
- `finishStartAndOverride(context, fromToggle)` is the rest of today's body, in today's order: `isEnabled()` recheck (→ `stopServers`), foreign-conflict warning, `applyOverrides`, `updateStatusBar` + `sidebar?.postAll()`, `promptReload`, then `maybeRefreshKiroUsage()`.
- `startAndOverride(context, fromToggle)` = `if (await startServers(context)) await finishStartAndOverride(context, fromToggle);`. The toggle path in `onConfigChanged` is unchanged apart from the parallel bind; the gate is open there.

FR-2.7: an early-bind failure goes through the same catch as today (logged, error message), returns `false`, and the rest of `activate()` still runs; `finishStartAndOverride` is skipped exactly as today's `startAndOverride` returns early.

FR-2.6: with the proxy disabled at activation, no gate, no bind; the only reorder is `initIdentityKey` running after `info("activating")`, and none of the sync inits depend on the key. OWNER/STANDBY yield, `requestGuard`, the config-change chain and `deactivate` are unchanged.

## 3. One-shot usage refresh (`src/extension.ts`)

```ts
let usageRefreshFired = false;
function maybeRefreshKiroUsage(): void {
  if (usageRefreshFired || !cpsServer?.isOwner()) return;
  usageRefreshFired = true;
  info("CPS is OWNER; asking kiro-agent to refresh usage limits once");
  try {
    Promise.resolve(vscode.commands.executeCommand("kiro.usageLimits.getUsageLimits"))
      .then(() => debug("kiro usage refresh done"), (e) => debug("kiro usage refresh failed:", (e as Error)?.message ?? String(e)));
  } catch (e) { debug("kiro usage refresh failed:", (e as Error)?.message ?? String(e)); }
}
```

- Called at the end of `finishStartAndOverride` and in `onOwnershipChanged` (takeover and release callbacks); `isOwner()` filters out releases. The flag makes it once per activation; a host that starts STANDBY fires on its first takeover.
- The CPS usage stub is ungated, so the call is answered immediately even if it races activation.
- If kiro-agent isn't signed in, its handler throws before its try block; the command rejects, no toast, we log at debug.

## Edge cases
- Kiro build drift in the usage handler: usageRetry skipped, info log once, other hooks unaffected, toast returns as today.
- A file patched by a future template version: segment deletion still restores; the 4000-char cap prevents runaway deletes.
- Custom ports: loopback matching ignores the port.
- Non-loopback ECONNREFUSED (e.g. corporate proxy) or HTTP 5xx: no retry, original toast.
- CPS never comes up: each of up to 3 kiro-agent callers waits ≤10 s, then warns without a toast; the profile watcher's following `Yle()` is delayed ≤10 s. Each failing `send` also passes through the SDK's standard retry, so up to ~20 attempts × 3 callers can drain the shared client's retry-token bucket and other CPS calls lose SDK-level retries for a while. Only in this failure case; no code change.
- Activation gate times out (e.g. a keychain prompt blocks `initTokenStore` >10 s): early KRS requests and CPS model-list requests get 503 + `Retry-After: 2`, never dispatched into uninitialized state. Smithy treats 503 as transient and retries; worst case matches today, where those requests hit a closed port.
- Activation throws midway: gate settles `false` (queued requests get 503), servers are stopped, then the error propagates as today.
- STANDBY host with a live peer owner: bind fails busy, `probeIdentity` waits for the key, then STANDBY as today. A signed yield arriving while our key is pending is answered after the key loads, with valid verification and `sig`.
- Proxy toggled during activation: handled by the post-init `isEnabled()` branch (bind late, or stop early servers).

## Testability and verification

New `dev/verify-startup-race.js`, in the style of `dev/verify-selector-patch.js` (same tsc-to-temp build, vscode stub, `A2K_APP_ROOT` pointing at a temp copy). Unit-testable: the transform, the retry function, the gate, `serveIdentity`, plan status/extras. Integration-only (manual reload): real kiro-agent behavior.

- U1–U6 (minimal fixture copying the real handler shape incl. toast tag; AC2 a–e): apply → three insertions + markers, rendered retry has no `*/`; apply twice → identical, no planned write; restore → byte-identical; LIT removed or `u.send(d)`→`u.call(d)` → unchanged, `findUsageHook` null; duplicated REG → unchanged; toast-tag mismatch → unchanged.
- U7 (AC2 f): fixture with backend setter + host config-option function + usage handler → all three hooks; restore byte-for-byte.
- P1–P3 (plan/reporting, via `planKiroAgentBackend` + `syncGroupHeaderStyle` on a temp `A2K_APP_ROOT`):
  - main present + usage newly added → `targets.backend === "unchanged"`, `extras.usageRetry === "applied"`, file written, commit log line is `hooked kiroAgent usage-limits retry`, `afterStyleSync` calls `promptReload` once (stubbed);
  - main drifted + usage applies → file written, `targets.backend === "unavailable"`, `extras.usageRetry === "applied"`, prompt shown;
  - disable → `extras.usageRetry === "removed"`, file byte-identical to factory; read failure → no drift log.
- B1–B3 (AC4): eval the patched fixture with `renderUsageRetry(20, 200)`, stub `send`/logger/toast: ECONNREFUSED ×3 then success → success path, no toast; persistent `connect ECONNREFUSED 127.0.0.1:19811` → no toast, one warn, `data:null`; `ECONNREFUSED 10.0.0.1:443` and HTTP 500 → one toast, one send.
- R1 (AC3): temp copy of the real file → `findUsageHook(restore(real))` matches (report whether step 3a held); patched output passes `node --check` (temp `.js` under `os.tmpdir()`); restore equals factory-normalized content; re-plan → no change. Temp files removed.
- G1–G4: gate holds dispatch until settled true; settle false → 503 and no dispatch; timeout → 503, timer unref'd and cleared on settle; open by default.
- I1–I2: `serveIdentity` with pending key answers only after resolve and includes `sig`; a signed yield during pending gets 200 / `yielding:true`.

Also run `npm run compile`, `npm run bundle`, and `node dev/verify-selector-patch.js` (regression). AC5, AC7, AC8 are checked by reading code. Manual reload checklist in the final report: toast gone and the Kiro usage meter populated after a cold start where the first attempt hit ECONNREFUSED (confirms re-sending the same Command works); cold-start bind timing in the API4Kiro log; two-window OWNER/STANDBY behavior.

## Documentation
- README.md line 146 table row: append `、usage-limits 启动重试钩子（本地端口 ECONNREFUSED 时重试并不弹 toast）`.
- README.md line 154: after "被替换的函数原文以 base64 随身携带，复原时精确回填" add "；插入型钩子用 `/*a2k-…:start*/…/*a2k-…:end*/` 定界、删段复原".
- README.md line 155: after "全有或全无——任一靶点漂移则三处都不写" add "（Ctx 下拉 / 宿主转发 / usage 重试为可选组，漂移只跳过自身）".
- SECURITY.md line 56: after the a2k-orig sentence, add that insertion-only hooks (ctx, row, usage) use `/*a2k-…:start*/…:end*/` delimiters and are restored by deleting the segments.
- docs/ARCHITECTURE.md: line 114 table row adds the usage-limits retry hook; line 81 row adds "usage 重试钩子"; line 130 notes usageRetry is optional and outside all-or-nothing, like ctx; under "触发时机" add one sentence on the early bind and activation gate. Lines 108, 135 and 154 stay unchanged ("三处" refers to the three files).

## Files touched
`src/selectorStyle.ts`, `src/extension.ts`, `src/proxyIdentity.ts`, `src/identityKey.ts`, `src/krsServer.ts`, `src/cpsServer.ts`, new `src/activationGate.ts`, new `dev/verify-startup-race.js`, `README.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`. Nothing is committed.

## Responses to design review (03-design-review.md)
1. MEDIUM gate timeout dispatched: addressed. `holdUntilReady` answers 503 + `Retry-After: 2` on timeout or failure, never dispatches.
2. MEDIUM CPS stubs gated: addressed. Only the CPS model-list branch is gated; all KRS dispatch gated; audit line added.
3. MEDIUM throw mid-activation: addressed. Catch settles gate `false`, awaits `serversUp`, `stopServers()`, rethrows. Gate has a `failed` state so queued requests get 503 instead of dispatch (slightly stronger than the suggested `finally` open).
4. MEDIUM usage-only writes: addressed. `targets.backend` derived from non-usage content; prompt on `extras.usageRetry === "applied"` with its own reason text; `FilePlan.log` override makes the commit log match the actual change; P1–P2 added.
5. MEDIUM bind not before initIdentityKey: addressed. `startServers` is called first; comment explains why it's safe; `startServers` must issue `start()` in its synchronous prefix.
6. NIT deferred serveIdentity: addressed via `answerIdentity()`; I2 covers signed yield during pending.
7. NIT pending timing claim: addressed. Pending is set as the first statement of `initIdentityKey` with a deferred promise.
8. NIT timer cleanup: addressed. `Promise.race` with an unref'd timer cleared on settle; G3 checks it.
9. NIT drift log: addressed. Module flag; read-failure branch returns `usageRetry: "unchanged"`; skipped when the write failed.
10. NIT re-sending Command: addressed. Manual checklist item (usage meter populated) plus matcher step 3a confidence check.
11. NIT SDK retry quota: addressed in Edge cases; no code change.
12. NIT docs: addressed. README 154/155 wording added; ARCHITECTURE 108 explicitly unchanged.
13. NIT "sticky check" wording: addressed. Step 4 now describes the end-anchored regex on `slice(max(0, l-80), l)`.
