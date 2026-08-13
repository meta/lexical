# Lexical Agent Guide

This file provides detailed guidance for AI agents and automated tools working with the Lexical codebase.

## Build, Test, and Development Commands

### Building
- `pnpm run build` - Build all packages in development mode
- `pnpm run build-prod` - Clean and build all packages in production mode
- `pnpm run build-release` - Build production release with error codes
- `pnpm run build-types` - Build TypeScript type definitions and validate them

### Testing
- `pnpm run test-unit` - Run all unit tests (Vitest, jsdom)
- `pnpm run test-unit-watch` - Run unit tests in watch mode
- `pnpm run test-browser` - Run browser-mode unit tests (Vitest + Playwright, real browser)
- `pnpm run test-browser-watch` - Run browser-mode tests in watch mode
- `pnpm run test-e2e-chromium` - Run E2E tests in Chromium (requires dev server running)
- `pnpm run test-e2e-firefox` - Run E2E tests in Firefox
- `pnpm run test-e2e-webkit` - Run E2E tests in WebKit
- `pnpm run debug-test-e2e-chromium` - Run E2E tests in debug mode (headed)
- `pnpm run debug-test-unit` - Debug unit tests with inspector

For E2E testing workflow:
1. Start the dev server: `pnpm run start` (or `pnpm run dev` if you don't need collab)
2. In another terminal: `pnpm run test-e2e-chromium`

### Development Servers
- `pnpm run start` - Start playground dev server + collab server (http://localhost:3000)
- `pnpm run dev` - Start only the playground dev server (no collab)
- `pnpm run start:website` - Start Docusaurus website (http://localhost:3001)
- `pnpm run collab` - Start collab server on localhost:1234

### Code Quality
- `pnpm run lint` - Run ESLint on all files
- `pnpm run lint:fix` - Auto-fix lint issues
- `pnpm run prettier` - Check code formatting
- `pnpm run prettier:fix` - Auto-fix formatting issues
- `pnpm run flow` - Run Flow type checker
- `pnpm run tsc` - Run TypeScript compiler
- `pnpm run ci-check` - Run all checks (TypeScript, Flow, Prettier, ESLint)

### Searching and refactoring

Prefer **ast-grep** over line-oriented regex (`grep`/`sed`) for anything
structural — matching or rewriting imports, call sites, JSX, type
annotations, etc. Regexes miss multi-line forms (a symbol on its own line
inside a multi-line `import { ... }` block) and produce false positives
(`IS_APPLE` matching inside `IS_APPLE_WEBKIT`); ast-grep matches the syntax
tree, so it does neither.

It isn't a dependency, so run it via npx (the CLI binary is `ast-grep`, not
the shadow-utils `sg` that may be on `PATH`):

```sh
# Find every import of something from '@lexical/utils' (ts and tsx are
# separate grammars, so pass -l for each; add --json=compact to post-process)
npx --package @ast-grep/cli ast-grep run \
  -p "import { \$\$\$NAMES } from '@lexical/utils'" -l ts packages
```

Metavariables (`$NAME`, `$$$LIST`) capture nodes for reporting or rewriting
with `--rewrite`. Reach for it whenever a change spans many files and must be
precise — e.g. moving symbols that `@lexical/utils` merely re-exports back to
a direct `lexical` import.

### Tree-shaking annotations

Module-scope calls to the side-effect-free factories (`defineExtension`,
`configExtension`, `safeCast`, `createCommand`, `createState`,
`defineImportRule`, etc.) must be annotated with `/* @__PURE__ */` so
bundlers can drop unused definitions from application bundles. This is
enforced (with an autofixer) by the
`@lexical/internal/require-pure-annotation` ESLint rule — run
`pnpm run lint:fix` (also run by the pre-commit hook) to insert the
annotations automatically. When adding a new factory of this kind,
annotate its definition with `@__NO_SIDE_EFFECTS__` and add its name to
the rule's default list in
`packages/lexical-eslint-plugin-internal/src/rules/require-pure-annotation.js`.

## High-Level Architecture

### Core Concepts

Lexical is built around several key architectural concepts that work together:

**Editor Instance** - Created via `createEditor()`, wires everything together. Manages the EditorState, registers listeners/commands/transforms, and handles DOM reconciliation.

**EditorState** - Immutable data model representing the editor content. Contains:
- A node tree (hierarchical structure of LexicalNodes)
- A selection object (current cursor/selection state)
- Fully serializable to/from JSON

**`$` Functions Convention** - Functions prefixed with `$` (e.g., `$getRoot()`, `$getSelection()`) can ONLY be called within:
- `editor.update(() => {...})` - for mutations
- `editor.read(() => {...})` - for read-only access
- Node transforms and command handlers (which have implicit update context)

This is similar to React hooks' restrictions but enforces synchronous context instead of call order.

**Double-Buffering Updates** - When `editor.update()` is called:
1. Current EditorState is cloned as work-in-progress
2. Mutations modify the work-in-progress state
3. Multiple synchronous updates are batched
4. DOM reconciler diffs and applies changes
5. New immutable EditorState becomes current

**Node Immutability & Keys** - All nodes are recursively frozen after reconciliation. Node methods automatically call `node.getWritable()` to create mutable clones. All versions of a logical node share the same runtime-only key, allowing node methods to always reference the latest version from the active EditorState.

### Monorepo Structure

This is a monorepo with packages in `packages/`:

**Core Packages:**
- `lexical` - Core framework (Editor, EditorState, base nodes, selection, updates)
- `@lexical/react` - React bindings (LexicalComposer, plugins as components)
- `@lexical/headless` - Headless editor for server-side/testing

**Feature Packages** (extend core with nodes/commands/utilities):
- `@lexical/rich-text` - Rich text editing (headings, quotes, etc.)
- `@lexical/plain-text` - Plain text editing
- `@lexical/extension` - Extend editor functionality
- `@lexical/list` - List nodes (ordered/unordered/checklist)
- `@lexical/table` - Table support
- `@lexical/code` - Code block with syntax highlighting
- `@lexical/link` - Link nodes and utilities
- `@lexical/markdown` - Markdown import/export
- `@lexical/html` - HTML serialization
- `@lexical/history` - Undo/redo
- `@lexical/yjs` - Real-time collaboration via Yjs
- And many more...

**Development Packages:**
- `lexical-playground` - Full-featured demo application
- `lexical-website` - Docusaurus documentation site

### Key Architectural Patterns

**Extensions** - Extensions should be used to add features and configuration
to an editor. The set of extensions in an editor must be determined when the
editor is created with `buildEditorFromExtensions`. Extensions with
functionality that can be toggled on or off typically have a `disabled`
configuration property and output signal that defaults to `false`. See the
lexical-extension package and the supporting code in lexical for
more examples and implementation details.

```tsx
export interface MyConfig {
  disabled: boolean;
}
export const MyExtension = defineExtension({
  build: (_editor, config, _state) => namedSignals(config),
  config: safeCast<MyConfig>({ disabled: false }),
  name: '@lexical/docs/My',
  nodes: () => [MyNode],
  register: (editor, _config, state) => {
    const {disabled} = state.getOutput();
    return effect(() => {
      if (!disabled.value) {
        return editor.registerUpdateListener(({editorState}) => {
          // React to updates
        });
      }
    })
  },
})
```

**Plugin System (React)** - Plugins are a legacy pattern for React components
to hook into the editor lifecycle, extensions should be preferred for new code:
```jsx
function MyPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerUpdateListener(({editorState}) => {
      // React to updates
    });
  }, [editor]);
  return null;
}
```

**Command Pattern** - Commands are the primary communication mechanism:
- Create with `createCommand()`
- Dispatch with `editor.dispatchCommand(command, payload)`
- Handle with `editor.registerCommand(command, handler, priority)`
- Handlers propagate by priority until one stops propagation

**Node Transforms** - Registered via `editor.registerNodeTransform(NodeClass, transform)`. Called automatically during updates when nodes of that type change. Have implicit update context.

**Listeners** - All `editor.register*()` methods return cleanup functions for easy unsubscription.

## Type System

This codebase uses **both TypeScript and Flow**:
- Source files are primarily TypeScript (`.ts`, `.tsx`)
- Flow type definitions are generated in `packages/*/flow/` directories
- Run `pnpm run flow` to check Flow types
- Run `pnpm run tsc` to check TypeScript types
- Both are checked in CI via `pnpm run ci-check`

When adding/modifying APIs, types must be maintained for both systems.

## Backwards Compatibility

**All changes MUST be backwards compatible.** Lexical is a widely-adopted OSS library, and breaking changes ripple out to every downstream consumer.

- Do NOT remove or rename existing public APIs, exported functions, types, or `$` functions. Add new APIs alongside the old ones instead.
- Do NOT change the signature, return type, or behavior of existing public APIs in ways that could break callers. Prefer additive, optional parameters.
- Preserve the serialization format of `EditorState` and node JSON. Serialized content produced by older versions must continue to deserialize correctly.
- If an API genuinely must change, deprecate the old one first (keep it working, document the replacement) rather than removing it outright.
- When in doubt, assume external code depends on the current behavior and keep it intact.

## Important Development Notes

### Reconciliation and Updates
- `editor.read(...)`  or `editor.read('force-commit', ...)` flushes pending updates first, then provides consistent reconciled state
- `editor.read('pending', ...)` reads the pending state (like `editor.update(...)`, but read-only)
- `editor.read('latest', ...)` reads the latest consistent reconciled state
- Inside `editor.update()`, you see pending state (transforms/reconciliation not yet run)
- `editor.getEditorState().read()` always uses latest reconciled state, but prefer `editor.read('latest', ...)` in new code
- Updates can be nested: `editor.update(() => editor.update(...))` is allowed but strongly discouraged
- Do NOT nest updates in reads, or use a force-commit in an update

### Node References
Always access node properties/methods within read/update context. Nodes automatically resolve to their latest version via their key. Don't store node references across update boundaries.

### Testing Strategy
- **Unit tests** - Vitest (jsdom), located in `packages/**/__tests__/unit/**/*.test.{ts,tsx}`
- **Browser tests** - Vitest browser mode driven by the Playwright runner, located in
  `packages/**/__tests__/browser/**/*.test.{ts,tsx}`. Use these for behavior that depends on
  a real layout/selection engine instead of stubbing the missing jsdom functionality from
  `vitest.setup.mts` (e.g. `Range.getBoundingClientRect`, the Selection API). Run with
  `pnpm run test-browser`; the browser set is controlled by the `VITEST_BROWSER` env var
  (comma-separated, default `chromium`). Prefer building editors with the extension APIs
  (`buildEditorFromExtensions`, or `LexicalExtensionComposer`/`LexicalExtensionEditorComposer`
  in React).
  - **Do not use `using`/`Disposable` in browser tests (or any browser-facing code).**
    Explicit Resource Management (`using`, `Symbol.dispose`, `Disposable`) is not supported
    in WebKit/Safari yet, so the syntax throws a `SyntaxError` there. `using` is fine in unit
    tests (jsdom/Node), but browser tests should clean up with
    `onTestFinished(() => editor.dispose())` instead — `editor.dispose()` is a plain method
    available on the result of `buildEditorFromExtensions`.
- **E2E tests** - Playwright, located in `packages/lexical-playground/__tests__/e2e/**/*.spec.{ts,mjs}`
- E2E tests require the playground dev server running
- Use `pnpm run debug-test-e2e-chromium` to debug E2E tests with browser UI

### Custom Nodes
When creating custom nodes:
1. Extend a base node class (TextNode, ElementNode, DecoratorNode)
2. Implement instance methods: `$config()`, `createDOM()`, `updateDOM()`
3. Register with extension or editor config: `nodes: [YourCustomNode]`
4. Export a `$createYourNode()` factory function (follows $ convention)

### Shadow DOM and iframe realm safety

Lexical supports editors whose root element lives inside a Shadow DOM or an
`<iframe>` document. The editor resolves its `window` and `document` from
`rootElement.ownerDocument.defaultView`, so code that reaches for the **global**
`window` or `document` will silently use the wrong realm when the editor crosses
a frame boundary. Shadow DOM adds a second hazard: the browser **retargets**
selection and focus reads to the shadow host, hiding the real nodes.

Use the shadow/iframe-aware helpers exported from `lexical` instead of the raw
browser globals:

| Instead of | Use | Why |
| --- | --- | --- |
| `window` | `element.ownerDocument.defaultView` or `getDefaultView(element)` (@internal) | Returns the window that owns the element |
| `window.getSelection()` | `getDOMSelection(rootElement.ownerDocument.defaultView)` | Reads selection from the correct window |
| `selection.getRangeAt(0)` | `getDOMSelectionRange(selection, rootElement)` | Unwraps retargeted shadow-DOM selection |
| `document` in `createDOM`/`updateDOM`/`exportDOM` | `$getDocument()` | Returns the document that owns the editor root (falls back to `globalThis.document`) |
| `document` elsewhere | `getRootOwnerDocument(rootElement)` or `element.ownerDocument` | Returns the document that owns a specific element |
| `document.activeElement` | `getActiveElement(element)` / `getActiveElementDeep(document)` | Walks through shadow roots to find the real focused element |
| `event.target` | `getComposedEventTarget(event)` | Returns the un-retargeted target for composed events |
| `element.parentElement` | `getParentElement(element)` | Crosses shadow boundaries correctly |
| `selection.anchorNode` / `focusNode` | `getDOMSelectionPoints(selection, rootElement)` | Returns un-retargeted boundary points |

Two ESLint rules enforce the globals rows at lint time:
- `no-restricted-syntax` (error) catches all `document.*` and `window.*` member access in library sources.
- `@lexical/no-document-in-dom-methods` (error, with autofix) catches `document.*` specifically inside `createDOM`/`updateDOM`/`exportDOM` methods and autofixes to `$getDocument().*`.

The remaining rows involve local variable properties that lint cannot reliably detect, so they must be caught in code review.

For full details on the browser platform APIs involved, see
[Shadow DOM and iframes](packages/lexical-website/docs/concepts/shadow-dom.md).

### Commits and Pull Requests
Every commit message — not just PR bodies — must be written to the shape of
`.github/pull_request_template.md`, so any commit can seed a PR directly
without being rewritten. This applies to every commit you author, including
one-line fixes; do not wait to be asked. Read the template rather than working
from memory, and fill in its sections:

- **Subject line**: `[Affected Packages] PR Type: title`, where the packages are
  the directory names under `packages/` that the diff touches and the type is
  one of Breaking change / Refactor / Feature / Bug Fix / Documentation Update /
  Chore. Test-only and tooling changes are `Chore`.
- **`## Description`**: what the current behavior is and what this change makes
  it do. Add `Closes #<issue>` only when there is a real issue number; drop the
  line otherwise rather than leaving the template's placeholder behind.
- **`## Test plan`** with `### Before` and `### After` subsections: the command
  you ran, plus the actual failing output before and passing output after.
  Paste real output — do not describe it. If a platform or browser in the
  matrix could not be exercised, say so explicitly under `### After`.

Drop any template section that does not apply to the diff instead of carrying
an empty heading, and treat the template's HTML comments as instructions to
follow, not text to copy into the message.

### Commit and PR Hygiene for Agents
This is an open source project: never include agent-session URLs or other
private/team-internal links (e.g. `https://claude.ai/code/session_...`) in
commit messages, PR titles, or PR bodies. Those URLs are private to the
person or team that ran the session and are meaningless or misleading to
everyone else. Co-authorship attribution (e.g. `Co-Authored-By:`) is fine.
For Claude Code this is enforced mechanically via `attribution.sessionUrl:
false` in the checked-in `.claude/settings.json`; agents from other vendors
should follow this rule as written.

### Build System
- Uses Rollup for bundling
- Build script: `scripts/build.mjs`
- Supports multiple build modes: development, production, www (Meta internal)
- TypeScript source → compiled to CommonJS and ESM
- Package manager logic in `scripts/shared/packagesManager.mjs`
