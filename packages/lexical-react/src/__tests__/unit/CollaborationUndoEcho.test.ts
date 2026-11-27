/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

/**
 * Regression test for the "empty-paragraph echo" on collaborative undo
 * (meta/lexical#8651, issue #6614).
 *
 * The React collaboration test harness in ./utils relays Yjs updates
 * SYNCHRONOUSLY (re-entrantly, inside the sender's transaction), which serializes
 * away the mid-reconcile transient that this bug depends on. A real provider
 * (y-websocket / y-protocols) delivers updates ASYNCHRONOUSLY. This test therefore
 * wires two peers directly with the exported `@lexical/yjs` infrastructure
 * (`createBinding` + `syncYjsChangesToLexical` + `syncLexicalUpdateToYjs` +
 * `createUndoManager`, exactly as `useYjsCollaboration` does) over a mock async
 * transport.
 *
 * The operation sequence below was found by fuzzing and minimized (the client ids
 * only need A's > B's, since Yjs conflict resolution is ordered by client id).
 * With it, a reconciliation invariant fires mid-undo and leaves the shared root
 * momentarily empty while the Yjs document still holds content. WITHOUT the fix,
 * `$ensureEditorNotEmpty()` then inserts a recovery paragraph in an untagged update
 * that is echoed into the shared document, leaving an extra empty paragraph (the
 * "unexpected paragraph" of #6614). WITH the fix that recovery is skipped because
 * `binding.root` is not actually empty, so no spurious paragraph appears.
 */

import {
  type Binding,
  createBinding,
  createUndoManager,
  type Provider,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  createEditor,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, it} from 'vitest';
import * as Y from 'yjs';

// A minimal awareness implementation (the binding only reads/writes cursor state
// through this interface; cross-peer relay keeps remote cursors visible).
class Awareness {
  clientID: number;
  states = new Map<number, unknown>();
  constructor(clientID: number, name: string) {
    this.clientID = clientID;
    this.states.set(clientID, {
      anchorPos: null,
      awarenessData: {},
      color: '#000',
      focusPos: null,
      focusing: true,
      name,
    });
  }
  getLocalState() {
    return this.states.get(this.clientID) ?? null;
  }
  setLocalState(s: unknown) {
    if (s == null) {
      this.states.delete(this.clientID);
    } else {
      this.states.set(this.clientID, s);
    }
  }
  setLocalStateField(field: string, value: unknown) {
    this.setLocalState({...(this.getLocalState() as object), [field]: value});
  }
  getStates() {
    return this.states;
  }
  on() {}
  off() {}
  applyRemote(clientID: number, state: unknown) {
    if (state == null) {
      this.states.delete(clientID);
    } else {
      this.states.set(clientID, state);
    }
  }
}

function makeProvider(awareness: Awareness): Provider {
  return {
    awareness,
    connect: () => {},
    disconnect: () => {},
    off: () => {},
    on: () => {},
  } as unknown as Provider;
}

type Peer = {
  name: string;
  doc: Y.Doc;
  editor: LexicalEditor;
  binding: Binding;
  awareness: Awareness;
};

function makePeer(name: string, clientID: number): Peer {
  const doc = new Y.Doc({gc: false});
  // Deterministic client ids: Yjs conflict resolution depends on them.
  doc.clientID = clientID;
  const editor = createEditor({
    namespace: name,
    onError: (e: Error) => {
      throw e;
    },
  });
  const awareness = new Awareness(doc.clientID, name);
  const provider = makeProvider(awareness);
  const binding = createBinding(
    editor,
    provider,
    'main',
    doc,
    new Map([['main', doc]]),
  );
  // Wire up like useYjsCollaboration. The try/catch models a provider that
  // survives an application-time error (this sequence also trips a separate
  // reconciliation invariant; the echo is the *next* thing that goes wrong, and
  // is what this test asserts on).
  binding.root.getSharedType().observeDeep((events, transaction) => {
    if (transaction.origin !== binding) {
      try {
        syncYjsChangesToLexical(
          binding,
          provider,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          events as any,
          transaction.origin instanceof Y.UndoManager,
        );
      } catch {
        // swallow: leaves binding.root momentarily diverged from Lexical
      }
    }
  });
  editor.registerUpdateListener(
    ({
      prevEditorState,
      editorState,
      dirtyLeaves,
      dirtyElements,
      normalizedNodes,
      tags,
    }) => {
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
    },
  );
  return {awareness, binding, doc, editor, name};
}

