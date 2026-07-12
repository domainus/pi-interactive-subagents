# Literary subagent roles design

## Goal

Add three package-bundled agents for a professional literary translation workflow:

1. `translator` translates source-language work into English.
2. `translator-reviewer` independently checks translation fidelity.
3. `editor` polishes English prose and formatting to professional quality.

The roles remain independently invokable. This change does not add an automatic pipeline or slash command.

## Shared runtime policy

Each role uses this frontmatter policy:

```yaml
model: openai-codex/gpt-5.6-sol
model-tier: deep
thinking: high
spawning: false
auto-exit: true
system-prompt: append
```

GPT-5.6 Sol with high reasoning is an explicit literary-work exception to the normal orchestration preference for Terra. No role uses `max` or `xhigh`, and provider fast inference remains disabled by the global normal-service-tier policy.

The roles are package-bundled under `agents/`, discovered through the existing project/global/package precedence rules, and may be overridden by higher-priority definitions.

## Translator

File: `agents/translator.md`

Tools:

```yaml
tools: read, write, edit
```

The translator converts prose, poetry, dialogue, scripts, essays, and other literary work from another language into polished English while preserving:

- semantic meaning and factual content;
- authorial voice, tone, register, rhythm, imagery, and characterization;
- paragraph, section, dialogue, emphasis, footnote, and other meaningful structure;
- intentional ambiguity, repetition, fragmentation, dialect, and stylistic irregularity;
- names and terminology consistently.

The translator must not silently embellish, censor, simplify, summarize, modernize, or flatten culturally specific language. When a source passage is genuinely ambiguous or admits materially different readings, the translator chooses the best-supported rendering and records a concise translator's note. It must distinguish source uncertainty from its own preference and must not fabricate source context.

The translator may edit target files directly when paths are supplied. Its final response identifies files changed, translation scope, material interpretive choices, unresolved ambiguities, and terminology decisions.

## Translator reviewer

File: `agents/translator-reviewer.md`

Tools:

```yaml
tools: read
```

The translator reviewer is independent and read-only. It compares the source text against the English translation rather than merely judging whether the English sounds fluent.

It checks for:

- omissions, additions, unsupported interpolation, or accidental duplication;
- mistranslation of meaning, grammar, reference, negation, tense, aspect, modality, or agency;
- drift in voice, tone, register, characterization, rhythm, imagery, ambiguity, and cultural meaning;
- mishandled idioms, wordplay, dialect, names, honorifics, terminology, and internal consistency;
- formatting or structural changes that alter meaning.

Findings are prioritized as Critical, Important, or Minor and include the source location, current rendering, issue, rationale, and a concrete suggested correction. The reviewer distinguishes fidelity defects from optional stylistic alternatives, states when source access or language competence is insufficient, and never claims certainty it cannot support. It does not modify files.

## Editor

File: `agents/editor.md`

Tools:

```yaml
tools: read, write, edit
```

The editor turns an English manuscript or translation into publication-quality prose while preserving authorial meaning and voice. It corrects:

- grammar, spelling, punctuation, syntax, diction, and semantic clarity;
- awkward flow, unintended ambiguity, repetition, continuity, and consistency;
- typography, dialogue conventions, headings, paragraphs, emphasis, lists, footnotes, and document formatting;
- names, capitalization, terminology, numerals, dates, and house-style consistency when a style guide is supplied.

The editor does not rewrite to personal taste, erase deliberate stylistic features, invent facts, or silently resolve meaning-changing ambiguities. It makes direct file edits when paths are supplied, records substantive or meaning-sensitive interventions, and flags questions requiring author or translator judgment. Translation fidelity remains the translator reviewer's responsibility.

## Separation of responsibilities

- The translator owns source-to-English interpretation.
- The translator reviewer owns independent fidelity assessment and does not edit.
- The editor owns English-language polish and presentation after translation choices are accepted.
- Fluent English does not excuse a fidelity defect, and literal fidelity does not excuse unprofessional English.
- The roles may be invoked sequentially as translator → translator-reviewer → editor, but orchestration is caller-controlled.

## Documentation

Update the README bundled-agent table and configured-model fallback defaults to list all three roles. Document the recommended sequence and the read-only reviewer boundary.

## Verification

Behavioral tests must verify:

1. all three definitions are discoverable and non-interactive;
2. all three use `openai-codex/gpt-5.6-sol`, `model-tier: deep`, and `thinking: high`;
3. translator and editor expose only `read`, `write`, and `edit`;
4. translator-reviewer exposes only `read`;
5. all three disable spawning, auto-exit, and append their role prompts;
6. existing bundled role expectations and configured fallback behavior remain valid;
7. README model/tier descriptions match the definitions.

Run the full unit suite and diff checks before review and integration.

## Out of scope

- Automatic chaining or a literary-work slash command.
- Source-language-specific glossaries or style guides.
- A new translation memory, corpus, or terminology database.
- Changes to the configured-model resolver.
- Enabling provider fast inference.
