# Generation-scoped sidecar arbitration design

## Status

This document amends `2026-07-12-subagent-health-remediation-design.md`. It supersedes any interpretation that completion sidecars or remediation ownership are shared only by session path. Health classification from Tasks 1–4 remains unchanged.

## Problem

A subagent resume reuses the session JSONL path but starts a new child process. Session-scoped exit and lease paths therefore force unrelated child generations to transfer ownership. Attempts to patch that transfer introduce gaps where an old child can publish, stale leases can block new children forever, or a live publisher can rename after remediation believes it reclaimed ownership.

The unit of terminal ownership must be one launched child generation, not one resumable transcript.

## Artifact identity

Every Pi-backed launch already has a random `runningChildId`. Terminal artifacts derive from both the preserved session path and this child ID:

```text
<session-file>.subagent-<running-child-id>.exit
<session-file>.subagent-<running-child-id>.lease/
```

The child ID is normalized to the existing generated hexadecimal identifier format before path construction. Callers never accept arbitrary path fragments.

A resumed session receives a new child ID and therefore fresh terminal artifacts. Previous remediation markers remain scoped to the dead generation and cannot block the resumed child.

Claude-backed sentinel behavior remains unchanged.

## Shared path helpers

A focused `sidecar-arbitration.ts` module owns:

- generation-specific exit and lease path construction;
- child publication leases;
- parent remediation acquisition;
- stale publisher fencing;
- bounded filesystem error conversion;
- lease metadata validation.

`cmux.ts`, `subagent-done.ts`, and `index.ts` consume these helpers rather than constructing terminal paths independently.

## Lease metadata

Each lease directory contains atomically published metadata:

```ts
interface SidecarLeaseMetadata {
  version: 1;
  kind: "publisher" | "remediation";
  runningChildId: string;
  token: string;
  acquiredAt: number;
}
```

Metadata is written to a same-directory temporary file and renamed into place. Invalid or partially readable metadata is treated as an arbitration problem, never as permission to publish or remediate immediately.

The random token fences stale owners. Child ID identifies the generation; token identifies one lease acquisition attempt within that generation.

## Child publication protocol

To publish a terminal payload, the child:

1. Atomically creates its generation lease directory.
2. Atomically writes publisher metadata with a fresh token.
3. Writes the exit payload to a same-directory temporary file.
4. Re-reads lease metadata immediately before final rename.
5. Renames the payload only when metadata still matches `kind`, child ID, and token.
6. Removes the temporary payload on lost ownership or error.
7. Removes its lease directory only when it still owns the same publisher token.

Outcomes are discriminated:

- `published`: final sidecar is authoritative.
- `blocked`: remediation already owns this generation.
- `lost`: publisher was fenced before rename.
- `error`: bounded filesystem detail accompanies the original failure.

All four Pi child terminal paths use this protocol: normal auto-exit, provider/agent error, `caller_ping`, and `subagent_done`.

## Parent remediation protocol

Remediation begins only after the existing health state classifies the same child generation `broken`.

The parent:

1. Reads the generation-specific final sidecar without consuming it. A valid sidecar defers to normal watcher completion.
2. Attempts to create the generation lease directory.
3. If it creates the directory, it atomically writes remediation metadata, rechecks the sidecar while holding ownership, then claims the in-memory terminal path.
4. If a publisher lease exists and is fresh, remediation defers.
5. If a publisher lease is stale and the child is still `broken`, the parent atomically renames the entire old lease directory to a unique fenced/tombstone path.
6. The parent creates a new lease directory and remediation marker with its own token.
7. It rechecks the final sidecar before claiming the in-memory terminal path.
8. It removes the fenced old directory best-effort after installing the remediation lease.

A publisher whose directory was renamed fails its mandatory metadata revalidation and cannot rename its temporary payload afterward.

The parent retains the remediation marker for that dead generation. No normal release or resume transfer is needed because no future child reuses that generation path.

## Stale recovery

A publisher lease may be reclaimed only when all conditions hold:

- metadata identifies the same child generation;
- lease age exceeds 30 seconds;
- the parent health snapshot for that exact child is currently `broken`;
- no valid final sidecar exists;
- atomic directory rename succeeds.

A missing or invalid metadata file is recoverable only after the lease directory itself is older than 30 seconds and the same child is `broken`. Fresh unreadable metadata always defers.

The 30-second lease threshold does not determine child health. It applies only after the independent 120-second heartbeat or three-probe broken gate has already fired.

## Watcher integration

`pollForExit()` receives `runningChildId` for Pi-backed runs and consumes only that generation’s sidecar. It never consumes another generation’s artifact or a generic session-level sidecar.

Normal completion removes the final generation sidecar after decoding, as today. Publisher leases should already be gone. Remediation markers may remain as small diagnostic artifacts beside the session.

## Resume behavior

`subagent_resume` creates a new child ID before command construction. It does not inspect, clear, replace, or reserve any prior generation’s lease. Command-delivery rollback therefore has no sidecar reservation to unwind.

The preserved JSONL session remains the transcript source; terminal ownership is independent.

## Filesystem errors

Arbitration helpers return discriminated error results rather than throwing into status intervals. Error messages collapse whitespace and are capped at 200 characters.

On parent arbitration error:

- no terminal claim occurs;
- the watcher, pane, map entry, and session remain intact;
- the error is recorded on the running state;
- at most one bounded status diagnostic is delivered for an unchanged error;
- later status ticks may retry.

Child publication preserves the original filesystem exception after cleaning only artifacts it owns. It never removes another token’s lease.

## Exactly-once ownership

Filesystem arbitration decides whether completion publication or remediation may proceed across processes. The existing in-memory terminal claim then decides which parent path may close, remove, and notify.

Both gates are required:

- filesystem token: child process versus parent remediation;
- in-memory claim: watcher versus remediation versus shutdown.

No asynchronous boundary occurs between a successful parent remediation lease, final sidecar recheck, and in-memory terminal claim.

## Testing

Implementation follows strict test-first development from the approved Task 4 baseline.

Tests must cover:

1. Generation-specific paths differ for two child IDs sharing one session.
2. A resumed generation is unaffected by an old remediation marker.
3. Child-first lease publishes and parent remediation defers.
4. Parent-first remediation blocks that same generation’s publisher.
5. A fenced publisher cannot rename after stale lease takeover.
6. Fresh publisher leases are never reclaimed.
7. Stale publisher and stale unmarked leases recover only when the same child is broken.
8. Publisher metadata and remediation markers use atomic rename.
9. Publisher token revalidation occurs immediately before payload rename.
10. Publication error/lost ownership cleans only owned temporary artifacts.
11. Parent filesystem errors remain bounded and do not escape the status timer.
12. `pollForExit()` consumes only its supplied child generation.
13. All four child terminal paths publish through the shared helper.
14. Spawn and resume command-delivery failures do not strand generation reservations.
15. Existing exactly-once, done-silence, interactive-preservation, shutdown, widget-failure, bounded-result, and identity-safe deletion tests remain green.

## Acceptance criteria

- Resumed children never transfer or clear prior terminal ownership.
- Old children cannot publish into a new generation’s completion path.
- A live publisher that loses a stale lease is fenced before final rename.
- A stale crashed publisher cannot block remediation indefinitely.
- A valid generation sidecar always wins before parent in-memory claim.
- Arbitration filesystem errors never escape the timer.
- Each autonomous broken run produces at most one terminal failure and never retries automatically.
- All unit and relevant integration tests pass.
