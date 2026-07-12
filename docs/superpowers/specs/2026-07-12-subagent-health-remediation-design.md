# Subagent health detection and remediation design

## Problem

The parent extension currently supervises Pi-backed children through event-driven activity snapshots and completion polling. This leaves several failure modes unresolved:

1. A syntactically valid activity snapshot can remain frozen forever. `active` and `waiting` snapshots intentionally do not age into `stalled`, so a hung child can continue to look healthy.
2. `pollForExit()` ignores pane-read failures indefinitely after checking for an exit sidecar. A destroyed pane without a sidecar therefore leaves a permanent watcher and widget entry.
3. Parent status supervision can report degraded health but cannot safely retire a confirmed-broken autonomous run.
4. Completion polling and future remediation could race, causing duplicate notifications, duplicate pane closes, or conflicting cleanup.
5. A launch failure after pane creation can leave an orphan pane because launch setup is not transactional.

The extension needs stronger evidence, explicit health states, and conservative remediation that preserves recoverable session data and never silently repeats work.

## Goals

- Detect frozen Pi-backed child runtimes even when their last activity snapshot remains valid.
- Detect destroyed or permanently unreadable multiplexer panes.
- Distinguish temporary telemetry degradation from confirmed breakage.
- Automatically clean up confirmed-broken autonomous runs.
- Preserve interactive/user-driven runs for manual inspection.
- Emit exactly one terminal result for each run under watcher/remediator races.
- Preserve the child session and provide actionable resume guidance.
- Prevent partially failed launches from orphaning newly created panes.

## Non-goals

- Automatically retry, resume, or relaunch failed work.
- Kill or clean up confirmed-broken interactive runs automatically.
- Add operating-system PID or process-tree supervision.
- Infer model progress from session-file growth or terminal text.
- Change existing normal completion, caller-ping, explicit interrupt, or result-summary semantics.
- Add user-configurable health thresholds in this change.

## Approaches considered

### 1. Heartbeat-backed health state machine — selected

The child periodically writes a heartbeat independently of model and tool events. The parent combines heartbeat freshness, activity validity, pane readability, and completion sidecars. This detects both frozen children and missing panes while retaining existing rich activity labels.

### 2. Pane-only detection

Repeated pane-read failures could be treated as terminal. This is smaller but cannot detect a hung Pi process whose pane remains readable.

### 3. PID/process-tree supervision

The launcher could capture and probe the child process tree. This offers direct process liveness but introduces shell- and backend-specific complexity, process-group semantics, PID reuse concerns, and more invasive launch changes. It is unnecessary when an extension heartbeat and pane probes provide sufficient evidence.

## Architecture

Health supervision remains split across three focused responsibilities:

1. `activity.ts` owns the child-written activity document and heartbeat recording.
2. `cmux.ts` owns completion polling and reports pane-probe observations without making remediation decisions.
3. `status.ts` owns pure health-state transitions and formatting. `index.ts` combines observations for each `RunningSubagent`, claims terminal ownership, performs cleanup, and delivers results.

No component infers completion from heartbeat loss. Completion sidecars and shell sentinels remain authoritative for successful or explicit terminal outcomes.

## Child heartbeat protocol

The version-1 activity document gains an optional finite `heartbeatAt` timestamp. It remains optional for compatibility with snapshots written by children started before a reload or package update. When absent, the parent uses `updatedAt` as the initial heartbeat reference.

The recorder gains a `heartbeat()` operation that:

- updates only `heartbeatAt`;
- writes atomically through the existing temporary-file/rename path;
- does not change `latestEvent`, `phase`, activity scope, event timestamps, or event sequence;
- follows the recorder's existing write-failure disabling policy.

The child extension starts one heartbeat interval after `session_start`, writes every 5 seconds, and clears the interval during `session_shutdown`. Explicit terminal paths (`subagent_done`, `caller_ping`, normal auto-exit completion, and provider/agent error completion) write their existing final activity/exit artifacts before shutdown. A completed child is never kept alive merely to write heartbeats.

