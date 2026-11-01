/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {nodeArbitrary} from '@lexical/fast-check';
import * as fc from 'fast-check';
import {$getRoot, createEditor, TextNode} from 'lexical';
import {$expectSameParse} from 'lexical/src/__tests__/utils';
import {describe, test} from 'vitest';

describe('the generated TextNode parser', () => {
  test('agrees with the schema-driven walk on everything the schema admits', () => {
    // The import direction is the untrusted-JSON boundary, so agreeing on a
    // handful of examples is not enough. `nodeArbitrary` builds values from the
    // very schema the walk parses — every legacy spelling, every enum member,
    // and each property independently present or absent — and the generated
    // parser and the walk have to land on the same node for all of them.
    const editor = createEditor({
      namespace: '',
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        $getRoot().clear();
        fc.assert(
          fc.property(nodeArbitrary(TextNode), json => {
            $expectSameParse(TextNode, json);
          }),
          {numRuns: 1000},
        );
      },
      {discrete: true},
    );
  });
});
