# Dynamic Subagent Reasoning Effort Design

**Date:** 2026-07-11
**Status:** Approved design

## Goal

Allow the orchestrating agent to choose a Pi-backed subagent's reasoning effort independently for each spawn or resume operation, while preserving agent frontmatter and persisted-session defaults when no per-call override is supplied.

## Scope

The feature applies to the `subagent` and `subagent_resume` tools provided by the interactive-subagents extension. It supports Pi's complete reasoning-level set:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`
- `max`

The implementation targets the installed Pi 0.80.6 CLI. Pi remains responsible for clamping a valid requested level to the selected model's capabilities.

Claude-backed custom agents are outside the reasoning-level mapping scope. If a caller explicitly supplies `thinking` for a Claude-backed launch, the extension must return a clear unsupported-option error rather than silently discarding the request.

## Public Interface

### New subagent parameter

Add an optional `thinking` property to `SubagentParams`:

```typescript
thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
```

Its description must state that it overrides the selected agent definition's frontmatter value for that invocation.

### New subagent_resume parameter

Add the same optional `thinking` property to `subagent_resume`.

When omitted, resume must not pass any reasoning override. Pi will therefore restore the level persisted in the resumed session. When supplied, the explicit level overrides persisted session state for the resumed process.

### Agent frontmatter

Retain the existing `thinking` frontmatter field, but recognize only the seven supported values. Invalid frontmatter must not be passed to the Pi CLI as an arbitrary model suffix or flag. A launch using invalid configured frontmatter should fail clearly before creating or commanding a multiplexer surface.

## Resolution Rules

For a new Pi-backed subagent, resolve reasoning effort in this order:

1. Explicit `thinking` tool argument.
2. Valid `thinking` value from the selected agent definition.
3. No extension-provided override; Pi uses inherited session metadata or its configured default.

For a resumed Pi-backed subagent:

1. Explicit `thinking` tool argument.
2. No extension-provided override; Pi restores the persisted session level.

A tool argument must never mutate the agent definition or establish a global default. It affects only that invocation.

## Command Construction

Use Pi's dedicated CLI form:

```text
pi --thinking <level>
```

Do not encode the new per-call selection exclusively as `--model model:level`. A dedicated flag works even when no model override is present and keeps model and effort selection independent.

For compatibility, existing model selection remains unchanged except that reasoning effort should no longer need to be appended to the model string. Both new and resumed Pi commands add `--thinking` only when an effective explicit/frontmatter value exists.

Backend-specific code in `cmux.ts` must remain unchanged. Herdr, tmux, cmux, WezTerm, and Zellij all receive the same generated launch script, so effort selection belongs in shared command construction.

## Internal Structure

Introduce a narrow reasoning-level type and reusable helpers that:

- define the canonical seven-value set;
- validate parsed frontmatter;
- resolve tool-call versus frontmatter precedence;
- append `--thinking` arguments to Pi command arrays only when appropriate.

Keep helpers independent of multiplexer side effects so unit tests can verify behavior without creating panes. Avoid broad command-construction refactoring unrelated to this feature.

## Errors and Compatibility

- Tool schemas reject values outside the canonical set before execution.
- Invalid frontmatter produces a bounded, actionable error identifying the agent and bad value.
- Explicit reasoning on a Claude-backed agent produces an unsupported-option error before surface creation.
- Pi may clamp `xhigh` or `max` for models with lower capabilities; this is expected and documented.
- The repository's older development dependency does not advertise `max`, but the deployed Pi 0.80.6 CLI does. Tests should verify generated arguments rather than depending on the old package's CLI parser.
- Existing uncommitted Ctrl+J/widget changes in `README.md`, `pi-extension/subagents/subagent-done.ts`, and `test/test.ts` must be preserved and not overwritten.

## Documentation

Update `README.md` to cover:

- `thinking` in the `subagent` parameter list;
- `thinking` in the `subagent_resume` parameter list;
- all seven accepted values in the frontmatter reference;
- spawn and resume precedence;
- model-capability clamping;
- Pi-only behavior and Claude-backed rejection.

Edits must be integrated with the already-uncommitted README widget changes.

## Testing

Follow test-driven development. Add failing tests before implementation for:

1. The `subagent` schema exposing exactly the seven accepted levels.
2. The `subagent_resume` schema exposing the same levels.
3. Explicit spawn `thinking` overriding frontmatter.
4. Valid frontmatter serving as spawn fallback.
5. No argument and no frontmatter emitting no `--thinking` flag.
6. Generated new-session Pi commands containing `--thinking <level>` when resolved.
7. Generated resume commands containing an explicit override.
8. Resume without an override emitting no flag, preserving persisted state.
9. Invalid frontmatter failing before multiplexer surface creation.
10. Explicit `thinking` on a Claude-backed agent failing before surface creation.
11. Shell escaping and existing launch behavior remaining intact.

Run the focused tests, the complete unit suite, and integration tests where they do not require an unavailable live multiplexer. Run a TypeScript/syntax check supported by the repository or installed Pi runtime.

## Acceptance Criteria

- Callers can choose any supported reasoning level independently on each `subagent` or `subagent_resume` call.
- Per-call spawn selection overrides agent frontmatter.
- Omitted spawn selection preserves valid frontmatter fallback.
- Omitted resume selection preserves persisted session behavior.
- Invalid or unsupported combinations fail explicitly and before pane creation.
- All existing and new tests pass.
- Documentation accurately describes the public behavior.
- Existing unrelated working-tree changes remain intact.
