# Configured model fallback design

## Problem

Bundled and user-defined subagents may name a preferred model whose provider has no configured API key or OAuth subscription. The extension currently passes that model directly to the child CLI, allowing avoidable startup failures. Bare subagents may omit a model and rely on opaque child-side selection, so the parent cannot disclose what will actually run.

The extension should use only models Pi already considers authenticated, preserve explicit user intent, and choose a deterministic role-appropriate fallback for unavailable agent defaults.

## Goals

- Use Pi's model/auth registry as the only authority for configured availability.
- Recognize API-key, OAuth/subscription, environment, custom-model, and dynamically registered provider authentication through Pi's existing APIs.
- Preserve an authenticated preferred model unchanged.
- Select a deterministic configured fallback when an agent definition's preferred model is unavailable.
- Select a configured model for bare Pi-backed spawns that omit both agent and model.
- Prefer OAuth/subscription-backed candidates before metered API-key candidates.
- Rank candidates by agent role/tier.
- Reject unavailable explicit tool-call model overrides before pane creation.
- Disclose requested, preferred, effective, fallback, and auth-type information without exposing secrets.
- Annotate `subagents_list` with effective model availability/fallback information.

## Non-goals

- Probe provider networks or validate current quota/rate-limit state.
- Read or parse `auth.json`, OAuth tokens, API key values, or provider-specific credential files directly.
- Guarantee credentials remain valid after launch; providers can still revoke or expire access.
- Automatically replace an explicit unavailable `model:` override.
- Implement custom user-authored fallback ordering in this change.
- Change model restoration for `subagent_resume`; Pi's native session restore already resolves unavailable saved models against configured auth.
- Infer or validate authentication for external `cli: claude` agents, whose CLI owns its separate login state.

## Authentication authority

For Pi-backed launches the extension uses `ctx.modelRegistry`:

- `getAvailable()` returns models with configured auth without refreshing OAuth tokens.
- `find(provider, modelId)` resolves preferred and explicit references.
- `hasConfiguredAuth(model)` validates one model.
- `isUsingOAuth(model)` classifies subscription/OAuth versus API-key authentication.

No credential value is read or rendered. Dynamic/custom providers participate automatically because they are already registered in the current `ModelRegistry`.

The resolver works from a snapshot of `getAvailable()` taken for the tool invocation. Selection does not make a network request.

## Model references

Model references use the existing `provider/model-id` syntax and split on the first slash. Missing provider, missing model ID, unknown model, and known-but-unconfigured model are distinct diagnostics internally but share bounded, secret-free user output.

## Agent model tier

Agent frontmatter gains an optional:

```yaml
model-tier: fast | balanced | deep
```

Bundled defaults:

- `scout`: `fast`
- `visual-tester`: `fast`
- `planner`: `balanced`
- `worker`: `balanced`
- `reviewer`: `deep`
- `chatgpt-code` and hidden `claude-code` compatibility alias: `deep`

Custom agents without a tier default to `balanced`. Invalid tier values fail agent-definition validation before pane creation rather than silently changing selection.

Tier describes workload need, not a provider or exact model.

## Candidate capability tier

The resolver assigns each candidate a deterministic capability tier using model ID/name hints, then metadata fallback:

- Fast hints: `luna`, `haiku`, `flash`, `mini`, `nano`, `small`.
- Deep hints: `sol`, `opus`, `pro`, `reasoning`, `o1`, `o3`, `r1`.
- Balanced hints: `terra`, `sonnet`, `medium`, `balanced`.
- Unknown reasoning models default to `balanced`.
- Unknown non-reasoning models default to `fast`.

Hint matching is case-insensitive against provider, ID, and display name. Exact tier matches outrank adjacent tiers. For a deep role, a balanced reasoning model outranks a fast model. For a fast role, balanced outranks deep when no fast model exists. For balanced, fast and deep are equally adjacent and metadata tie-breakers decide.

This table is intentionally small and pure; unknown future models still receive a metadata-based tier.

## Deterministic ranking

Candidates are sorted by these keys in order:

1. Auth class: OAuth/subscription before API-key.
2. Role-tier distance.
3. Reasoning suitability:
   - deep requires/prefer reasoning;
   - balanced prefers reasoning;
   - fast does not require reasoning.
4. Preferred provider match, when an unavailable agent default supplied a provider.
5. Tier metadata:
   - fast: lower total declared input/output cost, then smaller output/context capacity;
   - balanced: reasoning first, then larger output capacity and context;
   - deep: reasoning first, then larger context and output capacity.
6. Stable lexical `provider/model-id` ordering.

The comparator never depends on registry iteration order.

OAuth priority is binding even when an API-key candidate has a closer role tier, because the user explicitly prefers already-configured subscription access before metered APIs.

## Resolution policy

### Explicit tool-call model

When `params.model` is present:

