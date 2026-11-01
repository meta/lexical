/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {MarkNode} from '@lexical/mark';
import {
  $expectSameJSON,
  getGeneratedJSON,
  initializeUnitTest,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

describe('mark generated exportJSON', () => {
  initializeUnitTest(
    testEnv => {
      test('MarkNode agrees with the schema-driven walk', () => {
        testEnv.editor.update(
          () => {
            $expectSameJSON(new MarkNode());
            $expectSameJSON(new MarkNode([]));
            $expectSameJSON(new MarkNode(['a', 'b']));
          },
          {discrete: true},
        );
      });

      test('the compact form compares an empty-array default by content', () => {
        // `ids` defaults to an array, which no emitted literal could ever be
        // `===`, so the generated comparison is the length test arrayValue's
        // own equality reduces to for an empty default — verified against that
        // equality when it was generated. `getIDs()` also copies, so even the
        // identical-default node never hands back the default by reference;
        // both cases below are decided by content, not by `===`.
        expect(getGeneratedJSON(MarkNode)?.exportCompactJSON).toBeDefined();
        testEnv.editor.update(
          () => {
            expect(new MarkNode().exportJSON(true)).toEqual({
              children: [],
              type: 'mark',
            });
            expect(new MarkNode([]).exportJSON(true)).toEqual({
              children: [],
              type: 'mark',
            });
            expect(new MarkNode(['x']).exportJSON(true)).toEqual({
              children: [],
              ids: ['x'],
              type: 'mark',
            });
            // The legacy form writes it unconditionally either way.
            expect(new MarkNode().exportJSON().ids).toEqual([]);
          },
          {discrete: true},
        );
      });
    },
    {
      namespace: 'test',
      nodes: [MarkNode],
      theme: {},
    },
  );
});

/**
 * A subclass whose `setIDs` normalizes, to hold the field declaration to the
 * rule it stands in for.
 */
class DedupeMarkNode extends MarkNode {
  static getType(): string {
    return 'dedupe-mark';
  }
  static clone(node: DedupeMarkNode): DedupeMarkNode {
    return new DedupeMarkNode(node.__ids, node.__key);
  }
  setIDs(ids: readonly string[]): this {
    return super.setIDs([...new Set(ids)]);
  }
}

describe('the field `ids` stands in for', () => {
  initializeUnitTest(
    testEnv => {
      test('a subclass override of setIDs still decides', () => {
        // `ids` reads and writes `__ids` directly, which is the fast path, but
        // the field only ever *stands in for* the accessor. The accessor here
        // is `setIDs`, not the conventional `setIds` a field would assume, so
        // the declaration names it: without that, importing into a subclass
        // that normalizes wrote the raw array past its override.
        testEnv.editor.update(
          () => {
            const node = DedupeMarkNode.importJSON({
              children: [],
              direction: null,
              format: '',
              ids: ['a', 'a', 'b'],
              indent: 0,
              type: 'dedupe-mark',
              version: 1,
            } as never) as DedupeMarkNode;
            expect(node.getIDs()).toEqual(['a', 'b']);
          },
          {discrete: true},
        );
      });
    },
    {
      namespace: 'test',
      nodes: [MarkNode, DedupeMarkNode],
      theme: {},
    },
  );
});
