# Design review: startup ECONNREFUSED toast (02-design.md)

Verdict: **CHANGES_REQUESTED** (0 HIGH, 5 MEDIUM, 8 NIT)

The usageRetry hook design holds up. Every anchor claim checks out against the installed kiro-agent build, and the splice/restore mechanics are sound. The problems are in the early-bind/activation-gate section and in how the new hook interacts with the backend status, the reload prompt and the commit logging.

## Findings

### 1. MEDIUM: gate timeout dispatches requests into uninitialized modules (violates FR-2.3)
Where: §2 "Activation gate" and "Handlers". `whenActivationReady()` resolves `false` after 10 s, and the caller then runs `dispatch(...)` anyway. If `initTokenStore` is still pending (it reads SecretStorage, which on macOS can block on a keychain prompt), `getToken()` returns `undefined`. `providers.ts` then treats OAuth providers as unconfigured, so CPS `listavailablemodels` returns a list without them and Kiro caches it. KRS generate requests fail the same way. FR-2.3 says early requests "must not crash or return wrong data". The design is right that the wait must be bounded, but dispatching afterwards is not allowed.
Fix: on timeout, answer a retryable error and never dispatch.
```ts
void whenActivationReady().then((ok) => {
  if (res.destroyed || res.writableEnded || req.socket.destroyed) return;
  if (!ok) {
    warnEarlyOnce();
    req.resume();
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "2" });
    res.end(JSON.stringify({ message: "API4Kiro is still initializing" }));
    return;
  }
  this.dispatch(...);
});
```
Update the edge-case text and G2 to match: a timeout produces 503 and no dispatch.

### 2. MEDIUM: gating CPS stub routes is unnecessary and can create a new toast
Where: §2 "Handlers", CPS `dispatch` starting at `isEnabled()`. The CPS profile, `getusagelimits` and passthrough branches (cpsServer.ts) depend only on `isEnabled()`/config, which `initConfig` sets before the bind. Only `listavailablemodels` (`buildModelList` → providers/tokens/catalogs) needs initialized state. With the whole CPS gated, kiro-agent's startup `GetUsageLimits` waits for all of `activate()`. Nobody has checked whether kiro-agent's CPS client (`TW()`, not found/verified) sets a smithy `requestTimeout`. If it does, the call fails with `TimeoutError` instead of ECONNREFUSED. The usage hook does not retry that error, so the user gets "Unable to fetch account usage data: …" again. That defeats the purpose of FR-2.
Fix: gate only the model-list branch in CPS. Move the gate check into the `listavailablemodels` branch, after `req.resume()` and before `buildModelList()`, using the same wait/503 logic as finding 1. Keep the gate for all of KRS `dispatch`. Add a line to the AC6 audit: "CPS profile/usage/passthrough stubs depend only on config (initialized before bind)".

### 3. MEDIUM: if `activate()` throws midway, ports stay bound and serve half-initialized state
Where: §2 "`activate()` order", and the edge case "Activation throws midway: `finally` opens the gate, so queued requests are served". Today a throw before `startAndOverride` means no ports are ever bound. With this design the ports are already bound, the `finally` opens the gate, and the code after `try/finally` (`finishStartAndOverride`, the watcher) never runs. The persisted Kiro endpoints still point at us, so Kiro talks to a server whose token store, prompt store and so on may never have initialized. That violates FR-2.3. `serversUp` is also left unobserved.
Fix:
```ts
try {
  await keyInit;
  /* unchanged init sequence */
} catch (e) {
  if (serversUp) { await serversUp; await stopServers(); }
  throw e;                       // activation fails exactly as today
} finally {
  openActivationGate();          // queued requests see res/socket destroyed or hit a stopped server
}
```
Replace the edge-case bullet with "Activation throws midway: servers are stopped, then the error propagates as today."

