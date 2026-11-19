/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  DecoratorNode,
  DELETE_CHARACTER_COMMAND,
  DELETE_LINE_COMMAND,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

class InlineDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_inline_decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.contentEditable = 'false';
    span.style.cssText =
      'display: inline-block; inline-size: 24px; block-size: 16px';
    return span;
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): boolean {
    return true;
  }
  decorate(): null {
    return null;
  }
}

describe.each([RichTextExtension, PlainTextExtension])('$name', extension => {
  test.each(
    [false, true].flatMap(isBackward =>
      [
        'empty',
        'text',
        'nested',
        'image',
        'inline-image',
        'inline-text',
      ].flatMap(content =>
        [false, true].flatMap(raised =>
          [1, 2].map(count => ({content, count, isBackward, raised})),
        ),
      ),
    ),
  )(
    'line deletion (backward: $isBackward, raised: $raised, content: $content, count: $count)',
    ({content, count, isBackward, raised}) => {
      const root = document.createElement('div');
      root.contentEditable = 'true';
      root.style.cssText =
        'width: 500px; font: 16px monospace; line-height: 24px; white-space: pre-wrap';
      document.body.appendChild(root);
      const before = isBackward ? 'aaaa ' : 'aaaa bbbb ';
      const after = isBackward ? 'bbbbbbbb cccc' : '';
      const editor = buildEditorFromExtensions({
        $initialEditorState: () => {
          const left = $createTextNode(before);
          const right = $createTextNode(after);
          $getRoot().append(
            $createParagraphNode().append(
              left,
              ...Array.from({length: count}, () =>
                $create(InlineDecoratorNode),
              ),
              right,
            ),
          );
          (isBackward ? right : left).select(2, 2);
        },
        dependencies: [extension],
        name: '[inline-decorator-line-deletion]',
        nodes: [InlineDecoratorNode],
      });
      onTestFinished(() => {
        editor.dispose();
        root.remove();
      });
      editor.setRootElement(root);

      const decorator = root.querySelector<HTMLElement>(
        '[data-lexical-decorator]',
      )!;
      if (content.startsWith('inline-')) {
        decorator.style.display = 'inline';
      }
      if (content.endsWith('image')) {
        const img = document.createElement('img');
        img.width = 24;
        img.height = 16;
        img.src =
          'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"></svg>';
        decorator.appendChild(document.createElement('span')).appendChild(img);
      }
      if (content === 'text' || content === 'inline-text') {
        decorator.textContent = 'X';
      } else if (content === 'nested') {
        const child = document.createElement('strong');
        child.textContent = 'X';
        decorator.appendChild(child);
      }
      if (raised) {
        decorator.style.verticalAlign = '2em';
      }
      const text = root.querySelectorAll('[data-lexical-text]')[
        isBackward ? 1 : 0
      ].firstChild!;
      const range = document.createRange();
      range.setStart(text, 1);
      range.setEnd(text, 2);
      const caretRect = range.getBoundingClientRect();
      const decoratorRect = decorator.getBoundingClientRect();
      // All content fits on one line; raised content deliberately has no
      // vertical overlap with the text next to it.
      if (raised) {
        expect(caretRect.top).toBeGreaterThanOrEqual(decoratorRect.bottom);
      } else {
        expect(caretRect.top).toBeLessThan(decoratorRect.bottom);
        expect(caretRect.bottom).toBeGreaterThan(decoratorRect.top);
      }

      editor.update(
        () => editor.dispatchCommand(DELETE_LINE_COMMAND, isBackward),
        {discrete: true},
      );
      expect(root.querySelector('[data-lexical-decorator]')).toBeNull();
      expect(editor.read(() => $getRoot().getTextContent())).toBe(
        isBackward ? after.slice(2) : before.slice(0, 2),
      );
    },
  );
});

