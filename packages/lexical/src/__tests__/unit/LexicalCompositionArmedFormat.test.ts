/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * A format or style armed on a collapsed caret must survive an IME that
 * empties the composition and commits it with a plain `insertText`, which is
 * what ibus-hangul does on Chromium for every Korean syllable:
 *
 *   compositionstart → insertCompositionText(한) → insertCompositionText('')
 *   → compositionend('') → beforeinput insertText(한)
 *
 * Once the composing node's DOM is emptied, the DOM caret resolves to the end
 * of the text node before it. That is not a caret move, so the selection must
 * not take that node's format and style.
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {domOverride, DOMRenderExtension} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {$patchStyleText} from '@lexical/selection';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  configExtension,
  FORMAT_TEXT_COMMAND,
  getDOMTextNode,
  IS_BOLD,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';

import {
  COMPOSITION_START_CHAR,
  COMPOSITION_SUFFIX,
} from '../../LexicalConstants';

vi.mock('lexical/src/environment', async importOriginal => ({
  ...(await importOriginal<typeof import('lexical/src/environment')>()),
  CAN_USE_BEFORE_INPUT: true,
}));

// What ibus-hangul on Chromium leaves in the composing node once it has
// emptied it: one zero-width space (the start character and the suffix are
// both that character on Chromium)
const EMPTIED = COMPOSITION_START_CHAR;

function mountEditor(
  runs: [text: string, format: number][],
  {appendChild = false}: {appendChild?: boolean} = {},
) {
  const container = document.createElement('div');
  container.contentEditable = 'true';
  document.body.appendChild(container);
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      const nodes = runs.map(([text, format]) =>
        $createTextNode(text).setFormat(format),
      );
      $getRoot().append($createParagraphNode().append(...nodes));
      nodes[0].selectEnd();
    },
    dependencies: [
      RichTextExtension,
      // An append-only DOM override, as LexicalTextNode's createDOM allows
      ...(appendChild
        ? [
            configExtension(DOMRenderExtension, {
              overrides: [
                domOverride([TextNode], {
                  $createDOM: (_node, $next) => {
                    const dom = $next();
                    const badge = document.createElement('span');
                    badge.contentEditable = 'false';
                    badge.textContent = '\u2022';
                    dom.appendChild(badge);
                    return dom;
                  },
                }),
              ],
            }),
          ]
        : []),
    ],
    name: 'test',
  });
  editor.setRootElement(container);
  onTestFinished(() => {
    editor.dispose();
    document.body.removeChild(container);
  });
  return {container, editor};
}

function getDOMText(editor: LexicalEditor, key: string): Text {
  const text = getDOMTextNode(editor.getElementByKey(key));
  assert(text !== null, `no DOM text for ${key}`);
  return text;
}

function placeDOMCaret(text: Text, offset: number) {
  const domSelection = window.getSelection();
  assert(domSelection !== null);
  domSelection.collapse(text, offset);
}

function getTextKeys(editor: LexicalEditor): string[] {
  return editor.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(node => node.getKey()),
  );
}

function readState(editor: LexicalEditor) {
  return editor.read(() => {
    const selection = $getSelection();
    assert($isRangeSelection(selection));
    return {
      format: selection.format,
      runs: $getRoot()
        .getAllTextNodes()
        .map(node => [node.getTextContent(), node.getFormat()]),
      style: selection.style,
    };
  });
}

/**
 * Composes one syllable as ibus-hangul does on Chromium, at a caret that ends
 * a text node. `between` runs once the composing node's DOM is emptied, before
 * compositionend. `endAt` is where the DOM caret is at compositionend (by
 * default, where Chromium puts it: back where the composition started).
 */
