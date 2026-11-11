/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The binding's one write under a client id derived from what it writes: the
// initial content of a root. Every client that initializes such a root with
// the same content writes the same items under that id (one copy): the same
// bytes on every client and in any relay, whatever the order. A root that
// held anything before gets an id derived from the document it was written
// on too, so it never shares one with a pristine root's write.
//
// And content written without Lexical's normalization by a client the
// binding does not control (here inline text straight in a block holder) is
// shown as written, alike on every client, and no client that reads it
// writes anything: a remote change never triggers a write.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  createEditor,
  ElementNode,
  ParagraphNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {$p, NODES} from '../utils/harness';

class BlockBox extends ElementNode {
  $config() {
    return this.config('derived_block_box', {
      children: 'block',
      extends: ElementNode,
    });
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM() {
    return false;
  }
}

const idle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

type Client = {
  doc: Y.Doc;
  warnings: string[];
  editor: ReturnType<typeof createEditor>;
  stop: () => void;
};

// A client whose paragraphs turn text written as `TOKEN…` into token-mode
// text (a deterministic transform, which a reader's normalization would run).
function client(id: number, state?: Uint8Array): Client {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  if (state !== undefined) {
    Y.applyUpdate(doc, state, 'load');
  }
  const warnings: string[] = [];
  const editor = createEditor({
    nodes: [...NODES, BlockBox],
    onError: e => {
      throw e;
    },
    onWarn: e => warnings.push(String(e)),
  });
  const untransform = editor.registerNodeTransform(ParagraphNode, p => {
    for (const c of p.getChildren()) {
      if (
        $isTextNode(c) &&
        c.getTextContent().startsWith('TOKEN') &&
        c.getMode() !== 'token'
      ) {
        c.replace($createTextNode(c.getTextContent()).setMode('token'));
      }
    }
  });
  const binding = new YBinding(editor, doc, {
    schemaVersion: 1,
    selfCheck: true,
  });
  const stopBinding = binding.start();
  if (state === undefined) {
    editor.update(() => $getRoot().append($p('base')), {discrete: true});
  }
  binding.initialize();
  return {
    doc,
    editor,
    stop: () => {
      stopBinding();
      untransform();
      doc.destroy();
    },
    warnings,
  };
}

// Inline text written straight into a block holder (as a client without the
// normalization would): every reader shows it as a paragraph.
function writeRaw(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const root = doc.get('lexical-y');
    const box = new Y.Node('b:derived_block_box');
    root.insert(root.length, [box]);
    box.setAttr('c', 'b');
    box.insert(0, text);
    box.insert(text.length, [new Y.Node('\u00a6')]);
  }, 'raw');
}

const json = (c: Client) => JSON.stringify(c.editor.getEditorState().toJSON());

// Everything a client id wrote: each struct's id, length, deletion, origins,
// parent and content (format keys and values included).
function written(doc: Y.Doc, id: number): unknown[] {
  return (doc.store.clients.get(id) ?? []).map(s => {
    if (!(s instanceof Y.Item)) {
      return [s.id.clock, s.length, s.constructor.name];
    }
    const c = s.content;
    return [
      s.id.clock,
      s.length,
      s.deleted,
      s.parentSub,
      s.origin,
      s.rightOrigin,
      c instanceof Y.ContentType
        ? ['node', (c.type as Y.Node).name]
        : c instanceof Y.ContentFormat
          ? ['format', c.key, c.value]
          : c.getContent(),
    ];
  });
}

function initialized(
  id: number,
  gc: boolean,
  $init: () => void,
  history?: (doc: Y.Doc) => void,
): Client {
  const doc = createYDoc(null, {gc});
  doc.clientID = id;
  if (history !== undefined) {
    history(doc);
  }
  const warnings: string[] = [];
  const editor = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn: e => warnings.push(String(e)),
  });
  editor.update($init, {discrete: true});
  const binding = new YBinding(editor, doc, {schemaVersion: 1});
  const stop = binding.start();
  binding.initialize();
  return {
    doc,
    editor,
    stop: () => {
      stop();
      doc.destroy();
    },
    warnings,
  };
}

const $same = () =>
  $getRoot()
    .clear()
    .append(
      $p('same'),
      $createParagraphNode().append(
        $createTextNode('TOKEN two').setMode('token'),
        $createTextNode(' plain'),
      ),
    );

