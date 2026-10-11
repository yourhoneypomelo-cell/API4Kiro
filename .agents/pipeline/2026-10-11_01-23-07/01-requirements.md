# Requirements: stop the "Unable to fetch account usage data: connect ECONNREFUSED 127.0.0.1:19811" toast on Kiro startup

Sources: `.agents/tasks/cps-econnrefused-startup/task.md` and `findings.md`. User instruction: "按你建议修改", meaning implement all three recommendations. Do not commit.

## Summary

`kiro.kiroAgent` is listed in our `extensionDependencies`, so it activates before our `activate()`. During that activation it calls `kiro.usageLimits.getUsageLimits` against the persisted CPS endpoint (`http://127.0.0.1:19811`) before our CPS server has bound the port. The call gets ECONNREFUSED and has no retry, so kiro-agent shows its rate-limited error toast. Nothing is lost functionally, because our CPS returns `{}` for usage anyway. Three changes deal with this:

1. A new kiro-agent patch that retries the call and suppresses the toast. This is the primary fix.
2. Binding the CPS/KRS ports earlier in `activate()`. This shrinks the race window.
3. A one-shot usage refresh after CPS first becomes OWNER. This prevents stale UI state.

## Functional Requirements

### FR-1 Usage-limits retry hook in kiro-agent `dist/extension.js` (primary)
- FR-1.1 Extend `planKiroAgentBackend` in `src/selectorStyle.ts` to add a new hook to the same file it already patches (`kiroAgentBackendFile()`). Do not add a new target.
- FR-1.2 Behavior inside the `kiro.usageLimits.getUsageLimits` handler: if the usage fetch (the `u.send(d)` call wrapped by `xW("GetUsageLimits",…)` in the current build) throws and the error message matches a local-loopback ECONNREFUSED (`ECONNREFUSED` plus `127.0.0.1:<any port>` or `localhost:<any port>`, IPv6 `::1` included), the hook retries the same fetch:
  - Retry every 500 ms, with a total retry budget of about 10 s (about 20 attempts, or stop at the 10 s deadline, whichever comes first).
  - If a retry succeeds, continue down the original success path unchanged (`GEf` mapping, `y7.clear()`, `_X.fire`, and so on).
- FR-1.3 If every retry fails with local ECONNREFUSED, kiro-agent must not call the toast function (`WEf` / `showErrorToastRateLimited`) for that error. It may log through kiro-agent's existing logger (warn level is preferred). The returned `{data:null,error:{…}}` result keeps its original shape.
- FR-1.4 Errors that are not local ECONNREFUSED follow the original path byte-for-byte in behavior: no retry, same logging, same toast, same caching.
- FR-1.5 The patch follows the existing conventions in `selectorStyle.ts`:
  - Matching is structural and anchor-based, with minified names captured by regex. No hardcoded minified identifiers.
  - The anchor must match exactly once. On zero or multiple matches, skip this hook only, log the drift once at info or warn, and write no partial change.
  - The replaced span carries an `a2k-orig:<base64 original>` marker and/or delimited start/end markers, consistent with the other kiro-agent hooks.
  - Restore runs first, then apply. That makes the transform idempotent: re-applying to an already-patched file yields byte-identical output, and no write is planned.
  - The final write goes through the existing `commitPlans` → `writeAtomic` path, with its rollback semantics.
- FR-1.6 Restore uses the same path as the existing kiro-agent backend hooks. The hook is removed when the proxy is disabled or `api2kiroDual.groupHeaderStyle` is off, which is when `syncGroupHeaderStyle(false)` runs. Restoring must reproduce the original text byte-for-byte.
- FR-1.7 Drift in this hook must not change the status or outcome of the existing modelConfigProvider hook or the ctxHost hook, and vice versa. The usage hook does not count toward the all-or-nothing gating of the existing targets. Its status is reported separately (e.g. through `extras`), in the same style as `ctxHost`.
- FR-1.8 The patch takes effect only after the next Kiro reload. The existing "reload once" prompt behavior applies if a write occurs.

### FR-2 Early port binding in `activate()` (`src/extension.ts`)
- FR-2.1 When `isEnabled()` is true, start the CPS and KRS servers at the earliest safe point in `activate()`. That point comes after `initConfig` and before `initIdentityKey`, `initTokenStore`, the catalog kick-offs, status bar and sidebar registration, `registerCommands`, `registerSessionConfigHook` and `checkForUpdate`. CPS binds first, or CPS and KRS bind in parallel, never KRS strictly before CPS.
- FR-2.2 The fast `bindOnce` path in `src/portBinder.ts` must not wait for the identity key. Only the busy-port probe/yield path (`probeIdentity`, the HMAC in `identityKey.ts` / `proxyIdentity.ts`) waits for the key, and it does so lazily at that point.
- FR-2.3 Requests that arrive after the bind but before the remaining initialization has finished must not crash or return wrong data because of uninitialized modules (token store, usageStore, promptStore, endpoints, catalogs, clientIdentity, imagePolicy, and so on). Either the handlers await a single "initialized" promise, or each dependency is proven safe to use early.
- FR-2.4 The endpoint override, style sync and every other step that `startAndOverride` performs after the servers start keep their current order relative to each other. They must still run only after the servers are up.
- FR-2.5 Keep these unchanged:
  - Multi-window OWNER/STANDBY yield semantics.
  - The `requestGuard.ts` security checks.
  - The config-change serialization chain.
  - The behavior of `startAndOverride(context, true)` when called from a toggle.