The heartbeat timer is generation/session owned so `/reload`, session replacement, and shutdown cannot leave duplicate timers.

## Health observations and states

### Pane probe observations

Each `pollForExit()` iteration already attempts to read the pane after checking sidecars. It will report one observation to its caller:

- `readable` after a successful read;
- `unreadable` with a bounded error description after a failed read.

The `RunningSubagent` records the latest result, the first failure time, and the consecutive failure count. A successful probe resets the pane-failure streak. The status loop does not perform a second pane read, avoiding duplicate backend traffic.

### Heartbeat thresholds

Fixed internal thresholds are intentionally conservative:

- Heartbeat interval: 5 seconds.
- `stalled`: no fresh heartbeat for 60 seconds.
- `broken`: no fresh heartbeat for 120 seconds.

The heartbeat age is measured from `heartbeatAt`, falling back to `updatedAt`, and finally to the run start time when no valid snapshot has ever been observed.

A fresh heartbeat proves runtime liveness even when the latest semantic activity event remains unchanged during a long provider request, tool execution, or waiting period.

### Pane thresholds

A pane becomes confirmed missing after three consecutive unreadable probes. With the existing one-second polling interval, this tolerates transient backend failures while retiring a pane that has actually disappeared.

Before declaring a pane-based terminal failure, remediation checks the exit sidecar one final time. A valid sidecar always wins the race and proceeds through normal completion handling.

### Status kinds

Pi-backed runs expose these states:

- `starting`: no valid activity has arrived and neither broken threshold is met.
- `active`: heartbeat is fresh and semantic activity is active.
- `waiting`: heartbeat is fresh and semantic activity is waiting or done pending completion consumption.
- `stalled`: telemetry is missing, invalid, wrong-child, or older than 60 seconds, but breakage is not yet confirmed.
- `broken`: heartbeat is at least 120 seconds old or the pane has failed three consecutive probes, with no authoritative exit artifact.

Claude-backed runs retain the existing `running` fallback because they do not load the Pi child extension and therefore cannot provide this heartbeat.

Recovery from `stalled` or `broken` to a healthy state is allowed if fresh evidence arrives before remediation claims the run. Interactive runs can therefore visibly recover without being recreated.

## Terminal ownership and race prevention

Each `RunningSubagent` gains an in-memory terminal-claim field. Exactly one path may atomically claim it:

- the completion watcher after `pollForExit()` returns;
- health remediation after confirming breakage;
- shutdown/cancellation cleanup where applicable.

The winner owns terminal notification and cleanup. Later paths observe the claim and return without sending a second result or closing the pane again.

The running-map removal remains identity-safe: cleanup deletes an entry only when the map still contains the same `RunningSubagent` object. This preserves the existing generation protections during reload and delayed shutdown.

## Autonomous remediation

When a non-interactive/autonomous run reaches `broken`, the parent performs this sequence:

1. Re-read and decode the exit sidecar. If present, defer to normal completion.
2. Attempt to claim terminal ownership. Stop if another path already owns it.
3. Capture bounded diagnostics:
   - health reason (`heartbeat stale` or `pane unavailable`);
   - heartbeat age and last semantic activity;
   - latest activity read/validation error;
   - latest pane-probe error;
   - a bounded pane tail when the pane remains readable.
4. Abort the background completion watcher.
5. Close the pane best-effort.
6. Remove the exact running entry and refresh the widget.
7. Send one `subagent_result` failure notification containing:
   - the display name and elapsed time;
   - the confirmed health reason;
   - bounded diagnostics;
   - the preserved session path;
   - explicit `subagent_resume` guidance.

The notification is a failure, not a completion. It must not imply that the assigned task succeeded. Remediation never automatically retries, resumes, or relaunches the task.

## Interactive run behavior

Interactive/user-driven runs use the same heartbeat, pane probes, and health classification. When confirmed broken they:

- display `broken` in the widget with a concise reason;
- retain their pane, watcher, running-map entry, and session;
- do not wake the parent with stalled, recovered, or broken steer messages;
- are not automatically closed or removed.

