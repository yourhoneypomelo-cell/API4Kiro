# Implementation report: stop the startup "Unable to fetch account usage data: connect ECONNREFUSED 127.0.0.1:19811" toast

Nothing is committed or pushed. The installed Kiro.app files were never modified; every check ran against temp copies (`A2K_APP_ROOT`), which were removed afterwards.

**The user must reload or restart Kiro once.** The kiro-agent patch is written to disk on the next activation but only loaded by the next kiro-agent start.

## Files changed

| File | Change |
| --- | --- |
| `src/selectorStyle.ts` | New optional `usageRetry` hook inside `planKiroAgentBackend`; types, reporting and commit log updated. |
| `src/extension.ts` | Early parallel bind (`startServers`), activation gate wiring, `finishStartAndOverride`, one-shot usage refresh, extra reload prompt. |
| `src/activationGate.ts` (new) | Activation gate: open / pending / failed, `whenActivationReady`, `holdUntilReady`. |
| `src/proxyIdentity.ts` | Lazy identity key: `setIdentityKeyPending`, `serveIdentity` defers via `answerIdentity`, `probeIdentity` awaits the key. |
| `src/identityKey.ts` | `initIdentityKey` marks the key pending as its first statement and resolves it in `finally`. |
| `src/krsServer.ts` | After guard, CORS, OPTIONS and identity, everything moves into `dispatch()`, called via `holdUntilReady`. |
| `src/cpsServer.ts` | Only the model-list branch is wrapped in `holdUntilReady`. |
| `dev/verify-startup-race.js` (new) | 61 checks (U/B/P/R/G/I/L). The design explicitly requires this script. |
| `README.md`, `SECURITY.md`, `docs/ARCHITECTURE.md` | Docs per the design's Documentation section. |

`src/selectorStyle.ts` and `dev/verify-selector-patch.js` already had uncommitted popover-fix changes (`POPOVER_PATCH_CANON` and related) before I started. I left those alone, so the diff of those two files mixes that work with mine.

## What each change does

### 1. usageRetry hook (`selectorStyle.ts`)
- **Insertion A:** wraps the `xW("GetUsageLimits",l,()=>u.send(d))` thunk body in a retry function. It retries only on loopback ECONNREFUSED (any 127.x, `localhost` or `::1` host, any port), every 500 ms, with a 10 s budget. When the budget runs out it tags the error with a non-enumerable `__a2kLocalRefused`.
- **Insertion B:** in the `catch`, a tagged error gets `X.warn(h)` instead of `X.error(h),WEf(h)`, so no toast. All other errors take the original path. If the tag can't be set (a frozen error), the toast shows as before.
- **Conventions:** `/*a2k-usage:start*/…/*a2k-usage:end*/` delimited pure insertions. Restore deletes the segments, with a 4000-char cap per segment. This is the same approach as the ctx and row hooks.
- **Matching (`findUsageHook`):** the design's 6 steps plus the 3a check. Every minified name is captured structurally, and any miss or duplicate means no change.
- **Status:** the hook reports only through `extras.usageRetry` and never changes `targets.backend`. It is independent of the main hook, and drift only skips itself.
- **Commit and logging:** `FilePlan.log` makes the commit log match the real change. The drift info log is written once per host. A non-Kiro host (file unreadable) returns `usageRetry: "unchanged"` with no log.
- **Reload prompt:** `afterStyleSync` prompts for a reload when `extras.usageRetry === "applied"` and the core targets did not. Prompts are already deduplicated per host.
- **Exports:** `findUsageHook`, `applyUsageHook`, `restoreUsageHook`, `renderUsageRetry`, `USAGE_START`, `USAGE_END` and `USAGE_SEGMENT_RE` are exported via `__selectorStyleInternals.matchers`.

### 2. Early bind
- **Order in `activate()`:** `initLog`, `initConfig`, the "activating" log, then `beginActivationGate()` and `startServers()` when enabled. `startServers` builds both servers and calls `start()` in its synchronous prefix, so `listen()` is issued before `initIdentityKey` runs. CPS is constructed first, and both start in parallel.
- **Lazy identity key:** `initIdentityKey` sets the key pending synchronously.
  - `bindOnce` never waits for the key. `probeIdentity` (the busy-port probe and yield path) awaits it.
  - `serveIdentity` keeps its synchronous boolean return and defers the actual answer (including `verifyYield` and `sig`) until the key is loaded.
- **Activation gate:** a request that arrives early is held until the rest of `activate()` finishes. If activation fails or 10 s pass, it gets 503 with `Retry-After: 2` and is never dispatched. All KRS dispatch is gated. For CPS only the model-list branch is gated; profile, usage and passthrough stubs are answered immediately, so kiro-agent's early `GetUsageLimits` gets a reply as soon as the port is bound.
- **Failure and toggle paths:**
  - If activation throws, the gate settles false, the servers are stopped, and the error is rethrown.
  - If `enabled` flips during activation, the post-init branch either binds late or stops the early servers.
  - With the proxy disabled, nothing is bound and no gate is started.
  - `startAndOverride` is now `startServers` plus `finishStartAndOverride`, so the toggle path behaves as before.

### 3. One-shot usage refresh
`maybeRefreshKiroUsage()` runs at the end of `finishStartAndOverride` and in `onOwnershipChanged`. It does nothing unless CPS is OWNER, and it sets `usageRefreshFired` first, so it fires at most once per activation. It then fires `vscode.commands.executeCommand("kiro.usageLimits.getUsageLimits")` without awaiting it. A rejection or a synchronous throw is caught and logged at debug level.

