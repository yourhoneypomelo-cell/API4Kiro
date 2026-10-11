# CPS ECONNREFUSED 127.0.0.1:19811 on startup: findings

## Summary

The primary hypothesis holds: this is a startup race, and it is structural. `kiro.kiroAgent` is in our `extensionDependencies`, so the host fully activates kiro-agent before it calls our `activate()`. Inside its own activation, kiro-agent runs `kiro.usageLimits.getUsageLimits` against the `cpsEndpoints` that the previous session left in settings.json (`http://127.0.0.1:19811`). At that moment nothing is listening. The old extension host has just exited, and our CPS server has not bound yet. The SDK gets ECONNREFUSED, and kiro-agent shows an error toast (rate-limited to once per 5 minutes per message). It does not retry.

The error is harmless. Our CPS server only ever returns an empty `{}` stub for usage (`src/cpsServer.ts`, the `getusagelimits` branch), and everything else works once CPS binds a few ms to a few seconds later. Rebinding sooner shrinks the window but cannot close it, because kiro-agent always runs first.

## Evidence

### 1. Our activation order (`src/extension.ts` `activate()`)
Before `startAndOverride()` binds KRS and then CPS (`PortHolder.start` → `bindOnce`, `src/portBinder.ts`), these steps run:
- `await initIdentityKey(context)`: reads or creates a key file in globalStorage.
- Synchronous inits: endpoints, imagePolicy, clientIdentity, the modelCatalog and codexCatalog kick-offs, usageStore, promptStore.
- `await initTokenStore(context)`: reads the macOS keychain.
- Status bar, `SidebarProvider` and webview registration, `registerCommands`, `registerSessionConfigHook`, and `void checkForUpdate`.
- Only then `await startAndOverride()`, which runs `await krsServer.start()` before `await cpsServer.start()`.

Measured in the API4Kiro output logs (UTC):
- `output_logging_20261011T010516`: `activating` at 08:05:17.926, `CPS OWNER` at 08:05:26.268. That is **8.3 s** before CPS was listening. Provider `/models` fetch errors were logged in between, so the event loop and host were busy and awaited work ran slowly.
- `output_logging_20261011T010531` and `T011440`: `activating` → `CPS OWNER` in about 5–7 ms. That is the fast path.
- `output_logging_20261011T010630`: activated at 08:06:31 as STANDBY. It became OWNER only at 08:14:34, when the previous owner window exited. Between those two times, any other window's kiro-agent calling CPS would hit whatever the current owner was.

### 2. kiro-agent behaviour (`/Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent/dist/extension.js`)
- **Endpoints are read once at module load.** Top-level constants `UQt=udn("cpsEndpoints")`, `BQt=udn("krsEndpoints")` and `B0e=udn("endpoints")` (`readEndpointOverride`) mean endpoint changes made after kiro-agent loads have no effect until the next reload.
- **The error comes from the command handler.** `kiro.usageLimits.getUsageLimits` is registered in function `dga`. On failure it builds `` `Unable to fetch account usage data: ${f.message}` ``. Unless the error is FEATURE_NOT_SUPPORTED or throttling, it calls `X.error(h)` and then `WEf(h)` = `showErrorToastRateLimited`, which calls `window.showErrorMessage` at most once per 5 minutes per message (`aga=300*1e3`). The handler has no retry.
- **Startup callers:**
  - Usage-monitor `register` (`e$a`) calls `getUsageLimits` immediately during activation, once the profile is ready.
  - The profile watcher's `invokeInitializerAPIs` also calls it.
  - The login listener calls it on sign-in.
- **Log timing.** `Kiro Logs.log` lines 3376 and 3995 show the error inside kiro-agent's activation block, next to "Congratulations, "Kiro" is now active!" (01:05:32.061 and 01:14:41.169 local, which is UTC−7). These lines share a single flush timestamp, so the exact call time is earlier than shown. In the 011440 host, CPS bound at 08:14:41.130 and the error was flushed at .169. That is a near-tie, consistent with the call happening before the bind.

