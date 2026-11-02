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
import * as Y13 from 'yjs';

import {createYDoc, YBinding} from '../..';
import {inspectUpdateRoots} from '../../internal/UpdateRoots';
import {$p, $selectIn, NODES, setup} from '../utils/harness';

describe('@lexical/y on a server', () => {
  test('updates of upgraded clients write only to the layout root', async () => {
    const t = await setup(() => $getRoot().append($p('hello')));
    const updates: Uint8Array[] = [];
    t.a.doc.on('update', (u: Uint8Array) => updates.push(u));
    t.a.update(() => $selectIn([0], 5).insertText('!'));
    t.a.update(() => $selectIn([0], 0).insertParagraph());
    expect(updates.length).toBe(2);
    for (const u of updates) {
      // Nested items resolve through the server's copy of the document.
      const r = inspectUpdateRoots(u, t.b.doc);
      expect([[...r.roots], r.unresolved]).toEqual([['lexical-y'], 0]);
    }
    expect([
      ...inspectUpdateRoots(Y.encodeStateAsUpdate(t.a.doc)).roots,
    ]).toEqual(['lexical-y']);
  });

  test('an old client update is reported', () => {
    const old = new Y13.Doc();
    old
      .get('root-v2', Y13.XmlFragment)
      .insert(0, [new Y13.XmlElement('paragraph')]);
    const update = Y13.encodeStateAsUpdate(old);
    expect([...inspectUpdateRoots(update).roots]).toEqual(['root-v2']);
  });

  test('the editor is not editable until the layout record is read', () => {
    const doc = createYDoc();
    const editor = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    const binding = new YBinding(editor, doc, {
      schemaVersion: 1,
      selfCheck: true,
    });
    binding.start();
    expect(binding.status).toBe('pending');
    expect(editor.isEditable()).toBe(false);
    binding.initialize();
    expect(editor.isEditable()).toBe(true);
  });
});
