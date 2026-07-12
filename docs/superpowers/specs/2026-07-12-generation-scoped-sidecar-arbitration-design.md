# Generation-scoped atomic terminal record design

## Status

This document amends `2026-07-12-subagent-health-remediation-design.md` and supersedes all earlier lease-directory and exclusive-open proposals. Tasks 1–4 remain unchanged.

## Problem

Child completion and parent remediation run in separate processes. Correctness cannot depend on two filesystem calls executing without preemption. A final path created before its JSON is complete exposes partial records; token checks followed by rename are not atomic.

The protocol needs a single cross-process operation that publishes an already-complete record only when no winner exists.

## Generation identity

Every Pi launch has an eight-hex `runningChildId`. Its permanent terminal record is:

```text
<session-file>.subagent-<running-child-id>.exit
```

Resumes use a new child ID and path. No ownership transfer or reservation exists.

## Atomic publication primitive

Both child and parent:

1. Create a uniquely named hidden temporary file in the same directory as the final record.
2. Write the complete versioned JSON record.
3. `fsync` and close the temporary file.
4. Call `linkSync(tempPath, finalPath)`.
5. Remove only their own temporary path.

A hard link creates the final directory entry atomically and fails with `EEXIST` when another process already won. Because the temporary inode is complete and durable before `link`, readers never observe a partial final record.

The final record is retained permanently. Watchers read but do not unlink it. This prevents second callbacks, duplicate watchers, or late children from replacing the winner.

No correctness assumption spans multiple syscalls: the single `link` decides ownership.

## Records

```ts
type ChildTerminalRecord =
  | { version: 1; runningChildId: string; type: "done" }
  | { version: 1; runningChildId: string; type: "ping"; name: string; message: string }
  | { version: 1; runningChildId: string; type: "error"; errorMessage: string; stopReason?: string };

interface RemediationTerminalRecord {
  version: 1;
  runningChildId: string;
  type: "remediation";
  claimedAt: number;
  reason: "heartbeat-stale" | "pane-unavailable";
}
```

Readers reject invalid versions, child IDs, types, and unbounded strings.

## Child outcomes

- `published`: child linked its complete record first.
- `existing`: another complete child record already owns the path; do not overwrite.
- `blocked`: remediation owns the path.
- `error`: temp write/fsync/link/read failed for a reason other than expected `EEXIST`.

On `EEXIST`, the child reads the permanent winner and returns `existing` or `blocked`. It never unlinks or writes the final path.

Temp write/fsync failure leaves no final record. The original exception is preserved after best-effort removal of the caller-owned temp path.

Explicit `caller_ping` and `subagent_done` throw publication errors. Auto-exit success/provider-error paths emit a bounded diagnostic and request shutdown so the shell sentinel and session transcript remain fallback completion evidence.

## Parent remediation

Remediation runs only for autonomous runs already classified `broken`.

The parent builds and fsyncs a remediation temp record, then links it to the generation final path.

- Link succeeds: filesystem remediation ownership is established; parent proceeds immediately to in-memory terminal claim.
- `EEXIST` with child record: defer to watcher completion.
- `EEXIST` with remediation record: treat filesystem ownership as established and attempt/recover in-memory claim.
- Other filesystem/validation error: return bounded error; leave watcher, pane, map, and session intact.

There is no stale partial final record and therefore no stale fencing threshold, directory rename, inode replacement, or token cleanup.

## Watcher behavior

`pollForExit()` receives `runningChildId` and reads only that generation path.

- Child `done`, `ping`, or `error`: return existing `PollResult` semantics without deleting the permanent record.
- Remediation: ignore because remediation owns notification.
- Invalid/unreadable: leave intact, report bounded diagnostics, retry.
- Missing: continue sentinel/pane polling.

Retaining the final record makes duplicate watchers idempotent and prevents later publication.

## Exactly-once parent ownership

Atomic hard-link publication arbitrates child versus parent across processes. Existing in-memory `TerminalClaim` arbitrates watcher, remediation, and shutdown inside the parent.

Only the in-memory claim winner aborts, closes, identity-safe removes, refreshes the widget best-effort, and sends a terminal message.

Done-phase and interactive runs remain silent and unremediated. Autonomous remediation never retries work.

## Error containment

All parent helper outcomes are discriminated and bounded to 200 whitespace-collapsed characters. No filesystem error escapes the status interval.

Unexpected widget/delivery failures are contained so widget rendering cannot prevent the sole terminal failure. Delivery failure may be logged boundedly but never triggers a second steer.

## Launch and resume

No terminal record is created before child publication or parent remediation. Spawn/resume command-delivery failure cannot strand ownership state. Resume simply receives another child ID/path.

General pane rollback remains Task 6.

## Temporary artifact cleanup

Successful and failed attempts remove only their own unique temp path. A process crash can leave a hidden temp file, but it cannot block terminal ownership because only the permanent final path participates in arbitration.

Best-effort cleanup may remove old temp files matching this extension’s strict generated prefix after a conservative age, but cleanup is not required for correctness and must never target final records.

## Portability

Hard links require source and destination on the same filesystem; same-directory temp placement guarantees this. Node’s `linkSync` maps to the platform hard-link primitive. Unsupported/filesystem-denied links return bounded errors and defer automatic remediation rather than falling back to an unsafe protocol.

## Testing

Strict test-first coverage must prove:

1. Child IDs isolate paths.
2. Child-first link makes remediation defer.
3. Parent-first link makes child return blocked.
4. Final record is never visible before temp write/fsync completes.
5. Temp write/fsync failure creates no final record.
6. Two child callbacks cannot overwrite the first record.
7. Duplicate watchers read the same permanent record without unlinking.
8. Child and parent simultaneous links yield exactly one winner.
9. Unexpected link/read/validation errors are bounded and contained.
10. All four child terminal paths use the shared publisher.
11. Generation-only polling leaves other generations untouched.
12. Existing exactly-once, shutdown, widget-failure, identity-safe deletion, done silence, interactive preservation, bounded result, and real spawn/resume delivery tests remain green.
13. Tests invoke production event/tool/watcher paths, not only helper or source-string checks.

## Acceptance criteria

- Final records appear atomically complete.
- Exactly one hard-link operation wins per generation.
- No lease, token, stale fencing, or check-then-rename protocol remains.
- Final records are permanent and never overwritten/unlinked by runtime paths.
- Resume generations are isolated.
- Parent filesystem failures never escape supervision.
- Automatic remediation emits at most one failure and never retries work.
