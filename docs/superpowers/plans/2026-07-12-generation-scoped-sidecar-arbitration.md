# Generation-Scoped Sidecar Arbitration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Task 5’s session-scoped terminal arbitration with generation-scoped sidecars and token-fenced leases so completion/remediation remains race-safe across child processes and resumed sessions.

**Architecture:** Derive exit and lease artifacts from session path plus `runningChildId`. A shared arbitration module atomically publishes metadata, fences stale publishers through directory rename plus token revalidation, and returns bounded discriminated errors. Filesystem arbitration gates cross-process ownership; existing in-memory claims gate watcher/remediation/shutdown cleanup.

**Tech Stack:** TypeScript ESM, Node.js filesystem primitives, Node `node:test`, Pi extension lifecycle APIs.

## Global Constraints

- Start from approved Task 4 commit `3704f5e`.
- Exit and lease artifacts are scoped by `runningChildId`; resume never transfers old ownership.
- Stale publisher recovery threshold is exactly 30 seconds and applies only after the same child is already `broken`.
- Publisher must revalidate child ID and random token immediately before final sidecar rename.
- Valid final sidecar recheck occurs while parent holds remediation ownership and before in-memory claim.
- No `await` occurs inside filesystem arbitration critical sections.
- Arbitration filesystem errors are bounded to 200 collapsed characters and never escape the status interval.
- Autonomous remediation never retries/resumes/relaunches work.
- Interactive and done-phase runs remain untouched and silent.
- Follow strict RED-before-GREEN TDD and preserve exact evidence.

---

### Task 5R: Generation-Scoped Terminal Ownership and Remediation