- FR-2.6 When the proxy is disabled (`api2kiroDual.enabled=false`), activation behaves as it does today and no ports are bound.
- FR-2.7 A failure during early binding must have the same result as a failure in today's `startAndOverride` (logged and surfaced as it is now), and must not stop the rest of `activate()` from running.

### FR-3 One-shot usage refresh after the first OWNER transition
- FR-3.1 The first time CPS becomes OWNER in this extension host, call `vscode.commands.executeCommand("kiro.usageLimits.getUsageLimits")` once, fire-and-forget. Rejections are caught and logged at debug or info level. The command may not exist.
- FR-3.2 This happens at most once per activation. Later ownership changes (STANDBY→OWNER after a peer exits) don't fire it again. A STANDBY host that later becomes OWNER does fire it, because that is its first OWNER transition.

### FR-4 Documentation
- FR-4.1 Update the places that list the patches (README.md around line 155, SECURITY.md line 56, and docs/ARCHITECTURE.md lines 81, 108, 130, 135 and 154) to mention the new usage-limits retry hook in kiro-agent `dist/extension.js` briefly. Wording such as "三处补丁" stays correct where it refers to the three target files, but the description of the hooks in the extension.js file must include the new one.

## Non-Functional Requirements
- NFR-1 The patched kiro-agent file must still parse (`node --check`).
- NFR-2 Never edit the real `/Applications/Kiro.app/...` file by hand during development or verification. Use copies in a temp directory and clean them up afterward.
- NFR-3 Startup cost: the retry adds no delay to the success path, and the early bind adds no new awaited work before the bind.
- NFR-4 Security: the retry only targets loopback addresses, and the change does not loosen any guard or identity check.

## Acceptance Criteria
1. `npm run compile` (`tsc --noEmit`) and `npm run bundle` succeed.
2. A repeatable unit check covers the new transform. It goes in the repo's existing verification-script style (e.g. a new or extended script under `dev/`, alongside `dev/verify-selector-patch.js`, runnable with `node`) and checks that:
   - (a) a fixture containing the real handler shape gets patched, and the patch contains the markers;
   - (b) applying twice gives byte-identical output and no second write is planned;
   - (c) restoring gives output byte-identical to the original fixture;
   - (d) a fixture with the anchor missing or changed is unchanged and the drift is reported;
   - (e) a fixture with the anchor duplicated is unchanged;
   - (f) the existing modelConfigProvider and ctxHost hooks still apply and restore correctly with the new hook present.
3. On a temp copy of the real `/Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent/dist/extension.js` (which may already contain our patches), the planner matches the anchor exactly once. The output passes `node --check`, round-trips through restore back to the factory-normalized content, and re-planning yields no change.
4. Behavioral check of the injected handler logic: run it in Node with stubbed `send`, logger and toast. It must show that:
   - (a) local ECONNREFUSED followed by success within 10 s takes the success path with no toast;
   - (b) local ECONNREFUSED that persists for 10 s ends in the error result with no toast call and a log entry;
   - (c) a non-local error (e.g. `ECONNREFUSED 10.0.0.1:443`, or an HTTP 500) calls the toast exactly as the original code does, with no retry.
5. With `enabled=true`, reading the code shows the CPS bind (or a parallel CPS+KRS bind) runs before `initIdentityKey` and `initTokenStore` are awaited. `bindOnce` does not await the identity key, and `probeIdentity` awaits it lazily.
6. A request that hits CPS or KRS before initialization finishes is either delayed until init completes or served correctly, without throwing. This is shown either by a stub-based test or by an explicit audit, listed in the implementation notes, of each handler dependency.
7. With `enabled=false`, no port is bound during activation (shown by reading the code or by a test).
8. `kiro.usageLimits.getUsageLimits` is executed exactly once per activation, on the first OWNER transition, and a rejected promise is caught.
9. The docs from FR-4.1 are updated.
10. The final report lists what was verified locally and what needs a manual Kiro reload: the toast actually disappearing, a real cold-start timing improvement, and the OWNER/STANDBY behavior across two windows.

## Assumptions
- A1 The repo has no `npm test` script and no test framework. Existing verification uses node scripts under `dev/` (e.g. `dev/verify-selector-patch.js`), so the new checks follow that pattern rather than adding a test framework.
- A2 The usage hook is tied to the same enable condition as the existing backend hooks (proxy enabled and `groupHeaderStyle` on, through `syncGroupHeaderStyle`). Users with `groupHeaderStyle` off will still see the toast, which is acceptable per task.md. It is independent of the modelConfigProvider hook being present, because it doesn't depend on channel A.
- A3 "Local ECONNREFUSED" covers any loopback host and port, so custom ports configured with `getPort`/`getCpsPort` are included. The retry doesn't check which port is ours.
- A4 Retry timing defaults to 500 ms × up to 20 attempts, within a 10 s total budget. The exact numbers are left to design.
- A5 The current minified anchor is the `catch(f){let h=\`Unable to fetch account usage data…` block in function `dga` (verified to be present in the installed build). Design picks the final stable anchor.

## Out of Scope
- Changing the CPS `getusagelimits` stub response or implementing real usage data.
- Clearing or rewriting `codewhisperer.config.*Endpoints` on deactivate. This was rejected in the findings.
- A persistent helper process holding the ports.
- Removing `kiro.kiroAgent` from `extensionDependencies`, or changing the extension activation events.
- Reloading Kiro automatically, and committing the changes.
