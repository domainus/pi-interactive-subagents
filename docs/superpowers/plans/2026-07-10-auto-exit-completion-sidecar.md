# Auto-exit Completion Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal auto-exit subagent completion independent of multiplexer pane identity and verify the path under Herdr.

**Architecture:** Derive a completion sidecar payload from the latest assistant result and persist it before graceful shutdown. Keep terminal sentinel polling as fallback. Add a Herdr-inclusive lifecycle backend detector without enabling Herdr for focus tests that do not yet support it.

**Tech Stack:** TypeScript, Node test runner, Pi extensions, Herdr CLI.

## Global Constraints

- Normal completion writes `{ "type": "done" }` before shutdown.
- Provider errors retain `type`, `errorMessage`, and `stopReason` in the sidecar.
- Aborted turns remain open and write no completion sidecar.
- Existing terminal sentinel polling remains unchanged as crash fallback.
- Do not change pane creation, layout, explicit interrupt behavior, or result rendering.

---

### Task 1: Persist normal auto-exit completion and cover Herdr lifecycle

**Files:**
- Modify: `pi-extension/subagents/subagent-done.ts`
- Modify: `test/test.ts`
- Modify: `test/integration/harness.ts`
- Modify: `test/integration/subagent-lifecycle.test.ts`

**Interfaces:**
- Produces: `buildAutoExitSidecar(userTookOver: boolean, messages: any[] | undefined): { type: "done" } | ({ type: "error" } & SubagentErrorInfo) | null`
- Produces: `getAvailableLifecycleBackends(): MuxBackend[]`

- [ ] **Step 1: Add failing sidecar derivation tests**

Add unit tests requiring normal completion to return `{ type: "done" }`, provider errors to return their detailed error payload, and aborted turns to return `null`.

- [ ] **Step 2: Run the focused unit tests and confirm RED**

Run:

```bash
node --test --test-name-pattern='buildAutoExitSidecar' test/test.ts
```

Expected: fail because `buildAutoExitSidecar` is not exported.

- [ ] **Step 3: Implement minimal sidecar derivation and persistence**

Export `buildAutoExitSidecar`, derive it using `shouldAutoExitOnAgentEnd` and `findLatestAssistantError`, and update `agent_end` so every auto-exit path writes the derived payload to `${PI_SUBAGENT_SESSION}.exit` before `recorder.agentEndDone()` and `ctx.shutdown()`.

- [ ] **Step 4: Run focused and full unit tests**

Run:

```bash
node --test --test-name-pattern='buildAutoExitSidecar|subagent-done.ts|interpretExitSidecar' test/test.ts
npm test
```

Expected: all selected and full unit tests pass.

- [ ] **Step 5: Add Herdr lifecycle detection without widening unsupported mux tests**

Add `getAvailableLifecycleBackends()` to probe `cmux`, `tmux`, `zellij`, and `herdr`. Keep `getAvailableBackends()` unchanged for the generic mux-surface suite. Update only `subagent-lifecycle.test.ts` to use the lifecycle detector.

- [ ] **Step 6: Verify the real Herdr completion path**

Run the basic spawn/completion lifecycle test with `PI_SUBAGENT_MUX=herdr`, a supported test model, and a bounded timeout:

```bash
PI_SUBAGENT_MUX=herdr PI_TEST_MODEL=openai-codex/gpt-5.6-luna PI_TEST_TIMEOUT=180000 \
  node --test --test-concurrency=1 \
  --test-name-pattern='spawns a subagent that writes a file and verifies the session' \
  test/integration/subagent-lifecycle.test.ts
```

Expected: the marker file appears, the outer Pi receives the subagent result, and the integration test passes.

- [ ] **Step 7: Verify diff and commit**

Run:

```bash
npm test
git diff --check
git status --short
```

Commit only the sidecar implementation, tests, harness change, and documentation:

```bash
git add pi-extension/subagents/subagent-done.ts test/test.ts \
  test/integration/harness.ts test/integration/subagent-lifecycle.test.ts \
  docs/superpowers/specs/2026-07-10-auto-exit-completion-sidecar-design.md \
  docs/superpowers/plans/2026-07-10-auto-exit-completion-sidecar.md
git commit -m 'fix(subagents): persist normal auto-exit completion'
```

- [ ] **Step 8: Push the verified commits**

Run:

```bash
git push origin main
```

Expected: `origin/main` advances to the implementation commit.
