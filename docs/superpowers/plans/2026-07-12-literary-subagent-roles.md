# Literary Subagent Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add package-bundled translator, translator-reviewer, and editor agents for professional source-to-English literary work.

**Architecture:** Each role is a standalone Markdown agent definition discovered by the existing package agent loader. Static metadata selects Sol/deep/high and constrains tools; focused prompts separate translation, independent fidelity review, and professional English editing. Existing discovery and configured-model fallback code remains unchanged.

**Tech Stack:** Markdown/YAML agent definitions, TypeScript tests with Node's test runner, existing Pi interactive-subagents discovery.

## Global Constraints

- Names are exactly `translator`, `translator-reviewer`, and `editor`.
- Every role defaults to `openai-codex/gpt-5.6-sol`, `model-tier: deep`, and `thinking: high`.
- Every role sets `spawning: false`, `auto-exit: true`, and `system-prompt: append`.
- Translator and editor tools are exactly `read, write, edit`.
- Translator-reviewer tools are exactly `read`; it never modifies files.
- Translator preserves source meaning, voice, tone, register, structure, ambiguity, and culturally specific language without silent embellishment or simplification.
- Translator-reviewer independently checks fidelity and separates actual defects from optional style choices.
- Editor produces professional English grammar, semantics, consistency, typography, and formatting without erasing deliberate voice or changing unresolved meaning.
- Roles remain independently invokable; no automatic pipeline or slash command is added.
- No configured-model resolver or provider fast-inference behavior changes.

---

### Task 1: Bundled Literary Agent Definitions

**Files:**
- Create: `agents/translator.md`
- Create: `agents/translator-reviewer.md`
- Create: `agents/editor.md`
- Modify: `test/test.ts`

**Interfaces:**
- Consumes: existing `loadAgentDefaults(name)`, `discoverAgentDefinitions()`, and `resolveEffectiveInteractive()` test API.
- Produces: three visible package agent definitions with exact metadata and prompt contracts.

- [ ] **Step 1: Add failing metadata, discovery, permission, and prompt-contract tests**

Add these tests inside `describe("subagent discovery", ...)` in `test/test.ts`:

```ts
it("bundles autonomous Sol/high literary agents with role-specific permissions", async () => {
  await withIsolatedAgentEnv(async () => {
    const expected = {
      translator: "read, write, edit",
      "translator-reviewer": "read",
      editor: "read, write, edit",
    };

    const bundled = testApi.discoverAgentDefinitions()
      .filter((definition: any) => definition.source === "package");
    const visible = new Set(
      bundled
        .filter((definition: any) => !definition.disableModelInvocation)
        .map((definition: any) => definition.name),
    );

    for (const [name, tools] of Object.entries(expected)) {
      const defaults = testApi.loadAgentDefaults(name);
      assert.ok(defaults, `expected bundled ${name}`);
      assert.equal(defaults.model, "openai-codex/gpt-5.6-sol");
      assert.equal(defaults.modelTier, "deep");
      assert.equal(defaults.thinking, "high");
      assert.equal(defaults.tools, tools);
      assert.equal(defaults.spawning, false);
      assert.equal(defaults.autoExit, true);
      assert.equal(defaults.systemPromptMode, "append");
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defaults),
        false,
      );
      assert.ok(visible.has(name), `${name} should be publicly discoverable`);
    }
  });
});

it("keeps literary role instructions separated by responsibility", () => {
  const agentsDir = join(fileURLToPath(new URL("..", import.meta.url)), "agents");
  const translator = readFileSync(join(agentsDir, "translator.md"), "utf8");
  const reviewer = readFileSync(join(agentsDir, "translator-reviewer.md"), "utf8");
  const editor = readFileSync(join(agentsDir, "editor.md"), "utf8");

  assert.match(translator, /source language.*English/is);
  assert.match(translator, /voice.*tone.*register/is);
  assert.match(translator, /ambigu/i);
  assert.match(translator, /must not silently.*(embellish|simplify)/is);
  assert.match(translator, /translator(?:'s)? note/i);

  assert.match(reviewer, /compare.*source.*English translation/is);
  assert.match(reviewer, /Critical.*Important.*Minor/is);
  assert.match(reviewer, /omission|addition/i);
  assert.match(reviewer, /optional stylistic/i);
  assert.match(reviewer, /do not modify files/i);

  assert.match(editor, /publication-quality/is);
  assert.match(editor, /grammar.*spelling.*punctuation/is);
  assert.match(editor, /typography|formatting/i);
  assert.match(editor, /preserv.*authorial.*voice/is);
  assert.match(editor, /translator reviewer.*fidelity/is);
});
```

Extend the existing bundled-tier test map with:

```ts
translator: "deep",
"translator-reviewer": "deep",
editor: "deep",
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='literary agents|literary role|approved role tier' test/test.ts
```

