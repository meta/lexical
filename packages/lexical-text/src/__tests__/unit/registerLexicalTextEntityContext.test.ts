/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// A text node after a plain text node of another format: the first match in
// it is found after the previous node's text, as the previous node's own
// transform checks it (#9637). Typing a space inside "dogcat" between bold
// "x" and bold "y" made "dog" an entity (a match at the start of the node's
// own text), which the transform of "x" undid ("xdog" has no "dog"), and so
// on until Lexical gave up ("One or more transforms are endlessly
// triggering additional transforms") and the update was lost.

import {registerLexicalTextEntity} from '@lexical/text';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  createEditor,
  type ElementNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

class KeywordNode extends TextNode {
  $config() {
    return this.config('test-context-keyword', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
  canInsertTextBefore(): boolean {
    return false;
  }
  canInsertTextAfter(): boolean {
    return false;
  }
}

// "cat" or "dog" with no letter next to it.
const KEYWORD = /(^|[^a-z#])(cat|dog)(?=[^a-z]|$)/;

// Lookbehinds, which the browsers Lexical supports may lack (the tests run
// in Node).
// eslint-disable-next-line compat/compat
const LOOKBEHIND_DOG = /(?<=@)dog/;
// eslint-disable-next-line compat/compat
const LOOKBEHIND_DOG_OR_CAT = /(?<=@)dog|\bcat\b/;
// eslint-disable-next-line compat/compat
const DOG_OR_LOOKBEHIND_UPPER = /dog|(?<=@)DOG/;

// The match of `regex`, or for KEYWORD of its second group.
function matcher(regex: RegExp) {
  return (text: string) => {
    const m = regex.exec(text);
    if (m === null) {
      return null;
    }
    const lead = regex === KEYWORD ? m[1].length : 0;
    const word = regex === KEYWORD ? m[2] : m[0];
    return {end: m.index + lead + word.length, start: m.index + lead};
  };
}

function editorWith(
  texts: string[],
  regex: RegExp,
  normalize: (text: string) => string = text => text,
) {
  const editor = createEditor({
    nodes: [KeywordNode],
    onError: e => {
      throw e;
    },
  });
  registerLexicalTextEntity(editor, matcher(regex), KeywordNode, node =>
    $create(KeywordNode).setTextContent(normalize(node.getTextContent())),
  );
  editor.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append(
          // "*" makes a node bold, "_" italic.
          ...texts.map(t => {
            const node = $createTextNode(t.replace(/^[*_]/, ''));
            return t.startsWith('*')
              ? node.toggleFormat('bold')
              : t.startsWith('_')
                ? node.toggleFormat('italic')
                : node;
          }),
        ),
      );
    },
    {discrete: true},
  );
  return editor;
}

/** Type `typed` at `offset` in child `index`: the text and the entities. */
function typeInto(
  texts: string[],
  index: number,
  offset: number,
  typed: string,
  regex: RegExp = KEYWORD,
  normalize?: (text: string) => string,
): {text: string; entities: string[]} {
  const editor = editorWith(texts, regex, normalize);
  editor.update(
    () => {
      const node = (
        $getRoot().getFirstChildOrThrow() as ElementNode
      ).getChildAtIndex(index) as TextNode;
      const selection = $createRangeSelection();
      selection.anchor.set(node.getKey(), offset, 'text');
      selection.focus.set(node.getKey(), offset, 'text');
      $setSelection(selection);
      selection.insertText(typed);
    },
    {discrete: true},
  );
  return editor.getEditorState().read(() => ({
    entities: $getRoot()
      .getAllTextNodes()
      .filter(n => n instanceof KeywordNode)
      .map(n => n.getTextContent()),
    text: $getRoot().getTextContent(),
  }));
}

describe('registerLexicalTextEntity after a plain text node of another format', () => {
  test('bold "x" | "dogcat" | bold "y", a space after "dog": no entity', () => {
    expect(typeInto(['*x', 'dogcat', '*y'], 1, 3, ' ')).toEqual({
      entities: [],
      text: 'xdog caty',
    });
  });
  test('bold "x" | "dogcat" | bold "dog", an emoji after "dog": no entity', () => {
    expect(typeInto(['*x', 'dogcat', '*dog'], 1, 3, '😀')).toEqual({
      entities: [],
      text: 'xdog😀catdog',
    });
  });
  test('bold " " | "dogcat" | bold "y", a space after "dog": "dog" is an entity', () => {
    expect(typeInto(['* ', 'dogcat', '*y'], 1, 3, ' ')).toEqual({
      entities: ['dog'],
      text: ' dog caty',
    });
  });
  test('bold "x" | "a dogcat" | bold "y", a space after "dog": "dog" is an entity', () => {
    expect(typeInto(['*x', 'a dogcat', '*y'], 1, 5, ' ')).toEqual({
      entities: ['dog'],
      text: 'xa dog caty',
    });
  });
  test('"dogcat" | bold "y", a space after "dog": "dog" is an entity', () => {
    expect(typeInto(['dogcat', '*y'], 0, 3, ' ')).toEqual({
      entities: ['dog'],
      text: 'dog caty',
    });
  });

  // A match that needs the text before it (a lookbehind) is not made an
  // entity: an entity is checked on its own text, which would undo it.
  test('a lookbehind match after a bold "@": no entity, the update goes through', () => {
    expect(typeInto(['*@', 'do', '*!'], 1, 2, 'g', LOOKBEHIND_DOG)).toEqual({
      entities: [],
      text: '@dog!',
    });
  });
  test('a lookbehind or a word: the word after a bold space is an entity', () => {
    expect(
      typeInto(['*@', 'dog ca', '*!'], 1, 6, 't', LOOKBEHIND_DOG_OR_CAT),
    ).toEqual({entities: ['cat'], text: '@dog cat!'});
  });
  // createNode may change the text (to lower case): the entity is checked on
  // the text it gets.
  test('a lookbehind match that createNode makes a match of its own: an entity', () => {
    expect(
      typeInto(['*x', '@DO', '*!'], 1, 3, 'G', DOG_OR_LOOKBEHIND_UPPER, text =>
        text.toLowerCase(),
      ),
    ).toEqual({entities: ['dog'], text: 'x@dog!'});
  });
  test('a word boundary match after a bold letter: no entity', () => {
    expect(typeInto(['*x', 'do', '*!'], 1, 2, 'g', /\bdog\b/)).toEqual({
      entities: [],
      text: 'xdog!',
    });
  });
  test('a word boundary match after a bold space: an entity', () => {
    expect(typeInto(['* ', 'do', '*!'], 1, 2, 'g', /\bdog\b/)).toEqual({
      entities: ['dog'],
      text: ' dog!',
    });
  });

  // Random texts of keywords and other pieces between two bold ones, and a
  // character typed anywhere in the middle one: the transforms settle.
  test('random texts between formatted neighbours settle', () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = (list: string[]) => list[Math.floor(random() * list.length)];
    const pieces = (list: string[], n: number) =>
      Array.from({length: n}, () => pick(list)).join('');
    const MIDDLE = ['dog', 'cat', 'do', 'g', ' ', 'x'];
    const SIDE = ['x', 'y', ' ', 'dog', 'a '];
    let thrown = 0;
    for (let i = 0; i < 2000; i++) {
      const middle = pieces(MIDDLE, 1 + Math.floor(random() * 3));
      const texts = [
        '*' + pieces(SIDE, 1 + Math.floor(random() * 2)),
        middle,
        '*' + pieces(SIDE, 1 + Math.floor(random() * 2)),
      ];
      const offset = Math.floor(random() * (middle.length + 1));
      const typed = pick([' ', 'x', '😀']);
      try {
        typeInto(texts, 1, offset, typed);
      } catch (error) {
        thrown++;
        expect.fail(`${JSON.stringify({offset, texts, typed})}: ${error}`);
      }
    }
    expect(thrown).toBe(0);
  });
});