// #9234: stop at the measured soft wrap, even when another decorator is
// immediately adjacent to the endpoint in the model.
describe.each([RichTextExtension, PlainTextExtension])(
  '$name soft wraps',
  extension => {
    test.each(
      [false, true].flatMap(isBackward =>
        ['empty', 'text', 'button'].flatMap(content =>
          [false, true].flatMap(spaceBefore =>
            (content === 'empty' ? [1] : [1, 2]).map(count => ({
              content,
              count,
              isBackward,
              spaceBefore,
            })),
          ),
        ),
      ),
    )(
      'preserves the neighbouring line (backward: $isBackward, content: $content, space: $spaceBefore, decorators: $count)',
      ({content, count, isBackward, spaceBefore}) => {
        const before = 'aaaa bbbb' + (spaceBefore ? ' ' : '');
        const after = 'cccccccc dddd';
        const root = document.createElement('div');
        root.contentEditable = 'true';
        root.style.cssText =
          'font: 16px monospace; line-height: 24px; white-space: pre-wrap';
        // Leave room for one decorator on the first line for backward deletion
        // or when two decorators straddle the wrap. Each decorator is 24px wide.
        root.style.width = `calc(${before.length}ch + ${isBackward || count === 2 ? 36 : 12}px)`;
        document.body.appendChild(root);
        const editor = buildEditorFromExtensions({
          $initialEditorState: () => {
            const left = $createTextNode(before);
            const right = $createTextNode(after);
            $getRoot().append(
              $createParagraphNode().append(
                left,
                ...Array.from({length: count}, () =>
                  $create(InlineDecoratorNode),
                ),
                right,
              ),
            );
            (isBackward ? right : left).select(2, 2);
          },
          dependencies: [extension],
          name: '[soft-wrap-line-deletion]',
          nodes: [InlineDecoratorNode],
        });
        onTestFinished(() => {
          editor.dispose();
          root.remove();
        });
        editor.setRootElement(root);
        const decorators = Array.from(
          root.querySelectorAll<HTMLElement>('[data-lexical-decorator]'),
        );
        for (const decorator of decorators) {
          if (content === 'text') {
            decorator.textContent = 'X';
          } else if (content === 'button') {
            const button = document.createElement('button');
            button.textContent = 'X';
            decorator.appendChild(button);
          }
        }
        const text = root.querySelectorAll('[data-lexical-text]')[
          isBackward ? 1 : 0
        ].firstChild!;
        const range = document.createRange();
        range.setStart(text, 1);
        range.setEnd(text, 2);
        const textRect = range.getBoundingClientRect();
        const preservedDecorator = decorators[isBackward ? 0 : count - 1];
        const decoratorRect = preservedDecorator.getBoundingClientRect();
        // Assert the layout so a font/platform difference cannot turn this into
        // a same-line test. For two decorators, only one should be deleted.
        if (isBackward) {
          expect(decoratorRect.bottom).toBeLessThanOrEqual(textRect.top);
        } else {
          expect(decoratorRect.top).toBeGreaterThanOrEqual(textRect.bottom);
        }
        if (count === 2) {
          const deletedRect =
            decorators[isBackward ? 1 : 0].getBoundingClientRect();
          expect(deletedRect.top).toBeLessThan(textRect.bottom);
          expect(deletedRect.bottom).toBeGreaterThan(textRect.top);
        }
        editor.update(
          () => editor.dispatchCommand(DELETE_LINE_COMMAND, isBackward),
          {discrete: true},
        );
        expect(
          Array.from(root.querySelectorAll('[data-lexical-decorator]')),
        ).toEqual([preservedDecorator]);
        expect(editor.read(() => $getRoot().getTextContent())).toBe(
          isBackward ? before + after.slice(2) : before.slice(0, 2) + after,
        );
      },
    );
  },
);

// The repeated forward deletion and image-boundary cases covered by #7270.
// That change also introduced the post-measurement decorator traversal.
describe.each([RichTextExtension, PlainTextExtension])(
  '$name repeated deletion',
  extension => {
    test.each([false, true])(
      'deletes across image and paragraph boundaries (backward: %s)',
      isBackward => {
        const root = document.createElement('div');
        root.contentEditable = 'true';
        root.style.cssText =
          'width: 500px; font: 16px monospace; white-space: pre-wrap';
        document.body.appendChild(root);
        const editor = buildEditorFromExtensions({
          $initialEditorState: () => {
            const paragraph = $createParagraphNode();
            const text = $createTextNode('Two');
            const decorator = $create(InlineDecoratorNode);
            paragraph.append(
              ...(isBackward ? [text, decorator] : [decorator, text]),
            );
            $getRoot().append(
              $createParagraphNode().append($createTextNode('One')),
              paragraph,
            );
            if (isBackward) {
              paragraph.selectEnd();
            } else {
              $getRoot().append($createParagraphNode());
              paragraph.selectStart();
            }
          },
          dependencies: [extension],
          name: '[repeated-image-line-deletion]',
          nodes: [InlineDecoratorNode],
        });
        onTestFinished(() => {
          editor.dispose();
          root.remove();
        });
        editor.setRootElement(root);
        const wrapper = root.querySelector<HTMLElement>(
          '[data-lexical-decorator]',
        )!;
        wrapper.style.display = 'inline';
        const image = document.createElement('img');
        image.width = 24;
        image.height = 16;
        image.src =
          'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"></svg>';
        wrapper.appendChild(document.createElement('span')).appendChild(image);
        const lines = () =>
          editor.read(() =>
            $getRoot()
              .getChildren()
              .map(node => node.getTextContent()),
          );
        const deleteLine = () =>
          editor.update(
            () => editor.dispatchCommand(DELETE_LINE_COMMAND, isBackward),
            {discrete: true},
          );
        deleteLine();
        expect(lines()).toEqual(isBackward ? ['One', ''] : ['One', '', '']);
        expect(root.querySelector('[data-lexical-decorator]')).toBeNull();
        if (isBackward) {
          editor.update(
            () => editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true),
            {discrete: true},
          );
          expect(lines()).toEqual(['One']);
          deleteLine();
          expect(lines()).toEqual(['']);
        } else {
          deleteLine();
          expect(lines()).toEqual(['One', '']);
          deleteLine();
          expect(lines()).toEqual(['One', '']);
          editor.update(() => $getRoot().getFirstChildOrThrow().selectStart(), {
            discrete: true,
          });
          deleteLine();
          expect(lines()).toEqual(['', '']);
          deleteLine();
          expect(lines()).toEqual(['']);
          deleteLine();
          expect(lines()).toEqual(['']);
        }
      },
    );
  },
);
