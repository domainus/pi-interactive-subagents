# Configured Model Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every fresh Pi-backed subagent uses a model authenticated in the current Pi registry, with OAuth-first role-aware fallback for unavailable agent defaults and strict errors for unavailable explicit overrides.

**Architecture:** Add a pure model-selection module that consumes a narrow registry interface and returns a discriminated resolution. Parse `model-tier` in agent definitions, resolve before pane/artifact creation, pass the effective model into launch, and reuse the same resolver in `subagents_list` for safe disclosure.

**Tech Stack:** TypeScript ESM, Pi `ModelRegistry`, `@mariozechner/pi-ai` model metadata, Node `node:test`.

## Global Constraints

- Pi `ModelRegistry` is the only credential/configuration authority.
- No credential values, auth paths, headers, raw auth errors, or environment values may be rendered or persisted.
- OAuth/subscription candidates rank before API-key candidates.
- Explicit unavailable `model:` overrides error before pane/artifact creation and never fall back.
- Unavailable agent defaults and bare spawns choose deterministic configured fallbacks.
- Custom agents default to `balanced`; invalid `model-tier` fails before pane creation.
- External `cli: claude` behavior remains unchanged and is labeled `external auth`.
- No network/auth refresh occurs during resolution.
- Follow strict RED-before-GREEN TDD with exact evidence.

---

## File Structure

- Create `pi-extension/subagents/model-selection.ts`: pure parsing, tier inference, ranking, resolution, and bounded alternatives.
- Modify `pi-extension/subagents/index.ts`: frontmatter tier parsing, pre-pane resolution, launch details/rendering, and list integration.
- Modify bundled `agents/*.md`: explicit role tiers.
- Modify `test/test.ts`: resolver and production wiring tests.
- Modify `README.md`: model availability/fallback behavior.

### Task 1: Pure Configured Model Resolver

**Files:**
- Create: `pi-extension/subagents/model-selection.ts`
- Test: `test/test.ts` in a new `configured model selection` block

**Interfaces:**

```ts
export type ModelTier = "fast" | "balanced" | "deep";
export type ModelAuthType = "oauth" | "api-key";

export interface ModelRegistryLike {
  getAvailable(): Array<Model<any>>;
  find(provider: string, modelId: string): Model<any> | undefined;
  hasConfiguredAuth(model: Model<any>): boolean;
  isUsingOAuth(model: Model<any>): boolean;
}

export interface ResolvedLaunchModel {
  requestedModel?: string;
  preferredModel?: string;
  effectiveModel: string;
  authType: ModelAuthType;
  tier: ModelTier;
  source: "explicit" | "preferred" | "fallback" | "automatic";
  fallbackReason?: "preferred-unknown" | "preferred-unconfigured";
}

export type ModelResolution =
  | { ok: true; value: ResolvedLaunchModel }
  | {
      ok: false;
      code: "explicit-invalid" | "explicit-unknown" | "explicit-unconfigured" | "no-configured-models" | "registry-error";
      message: string;
      alternatives: string[];
    };
```

- [ ] **Step 1: Add fake model/registry builders and all resolver tests before production code**

Use fake public model metadata and fake secret-bearing registry internals to prove outputs never leak secrets. Add tests for:

- authenticated explicit model unchanged;
- invalid/unknown explicit reference errors;
- explicit known-unconfigured errors with at most three alternatives;
- authenticated preferred model unchanged;
- unknown preferred fallback reason;
- known-unconfigured preferred fallback reason;
- bare automatic selection;
- no configured models guidance;
- OAuth candidate outranking a closer-tier API-key candidate;
- tier inference hints (`luna/haiku/flash/mini/nano/small`, `terra/sonnet/medium/balanced`, `sol/opus/pro/reasoning/o1/o3/r1`);
- unknown reasoning => balanced and non-reasoning => fast;
- deterministic fast/balanced/deep role ordering;
- preferred-provider tie-break;
- lexical tie-break independent of input order;
- deduplication by canonical provider/model ID;
- malformed numeric metadata receiving safe defaults;
- dynamic/custom provider candidate participation;
- alternatives and errors omit fake keys/tokens/headers/auth paths.

- [ ] **Step 2: Run focused tests and verify genuine RED**

```bash
node --test --test-name-pattern='configured model selection' test/test.ts
```

Expected: import/module/function failures because `model-selection.ts` does not exist.

- [ ] **Step 3: Implement reference parsing and tier inference**

