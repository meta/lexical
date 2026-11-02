/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The document a write sees while a remote change waits to be read (see
// Unread): what attrsBefore reads as there before a transaction.

import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {attrsBefore, attrsOf, deleteAttr} from '../../internal/Seen';
import {emptyView, seenBy} from '../../internal/Unread';

test('N2: before a write, an attribute an earlier write removed is gone, one this write removed is not', () => {
  const doc = new Y.Doc({gc: false});
  const root = doc.get('lexical-y');
  doc.transact(() => root.setAttr('p:future', 'keep'));
  // A remote change deletes the attribute, and is not read yet.
  const other = new Y.Doc({gc: false});
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  other.transact(() => other.get('lexical-y').deleteAttr('p:future'));
  const view = emptyView(root);
  const note = (tr: Y.Transaction) => {
    view.changes.push(tr);
  };
  doc.on('afterTransaction', note);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
  doc.off('afterTransaction', note);
  expect(view.changes).toHaveLength(1);
  seenBy(
    () => view,
    () => {
      // A write deletes the value its editor shows.
      doc.transact(tr => {
        expect(attrsOf(root)).toEqual({'p:future': 'keep'});
        deleteAttr(root, 'p:future', tr);
        expect(attrsOf(root)).toEqual({});
        expect(attrsBefore(root, tr)).toEqual({'p:future': 'keep'});
      });
      // The next write finds it gone.
      doc.transact(tr => {
        expect(attrsBefore(root, tr)).toEqual({});
      });
    },
  );
});
