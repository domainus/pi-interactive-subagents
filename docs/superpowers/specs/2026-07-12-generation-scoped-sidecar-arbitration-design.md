# Generation-scoped exclusive sidecar ownership design

## Status

This document amends `2026-07-12-subagent-health-remediation-design.md` and supersedes earlier lease-directory proposals. Health classification from Tasks 1–4 remains unchanged.

## Problem

Completion and remediation execute in separate processes. Portable filesystem APIs cannot atomically compare lease metadata and then rename another file. Any protocol built from “read token, then rename” permits process preemption between those operations.

Terminal ownership therefore needs one filesystem operation that is itself authoritative.

## Generation identity

Every Pi-backed launch has a unique eight-hex-character `runningChildId`. Its terminal record is:

```text
<session-file>.subagent-<running-child-id>.exit
```

A resumed transcript receives a new child ID and a different terminal path. Previous runs cannot block or overwrite the resumed generation. Claude sentinel behavior remains unchanged.

## Exclusive ownership primitive

The generation exit path is both the ownership record and terminal payload. Child publication and parent remediation compete using exclusive creation (`openSync(path, "wx")`). Exactly one process can create the path.

There is no separate lease directory, token transfer, resume reservation, or check-then-rename ownership claim.

## Record types

A complete child terminal record uses the existing payload meanings with a version and child ID:

```ts
type ChildTerminalRecord =
  | { version: 1; runningChildId: string; type: "done" }
  | { version: 1; runningChildId: string; type: "ping"; name: string; message: string }
  | { version: 1; runningChildId: string; type: "error"; errorMessage: string; stopReason?: string };
```

A parent remediation owner writes:

```ts
interface RemediationTerminalRecord {
  version: 1;
  runningChildId: string;
  type: "remediation";
  claimedAt: number;
  reason: "heartbeat-stale" | "pane-unavailable";
}
```

An empty, partial, malformed, wrong-version, or wrong-child file is an incomplete/invalid owner record rather than absence.

## Child publication

The child:

1. Exclusively creates the generation exit path.
2. If creation reports `EEXIST`, reads the existing record:
   - completed child record: return `existing` without overwrite;
   - remediation record: return `blocked`;
   - incomplete record: return `blocked` while it remains fresh.
3. If creation succeeds, write the complete JSON payload through the held file descriptor.
4. Call `fsyncSync()` and close the descriptor.
5. Re-read/stat the canonical path:
   - if it still contains the intended complete child record, return `published`;
   - if remediation fenced it to another inode/path, return `lost`.

The child never overwrites an existing terminal record. A second terminal callback cannot replace `done`, `ping`, or `error`.

If writing fails, the publisher closes the descriptor and returns the original bounded error. It does not perform a check-then-unlink cleanup that could remove a replacement owner. The incomplete file becomes eligible for parent stale recovery after the broken-health gate.

Explicit `caller_ping` and `subagent_done` tool executions throw publication errors. Auto-exit success/provider-error handlers record a bounded publication diagnostic, request shutdown, and retain shell-sentinel/session extraction as the fallback completion path; provider error detail remains in the child session.

## Parent remediation

Remediation runs only for an autonomous child already classified `broken`.

1. Try exclusive creation of the generation exit path.
2. If creation succeeds, write/fsync/close a remediation record, then claim in-memory ownership without an asynchronous boundary.
3. If `EEXIST`, inspect the existing record:
   - valid child terminal record: defer to watcher completion;
   - remediation record for this child: treat remediation ownership as already established;
   - incomplete/invalid fresh record: defer;
   - incomplete/invalid record older than 30 seconds: attempt stale fencing.
4. Stale fencing atomically renames the canonical exit path to a unique tombstone.
5. Immediately retry exclusive creation of the canonical path and write a remediation record.
6. If rename or exclusive recreation loses a race, inspect/defer rather than deleting a replacement.
7. Remove only the uniquely named tombstone best-effort after remediation ownership is established.

A child still writing through an open descriptor after stale fencing writes to the renamed tombstone inode, not the new canonical remediation record. Its post-close canonical verification returns `lost`.

On platforms where renaming an open file fails, remediation returns a bounded defer/error outcome. It remains safe, although cleanup waits for a later retry.

## Why stale fencing cannot steal a fresh replacement

Publishers never remove or replace the canonical terminal path. Once a child exclusively creates it, that inode remains canonical until either:

- the watcher consumes a valid complete record; or
- the parent atomically renames an incomplete stale record.

There is no gap where the stale owner removes its path and another same-generation publisher recreates it. A second publisher sees `EEXIST` and never overwrites. Therefore the inode the parent stats is stable until the parent rename or watcher consumption; a failed rename causes reinspection.

## Watcher behavior

`pollForExit()` receives `runningChildId` and reads only that generation path.

- Valid `done`, `ping`, or `error`: consume and return existing `PollResult` semantics.
- `remediation`: ignore; remediation owns parent notification.
- Partial/invalid record: leave untouched and retry.
- No path: continue sentinel/pane polling.

A watcher never consumes another generation’s record.

## Filesystem errors

Shared helpers return discriminated outcomes and bounded messages (collapsed whitespace, maximum 200 characters). Parent arbitration errors never escape the status interval.

On parent error:

- no in-memory terminal claim occurs;
- watcher/pane/map/session remain intact;
- one bounded diagnostic is emitted per unchanged error;
- later ticks retry.

Child explicit tool paths preserve errors by throwing. Auto-exit paths preserve provider/session detail and emit the publication error to bounded stderr before shell-sentinel fallback.

## Exactly-once parent ownership

Exclusive sidecar creation arbitrates child versus parent across processes. Existing in-memory terminal claims arbitrate watcher, remediation, and shutdown inside the parent process.

Only the in-memory claim winner may abort, close, remove, or notify. Done-phase and interactive runs remain silent and unremediated.

## Launch and resume

Spawn/resume create no terminal artifact before the child process attempts publication. Command-delivery failure cannot strand an ownership record. Resume simply uses a new child ID and path; it never reads or modifies prior generation files.

General pane rollback remains Task 6.

## Testing

Strict test-first coverage must include:

1. Different child IDs sharing a session produce different exit paths.
2. Child-first exclusive creation makes parent defer.
3. Parent-first remediation makes child return blocked.
4. Second child publication never overwrites an existing complete payload.
5. Watcher consumes only its generation.
6. Partial fresh record defers remediation.
7. Partial stale record plus broken health is atomically renamed and fenced.
8. A child paused after open, then fenced, writes only the tombstone inode and returns lost.
9. Parent rename/recreate race failures re-inspect/defer safely.
10. Child write failure preserves the original error and leaves recoverable partial ownership.
11. Remediation record write/fsync errors are bounded and contained.
12. All four child terminal paths use exclusive publication.
13. Auto-exit publication errors retain session/sentinel fallback; explicit tools throw.
14. Existing exactly-once, shutdown, widget-failure, identity-safe deletion, done silence, interactive preservation, bounded result, and real spawn/resume delivery tests remain green.
15. No source-string-only test substitutes for production-path behavior.

## Acceptance criteria

- One exclusive creation decides cross-process ownership.
- No check-token-then-rename correctness assumption remains.
- A fenced writer cannot write to the canonical remediation record.
- Fresh partial records are never reclaimed.
- Stale partial records cannot block a broken generation forever where atomic rename is supported.
- Resumed children are isolated by generation.
- A valid child terminal record wins whenever published before parent exclusive ownership.
- Arbitration errors never escape status supervision.
- Autonomous remediation emits at most one failure and never retries work automatically.