Export:

```ts
export function parseModelReference(value: string):
  | { ok: true; provider: string; modelId: string; reference: string }
  | { ok: false };

export function inferCandidateTier(model: Model<any>): ModelTier;
```

Split on the first slash, trim both components, canonicalize only for comparison, and retain public identifiers for output. Match tier hints case-insensitively against `${provider} ${id} ${name}`. Unknown reasoning models are balanced; unknown non-reasoning models are fast.

- [ ] **Step 4: Implement pure deterministic ranking**

Export:

```ts
export function rankConfiguredModels(params: {
  models: Array<Model<any>>;
  registry: Pick<ModelRegistryLike, "isUsingOAuth">;
  tier: ModelTier;
  preferredProvider?: string;
}): Array<{ model: Model<any>; reference: string; authType: ModelAuthType }>;
```

Deduplicate canonical references. Comparator keys must follow the spec exactly: OAuth, tier distance, reasoning suitability, preferred provider, tier-specific metadata, lexical reference. Normalize non-finite costs/capacities to safe deterministic values.

- [ ] **Step 5: Implement model resolution**

Export:

```ts
export function resolveConfiguredModel(params: {
  registry: ModelRegistryLike;
  tier: ModelTier;
  explicitModel?: string;
  preferredModel?: string;
  availableModels?: Array<Model<any>>;
}): ModelResolution;
```

When `availableModels` is omitted, take one `getAvailable()` snapshot inside `try/catch`. When supplied, use that caller-owned snapshot without another registry fetch; `subagents_list` relies on this to resolve every definition consistently from one call-wide snapshot. Resolve explicit first without fallback. Resolve preferred second. Otherwise choose ranked first. Return bounded public alternatives only. No raw caught registry error appears in user output.

- [ ] **Step 6: Run focused GREEN and full tests**

```bash
node --test --test-name-pattern='configured model selection' test/test.ts
npm test
git diff --check
```

Expected: all pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add pi-extension/subagents/model-selection.ts test/test.ts
git commit -m "feat(subagents): resolve configured launch models"
```

Write `.superpowers/sdd/model-fallback-task-1-report.md` with exact RED/GREEN/full evidence.

### Task 2: Agent Tiers and Pre-Pane Launch Resolution

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Modify: `agents/scout.md`
- Modify: `agents/visual-tester.md`
- Modify: `agents/planner.md`
- Modify: `agents/worker.md`
- Modify: `agents/reviewer.md`
- Modify: `agents/chatgpt-code.md`
- Modify: `agents/claude-code.md`
- Test: `test/test.ts`

**Interfaces:**
- Consumes Task 1 `resolveConfiguredModel()` and `ModelTier`.
- Adds `modelTier?: ModelTier` and `invalidModelTier?: string` to `AgentDefaults`.
- `launchSubagent()` receives an already resolved Pi model result or external-CLI marker.

- [ ] **Step 1: Add all frontmatter and launch-order tests before production edits**

Tests must prove:

- valid `model-tier` parses;
- omitted custom tier resolves balanced;
- invalid tier is retained as diagnostic and rejected before `createSurface()`;
- every bundled agent has the specified tier;
- authenticated explicit override reaches `--model` unchanged;
- unavailable explicit override returns actionable error, alternatives, and creates no pane/artifact/map entry;
- authenticated preferred default remains unchanged;
- unavailable preferred default uses effective fallback in command;
- bare Pi spawn includes automatic effective `--model`;
- no configured models returns guidance before pane/artifact/map changes;
- external Claude CLI bypasses registry resolution;
- registry exception returns bounded error before pane creation;
- launch acknowledgement/details include requested/preferred/effective/auth/tier/source/reason safely;
- no fake secret appears in tool content/details or generated command.

Use the existing fake Herdr/mux harness and registered `subagent` tool path, not source-string assertions.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test --test-name-pattern='model-tier|configured launch model|unavailable explicit|automatic effective model|model fallback disclosure' test/test.ts
```

Expected: failures because tier fields and production resolution wiring are absent.

- [ ] **Step 3: Parse/validate model-tier**

Add:

```ts
function parseModelTier(value: string | undefined): ModelTier | undefined;
```

Store invalid raw values exactly as thinking validation does. Resolve effective tier from agent definition or balanced default. Reject invalid tier before pane creation.

Update bundled frontmatter to the approved role tiers.

- [ ] **Step 4: Resolve model before launch mutation**

