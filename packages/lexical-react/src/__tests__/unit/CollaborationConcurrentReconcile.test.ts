/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

/**
 * Regression tests for binding reconciliation crashes on concurrent collaborative
 * editing, found by fuzzing. Each sequence below drives `syncYjsChangesToLexical`
 * into a state where an event references a node that was concurrently removed (so
 * `getNode()` is null) or a shared type that was concurrently deleted (so it has
 * no `__type`). Previously these threw `invariant`s
 * (`could not find element node`, `could not find decorator node`,
 * `Expected shared type to include type attribute`) and corrupted the session;
 * now they are skipped gracefully and the peers still converge.
 *
 * Like CollaborationUndoEcho.test.ts these wire two/three peers directly with the
 * exported `@lexical/yjs` infrastructure over a mock ASYNC transport (the
 * synchronous React harness serializes away the transient). The crash propagates
 * uncaught here, so without the fix these tests throw; with it they pass.
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
  // Wired like useYjsCollaboration -- note: no try/catch, so a binding invariant
  // propagates and fails the test (which is what we want without the fix).
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
  return {awareness, binding, doc, editor};
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

type Op =
  | {t: 'edit'; peer: number; k: number; para: number; off: number; ch: string}
  | {t: 'undo' | 'redo'; peer: number}
  | {t: 'deliver'; n: number}
  | {t: 'flush'};

function execEdit(peer: Peer, op: Extract<Op, {t: 'edit'}>) {
  peer.editor.update(
    () => {
      const root = $getRoot();
      const paras = root.getChildren().filter($isElementNode);
      const k = op.k;
      if (k === 0 || paras.length === 0) {
        const p = $createParagraphNode();
        p.append($createTextNode(op.ch));
        root.append(p);
      } else {
        const para = paras[op.para % paras.length];
        if (!$isElementNode(para)) {
          return;
        }
        if (k === 1) {
          const existing = para.getFirstChild();
          const t = $isTextNode(existing) ? existing : $createTextNode('');
          if (existing !== t) {
            para.append(t);
          }
          t.spliceText(op.off % (t.getTextContentSize() + 1), 0, op.ch);
        } else if (k === 2) {
          const t = para.getFirstChild();
          if ($isTextNode(t) && t.getTextContentSize() > 0) {
            t.spliceText(op.off % t.getTextContentSize(), 1, '');
          }
        } else if (k === 3) {
          para.remove();
        } else if (k === 4) {
          const np = $createParagraphNode();
          np.append($createTextNode(op.ch));
          para.insertAfter(np);
        }
      }
    },
    {discrete: true},
  );
}

async function runProgram(cids: number[], ops: Op[]): Promise<string[]> {
  const net = new Network();
  const peers = cids.map((id, i) => makePeer(String.fromCharCode(65 + i), id));
  peers.forEach(p => net.attach(p));
  const undos = peers.map(p =>
    createUndoManager(p.binding, p.binding.root.getSharedType()),
  );
  for (const op of ops) {
    if (op.t === 'edit') {
      execEdit(peers[op.peer], op);
    } else if (op.t === 'undo') {
      undos[op.peer].undo();
    } else if (op.t === 'redo') {
      undos[op.peer].redo();
    } else if (op.t === 'deliver') {
      net.relay();
      net.deliver(op.n);
    }

    await tick();
  }
  for (let i = 0; i < 30; i++) {
    net.relay();
    net.deliver(9999);

    await tick();
    if (net.queue.length === 0) {
      break;
    }
  }
  // Reconstruct each peer's document from Yjs (the persisted state) and return it.
  return peers.map(p => {
    const doc2 = new Y.Doc({gc: false});
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(p.doc));
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
        .map(c => '<' + c.getTextContent() + '>')
        .join(''),
    );
  });
}

describe('Concurrent collaborative reconciliation does not crash', () => {
  it('survives a remove racing a text edit (syncChildrenFromYjs)', async () => {
    const docs = await runProgram(
      [2, 1],
      [
        {ch: 'a', k: 0, off: 0, para: 0, peer: 0, t: 'edit'},
        {n: 3, t: 'deliver'},
        {ch: 'b', k: 2, off: 0, para: 0, peer: 0, t: 'edit'},
        {ch: 'h', k: 1, off: 0, para: 0, peer: 1, t: 'edit'},
        {n: 3, t: 'deliver'},
        {ch: 'f', k: 3, off: 0, para: 1, peer: 0, t: 'edit'},
        {ch: 'h', k: 1, off: 0, para: 0, peer: 1, t: 'edit'},
      ],
    );
    // all peers converge to the same persisted document
    expect(new Set(docs).size).toBe(1);
  });

  it('survives an undo referencing a deleted shared type (type attribute)', async () => {
    const docs = await runProgram(
      [2, 3, 1],
      [
        {ch: 'g', k: 0, off: 0, para: 0, peer: 2, t: 'edit'},
        {n: 3, t: 'deliver'},
        {ch: 'a', k: 3, off: 0, para: 0, peer: 1, t: 'edit'},
        {n: 2, t: 'deliver'},
        {t: 'flush'},
        {n: 9999, t: 'deliver'},
        {ch: 'c', k: 1, off: 0, para: 1, peer: 0, t: 'edit'},
        {ch: 'e', k: 1, off: 0, para: 1, peer: 2, t: 'edit'},
        {n: 3, t: 'deliver'},
        {peer: 2, t: 'undo'},
      ],
    );
    expect(new Set(docs).size).toBe(1);
  });
});
