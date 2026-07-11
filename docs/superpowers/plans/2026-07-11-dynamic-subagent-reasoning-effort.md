# Dynamic Subagent Reasoning Effort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each `subagent` and `subagent_resume` tool call select a validated Pi reasoning level without losing frontmatter or persisted-session defaults.

**Architecture:** Define one canonical reasoning-level contract in `pi-extension/subagents/index.ts`, resolve spawn precedence before creating a multiplexer surface, and emit Pi's independent `--thinking <level>` arguments in both new and resumed command paths. Keep backend transport untouched and expose narrow pure helpers through the existing `__test__` surface for side-effect-free tests.

**Tech Stack:** TypeScript, Node.js test runner, TypeBox schemas, Pi 0.80.6 CLI, shell-script launch artifacts.

## Global Constraints

- Support exactly `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Spawn precedence is explicit tool argument, then valid agent frontmatter, then no extension override.
- Resume passes an override only when explicitly requested; omission preserves persisted session effort.
- Use `pi --thinking <level>`, not only `--model model:level`.
- Explicit `thinking` on a Claude-backed launch must fail before creating a multiplexer surface.
- Invalid configured frontmatter must never reach the CLI; a valid explicit tool override may supersede invalid fallback configuration.
- Do not modify `pi-extension/subagents/cmux.ts`.
- Preserve the pre-existing uncommitted Ctrl+J/widget changes in `README.md`, `pi-extension/subagents/subagent-done.ts`, and `test/test.ts`.
- When committing files that already contain unrelated changes, stage only this feature's hunks with `git add -p`; never commit or revert the Ctrl+J/widget hunks.

---

## File Structure

- `pi-extension/subagents/index.ts` — owns public tool schemas, frontmatter parsing, effort resolution, CLI argument generation, and both launch paths.
- `test/test.ts` — extends existing discovery/tool-registration tests with schema, precedence, validation, and argument-generation regressions.
- `README.md` — documents tool parameters, accepted levels, precedence, clamping, and Pi-only behavior.
- No new runtime module is warranted for this narrow contract; backend transport remains isolated in `cmux.ts`.

### Task 1: Reasoning-Level Contract and Frontmatter Resolution

**Files:**
- Modify: `pi-extension/subagents/index.ts:138-200,258-306,940-965`
- Test: `test/test.ts:880-1085,1440-1510`

**Interfaces:**
- Produces: `THINKING_LEVELS`, `ThinkingLevel`, `resolveEffectiveThinking(params, agentDefs): ThinkingLevel | undefined`, and `buildThinkingArgs(level): string[]`.
- Produces: `AgentDefaults.thinking?: ThinkingLevel` and `AgentDefaults.invalidThinking?: string`.
- Consumes: existing `SubagentParams`, `getFrontmatterValue()`, `loadAgentDefaults()`, and `__test__` export object.

- [ ] **Step 1: Add failing schema and resolution tests**

Add tests that inspect TypeBox union literals and exercise the pure resolution contract:

```typescript
const expectedThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function schemaLiteralValues(schema: any): string[] {
  return (schema.anyOf ?? []).map((entry: any) => entry.const);
}

it("exposes all Pi reasoning levels on subagent", () => {
  const { api, registeredTools } = createMockExtensionApi();
  (subagentsModule as any).default(api);
  const tool = registeredTools.find((entry) => entry.name === "subagent");
  assert.deepEqual(schemaLiteralValues(tool.parameters.properties.thinking), expectedThinkingLevels);
});

it("resolves explicit thinking before frontmatter and emits dedicated CLI args", () => {
  const testApi = (subagentsModule as any).__test__;
  assert.equal(
    testApi.resolveEffectiveThinking(
      { name: "Worker", task: "T", thinking: "max" },
      { thinking: "low" },
    ),
    "max",
  );
  assert.equal(
    testApi.resolveEffectiveThinking({ name: "Worker", task: "T" }, { thinking: "low" }),
    "low",
  );
  assert.equal(testApi.resolveEffectiveThinking({ name: "Worker", task: "T" }, null), undefined);
  assert.deepEqual(testApi.buildThinkingArgs("xhigh"), ["--thinking", "xhigh"]);
  assert.deepEqual(testApi.buildThinkingArgs(undefined), []);
});
```

Add an isolated agent-frontmatter test with `thinking: sideways` and assert `thinking === undefined`, `invalidThinking === "sideways"`, and `resolveEffectiveThinking()` throws unless an explicit valid tool value is present.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='thinking|reasoning levels' test/test.ts
```

Expected: FAIL because `thinking` is absent from `SubagentParams`, and `resolveEffectiveThinking`/`buildThinkingArgs` are not exported.

- [ ] **Step 3: Implement the canonical schema and parser**

Add the contract near `SubagentParams`:

