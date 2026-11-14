/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A block with more children than a call can take as arguments (a pasted
// text with that many line feeds is one paragraph of text nodes and line
// breaks), through the selection operations that move a block's children as
// a list. The `unit-size` project runs this file on a child process's main
// thread, whose argument limit (131,072 on Node) is the one production code
// runs under; spreading such a list into `append(...)` throws
// `RangeError: Maximum call stack size exceeded` there.

import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $insertNodes,
  $isElementNode,
  $isLineBreakNode,
  $splitNode,
  createEditor,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

/**
 * The smallest power of two of arguments a spread into a call throws on in
 * this runtime (Node's main thread: 131,072; a worker thread: 524,288).
 */
function argumentLimit(): number {
  for (let n = 1 << 16; n <= 1 << 24; n *= 2) {
    const items = new Array<string>(n).fill('x');
    try {
      [].push(...(items as never[]));
    } catch {
      return n;
    }
  }
  throw new Error('no argument limit up to 2^24');
}

const LIMIT = argumentLimit();
/** Children of the large block: past the limit, and past 130,000. */
const CHILDREN = Math.max(130_000, LIMIT) + 4_096;

/** A paragraph of `CHILDREN` nodes: a text and a line break each pair. */
function $largeParagraph(): ParagraphNode {
  const paragraph = $createParagraphNode();
  const children: LexicalNode[] = [];
  for (let i = 0; i < CHILDREN / 2; i++) {
    children.push($createTextNode('d'), $createLineBreakNode());
  }
  for (let i = 0; i < children.length; i += 4096) {
    paragraph.append(...children.slice(i, i + 4096));
  }
  return paragraph;
}

/** The root's block at `index` (from the end when negative). */
function $block(index: number): ElementNode {
  const root = $getRoot();
  const block = root.getChildAtIndex(
    index < 0 ? root.getChildrenSize() + index : index,
  );
  if (!$isElementNode(block)) {
    throw new Error(`no block at ${index}`);
  }
  return block;
}

function editorWith($build: () => void): LexicalEditor {
  const editor = createEditor({
    namespace: 'size',
    nodes: [],
    onError: error => {
      throw error;
    },
  });
  editor.update($build, {discrete: true});
  return editor;
}

/** Each block's child count and text, line breaks as `\n`. */
function blocks(editor: LexicalEditor): {children: number; text: string}[] {
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(block => ({
        children: $isElementNode(block) ? block.getChildrenSize() : 0,
        text: block.getTextContent(),
      })),
  );
}

const LARGE_TEXT = 'd\n'.repeat(CHILDREN / 2);

describe('a block with more children than a call takes as arguments', () => {
  test('runs on a main thread', () => {
    expect(LIMIT).toBeLessThanOrEqual(131_072);
    expect(CHILDREN).toBeGreaterThan(130_000);
  });

  test('insertParagraph after its first child moves the rest into a new block', () => {
    const editor = editorWith(() => {
      $getRoot().append($largeParagraph());
    });
    editor.update(
      () => {
        const first = $block(0);
        const selection = first.selectStart();
        selection.anchor.set(first.getKey(), 1, 'element');
        selection.focus.set(first.getKey(), 1, 'element');
        selection.insertParagraph();
      },
      {discrete: true},
    );
    expect(blocks(editor)).toEqual([
      {children: 1, text: 'd'},
      {children: CHILDREN - 1, text: LARGE_TEXT.slice(1)},
    ]);
  });

  test('inserting it at the end of a paragraph merges its children in', () => {
    const editor = editorWith(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('a')));
    });
    editor.update(
      () => {
        $block(0).selectEnd();
        $insertNodes([$largeParagraph()]);
      },
      {discrete: true},
    );
    // As for a small block: the text joins 'a', and the trailing line break
    // is dropped.
    expect(blocks(editor)).toEqual([
      {children: CHILDREN - 1, text: 'a' + LARGE_TEXT.slice(0, -1)},
    ]);
  });

  test('inserting blocks inside it joins its tail to the last inserted block', () => {
    const editor = editorWith(() => {
      $getRoot().append($largeParagraph());
    });
    editor.update(
      () => {
        const first = $block(0);
        const selection = first.selectStart();
        selection.anchor.set(first.getKey(), 1, 'element');
        selection.focus.set(first.getKey(), 1, 'element');
        $insertNodes([
          $createParagraphNode().append($createTextNode('x')),
          $createParagraphNode().append($createTextNode('y')),
        ]);
      },
      {discrete: true},
    );
    expect(blocks(editor).map(b => b.text)).toEqual([
      'dx',
      'y' + LARGE_TEXT.slice(1),
    ]);
  });

  test('$splitNode after its first child moves the rest into a copy', () => {
    const editor = editorWith(() => {
      $getRoot().append($largeParagraph());
    });
    editor.update(
      () => {
        $splitNode($block(0), 1);
      },
      {discrete: true},
    );
    expect(blocks(editor)).toEqual([
      {children: 1, text: 'd'},
      {children: CHILDREN - 1, text: LARGE_TEXT.slice(1)},
    ]);
  });

  test('its text and line breaks read back', () => {
    const editor = editorWith(() => {
      $getRoot().append($largeParagraph());
    });
    const breaks = editor.read(
      () => $block(0).getChildren().filter($isLineBreakNode).length,
    );
    expect(breaks).toBe(CHILDREN / 2);
  });
});
