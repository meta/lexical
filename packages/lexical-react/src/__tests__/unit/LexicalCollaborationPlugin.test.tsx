/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {InitialEditorStateType} from '@lexical/react/LexicalComposer';
import type {Provider} from '@lexical/yjs';
import type {ElementNode, LexicalEditor} from 'lexical';

import {LexicalCollaboration} from '@lexical/react/LexicalCollaborationContext';
import {
  CollaborationPlugin,
  CollaborationPluginV2__EXPERIMENTAL,
} from '@lexical/react/LexicalCollaborationPlugin';
import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  UNDO_COMMAND,
} from 'lexical';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {beforeEach, describe, expect, test, vi} from 'vitest';
import * as Y from 'yjs';

/**
 * A minimal in-memory {@link Provider} that reports a completed sync, which is
 * what drives the `shouldBootstrap` code path. By default `connect()` syncs
 * immediately; with `autoSync: false` the caller decides when, via `emitSync`,
 * so a test can settle the mount first and control what commits next.
 */
function createSyncedProvider({autoSync = true} = {}): Provider & {
  emitSync: () => void;
} {
  const listeners = new Map<string, Set<(arg: never) => void>>();
  const emitSync = () => {
    const syncListeners = listeners.get('sync');
    if (syncListeners !== undefined) {
      for (const cb of Array.from(syncListeners)) {
        (cb as (isSynced: boolean) => void)(true);
      }
    }
  };

  // A working awareness store (rather than a stub), so tests can observe what
  // the binding publishes about the local user -- notably the cursor position,
  // which is resolved through `binding.collabNodeMap`.
  let localState: Record<string, unknown> | null = null;

  return {
    awareness: {
      getLocalState: () => localState,
      getStates: () => new Map(),
      off: () => {},
      on: () => {},
      setLocalState: (state: Record<string, unknown> | null) => {
        localState = state;
      },
      setLocalStateField: (field: string, value: unknown) => {
        if (localState !== null) {
          localState = {...localState, [field]: value};
        }
      },
    },
    connect: () => {
      if (autoSync) {
        emitSync();
      }
    },
    disconnect: () => {},
    emitSync,
    off: (type: string, cb: (arg: never) => void) => {
      const set = listeners.get(type);
      if (set !== undefined) {
        set.delete(cb);
      }
    },
    on: (type: string, cb: (arg: never) => void) => {
      let set = listeners.get(type);
      if (set === undefined) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(cb);
    },
  } as Provider & {emitSync: () => void};
}

/** The content every bootstrap test starts the shared document with. */
function $appendInitialContent(): void {
  const paragraph = $createParagraphNode();
  paragraph.append($createTextNode('Initial content'));
  $getRoot().append(paragraph);
}

/**
 * The same content as a serialized editor state. `initialEditorState` accepts
 * this form too, and it reaches the editor through `editor.setEditorState`
 * rather than a plain `editor.update`, so it commits on a different schedule
 * and is worth covering separately.
 */
function serializedInitialContent(): string {
  const editor = createEditor({
    namespace: 'serializer',
    onError(error: Error) {
      throw error;
    },
  });
  editor.update($appendInitialContent, {discrete: true});
  return JSON.stringify(editor.getEditorState());
}

type TestProvider = Provider & {
  _connectCount: number;
  _disconnectCount: number;
};

/** A minimal in-memory {@link Provider} that records connect/disconnect calls. */
function createTestProvider(): TestProvider {
  const provider: TestProvider = {
    _connectCount: 0,
    _disconnectCount: 0,
    awareness: {
      getLocalState: () => null,
      getStates: () => new Map(),
      off: () => {},
      on: () => {},
      setLocalState: () => {},
      setLocalStateField: () => {},
    },
    connect: () => {
      provider._connectCount++;
    },
    disconnect: () => {
      provider._disconnectCount++;
    },
    off: () => {},
    on: () => {},
  };

  return provider;
}