```typescript
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
], {
  description: "Reasoning effort for this invocation. Overrides agent frontmatter: off, minimal, low, medium, high, xhigh, or max.",
});

function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
  return value != null && (THINKING_LEVELS as readonly string[]).includes(value);
}
```

Add this property to `SubagentParams` after `model`:

```typescript
thinking: Type.Optional(ThinkingLevelSchema),
```

Update `AgentDefaults`:

```typescript
thinking?: ThinkingLevel;
invalidThinking?: string;
```

Parse frontmatter without accepting arbitrary strings:

```typescript
const rawThinking = getFrontmatterValue(frontmatter, "thinking");
// in returned object
thinking: isThinkingLevel(rawThinking) ? rawThinking : undefined,
invalidThinking: rawThinking && !isThinkingLevel(rawThinking) ? rawThinking : undefined,
```

Add pure helpers:

```typescript
function resolveEffectiveThinking(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): ThinkingLevel | undefined {
  if (params.thinking) return params.thinking;
  if (agentDefs?.invalidThinking) {
    throw new Error(`Invalid thinking level in agent definition: ${agentDefs.invalidThinking}`);
  }
  return agentDefs?.thinking;
}

function buildThinkingArgs(level: ThinkingLevel | undefined): string[] {
  return level ? ["--thinking", level] : [];
}
```

Expose `THINKING_LEVELS`, `resolveEffectiveThinking`, and `buildThinkingArgs` from the existing `__test__` object.

- [ ] **Step 4: Run focused and complete unit tests**

Run:

```bash
node --test --test-name-pattern='thinking|reasoning levels' test/test.ts
npm test
```

Expected: focused tests PASS; complete suite reports all tests passing with no new warnings.

- [ ] **Step 5: Commit only Task 1 hunks**

```bash
git add pi-extension/subagents/index.ts
git add -p test/test.ts
git diff --cached --check
git commit -m "feat(subagents): validate reasoning effort overrides"
```

Before committing, inspect `git diff --cached` and confirm the pre-existing Ctrl+J test hunk is not staged.

### Task 2: Wire Spawn and Resume Command Paths

**Files:**
- Modify: `pi-extension/subagents/index.ts:1004-1170,1788-1945`
- Test: `test/test.ts:880-1085,1440-1510`

**Interfaces:**
- Consumes: `resolveEffectiveThinking()` and `buildThinkingArgs()` from Task 1.
- Produces: new Pi launches with frontmatter/per-call effort and resumed Pi launches with explicit-only effort.
- Preserves: existing `effectiveModel`, task delivery, shell escaping, artifacts, environment propagation, and all multiplexer backends.

- [ ] **Step 1: Add failing launch-policy tests**

Add pure policy tests covering command composition and Claude rejection:

```typescript
it("builds spawn and resume reasoning args without changing omission behavior", () => {
  const testApi = (subagentsModule as any).__test__;
  assert.deepEqual(testApi.buildThinkingArgs("max"), ["--thinking", "max"]);
  assert.deepEqual(testApi.buildThinkingArgs(undefined), []);
});

it("rejects explicit Pi thinking for Claude-backed agents", () => {
  const testApi = (subagentsModule as any).__test__;
  assert.throws(
    () => testApi.assertThinkingSupportedForCli({ thinking: "high" }, { cli: "claude" }),
    /Claude-backed.*thinking/i,
  );
  assert.doesNotThrow(() => testApi.assertThinkingSupportedForCli({}, { cli: "claude" }));
  assert.doesNotThrow(() => testApi.assertThinkingSupportedForCli({ thinking: "high" }, null));
});
```

