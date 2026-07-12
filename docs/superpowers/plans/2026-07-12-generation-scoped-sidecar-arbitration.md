# Generation-Scoped Exclusive Sidecar Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build exactly-once child completion versus parent remediation around exclusive creation of one generation-specific terminal path, eliminating non-atomic lease token protocols.

**Architecture:** Child and parent compete with `openSync(path, "wx")`. The winning inode is authoritative. Fresh partial files defer remediation; stale partial files for already-broken children are atomically renamed so an open writer is fenced onto a tombstone inode. Existing in-memory claims govern parent cleanup and notification.

**Tech Stack:** TypeScript ESM, Node filesystem descriptors, Node `node:test`, Pi extension lifecycle APIs.

## Global Constraints

- Start from approved Tasks 1–4 and the exclusive-sidecar design commit; no prior Task 5 code is retained.
- Terminal paths include the exact eight-hex `runningChildId`.
- Ownership is decided by exclusive final-path creation, not metadata check followed by rename.
- Fresh incomplete records defer; stale fencing threshold is exactly 30 seconds and only applies to an already-broken child.
- Child writes use held file descriptors plus `fsyncSync()`; no overwrite of existing records.
- Parent filesystem errors are bounded to 200 collapsed characters and never escape status supervision.
- Resume uses a fresh generation path and performs no ownership transfer/reservation.
- Only the in-memory claim winner cleans up or notifies.
- Strict complete RED-before-GREEN TDD evidence is mandatory.

---

### Task 1: Exclusive Generation Sidecar and Safe Remediation (Task 5X)

**Files:**
- Create: `pi-extension/subagents/sidecar-arbitration.ts`
- Modify: `pi-extension/subagents/cmux.ts`
- Modify: `pi-extension/subagents/subagent-done.ts`
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/test.ts`

**Interfaces:**
- `getGenerationExitFile(sessionFile, runningChildId): string`
- `publishGenerationTerminal(params): PublishOutcome`
- `tryClaimGenerationRemediation(params): RemediationOutcome`
- `readGenerationTerminal(sessionFile, runningChildId): ReadOutcome`
- `pollForExit()` consumes `runningChildId` for Pi sidecars.
- Parent retains the original Task 5 `TerminalClaim` and identity-safe cleanup concepts.

- [ ] **Step 1: Write all exclusive-ownership tests before production code**

Add generation-path tests and reject invalid IDs.

Add deterministic publisher tests using injected filesystem operations/hooks:

- successful exclusive create/write/fsync/close/readback returns `published`;
- existing valid child record returns `existing` without opening for write;
- existing remediation record returns `blocked`;
- second `done`/`error`/`ping` cannot overwrite first payload;
- write or fsync failure returns the original error and leaves an incomplete recoverable record;
- child paused after exclusive open, parent stale-fences the path, child resumes writing through the held descriptor, canonical remediation remains unchanged, and child returns `lost`;
- no cleanup operation can unlink a replacement canonical owner.

Add deterministic parent tests:

- parent exclusive create wins and blocks child publication;
- existing complete child record defers remediation and remains watcher-consumable;
- fresh empty/partial/malformed/wrong-child record defers;
- stale incomplete record with healthy child defers;
- stale incomplete record with broken child is renamed to a unique tombstone, canonical remediation is exclusively created, and tombstone cleanup targets only the renamed path;
- failed rename/recreate due to a competitor re-inspects and defers;
- remediation write/fsync/stat/rename/open errors return bounded error outcomes, not throws.

Add watcher and parent lifecycle tests before production edits:

- poller A consumes only A’s generation and leaves B untouched;
- remediation errors do not escape refresh interval and notify once per unchanged diagnostic;
- valid sidecar precedence;
- exactly one in-memory terminal owner;
- shutdown winner/loser;
- widget failure cannot skip terminal failure delivery;
- actual watcher abort catch suppression;
- real spawn and resume delivery paths suppress lost claims;
- interactive and done-phase zero-message preservation;
- close failure and identity-safe replacement-map behavior;
- command delivery failure creates no terminal artifact.

Add child extension tests proving all four terminal paths call exclusive publication with session and child ID. Explicit tools throw publication errors; auto-exit paths retain bounded fallback behavior.

- [ ] **Step 2: Run focused tests and capture genuine RED**

```bash
node --test --test-name-pattern='exclusive|generation|partial|fenc|terminal owner|remediat|watcher abort|sidecar|shutdown claim|widget refresh|identity-safe|spawn delivery|resume delivery|done-phase|interactive broken' test/test.ts
```

Expected: failures for absent sidecar module, generation polling, and parent ownership/remediation APIs. Record exact exit status and key failure lines before production edits.

- [ ] **Step 3: Implement record validation and bounded outcomes**

Validate eight-hex child IDs. Implement versioned child and remediation records from the spec. Reading distinguishes:

```ts
type ReadOutcome =
  | { kind: "missing" }
  | { kind: "child"; result: PollResult }
  | { kind: "remediation"; record: RemediationTerminalRecord }
  | { kind: "incomplete"; ageMs: number; error?: string }
  | { kind: "error"; error: string };
