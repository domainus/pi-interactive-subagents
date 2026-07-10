# Auto-exit completion sidecar design

## Problem

A normally completed auto-exit Pi subagent does not write its `.exit` sidecar. The parent watcher therefore depends on repeatedly reading the original multiplexer surface until it sees the shell sentinel. Herdr pane identifiers may change after nested panes close, so a watcher can retain a stale identifier and never report a completed child.

## Design

Normal auto-exit completion will use the same sidecar-first protocol already used by explicit `subagent_done`, caller pings, and provider errors. Before requesting graceful shutdown, the child extension will write one sidecar payload:

- `{ "type": "done" }` after a normal assistant completion.
- The existing error payload with `type`, `errorMessage`, and `stopReason` fields after an assistant error.
- No sidecar after an aborted turn, because the child remains open.

A small pure helper will derive the payload from the latest assistant message. The `agent_end` handler will persist that payload before `ctx.shutdown()`. Existing terminal-sentinel polling remains as crash fallback, but ordinary completion no longer depends on a stable pane identifier.

## Alternatives rejected

1. Re-resolve Herdr pane identifiers on every poll: backend-specific and requires maintaining an additional stable terminal identity mapping.
2. Disable nested subagents: avoids one trigger but leaves completion fragile whenever any backend surface disappears or changes identity.

## Testing

1. Unit tests prove normal completion produces a `done` payload, errors preserve their detailed error payload, and aborted turns produce no auto-exit payload.
2. Existing sidecar decoding and completion tests remain green.
3. The Herdr integration harness recognizes Herdr as an available lifecycle backend so the normal spawn/completion path can be exercised there.
4. Run unit tests, TypeScript/runtime test suite, and a focused real Herdr lifecycle test before commit and push.

## Scope

Only subagent completion signaling and the Herdr integration-test path change. Multiplexer pane creation, layout, explicit interrupt behavior, and result rendering remain unchanged.
