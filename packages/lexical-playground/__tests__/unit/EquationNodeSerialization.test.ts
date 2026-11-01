/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {describe, expect, test} from 'vitest';

import {$createEquationNode, EquationNode} from '../../src/nodes/EquationNode';

describe('EquationNode serialization', () => {
  test('inline survives a round trip', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[equation-serialization]',
        nodes: [EquationNode],
      }),
    );
    editor.update(
      () => {
        for (const inline of [true, false]) {
          const json = $createEquationNode('x^2', inline).exportJSON();
          expect(json).toMatchObject({equation: 'x^2', inline});
          // Previously `inline` had no setter, so it was silently dropped and
          // every inline equation reloaded as a block equation.
          // importJSON is synthesized, so it is typed as the base class.
          const restored = EquationNode.importJSON(json) as EquationNode;
          expect(restored.isInline()).toBe(inline);
          expect(restored.getEquation()).toBe('x^2');
        }
      },
      {discrete: true},
    );
  });
});
