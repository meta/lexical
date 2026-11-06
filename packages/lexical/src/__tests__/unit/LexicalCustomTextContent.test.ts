/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $removeSlot,
  $setSlot,
  ParagraphNode,
  type TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {$createTestElementNode, TestElementNode} from '../utils';

class CustomUnsizedParagraphNode extends ParagraphNode {
  $config() {
    return this.config('custom-paragraph', {extends: ParagraphNode});
  }

  getTextContent(): string {
    return `~"${super.getTextContent()}"`;
  }
}

class CustomSizedParagraphNode extends ParagraphNode {
  $config() {
    return this.config('custom-paragraph', {extends: ParagraphNode});
  }

  getTextContent(): string {
    return `--"${super.getTextContent()}"`;
  }

  getTextContentSize(): number {
    return 4 + super.getTextContentSize();
  }
}

function createEditor() {
  const editor = buildEditorFromExtensions(
    defineExtension({
      name: 'CustomTextContent',
      nodes: [
        CustomSizedParagraphNode,
        CustomUnsizedParagraphNode,
        TestElementNode,
      ],
    }),
  );
  editor.setRootElement(document.createElement('div'));
  return editor;
}

describe.each([CustomSizedParagraphNode, CustomUnsizedParagraphNode])(
  'custom element text content',
  CustomParagraphNode => {
    test.each(['', 'Hello'])(
      'root text includes a custom element containing %j after reconciliation',
      text => {
        using editor = createEditor();
        editor.update(
          () => {
            const paragraph = $create(CustomParagraphNode);
            if (text !== '') {
              paragraph.append($createTextNode(text));
            }
            $getRoot().clear().append(paragraph);
            expect(paragraph.getTextContentSize()).toBe(
              paragraph.getTextContent().length,
            );
            expect($getRoot().getTextContent()).toBe(`~"${text}"`);
          },
          {discrete: true},
        );
        editor.read(() => {
          expect($getRoot().getTextContent()).toBe(`~"${text}"`);
          expect($getRoot().getTextContentSize()).toBe(`~"${text}"`.length);
        });
      },
    );

    test('updates custom text when only a descendant is dirty', () => {
      using editor = createEditor();
      let text: TextNode;
      editor.update(
        () => {
          text = $createTextNode('Hello');
          $getRoot().clear().append($create(CustomParagraphNode).append(text));
        },
        {discrete: true},
      );
      const changes: string[] = [];
      onTestFinished(
        editor.registerTextContentListener(value => changes.push(value)),
      );
      editor.update(() => text.setTextContent('World'), {discrete: true});
      editor.read(() => expect($getRoot().getTextContent()).toBe('~"World"'));
      expect(changes).toEqual(['~"World"']);
    });

    test('preserves clean custom text when a following sibling changes', () => {
      using editor = createEditor();
      let text: TextNode;
      editor.update(
        () => {
          text = $createTextNode('Last');
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('First')),
              $create(CustomParagraphNode).append($createTextNode('Custom')),
              $createParagraphNode().append($createTextNode('Third')),
              $createParagraphNode().append(text),
            );
        },
        {discrete: true},
      );
      editor.update(() => text.setTextContent('Updated'), {discrete: true});
      editor.read(() =>
        expect($getRoot().getTextContent()).toBe(
          'First\n\n~"Custom"\n\nThird\n\nUpdated',
        ),
      );
    });

    test('recomputes a custom parent when its child suffix changes', () => {
      using editor = createEditor();
      let paragraph: typeof CustomParagraphNode.prototype;
      let last: TextNode;
      editor.update(
        () => {
          paragraph = $create(CustomParagraphNode);
          last = $createTextNode('d').toggleFormat('underline');
          $getRoot()
            .clear()
            .append(
              paragraph.append(
                $createTextNode('a'),
                $createTextNode('b').toggleFormat('bold'),
                $createTextNode('c').toggleFormat('italic'),
                last,
              ),
            );
        },
        {discrete: true},
      );
      editor.update(() => last.setTextContent('D'), {discrete: true});
      editor.read(() => expect($getRoot().getTextContent()).toBe('~"abcD"'));
      editor.update(() => paragraph.append($createTextNode('e')), {
        discrete: true,
      });
      editor.read(() => expect($getRoot().getTextContent()).toBe('~"abcDe"'));
      editor.update(() => paragraph.getLastChildOrThrow().remove(), {
        discrete: true,
      });
      editor.read(() => expect($getRoot().getTextContent()).toBe('~"abcD"'));
    });

    test('restores custom text when an editor state is replaced', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $create(CustomParagraphNode).append($createTextNode('Original')),
            );
        },
        {discrete: true},
      );
      const original = editor.getEditorState();
      editor.update(() => $getRoot().clear().append($createParagraphNode()), {
        discrete: true,
      });
      editor.setEditorState(original);
      editor.read(() =>
        expect($getRoot().getTextContent()).toBe('~"Original"'),
      );
    });

    test('preserves the source text when an ancestor of a custom node moves', () => {
      using editor = createEditor();
      let target: TestElementNode;
      let moved: TestElementNode;
      let text: TextNode;
      editor.update(
        () => {
          target = $createTestElementNode();
          text = $createTextNode('Original');
          moved = $createTestElementNode().append(
            $create(CustomParagraphNode).append(text),
          );
          $getRoot()
            .clear()
            .append(
              target,
              $createTestElementNode().append(
                $createParagraphNode().append($createTextNode('First')),
                $createParagraphNode().append($createTextNode('Second')),
                $createParagraphNode().append($createTextNode('Third')),
                moved,
              ),
            );
        },
        {discrete: true},
      );
      editor.update(
        () => {
          expect(moved.getTextContentSize()).toBe(
            moved.getTextContent().length,
          );
          target.append(moved);
          text.setTextContent('Changed text');
        },
        {discrete: true},
      );
      editor.read(() => {
        expect(moved.getTextContentSize()).toBe(moved.getTextContent().length);
        expect(target.getTextContentSize()).toBe(
          target.getTextContent().length,
        );
        expect($getRoot().getTextContent()).toBe(
          '~"Changed text"\n\nFirst\n\nSecond\n\nThird',
        );
        expect($getRoot().getTextContentSize()).toBe(
          $getRoot().getTextContent().length,
        );
      });
    });

    test('includes slots in custom text when they change or are removed', () => {
      using editor = createEditor();
      let paragraph: typeof CustomParagraphNode.prototype;
      let title: TextNode;
      editor.update(
        () => {
          paragraph = $create(CustomParagraphNode).append(
            $createTextNode('Body'),
          );
          title = $createTextNode('Title');
          $setSlot(paragraph, 'title', $createParagraphNode().append(title));
          $getRoot().clear().append(paragraph);
        },
        {discrete: true},
      );
      editor.read(() =>
        expect($getRoot().getTextContent()).toBe('~"TitleBody"'),
      );
      editor.update(() => title.setTextContent('Updated'), {discrete: true});
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('~"UpdatedBody"');
        expect(paragraph.getTextContentSize()).toBe(
          paragraph.getTextContent().length,
        );
        expect($getRoot().getTextContentSize()).toBe(
          $getRoot().getTextContent().length,
        );
      });
      editor.update(() => $removeSlot(paragraph, 'title'), {discrete: true});
      editor.read(() => expect($getRoot().getTextContent()).toBe('~"Body"'));
    });
  },
);
