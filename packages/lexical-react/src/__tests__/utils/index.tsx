/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Provider, UserState} from '@lexical/yjs';
import type {LexicalEditor} from 'lexical';

import {
  LexicalCollaboration,
  useCollaborationContext,
} from '@lexical/react/LexicalCollaborationContext';
import {
  CollaborationPlugin,
  CollaborationPluginV2__EXPERIMENTAL,
} from '@lexical/react/LexicalCollaborationPlugin';
import {
  type InitialConfigType,
  LexicalComposer,
} from '@lexical/react/LexicalComposer';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import * as React from 'react';
import {act} from 'react';
import {type Container, createRoot, type Root} from 'react-dom/client';
import {expect} from 'vitest';
import * as Y from 'yjs';

function Editor({
  doc,
  provider,
  setEditor,
  awarenessData,
  shouldBootstrapEditor = true,
  useCollabV2 = false,
}: {
  doc: Y.Doc;
  provider: Provider;
  setEditor: (editor: LexicalEditor) => void;
  awarenessData?: object | undefined;
  shouldBootstrapEditor?: boolean;
  useCollabV2?: boolean;
}) {
  const context = useCollaborationContext();

  const [editor] = useLexicalComposerContext();

  const {yjsDocMap} = context;
  context.isCollabActive = true;
  yjsDocMap.set('main', doc);

  setEditor(editor);

  return (
    <>
      {useCollabV2 ? (
        <CollaborationPluginV2__EXPERIMENTAL
          id="main"
          doc={doc}
          provider={provider}
          awarenessData={awarenessData}
          __shouldBootstrapUnsafe={shouldBootstrapEditor}
        />
      ) : (
        <CollaborationPlugin
          id="main"
          providerFactory={() => provider}
          shouldBootstrap={shouldBootstrapEditor}
          awarenessData={awarenessData}
        />
      )}
      <RichTextPlugin
        contentEditable={<ContentEditable />}
        placeholder={<></>}
        ErrorBoundary={LexicalErrorBoundary}
      />
    </>
  );
}

export class Client implements Provider {
  _id: string;
  _reactRoot: Root | null = null;
  _container: HTMLDivElement | null = null;
  _editor: LexicalEditor | null = null;
  _connection: {
    _clients: Map<string, Client>;
    _useCollabV2: boolean;
  };
  _connected: boolean = false;
  _doc: Y.Doc = new Y.Doc({gc: false});

  _listeners = new Map<string, Set<(data: unknown) => void>>();
  _updates: Uint8Array[] = [];
  _awarenessState: UserState | null = null;
  awareness: {
    getLocalState: () => UserState | null;
    getStates: () => Map<number, UserState>;
    off(): void;
    on(): void;
    setLocalState: (state: UserState | null) => void;
    setLocalStateField: (field: string, value: unknown) => void;
  };

  constructor(id: Client['_id'], connection: Client['_connection']) {
    this._id = id;
    this._connection = connection;
    this._onUpdate = this._onUpdate.bind(this);

    this._doc.on('update', this._onUpdate);

    this.awareness = {
      getLocalState: () => this._awarenessState,
      getStates: () => new Map([[0, this._awarenessState!]]),
      off: () => {
        // TODO
      },

      on: () => {
        // TODO
      },

      setLocalState: (state: UserState | null) => {
        this._awarenessState = state;
      },
      setLocalStateField: (field: string, value: unknown) => {
        // TODO
      },
    };
  }

  _onUpdate(update: Uint8Array, origin: unknown, transaction: unknown) {
    if (origin !== this._connection && this._connected) {
      this._broadcastUpdate(update);
    }
  }

  _broadcastUpdate(update: Uint8Array) {
    this._connection._clients.forEach(client => {
      if (client !== this) {
        if (client._connected) {
          Y.applyUpdate(client._doc, update, this._connection);
        } else {
          client._updates.push(update);
        }
      }
    });
  }

  connect() {
    if (!this._connected) {
      this._connected = true;
      const update = Y.encodeStateAsUpdate(this._doc);

      if (this._updates.length > 0) {
        Y.applyUpdate(
          this._doc,
          Y.mergeUpdates(this._updates),
          this._connection,
        );
        this._updates = [];
      }

      this._broadcastUpdate(update);

      this._dispatch('sync', true);
    }
  }