Expected: FAIL because the three bundled agent files do not exist and the new tier expectations resolve to `undefined`.

- [ ] **Step 3: Create `agents/translator.md`**

```md
---
name: translator
description: Literary translator — translates source-language work into faithful, polished English while preserving voice, tone, structure, and ambiguity
tools: read, write, edit
model: openai-codex/gpt-5.6-sol
model-tier: deep
thinking: high
spawning: false
auto-exit: true
system-prompt: append
---

# Translator

You are a professional literary translator working from another language into English. Translate the assigned source faithfully and produce natural English without replacing the author's work with your own.

## Preserve

- Semantic meaning, factual content, reference, agency, tense, aspect, modality, and negation.
- Authorial voice, tone, register, rhythm, imagery, characterization, and emotional force.
- Paragraphs, sections, dialogue, emphasis, footnotes, and every structure that carries meaning.
- Intentional ambiguity, repetition, fragmentation, dialect, and stylistic irregularity.
- Names and terminology consistently across the complete work.

## Hard rules

- Do not silently embellish, censor, simplify, summarize, modernize, domesticate, or flatten culturally specific language.
- Do not invent source context, explanations, or certainty.
- When a passage genuinely admits materially different readings, choose the best-supported English rendering and record a concise translator's note describing the ambiguity and alternatives.
- Distinguish uncertainty in the source from personal stylistic preference.
- Read all supplied context before editing so terminology and voice remain consistent.

When paths are supplied, edit the target files directly with `write` or `edit`. Do not alter the source text unless explicitly instructed.

## Final response

Report:

1. Files changed and translation scope.
2. Material interpretive choices.
3. Translator's notes and unresolved ambiguities.
4. Names, terms, or style decisions that later reviewers must preserve.
```

- [ ] **Step 4: Create `agents/translator-reviewer.md`**

```md
---
name: translator-reviewer
description: Translation fidelity reviewer — independently compares source work with its English translation and reports concrete defects
tools: read
model: openai-codex/gpt-5.6-sol
model-tier: deep
thinking: high
spawning: false
auto-exit: true
system-prompt: append
---

# Translator Reviewer

You are an independent literary translation fidelity reviewer. Compare the source text with the English translation. Fluent English is not evidence of fidelity.

## Review for

- Omissions, additions, unsupported interpolation, accidental duplication, and censorship.
- Errors in meaning, grammar, reference, agency, negation, tense, aspect, and modality.
- Drift in voice, tone, register, characterization, rhythm, imagery, ambiguity, and cultural meaning.
- Mishandled idioms, wordplay, dialect, names, honorifics, terminology, and internal consistency.
- Formatting or structural changes that alter meaning.

## Hard rules

- Do not modify files. You are read-only and must report corrections for another agent to apply.
- Separate fidelity defects from optional stylistic alternatives.
- Do not penalize a defensible nonliteral rendering merely for being nonliteral.
- State when source access, context, or language competence is insufficient; never claim certainty you cannot support.

## Findings format

Group findings as Critical, Important, or Minor. For every finding provide:

1. Source location and relevant source text.
2. Current English rendering.
3. Exact problem and fidelity rationale.
4. Concrete suggested correction.

End with an overall fidelity assessment, recurring terminology or voice concerns, and any passages requiring author or translator judgment.
```

- [ ] **Step 5: Create `agents/editor.md`**

```md
---
name: editor
description: Literary editor — brings English manuscripts and translations to professional publication quality while preserving meaning and voice
tools: read, write, edit
model: openai-codex/gpt-5.6-sol
model-tier: deep
thinking: high
spawning: false
auto-exit: true
system-prompt: append
---

# Editor

You are a professional literary editor. Bring the assigned English manuscript or translation to publication quality while preserving authorial meaning and voice.

## Edit for

- Grammar, spelling, punctuation, syntax, diction, semantic clarity, and idiomatic English.
- Flow, unintended ambiguity, accidental repetition, continuity, and consistency.
- Typography, dialogue conventions, headings, paragraphs, emphasis, lists, footnotes, and formatting.
- Consistent names, capitalization, terminology, numerals, dates, and any supplied house style.

## Hard rules

- Do not rewrite to personal taste or homogenize a distinctive voice.
- Preserve deliberate ambiguity, fragmentation, repetition, dialect, rhythm, and unconventional style.
- Do not invent facts or silently resolve a meaning-changing ambiguity.
- Flag questions that require author or translator judgment.
- Translation fidelity belongs to the translator reviewer; do not conceal a known fidelity concern with smoother prose.

When paths are supplied, edit the target files directly with `write` or `edit`. Keep formatting changes intentional and compatible with the document format.

## Final response

Report files changed, the scope of editing, substantive or meaning-sensitive interventions, consistency decisions, and unresolved editorial queries.
```

- [ ] **Step 6: Run focused and full verification**

```bash
node --test --test-name-pattern='literary agents|literary role|approved role tier' test/test.ts
npm test
git diff --check
```

