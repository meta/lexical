---
sidebar_position: 6
---

# Testing

Lexical has three tiers of tests: unit tests in jsdom, browser tests in a real browser, and end-to-end tests against the playground. Because `contentEditable` doesn't work in jsdom, anything involving real user input needs a browser.

## Unit tests (jsdom)

Unit tests run in [vitest](https://vitest.dev/) with a jsdom environment. They are fast (the full suite finishes in ~20 seconds) and cover the majority of Lexical's API surface.

```bash
pnpm test-unit
```

Test files live under `packages/**/src/__tests__/unit/` and `packages/**/__tests__/unit/`.

### Why user input doesn't work in jsdom

Calls like `userEvent.type()` or `fireEvent.input()` from React Testing Library will not produce any effect:

:::info

jsdom does not implement `contentEditable` editing. In a real browser, a keystroke inside a `contentEditable` element goes through the browser's native editing engine, which modifies the DOM and fires `beforeinput`/`input` events that Lexical observes. jsdom has no such engine, so dispatching synthetic `InputEvent`s has no effect.

The same applies to ProseMirror, Slate, Tiptap, and any other `contentEditable`-based editor. The approach is the same everywhere: use the editor's API to manipulate state in unit tests, and use a real browser when you need real input.

:::

### What you can test in jsdom

Anything that goes through Lexical's API rather than the browser's input pipeline:

```ts
import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  CONTROLLED_TEXT_INSERTION_COMMAND,
} from 'lexical';

const editor = buildEditorFromExtensions({
  $initialEditorState: () => {
    $getRoot().append(
      $createParagraphNode().append($createTextNode('hello')),
    );
  },
  dependencies: [RichTextExtension],
  name: 'test',
});

const root = document.createElement('div');
root.contentEditable = 'true';
document.body.appendChild(root);
editor.setRootElement(root);
```

**Insert text via the selection API:**

```ts
editor.update(() => {
  $getRoot().selectEnd();
}, {discrete: true});

editor.update(() => {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    selection.insertText(' world');
  }
}, {discrete: true});

editor.read(() => {
  expect($getRoot().getTextContent()).toBe('hello world');
});
```

`{discrete: true}` makes the update commit synchronously instead of being batched, so each step's effects are visible to the next one.

**Insert text via a command.** This also requires a selection to be set first:

```ts
editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, ' world');
```

Both approaches update the editor state and the DOM. Use whichever is closer to the code path you're testing.

### What you cannot test in jsdom

- Typing by dispatching `KeyboardEvent` or `InputEvent` on the DOM to insert text
- IME / composition sequences
- Selection changes driven by mouse clicks or arrow keys
- Clipboard paste with real browser `DataTransfer`

`KeyboardEvent` dispatch *does* work for non-text-input events. `KEY_ENTER_COMMAND`, `KEY_TAB_COMMAND`, `KEY_ARROW_*` commands, and shortcuts can all be tested in jsdom, either by dispatching the event on the DOM or via `editor.dispatchCommand`.

If your test needs real text input or composition, use browser tests.

### Editor cleanup with `using`

`buildEditorFromExtensions` returns an editor with a `dispose()` method and `Symbol.dispose` support. Declaring it with `using` automatically cleans up registrations at the end of the block:

```ts
it('inserts text', () => {
  using editor = buildEditorFromExtensions({
    dependencies: [RichTextExtension],
    name: 'test',
  });
  // editor.dispose() is called automatically at the end of the block
});
```

This only works in unit tests (jsdom). The `using` syntax is not supported in all browser engines, so browser tests should call `editor.dispose()` manually or use vitest's `onTestFinished` callback instead.

### Property-based tests with `@lexical/fast-check`

A node that declares a [serialization schema](./serialization/serialization.md#declarative-serialization-schemas-with-config) has already stated what each of its properties accepts, so tests do not have to invent examples. [`@lexical/fast-check`](./packages/lexical-fast-check.md) turns that declaration into a [fast-check](https://fast-check.dev) arbitrary:

```bash
npm install --save-dev @lexical/fast-check fast-check
```

```ts
import {nodeArbitrary} from '@lexical/fast-check';
import * as fc from 'fast-check';

fc.assert(
  fc.property(nodeArbitrary(MyNode), props => {
    // props is a serialized MyNode, drawn from its own schema's domain
  }),
);
```

This is worth reaching for whenever a hand-written fixture would tend to use *default* values, because a bug that drops a property compares equal to the default — the test looks like it passed exactly when the bug is invisible. The clearest case is `afterCloneFrom`: declaring a new property and forgetting to copy it there is silent, since the field still exists on the clone and simply holds the constructor's default. Generated values catch it, and fast-check shrinks the failure to the property at fault:

```
Counterexample: [{"style":" "}]

-   "style": " ",
+   "style": "",
```

The package's [README](./packages/lexical-fast-check.md) has the full example, and `packages/lexical-fast-check/src/__tests__/unit/` runs it against `TextNode`.

## Browser tests (vitest browser mode)

Browser tests run in a real browser via vitest's [browser mode](https://vitest.dev/guide/browser/), backed by Playwright. The browser has a real `contentEditable` engine, so input events, composition, and selection work as expected.

```bash
pnpm test-browser                                 # default: chromium
VITEST_BROWSER=firefox pnpm test-browser           # firefox
VITEST_BROWSER=chromium,firefox pnpm test-browser  # multiple browsers
```

Test files live under `packages/**/src/__tests__/browser/`. They look like normal vitest tests. Here's an example that uses the `compose()` and `korean()` helpers to simulate an IME sequence:

```ts
import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {$getRoot, $createParagraphNode} from 'lexical';
import {expect, test, onTestFinished} from 'vitest';
import {compose, korean} from './utils/compose';

test('IME composition inserts Korean text', async () => {
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot().append($createParagraphNode());
    },
    dependencies: [RichTextExtension],
    name: 'test',
  });
  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  document.body.appendChild(rootElement);
  editor.setRootElement(rootElement);
  onTestFinished(() => {
    editor.setRootElement(null);
    rootElement.remove();
    editor.dispose();
  });

  rootElement.focus();
  await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));

  editor.read(() => {
    expect($getRoot().getTextContent()).toBe('한');
  });
});
```

For a complete working setup with vitest browser mode configured from scratch, see the [`website-toolbar` example](https://github.com/meta/lexical/tree/main/examples/website-toolbar).

## End-to-end (E2E) tests

E2E tests use [Playwright](https://playwright.dev/) to drive the full playground application in Chromium, Firefox, and WebKit. They click, type, and verify what appears on screen, with no access to Lexical internals. Install the browsers first:

```bash
pnpm exec playwright install
```

Then start the playground and run the tests:

```bash
pnpm start &
pnpm test-e2e-chromium   # or -firefox, -webkit
```

Tests live under `packages/lexical-playground/__tests__/` in `e2e/` (feature coverage) and `regression/` (one test per reported bug) directories.

## When to use which tier

| What you're testing | Tier |
|---|---|
| Node creation, transforms, serialization | Unit (jsdom) |
| A node property's whole domain, not one example | Unit (jsdom), property-based |
| Command dispatch and handler logic | Unit (jsdom) |
| Extension registration and config | Unit (jsdom) |
| Real keystroke input and typing | Browser |
| IME composition (Korean, Japanese, Chinese) | Browser |
| Selection from user interaction | Browser |
| Clipboard paste with real `DataTransfer` | Browser |
| Full-application user scenarios | E2E |
| Cross-browser rendering differences | E2E |

## Running specific tests

Pass a filename filter to run a subset of tests:

```bash
pnpm test-unit LexicalReconciler
pnpm test-browser compose
```

vitest matches the filter against file paths, so any substring of the filename works.

## General guidelines

- New features must include tests.
- If it can break, it should have a test.
- Do not merge pull requests with failing tests — this blocks other people and releases.