  disconnect() {
    this._connected = false;
  }

  /**
   * @param options
   *  - shouldBootstrapEditor: Whether to initialize the editor with an empty paragraph
   */
  start(
    rootContainer: Container,
    awarenessData?: object,
    options: {
      nodes?: InitialConfigType['nodes'];
      shouldBootstrapEditor?: boolean;
    } = {},
  ) {
    const container = document.createElement('div');
    const reactRoot = createRoot(container);
    this._container = container;
    this._reactRoot = reactRoot;

    rootContainer.appendChild(container);

    act(() => {
      reactRoot.render(
        <LexicalCollaboration>
          <LexicalComposer
            initialConfig={{
              editorState: null,
              namespace: '',
              nodes: options.nodes,
              onError: e => {
                throw e;
              },
            }}>
            <Editor
              provider={this}
              doc={this._doc}
              setEditor={editor => (this._editor = editor)}
              awarenessData={awarenessData}
              shouldBootstrapEditor={options.shouldBootstrapEditor}
              useCollabV2={this._connection._useCollabV2}
            />
          </LexicalComposer>
        </LexicalCollaboration>,
      );
    });
  }

  stop() {
    act(() => {
      this._reactRoot!.render(null);
    });

    this.getContainer().parentNode!.removeChild(this.getContainer());

    this._container = null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(type: string, callback: (arg: any) => void) {
    let listenerSet = this._listeners.get(type);

    if (listenerSet === undefined) {
      listenerSet = new Set();

      this._listeners.set(type, listenerSet);
    }

    listenerSet.add(callback);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(type: string, callback: (arg: any) => void) {
    const listenerSet = this._listeners.get(type);

    if (listenerSet !== undefined) {
      listenerSet.delete(callback);
    }
  }

  _dispatch(type: string, data: unknown) {
    const listenerSet = this._listeners.get(type);

    if (listenerSet !== undefined) {
      listenerSet.forEach(callback => callback(data));
    }
  }

  getHTML() {
    return (this.getContainer().firstChild as HTMLElement).innerHTML;
  }

  getDoc() {
    return this._doc;
  }

  getDocJSON() {
    return this._doc.toJSON();
  }

  getEditorState() {
    return this.getEditor().getEditorState();
  }

  getEditor() {
    return this._editor!;
  }

  getContainer() {
    return this._container!;
  }

  async focus() {
    this.getContainer().focus();

    await Promise.resolve().then();
  }

  update(cb: () => void) {
    this.getEditor().update(cb);
  }
}

export class TestConnection {
  _clients = new Map<string, Client>();

  constructor(readonly _useCollabV2: boolean) {}

  createClient(id: string) {
    const client = new Client(id, this);

    this._clients.set(id, client);

    return client;
  }
}

export function createTestConnection(useCollabV2: boolean) {
  return new TestConnection(useCollabV2);
}

export async function waitForReact(cb: () => void) {
  await act(async () => {
    cb();
    await Promise.resolve().then();
  });
}

export function createAndStartClients(
  connector: TestConnection,
  aContainer: HTMLDivElement,
  count: number,
): Client[] {
  const result = [];

  for (let i = 0; i < count; ++i) {
    const id = `${i}`;
    const client = connector.createClient(id);
    client.start(aContainer);
    result.push(client);
  }

  return result;
}

export function disconnectClients(clients: Client[]) {
  for (let i = 0; i < clients.length; ++i) {
    clients[i].disconnect();
  }
}

export function connectClients(clients: Client[]) {
  for (let i = 0; i < clients.length; ++i) {
    clients[i].connect();
  }
}

export function stopClients(clients: Client[]) {
  for (let i = 0; i < clients.length; ++i) {
    clients[i].stop();
  }
}

export function testClientsForEquality(clients: Client[]) {
  for (let i = 1; i < clients.length; ++i) {
    expect(clients[0].getHTML()).toEqual(clients[i].getHTML());
    expect(clients[0].getDocJSON()).toEqual(clients[i].getDocJSON());
  }
}
