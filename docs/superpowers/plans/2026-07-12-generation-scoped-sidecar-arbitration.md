# Generation-Scoped Atomic Terminal Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arbitrate child completion and parent remediation with atomic hard-link publication of complete generation-specific records.

**Architecture:** Each contender writes/fsyncs a unique same-directory temp record, then calls `linkSync(temp, final)`. Exactly one link creates the permanent final record. Existing in-memory claims control parent cleanup/notification.

**Tech Stack:** TypeScript ESM, Node filesystem descriptors/hard links, Node `node:test`, Pi extension lifecycle APIs.

## Global Constraints

- Start from approved Tasks 1–4 and this hard-link design; no prior Task 5 implementation remains.
- Final paths include exact eight-hex `runningChildId`.
- Final records are linked only after complete write/fsync/close.
- Runtime never overwrites or unlinks a final record.
- No lease directory, ownership token, stale fencing, or check-then-rename correctness logic.
- Parent errors are bounded to 200 collapsed characters and never escape status supervision.
- Resume uses a new generation and no transfer/reservation.
- Only in-memory claim winner cleans/notifies.
- Complete genuine RED-before-GREEN evidence is mandatory.

---

### Task 1: Atomic Hard-Link Terminal Ownership (Task 5H)

**Files:**
- Create: `pi-extension/subagents/sidecar-arbitration.ts`
- Modify: `pi-extension/subagents/cmux.ts`
- Modify: `pi-extension/subagents/subagent-done.ts`
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/test.ts`

**Interfaces:**
- `getGenerationExitFile(sessionFile, runningChildId): string`
- `publishGenerationTerminal(params): PublishOutcome`
- `tryPublishRemediation(params): RemediationOutcome`
- `readGenerationTerminal(sessionFile, runningChildId): ReadOutcome`
- `pollForExit()` receives `runningChildId` and never unlinks final records.
- Parent reuses Task 5 terminal-claim, identity-safe cleanup, and bounded delivery concepts.

- [ ] **Step 1: Write the complete hard-link and lifecycle suite before production edits**

Add deterministic injected-filesystem tests proving:

- distinct generation paths and invalid-ID rejection;
- temp record is completely written, fsynced, and closed before `linkSync`;
- child link first publishes; parent sees child and defers;
- parent link first publishes remediation; child returns blocked;
- two simultaneous/serial child publications preserve the first payload;
- temp write/fsync failure leaves final path absent and preserves original error;
- `EEXIST` reads winner without modifying it;
- unexpected link/read/validation errors return bounded outcomes;
- caller-owned temp cleanup never touches final path;
- duplicate watcher reads return the same child result and do not unlink;
- poller A never reads generation B;
- remediation record can recover in-memory ownership on a later tick without republishing.

Before production edits add production-path tests for:

- registered `agent_end` normal and provider-error paths invoke generation publisher;
- registered `caller_ping` and `subagent_done` invoke publisher and throw publication errors;
- actual spawn and resume watcher delivery paths suppress lost claims;
- terminal claim winner/loser and shutdown winner/loser;
- widget failure cannot skip one remediation result;
- send failure is contained without second message;
- interactive and done-phase runs remain registered and silent;
- close failure plus replacement-map identity safety;
- command delivery failure creates no final/temp ownership record.

- [ ] **Step 2: Run focused tests and capture genuine RED**

```bash
node --test --test-name-pattern='hard.?link|generation|terminal owner|remediat|watcher|sidecar|shutdown claim|widget|identity-safe|spawn delivery|resume delivery|done-phase|interactive broken|caller_ping|subagent_done|agent_end' test/test.ts
```

Expected: failures for absent atomic publication module, generation polling, and Task 5 parent ownership. Save exact exit status and key output before production edits.

- [ ] **Step 3: Implement validated records and paths**

Require `/^[a-f0-9]{8}$/i`. Build `<session>.subagent-<id>.exit`. Implement versioned record validation from the spec and bounded errors.

Reading returns:

```ts
type ReadOutcome =
  | { kind: "missing" }
  | { kind: "child"; record: ChildTerminalRecord; result: PollResult }
  | { kind: "remediation"; record: RemediationTerminalRecord }
  | { kind: "invalid"; error: string }
  | { kind: "error"; error: string };
```

- [ ] **Step 4: Implement one atomic publication helper**

Write a generic internal helper:

1. Generate a strict hidden temp filename beside final path.
2. `openSync(temp, "wx", 0o600)`.
3. `writeFileSync(fd, json)` or `writeSync` until complete.
4. `fsyncSync(fd)`.
5. `closeSync(fd)`.
6. `linkSync(temp, final)`.
7. `unlinkSync(temp)` best-effort.

On write/fsync failure, close and remove only temp; final remains absent. On `linkSync` `EEXIST`, remove temp and inspect permanent final. Never fall back to rename or direct final writes.

Use this for both child and remediation records.

- [ ] **Step 5: Implement child and remediation outcomes**

Child maps winning child record to `published`, existing child to `existing`, existing remediation to `blocked`, and unexpected failures to `error` preserving bounded original detail.

Parent maps winning remediation record to `acquired`, existing child to `defer`, existing remediation for same generation to `acquired-existing`, and failures to bounded `error`.

No stale/recovery threshold is needed because partial final records cannot exist through protocol writes.

- [ ] **Step 6: Migrate watcher and all child terminal paths**

`pollForExit()` reads generation final records and returns child records without deleting them. It ignores remediation. Claude remains unchanged.

`subagent-done.ts` uses the shared publisher for all four paths. Explicit tools throw publication errors. Auto-exit handlers log bounded publication errors and still request shutdown so shell sentinel/session extraction wakes the parent.

- [ ] **Step 7: Implement parent exactly-once remediation**

Reintroduce terminal claims and production delivery from the original Task 5 brief. Only `acquired`/`acquired-existing` proceeds to in-memory claim. Winner aborts watcher, closes best-effort, identity-safe removes, widget-refreshes best-effort, and sends one bounded failure with session/resume guidance.

Arbitration errors leave run intact, report once per unchanged error, and retry later. Status refresh processes candidates after map iteration and suppresses interactive/done transitions.

- [ ] **Step 8: Verify no ownership artifact precedes launch**

Spawn/resume create only session/activity/launch artifacts. New terminal temp/final paths arise solely during publication/remediation. Command delivery failure cannot strand ownership state; Task 6 handles pane rollback.

- [ ] **Step 9: Run GREEN and full verification**

```bash
node --test --test-name-pattern='hard.?link|generation|terminal owner|remediat|watcher|sidecar|shutdown claim|widget|identity-safe|spawn delivery|resume delivery|done-phase|interactive broken|caller_ping|subagent_done|agent_end' test/test.ts
npm test
git diff --check
```

Expected: all pass.

- [ ] **Step 10: Self-review atomicity and real-path coverage**

Verify:

- final path appears only through `linkSync`;
- complete fsync precedes link;
- runtime has no final-path unlink/write/rename;
- no lease/token/stale fencing remains;
- watcher leaves permanent final records;
- tests invoke registered event/tool and watcher paths, not source strings alone;
- widget/send/fs errors cannot escape status interval.

- [ ] **Step 11: Commit and report**

```bash
git add pi-extension/subagents/sidecar-arbitration.ts pi-extension/subagents/cmux.ts pi-extension/subagents/subagent-done.ts pi-extension/subagents/index.ts test/test.ts
git commit -m "feat(subagents): publish terminal records atomically"
```

Write `.superpowers/sdd/task-5h-report.md` with exact RED/GREEN/full evidence, commit, files, self-review, and concerns.
