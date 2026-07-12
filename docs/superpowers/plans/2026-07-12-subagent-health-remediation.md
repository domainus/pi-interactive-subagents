# Subagent Health Detection and Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect frozen or unreachable Pi-backed subagents, safely retire confirmed-broken autonomous runs exactly once, preserve interactive runs, and prevent launch-created orphan panes.

**Architecture:** Extend the existing activity sidecar with a semantic-neutral heartbeat, feed pane probe outcomes from the existing completion poll into a pure status health model, and add a terminal-claim gate around completion/remediation cleanup. Keep sidecars and sentinels authoritative for completion; health evidence may only produce an explicit failure.

**Tech Stack:** TypeScript ESM, Node.js `node:test`, Pi extension lifecycle APIs, filesystem sidecars, Herdr/cmux/tmux/Zellij/WezTerm adapters.

## Global Constraints

- Heartbeat interval is exactly 5 seconds.
- Heartbeat age reaches `stalled` at 60 seconds and `broken` at 120 seconds.
- Three consecutive unreadable pane probes confirm pane breakage.
- A final valid exit sidecar always wins over health remediation.
- Autonomous remediation never automatically retries, resumes, or relaunches work.
- Interactive broken runs remain registered, open, and silent except for widget state.
- Exactly one path may notify or close a terminal run.
- Preserve session files and generated artifacts.
- Follow strict red-green-refactor TDD for every production change.

---

## File Structure

- Modify `pi-extension/subagents/activity.ts`: heartbeat schema, validation, and recorder operation.
- Modify `pi-extension/subagents/subagent-done.ts`: generation-owned heartbeat timer lifecycle.
- Modify `pi-extension/subagents/status.ts`: heartbeat/pane health observations, `broken` classification, transitions, and formatting.
- Modify `pi-extension/subagents/cmux.ts`: expose reusable exit-sidecar consumption and report pane probe outcomes from `pollForExit()`.
- Modify `pi-extension/subagents/index.ts`: store probe health, claim terminal ownership, remediate autonomous failures, suppress watcher races, and make launches transactional.
- Modify `test/test.ts`: pure/unit/lifecycle race and launch-cleanup coverage.
- Modify `test/integration/subagent-lifecycle.test.ts`: assert heartbeat keeps a long tool healthy for longer than the stalled threshold and that completion remains singular. Broken-pane remediation stays deterministic in unit tests because the current harness tracks only its outer surfaces, not dynamically spawned child panes.
- Modify `README.md`: document heartbeat-backed `stalled`/`broken` behavior and safe autonomous remediation.

### Task 1: Activity Heartbeat Protocol

**Files:**
- Modify: `pi-extension/subagents/activity.ts`
- Test: `test/test.ts` under `describe("subagent activity snapshots")`

**Interfaces:**
- Consumes: existing `SubagentActivityState`, atomic `writeSubagentActivityFile()`, and recorder write-failure policy.
- Produces: optional `heartbeatAt?: number` and `SubagentActivityRecorder.heartbeat(): void`.

- [ ] **Step 1: Write failing compatibility and semantic-neutral heartbeat tests**

Add tests equivalent to:

```ts
it("accepts legacy snapshots without heartbeatAt", () => {
  withTempDir((dir) => {
    const activityFile = getSubagentActivityFile(dir, "legacy-child");
    writeFileSync(activityFile, `${JSON.stringify(validActivity({ runningChildId: "legacy-child" }))}\n`);
    assert.equal(readSubagentActivityFile(activityFile, "legacy-child").ok, true);
  });
});

it("updates heartbeat without changing semantic activity or sequence", () => {
  withTempDir((dir) => {
    let now = 1_000;
    const activityFile = getSubagentActivityFile(dir, "heartbeat-child");
    const recorder = createSubagentActivityRecorder({
      runningChildId: "heartbeat-child",
      activityFile,
      now: () => now,
    });
    recorder.sessionStart();
    recorder.toolExecutionStart("tool-1", "bash");
    const before = readSubagentActivityFile(activityFile, "heartbeat-child");
    assert.ok(before.ok);

    now = 6_000;
    recorder.heartbeat();
    const after = readSubagentActivityFile(activityFile, "heartbeat-child");
    assert.ok(after.ok);
    assert.equal(after.activity.heartbeatAt, 6_000);
    assert.equal(after.activity.sequence, before.activity.sequence);
    assert.equal(after.activity.latestEvent, before.activity.latestEvent);
    assert.equal(after.activity.phase, "active");
    assert.equal(after.activity.toolName, "bash");
    assert.equal(after.activity.updatedAt, before.activity.updatedAt);
  });
});

it("rejects a non-finite heartbeatAt", () => {
  withTempDir((dir) => {
    const activityFile = getSubagentActivityFile(dir, "bad-heartbeat");
    writeFileSync(activityFile, `${JSON.stringify(validActivity({
      runningChildId: "bad-heartbeat",
      heartbeatAt: "bad",
    }))}\n`);
    const read = readSubagentActivityFile(activityFile, "bad-heartbeat");
    assert.equal(read.ok, false);
    assert.equal((read as { ok: false; reason: string }).reason, "invalid");
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='heartbeat|legacy snapshots' test/test.ts
```