This preserves the existing principle that interactive subagent status should not consume orchestrator turns or destroy a pane the user may be inspecting.

## Transactional launch cleanup

`launchSubagent()` tracks whether it created the pane or received a pre-created pane from a parallel-launch coordinator.

If any subsequent setup or command-delivery step throws:

- a pane created by `launchSubagent()` is closed best-effort;
- no `RunningSubagent` is inserted into the running map;
- generated files may remain as bounded diagnostic artifacts;
- the original launch error is rethrown.

A pre-created pane is not closed by the inner launcher because its caller owns cleanup across the parallel launch transaction. Existing parallel-launch cleanup remains responsible for those panes.

## User-visible formatting

The widget adds a `broken` label distinct from `stalled`. A concise reason may be appended:

- `broken · heartbeat 2m`
- `broken · pane unavailable`

Transition/result text remains bounded by the existing status and delivered-result limits. Internal paths, raw activity JSON, and unbounded terminal output are not included in status transition messages.

Autonomous `broken` transitions do not emit a separate status steer followed by a result steer. Remediation emits only the terminal failure result. This avoids duplicate orchestrator turns.

## Error handling

- Heartbeat write failures follow the existing three-failure disable behavior; the parent eventually observes stale telemetry and diagnoses it rather than crashing the child.
- Pane-read errors are stored as bounded diagnostics and require three consecutive failures.
- Sidecar parse/read races remain retriable until breakage confirmation; the final remediation check prevents cleanup from beating a valid exit.
- Pane close failures do not prevent map cleanup or failure delivery.
- Session files and launch artifacts are never deleted by remediation.
- Abort errors produced after remediation are suppressed by terminal ownership and do not become duplicate cancellation results.

## Testing strategy

Implementation follows test-driven development.

### Pure status tests

- Fresh heartbeats preserve `active` and `waiting` regardless of semantic event age.
- A heartbeat older than 60 seconds becomes `stalled`.
- A heartbeat older than 120 seconds becomes `broken`.
- A fresh heartbeat recovers `stalled` and unclaimed `broken` states.
- Three consecutive pane failures become `broken`; a successful probe resets the streak.
- Status and widget formatting distinguish and bound `broken` reasons.

### Recorder tests

- `heartbeat()` updates `heartbeatAt` without changing semantic activity fields or sequence.
- Heartbeats use atomic writes and remain parseable.
- Heartbeat timers start once and stop on shutdown/reload.
- Existing write-failure disabling behavior still applies.

### Polling and remediation tests

- `pollForExit()` reports readable and unreadable pane probes.
- Transient pane failures recover without remediation.
- A late exit sidecar wins before pane-based remediation.
- Autonomous remediation claims once, aborts once, closes once, removes once, and sends exactly one failure result.
- A completion watcher that loses the claim sends nothing.
- Interactive broken runs remain registered and are not closed or notified.
- Preserved session paths and resume guidance appear in terminal failure output.

### Launch tests

- A failure after locally creating a pane closes that pane and leaves no running entry.
- A failure using a caller-owned pre-created pane does not close it in the inner launcher.
- Successful launch behavior is unchanged.

### Regression and integration verification

Run the unit suite and focused lifecycle integration tests. Existing normal completion, sidecar errors, caller pings, explicit interrupts, auto-exit, reload ownership, result bounding, and supported multiplexer behavior must remain green.

## Acceptance criteria

- A healthy long-running child with fresh heartbeats is never marked stale solely because its semantic activity event is old.
- A Pi child with no heartbeat for 60 seconds displays `stalled`; at 120 seconds it becomes `broken`.
- A pane unreadable for three consecutive polls becomes `broken` unless an exit sidecar appears.
- Confirmed-broken autonomous runs are cleaned up and produce exactly one actionable failure result without automatic retry.
- Confirmed-broken interactive runs remain intact and silent except for their widget label.
- Completion/remediation races cannot double-notify or double-close.
- Failed non-parallel launches do not leave orphan panes or phantom running entries.
- All relevant unit and integration tests pass.
