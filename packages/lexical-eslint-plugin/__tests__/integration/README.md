# ESLint Plugin Integration Tests

This directory contains integration tests that verify `@lexical/eslint-plugin`
works correctly with every supported ESLint version.

## Test Coverage

The integration tests verify:

- **ESLint 9.x** with a flat `eslint.config.js` configuration
- **ESLint 10.x** with the same configuration

## Running the Tests

From the repository root:

```bash
pnpm run test-eslint-integration
```

## How It Works

The test script uses `pnpm dlx` to run different ESLint versions without
modifying `package.json` or `pnpm-lock.yaml`. This ensures:

- No dependency conflicts
- Clean testing environment
- Multiple ESLint versions can be tested in the same run

## Test Fixtures

### Flat Config

Located in `fixtures/flat-config/`:

- `eslint.config.js` - Flat ESLint configuration using `configs.recommended`
- `valid.js` - Code that should pass linting
- `invalid.js` - Code that should trigger `@lexical/rules-of-lexical` errors

## Expected Behavior

### Valid Code Examples

These should **pass** linting:

- Functions with `$` prefix calling other `$` functions
- Code inside `editor.update()` callbacks calling `$` functions
- Class methods calling `$` functions

### Invalid Code Examples

These should **fail** linting with `@lexical/rules-of-lexical` error:

- Functions without `$` prefix calling `$` functions directly

## Test Output

The test script provides colored output:

- ✓ Green = Test passed
- ✗ Red = Test failed
- Summary at the end with total/passed/failed counts
