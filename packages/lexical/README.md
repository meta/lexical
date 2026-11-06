# `lexical`

[![See API Documentation](https://lexical.dev/img/see-api-documentation.svg)](https://lexical.dev/docs/api/modules/lexical)

Lexical is an extensible JavaScript web text-editor framework with an emphasis on reliability, accessibility, and performance. Lexical aims to provide a best-in-class developer experience, so you can easily prototype and build features with confidence. Combined with a highly extensible architecture, Lexical allows developers to create unique text editing experiences that scale in size and functionality.

The core of Lexical is a dependency-free text editor engine that allows for powerful, simple and complex,
editor implementations to be built on top. Lexical's engine provides three main parts:

- editor instances that each attach to a single content editable element.
- a set of editor states that represent the current and pending states of the editor at any given time.
- a DOM reconciler that takes a set of editor states, diffs the changes, and updates the DOM according to their state.

By design, the core of Lexical tries to be as minimal as possible.
Lexical doesn't directly concern itself with things that monolithic editors tend to do, such as UI components, toolbars, rich-text features or markdown. Instead,
those features are added to an editor as [extensions](https://lexical.dev/docs/extensions/intro) from optional packages, which are used as and when they're needed. This ensures great extensibility and keeps code sizes
to a minimum, so apps only pay the cost for what they actually import.

For React apps, the optional `@lexical/react` package provides React bindings, including `LexicalExtensionComposer`, which builds an editor from extensions and renders it.

## Usage

The `lexical` package contains the core Lexical engine and nodes, and the extension system that the other packages build on. Most applications build an editor with `buildEditorFromExtensions()` from `@lexical/extension` (or with `@lexical/react`), and add features such as rich text and history with the extensions from other `@lexical/*` packages.

## Working with Lexical

This section covers how to use Lexical independently of any framework or library. For React, see [Getting Started with React](https://lexical.dev/docs/getting-started/react).

### Creating an editor and using it

When you work with Lexical, you normally work with a single editor instance. An editor instance can be thought of as the one responsible
for wiring up an EditorState with the DOM. You build one from extensions: each extension bundles the nodes, configuration, commands and listeners for a feature, together with any extensions it depends on.

```js
import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {RichTextExtension} from '@lexical/rich-text';
import {defineExtension} from 'lexical';

const editor = buildEditorFromExtensions(
  defineExtension({
    dependencies: [RichTextExtension, HistoryExtension],
    name: '@my-app/editor',
    namespace: 'MyEditor',
    theme: {
      // ...
    },
  }),
);
```

Once you have an editor instance, when ready, you can associate the editor instance with a content editable `<div>` element in your document:

```js
const contentEditableElement = document.getElementById('editor');

editor.setRootElement(contentEditableElement);
```

If you want to clear the editor instance from the element, you can pass `null`. Alternatively, you can switch to another element if need be,
just pass an alternative element reference to `setRootElement()`. When you are done with the editor, call `editor.dispose()`.

An editor that never gets a root element does no DOM work at all, so the same code can run on a server or in tests.

### Understanding the Editor State

With Lexical, the source of truth is not the DOM, but rather an underlying state model
that Lexical maintains and associates with an editor instance. You can get the latest
editor state from an editor by calling `editor.getEditorState()`.

Editor states have two phases:

- During an update they can be thought of as "mutable". See "Updating an editor" below to
  mutate an editor state.
- After an update, the editor state is then locked and deemed immutable from there on. This
  editor state can therefore be thought of as a "snapshot".

Editor states contain two core things:

- The editor node tree (starting from the root node).
- The editor selection (which can be null).

Editor states are serializable to JSON, and the editor instance provides a useful method
to deserialize stringified editor states.

```js
const stringifiedEditorState = JSON.stringify(editor.getEditorState());

const newEditorState = editor.parseEditorState(stringifiedEditorState);
editor.setEditorState(newEditorState);
```

To start an editor with some content, give its extension an `$initialEditorState`: a stringified editor state, or a function that builds the content inside an update.

### Updating an editor

There are a few ways to update an editor instance:

- Trigger an update with `editor.update()`
- Setting the editor state via `editor.setEditorState()`
- Applying a change as part of an existing update via `editor.registerNodeTransform()`
- Using a command listener with `editor.registerCommand(EXAMPLE_COMMAND, () => {...}, priority)`

The most common way to update the editor is to use `editor.update()`. Calling this function
requires a function to be passed in that will provide access to mutate the underlying
editor state. When starting a fresh update, the current editor state is cloned and
used as the starting point. From a technical perspective, this means that Lexical leverages a technique
called double-buffering during updates. There's an editor state to represent what is current on
the screen, and another work-in-progress editor state that represents future changes.

Creating an update is typically an async process that allows Lexical to batch multiple updates together in
a single update, improving performance. When Lexical is ready to commit the update to
the DOM, the underlying mutations and changes in the update will form a new immutable
editor state. Calling `editor.getEditorState()` will then return the latest editor state
based on the changes from the update.

Here's an example of how you can update an editor instance:

```js
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';

// Inside the `editor.update` you can use special $ prefixed helper functions.
// These functions cannot be used outside the closure, and will error if you try.
// (If you're familiar with React, you can imagine these to be a bit like using a hook
// outside of a React function component).
editor.update(() => {
  // Get the RootNode from the EditorState
  const root = $getRoot();

  // Create a new ParagraphNode
  const paragraphNode = $createParagraphNode();

  // Create a new TextNode
  const textNode = $createTextNode('Hello world');

  // Append the text node to the paragraph
  paragraphNode.append(textNode);

  // Finally, append the paragraph to the root
  root.append(paragraphNode);
});
```

To read the editor state without changing it, use `editor.read()`, which also accepts the $ prefixed helper functions:

```js
const text = editor.read(() => $getRoot().getTextContent());
```

If you want to know when the editor updates so you can react to the changes, you can add an update
listener. The usual place to register one is the `register` function of your own extension, which is
called when the editor is built and cleans up when it is disposed:

```js
import {$getRoot, defineExtension} from 'lexical';

const WordCountExtension = defineExtension({
  name: '@my-app/WordCount',
  register: (editor) =>
    editor.registerUpdateListener(({editorState}) => {
      // The latest EditorState can be found as `editorState`.
      // To read its contents, pass `{editor}` so the $ prefixed helper
      // functions can find the editor too.
      editorState.read(
        () => {
          const words = $getRoot().getTextContent().split(/\s+/);
          console.log(words.filter(Boolean).length);
        },
        {editor},
      );
    }),
});
```

Add `WordCountExtension` to your editor's `dependencies` alongside the extensions it already uses.

To learn more, see the [Lexical documentation](https://lexical.dev/docs/intro).