function composeLikeIbus(
  editor: LexicalEditor,
  container: HTMLElement,
  {
    between,
    commit = '한',
    domAtEnd = EMPTIED,
    endAt,
  }: {
    between?: (target: LexicalEditor) => void;
    commit?: string;
    domAtEnd?: string;
    endAt?: (keys: string[]) => [key: string, offset: number];
  } = {},
) {
  const [startKey, startOffset] = editor.read(() => {
    const selection = $getSelection();
    assert($isRangeSelection(selection) && selection.isCollapsed());
    return [selection.anchor.key, selection.anchor.offset];
  });
  container.dispatchEvent(
    new CompositionEvent('compositionstart', {bubbles: true, data: ''}),
  );
  editor.read(() => {});
  const compositionKey = editor._compositionKey;
  assert(compositionKey !== null, 'no composition');
  // The IME types the syllable into the composing node...
  const composing = getDOMText(editor, compositionKey);
  composing.nodeValue = COMPOSITION_START_CHAR + commit + COMPOSITION_SUFFIX;
  placeDOMCaret(composing, 1 + commit.length);
  container.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      data: commit,
      inputType: 'insertCompositionText',
    }),
  );
  editor.read(() => {});
  // ...then empties it, and the DOM caret falls back into the node before it
  getDOMText(editor, compositionKey).nodeValue = domAtEnd;
  placeDOMCaret(getDOMText(editor, startKey), startOffset);
  if (between) {
    between(editor);
  }
  const [endKey, endOffset] = endAt
    ? endAt(getTextKeys(editor))
    : [startKey, startOffset];
  placeDOMCaret(getDOMText(editor, endKey), endOffset);
  const emptied = !domAtEnd.includes(commit);
  container.dispatchEvent(
    new CompositionEvent('compositionend', {
      bubbles: true,
      data: emptied ? '' : commit,
    }),
  );
  editor.read(() => {});
  if (!emptied) {
    // The composed text stayed in the DOM: compositionend committed it.
    return;
  }
  placeDOMCaret(getDOMText(editor, endKey), endOffset);
  container.dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: commit,
      inputType: 'insertText',
    }),
  );
  editor.read(() => {});
}

describe('A format armed before an IME empties the composition', () => {
  test.for([
    {kind: 'as ibus-hangul on Chromium does'},
    {
      kind: 'leaving more than one start character',
      options: {
        domAtEnd:
          COMPOSITION_START_CHAR + COMPOSITION_START_CHAR + COMPOSITION_SUFFIX,
      },
    },
    {
      kind: 'with an update between the emptying and compositionend',
      options: {
        between: (editor: LexicalEditor) =>
          editor.update(() => {}, {discrete: true}),
      },
    },
    {
      appendChild: true,
      kind: 'into a text span that a DOM override appends to',
    },
  ])('bold armed after plain text is kept, $kind', ({appendChild, options}) => {
    const {container, editor} = mountEditor([['ab', 0]], {appendChild});
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
    composeLikeIbus(editor, container, options);
    expect(readState(editor)).toMatchObject({
      format: IS_BOLD,
      runs: [
        ['ab', 0],
        ['한', IS_BOLD],
      ],
    });
  });

  test('bold turned off after bold text is kept off', () => {
    const {container, editor} = mountEditor([['ab', 0]]);
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.insertText('cd');
      },
      {discrete: true},
    );
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
    composeLikeIbus(editor, container);
    expect(readState(editor)).toMatchObject({
      format: 0,
      runs: [
        ['ab', 0],
        ['cd', IS_BOLD],
        ['한', 0],
      ],
    });
  });

  test('an armed style is kept', () => {
    const {container, editor} = mountEditor([['ab', 0]]);
    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        $patchStyleText(selection, {color: 'red'});
      },
      {discrete: true},
    );
    composeLikeIbus(editor, container);
    expect(readState(editor)).toMatchObject({style: 'color: red;'});
    expect(
      editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(node => [node.getTextContent(), node.getStyle()]),
      ),
    ).toEqual([
      ['ab', ''],
      ['한', 'color: red;'],
    ]);
  });

  // Each of these is a caret move, so the caret takes the format it lands in
  test.for([
    {
      expected: 0,
      kind: 'the commit leaves the composed text in the DOM',
      options: {domAtEnd: EMPTIED + '한'},
    },
    {
      expected: 0,
      kind: 'the caret lands inside the text node before',
      options: {endAt: (keys: string[]): [string, number] => [keys[0], 1]},
    },
    {
      expected: IS_BOLD,
      kind: 'the caret lands in the text node after',
      options: {
        endAt: (keys: string[]): [string, number] => [keys[keys.length - 1], 1],
      },
    },
    {
      // The offset that would end the text node before
      expected: IS_BOLD,
      kind: 'the caret lands in the text node after, at offset 2',
      options: {
        endAt: (keys: string[]): [string, number] => [keys[keys.length - 1], 2],
      },
    },
  ])('italic armed is not kept when $kind', ({expected, options}) => {
    const {container, editor} = mountEditor([
      ['ab', 0],
      ['CD', IS_BOLD],
    ]);
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic');
    composeLikeIbus(editor, container, options);
    expect(readState(editor).format).toBe(expected);
  });
});