### 4. MEDIUM: usage-only writes break FR-1.8, misreport `backend`, and log a false "hooked modelConfigProvider bridge"
Where: §1 "Plan integration" and "Types and reporting". There are three related problems.
- (a) If the main hook drifted but usageRetry applied, the file is written while `backend="unavailable"`, and `afterStyleSync` shows no reload prompt. The design calls this "acceptable", but FR-1.8 requires the reload prompt whenever a write occurs.
- (b) If the main hook is already present and only usageRetry is new, `backend` becomes `applied`. `syncGroupHeaderStyleUnlocked` then makes the overall `status` `applied` (`Object.values(targets).some(s => s === "applied")`). That contradicts the design's own statement that "usageRetry never affects it", and FR-1.7, which says the usage hook doesn't count toward the existing targets.
- (c) `commitPlans` logs `TARGET_LOG.backend.on` ("hooked kiroAgent modelConfigProvider bridge") for any non-`removed` plan. A usage-only write therefore lies in the log, which is exactly the kind of false report the repo's 2026-09-15 comment warns against.

Fix: derive `backend.status` from the main hook alone, report usageRetry only through extras, and make the prompt and the log aware of it.
```ts
const mainBefore = /__kiroModelConfigProvider=t/.test(original);
const mainHooked = /__kiroModelConfigProvider=t/.test(content);
const status: TargetStatus = enabled
  ? (mainHooked ? (mainBefore ? "unchanged" : "applied") : "unavailable")
  : (mainBefore ? "removed" : "unchanged");
// files: written whenever content !== original (independent of status)
```
Note: this keeps today's semantics, where ctx-only changes are also counted as `applied`. If you want ctx-only writes to keep counting as `applied`, use `content` minus usage segments for the comparison: `restoreUsageHook(content) !== restoreUsageHook(original)`. Then:
- In `afterStyleSync`, prompt when `t.backend === "applied" || result.extras.usageRetry === "applied"`. When only the usage hook was written, use the reason text "已写入 kiro-agent 用量重试钩子".
- In `commitPlans`, choose the log message by the actual change, not by `status`. Do this either by passing a `logOn` override on the `FilePlan` (`"hooked kiroAgent usage-limits retry"` when the main hook is unchanged), or by logging `backend` only when `status` is `applied`/`removed`, plus a separate usage log line.
- Add a verify case: main hook present and usage newly added gives `targets.backend === "unchanged"`, `extras.usageRetry === "applied"` and one reload prompt. Main hook drifted and usage applied gives a write plus `extras.usageRetry === "applied"`.

### 5. MEDIUM: bind is not before `initIdentityKey` (FR-2.1 deviation)
Where: §2 "`activate()` order". FR-2.1 says the bind comes after `initConfig` and before `initIdentityKey`. The design calls `initIdentityKey(context)` first. It isn't awaited, but its body (`ensureKey`: `mkdirSync`, `openSync("wx")`/`writeSync`/`readFileSync`) runs synchronously up to the first `await`, so file I/O happens before `listen()`. The reorder is safe: `bindOnce` only issues `listen()` synchronously, and `probeIdentity`/`serveIdentity` run only from later async callbacks, by which time `setIdentityKeyPending` has already been called.
Fix:
```ts
let serversUp: Promise<boolean> | undefined;
if (isEnabled()) { beginActivationGate(); serversUp = startServers(context); } // listen() issued first
const keyInit = initIdentityKey(context);   // sets pending synchronously; probes/identity answers await it
```
Add a one-line comment explaining why this order is safe (no identity code runs before the first event-loop turn).

### 6. NIT: deferred `serveIdentity` must compute the whole response after the key resolves
Where: §2 "Lazy identity key". "Responds inside `keyReady.then(...)`" doesn't say what is computed there. If `verifyYield`/`identitySignature` run before the key is set, a legitimate yield gets 403 ("本实例没有共享密钥") and `sig` is omitted.
Fix: move the existing body after the path check into `function answerIdentity(params, res, role, headers): void`. `serveIdentity` then calls it synchronously when `!keyPending`, or as `keyReady.then(() => { if (!res.destroyed && !res.writableEnded) answerIdentity(...) })`. G3 must also cover a signed yield answered during pending, which must get 200/`yielding:true`.