## AC6 audit: what a request can touch before init finishes
- **CPS profile, getusagelimits, passthrough:** depend only on `isEnabled()` and constants. `initConfig` runs before the bind, so these are safe early and are not gated.
- **CPS listavailablemodels:** depends on providers, tokenStore, catalogs and modelStore, so it is gated.
- **KRS, all routes:** depend on tokens, usageStore, promptStore, endpoints, imagePolicy and clientIdentity, so everything after identity is gated.
- **Identity endpoint:** waits only for the key.
- **`requestGuard` and the guard-first order:** unchanged.

## Verification

| Command | Result |
| --- | --- |
| `npm run compile` (`tsc --noEmit`) | exit 0 |
| `npm run bundle` | build complete |
| `node dev/verify-selector-patch.js` (regression) | 176 passed, 0 failed |
| `node dev/verify-startup-race.js` (new) | 61 passed, 0 failed |

There is no `npm test` script and no test framework in the repo, so the `dev/` node scripts are the verification suite.

One script fix: the activation gate's timer is unref'd by design, so during G3 nothing kept the event loop alive and Node exited silently with 0 mid-run. I added a keepalive timer to `verify-startup-race.js`.

## Acceptance criteria

1. **Compile and bundle.** Met. Both succeed (above).
2. **Transform checks.** Met by `verify-startup-race.js`.
   - (a) U1 applies the patch and checks the markers.
   - (b) U2 is idempotent; P2 shows no second write.
   - (c) U3 and P4 restore byte-for-byte.
   - (d) U4 covers a missing or changed anchor; P6 covers the drift log, once per host.
   - (e) U5 covers a duplicated anchor, and U6 a toast-tag mismatch.
   - (f) U7 stacks the main hook, ctx host hook and usage hook, and restores to factory.
3. **Real file copy.** Met by R1, run on a temp copy of the installed `kiro-agent/dist/extension.js`.
   - The anchor matches exactly once, and step 3a held (`d=new uga.GetUsageLimitsCommand(`), so I kept it.
   - The patched output passes `node --check`, restores to factory-normalized content, and re-planning gives no change.
   - `sync(false)` returns to factory.
4. **Retry behavior.** Met. B1 to B3 run the patched fixture with `renderUsageRetry(20, 200)` and stubbed send, logger and toast.
   - ECONNREFUSED ×3 then success: success path, no toast.
   - Persistent ECONNREFUSED: one warn, no toast, `data:null`.
   - `ECONNREFUSED 10.0.0.1:443` and HTTP 500: one send, one toast.
   - Also covered: ECONNRESET is not retried (B3), unpatched behavior as a control (B0), and a frozen error falls back to the toast (B4).
5. **Bind order.** Met by code reading plus L1. In `activate()`, `startServers` is called before `initIdentityKey`, `initTokenStore` and the sidebar. `bindOnce` has no key dependency, and `probeIdentity` does `await keyReady`. L1 shows `PortHolder.start()` becomes OWNER while the key is still pending.
6. **Early requests.** Met. G1 to G4 cover holding, 503 on failure or timeout, timer cleanup, and the default-open gate. I1 to I4 cover identity answers waiting for the key, including a signed yield during the pending window. The audit is above.
7. **Disabled proxy.** Met by code reading only, no test. `startServers` and `beginActivationGate` are called only inside `if (isEnabled())`. The disabled branch only stops servers that were started because `enabled` flipped mid-activation.
8. **One refresh.** Met by code reading only, no unit test. The flag is set before the call, the call is fire-and-forget, and rejection and sync throw are both caught. The flag resets at the top of `activate()`, so it is once per activation.
9. **Docs.** Met.
   - README: the table row, the "插入型钩子用 `/*a2k-…:start*/…/*a2k-…:end*/` 定界" sentence, and the optional-group note.
   - SECURITY: the delimiters sentence.
   - ARCHITECTURE: the module row, the extension.js row, the optional-group note, and a sentence on early bind and the gate under "触发时机".
10. **This report.** Met; the unverified items are below.

## Not verified (needs a live Kiro)
- **The toast disappearing** after a cold start where kiro-agent's first attempt hits ECONNREFUSED. The user must reload or restart Kiro once, because kiro-agent loads the patched file only on its next start.
- **Re-sending the same smithy `GetUsageLimitsCommand` instance on retry.** I believe the SDK middleware replaces rather than duplicates on re-send, but this is only provable live. The check is that Kiro's usage meter populates after a cold start that needed a retry.
- **Real cold-start bind latency.** Compare the gap between "activating" and "CPS OWNER" in the API4Kiro output log.
- **OWNER/STANDBY across two windows**, including a signed yield during the key-pending window. Unit-covered (I2, L1), but not exercised with two real windows.
- **`maybeRefreshKiroUsage`** is not covered by any script. Confirm the "CPS is OWNER; asking kiro-agent to refresh usage limits once" info line shows once per window.
- **Gate timeout in practice**, for example a long keychain prompt in `initTokenStore`. The 503 path is unit-tested only.

## Notes
- Code comments label the hook "4.13.65", but `package.json` is still 4.13.64. I did not bump the version.
- **SDK retry bucket:** if CPS never comes up, each of up to 3 kiro-agent callers waits at most 10 s, then warns without a toast. Their SDK-level retries can also drain the shared client's retry budget for a while. This is only in the failure case, and there is no code change.
- **No endpoint clearing:** I did not remove or clear `codewhisperer.config.*Endpoints`, since kiro-agent caches them at load.
