/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import * as Y from '@y/y';
import {$getRoot, createEditor} from 'lexical';
import {describe, expect, test} from 'vitest';
import * as yrs028 from 'ywasm';
import * as yrs023 from 'ywasm-0.23';

import {type ClientIDRange, createYDoc, YBinding, type YDoc} from '../..';
import {
  createYWriter,
  editYState,
  readYState,
  seedYState,
} from '../../headless';
import {$p, $selectIn, NODES} from '../utils/harness';

// A relay on yrs (y-crdt) stores updates and answers a reconnecting client
// with what it lacks. yrs before 0.28 reads client ids as 32-bit numbers;
// Yjs 14 draws 53-bit ones.

// The subset of ywasm used here (same in 0.23 and 0.28).
type Yrs = {
  YDoc: new (options: object) => unknown;
  applyUpdate: (doc: never, update: Uint8Array, origin: unknown) => void;
  encodeStateAsUpdate: (doc: never, vector?: Uint8Array) => Uint8Array;
};

function session(yrs: Yrs, options: {range?: ClientIDRange; doc?: YDoc}) {
  const relay = new yrs.YDoc({}) as never;
  const doc = options.doc || createYDoc();
  doc.on('update', (u: Uint8Array) => yrs.applyUpdate(relay, u, null));
  const editor = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
  });
  editor.update(() => $getRoot().append($p('hello')), {discrete: true});
  const binding = new YBinding(editor, doc, {
    clientIDRange: options.range,
    schemaVersion: 1,
    selfCheck: true,
  });
  binding.start();
  binding.initialize();
  editor.update(() => $selectIn([0], 5).insertText(' world'), {
    discrete: true,
  });
  // The author reconnects: the relay sends what the author's state vector
  // says it lacks.
  const diff = yrs.encodeStateAsUpdate(relay, Y.encodeStateVector(doc));
  Y.applyUpdate(doc, diff);
  // A new client loads the relay's state.
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, yrs.encodeStateAsUpdate(relay));
  return {
    author: editor.getEditorState().read(() => $getRoot().getTextContent()),
    clientID: doc.clientID,
    fresh: fresh.get('lexical-y').toString(),
    original: doc.get('lexical-y').toString(),
  };
}

