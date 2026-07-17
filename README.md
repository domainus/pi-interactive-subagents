# pi-interactive-subagents

Policy-constrained dynamic DAG workflows for [pi](https://github.com/badlogic/pi-mono). The package keeps `pi-interactive-subagents` as its repository and package identity while making host-owned workflow planning, execution, recovery, and evidence-bound approval the canonical interface.

## Install and update

```bash
pi install git:github.com/domainus/pi-interactive-subagents
pi update --extension git:github.com/domainus/pi-interactive-subagents
```

## Architecture

A workflow is a strict, versioned JSON data graph. The trusted host selects a fixed policy template, validates and bounds generated task data, compiles a deterministic DAG, and launches each node with a signed host-policy artifact. Generated data is restricted to `objective` plus `nodes`; each node may contain only `id`, `objective`, `expertise`, canonical sorted `dependsOn`, and `input`. It cannot choose models, tools, paths, gates, worktrees, approvals, retries, or limits. Capability intersection, canonical path guards, bounded payloads, and deterministic host gates enforce that boundary. Workflow children disable extension discovery and load only the package's trusted bootstrap, which verifies active built-in tool provenance before the first model turn.

The host templates are immutable ceilings:

| Template | Policy | Exact model | Bounds |
| --- | --- | --- | --- |
| `research` | read/search only (`read`, `grep`, `find`, `ls`) | Luna, medium | 64 nodes, concurrency 4, one retry |
| `build` | isolated read/edit/write; no shell; `package-lock.json` denied | Luna, medium | 64 nodes, concurrency 1, two retries |
| `review` | read/search validation only | Sol, high | 64 nodes, concurrency 2, one retry |

Models are exact authenticated `openai-codex/gpt-5.6-luna` and `openai-codex/gpt-5.6-sol`; workflow execution never falls back to Terra or another provider. The hidden migration alias `claude-code` is OpenAI-backed, while the separate generic external Claude CLI path remains only for legacy custom profiles. Neither is part of the canonical workflow architecture.

Unit tests use deterministic launchers. Host-injected web research and provider telemetry are bounded, provenance-recorded seams: HTTPS research requires a transport with DNS/peer-IP verification and rejects private/local destinations and credentials, while telemetry-required execution fails closed when trusted provider data is unavailable. Usage-limit pause restoration is host-coordinated and idempotent; without an injected usage coordinator, workflows remain paused until an explicit manual resume (there is no claimed automatic quota API). Host-owned immutable recipes support adversarial review, completeness checking, and deterministic candidate selection; adaptive expansion manifests are bounded, digest-bound, and recovery-validated. Revised plans use fresh run identities and may import only provenance-bound unchanged read-only task results after exact parent workflow/run/integrity/topology verification; worktrees, approvals, mutating results, and any unbound or changed result are never reused. Optional mux integration tests require locally configured model access and have separate environment/time constraints; this release does not claim real-model end-to-end coverage as completed.

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

The strict host tools are:

| Tool | Purpose |
| --- | --- |
| `workflow_plan` | Validate JSON and persist a host-compiled plan |
| `workflow_run` | Start a detached run without an interaction prompt |
| `workflow_status` | Read durable run metadata and bounded aggregate node-state counts |
| `workflow_cancel` | Request cancellation and persist the outcome |
| `workflow_resume` | Reload a persisted run after interruption/restart |
| `workflow_approve` | Preview evidence and issue a host-signed, one-use approval token |
| `workflow_apply` | Preview and explicitly confirm applying that token to the parent |
| `workflow_history` / `workflow_detail` | Bounded metadata-only history/detail (counts, digests, timings, gates, pause, telemetry) |
| `workflow_revise` / `workflow_rerun` | Create a distinct immutable linked workflow/run identity; revisions may import only provenance-bound unchanged read-only results, never mutating results, worktrees, or approvals |
| `workflow_expand` / `workflow_web_research` | Host-owned expansion manifests and HTTPS research; fail closed without trusted transport |

The host operation sequence and exact argument shapes are:

```typescript
workflow_plan({ workflowId: "build-auth", template: "build", generated: { objective: "Update auth", nodes: [{ id: "implement", objective: "Implement the approved change" }] } });
workflow_run({ workflowId: "build-auth" });
workflow_status({ workflowId: "build-auth" });
// After successful completion, use the persisted mutating node attempt shown by the run artifacts:
workflow_approve({ workflowId: "build-auth", nodeId: "implement", attempt: 1 });
workflow_apply({ workflowId: "build-auth", nodeId: "implement", token: "<64-hex token returned by workflow_approve>" });
```

`workflow_cancel` and `workflow_resume` each take `{ workflowId }`. Plan, run, resume, and approval issuance use the trusted global workflow UI as standing authorization and do not open interaction prompts. Final apply alone opens an explicit confirmation prompt.

Matching slash commands are `/workflow-plan`, `/workflow-run`, `/workflow-status`, `/workflow-history`, `/workflow-detail`, `/workflow-cancel`, `/workflow-resume`, `/workflow-approve`, and `/workflow-apply`. History/detail never expose prompts, raw output, diffs, tokens, or secrets. `/workflow-plan` accepts the full JSON object, run/status/cancel/resume accept a workflow ID, and approve/apply accept their JSON argument objects. Runs are detached from the chat turn: completion is delivered as a terminal `workflow_result` message and durable state remains available through status/reload. Every mutating node receives host-generated result-schema, dependency-success, and diff-scope gates bound to its exact attempt evidence. Approval tokens are HMAC-authenticated, evidence/gate/path scoped, time bounded, and consumed by apply. There is no automatic apply, commit, worktree cleanup, or retry beyond the configured bounds. The trusted global workflow UI provides standing authorization for plan/run/resume and approval issuance; the operator explicitly confirms final apply only.

Workflow artifacts live under `<sessionDir>/artifacts/<session-id>/workflow/<workflow-id>/`. Build worktrees are external and durable. Set absolute `PI_WORKFLOW_WORKTREE_ROOT` to choose a trusted host root; otherwise hashed worktrees live beneath `~/.pi/agent/workflow-worktrees`. Set `PI_WORKFLOW_APPROVAL_SECRET` to provide a stable secret of at least 32 bytes; otherwise a private `0600` key is created beneath `~/.pi/agent/workflow-secrets/`. Worktree status and diffs are bounded sidecar artifacts, while workflow state stores evidence digests and provenance. Explicit resume reloads verified metadata, state, gates, artifacts, and approval journals; ambiguous, stale, corrupt, or forged records fail closed and require operator action. Coordination and workflow-storage lock files are never automatically reclaimed: if a lock remains after an owner is verified stopped, an operator must remove it after independent verification.

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

Run Pi inside the mux, or set `PI_SUBAGENT_MUX=herdr|cmux|tmux|zellij|wezterm` to force a backend. Slow shell startup can be accommodated with `PI_SUBAGENT_SHELL_READY_DELAY_MS` (default `500`). Active detached workflows use the legacy bordered widget language (one row per workflow, refreshed from persisted state); the workflow widget remains separate from the legacy subagent activity widget and bounded in narrow terminals. Completion is rendered as a boxed `workflow_result`; status tools/commands use semantic tool cards and notifications, while the boxed `workflow_status` renderer is retained for existing transcript records rather than emitted for every status query.

## Development

```bash
npm test
npm run test:integration # run inside a supported mux
```

Unit tests validate policy, lifecycle, storage, worktree, approval, and presentation behavior with deterministic launchers. Optional integration tests exercise real Pi subprocess/mux lifecycle behavior and may require authenticated `PI_TEST_MODEL` access; report skipped or timed-out real-model coverage honestly. Before release, run `git diff --check` and verify protected files such as `package-lock.json` and `LICENSE` are unchanged unless separately requested.

## Acknowledgements and license

This fork preserves HazAT's MIT copyright and package-author attribution. Sub-agent status supervision and turn-only interruption were inspired by [RepoPrompt](https://repoprompt.com/)'s snapshot polling and cancellation features. See [LICENSE](LICENSE).
