/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getChildCaret,
  $getRoot,
  $getSiblingCaret,
  $getTextPointCaret,
  $insertNodeToNearestRootAtCaret,
  $isElementNode,
  type LexicalNode,
  type SplitAtPointCaretNextOptions,
} from 'lexical';
import {describe, expect, test} from 'vitest';

function $serialize(node: LexicalNode): string {
  if (!$isElementNode(node)) {
    return node.getTextContent();
  }
  const children = node.getChildren().map($serialize).join('');
  return `[${children}]`;
}

function $rootSerialize(): string {
  return $getRoot().getChildren().map($serialize).join('');
}

type NodeKind = 'ParagraphNode' | 'TextNode';

function $createLiftable(kind: NodeKind, text: string): LexicalNode {
  return kind === 'ParagraphNode'
    ? $createParagraphNode().append($createTextNode(text))
    : $createTextNode(text);
}

// Each option variant records how $shouldSplit responds on the 'first' and
// 'last' edges; scenarios whose expected output depends on the option
// consume these flags directly rather than invoking $shouldSplit in a
// non-editor context.
type SplitFlags = {
  first: boolean;
  last: boolean;
  removeEmptyDestination: boolean;
};

type Scenario = {
  label: string;
  $run: (kind: NodeKind, options?: SplitAtPointCaretNextOptions) => void;
  // For scenarios where the outcome depends on the $shouldSplit option,
  // `expected` can be a function that returns the expected serialization
  // based on the option's split flags.
  expected: string | ((flags: SplitFlags) => string);
};

