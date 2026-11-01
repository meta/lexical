/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {domOverride} from '@lexical/html';
import {$isLineBreakNode, isHTMLElement, TextNode} from 'lexical';
import {describe, expect, test} from 'vitest';

import {precompileDOMRenderConfigOverrides} from '../../internal/compileDOMRenderConfigOverrides';
import {ALWAYS_TRUE} from '../../internal/constants';

describe('precompileDOMRenderConfigOverrides', () => {
  test('precompiles with only type overrides', () => {
    class TextNodeA extends TextNode {
      $config() {
        return this.config('text-a', {extends: TextNode});
      }
    }
    const overrides = [
      domOverride([TextNode], {
        $exportDOM: function $exportDOM_TextNode_0(node) {
          const span = document.createElement('span');
          span.append(node.getTextContent());
          return {element: span};
        },
      }),
      domOverride([TextNodeA], {
        $exportDOM: function $exportDOM_TextNodeA_1(node) {
          const span = document.createElement('span');
          span.append(node.getTextContent());
          span.dataset.lexicalType = node.getType();
          return {element: span};
        },
      }),
      domOverride([TextNode], {
        $exportDOM: function $exportDOM_TextNode_2(node, $next) {
          const r = $next();
          if (isHTMLElement(r.element)) {
            r.element.dataset.didOverride = 'true';
          }
          return r;
        },
      }),
    ];
    const prerender = precompileDOMRenderConfigOverrides(
      {nodes: [TextNode, TextNodeA]},
      overrides,
    );
    expect(prerender).toEqual({
      $createDOM: [],
      $decorateDOM: [],
      $exportDOM: [
        [
          'types',
          {
            text: [overrides[0].$exportDOM, overrides[2].$exportDOM],
            'text-a': [
              overrides[0].$exportDOM,
              // This is lower precedence than overrides[1] because it's for TextNode
              overrides[2].$exportDOM,
              // this one is higher precedence and sorted after its extension ordering
              // since it is for TextNodeA
              overrides[1].$exportDOM,
            ],
          },
        ],
      ],
      $extractWithChild: [],
      $getDOMSlot: [],
      $getSlotTargetElement: [],
      $shouldExclude: [],
      $shouldInclude: [],
      $updateDOM: [],
    });
  });
  test('precompiles with wildcards, predicates, and type overrides', () => {
    class TextNodeA extends TextNode {
      $config() {
        return this.config('text-a', {extends: TextNode});
      }
    }
    const overrides = [
      domOverride([TextNode], {
        $exportDOM: function $exportDOM_TextNode_0(node) {
          const span = document.createElement('span');
          span.append(node.getTextContent());
          return {element: span};
        },
      }),
      domOverride('*', {
        $createDOM: function $createDOM_any_1(node, $next) {
          return $next();
        },
        $exportDOM: function $exportDOM_any_1(node, $next) {
          return $next();
        },
      }),
      domOverride([TextNodeA], {
        $exportDOM: function $exportDOM_TextNodeA_2(node) {
          const span = document.createElement('span');
          span.append(node.getTextContent());
          span.dataset.lexicalType = node.getType();
          return {element: span};
        },
      }),
      domOverride([TextNode], {
        $exportDOM: function $exportDOM_TextNode_3(node, $next) {
          const r = $next();
          if (isHTMLElement(r.element)) {
            r.element.dataset.didOverride = 'true';
          }
          return r;
        },
      }),
      domOverride([$isLineBreakNode], {
        $exportDOM: function $exportDOM_LineBreakNode_4(node, $next) {
          return $next();
        },
      }),
    ];
    const prerender = precompileDOMRenderConfigOverrides(
      {nodes: [TextNode, TextNodeA]},
      overrides,
    );
    expect(prerender).toEqual({
      $createDOM: [[ALWAYS_TRUE, overrides[1].$createDOM]],
      $decorateDOM: [],
      $exportDOM: [
        // These are all merged because the predicate and wildcard were
        // moved to a higher priority
        [
          'types',
          {
            text: [overrides[0].$exportDOM, overrides[3].$exportDOM],
            'text-a': [
              overrides[0].$exportDOM,
              overrides[3].$exportDOM,
              // This is re-ordered because it targets TextNodeA
              overrides[2].$exportDOM,
            ],
          },
        ],
        [$isLineBreakNode, overrides[4].$exportDOM],
        // Reordered since it always matches
        [ALWAYS_TRUE, overrides[1].$exportDOM],
      ],
      $extractWithChild: [],
      $getDOMSlot: [],
      $getSlotTargetElement: [],
      $shouldExclude: [],
      $shouldInclude: [],
      $updateDOM: [],
    });
  });
});