// Mock async transport: local updates are QUEUED and delivered on a later tick
// (not re-entrantly inside the sender's transaction).
const RELAY = {relay: true};
class Network {
  peers: Peer[] = [];
  queue: {target: Peer; update: Uint8Array}[] = [];
  attach(peer: Peer) {
    this.peers.push(peer);
    peer.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === RELAY) {
        return;
      }
      for (const other of this.peers) {
        if (other !== peer) {
          this.queue.push({target: other, update});
        }
      }
    });
  }
  relayAwareness() {
    for (const a of this.peers) {
      for (const b of this.peers) {
        if (a !== b) {
          b.awareness.applyRemote(a.doc.clientID, a.awareness.getLocalState());
        }
      }
    }
  }
  deliver(n: number) {
    for (let i = 0; i < n && this.queue.length > 0; i++) {
      const {target, update} = this.queue.shift()!;
      Y.applyUpdate(target.doc, update, RELAY);
    }
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// The number of top-level paragraphs actually persisted in a peer's Yjs document,
// reconstructed from the shared type (empty paragraphs are invisible to toJSON, so
// we rebuild the collab tree instead).
function persistedParagraphCount(peer: Peer): number {
  const doc2 = new Y.Doc({gc: false});
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(peer.doc));
  const editor = createEditor({namespace: 'reload', onError: () => {}});
  const binding = createBinding(
    editor,
    makeProvider(new Awareness(doc2.clientID, 'reload')),
    'main',
    doc2,
    new Map([['main', doc2]]),
  );
  editor.update(
    () => {
      binding.root.applyChildrenYjsDelta(
        binding,
        binding.root.getSharedType().toDelta(),
      );
      binding.root.syncChildrenFromYjs(binding);
    },
    {discrete: true},
  );
  return editor.read(
    'latest',
    () => $getRoot().getChildren().filter($isElementNode).length,
  );
}

describe('Collaborative undo empty-paragraph echo (#8651)', () => {
  it('does not echo a recovery paragraph into the shared document', async () => {
    const net = new Network();
    // Client ids decide Yjs conflict order; the reproduction needs A's id > B's.
    const A = makePeer('A', 2);
    const B = makePeer('B', 1);
    net.attach(A);
    net.attach(B);
    const undoA = createUndoManager(A.binding, A.binding.root.getSharedType());
    const undoB = createUndoManager(B.binding, B.binding.root.getSharedType());

    const firstText = (peer: Peer) =>
      peer.editor.read('latest', () => {
        const p = $getRoot().getFirstChild();
        const t = $isElementNode(p) ? p.getFirstChild() : null;
        return $isTextNode(t) ? t : null;
      });

    const update = (peer: Peer, fn: () => void) =>
      peer.editor.update(fn, {discrete: true});

    // Each step is followed by a macrotask so updates are delivered/applied the
    // way an async provider would (this interleaving is essential to the repro).
    const step = async (fn: () => void) => {
      fn();
      await tick();
    };
    const deliver = (n: number) => {
      net.relayAwareness();
      net.deliver(n);
    };
    const delText0 = (peer: Peer) =>
      update(peer, () => {
        const t = firstText(peer);
        if (t && t.getTextContentSize() > 0) {
          t.spliceText(0, 1, '');
        }
      });
    const addPara = (peer: Peer, text: string) =>
      update(peer, () => {
        const p = $createParagraphNode();
        p.append($createTextNode(text));
        $getRoot().append(p);
      });

    // A sequence of ordinary collaborative edits + undos, interleaved with partial
    // async delivery, that drives the binding into the buggy mid-undo state.
    await step(() => addPara(A, 'c'));
    await step(() => deliver(3)); // partial delivery
    await step(() => update(B, () => $getRoot().getFirstChild()?.remove()));
    await step(() => undoB.undo());
    await step(() => deliver(9999));
    await step(() => delText0(A));
    await step(() => delText0(B));
    await step(() => undoA.undo());
    await step(() => undoB.undo());
    await step(() => deliver(9999));
    await step(() => addPara(B, 'd'));
    await step(() => undoB.undo());
    await step(() => update(B, () => $getRoot().getFirstChild()?.remove()));

    // Settle the network.
    for (let i = 0; i < 30; i++) {
      net.relayAwareness();
      net.deliver(9999);

      await tick();
      if (net.queue.length === 0) {
        break;
      }
    }

    // The document should hold a single paragraph of content. Without the fix the
    // undo recovery echoes a spurious empty paragraph, leaving two.
    expect(persistedParagraphCount(A)).toBe(1);
    expect(persistedParagraphCount(B)).toBe(1);
  });
});
