# pi-interactive-subagents

Policy-constrained dynamic DAG workflows for [pi](https://github.com/badlogic/pi-mono). The package keeps `pi-interactive-subagents` as its repository and package identity while making host-owned workflow planning, execution, recovery, and evidence-bound approval the canonical interface.

## Install and update

```bash
pi install git:github.com/domainus/pi-interactive-subagents
pi update --extension git:github.com/domainus/pi-interactive-subagents
```

## Architecture

A workflow is a strict, versioned JSON data graph. The trusted host selects a fixed policy template, validates and bounds generated task data, compiles a deterministic DAG, and launches each node with a signed host-policy artifact. Generated data can describe objectives, IDs, dependencies, expertise, and input only; it cannot choose models, tools, paths, gates, worktrees, approvals, retries, or limits. Capability intersection, canonical path guards, bounded payloads, and deterministic host gates enforce that boundary. Workflow children disable extension discovery and load only the package's trusted bootstrap, which verifies active built-in tool provenance before the first model turn.

The host templates are immutable ceilings:

| Template | Policy | Exact model | Bounds |
| --- | --- | --- | --- |
| `research` | read/search only (`read`, `grep`, `find`, `ls`) | Luna, medium | 64 nodes, concurrency 4, one retry |
| `build` | isolated read/edit/write; no shell; `package-lock.json` denied | Luna, medium | 64 nodes, concurrency 1, two retries |
| `review` | read/search validation only | Sol, high | 64 nodes, concurrency 2, one retry |

Models are exact authenticated `openai-codex/gpt-5.6-luna` and `openai-codex/gpt-5.6-sol`; workflow execution never falls back to Terra or another provider. The hidden migration alias `claude-code` is OpenAI-backed, while the separate generic external Claude CLI path remains only for legacy custom profiles. Neither is part of the canonical workflow architecture.

Unit tests use deterministic launchers. Optional mux integration tests require locally configured model access and have separate environment/time constraints; this release does not claim real-model end-to-end coverage as completed.

## Quick start: strict workflow JSON

Plan a workflow by passing a bounded object to `workflow_plan` (or `/workflow-plan`):

```json
{
  "workflowId": "research-release-notes",
  "template": "research",
  "generated": {
    "objective": "Summarize the release changes",
    "nodes": [
      {"id":"inspect","objective":"Read the changelog","dependsOn":[]},
      {"id":"summarize","objective":"Produce a concise summary","dependsOn":["inspect"]}
    ]
  }
}
```

generated data is task data only. The host supplies the fixed policy, capabilities, model, thinking ceiling, gates, bounds, and paths. IDs, graph depth, node count, concurrency, retries, runtime, and serialized data are bounded; invalid or cyclic graphs fail closed.

## Workflow operations

The seven strict host tools are:

| Tool | Purpose |
| --- | --- |
| `workflow_plan` | Validate JSON and persist a host-compiled plan |
| `workflow_run` | Start a detached run; mutating builds require confirmation |
| `workflow_status` | Read durable run metadata and bounded aggregate node-state counts |
| `workflow_cancel` | Request cancellation and persist the outcome |
| `workflow_resume` | Reload a persisted run after interruption/restart |
| `workflow_approve` | Preview evidence and issue a host-signed, one-use approval token |
| `workflow_apply` | Preview and explicitly confirm applying that token to the parent |

The host operation sequence and exact argument shapes are:

```typescript
workflow_plan({ workflowId: "build-auth", template: "build", generated: { objective: "Update auth", nodes: [{ id: "implement", objective: "Implement the approved change" }] } });
workflow_run({ workflowId: "build-auth" });
workflow_status({ workflowId: "build-auth" });
// After successful completion, use the persisted mutating node attempt shown by the run artifacts:
workflow_approve({ workflowId: "build-auth", nodeId: "implement", attempt: 1 });
workflow_apply({ workflowId: "build-auth", nodeId: "implement", token: "<64-hex token returned by workflow_approve>" });
```

`workflow_cancel` and `workflow_resume` each take `{ workflowId }`. Build plan/run/resume, approval issuance, and apply open explicit confirmation prompts.

Matching slash commands are `/workflow-plan`, `/workflow-run`, `/workflow-status`, `/workflow-cancel`, `/workflow-resume`, `/workflow-approve`, and `/workflow-apply`. `/workflow-plan` accepts the full JSON object, run/status/cancel/resume accept a workflow ID, and approve/apply accept their JSON argument objects. Runs are detached from the chat turn: completion is delivered as a terminal `workflow_result` message and durable state remains available through status/reload. Every mutating node receives host-generated result-schema, dependency-success, and diff-scope gates bound to its exact attempt evidence. Approval tokens are HMAC-authenticated, evidence/gate/path scoped, time bounded, and consumed by apply. There is no automatic apply, commit, worktree cleanup, or retry beyond the configured bounds. The operator explicitly confirms planning/running/resuming mutating builds, approval issuance, and apply.

Workflow artifacts live under `<sessionDir>/artifacts/<session-id>/workflow/<workflow-id>/`. Build worktrees are external and durable. Set absolute `PI_WORKFLOW_WORKTREE_ROOT` to choose a trusted host root; otherwise hashed worktrees live beneath `~/.pi/agent/workflow-worktrees`. Set `PI_WORKFLOW_APPROVAL_SECRET` to provide a stable secret of at least 32 bytes; otherwise a private `0600` key is created beneath `~/.pi/agent/workflow-secrets/`. Worktree status and diffs are bounded sidecar artifacts, while workflow state stores evidence digests and provenance. Explicit resume reloads verified metadata, state, gates, artifacts, and approval journals; ambiguous, stale, corrupt, or forged records fail closed and require operator action.

## Legacy compatibility adapters

The older `subagent`, `subagent_interrupt`, `subagents_list`, and `subagent_resume` tools, plus `/plan`, `/iterate`, and `/subagent`, remain documented compatibility adapters for static bundled-agent sessions. They are not the canonical workflow API. The mux launch/config/status/session facilities remain useful for those adapters and for local development; supported muxes include Herdr, cmux, tmux, zellij, and WezTerm.

Bundled compatibility agents remain discoverable through project, global, then package paths. The literary workflow is still **translator → translator-reviewer → editor**: translator (GPT-5.6 Sol with high thinking, deep tier) writes the English translation, translator-reviewer is read-only and reports fidelity issues, and editor applies publication-quality corrections. These roles are independently invokable, caller-controlled, and do not automatically chain.

| Agent | Default |
| --- | --- |
| planner | `openai-codex/gpt-5.6-luna` |
| scout | `openai-codex/gpt-5.6-luna` |
| worker | `openai-codex/gpt-5.6-sol` |
| reviewer | `openai-codex/gpt-5.6-sol` |
| visual-tester | `openai-codex/gpt-5.6-luna` |
| translator / translator-reviewer / editor | `openai-codex/gpt-5.6-sol` |

The external Claude CLI path is retained for legacy custom profiles. The hidden `claude-code` name is a deprecated compatibility alias for the OpenAI-backed Pi flow; it does not invoke Claude.

## Runtime requirements

- Pi coding agent `>=0.65.0`
- Node.js 22+
- A supported multiplexer: Herdr, cmux, tmux, zellij, or WezTerm

Run Pi inside the mux, or set `PI_SUBAGENT_MUX=herdr|cmux|tmux|zellij|wezterm` to force a backend. Slow shell startup can be accommodated with `PI_SUBAGENT_SHELL_READY_DELAY_MS` (default `500`). The workflow widget is separate from the legacy subagent activity widget and remains bounded in narrow terminals.

## Development

```bash
npm test
npm run test:integration # run inside a supported mux
```

Unit tests validate policy, lifecycle, storage, worktree, approval, and presentation behavior with deterministic launchers. Optional integration tests exercise real Pi subprocess/mux lifecycle behavior and may require authenticated `PI_TEST_MODEL` access; report skipped or timed-out real-model coverage honestly. Before release, run `git diff --check` and verify protected files such as `package-lock.json` and `LICENSE` are unchanged unless separately requested.

## Acknowledgements and license

This fork preserves HazAT's MIT copyright and package-author attribution. Sub-agent status supervision and turn-only interruption were inspired by [RepoPrompt](https://repoprompt.com/)'s snapshot polling and cancellation features. See [LICENSE](LICENSE).