### 3. User settings (`~/Library/Application Support/Kiro/User/settings.json`)
- `api2kiroDual.enabled = true`.
- `codewhisperer.config.cpsEndpoints`: all 8 regions point to `http://127.0.0.1:19811`.
- `codewhisperer.config.krsEndpoints` and `endpoints`: all 8 regions point to `http://127.0.0.1:19810`.

This is the correct state while the proxy is enabled. Endpoints are not left behind by mistake: `deactivate` only stops the servers, which is the intended design.

### 4. Current listener
`lsof -nP -iTCP:19811 -sTCP:LISTEN` shows `Kiro H` pid 44271 listening on 127.0.0.1:19811, and 19810 is also held. So CPS works once it starts: there is no port conflict and no crash. That rules out secondary hypotheses (b) and (c). (d) is ruled out because the route exists (an empty stub) and the error is a connection-level failure.

### 5. Secondary hypothesis (a)
Confirmed as an aggravating factor, not the root cause. The awaited `initIdentityKey` and `initTokenStore` (keychain) calls, plus KRS binding first, sit in front of the CPS bind. In one cold start this added up to 8.3 s, though not every start was that slow.

## Conclusions

- **Root cause:** kiro-agent activates first and fetches usage from the persisted CPS endpoint before any extension host is listening on 19811.
- **Impact:** a one-off error toast and log line per startup or reload. There is no functional loss, because our CPS returns `{}` for usage anyway.
- **Removing endpoints is not a viable fix.** kiro-agent caches them at module load, so clearing them on deactivate would make the next session talk to real AWS for its whole lifetime, which breaks the proxy until another reload.

## Recommendations (ranked)

1. **Suppress or retry inside kiro-agent via the existing backend patch** (`src/selectorStyle.ts`, `planKiroAgentBackend`, which already patches `dist/extension.js`). Extend the patch so that, for errors whose message matches `ECONNREFUSED 127.0.0.1:1981x`, `getUsageLimits` waits and retries a few times (for example 500 ms × 10) or skips `WEf`. This is the only fix that removes the toast reliably, because only it acts inside the code that runs first.
   - Trade-off: the patch target can drift when Kiro upgrades. Mitigate with the same marker and drift-detection approach as the other hooks. The patch also only takes effect after one reload.
2. **Bind CPS (and KRS) as early as possible in `activate()`.** Construct and start both `PortHolder`s before `initIdentityKey`, `initTokenStore`, sidebar registration and the catalog kick-offs, and do the `bindOnce` for CPS before KRS or in parallel.
   - The fast `bindOnce` path does not need the identity key. Only the busy-port probe and yield path do, so await the key lazily inside `tryAcquire` before calling `probeIdentity`.
   - This narrows the window from up to 8 s down to the gap between kiro-agent activating and ours, and in the 011440 case it was a near-tie. It reduces how often the toast appears but cannot guarantee it disappears. It is low risk.
3. **After CPS first becomes OWNER**, fire `vscode.commands.executeCommand("kiro.usageLimits.getUsageLimits")` once, fire-and-forget. This clears kiro-agent's cached error state and broadcasts fresh usage data to its UI. The toast stays, but nothing in the UI remains stale.
4. **Rejected:**
   - Clearing `cpsEndpoints` on deactivate and rewriting them after binding. kiro-agent reads them at load, so this breaks proxying for the whole session.
   - A separate always-on helper process holding the ports. This is heavy and changes the architecture.

## Immediate workaround for the user

The message is cosmetic and can be dismissed. The proxy and chat work normally, and usage is shown in the API4Kiro panel, not Kiro's own usage view. It appears at most once per 5 minutes and only right after a launch or reload. No settings change is needed. Removing the `codewhisperer.config.*Endpoints` entries would stop the error but also disable the proxy.