1. Resolve it in the registry.
2. Confirm it appears in the authenticated candidate set.
3. If available, use it exactly; no fallback.
4. If unavailable, return an error before `createSurface()` with up to three configured alternatives ranked for the role.

The error states whether the model is unknown or not authenticated, but never includes credential details.

### Agent default model

When agent frontmatter supplies `model`:

1. Use it unchanged if authenticated.
2. Otherwise select the highest-ranked configured candidate.
3. Record/disclose the preferred model and fallback reason.

### No preferred model

For a bare Pi-backed spawn with no explicit/default model, choose the highest-ranked configured candidate for the resolved tier. This makes the child command deterministic and inspectable.

### No configured model

Return before pane creation:

```text
No authenticated Pi models are configured. Use /login or configure a provider API key, then retry.
```

No pane, task artifact, activity file, or running-map entry is created.

### External Claude CLI

An agent with `cli: claude` bypasses Pi `ModelRegistry` fallback because its login and model namespace are external. Existing behavior remains unchanged and listing labels it `external auth` rather than `configured`.

## Resolution result

A pure resolver returns:

```ts
interface ResolvedLaunchModel {
  requestedModel?: string;
  preferredModel?: string;
  effectiveModel: string;
  authType: "oauth" | "api-key";
  tier: "fast" | "balanced" | "deep";
  source: "explicit" | "preferred" | "fallback" | "automatic";
  fallbackReason?: "preferred-unknown" | "preferred-unconfigured";
}
```

Errors are discriminated and include bounded ranked alternatives, never secrets.

## Launch integration

Model resolution occurs after basic mux/session prerequisites but before `launchSubagent()` creates a pane or writes artifacts. `launchSubagent()` receives the resolved result and uses `effectiveModel` for `--model`.

Thinking resolution remains independent. Existing thinking compatibility validation happens before pane creation. If the selected model does not support reasoning, Pi clamps thinking as it already does; this change does not invent model-specific thinking rules.

Launch acknowledgement/details include:

- requested or preferred model when present;
- effective model;
- auth type;
- tier;
- whether fallback occurred and why.

Fallback text is concise, for example:

```text
Reviewer launched with openai-codex/gpt-5.6-terra (configured OAuth fallback; preferred anthropic/claude-opus was unavailable).
```

Normal no-fallback acknowledgements remain compact.

## Agent listing

`subagents_list` accepts its execution context and resolves models against the same registry snapshot. Each visible Pi-backed definition reports:

- preferred model;
- effective authenticated model;
- auth type;
- tier;
- fallback status/reason.

Definitions are not hidden merely because their preferred model is unavailable; the user chose fallback behavior. External CLI agents are labeled separately. If no configured Pi model exists, definitions remain listed with `unavailable: no authenticated Pi models`.

## Security and privacy

- Never render keys, tokens, auth file paths, raw auth errors, headers, environment values, or command-based key resolvers.
- `getAvailable()`, `hasConfiguredAuth()`, and `isUsingOAuth()` are used only for booleans/classification.
- Alternatives contain only public model identifiers.
- Output and details arrays are bounded.

## Error handling

- Registry method failures become bounded launch errors before pane creation.
- A model removed between resolution and child execution may still fail normally; the delivered error should identify the model but not credentials.
- Empty/invalid custom model metadata receives safe numeric defaults for ranking and stable lexical fallback.
- Duplicate provider/model entries are deduplicated by canonical reference before ranking.

## Testing

Implementation follows strict RED-before-GREEN TDD.

Pure resolver tests cover:

1. Authenticated explicit model passes unchanged.
2. Unknown explicit model errors without fallback.
3. Unconfigured explicit model errors with up to three ranked configured alternatives.
4. Authenticated agent preferred model passes unchanged.
5. Unavailable preferred model falls back and records reason.
6. Bare spawn selects a configured model.
7. OAuth outranks API-key candidates.
8. Fast, balanced, and deep tiers rank deterministically.
9. Preferred-provider and lexical tie-breakers are stable.
10. Unknown reasoning/non-reasoning metadata receives balanced/fast defaults.
11. Custom/dynamic providers participate.
12. No candidates returns the login/API-key guidance.
13. No output includes supplied fake secret values.

Integration/unit wiring tests cover:

14. Explicit failure occurs before pane creation or artifact writes.
15. Preferred fallback command uses effective `--model`.
16. Launch details and rendered acknowledgement disclose substitution safely.
17. `subagents_list` annotates configured/fallback/unavailable/external states.
18. Invalid `model-tier` fails before pane creation.
19. External Claude behavior remains unchanged.
20. Existing session mode, thinking, tools, health, completion, and rollback tests remain green.

## Acceptance criteria

- Every fresh Pi-backed subagent command includes an authenticated effective model.
- Explicit unavailable overrides never silently change.
- Agent-default unavailability produces deterministic OAuth-first, role-aware fallback.
- No configured models produces no pane/artifacts and actionable guidance.
- Listings and launch results disclose effective model/auth class without secrets.
- All tests pass.