**Files:**
- Create: `pi-extension/subagents/sidecar-arbitration.ts`
- Modify: `pi-extension/subagents/cmux.ts`
- Modify: `pi-extension/subagents/subagent-done.ts`
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/test.ts`

**Interfaces:**
- Produces `getGenerationExitFile(sessionFile, runningChildId)` and `getGenerationLeaseDir(...)`.
- Produces `publishGenerationSidecar(...)` with `published | blocked | lost | error` outcomes.
- Produces `tryClaimGenerationRemediation(...)` with `acquired | defer | error` outcomes and a token-fenced retained marker.
- Extends `pollForExit()` options with `runningChildId` for Pi-backed sidecar consumption.
- Preserves existing `TerminalClaim`, identity-safe deletion, shared spawn/resume delivery, and bounded result interfaces described in the original Task 5 brief.

- [ ] **Step 1: Write every arbitration and remediation test before production edits**

Add tests for generation path isolation:

```ts
it("isolates terminal artifacts by running child generation", () => {
  assert.notEqual(
    getGenerationExitFile("/tmp/session.jsonl", "child-a"),
    getGenerationExitFile("/tmp/session.jsonl", "child-b"),
  );
  assert.notEqual(
    getGenerationLeaseDir("/tmp/session.jsonl", "child-a"),
    getGenerationLeaseDir("/tmp/session.jsonl", "child-b"),
  );
});
```

Add deterministic injected hooks/ops to prove:

- child publisher owns lease first, publishes, releases, and parent defers;
- parent owns first and same-generation publisher returns `blocked`;
- an old generation remediation marker does not affect a new generation publisher;
- publisher paused before final rename loses after parent atomically fences its stale lease;
- lost publisher removes its temp payload and never creates final sidecar;
- fresh publisher lease defers even when caller asks for stale recovery;
- stale lease recovers only with `{ childBroken: true }`;
- stale lease does not recover for another child ID or a healthy child;
- fresh invalid/unmarked metadata defers; stale invalid/unmarked metadata recovers only for the broken same-generation path;
- metadata/marker publication uses temp plus rename and preserves the previous valid marker on failure;
- mkdir/stat/read/write/rename/rm errors return bounded `error` outcomes;
- child publication failure preserves the original exception and cleans only matching-token artifacts.

Add parent lifecycle tests before production edits for:

- all existing Task 5 claim/remediation races;
- shutdown winner/loser cleanup;
- widget throw still followed by one result;
- done-phase and interactive zero-message preservation;
- identity-safe map deletion;
- spawn and resume production delivery helpers suppress lost claims;
- broken-generation arbitration error leaves run registered and sends one diagnostic per unchanged error;
- a later successful retry remediates normally;
- valid generation sidecar defers remediation and remains consumable;
- `pollForExit()` consumes child A’s sidecar and leaves child B’s untouched;
- resume uses a new child ID without reading or changing old lease directories;
- command delivery failure creates no generation lease/marker.

Add child extension tests proving normal success, provider error, `caller_ping`, and `subagent_done` pass both session file and child ID to the shared publisher.

- [ ] **Step 2: Run the complete focused selection and verify genuine RED**

Run:

```bash
node --test --test-name-pattern='generation|arbitrat|terminal owner|remediat|interactive broken|done-phase|watcher abort|sidecar|shutdown claim|widget refresh|identity-safe|spawn delivery|resume delivery' test/test.ts
```

Expected: failure because generation path helpers, fenced publisher/remediation functions, and Task 5 parent ownership behavior do not exist. Preserve exact exit status and key failure lines before any production edit.

- [ ] **Step 3: Implement the focused generation arbitration module**

Use strict child-ID validation:

```ts
function requireRunningChildId(value: string): string {
  if (!/^[a-f0-9]{8}$/i.test(value)) throw new Error("invalid running child id");
  return value.toLowerCase();
}
```

Paths append `.subagent-${id}.exit` and `.subagent-${id}.lease` to the session path.

Metadata is versioned and validated:

```ts
export interface SidecarLeaseMetadata {
  version: 1;
  kind: "publisher" | "remediation";
  runningChildId: string;
  token: string;
  acquiredAt: number;
}
```

Use same-directory temp files and `renameSync()` for metadata and payload. Generate tokens with `randomUUID()` or cryptographically random bytes. Normalize errors with:

```ts
export function boundArbitrationError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown filesystem error";
}
```

Publisher re-reads metadata and compares all identity fields immediately before payload rename. Cleanup verifies token ownership before removing a lease directory.

- [ ] **Step 4: Implement stale fencing through atomic directory rename**

When a publisher lease is older than 30,000 ms and `childBroken` is true:

1. rename the existing lease directory to a unique tombstone path;
2. create the canonical lease directory;
3. atomically publish remediation metadata with a new token;
4. recheck the final sidecar;
5. return an acquired lease only when no sidecar exists;
6. remove tombstone best-effort.

If any competing operation recreates the canonical path first, return `defer`. A publisher tied to the renamed directory must fail canonical metadata token revalidation before payload rename.

- [ ] **Step 5: Migrate child and watcher sidecar paths**

`subagent-done.ts` reads both `PI_SUBAGENT_SESSION` and `PI_SUBAGENT_ID` and calls `publishGenerationSidecar()` on all four terminal paths.

`pollForExit()` accepts `runningChildId?: string`. For Pi runs it reads and consumes only `getGenerationExitFile(sessionFile, runningChildId)`. Claude sentinel behavior is unchanged. Remove duplicate generic `.exit` construction from new Pi launch paths.

- [ ] **Step 6: Implement exactly-once parent remediation on top of arbitration**

Reintroduce the original Task 5 in-memory ownership helpers and tests from the approved plan. `remediateBrokenSubagent()` calls `tryClaimGenerationRemediation()` with `running.id`, current time, and `childBroken: true`.

Only `acquired` may proceed to `claimTerminal("remediation")`. If the in-memory claim loses, retain safe ownership without cleanup/notification and let the winner finish. `defer` leaves the watcher intact. `error` records a bounded diagnostic and leaves the run intact.

After claim:

1. capture bounded diagnostics;
2. abort watcher;
3. close pane best-effort;
4. identity-safe remove;
5. refresh widget best-effort;
6. send exactly one terminal failure with session path and `subagent_resume` guidance.

Status refresh excludes done/interactive transitions and remediates collected candidates after map iteration.

- [ ] **Step 7: Keep resume generation-independent and launch transactional**

`subagent_resume` creates its new random ID and directly constructs the command with that ID. It does not reserve, inspect, replace, or remove any old generation lease. No sidecar artifact exists before the child starts publishing.

Task 6 will provide general pane rollback; for this task, ensure no new arbitration artifact can be stranded when `sendLongCommand()` throws.

- [ ] **Step 8: Run focused GREEN and full verification**

Run:

```bash
node --test --test-name-pattern='generation|arbitrat|terminal owner|remediat|interactive broken|done-phase|watcher abort|sidecar|shutdown claim|widget refresh|identity-safe|spawn delivery|resume delivery' test/test.ts
npm test
git diff --check
```

Expected: all pass.

- [ ] **Step 9: Self-review process boundaries**

Inspect the diff and explicitly verify:

- no generic Pi `.exit` path remains in launch/watch paths;
- no resume ownership transfer exists;
- every child rename is preceded by token revalidation;
- stale recovery requires both 30 seconds and broken health;
- filesystem errors cannot escape `refreshSubagentStatuses()`;
- only terminal-claim winner closes/removes/notifies;
- tests invoke real production delivery helpers, not a parallel test-only abstraction.

- [ ] **Step 10: Commit and report**

```bash
git add pi-extension/subagents/sidecar-arbitration.ts pi-extension/subagents/cmux.ts pi-extension/subagents/subagent-done.ts pi-extension/subagents/index.ts test/test.ts
git commit -m "feat(subagents): arbitrate generation-scoped terminal ownership"
```

Write `.superpowers/sdd/task-5r-report.md` with exact RED/GREEN/full output, commit SHA, files, self-review, and concerns.
