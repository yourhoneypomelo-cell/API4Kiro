# Task: eliminate "Unable to fetch account usage data: connect ECONNREFUSED 127.0.0.1:19811" on Kiro startup

Repo: /Users/macbkkopro/Documents/API4Kiro (branch `main`, work directly in it; no worktree). Do NOT commit; leave changes uncommitted for the user to review.

Root-cause analysis (already confirmed, read it first): /Users/macbkkopro/Documents/API4Kiro/.agents/tasks/cps-econnrefused-startup/findings.md

Summary: `kiro.kiroAgent` is in our `extensionDependencies`, so kiro-agent activates before our `activate()`. During its activation it calls `kiro.usageLimits.getUsageLimits` against the persisted `codewhisperer.config.cpsEndpoints` (http://127.0.0.1:19811) before our CPS server binds. It gets ECONNREFUSED, has no retry, and shows a rate-limited error toast (`showErrorToastRateLimited`, function `WEf`, 5 min window `aga=300*1e3`; message built in command handler in function `dga`: `` `Unable to fetch account usage data: ${f.message}` ``). Our CPS returns `{}` for usage anyway (`src/cpsServer.ts` getusagelimits branch), so this is cosmetic.

Implement all three changes:

## 1. Patch kiro-agent's getUsageLimits to retry on local ECONNREFUSED (primary fix)
- Extend the existing kiro-agent backend patch in `src/selectorStyle.ts` (`planKiroAgentBackend`, which already patches `/Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent/dist/extension.js` — the path is resolved by existing code, reuse it).
- Behavior: inside the `getUsageLimits` command handler, when the fetch fails with an error whose message matches `/ECONNREFUSED 127\.0\.0\.1:198\d\d/` (our local ports; be generous enough to cover configured custom ports, e.g. any 127.0.0.1 / localhost port ECONNREFUSED), retry the fetch a bounded number of times (e.g. every 500 ms, up to ~10 s total) before falling back to the original error path. If still failing after retries, it is acceptable to log via the existing logger but skip the toast for this specific local-ECONNREFUSED case.
- Follow the SAME conventions as the existing patches in that file exactly: start/end markers, `a2k-orig:<base64 original>` embedding of the replaced original text, anchor-based matching with drift detection (if the anchor isn't found exactly, skip this hook and log, never corrupt the file), plan-then-commit via `commitPlans` with rollback, atomic write via `writeAtomic`, and reversal when proxy is disabled / `api2kiroDual.groupHeaderStyle` is off (whatever restore path existing kiro-agent backend hooks use). Idempotent across repeated activations.
- Inspect the actual minified kiro-agent dist/extension.js on this machine to pick a stable anchor (read-only; never edit it by hand). Note the real file may already contain our existing patches.
- Only takes effect after one reload; that's expected.

## 2. Bind CPS/KRS ports as early as possible in `activate()` (src/extension.ts)
- Currently before `startAndOverride()` (which awaits `krsServer.start()` then `cpsServer.start()`; `PortHolder.start` → `bindOnce` in `src/portBinder.ts`) we run: `await initIdentityKey(context)`, sync inits (endpoints, imagePolicy, clientIdentity, modelCatalog/codexCatalog kick-offs, usageStore, promptStore), `await initTokenStore(context)`, status bar, SidebarProvider/webview registration, registerCommands, registerSessionConfigHook, checkForUpdate. One cold start measured 8.3 s from `activating` to `CPS OWNER`.
- Move port acquisition to the earliest safe point. Bind CPS before KRS or in parallel. The fast `bindOnce` path should not depend on the identity key; only the busy-port probe/yield path (`probeIdentity`, HMAC in `identityKey.ts`/`proxyIdentity.ts`) needs it — make it await the key lazily there.
- Be careful: request handlers that run once bound must not crash if later-initialized modules (token store, usageStore, catalogs, etc.) aren't ready yet. Either gate handlers on an "initialized" promise (await it inside the request handler) or verify each dependency is safe. Preserve the multi-window OWNER/STANDBY yield semantics and security guards (`requestGuard.ts`) unchanged.
- Respect `api2kiroDual.enabled`: if proxy is disabled, behavior must stay as today (don't bind if we currently don't).

## 3. Refresh kiro-agent usage after CPS first becomes OWNER
- After CPS first becomes OWNER in this host, fire-and-forget `vscode.commands.executeCommand("kiro.usageLimits.getUsageLimits")` once, wrapped in catch (command may not exist). Only once per activation.

## Verification
- `npm run compile` / build and typecheck (check package.json for exact scripts) and existing tests (`npm test` or equivalent) must pass.
- Add unit tests for the new kiro-agent patch transform if the repo has tests for other selectorStyle patches: apply to a fixture containing the anchor → patched with markers; apply twice → idempotent; restore → byte-identical to original; anchor missing → no change.
- Run the patch planner against a COPY of the real `/Applications/Kiro.app/.../kiro.kiro-agent/dist/extension.js` (copy to a temp dir, never modify the real one) and confirm the anchor matches and the result parses (`node --check`). Clean up temp files.
- Update docs where patches are enumerated (README.md / SECURITY.md / docs/ARCHITECTURE.md mention "三处补丁") to reflect the new hook concisely.
- Report what was verified and what could only be verified by a Kiro reload (the user will reload manually).
