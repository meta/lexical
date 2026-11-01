# `@lexical/y` Agent Guide

This file adds to the repository's [AGENTS.md](../../AGENTS.md) for work in
`packages/lexical-y` and reviews of pull requests that touch it.

## Decisions

- Read [DECISIONS.md](./DECISIONS.md) before changing `@lexical/y` or
  reviewing a pull request to it.
- Do not re-open a `DECIDED` row without new evidence: a repro, a
  measurement, or a use case the row did not consider. Say which row and what
  is new.
- A pull request that makes a new consequential decision, accepts a new
  limit, or changes a recorded one adds or updates its row in the same pull
  request. Accepted limits are also documented in
  [y.md's Limits](../lexical-website/docs/collaboration/y.md#limits).

## Testing

- Test the input space, not the cases you thought of. Draw inputs from the
  catalogs in `src/__tests__/catalog/` (node shapes, block id formats,
  configurations; added in
  [#9588](https://github.com/meta/lexical/pull/9588)), and add a class, id format or option to
  them when you add one to the code.
- Every bug fix lands with a regression test in
  `src/__tests__/unit/regressions/`. A known failure is a `test.fails` that
  names the issue or pull request that fixes it.
- Never label a failure intended, a limit, flaky or pre-existing without a
  repro and a control on the baseline you claim (for example, the same repro
  passing or failing on `main`).
- A refactor proves it stores the same bytes: identical updates and states,
  before and after, over the seeds in `src/__tests__/fuzz/` and a run of
  random sessions.

## Before a pull request is ready, and before merging

- Read the automated code-review bot's review on the pull request and resolve
  every item before calling it ready.
- Before merging a stack of pull requests, test them combined (main plus
  every pull request in the stack) and soak that build, not each pull
  request alone.
- Run the test suites of downstream consumers against the build where they
  are available.
- Pull requests are squash-merged through the merge queue, bottom-up for a
  stack, each rebased on `main` with required checks green and a
  maintainer's approval.
