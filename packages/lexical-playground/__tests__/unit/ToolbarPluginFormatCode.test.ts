/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {CodeNode} from '@lexical/code';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {formatCode} from '../../src/plugins/ToolbarPlugin/utils';

function createEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension],
      name: 'test',
      nodes: [CodeNode],
    }),
  );
}

/**
 * Render the editor state to a compact string for assertions:
 *
 *   "p:hello world|code:foo"
 *
 * Each block becomes `type:textcontent`, separated by `|`. The text
 * content uses the node's getTextContent() output.
 */
const $serializeBlocks = (): string =>
  $getRoot()
    .getChildren()
    .map(child => `${child.getType()}:${child.getTextContent()}`)
    .join('|');

describe('formatCode (Toolbar) — selection-aware code block conversion', () => {
  test.for([
    {
      end: 'hello world'.length,
      expected: 'code:hello world',
      name: 'full',
      start: 0,
      text: 'hello world',
    },
    {
      end: 'hello'.length,
      expected: 'code:hello|paragraph: world',
      name: 'start',
      start: 0,
      text: 'hello world',
    },
    {
      end: 'before middle'.length,
      expected: 'paragraph:before |code:middle|paragraph: after',
      name: 'middle (#6324)',
      start: 'before '.length,
      text: 'before middle after',
    },
    {
      end: 'hello world'.length,
      expected: 'paragraph:hello |code:world',
      name: 'end',
      start: 'hello '.length,
      text: 'hello world',
    },
  ])('paragraph $name selection', ({text, start, end, expected}) => {
    using editor = createEditor();
    editor.update(
      () => {
        const node = $createTextNode(text);
        $getRoot().clear().append($createParagraphNode().append(node));
        node.select(start, end);
      },
      {discrete: true},
    );

    editor.update(() => formatCode(editor, 'paragraph'), {discrete: true});

    expect(editor.read($serializeBlocks)).toBe(expected);
  });

  test.for([
    {
      end: 'Heading'.length,
      expected: 'code:Heading',
      headingTag: 'h1' as const,
      name: 'full from offset 0 (regression for #8446 crash)',
      start: 0,
      text: 'Heading',
    },
    {
      end: 'Head'.length,
      expected: 'code:Head|paragraph:ing',
      headingTag: 'h1' as const,
      name: 'partial from offset 0 (regression for detached firstBlock)',
      start: 0,
      text: 'Heading',
    },
    {
      end: 'Section title'.length,
      expected: 'heading:Section |code:title',
      headingTag: 'h2' as const,
      name: 'partial middle',
      start: 'Section '.length,
      text: 'Section title',
    },
  ])('heading $name', ({text, headingTag, start, end, expected}) => {
    using editor = createEditor();
    editor.update(
      () => {
        const node = $createTextNode(text);
        $getRoot().clear().append($createHeadingNode(headingTag).append(node));
        node.select(start, end);
      },
      {discrete: true},
    );

    editor.update(() => formatCode(editor, headingTag), {discrete: true});

    expect(editor.read($serializeBlocks)).toBe(expected);
  });

  test('Selection spanning two paragraphs converts to one code block', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const firstText = $createTextNode('first');
        const secondText = $createTextNode('second');
        $getRoot()
          .clear()
          .append($createParagraphNode().append(firstText))
          .append($createParagraphNode().append(secondText));
        firstText
          .select(0, 0)
          .setTextNodeRange(firstText, 0, secondText, 'second'.length);
      },
      {discrete: true},
    );

    editor.update(() => formatCode(editor, 'paragraph'), {discrete: true});

    expect(editor.read($serializeBlocks)).toBe('code:first\nsecond');
  });

  test('Selection spanning paragraph + heading converts both into one code block', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const paraText = $createTextNode('first');
        const headingText = $createTextNode('second');
        $getRoot()
          .clear()
          .append($createParagraphNode().append(paraText))
          .append($createHeadingNode('h1').append(headingText));
        paraText
          .select(0, 0)
          .setTextNodeRange(paraText, 0, headingText, 'second'.length);
      },
      {discrete: true},
    );

    editor.update(() => formatCode(editor, 'paragraph'), {discrete: true});

    // Block boundaries become newlines inside the code block; the
    // outer multi-block selection is replaced with a single code block.
    expect(editor.read($serializeBlocks)).toBe('code:first\nsecond');
  });

  test('Paragraph with soft line breaks splits into separate blocks before code conversion', () => {
    // The legacy splitter was meant to keep <br>-separated lines from
    // bleeding around the new code block. Verify the selection on the
    // middle line produces three sibling blocks rather than two
    // paragraphs with stray line breaks.
    using editor = createEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('line1'));
        paragraph.append($createLineBreakNode());
        const middle = $createTextNode('line2');
        paragraph.append(middle);
        paragraph.append($createLineBreakNode());
        paragraph.append($createTextNode('line3'));
        $getRoot().clear().append(paragraph);
        middle.select(0, 'line2'.length);
      },
      {discrete: true},
    );

    editor.update(() => formatCode(editor, 'paragraph'), {discrete: true});

    expect(editor.read($serializeBlocks)).toBe(
      'paragraph:line1|code:line2|paragraph:line3',
    );
  });
});