```

Bound all surfaced errors to 200 collapsed characters.

- [ ] **Step 4: Implement child exclusive publication through a held descriptor**

Use `openSync(exitPath, "wx", 0o600)`. On success, write the complete payload to that descriptor, `fsyncSync`, and close.

After close, read canonical record. Matching intended record means `published`; remediation/missing/different inode/content means `lost`.

On `EEXIST`, inspect without modifying. Never call `writeFileSync` on an existing final path and never unlink after check-token logic.

Expose test hooks around post-open/pre-write and post-write/pre-readback so the test can interleave parent fencing while the descriptor remains open.

- [ ] **Step 5: Implement parent exclusive claim and stale partial fencing**

First try `openSync(exitPath, "wx", 0o600)` and write/fsync/close remediation JSON. If it succeeds, return acquired.

On `EEXIST`, inspect:

- complete child: defer;
- remediation: already-owned/defer;
- incomplete younger than 30,000 ms: defer;
- incomplete older than 30,000 ms with `childBroken: false`: defer;
- stale incomplete with broken child: rename canonical path to unique tombstone, then retry exclusive create.

A failed rename or recreate returns defer/error after reinspection. Remove only the unique tombstone path best-effort after canonical remediation creation. A writer with the original open descriptor can no longer affect canonical path.

- [ ] **Step 6: Migrate polling and all child terminal paths**

`pollForExit()` accepts `runningChildId`; it consumes only complete child records. It ignores remediation and leaves incomplete records for retry. Claude behavior remains unchanged.

`subagent-done.ts` uses the publisher for auto-exit done/error, `caller_ping`, and `subagent_done`. Explicit tool publication errors throw. Auto-exit publication error is bounded to stderr, then shutdown/sentinel/session extraction remains the fallback.

- [ ] **Step 7: Implement parent exactly-once remediation**

Reintroduce the original Task 5 in-memory claims, shared production delivery helper, identity-safe delete, bounded health result, and tests.

Only an acquired remediation record may attempt `claimTerminal("remediation")`. The winner aborts watcher, closes best-effort, identity-safe removes, refreshes widget best-effort, and sends exactly one failure containing session path and `subagent_resume` guidance. No retry occurs.

Status refresh collects remediation candidates after iteration and suppresses interactive/done transitions.

- [ ] **Step 8: Verify resume and delivery failure behavior**

Resume constructs a new ID/path and does not inspect old paths. No ownership file exists before child publication, so `sendLongCommand()` failure cannot strand terminal ownership. Preserve existing pane behavior for Task 6 rollback.

- [ ] **Step 9: Run GREEN and full verification**

```bash
node --test --test-name-pattern='exclusive|generation|partial|fenc|terminal owner|remediat|watcher abort|sidecar|shutdown claim|widget refresh|identity-safe|spawn delivery|resume delivery|done-phase|interactive broken' test/test.ts
npm test
git diff --check
```

Expected: all pass.

- [ ] **Step 10: Self-review protocol assumptions**

Verify:

- no separate lease directory or token check remains;
- no publisher overwrites or unlinks existing canonical path;
- parent rename acts on the stable incomplete inode publishers never replace;
- open-descriptor fencing test pauses after open and before completion;
- second terminal callbacks cannot overwrite;
- all parent errors are contained;
- tests exercise production delivery paths rather than source strings.

- [ ] **Step 11: Commit and report**

```bash
git add pi-extension/subagents/sidecar-arbitration.ts pi-extension/subagents/cmux.ts pi-extension/subagents/subagent-done.ts pi-extension/subagents/index.ts test/test.ts
git commit -m "feat(subagents): claim generation terminal paths exclusively"
```

Write `.superpowers/sdd/task-5x-report.md` with exact RED/GREEN/full evidence, commit, files, self-review, and concerns.
