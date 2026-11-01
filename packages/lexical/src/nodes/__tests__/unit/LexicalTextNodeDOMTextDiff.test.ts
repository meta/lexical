/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setCompositionKey,
  type LexicalEditor,
} from 'lexical';
import {
  afterEach,
  assert,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';

// Lexical's composition suffix outside Apple platforms.
const COMPOSITION_SUFFIX = '\u200B';

const env = vi.hoisted(() => ({IS_CHROME: false, IS_FIREFOX: false}));

vi.mock('lexical/src/environment', async importOriginal => ({
  ...(await importOriginal<object>()),
  get IS_CHROME() {
    return env.IS_CHROME;
  },
  get IS_FIREFOX() {
    return env.IS_FIREFOX;
  },
}));

function setUpEditor(): LexicalEditor {
  const container = document.createElement('div');
  container.contentEditable = 'true';
  document.body.appendChild(container);
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Teh quick fxo')),
      );
    },
    dependencies: [RichTextExtension],
    name: 'test',
  });
  editor.setRootElement(container);
  onTestFinished(() => {
    editor.dispose();
    container.remove();
  });
  return editor;
}

// A live Range over a word the update doesn't touch stands in for a
// spellcheck marker: assigning nodeValue replaces the node's whole data and
// collapses it, writing only the changed part shifts it along.
function rangeAfterEdit(
  editor: LexicalEditor,
  nextText: string,
  composing = false,
): string {
  const domText = editor.getRootElement()!.querySelector('span')!.firstChild!;
  const range = document.createRange();
  range.setStart(domText, 10);
  range.setEnd(domText, 13);
  editor.update(
    () => {
      const textNode = $getRoot().getFirstDescendant();
      assert($isTextNode(textNode));
      if (composing) {
        $setCompositionKey(textNode.getKey());
      }
      textNode.setTextContent(nextText);
    },
    {discrete: true},
  );
  expect(editor.getRootElement()!.querySelector('span')!.firstChild).toBe(
    domText,
  );
  expect(domText.nodeValue).toBe(
    composing ? nextText + COMPOSITION_SUFFIX : nextText,
  );
  return range.toString();
}

describe('TextNode DOM text writes', () => {
  afterEach(() => {
    env.IS_CHROME = false;
    env.IS_FIREFOX = false;
  });

  test.each(['IS_CHROME', 'IS_FIREFOX'] as const)(
    'rewrites only the changed part of the DOM text when %s',
    flag => {
      env[flag] = true;
      expect(rangeAfterEdit(setUpEditor(), 'The quick brown fxo')).toBe('fxo');
    },
  );

  test('a pure deletion keeps a range after it', () => {
    env.IS_CHROME = true;
    expect(rangeAfterEdit(setUpEditor(), 'Teh fxo')).toBe('fxo');
  });

  test('rewrites only the changed part during composition in any engine', () => {
    // The composition suffix is written after the text, so append to keep
    // the diff clear of the range.
    expect(rangeAfterEdit(setUpEditor(), 'Teh quick fxo jumsp', true)).toBe(
      'fxo',
    );
  });

  test('replaces the whole DOM text in other engines, such as WebKit', () => {
    expect(rangeAfterEdit(setUpEditor(), 'The quick brown fxo')).toBe('');
  });
});