describe('@lexical/y with yrs relays', () => {
  test('yrs 0.23 duplicates the content of a 53-bit client on reconnect', () => {
    const r = session(yrs023, {});
    expect(r.clientID).toBeGreaterThan(0xffffffff);
    // Both the initial content (a 53-bit content-derived id) and the
    // keystroke (the 53-bit client id) come back as another client's.
    expect(r.author).toBe('hello world\n\nhello world');
  });

  test('yrs 0.23 with clientIDRange uint32: no duplication', () => {
    const r = session(yrs023, {range: 'uint32'});
    expect(r.clientID).toBeLessThanOrEqual(0xffffffff);
    expect(r.author).toBe('hello world');
    expect(r.fresh).toBe(r.original);
  });

  test('yrs 0.28 handles 53-bit client ids', () => {
    const r = session(yrs028, {});
    expect(r.clientID).toBeGreaterThan(0xffffffff);
    expect(r.author).toBe('hello world');
    expect(r.fresh).toBe(r.original);
  });

  test('uint32 range survives Yjs drawing a new client id', () => {
    const doc = createYDoc();
    const editor = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    new YBinding(editor, doc, {
      clientIDRange: 'uint32',
      schemaVersion: 1,
      selfCheck: true,
    }).start();
    expect(doc.clientID).toBeLessThanOrEqual(0xffffffff);
    const other = new Y.Doc();
    other.clientID = doc.clientID;
    other.get('lexical-y').setAttr('x', 1);
    // An update with the doc's own id makes Yjs draw a new (53-bit) one.
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    expect(doc.clientID).not.toBe(other.clientID);
    expect(doc.clientID).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('@lexical/y/headless with yrs relays', () => {
  const $text = () =>
    $getRoot()
      .getChildren()
      .map(node => node.getTextContent())
      .join(' / ');

  function roundTrip(
    yrs: Yrs,
    range: ClientIDRange,
    direct: boolean,
    serverRange: ClientIDRange = range,
  ) {
    const config = {clientIDRange: serverRange, nodes: NODES, schemaVersion: 1};
    const relay = new yrs.YDoc({}) as never;
    // The server seeds the document into the relay.
    yrs.applyUpdate(
      relay,
      seedYState(config, () => $getRoot().append($p('hello'))),
      null,
    );
    // A browser loads it from the relay, binds and types.
    const doc = createYDoc();
    Y.applyUpdate(doc, yrs.encodeStateAsUpdate(relay), 'relay');
    doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'relay') {
        yrs.applyUpdate(relay, u, null);
      }
    });
    const editor = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    const binding = new YBinding(editor, doc, {
      clientIDRange: range,
      schemaVersion: 1,
      selfCheck: true,
    });
    binding.start();
    editor.update(() => $selectIn([0], 5).insertText(' world'), {
      discrete: true,
    });
    // The server edits the relay's state and stores its update there.
    const {update} = editYState(
      yrs.encodeStateAsUpdate(relay),
      config,
      () => $getRoot().append($p('from the server')),
      {writer: createYWriter('server')},
    );
    yrs.applyUpdate(relay, update!, null);
    if (direct) {
      // The server also sends its update to connected browsers itself.
      Y.applyUpdate(doc, update!, 'relay');
    }
    // The browser reconnects: the relay sends what it lacks.
    Y.applyUpdate(
      doc,
      yrs.encodeStateAsUpdate(relay, Y.encodeStateVector(doc)),
      'relay',
    );
    const browser = editor.getEditorState().read($text);
    const stored = readYState(yrs.encodeStateAsUpdate(relay), config, $text);
    binding.dispose();
    return {browser, stored};
  }

  for (const [version, yrs] of [
    ['0.23', yrs023],
    ['0.28', yrs028],
  ] as const) {
    for (const direct of [false, true]) {
      test(`ywasm ${version} relay round trip, 32-bit ids${
        direct ? ', update also sent directly' : ''
      }`, () => {
        const r = roundTrip(yrs, 'uint32', direct);
        expect(r.browser).toBe('hello world / from the server');
        expect(r.stored).toBe(r.browser);
      });
    }
  }

  for (const [version, yrs] of [
    ['0.23', yrs023],
    ['0.28', yrs028],
  ] as const) {
    test(`a writer continues its 32-bit client id on a ywasm ${version} relay's state`, () => {
      const config = {
        clientIDRange: 'uint32' as const,
        nodes: NODES,
        schemaVersion: 1,
      };
      const relay = new yrs.YDoc({}) as never;
      yrs.applyUpdate(
        relay,
        seedYState(config, () => $getRoot().append($p('hello'))),
        null,
      );
      const writer = createYWriter('server');
      const ids = new Set<number>();
      for (const line of ['one', 'two', 'three']) {
        const result = editYState(
          yrs.encodeStateAsUpdate(relay),
          config,
          () => $getRoot().append($p(line)),
          {writer},
        );
        expect(result.warnings).toEqual([]);
        ids.add(result.clientID);
        yrs.applyUpdate(relay, result.update!, null);
      }
      expect(ids.size).toBe(1);
      expect([...ids][0]).toBeLessThanOrEqual(0xffffffff);
      expect(readYState(yrs.encodeStateAsUpdate(relay), config, $text)).toBe(
        'hello / one / two / three',
      );
    });
  }

  test('ywasm 0.28 relay round trip, 53-bit ids', () => {
    const r = roundTrip(yrs028, 'uint53', true);
    expect(r.browser).toBe('hello world / from the server');
    expect(r.stored).toBe(r.browser);
  });

  test('ywasm 0.23 relay with 53-bit server ids duplicates a direct update', () => {
    // The relay stores the server's content under a truncated id, so a
    // browser that also received the update directly gets it twice.
    const r = roundTrip(yrs023, 'uint32', true, 'uint53');
    expect(r.browser).toBe('hello world / from the server / from the server');
  });
});
