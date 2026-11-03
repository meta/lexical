/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// GPT layout 3 review round 10, verification cells: copy repair by a nested
// root's own layout, a nested root's minimum independent of its ancestor,
// older headless opens and edits refused, and the pure reader equal to the
// binding's fold on noncanonical states.
import * as Y from '@y/y';
import {$getEditor, $getRoot, createEditor, type LexicalEditor} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {editYState, readYState, seedYState} from '../../headless';
import {covered, isShadowKey, stepFormat} from '../../internal/Ident';
import {readLayout3Formats} from '../../internal/Layout3';
import {$p, NODES} from '../utils/harness';

const text = (root: Y.Node) => {
  let s = '';
  for (let i = root._start; i; i = i.right)
    if (!i.deleted && i.content instanceof Y.ContentString) s += i.content.str;
  return s;
};
const config = {
  nodes: NODES,
  onWarn: () => {},
  schemaVersion: 1,
  selfCheck: true,
};
for (const gc of [false, true]) {
  test(`R10 copy repair uses a nested root's own layout gc=${gc}`, () => {
    for (const version of [1, 2, 3]) {
      const doc = createYDoc(null, {gc});
      doc.clientID = 7;
      const parent = doc.get('app');
      parent.setAttr('lexical-y:3', true);
      const root = new Y.Node('editor-root');
      parent.setAttr('editor', root);
      root.setAttr('lexical-y:' + version, true);
      root.insert(0, 'abc');
      const app = new Y.UndoManager(root, {
        captureTimeout: 0,
        deleteFilter: i =>
          i.content instanceof Y.ContentFormat &&
          Array.isArray(i.content.value),
        trackedOrigins: new Set(['raw']),
      });
      doc.transact(tr => {
        const right = root._start;
        const open = new Y.Item(
          Y.createID(7, doc.store.getClock(7)),
          null,
          null,
          right,
          right!.id,
          root,
          null,
          new Y.ContentFormat('f:bold', true as never),
        );
        open.integrate(tr, 0);
        const last = open.right!;
        const end = new Y.Item(
          Y.createID(7, doc.store.getClock(7)),
          last,
          last.lastId,
          null,
          null,
          root,
          null,
          new Y.ContentFormat('f:bold', [1] as never),
        );
        end.integrate(tr, 0);
      }, 'raw');
      app.undo();
      app.redo();
      let value: unknown;
      for (let it = root._start; it; it = it.right)
        if (
          !it.deleted &&
          it.content instanceof Y.ContentFormat &&
          Array.isArray(it.content.value)
        )
          value = it.content.value;
      if (version < 3) expect(value).toEqual([1]);
      else expect(value).toEqual([2]);
      app.destroy();
      doc.destroy();
    }
  });
  test(`R10 nested root minimum blocks edits independent of ancestor gc=${gc}`, () => {
    const doc = createYDoc(null, {gc});
    doc.clientID = 7;
    const parent = doc.get('app');
    parent.setAttr('lexical-y:3', true);
    const root = new Y.Node('editor-root');
    parent.setAttr('editor', root);
    root.setAttr('lexical-y:1', true);
    root.insert(0, 'abc');
    root.insert(3, [new Y.Node('¶')]);
    const e = createEditor({
      nodes: NODES,
      onError: x => {
        throw x;
      },
      onWarn: () => {},
    });
    const b = new YBinding(e, doc, {root, schemaVersion: 1});
    const before = Y.encodeStateAsUpdate(doc);
    b.start();
    b.initialize();
    doc.transact(
      () =>
        e.update(() => $getRoot().append($p('forbidden')), {discrete: true}),
      'app',
    );
    b.undo();
    b.redo();
    expect(b.status).toBe('readonly');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    b.dispose();
    doc.destroy();
  });
  test(`R10 headless older layouts refuse before the callback gc=${gc}`, () => {
    for (const version of [1, 2]) {
      const doc = createYDoc(null, {gc});
      const root = doc.get('lexical-y');
      root.setAttr('lexical-y:' + version, true);
      root.setAttr('lexical-y-schema:1', true);
      root.insert(0, 'abc');
      root.insert(3, [new Y.Node('¶')]);
      let called = false;
      const state = Y.encodeStateAsUpdate(doc);
      expect(() =>
        editYState(
          state,
          config,
          () => {
            called = true;
            $getRoot().append($p('forbidden'));
          },
          {writer: null},
        ),
      ).toThrow();
      expect(called).toBe(false);
      expect(() =>
        readYState(state, config, () => $getRoot().getTextContent()),
      ).toThrow();
      doc.destroy();
    }
  });
  test(`R10 headless transact gates an editor edit after downgrade gc=${gc}`, () => {
    const base = seedYState(config, () => $getRoot().append($p('abc')));
    let e: LexicalEditor | undefined;
    const out = editYState(
      base,
      config,
      () => {
        e = $getEditor();
      },
      {
        transact: doc => {
          doc.get('lexical-y').deleteAttr('lexical-y:3');
          e!.update(() => $getRoot().append($p('forbidden')), {discrete: true});
        },
        writer: null,
      },
    );
    const doc = createYDoc(out.state, {gc});
    expect(text(doc.get('lexical-y'))).toBe('abc');
    doc.destroy();
  });
  test(`R10 pure/core fold equivalence on 300 noncanonical states gc=${gc}`, () => {
    let seed = 82737;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const keys = ['p:style', 'f:bold', 's:ids\u001fx', 'w:link', 't', 'k'];
    for (let sample = 0; sample < 300; sample++) {
      const doc = new Y.Doc({gc});
      doc.cleanupFormatting = false;
      doc.clientID = 17;
      const root = doc.get('c');
      root.setAttr('lexical-y:3', true);
      const formats: Y.Item[] = [];
      doc.transact(tr => {
        let left: Y.Item | null = null;
        for (let n = 0; n < 30; n++) {
          doc.clientID = random() < 0.5 ? 17 : 19;
          let content: Y.ContentFormat | Y.ContentString;
          if (n % 3 === 2) content = new Y.ContentString('ab');
          else {
            const key = keys[Math.floor(random() * keys.length)];
            let value: unknown;
            if (random() < 0.5 && formats.length) {
              const target = formats[Math.floor(random() * formats.length)];
              value =
                random() < 0.8 ? [target.id.client, target.id.clock] : ['bad'];
            } else
              value = [null, [], true, 'red', 'blue'][Math.floor(random() * 5)];
            content = new Y.ContentFormat(key, value as object);
          }
          const item: Y.Item = new Y.Item(
            Y.createID(doc.clientID, doc.store.getClock(doc.clientID)),
            left,
            left && left.lastId,
            null,
            null,
            root,
            null,
            content,
          );
          item.integrate(tr, 0);
          if (content instanceof Y.ContentFormat) formats.push(item);
          left = item;
        }
      });
      doc.transact(tr => {
        for (const it of formats) if (random() < 0.2) it.delete(tr);
      });
      const actual = readLayout3Formats(root).map(m => Object.fromEntries(m));
      const m = new Map<string, unknown>();
      const expected: Record<string, unknown>[] = [];
      for (let it = root._start; it; it = it.right) {
        if (it.deleted) continue;
        if (it.content instanceof Y.ContentFormat) stepFormat(m, it);
        else if (it.countable) {
          const v = Object.fromEntries(
            [...m].filter(([k]) => covered(k) && !isShadowKey(k)),
          );
          for (let n = 0; n < it.length; n++) expected.push(v);
        }
      }
      expect(actual).toEqual(expected);
      doc.destroy();
    }
  });
}