### 7. NIT: wrong claim about when pending is set
Where: §2, "Pending is set synchronously, before the first await". `(async () => {...})()` runs `ensureKey`'s synchronous part (in the common case, all of it) before `setIdentityKeyPending(run)` is reached. Nothing breaks: no identity request can arrive in between. Fix the sentence to say "set synchronously before `initIdentityKey` returns", or set pending at the top of `initIdentityKey` with a deferred promise.

### 8. NIT: `whenActivationReady` timer cleanup is unspecified
Each early request adds its own 10 s timer. Specify `Promise.race([opened.then(() => true), new Promise(r => { const t = setTimeout(() => r(false), timeoutMs); t.unref?.(); opened.then(() => clearTimeout(t)); })])`, so timers don't outlive the gate or keep the host alive in tests.

### 9. NIT: the drift log is not "once" (FR-1.5) and fires in non-Kiro hosts
Where: §1 "Types and reporting". The info line is emitted on every `syncGroupHeaderStyle(true)`. When the file read fails (plain VS Code, ENOENT), `extras` is missing and `extraOf` returns `unavailable`, so it logs there too.
Fix: use a module-level `let usageDriftLogged = false`, and log only when `enabled && extras.usageRetry === "unavailable" && !committed.backend.detail && backend.files !== undefined && readOk`. For example, return `extras: { usageRetry: "unchanged" }` from the read-failure branch, or track a `readOk` flag.

### 10. NIT: re-sending the same `GetUsageLimitsCommand` instance is unverified at runtime
`u.send(d)` is retried with the same `d`. The smithy `resolveMiddlewareWithContext` re-`use`s the plugin middleware into the command's own stack on every send. The serializer, deserializer and endpoint middleware are `override:!0`, so duplicates are replaced rather than thrown, but no runtime check covers it. The B1–B3 stubs can't catch a problem here.
Fix: add to the final report's manual list "toast gone **and** usage meter populated after a cold start where the first attempt hit ECONNREFUSED". Optionally, R1 can assert that the thunk shape is `()=>u.send(d)` with `d` declared via `new …GetUsageLimitsCommand(`, which confirms it is a smithy Command.

### 11. NIT: SDK retry-quota side effect
Each failing `send` already goes through the SDK's standard retry. Up to 20 attempts × 3 callers can drain the shared client's retry token bucket, so other CPS calls lose SDK-level retries for a while. This only happens in the failure case where CPS never comes up. Mention it in the edge cases. No code change is needed.

### 12. NIT: docs list is incomplete versus FR-4.1
- README.md line 154 says "被替换的函数原文以 base64 随身携带". The usage hook (like ctx) uses delimited segments, so add "插入型钩子用 `/*a2k-…:start*/…:end*/` 定界、删段复原".
- README.md line 155 says "全有或全无——任一靶点漂移则三处都不写". Add "（Ctx 下拉 / 宿主转发 / usage 重试为可选组，漂移只跳过自身）".
- ARCHITECTURE line 108: the design should say explicitly that it stays unchanged.

### 13. NIT: "sticky check" wording in matching step 4
`content.slice(l - 80, l)` with a `$`-anchored regex is an end-anchor check, not a sticky (`y`) check. Write it as `new RegExp(\`catch\\((${IDENT_SRC})\\)\\{let (${IDENT_SRC})=$\`).exec(content.slice(Math.max(0, l - 80), l))`.

