/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {buildEditorFromExtensions, DecoratorTextNode} from '@lexical/extension';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  IS_BOLD,
} from 'lexical';
import {expect, test} from 'vitest';

test.each(
  [false, true].flatMap(backward =>
    [false, true].flatMap(active =>
      (['partial', 'whole', 'multiple', 'empty-end'] as const).map(shape => ({
        active,
        backward,
        shape,
      })),
    ),
  ),
)(
  'formatting a text edge and decorator (backward=$backward, active=$active, shape=$shape)',
  ({active, backward, shape}) => {
    using editor = buildEditorFromExtensions({
      name: 'format-decorator-boundary',
      nodes: [DecoratorTextNode],
    });
    editor.update(
      () => {
        const first = $createTextNode('A');
        const decorator = $create(DecoratorTextNode);
        const text = $createTextNode('BC');
        const last = $createTextNode('D').setStyle('color: red;');
        const paragraph = $createParagraphNode().append(first, decorator, text);
        if (shape === 'multiple' || shape === 'empty-end')
          paragraph.append(last);
        $getRoot().append(paragraph);
        const selection = $createRangeSelection();
        const [start, end] = backward
          ? [selection.focus, selection.anchor]
          : [selection.anchor, selection.focus];
        start.set(first.getKey(), 1, 'text');
        end.set(
          shape === 'multiple' || shape === 'empty-end'
            ? last.getKey()
            : text.getKey(),
          shape === 'empty-end' ? 0 : shape === 'whole' ? 2 : 1,
          'text',
        );
        if (active) $setSelection(selection);
        expect(decorator.isSelected(selection)).toBe(true);
        selection.formatText('bold');
        expect(decorator.getFormat()).toBe(IS_BOLD);
        expect(decorator.isSelected(selection)).toBe(shape === 'whole');
        expect(start.key).toBe(
          shape === 'whole' ? first.getKey() : text.getKey(),
        );
        expect(start.offset).toBe(shape === 'whole' ? 1 : 0);
        expect(selection.isBackward()).toBe(backward);
        selection.formatText('bold');
        expect(text.getFormat()).toBe(0);
        expect(decorator.getFormat()).toBe(shape === 'whole' ? 0 : IS_BOLD);
      },
      {discrete: true},
    );
  },
);