Expected: failure because `heartbeat()` and `heartbeatAt` validation do not exist.

- [ ] **Step 3: Implement the minimal heartbeat schema and recorder operation**

In `activity.ts`:

```ts
export interface SubagentActivityState {
  // existing fields
  heartbeatAt?: number;
}

export interface SubagentActivityRecorder {
  heartbeat(): void;
  // existing methods
}
```

Add `heartbeat() {}` to the no-op recorder. Validate the optional field by adding:

```ts
validateOptionalFiniteNumber(object, "heartbeatAt"),
```

Initialize `heartbeatAt` to `createdAt`. Add this recorder method without calling `record()` so semantic fields and sequence remain untouched:

```ts
heartbeat() {
  if (disabled) return;
  activity.heartbeatAt = now();
  flushNow();
},
```

Do not update `updatedAt`, `sequence`, `latestEvent`, `phase`, or scope fields.

- [ ] **Step 4: Run focused and complete unit tests**

Run:

```bash
node --test --test-name-pattern='subagent activity snapshots' test/test.ts
npm test
```

Expected: all pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add pi-extension/subagents/activity.ts test/test.ts
git commit -m "feat(subagents): record child heartbeats"
```

### Task 2: Child Heartbeat Timer Lifecycle

**Files:**
- Modify: `pi-extension/subagents/subagent-done.ts`
- Test: `test/test.ts` near existing child extension tests

**Interfaces:**
- Consumes: `SubagentActivityRecorder.heartbeat()`.
- Produces: exported pure timer owner helper or test-visible `HEARTBEAT_INTERVAL_MS = 5_000` and one timer per child extension session.

- [ ] **Step 1: Write failing timer lifecycle tests**

Use injected `setInterval`/`clearInterval` callbacks through a small exported helper so tests do not wait five seconds:

```ts
it("starts one heartbeat timer and stops it on shutdown", () => {
  const calls: string[] = [];
  let tick: (() => void) | undefined;
  const owner = createHeartbeatTimer(
    { heartbeat() { calls.push("heartbeat"); } },
    (callback, ms) => {
      assert.equal(ms, 5_000);
      tick = callback;
      return 41 as any;
    },
    (timer) => calls.push(`clear:${timer}`),
  );

  tick!();
  owner.stop();
  owner.stop();
  assert.deepEqual(calls, ["heartbeat", "clear:41"]);
});
```

Add an extension-level test using `createMockExtensionApi()` that invokes `session_start` twice, then `session_shutdown`, and proves only the current timer is retained and cleared.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test --test-name-pattern='heartbeat timer' test/test.ts
```

Expected: failure because `createHeartbeatTimer` is missing.

- [ ] **Step 3: Implement an idempotent timer owner and wire lifecycle events**

In `subagent-done.ts`:

```ts
export const HEARTBEAT_INTERVAL_MS = 5_000;

export function createHeartbeatTimer(
  recorder: Pick<SubagentActivityRecorder, "heartbeat">,
  setTimer = setInterval,
  clearTimer = clearInterval,
) {
  const timer = setTimer(() => recorder.heartbeat(), HEARTBEAT_INTERVAL_MS);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
    },
  };
}
```

Keep `let heartbeatTimer: ReturnType<typeof createHeartbeatTimer> | null = null`. On `session_start`, stop any previous owner, call `recorder.sessionStart()`, then create a new owner. On `session_shutdown`, stop and clear the owner before `recorder.sessionShutdown(...)`. Also stop the timer immediately before every terminal `ctx.shutdown()` path (`agent_end` auto-exit, `caller_ping`, and `subagent_done`) so no post-terminal heartbeat write races the final snapshot.

