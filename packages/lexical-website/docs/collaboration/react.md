---
sidebar_position: 1
---

# React

Lexical provides `LexicalCollaborationPlugin` and `useCollaborationContext` hook within `@lexical/react` to accelerate creation of the collaborative React backed editors.
This is on top of the Yjs bindings provided by `@lexical/yjs`.


:::tip

Clone [Lexical GitHub repo](https://github.com/facebook/lexical), run `pnpm i && pnpm run start` and open [`http://localhost:3000/split/?isCollab=true`](http://localhost:3000/split/?isCollab=true) to launch playground in collaborative mode.

:::

## Getting started

This guide is based on [examples/react-rich](https://github.com/facebook/lexical/tree/main/examples/react-rich) example.

**Install minimal set of the required dependencies:**
```bash
$ npm i -S @lexical/react @lexical/yjs lexical react react-dom y-websocket yjs
```

:::note

`y-websocket` is the only officially supported Yjs connection provider at this point. Although other providers may work just fine.

:::

**Get WebSocket server running:**

This allows different browser windows and different browsers to find each other and sync Lexical state. On top of this `YPERSISTENCE` allows you to save Yjs documents in between server restarts so clients can simply reconnect and keep editing.

```bash
$ HOST=localhost PORT=1234 YPERSISTENCE=./yjs-wss-db npx y-websocket
```

**Get basic collaborative Lexical setup:**

```tsx
import { useCallback } from 'react';

import {$getRoot, $createParagraphNode, $createTextNode} from 'lexical';
import {LexicalCollaboration} from '@lexical/react/LexicalCollaborationContext';
import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {CollaborationPlugin} from '@lexical/react/LexicalCollaborationPlugin';
import * as Y from 'yjs';
import {$initialEditorState} from './initialEditorState';
import {WebsocketProvider} from 'y-websocket';

function Editor() {
  const initialConfig = {
    // NOTE: This is critical for collaboration plugin to set editor state to null. It
    // would indicate that the editor should not try to set any default state
    // (not even empty one), and let collaboration plugin do it instead
    editorState: null,
    namespace: 'Demo',
    nodes: [],
    onError: (error: Error) => {
      throw error;
    },
    theme: {},
  };

  const getDocFromMap = (id: string, yjsDocMap: Map<string, Y.Doc>): Y.Doc => {
    let doc = yjsDocMap.get(id);
  
    if (doc === undefined) {
      doc = new Y.Doc();
      yjsDocMap.set(id, doc);
    } else {
      doc.load();
    }

    return doc;
  }

  const providerFactory = useCallback(
    (id: string, yjsDocMap: Map<string, Y.Doc>) => {
      const doc = getDocFromMap(id, yjsDocMap);

      return new WebsocketProvider('ws://localhost:1234', id, doc, {
        connect: false,
      });
    }, [],
  );

  return (
    <LexicalCollaboration>
      <LexicalComposer initialConfig={initialConfig}>
        <RichTextPlugin
          contentEditable={<ContentEditable className="editor-input" />}
          placeholder={<div className="editor-placeholder">Enter some rich text...</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <CollaborationPlugin
          id="lexical/react-rich-collab"
          providerFactory={providerFactory}
        />
      </LexicalComposer>
    </LexicalCollaboration>
  );
}
```

**Initial editor content:**

In a production environment, you should bootstrap the editor's initial content on the server. If bootstrapping was left to the client and two clients connected at the same time, they could both try to initialize the content resulting in document corruption.

Using the `withHeadlessCollaborationEditor` function from the [FAQ](faq.md) page, you can create a bootstrapped `Y.Doc` with the following:

```tsx
import type {CreateEditorArgs} from 'lexical';

import {$getRoot, $createParagraphNode} from 'lexical';
import {Doc} from 'yjs';

import {withHeadlessCollaborationEditor} from './withHeadlessCollaborationEditor';

function createBootstrappedYDoc(nodes: CreateEditorArgs['nodes']): Doc {
  return withHeadlessCollaborationEditor(nodes, (editor) => {
    const yDoc = new Doc();
    editor.update(() => {
      $getRoot().append($createParagraphNode());
    }, {discrete: true});
    return yDoc;
  });
}
```

If you're simply following the above example to play around in a local dev environment, then you can add the following props to `CollaborationPlugin` to initialize the editor state client-side:

```tsx
// Dev-testing only, do not use in real-world cases.
initialEditorState={$initialEditorState}
shouldBootstrap={true}
```

## See it in action

Source code: [examples/react-rich-collab](https://github.com/facebook/lexical/tree/main/examples/react-rich-collab)

<iframe width="100%" height="600" src="https://stackblitz.com/github/facebook/lexical/tree/main/examples/react-rich-collab?embed=1&file=src%2FApp.tsx&terminalHeight=0&ctl=1&showSidebar=0&devtoolsheight=0&view=preview" sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"></iframe>

## Sharing one Yjs document between editors

By default a binding uses the `XmlText` shared type named `root` on the Yjs
`Doc`, so each editor needs its own document. Two options let several editors
live in one document instead, which is what applications like collaborative
sticky notes or comment threads usually want:

- `rootName` picks a different top-level shared type, one per editor:

```jsx
<CollaborationPlugin
  id={`note-${noteId}`}
  providerFactory={providerFactory}
  rootName={`note-${noteId}`}
  shouldBootstrap={true}
/>
```

- `getXmlText` resolves the root yourself, for roots that are not top-level
  shared types (for example an `XmlText` stored in a `Y.Map`). It takes
  precedence over `rootName`:

```jsx
const getXmlText = useCallback(
  (doc) => doc.getMap('notes').get(noteId),
  [noteId],
);

<CollaborationPlugin
  id={`note-${noteId}`}
  providerFactory={providerFactory}
  getXmlText={getXmlText}
  shouldBootstrap={true}
/>
```

Give each editor its own `id`, as above: the `id` keys the document map and the
remote-cursor highlight registry, both of which are shared across the page, so
two editors mounted under one `id` overwrite each other's entries.

Both options are also available on `createYjsBinding` for non-React usage.

:::warning

The root is chosen when the binding is created, and a mounted editor cannot be
repointed at another root: changing `rootName` or `getXmlText` afterwards has no
effect. To switch documents, remount the **editor** — put a `key` that changes
with the document on the component that owns the `LexicalComposer`. Remounting
only the plugin is not enough: the editor would keep the previous document's
content and write it into the newly selected root.

:::

`getXmlText` runs while the binding is constructed, before the provider has
synced, so it has to resolve the root from whatever the local `Doc` holds at
that moment — reaching into a `Y.Array` that the server has not sent yet throws.
Either mount the editor only once the note exists locally, or have the callback
create the missing shared type. Write it to be idempotent: it can run more than
once for one editor (React StrictMode double-invokes render, and a remount
builds a new binding), and a callback that unconditionally stores a new
`XmlText` would throw away what the previous call stored.

The returned `XmlText` is checked to be an `XmlText` that is integrated into the
document; that it is not already driving another live binding is yours to
guarantee, since a second binding over one root takes over the collab nodes
cached on its shared types.

The experimental `CollaborationPluginV2__EXPERIMENTAL` (and
`createBindingV2__EXPERIMENTAL`) take the same two options, except that its
root is an `XmlElement`, so the callback is named `getXmlElement`. Create that
element as `new Y.XmlElement()` without a `nodeName`, which is how the root is
recognized.

## Building collaborative plugins

[Lexical Playground](https://playground.lexical.dev/) features set of the collaboration enabled plugins that integrate with primary document via `useCollaborationContext()` hook. Notable mentions:

- [`CommentPlugin`](https://github.com/facebook/lexical/tree/main/packages/lexical-playground/src/plugins/CommentPlugin) - features use of the separate provider and Yjs room to sync comments.
- [`ImageComponent`](https://github.com/facebook/lexical/blob/main/packages/lexical-playground/src/nodes/ImageComponent.tsx) - features use of the `LexicalNestedComposer` paired with `CollaborationPlugin`.
- [`PollOptionComponent`](https://github.com/facebook/lexical/blob/main/packages/lexical-playground/src/nodes/PollComponent.tsx) - showcases poll implementation using `clientID` from Yjs context.
- [`StickyComponent`](https://github.com/facebook/lexical/blob/main/packages/lexical-playground/src/nodes/StickyComponent.tsx) - features use of the `LexicalNestedComposer` paired with `CollaborationPlugin` as well as sticky note position real-time sync.

:::note

While these "playground" plugins aren't production ready - they serve as a great example of collaborative Lexical capabilities as well as provide a good starting point.

:::

## Custom node property syncing

`@lexical/yjs` syncs custom node properties by constructing a fresh node instance and inspecting its **own enumerable properties**. This means every property that should be synced across peers must be assigned in the constructor, even if the initial value is `undefined`.

:::warning

Declaring a class property with TypeScript's optional syntax (`foo?: Type`) does **not** guarantee the property exists as an own enumerable property on the instance. Under TypeScript's default compilation settings (target < ES2022 without `useDefineForClassFields`), such declarations produce no initialization code.

:::

### What to do

Always initialize every node property in the constructor. Conditional initialization such as `if (someValue !== undefined) this.__someValue = someValue` is not enough, because the default construction path still needs to create the property.

For example:

```ts
// ✅ Correct — property is guaranteed to be an own property
class MyNode extends ElementNode {
  __someValue: string | undefined;

  constructor(someValue?: string, key?: NodeKey) {
    super(key);
    this.__someValue = someValue; // explicitly initialized
  }
}

// ❌ Incorrect — property may not exist as an own property
class MyNode extends ElementNode {
  __someValue?: string; // optional syntax without initialization

  constructor(key?: NodeKey) {
    super(key);
    // __someValue is never assigned → won't be synced via yjs
  }
}
```

If you use [`NodeState`](../concepts/node-state.md) for your custom properties, this concern does not apply. `NodeState` values are synced correctly without relying on constructor-created enumerable properties.

## Yjs providers

Setting up the communication between clients, managing awareness information, and storing shared data for offline usage is quite a hassle. Providers manage all that for you and are the perfect starting point for your collaborative app.

See [Yjs Website](https://docs.yjs.dev/ecosystem/connection-provider) for the list of the officially endorsed providers. Although it's not an exhaustive one.
