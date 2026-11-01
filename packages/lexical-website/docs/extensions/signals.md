# Signals

Lexical Extensions uses signals as the reactive interface that you can use to
communicate with and between extensions.

## Motivation

At the lowest level, communicating between parts of Lexical is done with
callbacks such as `registerCommand`, `registerUpdateListener`,
`registerMutationListener`, and `addEventListener` with the DOM.

How these callbacks behave and in some cases whether they are registered
at all depends on state local to the extension that may also be mutable,
so would require a similar callback mechanism with a naïve implementation.
With legacy React plug-ins, this mechanism is `useEffect` which is very
coarse and doesn't really have a portable equivalent when using other
or no framework.

The initial prototype was largely callback based as well, but this quickly
becomes very difficult to work with when you have to do work based on
the "result" of multiple callbacks or configuration values. Signals are
a more general solution to this problem. There's even a
[TC39 Signals Proposal](https://github.com/tc39/proposal-signals) to add
infrastructure for this to the JavaScript standard.

Signals also allow for optimizations by reducing redundant callbacks with
primitives such as `batch` or by allowing the current value to be inspected
with `peek` without adding any subscription. Basically, the same Signal can
be used either like React State when you want to run code as the value changes
over time, or like a React Ref when you only need to know the current value
(as is typical with event handlers).

Signals also do not require you to manage a dependency array or use a
compiler, the subscriptions and dependencies are inferred at runtime
as they are used. This means that the set of signals subscribed to by a
given effect can change without violating any rules or generating any
warnings.

## Implementation

Since Signals are not yet standardized, and the
[signal-polyfill](https://github.com/proposal-signals/signal-polyfill) is not
ready for production use, it was decided to leverage
[@preact/signals-core](https://github.com/preactjs/signals). This
implementation is dependency-free, optimized, and well tested.

For future compatibility we *do not recommend* that you use
`@preact/signals-core` directly, and instead use the re-exports from
[@lexical/extension](https://lexical.dev/docs/api/modules/lexical_extension).

As of the initial release, these re-exports are:

```ts
export {
  batch,
  computed,
  effect,
  type ReadonlySignal,
  type Signal,
  signal,
  type SignalOptions,
  untracked,
} from '@preact/signals-core';
```

## Usage

For thorough examples on how the signal primitives work, you can read through the
[Preact Signals](https://preactjs.com/guide/v10/signals/) documentation.

Lexical provides the following higher-level signal functions to make it easier
to build extensions:

### namedSignals

[namedSignals](/docs/api/modules/lexical_extension#namedsignals)
is a convenience function used to output independent signals from
each property of a configuration object.

```ts
export interface TabIndentationConfig {
  disabled: boolean;
  maxIndent: null | number;
  /**
   * By default, indents are set on all elements for which the
   * {@link ElementNode.canIndent} returns true. This option allows you to set
   * indents for specific nodes without overriding the method for others.
   */
  $canIndent: CanIndentPredicate;
}

export const TabIndentationExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: safeCast<TabIndentationConfig>({
    $canIndent: $defaultCanIndent,
    disabled: false,
    maxIndent: null,
  }),
  name: '@lexical/extension/TabIndentation',
  register(editor, config, state) {
    const {disabled, maxIndent, $canIndent} = state.getOutput();
    return effect(() => {
      if (!disabled.value) {
        // This register function's implementation uses peek on the maxIndent
        // signal to get its current value when needed, no need to re-register
        // every time this value changes.
        return registerTabIndentation(editor, maxIndent, $canIndent);
      }
    });
  },
});
```

### watchedSignal

[watchedSignal](/docs/api/modules/lexical_extension#watchedsignal)
is equivalent to React's [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)

```ts
export const EditorStateExtension = defineExtension({
  build(editor) {
    return watchedSignal(
      () => editor.getEditorState(),
      (editorStateSignal) =>
        editor.registerUpdateListener((payload) => {
          editorStateSignal.value = payload.editorState;
        }),
    );
  },
  name: '@lexical/extension/EditorState',
});
```