- [ ] **Step 4: Verify timer and full child-extension behavior**

```bash
node --test --test-name-pattern='heartbeat timer|auto-exit|caller_ping|subagent_done' test/test.ts
npm test
```

Expected: all pass and the Node process exits without a referenced timer leak.

- [ ] **Step 5: Commit Task 2**

```bash
git add pi-extension/subagents/subagent-done.ts test/test.ts
git commit -m "feat(subagents): supervise child heartbeat lifecycle"
```

### Task 3: Pure Heartbeat and Pane Health Classification

**Files:**
- Modify: `pi-extension/subagents/status.ts`
- Test: `test/test.ts` in the status test block

**Interfaces:**
- Consumes: activity `heartbeatAt` forwarded in `StatusObservation` and pane probe observations from Task 4.
- Produces: `SubagentStatusKind` including `broken`, heartbeat thresholds, pane probe state, and bounded reason formatting.

- [ ] **Step 1: Write failing state-machine tests**

Add tests that construct states through public functions rather than mutating private details:

```ts
it("uses fresh heartbeats to keep old semantic activity healthy", () => {
  let state = createStatusState({ source: "pi", startTimeMs: 0 });
  state = observeStatus(state, {
    snapshot: "present",
    updatedAt: 5_000,
    heartbeatAt: 115_000,
    sequence: 1,
    phase: "active",
    active: true,
    activeScope: "tool",
    activeSince: 5_000,
    activityLabel: "bash",
  }, 115_000);
  assert.equal(classifyStatus(state, 125_000).kind, "active");
});

it("ages heartbeat through stalled and broken", () => {
  let state = createStatusState({ source: "pi", startTimeMs: 0 });
  state = observeStatus(state, {
    snapshot: "present",
    updatedAt: 1_000,
    heartbeatAt: 1_000,
    sequence: 1,
    phase: "waiting",
    waitingSince: 1_000,
  }, 1_000);
  assert.equal(classifyStatus(state, 60_999).kind, "waiting");
  assert.equal(classifyStatus(state, 61_000).kind, "stalled");
  assert.equal(classifyStatus(state, 121_000).kind, "broken");
});

it("confirms pane breakage after three consecutive failures and resets on success", () => {
  let state = createStatusState({ source: "pi", startTimeMs: 0 });
  state = observePaneProbe(state, { readable: false, error: "pane missing" }, 1_000);
  state = observePaneProbe(state, { readable: false, error: "pane missing" }, 2_000);
  assert.notEqual(classifyStatus(state, 2_000).kind, "broken");
  state = observePaneProbe(state, { readable: true }, 3_000);
  assert.equal(state.consecutivePaneFailures, 0);
  state = observePaneProbe(state, { readable: false, error: "pane missing" }, 4_000);
  state = observePaneProbe(state, { readable: false, error: "pane missing" }, 5_000);
  state = observePaneProbe(state, { readable: false, error: "pane missing" }, 6_000);
  assert.equal(classifyStatus(state, 6_000).kind, "broken");
});
```

Also assert recovery from unclaimed `broken`, transition values (`stalled`, `recovered`, `broken`), widget/status formatting, 120-character limits, and Claude fallback unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test --test-name-pattern='heartbeat|pane breakage|broken' test/test.ts
```

Expected: failures for absent fields/functions/kind.

- [ ] **Step 3: Add explicit health fields and constants**

Add:

```ts
export const HEARTBEAT_STALLED_AFTER_MS = 60_000;
export const HEARTBEAT_BROKEN_AFTER_MS = 120_000;
export const PANE_BROKEN_AFTER_FAILURES = 3;

export type SubagentStatusKind =
  | "starting" | "active" | "waiting" | "stalled" | "broken" | "running";
export type SubagentStatusTransition = "stalled" | "broken" | "recovered" | null;
```

Extend `StatusObservation` present values with `heartbeatAt?: number`. Extend state with:

```ts
lastHeartbeatAtMs: number | null;
consecutivePaneFailures: number;
paneProblemSinceMs: number | null;
paneError: string | null;
```

Extend `StatusSnapshot` with fields used by classification and remediation:

```ts
heartbeatAgeMs: number;
heartbeatAgeText: string;
consecutivePaneFailures: number;
paneError: string | null;
```

Add:

```ts
export type PaneProbeObservation =
  | { readable: true }
  | { readable: false; error?: string };