const scenarios: Scenario[] = [
  {
    $run: (kind, options) => {
      const x = $createLiftable(kind, 'x');
      $getRoot().append($createParagraphNode().append(x));
      $insertNodeToNearestRootAtCaret(
        x,
        $getSiblingCaret(x, 'previous'),
        options,
      );
    },
    expected: ({first, last, removeEmptyDestination}) =>
      removeEmptyDestination
        ? '[x]'
        : `${first ? '[]' : ''}[x]${last || !first ? '[]' : ''}`,
    label: 'sole child, caret on node (previous) — caret.origin === node',
  },
  {
    $run: (kind, options) => {
      const x = $createLiftable(kind, 'x');
      $getRoot().append($createParagraphNode().append(x));
      $insertNodeToNearestRootAtCaret(x, $getSiblingCaret(x, 'next'), options);
    },
    expected: ({first, last, removeEmptyDestination}) =>
      removeEmptyDestination
        ? '[x]'
        : `${first ? '[]' : ''}[x]${last || !first ? '[]' : ''}`,
    label: 'sole child, caret on node (next) — caret.origin === node',
  },
  {
    $run: (kind, options) => {
      const x = $createLiftable(kind, 'x');
      const p = $createParagraphNode();
      $getRoot().append(p);
      $insertNodeToNearestRootAtCaret(x, $getChildCaret(p, 'next'), options);
    },
    expected: ({first, last, removeEmptyDestination}) =>
      removeEmptyDestination
        ? '[x]'
        : `${first ? '[]' : ''}[x]${last || !first ? '[]' : ''}`,
    label: 'empty, caret on paragraph (next)',
  },
  {
    $run: (kind, options) => {
      const x = $createLiftable(kind, 'x');
      const p = $createParagraphNode();
      $getRoot().append(p);
      $insertNodeToNearestRootAtCaret(
        x,
        $getChildCaret(p, 'previous'),
        options,
      );
    },
    expected: ({first, last, removeEmptyDestination}) =>
      removeEmptyDestination
        ? '[x]'
        : `${first ? '[]' : ''}[x]${last || !first ? '[]' : ''}`,
    label: 'empty, caret on paragraph (previous)',
  },
  {
    $run: (kind, options) => {
      const x = $createLiftable(kind, 'x');
      $insertNodeToNearestRootAtCaret(
        x,
        $getChildCaret($getRoot(), 'next'),
        options,
      );
    },
    expected: '[x]',
    label: 'caret on root (next)',
  },
  {
    $run: (kind, options) => {
      const x = $createLiftable(kind, 'x');
      $getRoot().append($createParagraphNode().append($createTextNode('a'), x));
      $insertNodeToNearestRootAtCaret(x, $getSiblingCaret(x, 'next'), options);
    },
    expected: ({last, removeEmptyDestination}) =>
      `[a][x]${last && !removeEmptyDestination ? '[]' : ''}`,
    label: 'sibling before, caret on node (next) — caret.origin === node',
  },
  {
    $run: (kind, options) => {
      const x = $createLiftable(kind, 'x');
      $getRoot().append($createParagraphNode().append($createTextNode('a'), x));
      $insertNodeToNearestRootAtCaret(
        x,
        $getSiblingCaret(x, 'previous'),
        options,
      );
    },
    expected: ({last, removeEmptyDestination}) =>
      `[a][x]${last && !removeEmptyDestination ? '[]' : ''}`,
    label: 'sibling before, caret on node (previous) — caret.origin === node',
  },
  {
    $run: (kind, options) => {
      const x = $createLiftable(kind, 'x');
      const sib = $createTextNode('a');
      $getRoot().append($createParagraphNode().append(sib, x));
      $insertNodeToNearestRootAtCaret(
        x,
        $getSiblingCaret(sib, 'previous'),
        options,
      );
    },
    expected: ({first}) => `${first ? '[]' : ''}[x][a]`,
    label: 'sibling before, caret on sibling (previous)',
  },
  {
    $run: (kind, options) => {
      const x = $createLiftable(kind, 'x');
      const sib = $createTextNode('ab');
      $getRoot().append($createParagraphNode().append(sib, x));
      $insertNodeToNearestRootAtCaret(
        x,
        $getTextPointCaret(sib, 'next', 0),
        options,
      );
    },
    expected: ({first}) => `${first ? '[]' : ''}[x][ab]`,
    label: 'sibling before, caret on text start (next)',
  },
  {
    $run: (kind, options) => {
      const x = $createLiftable(kind, 'x');
      const sib = $createTextNode('ab');
      $getRoot().append($createParagraphNode().append(sib, x));
      $insertNodeToNearestRootAtCaret(
        x,
        $getTextPointCaret(sib, 'next', 1),
        options,
      );
    },
    expected: `[a][x][b]`,
    label: 'sibling before, caret on text middle (next)',
  },
  {
    $run: (kind, options) => {
      const x = $createLiftable(kind, 'x');
      const sib = $createTextNode('ab');
      $getRoot().append($createParagraphNode().append(sib, x));
      $insertNodeToNearestRootAtCaret(
        x,
        $getTextPointCaret(sib, 'next', 'next'),
        options,
      );
    },
    expected: ({last, removeEmptyDestination}) =>
      `[ab][x]${!removeEmptyDestination && last ? '[]' : ''}`,
    label: 'sibling before, caret on text end (next)',
  },
];

const optionVariants: {
  options: SplitAtPointCaretNextOptions;
  splits: SplitFlags;
}[] = [true, false].flatMap(first =>
  [true, false].flatMap(last =>
    [true, false].flatMap(removeEmptyDestination => [
      {
        options: {
          $shouldSplit: (_node, edge) =>
            (first && edge === 'first') || (last && edge === 'last'),
          removeEmptyDestination,
        },
        splits: {first, last, removeEmptyDestination},
      },
    ]),
  ),
);

describe('$insertNodeToNearestRootAtCaret edge cases', () => {
  for (const variant of optionVariants) {
    for (const kind of ['ParagraphNode'] as const) {
      describe(`${kind} with ${
        Object.entries(variant.splits)
          .flatMap(([k, v]) => (v ? [k] : []))
          .join(' ') || 'no-splits-or-remove'
      }`, () => {
        for (const scenario of scenarios) {
          test(scenario.label, () => {
            using editor = buildEditorFromExtensions(
              defineExtension({
                $initialEditorState: () => scenario.$run(kind, variant.options),
                dependencies: [RichTextExtension],
                name: '[insert-to-nearest-root]',
              }),
            );
            const expected =
              typeof scenario.expected === 'function'
                ? scenario.expected(variant.splits)
                : scenario.expected;
            expect(editor.read($rootSerialize)).toBe(expected);
          });
        }
      });
    }
  }
});