describe(`LexicalCollaborationPlugin`, () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  const editorConfig = Object.freeze({
    // NOTE: This is critical for collaboration plugin to set editor state to null. It
    // would indicate that the editor should not try to set any default state
    // (not even empty one), and let collaboration plugin do it instead
    editorState: null,
    namespace: 'Test editor',
    nodes: [],
    // Handling of errors during update
    onError(error: Error) {
      throw error;
    },
  });

  beforeEach(() => {
    container = document.createElement('div');
    reactRoot = createRoot(container);
    document.body.appendChild(container);
  });

  test(`providerFactory called only once`, () => {
    const providerFactory = vi.fn(
      (id: string, yjsDocMap: Map<string, Y.Doc>) => {
        const doc = new Y.Doc();
        yjsDocMap.set(id, doc);

        return {
          awareness: {
            getLocalState: () => null,
            getStates: () => new Map(),
            off: () => {},
            on: () => {},
            setLocalState: () => {},
            setLocalStateField: () => {},
          },
          connect: () => {},
          disconnect: () => {},
          off: () => {},
          on: () => {},
        };
      },
    );
    function MemoComponent() {
      return (
        <LexicalCollaboration>
          <LexicalComposer initialConfig={editorConfig}>
            {/* With CollaborationPlugin - we MUST NOT use @lexical/react/LexicalHistoryPlugin */}
            <CollaborationPlugin
              id="lexical/react-rich-collab"
              providerFactory={providerFactory}
              // Unless you have a way to avoid race condition between 2+ users trying to do bootstrap simultaneously
              // you should never try to bootstrap on client. It's better to perform bootstrap within Yjs server.
              shouldBootstrap={false}
            />
            <RichTextPlugin
              contentEditable={<ContentEditable className="editor-input" />}
              placeholder={
                <div className="editor-placeholder">
                  Enter some rich text...
                </div>
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
          </LexicalComposer>
        </LexicalCollaboration>
      );
    }
    act(() => {
      reactRoot.render(
        <React.StrictMode>
          <MemoComponent />
        </React.StrictMode>,
      );
    });

    expect(providerFactory).toHaveBeenCalledTimes(1);
  });

  /**
   * Render a collaborative editor against an empty shared document, so the
   * `shouldBootstrap` path writes `initialEditorState` into it.
   */
  async function renderBootstrapped(
    initialEditorState: InitialEditorStateType,
    {
      autoSync = true,
      onError,
    }: {autoSync?: boolean; onError?: (error: Error) => void} = {},
  ): Promise<{
    editor: LexicalEditor;
    readText: () => string;
    sync: () => Promise<void>;
  }> {
    const doc = new Y.Doc();
    const provider = createSyncedProvider({autoSync});
    let editor: LexicalEditor | null = null;

    function CaptureEditor() {
      [editor] = useLexicalComposerContext();
      return null;
    }

    function App() {
      return (
        <LexicalCollaboration>
          <LexicalComposer
            initialConfig={
              onError === undefined ? editorConfig : {...editorConfig, onError}
            }>
            <CaptureEditor />
            <CollaborationPlugin
              id="main"
              providerFactory={(id, yjsDocMap) => {
                yjsDocMap.set(id, doc);
                return provider;
              }}
              shouldBootstrap={true}
              initialEditorState={initialEditorState}
            />
            <RichTextPlugin
              contentEditable={<ContentEditable />}
              placeholder={<></>}
              ErrorBoundary={LexicalErrorBoundary}
            />
          </LexicalComposer>
        </LexicalCollaboration>
      );
    }

    await act(async () => {
      reactRoot.render(<App />);
    });

    const activeEditor = editor!;
    return {
      editor: activeEditor,
      readText: () =>
        activeEditor.getEditorState().read(() => $getRoot().getTextContent()),
      sync: async () => {
        await act(async () => {
          provider.emitSync();
        });
      },
    };
  }

  // https://github.com/facebook/lexical/issues/7110
  test(`the bootstrapped initialEditorState can not be undone`, async () => {
    const {editor, readText} = await renderBootstrapped($appendInitialContent);
    expect(readText()).toBe('Initial content');

    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    });

    expect(readText()).toBe('Initial content');
  });

  // The `setEditorState` form commits from inside the bootstrap update instead
  // of from the microtask that follows it, so it exercises a different point in
  // the flag's lifetime than the callback form above.
  test(`a bootstrapped serialized initialEditorState can not be undone`, async () => {
    const {editor, readText} = await renderBootstrapped(
      serializedInitialContent(),
    );
    expect(readText()).toBe('Initial content');

    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    });

    expect(readText()).toBe('Initial content');
  });

  // Undo is suppressed by a flag that is only meant to cover the bootstrap
  // write. A regression that left it set would silently disable undo for the
  // rest of the session, which the assertions above would not catch.
  test(`an edit made after bootstrapping is still undoable`, async () => {
    const {editor, readText} = await renderBootstrapped($appendInitialContent);
    expect(readText()).toBe('Initial content');

    await act(async () => {
      editor.update(() => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode(' and more'));
        $getRoot().append(paragraph);
      });
    });
    expect(readText()).toBe('Initial content\n\n and more');

    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    });
    expect(readText()).toBe('Initial content');
  });

  // A bootstrap update that throws still has to release the flag that keeps the
  // bootstrap write out of the undo stack. Lexical reports the error, commits
  // (so the update listeners — and the Yjs write — still run) and skips that
  // commit's deferred callbacks, so a reset that only rides on `onUpdate` is
  // left queued and does not land until the tail of the *next* commit, by which
  // point that commit's listener has already written to Yjs with the flag set.
  // Syncing on demand rather than from `connect()` keeps the user's edit the
  // first commit after the failure, which is what makes that visible.
  test(`an edit after a failed bootstrap is still undoable`, async () => {
    const errors: Error[] = [];
    const {editor, readText, sync} = await renderBootstrapped(
      () => {
        throw new Error('bootstrap failed');
      },
      {autoSync: false, onError: error => errors.push(error)},
    );

    await sync();
    expect(errors.map(error => error.message)).toEqual(['bootstrap failed']);

    await act(async () => {
      editor.update(() => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('typed after the failure'));
        $getRoot().append(paragraph);
      });
    });
    expect(readText()).toBe('typed after the failure');

    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    });
    expect(readText()).not.toBe('typed after the failure');
  });
  // https://github.com/facebook/lexical/issues/7136
  test(`provider is replaced when providerFactory changes`, () => {
    const doc = new Y.Doc();
    const providerA = createTestProvider();
    const providerB = createTestProvider();

    const factoryA = vi.fn((id: string, yjsDocMap: Map<string, Y.Doc>) => {
      yjsDocMap.set(id, doc);
      return providerA;
    });
    const factoryB = vi.fn((id: string, yjsDocMap: Map<string, Y.Doc>) => {
      yjsDocMap.set(id, doc);
      return providerB;
    });

    function App({
      providerFactory,
    }: {
      providerFactory: (id: string, yjsDocMap: Map<string, Y.Doc>) => Provider;
    }) {
      return (
        <LexicalCollaboration>
          <LexicalComposer initialConfig={editorConfig}>
            <CollaborationPlugin
              id="main"
              providerFactory={providerFactory}
              shouldBootstrap={false}
            />
            <RichTextPlugin
              contentEditable={<ContentEditable />}
              placeholder={<></>}
              ErrorBoundary={LexicalErrorBoundary}
            />
          </LexicalComposer>
        </LexicalCollaboration>
      );
    }

    act(() => {
      reactRoot.render(<App providerFactory={factoryA} />);
    });

    expect(factoryA).toHaveBeenCalledTimes(1);
    expect(providerA._connectCount).toBe(1);

    act(() => {
      reactRoot.render(<App providerFactory={factoryB} />);
    });

    expect(factoryB).toHaveBeenCalledTimes(1);
    expect(providerB._connectCount).toBe(1);
    // The superseded provider is torn down.
    expect(providerA._disconnectCount).toBeGreaterThan(0);
  });

  test(`an inline providerFactory keeps its provider connected`, () => {
    const doc = new Y.Doc();
    const provider = createTestProvider();

    // Declared inline, the way this package's own test harness does it, so the
    // factory has a fresh identity on every render while handing back the same
    // provider. Re-rendering must not tear that provider down: nothing would
    // reconnect it, because setProvider() bails on the identical value.
    function App() {
      return (
        <LexicalCollaboration>
          <LexicalComposer initialConfig={editorConfig}>
            <CollaborationPlugin
              id="main"
              providerFactory={(id: string, yjsDocMap: Map<string, Y.Doc>) => {
                yjsDocMap.set(id, doc);
                return provider;
              }}
              shouldBootstrap={false}
            />
            <RichTextPlugin
              contentEditable={<ContentEditable />}
              placeholder={<></>}
              ErrorBoundary={LexicalErrorBoundary}
            />
          </LexicalComposer>
        </LexicalCollaboration>
      );
    }

    act(() => {
      reactRoot.render(<App />);
    });
    expect(provider._connectCount).toBe(1);
    expect(provider._disconnectCount).toBe(0);

    act(() => {
      reactRoot.render(<App />);
    });
    act(() => {
      reactRoot.render(<App />);
    });

    expect(provider._disconnectCount).toBe(0);
    expect(provider._connectCount).toBe(1);
  });
  /**
   * The root a binding uses is fixed for its lifetime -- nothing reloads a
   * mounted editor from another root -- so `getXmlText` / `getXmlElement` (and
   * `rootName`) are read when the binding is created and ignored afterwards.
   * Acting on a later change would tear the V1 binding down without building a
   * replacement, and in V2 would build one and then overwrite the newly chosen
   * root with the previous document's content.
   */
  describe('the root is fixed once the binding exists', () => {
    function $appendParagraph(text: string): void {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(text));
      $getRoot().append(paragraph);
    }

    test(`changing getXmlText leaves the mounted editor on its own root`, async () => {
      const doc = new Y.Doc();
      const notes = doc.getMap<Y.XmlText>('notes');
      notes.set('a', new Y.XmlText());
      notes.set('b', new Y.XmlText());
      const provider = createSyncedProvider();
      let editor: LexicalEditor | null = null;

      function CaptureEditor() {
        [editor] = useLexicalComposerContext();
        return null;
      }

      function App({noteId}: {noteId: string}) {
        return (
          <LexicalCollaboration>
            <LexicalComposer initialConfig={editorConfig}>
              <CaptureEditor />
              <CollaborationPlugin
                id="main"
                providerFactory={(id, yjsDocMap) => {
                  yjsDocMap.set(id, doc);
                  return provider;
                }}
                shouldBootstrap={false}
                getXmlText={ydoc =>
                  ydoc.getMap<Y.XmlText>('notes').get(noteId)!
                }
              />
              <RichTextPlugin
                contentEditable={<ContentEditable />}
                placeholder={<></>}
                ErrorBoundary={LexicalErrorBoundary}
              />
            </LexicalComposer>
          </LexicalCollaboration>
        );
      }

      await act(async () => {
        reactRoot.render(<App noteId="a" />);
      });
      await act(async () => {
        editor!.update(() => $appendParagraph('hello'));
      });
      expect(notes.get('a')!.toString()).toContain('hello');

      // A resolver for another note is ignored...
      await act(async () => {
        reactRoot.render(<App noteId="b" />);
      });

      // ...and the binding is still the one this editor was mounted with, so
      // further edits keep syncing, into the note it is bound to.
      await act(async () => {
        editor!.update(() => $appendParagraph('world'));
      });
      expect(notes.get('a')!.toString()).toContain('hello');
      expect(notes.get('a')!.toString()).toContain('world');
      expect(notes.get('b')!.length).toBe(0);
      expect(
        editor!.getEditorState().read(() => $getRoot().getTextContent()),
      ).toBe('hello\n\nworld');

      // Acting on the change would have destroyed the binding without building
      // a replacement, which empties `binding.collabNodeMap` and silently stops
      // the caret of every node that predates it from being published.
      await act(async () => {
        editor!.update(() => {
          const paragraph = $getRoot().getFirstChildOrThrow<ElementNode>();
          paragraph.selectStart();
        });
      });
      expect(provider.awareness.getLocalState()!.anchorPos).not.toBeNull();
    });

    test(`a root that only resolves after mount is still used`, async () => {
      const doc = new Y.Doc();
      const notes = doc.getMap<Y.XmlText>('notes');
      notes.set('a', new Y.XmlText());
      const provider = createSyncedProvider();
      let editor: LexicalEditor | null = null;

      function CaptureEditor() {
        [editor] = useLexicalComposerContext();
        return null;
      }

      // The doc is only registered for the id the second render passes, so the
      // binding is created on a later effect pass than the first render -- the
      // window in which an asynchronously resolved root arrives.
      const providerFactory = (id: string, yjsDocMap: Map<string, Y.Doc>) => {
        if (id === 'main') {
          yjsDocMap.set(id, doc);
        }
        return provider;
      };

      function App({
        getXmlText,
        id,
      }: {
        getXmlText?: (ydoc: Y.Doc) => Y.XmlText;
        id: string;
      }) {
        return (
          <LexicalCollaboration>
            <LexicalComposer initialConfig={editorConfig}>
              <CaptureEditor />
              <CollaborationPlugin
                id={id}
                providerFactory={providerFactory}
                shouldBootstrap={false}
                getXmlText={getXmlText}
              />
              <RichTextPlugin
                contentEditable={<ContentEditable />}
                placeholder={<></>}
                ErrorBoundary={LexicalErrorBoundary}
              />
            </LexicalComposer>
          </LexicalCollaboration>
        );
      }

      await act(async () => {
        reactRoot.render(<App id="pending" />);
      });

      await act(async () => {
        reactRoot.render(
          <App
            id="main"
            getXmlText={ydoc => ydoc.getMap<Y.XmlText>('notes').get('a')!}
          />,
        );
      });
      await act(async () => {
        editor!.update(() => $appendParagraph('hello'));
      });

      expect(notes.get('a')!.toString()).toContain('hello');
      expect(doc.share.has('root')).toBe(false);
    });

    test(`re-rendering does not re-run the V2 root resolver`, async () => {
      const doc = new Y.Doc();
      const notes = doc.getMap<Y.XmlElement>('notes');
      notes.set('a', new Y.XmlElement());
      const provider = createSyncedProvider();
      const getXmlElement = vi.fn(
        (ydoc: Y.Doc) => ydoc.getMap<Y.XmlElement>('notes').get('a')!,
      );

      function App() {
        return (
          <LexicalCollaboration>
            <LexicalComposer initialConfig={editorConfig}>
              <CollaborationPluginV2__EXPERIMENTAL
                id="main"
                doc={doc}
                provider={provider}
                // A fresh identity on every render, the way an inline prop has
                excludedProperties={new Map()}
                getXmlElement={getXmlElement}
              />
              <RichTextPlugin
                contentEditable={<ContentEditable />}
                placeholder={<></>}
                ErrorBoundary={LexicalErrorBoundary}
              />
            </LexicalComposer>
          </LexicalCollaboration>
        );
      }

      await act(async () => {
        reactRoot.render(<App />);
      });
      await act(async () => {
        reactRoot.render(<App />);
      });
      await act(async () => {
        reactRoot.render(<App />);
      });

      // The resolver may create shared types, so re-running it on a render is
      // a document mutation, not just wasted work.
      expect(getXmlElement).toHaveBeenCalledTimes(1);
    });

    test(`changing getXmlElement leaves the mounted V2 editor on its own root`, async () => {
      const doc = new Y.Doc();
      const notes = doc.getMap<Y.XmlElement>('notes');
      notes.set('a', new Y.XmlElement());
      notes.set('b', new Y.XmlElement());
      const provider = createSyncedProvider();
      let editor: LexicalEditor | null = null;

      function CaptureEditor() {
        [editor] = useLexicalComposerContext();
        return null;
      }

      function App({noteId}: {noteId: string}) {
        return (
          <LexicalCollaboration>
            <LexicalComposer initialConfig={editorConfig}>
              <CaptureEditor />
              <CollaborationPluginV2__EXPERIMENTAL
                id="main"
                doc={doc}
                provider={provider}
                getXmlElement={ydoc =>
                  ydoc.getMap<Y.XmlElement>('notes').get(noteId)!
                }
              />
              <RichTextPlugin
                contentEditable={<ContentEditable />}
                placeholder={<></>}
                ErrorBoundary={LexicalErrorBoundary}
              />
            </LexicalComposer>
          </LexicalCollaboration>
        );
      }

      await act(async () => {
        reactRoot.render(<App noteId="a" />);
      });
      await act(async () => {
        editor!.update(() => $appendParagraph('hello'));
      });
      expect(notes.get('a')!.length).toBeGreaterThan(0);

      await act(async () => {
        reactRoot.render(<App noteId="b" />);
      });
      await act(async () => {
        editor!.update(() => $appendParagraph('world'));
      });

      // note b never receives this editor's content: rebuilding the binding on
      // the new root would serialize the whole editor state over it.
      expect(notes.get('b')!.length).toBe(0);
      expect(notes.get('a')!.toString()).toContain('hello');
      expect(notes.get('a')!.toString()).toContain('world');
    });
  });
});