Expected: focused tests pass; full suite passes; diff check emits no output.

- [ ] **Step 7: Commit Task 1**

```bash
git add agents/translator.md agents/translator-reviewer.md agents/editor.md test/test.ts
git commit -m "feat(subagents): add literary translation roles"
```

Write `.superpowers/sdd/literary-roles-task-1-report.md` with exact RED, focused GREEN, full GREEN, and self-review evidence.

### Task 2: Documentation and Final Verification

**Files:**
- Modify: `README.md`
- Test: `test/test.ts`

**Interfaces:**
- Consumes: the three Task 1 bundled definitions and existing README bundled-agent/configured-fallback sections.
- Produces: user-facing discovery, model, permission, and recommended-sequence documentation.

- [ ] **Step 1: Add a failing README contract test**

Add to `test/test.ts`:

```ts
it("documents the bundled literary workflow and permissions", () => {
  const readme = readFileSync(
    join(fileURLToPath(new URL("..", import.meta.url)), "README.md"),
    "utf8",
  );

  assert.match(readme, /translator.*GPT-5\.6 Sol.*high thinking/is);
  assert.match(readme, /translator-reviewer.*read-only/is);
  assert.match(readme, /editor.*publication-quality/is);
  assert.match(readme, /translator\s*(?:→|->).*translator-reviewer\s*(?:→|->).*editor/is);
  assert.match(readme, /independently invokable/i);
  assert.match(readme, /literary.*deep/i);
});
```

- [ ] **Step 2: Run the README test and verify RED**

```bash
node --test --test-name-pattern='documents the bundled literary workflow' test/test.ts
```

Expected: FAIL because README does not list or explain the three roles.

- [ ] **Step 3: Update the bundled-agent table**

Add these rows under `### Bundled Agents`:

```md
| **translator** | GPT-5.6 Sol (high thinking) | Translates source-language literary work into faithful, polished English |
| **translator-reviewer** | GPT-5.6 Sol (high thinking) | Read-only fidelity review comparing source work with its English translation |
| **editor** | GPT-5.6 Sol (high thinking) | Brings English manuscripts and translations to professional publication quality |
```

- [ ] **Step 4: Document the workflow and fallback tier**

After the bundled-agent discovery paragraph, add:

```md
#### Literary workflow

The literary roles are independently invokable and default to GPT-5.6 Sol with high thinking. A typical sequence is **translator → translator-reviewer → editor**:

1. `translator` reads the source and writes the English translation.
2. `translator-reviewer` is read-only and reports fidelity defects without modifying files.
3. `editor` applies professional English grammar, semantics, consistency, typography, and formatting after translation choices are accepted.

All three declare the `deep` configured-model tier. If their preferred Sol model is unavailable, the configured-model resolver applies the same authenticated OAuth-first fallback policy documented below. The sequence is caller-controlled; the package does not chain the roles automatically.
```

Extend the configured-model bundled defaults sentence so `translator`, `translator-reviewer`, and `editor` are included among `deep` roles.

- [ ] **Step 5: Run focused and full verification**

```bash
node --test --test-name-pattern='documents the bundled literary workflow|literary agents|literary role|approved role tier' test/test.ts
npm test
git diff --check
```

Expected: all tests pass and diff check emits no output.

- [ ] **Step 6: Commit Task 2**

```bash
git add README.md test/test.ts
git commit -m "docs(subagents): explain literary workflow"
```

Write `.superpowers/sdd/literary-roles-task-2-report.md` with exact RED/GREEN/full verification evidence.

### Task 3: Whole-Branch Verification and Review

**Files:**
- Review all branch changes from the merge base.
- Modify only files required by verified review findings.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a reviewer-approved and freshly verified integration candidate.

- [ ] **Step 1: Run fresh verification**

```bash
npm test
git diff --check
git status --short --branch
```

Expected: zero test failures, no diff-check output, and no uncommitted source changes.

- [ ] **Step 2: Generate a whole-branch review package**

Run:

```bash
BASE=$(git merge-base main HEAD)
/var/home/ryan/.agents/skills/superpowers/subagent-driven-development/scripts/review-package "$BASE" HEAD
```

Expected: the script prints one `.superpowers/sdd/review-<base>..<head>.diff` path whose commit list includes every literary-role commit.

- [ ] **Step 3: Dispatch a Terra/high reviewer**

Review for exact metadata, least-privilege tools, prompt role separation, translation fidelity safeguards, editor scope, autonomous behavior, configured-model consistency, documentation accuracy, and behavioral test coverage.

- [ ] **Step 4: Fix all Critical and Important findings test-first**

Use one worker for the combined findings. Re-run covering tests and the full suite, then return the complete package to the same reviewer.

- [ ] **Step 5: Run final completion verification**

```bash
npm test && git diff --check && git status --short --branch
```

Record exact output before integration options.
