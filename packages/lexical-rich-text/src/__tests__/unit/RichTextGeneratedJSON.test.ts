/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {
  $expectSameJSON,
  $expectSameParse,
  getGeneratedJSON,
  initializeUnitTest,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

describe('rich-text generated JSON', () => {
  initializeUnitTest(
    testEnv => {
      test('HeadingNode agrees with the schema-driven walk', () => {
        testEnv.editor.update(
          () => {
            $expectSameJSON(new HeadingNode());
            $expectSameJSON(
              new HeadingNode('h3')
                .setDirection('rtl')
                .setIndent(2)
                .setFormat('center')
                .setTextFormat(1)
                .setTextStyle('color: red'),
            );
            $expectSameParse(HeadingNode, {
              direction: 'rtl',
              format: 'center',
              indent: 2,
              tag: 'h3',
              textFormat: 1,
              textStyle: 'color: red',
            });
          },
          {discrete: true},
        );
      });

      test('QuoteNode agrees with the schema-driven walk', () => {
        testEnv.editor.update(
          () => {
            $expectSameJSON(new QuoteNode());
            $expectSameJSON(
              new QuoteNode().setDirection('rtl').setIndent(1).setFormat('end'),
            );
            // The shadowRoot flat state is appended by the dispatch rather
            // than written by either path; it has to survive the composition.
            expect(
              new QuoteNode().setIsShadowRoot(true).exportJSON(),
            ).toHaveProperty('shadowRoot', true);
          },
          {discrete: true},
        );
      });

      test('QuoteNode parses through its generated parser, flat state included', () => {
        // A class that carries flat NodeState still gets a parser: the walk
        // applies the state before handing the node to the generated code,
        // the mirror of how export appends it after the generated literal.
        expect(getGeneratedJSON(QuoteNode)?.updateFromJSON).toBeDefined();
        testEnv.editor.update(
          () => {
            const node = $expectSameParse(QuoteNode, {
              direction: 'rtl',
              format: 'center',
              indent: 2,
              shadowRoot: true,
              textFormat: 1,
              textStyle: 'color: red',
            });
            expect(node.isShadowRoot()).toBe(true);
            expect(node.getIndent()).toBe(2);
          },
          {discrete: true},
        );
      });
    },
    {
      namespace: 'test',
      nodes: [HeadingNode, QuoteNode],
      theme: {},
    },
  );
});