## Verified Assumptions
All checks were done on the installed `/Applications/Kiro.app/.../kiro.kiro-agent/dist/extension.js` (read-only) and the repo source.
- `"kiro.usageLimits.getUsageLimits",async` occurs exactly once (offset 13175295). `` `Unable to fetch account usage data `` occurs once, 588 chars later.
- Exactly one `xW("GetUsageLimits",l,()=>u.send(d))` sits between them. There are two file-wide (the other uses `u`). The design's regex 3 matches it once.
- `catch(f){let h=` ends exactly at the literal (`errVar=f`, `msgVar=h`). The tail `?X.warn(h):(X.error(h),WEf(h))}` matches once, 327 chars after the literal.
- `c(WEf,"showErrorToastRateLimited");` occurs once, and `WEf` rate-limits `showErrorMessage`.
- `xW` (`withCpsTelemetry`) rethrows the same error object. So a property set inside the thunk (`__a2kLocalRefused`) is visible to the handler's `catch(f)`, and retrying inside the thunk keeps one telemetry count.
- `HEf` (FEATURE_NOT_SUPPORTED) and `VEf` (throttling) are tested before the toast branch. The result `p` is built before the branch, so insertion B doesn't change its shape. Ternary association is as the design describes.
- No `a2k-usage` exists yet. The file already contains `__kiroModelConfigProvider` and `a2k-ctx` segments.
- The startup caller `Po("UsageMonitoring",()=>{e$a(t,…)})` doesn't await `e$a`, and `Po` runs `e()` synchronously, so a slow handler can't block kiro-agent activation. Login (`Bih`) and profile watcher (`invokeInitializerAPIs`, which awaits it before `Yle()`) are event-driven, as claimed.
- `planKiroAgentBackend`, `restoreBackendHook`/`applyBackendHook`, `restoreCtxHostHook`/`applyCtxHostHook`, `ctxStatus`, `extraOf`, `CtxTargetKey`/`CtxExtras`, `TargetPlan.extras`, `__selectorStyleInternals.matchers`, `IDENT_SRC`, `escapeRe` and `CTX_SEGMENT_RE`/`MAX` exist with the shapes the design assumes. `commitPlans` → `writeAtomic` has rollback under `enabled`.
- `bindOnce` doesn't touch the identity key. Only `tryAcquire` → `probeIdentity` (both probes) and `serveIdentity`/`verifyYield` use it. `initIdentityKey` never rejects.
- `initConfig` alone backs `isEnabled`/`getPort`/`getCpsPort`/`getExtensionVersion`. `updateStatusBar` and `sidebar?.` are undefined-safe before creation.
- `startAndOverride` today runs bind (KRS then CPS sequentially), `isEnabled` recheck, foreign warning, `applyOverrides`, `updateStatusBar`/`postAll`, `promptReload`. The proposed split preserves that order.
- No test framework exists. `dev/verify-selector-patch.js` builds with tsc into a temp directory with a vscode stub and `A2K_APP_ROOT`.

## Unverified / Wrong Assumptions
- **Wrong:** "The overall `status` computation is unchanged. usageRetry never affects it." A usage-only write flips `backend` to `applied`, which flips the overall status (finding 4).
- **Wrong:** "no reload prompt is shown, which is acceptable". This conflicts with FR-1.8 (finding 4).
- **Wrong:** "Activation throws midway → queued requests are served" is presented as safe. It serves half-initialized state on bound ports (finding 3).
- **Wrong (minor):** "Pending is set synchronously, before the first await". `ensureKey`'s synchronous I/O runs first (finding 7).
- **Unverified:** whether kiro-agent's CPS client (`TW()`) sets a `requestTimeout` shorter than the activation-gate wait (finding 2). I couldn't locate `TW`'s definition in the minified bundle.
- **Unverified:** that re-sending the same smithy Command instance is safe at runtime (finding 10). The middleware `override:!0` flags suggest it is.
- **Unverified:** the actual shape of the ECONNREFUSED error after SDK wrapping (`code`/`address` vs message only). The design hedges by matching both, which is fine, and the toast text confirms that the message contains `ECONNREFUSED 127.0.0.1:19811`.
