---
sidebar_position: 7
---

# FAQ

## Why does Lexical use the `$` prefix in the name of many of the functions?

Originally, Lexical didn't have `$` functions, instead these functions were provided to you through callback params:

```js
// Mid 2020 API
editor.update((viewState) => {
  const getRoot = viewState.getRoot();
  ..
});
editor.addTextTransform((viewState) => {
  const getRoot = viewState.getRoot();
  ..
});
```

Internally, this approach raised some negative feedback:

- The `viewState` terminology was confusing. It wasn't really a `viewState`, more like a toolkit to manipulate the `EditorState`
- For complex updates and transforms devs had to carry params around on many layers

This is when we decided to leverage the "lexical" scope instead to perform `EditorState` manipulation, and the `$` represents just that.

```js
editor.update(() => ...);
editor.registerNodeTransform(FooNode, () => ...);
editor.getEditorState().read(...);
```

If you've used React Hooks before, you can think of `$` functions as being something that follows a similar pattern. These are functions that show their intent as to where they can or cannot be used. This makes it possible for a developer to create their own functions that give the same signal, by simply prefixing the function with the dollar.

Internally, we've found this scales really well and developers get to grips with it in almost no time at all.

## When does reconciliation happen?

Reconciliation is scheduled with
[queueMicrotask](https://developer.mozilla.org/en-US/docs/Web/API/queueMicrotask),
which means that it will happen very soon, but asynchronously. This is similar
to something like `setTimeout(reconcile, 0)` with a bit more immediacy or
`Promise.resolve().then(reconcile)` with less overhead. This is done so
that all of the updates that occur as a result of a single logical event will
be batched into one reconciliation.

You can force a reconciliation to take place synchronously with the discrete
option to `editor.update` (demonstrated below).

## Why do tests use `await editor.update(…)`

You may notice that many tests look like this:

```js
await editor.update(updateA);
await editor.update(updateB);
```

An astute observer would notice that this seems very strange, since
`editor.update()` returns `void` and not `Promise<void>`. However,
it does happen to work as you would want it to because
the implementation of Promise uses the same microtask queue.

It's not recommended to rely on this in browser code as it could depend on
implementation details of the compilers, bundlers, and VM. It's best to stick
to using the `discrete` or the `onUpdate` callback options to be sure that
the reconciliation has taken place.

Ignoring any other microtasks that were scheduled elsewhere,
it is roughly equivalent to this synchronous code:

```js
editor.update(updateA, {discrete: true});
editor.update(updateB, {discrete: true});
```

At a high level, very roughly, the order of operations looks like this:

1. `editor.update()` is called
2. `updateA()` is called and updates the editor state
3. `editor.update()` schedules a reconciliation microtask and returns
4. `await` schedules a resume microtask and yields control to the task executor
5. the reconciliation microtask runs, reconciling the editor state with the DOM
6. the resume microtask runs

## How do I listen for user text insertions?

Listening to text insertion events is problematic with content editables in general. It's a common source of bugs due to how
different browsers and third-party extensions interact with the DOM. Whilst it's possible to use DOM events like `input` and
`beforeinput` to gauge some of the possible cases where a user has inserted text, these are hardly reliable and also don't
take into account edge-cases. Instead, Lexical prefers to consider any change as a possible user input, and as such doesn't
make a distinction between the cases. This is important for tools like spellcheck, browser extensions, IME, speech-to-text,
screen readers and other external tools that often don't reliably trigger a reliable event sequence (some don't even trigger
any events at all!).

For those wanting to react to a text change and possibly block/alter the intent, the recommended approach is to use a node
transform. This also plays nicely with other sub-systems at play that might also be looking to do the same thing as you.

For those who just want to know of the changes, this can be achieved using a text content listener or an editor update listener.

## How do I clear the contents of the editor?

You can go this by calling ```clear()``` on the RootNode in an update callback:

```js
editor.update(() => {
  $getRoot().clear();
})
```

## How do I listen to specific key down events?

You can leverage Lexical's command listening system. Lexical provides specific commands for many common keyboard operations, such as:

- `KEY_ARROW_LEFT_COMMAND`
- `KEY_ARROW_RIGHT_COMMAND`
- `KEY_ARROW_UP_COMMAND`
- `KEY_ARROW_DOWN_COMMAND`
- `KEY_SPACE_COMMAND`
- `KEY_ENTER_COMMAND`
- `KEY_BACKSPACE_COMMAND`
- `KEY_DELETE_COMMAND`
- `KEY_TAB_COMMAND`
- `KEY_ESCAPE_COMMAND`

```js
import {KEY_ENTER_COMMAND, COMMAND_PRIORITY_LOW} from 'lexical';

editor.registerCommand(KEY_ENTER_COMMAND, (event: KeyboardEvent) => {
  // Handle enter key presses here
  return false;
}, COMMAND_PRIORITY_LOW);
```

You can use the generic `KEY_DOWN_COMMAND` command to listen
to all keydown events. Do note, that returning `true` in your listener will prevent any
other key based commands from firing, so in most cases you'll want to return `false` from
the command listener.

```js
import {KEY_DOWN_COMMAND, COMMAND_PRIORITY_LOW} from 'lexical';

editor.registerCommand(KEY_DOWN_COMMAND, (event: KeyboardEvent) => {
  // Handle event here
  return false;
}, COMMAND_PRIORITY_LOW)
```

:::tip

If you do return `true` from any listener with an event payload, you likely
also should call `event.preventDefault()` unless your command relies on the
browser's native processing of that event.

:::

## Why do I get "does not implement .getType()" or "does not match registered node"?

```
LexicalNode: Node FooNode does not implement .getType().
Create node: Type heading in node HeadingNode does not match registered node HeadingNode with the same type
```

These almost always mean your app resolved **two copies of `lexical`**, not that
the node is misdeclared — the `instanceof` and registration checks compare class
references, and the two copies have different ones. Run `npm ls lexical` (or
`pnpm why lexical`) from the app root: it must report exactly one version.
See [One Lexical per app](concepts/one-lexical-per-app.md) for the causes and
the fix, including why a library must declare `lexical` in `peerDependencies`.

## Which module formats are published? (ESM, CommonJS, Node.js, React Native)

Every Lexical package is published as ES modules only. The packages declare
`"type": "module"`, and their `exports` maps offer a `development` and a
`production` build plus a `default` entry that picks one of the two at runtime
from `process.env.NODE_ENV`.

- **Bundlers** (webpack, Vite, Rollup, esbuild with the conditions set) resolve
  the `development` or `production` condition and get exactly one build.
- **Node.js** resolves `default`, which loads both builds and exports one. To
  load a single build, pass the condition on the command line:
  `node --conditions=production app.js` (or `--conditions=development`).
- **CommonJS** code can `require()` the packages on Node.js 20.19 or later,
  which loads ES modules from `require()` as long as nothing in the module
  graph uses top-level `await` (Lexical's builds do not). Older Node.js
  versions have to use `await import('lexical')` instead. Loading is all
  that `require()` guarantees: Lexical's builds import their own
  dependencies as ES modules, so a dependency that a CommonJS application
  also loads through `require()` can end up in the application twice, once
  per module system, with separate classes and module state. That breaks
  any integration that hands such a dependency's objects to Lexical, for
  example `yjs` documents given to `@lexical/yjs`, or `@preact/signals-core`
  effects observing signals from `@lexical/extension`. Load those
  dependencies as ES modules too (`await import('yjs')`), or move the
  application to ES modules.
- **React Native (Metro)** bundles the packages without extra configuration,
  but Metro does not set the `development`/`production` conditions and does
  not drop the build the `default` entry leaves unused, so both end up in the
  bundle. To bundle only the one that matches the build mode, add the
  condition for Lexical's packages in `metro.config.js`:

  ```js
  const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

  module.exports = mergeConfig(getDefaultConfig(__dirname), {
    resolver: {
      resolveRequest: (context, moduleName, platform) =>
        context.resolveRequest(
          /^(lexical|@lexical\/)/.test(moduleName)
            ? {
                ...context,
                unstable_conditionNames: [
                  ...context.unstable_conditionNames,
                  context.dev ? 'development' : 'production',
                ],
              }
            : context,
          moduleName,
          platform,
        ),
    },
  });
  ```