export function observePaneProbe(
  state: SubagentStatusState,
  observation: PaneProbeObservation,
  now: number,
): SubagentStatusState {
  if (state.source === "claude") return state;
  if (observation.readable) {
    return { ...state, consecutivePaneFailures: 0, paneProblemSinceMs: null, paneError: null };
  }
  return {
    ...state,
    consecutivePaneFailures: state.consecutivePaneFailures + 1,
    paneProblemSinceMs: state.paneProblemSinceMs ?? now,
    paneError: observation.error?.replace(/\s+/g, " ").trim().slice(0, 200) || null,
  };
}
```

- [ ] **Step 4: Implement classification priority and transitions**

Classification order for Pi runs must be:

1. `broken` if pane failures are at least three;
2. `broken` if heartbeat age is at least 120 seconds;
3. `stalled` if heartbeat age is at least 60 seconds;
4. existing snapshot validity/semantic phase classification.

Use `lastHeartbeatAtMs ?? lastActivityAtMs ?? startTimeMs` as the heartbeat reference. A present observation records `observation.heartbeatAt ?? observation.updatedAt`. A compatible legacy snapshot therefore starts aging from `updatedAt`.

Transition rules:

```ts
const transition =
  state.currentKind !== "broken" && snapshot.kind === "broken" ? "broken" :
  state.currentKind !== "stalled" && snapshot.kind === "stalled" ? "stalled" :
  (state.currentKind === "stalled" || state.currentKind === "broken") &&
    (snapshot.kind === "active" || snapshot.kind === "waiting") ? "recovered" :
  null;
```

Add bounded `broken` text with either `pane unavailable` or heartbeat duration. Do not expose raw paths or multiline backend errors.

- [ ] **Step 5: Run status and full unit tests**

```bash
node --test --test-name-pattern='status|heartbeat|pane breakage|broken' test/test.ts
npm test
```

Expected: all pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add pi-extension/subagents/status.ts test/test.ts
git commit -m "feat(subagents): classify stale and broken children"
```

### Task 4: Pane Probe Reporting and Final Sidecar Recheck

