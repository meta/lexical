/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

/**
 * Regression test (found by fuzzing) for a collaborative desync where a local
 * edit is silently dropped from the shared Yjs document.
 *
 * The sequence below drives a peer into applying a remote change that turns out
 * to be a no-op (the text node it targets was concurrently removed, so nothing
 * reconciles into Lexical). That remote update is tagged COLLABORATION, and
 * because it produced no dirty nodes the tag used to leak into the editor's
 * `_updateTags` and contaminate the *next* local update. `syncLexicalUpdateToYjs`
 * early-returns for COLLABORATION/HISTORIC updates, so the contaminated local
 * edit was never written back to Yjs: the peer's live Lexical state and its own
 * persisted Yjs document diverged (and the peers diverged from each other).
 *
 * Like the other collab unit tests this wires peers directly with the exported
 * `@lexical/yjs` infrastructure over a mock ASYNC transport. The assertion is at
 * the infrastructure level: every peer's *live* editor must match what its *own*
 * Yjs document reloads to, and all peers must converge. Without the fix peer A
 * ends up with an empty live editor while its Yjs document still holds a
 * paragraph, so the test fails.
 */

import {
  type Binding,
  createBinding,
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
const makeProvider = (a: Awareness): Provider =>
  ({
    awareness: a,
    connect() {},
    disconnect() {},
    off() {},
    on() {},
  }) as unknown as Provider;

type Peer = {
  name: string;
  doc: Y.Doc;
  editor: LexicalEditor;
  binding: Binding;
  awareness: Awareness;
};
function makePeer(name: string, clientID: number): Peer {
  const doc = new Y.Doc({gc: false});
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
  // Wired exactly like useYjsCollaboration.
  binding.root.getSharedType().observeDeep((events, transaction) => {
    if (transaction.origin !== binding) {
      syncYjsChangesToLexical(
        binding,
        provider,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        events as any,
        transaction.origin instanceof Y.UndoManager,
      );
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
const RELAY = {relay: true};
class Network {
  peers: Peer[] = [];
  queue: {target: Peer; update: Uint8Array}[] = [];
  attach(p: Peer) {
    this.peers.push(p);
    p.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === RELAY) {
        return;
      }
      for (const o of this.peers) {
        if (o !== p) {
          this.queue.push({target: o, update: u});
        }
      }
    });
  }
  relay() {
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
const tick = () => new Promise(r => setTimeout(r, 0));

// k: 1 = insert text into first paragraph, 2 = delete one char from it,
// 3 = remove the paragraph, 4 = append a new paragraph after it.
function execEdit(peer: Peer, k: number, off: number, ch: string) {
  peer.editor.update(
    () => {
      const root = $getRoot();
      const paras = root.getChildren().filter($isElementNode);
      if (paras.length === 0) {
        const p = $createParagraphNode();
        p.append($createTextNode(ch));
        root.append(p);
        return;
      }
      const para = paras[0];
      if (!$isElementNode(para)) {
        return;
      }
      if (k === 1) {
        const existing = para.getFirstChild();
        const t = $isTextNode(existing) ? existing : $createTextNode('');
        if (existing !== t) {
          para.append(t);
        }
        t.spliceText(off % (t.getTextContentSize() + 1), 0, ch);
      } else if (k === 2) {
        const t = para.getFirstChild();
        if ($isTextNode(t) && t.getTextContentSize() > 0) {
          t.spliceText(off % t.getTextContentSize(), 1, '');
        }
      } else if (k === 3) {
        para.remove();
      } else if (k === 4) {
        const np = $createParagraphNode();
        np.append($createTextNode(ch));
        para.insertAfter(np);
      }
    },
    {discrete: true},
  );
}

// A structural snapshot that distinguishes "no children" from "one empty
// paragraph" (plain text content cannot).
function liveSnapshot(peer: Peer): string {
  return peer.editor.read('latest', () =>
    $getRoot()
      .getChildren()
      .map(c => `${c.getType()}(${JSON.stringify(c.getTextContent())})`)
      .join('|'),
  );
}
// Reconstruct the document purely from a peer's persisted Yjs state, the same
// way a fresh client joining the session would.
function reloadSnapshot(peer: Peer): string {
  const doc2 = new Y.Doc({gc: false});
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(peer.doc));
  const ed = createEditor({namespace: 'reload', onError: () => {}});
  const b = createBinding(
    ed,
    makeProvider(new Awareness(doc2.clientID, 'r')),
    'main',
    doc2,
    new Map([['main', doc2]]),
  );
  ed.update(
    () => {
      b.root.applyChildrenYjsDelta(b, b.root.getSharedType().toDelta());
      b.root.syncChildrenFromYjs(b);
    },
    {discrete: true},
  );
  return ed.read('latest', () =>
    $getRoot()
      .getChildren()
      .map(c => `${c.getType()}(${JSON.stringify(c.getTextContent())})`)
      .join('|'),
  );
}

describe('Local edits after a no-op remote sync stay in sync with Yjs', () => {
  it('a paragraph removal that follows a no-op remote sync is persisted', async () => {
    const net = new Network();
    // The editing peer (A) must have the higher clientID so that, in the Yjs
    // conflict resolution, A's concurrent text deletion wins and B's insert
    // arrives at A as a dangling (no-op) change.
    const A = makePeer('A', 2);
    const B = makePeer('B', 1);
    net.attach(A);
    net.attach(B);

    // B creates a paragraph with a single character and everyone syncs.
    execEdit(B, 4, 0, 'e');
    await tick();
    net.relay();
    net.deliver(9999);
    await tick();

    // B types another character into that paragraph (not yet delivered).
    execEdit(B, 1, 1, 'f');
    await tick();
    // A concurrently deletes the paragraph's only character.
    execEdit(A, 2, 0, 'd');
    await tick();

    // A receives B's insert. Because A removed the text node, B's insert is a
    // dangling no-op: A's COLLABORATION-tagged sync produces no dirty nodes.
    net.relay();
    net.deliver(1);
    await tick();

    // A immediately removes the (now empty) paragraph. Pre-fix this local edit
    // inherited the leaked COLLABORATION tag and was never written to Yjs.
    execEdit(A, 3, 0, 'x');
    await tick();

    // Let everything settle.
    for (let i = 0; i < 20; i++) {
      net.relay();
      net.deliver(9999);

      await tick();
      if (net.queue.length === 0) {
        break;
      }
    }

    const peers = [A, B];
    // Every peer's live editor must match its own persisted Yjs document...
    for (const p of peers) {
      expect(`${p.name}:${liveSnapshot(p)}`).toBe(
        `${p.name}:${reloadSnapshot(p)}`,
      );
    }
    // ...and all peers must have converged to the same document.
    expect(new Set(peers.map(liveSnapshot)).size).toBe(1);
    expect(new Set(peers.map(reloadSnapshot)).size).toBe(1);
  });
});
