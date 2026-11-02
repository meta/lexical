---
sidebar_position: 2
---

# Collaboration FAQ

## Source of truth: Lexical State, Yjs and App's DB

It's recommended to treat the Yjs model as the source of truth. You can store the document to a database for indexing.
But, if possible, you should never forget the Yjs model, as this is the only way clients without internet access can reliably join and sync with the server.

You can also treat the database as the source of truth. This is how it could be achieved:

- Clients receive a `sessionId` when they connect to the server
- When a client connects without an existing `sessionId`, get the content from the database and create a `sessionId`
- When all clients disconnect, forget the room content and `sessionId` on the server after some timeout (e.g. 1 hour)
- When a client reconnects, use that content on the server. Furthermore, get the `sessionId` from the client
- When two clients with different `sessionId` reconnect, one of the clients should forget the room content. _In this case the client will lose content_ - although it is very unlikely if you set the forget timeout (see point 2) very high.

Or, there is an ever simpler approach:

- When a client connects to the server, the server populates the room content if empty
- When all clients disconnect, the server forgets the room content after some timeout (e.g. 1 hour)
- When a client was not able to reconnect for 40 minutes, the client must forget its local updates and start fresh (this should be enforced by the server)

When the database is the source of truth, and if you want to be able to forget the Yjs model, you will always run into cases where clients are not able to commit changes. That's not too bad in most projects. It somehow limits you, because you can't cache the document on the client using y-indexeddb. On the other hand, it is much easier to maintain, and do Yjs upgrades. Furthermore, most people would say that SQL is a bit more reliable than Yjs.

_* Based on the advice of the Yjs author - [Kevin Jahns](https://github.com/yjs/yjs/issues/82#issuecomment-328365015)_


With `@lexical/y`, store the document's Yjs state, load it into a relay or
server with `createYDoc(stored)`, and create new documents in one place with
`seedYState` (see [Servers](./y.md#servers) and
[Server-side editing](./y-server.md)).

## Initializing `EditorState` from Yjs Document

This section is about `@lexical/yjs` (Yjs 13). For a `@lexical/y` (Yjs 14)
document, `readYState` from `@lexical/y/headless` does it in one call (see
[Server-side editing](./y-server.md)):

```ts
import {readYState} from '@lexical/y/headless';
import {$getEditor} from 'lexical';

const json = readYState(state, {extensions, schemaVersion}, () =>
  $getEditor().getEditorState().toJSON(),
);
```

With `@lexical/yjs`, it's achievable by leveraging headless Lexical and
no-op provider for Yjs:

<details>
  <summary>createHeadlessCollaborativeEditor.ts</summary>

  ```typescript
  import type {Binding, Provider} from '@lexical/yjs';
  import type {
    Klass,
    LexicalEditor,
    LexicalNode,
    LexicalNodeReplacement,
    SerializedEditorState,
  } from 'lexical';

  import {createHeadlessEditor} from '@lexical/headless';
  import {
    createBinding,
    syncLexicalUpdateToYjs,
    syncYjsChangesToLexical,
  } from '@lexical/yjs';
  import {type YEvent, applyUpdate, Doc, Transaction} from 'yjs';

  export default function headlessConvertYDocStateToLexicalJSON(
    nodes: ReadonlyArray<Klass<LexicalNode> | LexicalNodeReplacement>,
    yDocState: Uint8Array,
  ): SerializedEditorState {
    return withHeadlessCollaborationEditor(nodes, (editor, binding) => {
      applyUpdate(binding.doc, yDocState, {isUpdateRemote: true});
      editor.update(() => {}, {discrete: true});

      return editor.getEditorState().toJSON();
    });
  }

  /**
   * Creates headless collaboration editor with no-op provider (since it won't
   * connect to message distribution infra) and binding. It also sets up
   * bi-directional synchronization between yDoc and editor
   */
  export function withHeadlessCollaborationEditor<T>(
    nodes: ReadonlyArray<Klass<LexicalNode> | LexicalNodeReplacement>,
    callback: (editor: LexicalEditor, binding: Binding, provider: Provider) => T,
  ): T {
    const editor = createHeadlessEditor({
      nodes,
    });

    const id = 'main';
    const doc = new Doc();
    const docMap = new Map([[id, doc]]);
    const provider = createNoOpProvider();
    const binding = createBinding(editor, provider, id, doc, docMap);

    const unsubscribe = registerCollaborationListeners(editor, provider, binding);

    const res = callback(editor, binding, provider);

    unsubscribe();

    return res;
  }

  function registerCollaborationListeners(
    editor: LexicalEditor,
    provider: Provider,
    binding: Binding,
  ): () => void {
    const unsubscribeUpdateListener = editor.registerUpdateListener(
      ({
        dirtyElements,
        dirtyLeaves,
        editorState,
        normalizedNodes,
        prevEditorState,
        tags,
      }) => {
        if (tags.has('skip-collab') === false) {
          syncLexicalUpdateToYjs(
            binding,
            provider,
            prevEditorState,
            editorState,
            dirtyElements,
            dirtyLeaves,
            normalizedNodes,
            tags,
          );
        }
      },
    );

    const observer = (events: Array<YEvent<any>>, transaction: Transaction) => {
      if (transaction.origin !== binding) {
        syncYjsChangesToLexical(binding, provider, events, false);
      }
    };

    binding.root.getSharedType().observeDeep(observer);

    return () => {
      unsubscribeUpdateListener();
      binding.root.getSharedType().unobserveDeep(observer);
    };
  }

  function createNoOpProvider(): Provider {
    const emptyFunction = () => {};

    return {
      awareness: {
        getLocalState: () => null,
        getStates: () => new Map(),
        off: emptyFunction,
        on: emptyFunction,
        setLocalState: emptyFunction,
        setLocalStateField: emptyFunction,
      },
      connect: emptyFunction,
      disconnect: emptyFunction,
      off: emptyFunction,
      on: emptyFunction,
    };
  }
  ```
</details>