Extend the registered `subagent_resume` schema test to assert the seven literal values exactly. Add a source-level launch regression, following existing source-inspection tests, which reads `index.ts` and verifies both Pi command paths spread or append `buildThinkingArgs(...)`, while the Claude command block does not.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='spawn and resume reasoning|Claude-backed|subagent_resume.*thinking' test/test.ts
```

Expected: FAIL because resume lacks the schema field, launch paths do not append dedicated effort arguments, and `assertThinkingSupportedForCli` does not exist.

- [ ] **Step 3: Implement pre-surface validation and spawn arguments**

Add and export through `__test__`:

```typescript
function assertThinkingSupportedForCli(
  params: Pick<Static<typeof SubagentParams>, "thinking">,
  agentDefs: AgentDefaults | null,
): void {
  if (params.thinking && agentDefs?.cli === "claude") {
    throw new Error("Claude-backed subagents do not support Pi thinking levels");
  }
}
```

At the beginning of `launchSubagent()`, after loading agent defaults but before `createSurface()`:

```typescript
assertThinkingSupportedForCli(params, agentDefs);
const effectiveThinking = resolveEffectiveThinking(params, agentDefs);
```

Remove `const effectiveThinking = agentDefs?.thinking`.

Change Pi model/effort construction from model suffixing to independent arguments:

```typescript
if (effectiveModel) {
  parts.push("--model", shellEscape(effectiveModel));
}
for (const arg of buildThinkingArgs(effectiveThinking)) {
  parts.push(shellEscape(arg));
}
```

This validation occurs before the existing `createSurface(params.name)` call, satisfying the no-orphan-pane requirement.

- [ ] **Step 4: Implement resume schema and explicit-only arguments**

Add `thinking` to `subagent_resume.parameters` using the same seven-literal TypeBox union and this description:

```typescript
thinking: Type.Optional(
  Type.Union([
    Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"),
    Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
  ], {
    description: "Reasoning effort for this resumed invocation. When omitted, preserves the session's persisted level.",
  }),
),
```

Immediately after constructing resume `parts`, append only the explicit parameter:

```typescript
for (const arg of buildThinkingArgs(params.thinking)) {
  parts.push(shellEscape(arg));
}
```

Do not derive a default or read agent frontmatter in the resume path.

- [ ] **Step 5: Run focused tests, full tests, and syntax validation**

Run:

```bash
node --test --test-name-pattern='thinking|reasoning|Claude-backed' test/test.ts
npm test
node --experimental-strip-types --check pi-extension/subagents/index.ts
```

Expected: all commands exit 0. The full unit suite includes all baseline tests plus the new regressions.

- [ ] **Step 6: Commit only Task 2 hunks**

```bash
git add pi-extension/subagents/index.ts
git add -p test/test.ts
git diff --cached --check
git commit -m "feat(subagents): apply dynamic reasoning effort"
```

Inspect the staged diff before committing; do not stage the unrelated Ctrl+J test.

### Task 3: Documentation, Installed-Package Verification, and Review

**Files:**
- Modify: `README.md:177-225,286-320`
- Verify: `pi-extension/subagents/index.ts`
- Verify: `test/test.ts`

**Interfaces:**
- Consumes: the final tool schemas and precedence behavior from Tasks 1-2.
- Produces: user-facing documentation and deployment verification for the package loaded from `git:github.com/domainus/pi-interactive-subagents`.

- [ ] **Step 1: Update README parameter and frontmatter documentation**

Add `thinking` to the `subagent` parameter section:

```markdown
- `thinking` (optional): Per-invocation Pi reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Overrides agent frontmatter for this spawn.
```

Add it to `subagent_resume`:

```markdown
- `thinking` (optional): Override reasoning effort for this resumed invocation. Omit it to preserve the level stored in the session.
```

Replace the frontmatter table's restricted list with all seven values. Add a short precedence section:

```markdown
### Reasoning effort precedence

New Pi subagents use the tool-call `thinking` value first, then valid agent frontmatter, then Pi's inherited/configured default. Resumed sessions keep their persisted level unless `subagent_resume.thinking` is supplied. Pi may clamp higher levels to model capabilities. Pi thinking levels are not supported for Claude-backed custom agents.
```

Integrate these additions without reverting the existing unstaged widget/shortcut documentation changes.

- [ ] **Step 2: Run complete verification**

Run:

```bash
npm test
npm run test:integration
node --experimental-strip-types --check pi-extension/subagents/index.ts
git diff --check
git status --short
```

Expected:
- unit suite exits 0;
- integration suite exits 0, or any environment-only skip is explicitly reported with its exact output;
- syntax check exits 0;
- no whitespace errors;
- only intended feature changes plus the known pre-existing Ctrl+J/widget changes remain.

- [ ] **Step 3: Inspect generated public tool metadata**

Run a no-pane unit-level inspection through the test suite and confirm both registered schemas advertise the seven values. Then run:

```bash
pi --no-extensions --list-models openai-codex | grep 'gpt-5.6'
```

Expected: active GPT-5.6 models advertise thinking support. Do not spawn a live subagent solely for this check.

- [ ] **Step 4: Commit only documentation hunks**

```bash
git add -p README.md
git diff --cached --check
git commit -m "docs(subagents): explain reasoning effort selection"
```

Inspect `git diff --cached` and ensure the pre-existing Tools Widget/`Ctrl+J` hunk remains unstaged.

- [ ] **Step 5: Request independent review and address findings**

Ask a reviewer to inspect:

- schema/provider compatibility;
- precedence and invalid-frontmatter behavior;
- no pane creation before errors;
- resume omission preserving persisted effort;
- shell argument safety;
- preservation of unrelated dirty changes;
- test adequacy.

Apply any Critical or Important fixes with a fresh failing regression first, rerun the complete verification commands, and commit only the fix hunks.

- [ ] **Step 6: Reload and smoke-check the installed extension**

After review and tests, run `/reload` in the parent Pi session. Verify `subagents_list` still succeeds and that the model-facing `subagent` and `subagent_resume` schemas expose optional `thinking`. Do not launch a costly live child unless the user requests a live smoke test.
