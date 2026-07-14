---
name: run-integration-tests
description: Run unit and mux integration tests and verify workflow/subagent lifecycle artifacts.
---

# Run Integration Tests

## Preflight

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
echo "CMUX_SOCKET_PATH=$CMUX_SOCKET_PATH"
echo "TMUX=$TMUX"
echo "ZELLIJ=$ZELLIJ"
for mux in cmux tmux zellij herdr; do command -v "$mux" >/dev/null && echo "$mux available"; done
node --version
```

Node 22+ is required. The harness probes cmux, tmux, and zellij, with Herdr additionally covered by lifecycle tests. WezTerm is supported by the package but is not currently an integration-harness target. If no harness backend is available, run `npm test` and report that mux integration was skipped; do not use hard-coded developer-home paths.

## Unit and integration suites

Run the repository scripts so test selection stays current:

```bash
npm test
npm run test:integration
```

The integration runner uses `--test-concurrency=1` where required by mux focus assertions. Use the test runner's dynamic totals, not a fixed expected count. Stop and report failures before any release action. Unlike the deterministic unit suite, subprocess lifecycle tests may require authenticated `PI_TEST_MODEL` access and can be slow; state any skipped, timed-out, or unavailable real-model coverage explicitly.

For cmux, a dedicated surface may be used. Poll for the terminal sentinel with a bounded timeout; never close the surface while tests are still running:

```bash
SURFACE=$(cmux new-surface --type terminal | awk '{print $2}')
cmux send --surface "$SURFACE" "cd '$REPO_ROOT' && npm run test:integration; printf '\\n__TESTS_DONE_%s__\\n' \$?\n"
DEADLINE=$((SECONDS + 900))
while :; do
  SCREEN=$(cmux read-screen --surface "$SURFACE" --lines 200 2>&1 || true)
  printf '%s\n' "$SCREEN"
  if printf '%s' "$SCREEN" | grep -Eq '__TESTS_DONE_[0-9]+__'; then break; fi
  if (( SECONDS >= DEADLINE )); then
    echo "integration timeout after 15 minutes" >&2
    cmux read-screen --surface "$SURFACE" --scrollback --lines 500 || true
    cmux close-surface --surface "$SURFACE" || true
    exit 1
  fi
  sleep 15
done
FINAL=$(cmux read-screen --surface "$SURFACE" --scrollback --lines 500)
printf '%s\n' "$FINAL"
cmux close-surface --surface "$SURFACE"
printf '%s' "$FINAL" | grep -q '__TESTS_DONE_0__'
```

For tmux or zellij, run `npm run test:integration` in a dedicated window/pane and capture the complete output. Herdr lifecycle coverage is selected automatically when available. Preserve the parent session's focus.

## Workflow verification

When workflow tests or artifacts are part of the change, inspect the created temporary session/workflow directories after the suite. Verify every workflow has durable metadata and state, valid node results/gate records, bounded sidecar artifact references, and (for build runs) an external worktree/evidence record. Check detached completion, cancellation, reload/resume, and explicit approval preview/token/apply behavior where covered. Never apply or clean up a worktree automatically during verification.

## Report

Report:

- `npm test` result and dynamic totals
- `npm run test:integration` result and dynamic totals, or why mux testing was skipped
- workflow status/artifact/session verification performed
- any failures with captured output
