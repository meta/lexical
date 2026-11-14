/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// 3to4's step 0 skips a container without flat NodeState only where it
// already meets layout 4's pairing invariant, read from the container's own
// sequence. An end a raw writer stored that names nothing (a client the
// document does not hold), live text, or another end does not meet it: the
// container is rewritten (the end is dropped, as the step without step 0
// did), and the migration never throws on it. An end naming a deleted
// opener of its name before it does meet it: the container keeps its bytes.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {migrateYState} from '../../../migrate';
import step3to4 from '../../../migrate/3to4';

const CLIENT = 42;

/**
 * Insert a format item `key`=`value` right after `left` in `root` (at the
 * start for null).
 */
function formatAfter(
  tr: Y.Transaction,
  root: Y.Node,
  left: Y.Item | null,
  key: string,
  value: unknown,
): Y.Item {
  const doc = root.doc!;
  const right = (left === null ? root._start : left.right) as Y.Item | null;
  const item = new Y.Item(
    Y.createID(CLIENT, doc.store.getClock(CLIENT)),
    left,
    left === null ? null : left.lastId,
    right,
    right === null ? null : right.id,
    root,
    null,
    new Y.ContentFormat(key, value as never),
  );
  item.integrate(tr, 0);
  return item;
}

/**
 * A layout 3 root holding "abc" and a paragraph marker, then `write` (raw
 * items, gc off so deleted items keep their content until the step runs).
 */
function layout3(write: (tr: Y.Transaction, root: Y.Node) => void): {
  state: Uint8Array;
} {
  const doc = new Y.Doc({gc: false});
  doc.cleanupFormatting = false;
  doc.clientID = CLIENT;
  const root = doc.get('lexical-y');
  doc.transact(tr => {
    root.setAttr('lexical-y:1', true);
    root.setAttr('lexical-y:3', true);
    root.setAttr('lexical-y-schema:1', true);
    root.setAttr('k:paragraph', 'line');
    root.insert(0, 'abc');
    root.insert(3, [new Y.Node('¶')]);
  });
  doc.transact(tr => write(tr, root));
  return {state: Y.encodeStateAsUpdate(doc)};
}

/** The live format items of the migrated root, as "client key=value". */
function formats(state: Uint8Array, gc: boolean): string[] {
  const doc = new Y.Doc({gc});
  Y.applyUpdate(doc, state);
  const out: string[] = [];
  for (let it = doc.get('lexical-y')._start; it; it = it.right as Y.Item) {
    if (!it.deleted && it.content instanceof Y.ContentFormat) {
      out.push(
        `${it.id.client === CLIENT ? 'raw' : 'step'} ${it.content.key}=${JSON.stringify(it.content.value)}`,
      );
    }
  }
  return out;
}

/** The text item holding "abc". */
const text = (root: Y.Node) => {
  for (let it = root._start; it; it = it.right as Y.Item) {
    if (it.content instanceof Y.ContentString) {
      return it;
    }
  }
  throw new Error('no text');
};

describe('3to4 step 0 reads the pairing invariant from the container itself', () => {
  for (const gc of [false, true]) {
    test(`an end naming a client the document does not hold: rewritten, no throw (gc ${gc ? 'on' : 'off'})`, () => {
      const {state} = layout3((tr, root) => {
        formatAfter(tr, root, text(root), 'f:bold', [999999, 0]);
      });
      const result = migrateYState(state, [step3to4], {gc});
      expect(result.receipt.changed).toBe(true);
      expect(formats(result.state, gc)).toEqual([]);
    });

    test(`an end naming live text: rewritten, the end dropped (gc ${gc ? 'on' : 'off'})`, () => {
      const {state} = layout3((tr, root) => {
        const t = text(root);
        formatAfter(tr, root, t, 'f:bold', [t.id.client, t.id.clock]);
      });
      const result = migrateYState(state, [step3to4], {gc});
      expect(formats(result.state, gc)).toEqual([]);
    });

    test(`an end naming a deleted end: rewritten (gc ${gc ? 'on' : 'off'})`, () => {
      const {state} = layout3((tr, root) => {
        const t = text(root);
        const opener = formatAfter(tr, root, null, 'f:bold', true);
        const end = formatAfter(tr, root, t, 'f:bold', [
          opener.id.client,
          opener.id.clock,
        ]);
        const second = formatAfter(tr, root, end, 'f:bold', [
          end.id.client,
          end.id.clock,
        ]);
        expect(second.deleted).toBe(false);
        end.delete(tr);
      });
      const result = migrateYState(state, [step3to4], {gc});
      // The opener's run was open to the end of the container (its end is
      // deleted): the step writes it as a paired run of its own.
      expect(formats(result.state, gc).every(i => i.startsWith('step '))).toBe(
        true,
      );
      expect(formats(result.state, gc).length).toBe(2);
    });

    test(`an end naming a deleted opener of its name before it: kept as stored (gc ${gc ? 'on' : 'off'})`, () => {
      const {state} = layout3((tr, root) => {
        const t = text(root);
        const opener = formatAfter(tr, root, null, 'f:bold', true);
        formatAfter(tr, root, t, 'f:bold', [opener.id.client, opener.id.clock]);
        opener.delete(tr);
      });
      const result = migrateYState(state, [step3to4], {gc});
      expect(formats(result.state, gc)).toEqual(['raw f:bold=[42,8]']);
      expect(result.state).not.toBe(state);
    });
  }
});