**Files:**
- Modify: `pi-extension/subagents/cmux.ts`
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/test.ts`

**Interfaces:**
- Consumes: existing `pollForExit()` read attempt and `interpretExitSidecar()`.
- Produces: `PaneProbeObservation`, `onPaneProbe`, and reusable `readExitSidecar(sessionFile, { consume })`.

- [ ] **Step 1: Write failing poll observation and sidecar-consumption tests**

Extract polling dependencies only as far as needed for deterministic tests. Add tests proving:

```ts
const probes: Array<{ readable: boolean; error?: string }> = [];
// Inject one read rejection followed by one successful read containing a sentinel.
// Assert probes are [{ readable: false, error: "pane missing" }, { readable: true }].
```

Add file-backed tests for sidecar peek and consumption:

```ts
it("peeks without removing and consumes a valid exit sidecar exactly once", () => {
  withTempDir((dir) => {
    const session = join(dir, "child.jsonl");
    writeFileSync(`${session}.exit`, JSON.stringify({ type: "done" }));
    assert.deepEqual(readExitSidecar(session, { consume: false }), { reason: "done", exitCode: 0 });
    assert.deepEqual(readExitSidecar(session, { consume: true }), { reason: "done", exitCode: 0 });
    assert.equal(readExitSidecar(session, { consume: true }), null);
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test --test-name-pattern='pane probe|exit sidecar exactly once' test/test.ts
```

Expected: missing APIs.

- [ ] **Step 3: Extract authoritative sidecar consumption**

Export:

```ts
export function readExitSidecar(
  sessionFile: string,
  options: { consume: boolean },
): PollResult | null {
  try {
    const exitFile = `${sessionFile}.exit`;
    if (!existsSync(exitFile)) return null;
    const data = JSON.parse(readFileSync(exitFile, "utf8"));
    if (options.consume) rmSync(exitFile, { force: true });
    return interpretExitSidecar(data);
  } catch {
    return null;
  }
}
```

Replace duplicate fast/slow sidecar blocks in `pollForExit()` with `readExitSidecar(sessionFile, { consume: true })`. Remediation uses `{ consume: false }` for its final authoritative-artifact check, leaving normal watcher consumption intact.

- [ ] **Step 4: Report bounded pane probes from the existing read**

Extend options:

```ts
onPaneProbe?: (observation: { readable: true } | { readable: false; error?: string }) => void;
```

After successful `readScreenAsync`, call `{ readable: true }`. In `catch (error)`, call `{ readable: false, error: boundedError(error) }` before the second sidecar check. `boundedError` collapses whitespace and limits output to 200 characters.

In `watchSubagent()`, pass an `onPaneProbe` callback that updates `running.statusState = observePaneProbe(...)`. Continue using `onTick` for activity-file observation.

- [ ] **Step 5: Verify focused and complete tests**

```bash
node --test --test-name-pattern='pane probe|sidecar|pollForExit' test/test.ts
npm test
```

Expected: all pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add pi-extension/subagents/cmux.ts pi-extension/subagents/index.ts test/test.ts
git commit -m "feat(subagents): report pane health from completion polling"
```

### Task 5: Exactly-Once Terminal Claims and Autonomous Remediation

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/test.ts` under lifecycle hardening

**Interfaces:**
- Consumes: `broken` status, `readExitSidecar()`, existing watcher abort/close/map/widget/message paths.
- Produces: `claimTerminal()`, `remediateBrokenSubagent()`, exactly-once completion delivery, and bounded failure presentation.

- [ ] **Step 1: Write failing terminal-claim tests**

Add a pure claim helper expectation:

```ts
it("allows exactly one terminal owner", () => {
  const running = makeRunning();
  assert.equal(claimTerminal(running, "watcher"), true);
  assert.equal(claimTerminal(running, "remediation"), false);
  assert.equal(running.terminalClaim, "watcher");
});
```

Add a watcher/remediator race test with injected `consumeSidecar`, `close`, and `send` functions. Assert one abort, one close, one map deletion, one failure message, and no later cancellation/completion message. Add the inverse race where completion claims first and remediation is a no-op.

- [ ] **Step 2: Write failing remediation policy tests**

Cover:

- autonomous `broken` run is remediated;
- interactive `broken` run remains registered, is not aborted/closed, and sends nothing;
- a final valid sidecar causes remediation to leave the run untouched so the already-running watcher consumes it on its next poll;
- close failure still removes the exact running object and sends failure;
- a replacement map entry with the same ID is not deleted;
- failure text includes reason, preserved session path, and `subagent_resume` guidance but not unbounded screen output.

Run:

```bash
node --test --test-name-pattern='terminal owner|remediat|interactive broken|final sidecar' test/test.ts
```

Expected: failures because claim/remediation behavior is missing.

- [ ] **Step 3: Add terminal ownership to running state**

```ts
type TerminalClaim = "watcher" | "remediation" | "shutdown";

interface RunningSubagent {
  // existing fields
  terminalClaim?: TerminalClaim;
}

function claimTerminal(running: RunningSubagent, owner: TerminalClaim): boolean {
  if (running.terminalClaim) return false;
  running.terminalClaim = owner;
  return true;
}

function deleteRunningIdentitySafe(running: RunningSubagent): void {
  if (runningSubagents.get(running.id) === running) runningSubagents.delete(running.id);
}
```

Watcher completion must claim before closing/removing or delivering. If it cannot claim, it returns a suppressed outcome and its `.then()` sends nothing. Refactor the duplicated spawn/resume `.then()` logic to test a `delivered`/`suppressed` discriminator rather than treating an abort as cancellation after remediation.

- [ ] **Step 4: Implement bounded broken-result construction**

Create a helper that returns a normal `SubagentResult`-compatible failure:

```ts
function buildBrokenSubagentResult(running: RunningSubagent, snapshot: StatusSnapshot): SubagentResult {
  const reason = snapshot.statusLabel === "pane unavailable"
    ? "multiplexer pane became unavailable"
    : `child heartbeat stopped (${snapshot.heartbeatAgeText ?? "unknown age"})`;
  const diagnostics = [
    `Health: ${reason}`,
    running.statusState.latestEvent ? `Last activity: ${running.statusState.latestEvent}` : null,
    running.activityRead?.error ? `Activity error: ${boundDiagnostic(running.activityRead.error)}` : null,
    running.statusState.paneError ? `Pane error: ${boundDiagnostic(running.statusState.paneError)}` : null,
  ].filter(Boolean).join("\n");

  return {
    name: running.name,
    task: running.task,
    summary: diagnostics,
    sessionFile: running.sessionFile,
    exitCode: 1,
    elapsed: Math.floor((Date.now() - running.startTime) / 1000),
    error: "subagent health check confirmed broken runtime",
  };
}
```

Keep each diagnostic line bounded and newline-collapsed. If pane tail capture succeeds, include only a small bounded tail in expanded result content, never in status messages.

- [ ] **Step 5: Implement safe remediation sequence**

`remediateBrokenSubagent()` must:

1. return immediately for `interactive` or already claimed runs;
2. call `readExitSidecar(running.sessionFile, { consume: false })` and return immediately when found, leaving the artifact for normal watcher consumption;
3. claim `remediation`;
4. build diagnostics;
5. abort watcher;
6. close pane best-effort;
7. delete exact map entry and refresh widget;
8. send one `subagent_result` through the same bounded presentation/rendering path as other failures.

Modify `refreshSubagentStatuses()` so `broken` autonomous runs are collected, not included in `subagent_status` transition lines, then remediated after the map iteration. `stalled`/`recovered` behavior remains unchanged. Interactive transitions remain silent.

- [ ] **Step 6: Verify race, remediation, and full unit suites**

```bash
node --test --test-name-pattern='terminal owner|remediat|broken|completion watcher|interactive' test/test.ts
npm test
```

Expected: all pass with exactly-once assertions.

- [ ] **Step 7: Commit Task 5**

```bash
git add pi-extension/subagents/index.ts test/test.ts
git commit -m "feat(subagents): remediate broken autonomous runs"
```

### Task 6: Transactional Pane Launch Cleanup

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/test.ts`

**Interfaces:**
- Consumes: `launchSubagent()` surface ownership and `closeSurface()`.
- Produces: best-effort rollback for locally created panes; caller-owned pre-created panes remain untouched.

- [ ] **Step 1: Write failing ownership-aware rollback tests**

Extract a small helper rather than source-string assertions:

```ts
it("closes a locally owned pane when launch setup fails", async () => {
  const closed: string[] = [];
  await assert.rejects(() => withOwnedLaunchSurface({
    surface: "pane-1",
    owned: true,
    close: (surface) => closed.push(surface),
    launch: async () => { throw new Error("seed failed"); },
  }), /seed failed/);
  assert.deepEqual(closed, ["pane-1"]);
});

it("does not close a caller-owned pre-created pane", async () => {
  const closed: string[] = [];
  await assert.rejects(() => withOwnedLaunchSurface({
    surface: "pane-2",
    owned: false,
    close: (surface) => closed.push(surface),
    launch: async () => { throw new Error("send failed"); },
  }), /send failed/);
  assert.deepEqual(closed, []);
});
```

Also assert the original error is preserved when rollback close itself throws.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test --test-name-pattern='owned pane|caller-owned|launch setup fails' test/test.ts
```

Expected: missing helper.

- [ ] **Step 3: Implement rollback helper and wrap launch setup**

```ts
async function withOwnedLaunchSurface<T>(params: {
  surface: string;
  owned: boolean;
  close?: (surface: string) => void;
  launch: () => Promise<T> | T;
}): Promise<T> {
  try {
    return await params.launch();
  } catch (error) {
    if (params.owned) {
      try { (params.close ?? closeSurface)(params.surface); } catch {}
    }
    throw error;
  }
}
```

In `launchSubagent()`, determine `surfacePreCreated`, create/receive the surface, then place all subsequent delay, seeding, artifact generation, command delivery, and map registration inside this helper. The helper must not close after a successful map insertion. Ensure no map insertion happens until `sendLongCommand()` succeeds.

- [ ] **Step 4: Verify launch ordering and full unit tests**

```bash
node --test --test-name-pattern='launch|pane|reasoning diagnostics' test/test.ts
npm test
```

Expected: all pass, including existing assertions that validation occurs before pane creation.

- [ ] **Step 5: Commit Task 6**

```bash
git add pi-extension/subagents/index.ts test/test.ts
git commit -m "fix(subagents): roll back partial pane launches"
```

### Task 7: Documentation and Integration Verification

**Files:**
- Modify: `README.md`
- Modify: `test/integration/subagent-lifecycle.test.ts`
- Test: all test files

**Interfaces:**
- Consumes: completed behavior from Tasks 1–6.
- Produces: user-facing semantics and real lifecycle evidence.

- [ ] **Step 1: Strengthen the long-tool integration assertion**

The existing 90-second `sleep` integration test must continue to verify no false `stalled` or `broken` state after 65 seconds. Change its assertions to reject both labels:

```ts
assert.doesNotMatch(
  watchdogScreen,
  /Subagent status[\s\S]*(stalled|broken)|(stalled|broken)[\s\S]*Subagent status/i,
);
```

After completion, assert the parent receives one completion result and no broken-runtime result.

- [ ] **Step 2: Keep broken-pane remediation at the deterministic unit layer**

Do not add an integration test that guesses the dynamically spawned child pane from multiplexer display text. The current lifecycle harness tracks surfaces it creates directly but does not receive the extension's child surface ID. Confirm the Task 5 unit tests cover three failed probes, authoritative sidecar precedence, exact-map deletion, one close, and one terminal notification. Add this explanatory comment beside those tests:

```ts
// Broken-pane remediation is unit-tested with injected probes because the
// integration harness does not own the dynamically created child surface ID.
// Parsing pane titles or creation order would make this lifecycle test flaky.
```

- [ ] **Step 3: Update README health semantics**

Document:

- child heartbeats every five seconds;
- `stalled` after 60 seconds without heartbeat;
- `broken` after 120 seconds or three unreadable pane probes;
- safe autonomous cleanup and exactly-once failure notification;
- preserved sessions and explicit resume guidance;
- interactive runs are detected but not automatically cleaned up;
- Claude fallback remains elapsed-only.

Update widget examples and the state bullet list to include `broken`.

- [ ] **Step 4: Run formatting/static sanity checks**

```bash
git diff --check
rg -n 'T[B]D|T[O]DO|implement[[:space:]]+later|fill[[:space:]]+in' README.md pi-extension test docs/superpowers/plans/2026-07-12-subagent-health-remediation.md
```

Expected: `git diff --check` succeeds; the scan has no new planning placeholders in changed product/test documentation.

- [ ] **Step 5: Run complete unit suite**

```bash
npm test
```

Expected: zero failures.

- [ ] **Step 6: Run focused integration suite in the active supported multiplexer**

```bash
npm run test:integration
```

Expected: zero failures on available backends. If model/API availability blocks the run, record the exact command and error; do not claim integration success.

- [ ] **Step 7: Perform final externally rerunnable verification**

```bash
npm test && git diff --check
```

Expected: both commands exit zero from the repository root.

- [ ] **Step 8: Commit documentation and integration evidence**

```bash
git add README.md test/integration/subagent-lifecycle.test.ts
git commit -m "docs(subagents): explain broken-run remediation"
```

### Task 8: Independent Review and Remediation

**Files:**
- Review all changes since `18db692`.
- Modify only files required to resolve verified findings.

**Interfaces:**
- Consumes: completed implementation and test evidence.
- Produces: reviewed, corrected, fully verified branch.

- [ ] **Step 1: Review correctness and race safety**

Inspect:

```bash
git diff 18db692..HEAD -- pi-extension/subagents/activity.ts pi-extension/subagents/subagent-done.ts pi-extension/subagents/status.ts pi-extension/subagents/cmux.ts pi-extension/subagents/index.ts test/test.ts test/integration/subagent-lifecycle.test.ts README.md
```

Verify sidecar precedence, claim atomicity within the single Node event loop, identity-safe deletion, no duplicate steer messages, no timer leaks, and no automatic retry.

- [ ] **Step 2: Review backend and compatibility behavior**

Verify legacy activity snapshots remain valid, Claude behavior is unchanged, all backend read failures are bounded, and pane close failures cannot suppress failure delivery.

- [ ] **Step 3: Resolve findings with fresh failing tests first**

For every confirmed defect, add a narrowly failing test, run it to observe the expected failure, implement the smallest fix, and rerun the focused test before continuing.

- [ ] **Step 4: Run final verification**

```bash
npm test && git diff --check && git status -sb
```

Expected: unit tests and diff check succeed; status lists only intended commits/changes. Run `npm run test:integration` as well when a supported multiplexer and configured test model are available.

- [ ] **Step 5: Commit review fixes if any**

```bash
git add pi-extension/subagents README.md test
git commit -m "fix(subagents): address health remediation review"
```

Skip this commit only when review finds no changes are needed.
