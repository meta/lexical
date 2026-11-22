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

import {createYDoc} from '../..';
import {inspectUpdateRoots} from '../../internal/UpdateRoots';
import {$p, NODES} from '../utils/harness';
import {writeEditorToYDoc} from '../utils/headless';

function bigDoc(n: number): Y.Doc {
  const editor = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
  });
  editor.update(
    () => {
      for (let i = 0; i < n; i++) {
        $getRoot().append($p(`paragraph ${i} with some text`));
      }
    },
    {discrete: true},
  );
  const doc = createYDoc(null, {gc: false});
  writeEditorToYDoc(editor, doc);
  return doc;
}

describe('@lexical/y update roots at scale', () => {
  test('full-state updates resolve in linear time', () => {
    const times: number[] = [];
    for (const n of [1000, 8000]) {
      const update = Y.encodeStateAsUpdate(bigDoc(n));
      const start = performance.now();
      const result = inspectUpdateRoots(update);
      times.push(performance.now() - start);
      expect([...result.roots]).toEqual(['lexical-y']);
      expect(result.unresolved).toBe(0);
    }
    // 8x the content: allow 30x before calling it superlinear.
    expect(times[1]).toBeLessThan(Math.max(30 * times[0], 1000));
    // About 3 s alone (building the documents), over vitest's default 5 s
    // limit when the whole suite runs.
  }, 30_000);

  test('a delete-only update to an older root is detected', () => {
    const old = new Y13.Doc();
    const fragment = old.get('root-v2', Y13.XmlFragment);
    fragment.insert(0, [new Y13.XmlElement('paragraph')]);
    const server = new Y.Doc();
    Y.applyUpdate(server, Y13.encodeStateAsUpdate(old));
    const before = Y13.encodeStateVector(old);
    fragment.delete(0, 1);
    const deleteOnly = Y13.encodeStateAsUpdate(old, before);
    const result = inspectUpdateRoots(deleteOnly, server);
    expect([...result.roots]).toEqual(['root-v2']);
    // Without the server's document the deletion cannot be resolved.
    expect(inspectUpdateRoots(deleteOnly).unresolved).toBeGreaterThan(0);
  });
});
