/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createHorizontalRuleNode,
  $handleDecoratorClickModifiers,
  HorizontalRuleNode,
} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $setSlot,
  createEditor,
  IS_APPLE,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

// Rethrow, or a failed expect() inside editor.update() is only logged.
function createThrowingEditor() {
  return createEditor({
    nodes: [HorizontalRuleNode],
    onError: error => {
      throw error;
    },
  });
}

describe('$handleDecoratorClickModifiers', () => {
  test.each([
    ['forward', false, 2],
    ['backward', true, 1],
  ] as const)(
    'extends a range %s while preserving its anchor',
    (_, backward, offset) => {
      const editor = createThrowingEditor();
      editor.update(
        () => {
          const before = $createTextNode('before');
          const after = $createTextNode('after');
          const rule = $createHorizontalRuleNode();
          $getRoot().append(
            $createParagraphNode().append(before),
            rule,
            $createParagraphNode().append(after),
          );
          const anchorNode = backward ? after : before;
          const selection = anchorNode.select(2, 2);

          expect(
            $handleDecoratorClickModifiers(
              new MouseEvent('click', {shiftKey: true}),
              rule.getKey(),
            ),
          ).toBe(true);
          expect(selection.anchor.getNode()).toBe(anchorNode);
          expect(selection.anchor.offset).toBe(2);
          expect(selection.focus.getNode()).toBe($getRoot());
          expect(selection.focus.offset).toBe(offset);
          expect(selection.isBackward()).toBe(backward);
          expect(selection.getNodes()).toContain(rule);
        },
        {discrete: true},
      );
    },
  );

  test('leaves the range alone when the anchor and target have no shared ancestor', () => {
    const editor = createThrowingEditor();
    editor.update(
      () => {
        const host = $createParagraphNode();
        const text = $createTextNode('slot text');
        const rule = $createHorizontalRuleNode();
        $setSlot(host, 'title', $createParagraphNode().append(text));
        $getRoot().append(host, rule);
        const selection = text.select(2, 2);

        expect(
          $handleDecoratorClickModifiers(
            new MouseEvent('click', {shiftKey: true}),
            rule.getKey(),
          ),
        ).toBe(false);
        expect($getSelection()).toBe(selection);
        expect(selection.isCollapsed()).toBe(true);
        expect(selection.anchor.getNode()).toBe(text);
        expect(selection.anchor.offset).toBe(2);
      },
      {discrete: true},
    );
  });

  test('toggles node selection membership independently', () => {
    const editor = createThrowingEditor();
    editor.update(
      () => {
        const text = $createTextNode('before');
        const first = $createHorizontalRuleNode();
        const second = $createHorizontalRuleNode();
        $getRoot().append($createParagraphNode().append(text), first, second);
        text.select(2, 2);
        const click = new MouseEvent(
          'click',
          IS_APPLE ? {metaKey: true} : {ctrlKey: true},
        );

        expect($handleDecoratorClickModifiers(click, first.getKey())).toBe(
          true,
        );
        const selection = $getSelection();
        assert($isNodeSelection(selection));
        expect(selection.getNodes()).toEqual([first]);
        expect($handleDecoratorClickModifiers(click, second.getKey())).toBe(
          true,
        );
        expect(selection.getNodes()).toEqual([first, second]);
        expect($handleDecoratorClickModifiers(click, first.getKey())).toBe(
          true,
        );
        expect(selection.getNodes()).toEqual([second]);
        expect($handleDecoratorClickModifiers(click, second.getKey())).toBe(
          true,
        );
        expect(selection.getNodes()).toEqual([]);
      },
      {discrete: true},
    );
  });

  test.each([false, true])(
    'includes both selected and clicked nodes (backward=%s)',
    backward => {
      const editor = createThrowingEditor();
      editor.update(
        () => {
          const first = $createHorizontalRuleNode();
          const between = $createTextNode('between');
          const last = $createHorizontalRuleNode();
          $getRoot().append(
            first,
            $createParagraphNode().append(between),
            last,
          );
          const origin = backward ? last : first;
          const target = backward ? first : last;
          $handleDecoratorClickModifiers(
            new MouseEvent(
              'click',
              IS_APPLE ? {metaKey: true} : {ctrlKey: true},
            ),
            origin.getKey(),
          );
          expect(
            $handleDecoratorClickModifiers(
              new MouseEvent('click', {shiftKey: true}),
              target.getKey(),
            ),
          ).toBe(true);
          const range = $getSelection();
          assert($isRangeSelection(range));
          expect(range.anchor.key).toBe($getRoot().getKey());
          expect(range.focus.key).toBe($getRoot().getKey());
          expect([range.anchor.offset, range.focus.offset]).toEqual(
            backward ? [3, 0] : [0, 3],
          );
          expect(range.getNodes()).toContain(between);
        },
        {discrete: true},
      );
    },
  );

  test('keeps the first rule when Shift-click crosses it, until a new caret is placed', () => {
    const editor = createThrowingEditor();
    editor.update(
      () => {
        const before = $createHorizontalRuleNode();
        const origin = $createHorizontalRuleNode();
        const after = $createHorizontalRuleNode();
        const text = $createTextNode('next');
        $getRoot().append(
          before,
          origin,
          after,
          $createParagraphNode().append(text),
        );
        $handleDecoratorClickModifiers(
          new MouseEvent('click', IS_APPLE ? {metaKey: true} : {ctrlKey: true}),
          origin.getKey(),
        );
        const shift = new MouseEvent('click', {shiftKey: true});
        $handleDecoratorClickModifiers(shift, before.getKey());
        $handleDecoratorClickModifiers(shift, after.getKey());
        const range = $getSelection();
        assert($isRangeSelection(range));
        expect(range.getNodes()).toEqual([origin, after]);

        const caret = text.select(2, 2);
        $handleDecoratorClickModifiers(shift, before.getKey());
        expect(caret.anchor.key).toBe(text.getKey());
        expect(caret.anchor.offset).toBe(2);
        expect(caret.focus.offset).toBe(0);
      },
      {discrete: true},
    );
  });
});