In registered `subagent.execute`, after mux/session prerequisites but before `launchSubagent()`:

1. load agent defaults once;
2. validate thinking/tier;
3. for Pi-backed runs call `resolveConfiguredModel({ registry: ctx.modelRegistry, tier, explicitModel: params.model, preferredModel: agentDefs?.model })`;
4. on error return content/details before launch;
5. pass successful resolution and loaded defaults into `launchSubagent()` so it does not re-resolve/reload inconsistently.

External Claude retains existing model handling.

- [ ] **Step 5: Use effective model and disclose result**

Use `resolution.effectiveModel` in the Pi command. Return details:

```ts
model: {
  requested?: string;
  preferred?: string;
  effective: string;
  authType: "oauth" | "api-key";
  tier: ModelTier;
  source: "explicit" | "preferred" | "fallback" | "automatic";
  fallbackReason?: string;
}
```

Acknowledgement/rendering mentions fallback only when source is `fallback`; explicit/preferred/automatic no-fallback stays compact. Bound model strings in rendering.

- [ ] **Step 6: Verify ordering and regressions**

```bash
node --test --test-name-pattern='model-tier|configured launch model|unavailable explicit|automatic effective model|model fallback disclosure|reasoning|launch surface' test/test.ts
npm test
git diff --check
```

Expected: all pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add pi-extension/subagents/index.ts agents test/test.ts
git commit -m "feat(subagents): select configured models before launch"
```

Write `.superpowers/sdd/model-fallback-task-2-report.md`.

### Task 3: Configured Model Listing and Documentation

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Modify: `README.md`
- Test: `test/test.ts`

**Interfaces:**
- Reuses Task 1 resolver for listing.
- `subagents_list.execute(..., ctx)` returns model-resolution annotations per visible definition.

- [ ] **Step 1: Add listing tests before implementation**

Through the registered `subagents_list` tool, test:

- preferred configured model annotation;
- unavailable preferred fallback annotation;
- OAuth/API-key classification;
- no configured model unavailable annotation without hiding definition;
- custom agent balanced default;
- external CLI `external auth` label;
- deterministic output independent of registry order;
- output/details never contain fake secrets;
- line/model/alternatives bounds.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test --test-name-pattern='subagents_list.*model|configured fallback listing|external auth listing' test/test.ts
```

Expected: listing lacks context-based annotations.

- [ ] **Step 3: Implement listing annotations**

Accept tool execution context, call `ctx.modelRegistry.getAvailable()` exactly once per list invocation, and pass that same `availableModels` array into every resolver call. Annotate each visible definition. Do not hide unavailable definitions. Reuse the same tier/default policy and error wording as launch. Preserve source shadowing and hidden-agent behavior.

- [ ] **Step 4: Update README**

Document:

- configured auth is determined by Pi registry;
- OAuth/subscription-first role-aware fallback;
- explicit override strictness;
- `model-tier` values and bundled defaults;
- no-model error before pane creation;
- listing annotations;
- external Claude exclusion;
- no credential/network probing.

- [ ] **Step 5: Run focused/full verification**

```bash
node --test --test-name-pattern='subagents_list.*model|configured fallback listing|external auth listing' test/test.ts
npm test
git diff --check
```

Expected: all pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add pi-extension/subagents/index.ts README.md test/test.ts
git commit -m "docs(subagents): explain configured model fallback"
```

Write `.superpowers/sdd/model-fallback-task-3-report.md`.

### Task 4: Final Verification and Review

**Files:**
- Review all changes from the branch base.
- Modify only files required by verified review findings.

- [ ] **Step 1: Run fresh full verification**

```bash
npm test
git diff --check
```

Expected: zero failures.

- [ ] **Step 2: Run a no-pane model-resolution smoke test**

Use registered tool tests or a small temporary extension/mocked registry to prove one OAuth fallback and one unavailable explicit override without creating a real pane. Do not expose real credential values.

- [ ] **Step 3: Generate full branch review package and dispatch Terra reviewer**

Review for spec coverage, auth/privacy safety, deterministic ranking, pane-ordering, dynamic/custom provider support, listing/launch consistency, and regression risk.

- [ ] **Step 4: Fix all Critical/Important findings test-first**

Use one worker for the combined final findings. Re-run covering and full tests.

- [ ] **Step 5: Final completion verification**

```bash
npm test && git diff --check && git status -sb
```

Record exact output before merge/PR options.