for (const gc of [false, true]) {
  test(`the initial content of a pristine root is the same items on every client and in any relay (gc ${gc})`, async () => {
    const clients = [11, 12, 13].map(id => initialized(id, gc, $same));
    try {
      const derived = (c: Client) =>
        [...c.doc.store.clients.keys()].filter(id => id !== c.doc.clientID);
      // Each wrote only under the derived id, the same one.
      const id = derived(clients[0])[0];
      for (const c of clients) {
        expect(derived(c)).toEqual([id]);
        expect(c.doc.store.clients.has(c.doc.clientID)).toBe(false);
      }
      const updates = clients.map(c => Y.encodeStateAsUpdate(c.doc));
      for (const c of clients) {
        for (const u of updates) {
          Y.applyUpdate(c.doc, u, 'net');
        }
      }
      await idle();
      const relays = [updates, [...updates].reverse()].map(order => {
        const relay = new Y.Doc({gc});
        for (const u of order) {
          Y.applyUpdate(relay, u);
        }
        return relay;
      });
      const expected = written(clients[0].doc, id);
      for (const doc of [...clients.map(c => c.doc), ...relays]) {
        expect(written(doc, id)).toEqual(expected);
      }
      for (const relay of relays) {
        relay.destroy();
      }
      for (const c of clients) {
        expect(json(c)).toBe(json(clients[0]));
        expect(
          c.editor.getEditorState().read(() => $getRoot().getTextContent()),
        ).toBe('same\n\nTOKEN two plain');
        expect(c.warnings).toEqual([]);
      }
    } finally {
      for (const c of clients) {
        c.stop();
      }
    }
  });

  for (const held of ['an item', 'an attribute'] as const) {
    test(`a root that held ${held}, deleted since, is initialized under an id of its own, never a pristine root's (gc ${gc})`, async () => {
      const a = initialized(72001, gc, $same, doc => {
        const root = doc.get('lexical-y');
        if (held === 'an item') {
          root.insert(0, 'gone');
          root.delete(0, 4);
        } else {
          root.setAttr('k:paragraph', 'line');
          root.deleteAttr('k:paragraph');
        }
      });
      const b = initialized(72002, gc, $same);
      try {
        // A wrote under an id derived from what it wrote on the document it
        // had; B, whose root is pristine, under the pristine one. Neither
        // wrote under its own id (A's holds only what it deleted before).
        const derived = (c: Client) =>
          [...c.doc.store.clients.keys()].filter(id => id !== c.doc.clientID);
        expect(derived(a)).toHaveLength(1);
        expect(derived(b)).toHaveLength(1);
        expect(derived(a)[0]).not.toBe(derived(b)[0]);
        expect(b.doc.store.clients.has(72002)).toBe(false);
        Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'net');
        Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'net');
        await idle();
        // No client id holds different items on the two clients.
        for (const id of a.doc.store.clients.keys()) {
          expect(written(b.doc, id)).toEqual(written(a.doc, id));
        }
        expect(json(b)).toBe(json(a));
      } finally {
        a.stop();
        b.stop();
      }
    });
  }
}

for (const third of ['TOKEN three', 'plain three']) {
  test(`a change written without the normalization is shown alike by clients with different histories, which write nothing (${third})`, async () => {
    // B loads after the first change, C after the second.
    const a = client(901);
    const others: Client[] = [];
    try {
      const raw = (text: string) => {
        const author = new Y.Doc({gc: false});
        author.clientID = 990 + others.length;
        Y.applyUpdate(author, Y.encodeStateAsUpdate(a.doc));
        const sv = Y.encodeStateVector(author);
        writeRaw(author, text);
        const update = Y.encodeStateAsUpdate(author, sv);
        author.destroy();
        return update;
      };
      Y.applyUpdate(a.doc, raw('TOKEN one'), 'net');
      await idle();
      others.push(client(902, Y.encodeStateAsUpdate(a.doc)));
      Y.applyUpdate(a.doc, raw('TOKEN two'), 'net');
      await idle();
      Y.applyUpdate(
        others[0].doc,
        Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(others[0].doc)),
        'net',
      );
      await idle();
      others.push(client(903, Y.encodeStateAsUpdate(a.doc)));
      const clients = [a, ...others];
      const writers = () =>
        clients.map(c =>
          [...c.doc.store.clients.keys()].filter(id => id < 990 || id > 999),
        );
      const before = writers();
      const change = raw(third);
      for (const c of clients) {
        Y.applyUpdate(c.doc, change, 'net');
        await idle();
      }
      // No reader wrote anything (A's own items are its initial paragraph).
      expect(writers()).toEqual(before);
      for (const c of clients) {
        expect(json(c)).toBe(json(a));
        expect(c.warnings).toEqual([]);
      }
      const fresh = client(904, Y.encodeStateAsUpdate(a.doc));
      expect(json(fresh)).toBe(json(a));
      fresh.stop();
      expect(
        a.editor
          .getEditorState()
          .read(() => $getRoot().getLastChild()!.getTextContent()),
      ).toBe(third);
    } finally {
      a.stop();
      for (const c of others) {
        c.stop();
      }
    }
  });
}
