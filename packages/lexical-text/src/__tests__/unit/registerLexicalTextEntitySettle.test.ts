/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// registerLexicalTextEntity's transforms must settle wherever an edit leaves
// text between text nodes of other formats (#9637), and settle on the same
// entities as a fresh parse of the text they leave.

import {
  $createHashtagNode,
  HashtagExtension,
  HashtagNode,
} from '@lexical/hashtag';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  createEditor,
  type ElementNode,
  type LexicalEditor,
  type RangeSelection,
  type TextFormatType,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {type EntityMatch, registerLexicalTextEntity} from '../..';

class KeywordNode extends TextNode {
  $config() {
    return this.config('test-keyword', {extends: TextNode});
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

class TagNode extends TextNode {
  $config() {
    return this.config('test-tag', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
  canInsertTextBefore(): boolean {
    return false;
  }
}

/** The issue's matcher: `cat` or `dog` with no letter next to them. */
function keywordMatch(text: string): null | EntityMatch {
  const m = /(^|[^a-z#])(cat|dog)(?=[^a-z]|$)/.exec(text);
  return m === null
    ? null
    : {end: m.index + m[1].length + m[2].length, start: m.index + m[1].length};
}

/** A hashtag-like matcher: `#` and letters, after the start or a space. */
function tagMatch(text: string): null | EntityMatch {
  const m = /(^|\s)(#[a-z]+)/.exec(text);
  return m === null
    ? null
    : {end: m.index + m[1].length + m[2].length, start: m.index + m[1].length};
}

/**
 * `dog` with no letter before or after it, where the letter before is looked
 * at but not taken into the match, like a regex lookbehind
 * (`/(?<![a-z])dog(?![a-z])/`).
 */
function lookbehindMatch(text: string, word = 'dog'): null | EntityMatch {
  const isLetter = (c: string | undefined) =>
    c !== undefined && /[a-z]/i.test(c);
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    if (!isLetter(text[i - 1]) && !isLetter(text[i + word.length])) {
      return {end: i + word.length, start: i};
    }
  }
  return null;
}

type Matcher = 'keyword' | 'tag' | 'lookbehind';

const MATCHERS: Record<Matcher, (text: string) => null | EntityMatch> = {
  keyword: keywordMatch,
  lookbehind: lookbehindMatch,
  tag: tagMatch,
};

function makeEditor(
  matcher: Matcher = 'keyword',
  getMatch?: (text: string) => null | EntityMatch,
): LexicalEditor {
  const editor = createEditor({
    nodes: [KeywordNode, TagNode],
    onError: e => {
      throw e;
    },
  });
  if (matcher === 'tag') {
    registerLexicalTextEntity(
      editor,
      getMatch ?? MATCHERS[matcher],
      TagNode,
      node => $create(TagNode).setTextContent(node.getTextContent()),
    );
  } else {
    registerLexicalTextEntity(editor, MATCHERS[matcher], KeywordNode, node =>
      $create(KeywordNode).setTextContent(node.getTextContent()),
    );
  }
  return editor;
}

/** A run of text: `*` bold, `_` italic, `` ` `` code, then the text. */
type Run = string;

function parseRun(run: Run): {formats: TextFormatType[]; text: string} {
  const formats: TextFormatType[] = [];
  let i = 0;
  for (; i < run.length; i++) {
    const c = run[i];
    if (c === '*') {
      formats.push('bold');
    } else if (c === '_') {
      formats.push('italic');
    } else if (c === '`') {
      formats.push('code');
    } else {
      break;
    }
  }
  return {formats, text: run.slice(i)};
}

function $createRun(run: Run): TextNode {
  const {formats, text} = parseRun(run);
  const node = $createTextNode(text);
  for (const format of formats) {
    node.toggleFormat(format);
  }
  return node;
}

function $paragraph(): ElementNode {
  return $getRoot().getFirstChildOrThrow() as ElementNode;
}

type Out = [type: string, text: string, format: number][];

function $read(): Out {
  return $paragraph()
    .getChildren()
    .filter($isTextNode)
    .map(node => [node.getType(), node.getTextContent(), node.getFormat()]);
}

function read(editor: LexicalEditor): Out {
  return editor.getEditorState().read($read);
}

function setUp(editor: LexicalEditor, runs: Run[]): void {
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append(...runs.map($createRun)));
    },
    {discrete: true},
  );
}

function $select(node: TextNode, offset: number): RangeSelection {
  const sel = $createRangeSelection();
  sel.anchor.set(node.getKey(), offset, 'text');
  sel.focus.set(node.getKey(), offset, 'text');
  $setSelection(sel);
  return sel;
}

/** Type into run `index` at `offset` of a paragraph made of `runs`. */
function typeInto(
  runs: Run[],
  index: number,
  offset: number,
  typed: string,
  matcher: Matcher = 'keyword',
): LexicalEditor {
  const editor = makeEditor(matcher);
  setUp(editor, runs);
  editor.update(
    () => {
      const node = $paragraph().getChildAtIndex(index) as TextNode;
      $select(node, offset).insertText(typed);
    },
    {discrete: true},
  );
  return editor;
}

/**
 * The text of a paragraph as runs of one format each, adjacent runs of the
 * same format joined: what a fresh parse starts from.
 */
function toRuns(out: Out): [text: string, format: number][] {
  const runs: [string, number][] = [];
  for (const [, text, format] of out) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[1] === format) {
      last[0] += text;
    } else {
      runs.push([text, format]);
    }
  }
  return runs;
}

/** The nodes the transforms settle on when they parse `runs` from scratch. */
function freshParse(
  runs: [text: string, format: number][],
  matcher: Matcher,
  getMatch?: (text: string) => null | EntityMatch,
): Out {
  const editor = makeEditor(matcher, getMatch);
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(
            ...runs.map(([text, format]) =>
              $createTextNode(text).setFormat(format),
            ),
          ),
        );
    },
    {discrete: true},
  );
  return read(editor);
}

function expectFreshParse(editor: LexicalEditor, matcher: Matcher): void {
  const out = read(editor);
  expect(out).toEqual(freshParse(toRuns(out), matcher));
}

const B = 1; // IS_BOLD

describe('registerLexicalTextEntity between text nodes of other formats (#9637)', () => {
  test('bold "x" | "dogcat" | bold "y", a space after "dog": settles, no entity', () => {
    const editor = typeInto(['*x', 'dogcat', '*y'], 1, 3, ' ');
    expect(read(editor)).toEqual([
      ['text', 'x', B],
      ['text', 'dog cat', 0],
      ['text', 'y', B],
    ]);
    expectFreshParse(editor, 'keyword');
  });

  test('bold "x" | "dogcat" | bold "dog", an emoji after "dog": settles, no entity', () => {
    const editor = typeInto(['*x', 'dogcat', '*dog'], 1, 3, '😀');
    expect(read(editor)).toEqual([
      ['text', 'x', B],
      ['text', 'dog😀cat', 0],
      ['text', 'dog', B],
    ]);
    expectFreshParse(editor, 'keyword');
  });

  test('a later match in the same node is still an entity, and one touching the next node is not', () => {
    const editor = typeInto(['*x', 'dogcat dog', '*y'], 1, 3, ' ');
    expect(read(editor)).toEqual([
      ['text', 'x', B],
      ['text', 'dog ', 0],
      ['test-keyword', 'cat', 0],
      ['text', ' dog', 0],
      ['text', 'y', B],
    ]);
    expectFreshParse(editor, 'keyword');
  });

  test('control: "dogcat" | bold "y", nothing before', () => {
    const editor = typeInto(['dogcat', '*y'], 0, 3, ' ');
    expect(read(editor)).toEqual([
      ['test-keyword', 'dog', 0],
      ['text', ' cat', 0],
      ['text', 'y', B],
    ]);
    expectFreshParse(editor, 'keyword');
  });

  test('control: bold " " | "dogcat" | bold "y", a space before', () => {
    const editor = typeInto(['* ', 'dogcat', '*y'], 1, 3, ' ');
    expect(read(editor)).toEqual([
      ['text', ' ', B],
      ['test-keyword', 'dog', 0],
      ['text', ' cat', 0],
      ['text', 'y', B],
    ]);
    expectFreshParse(editor, 'keyword');
  });

  test('a match that needs a lookbehind is checked against the previous node', () => {
    const touching = typeInto(['*x', 'dogcat', '*y'], 1, 3, ' ', 'lookbehind');
    expect(read(touching)).toEqual([
      ['text', 'x', B],
      ['text', 'dog cat', 0],
      ['text', 'y', B],
    ]);
    const spaced = typeInto(['*x ', 'dogcat', '*y'], 1, 3, ' ', 'lookbehind');
    expect(read(spaced)).toEqual([
      ['text', 'x ', B],
      ['test-keyword', 'dog', 0],
      ['text', ' cat', 0],
      ['text', 'y', B],
    ]);
  });

  test('a hashtag after a formatted letter is not an entity, after a formatted space it is', () => {
    const letter = typeInto(['*a', '#tagx', '*.'], 1, 4, ' ', 'tag');
    expect(read(letter)).toEqual([
      ['text', 'a', B],
      ['text', '#tag x', 0],
      ['text', '.', B],
    ]);
    expectFreshParse(letter, 'tag');
    const space = typeInto(['*a ', '#tagx', '*.'], 1, 4, ' ', 'tag');
    expect(read(space)).toEqual([
      ['text', 'a ', B],
      ['test-tag', '#tag', 0],
      ['text', ' x', 0],
      ['text', '.', B],
    ]);
    expectFreshParse(space, 'tag');
  });

  test('of two matches next to each other, the second stays text, as before', () => {
    const editor = typeInto(['*x ', 'a#b', '*.'], 1, 0, '#', 'tag');
    expect(read(editor)).toEqual([
      ['text', 'x ', B],
      ['test-tag', '#a', 0],
      ['text', '#b', 0],
      ['text', '.', B],
    ]);
    expectFreshParse(editor, 'tag');
  });

  test('entity at the edges of a node, every format combination around it', () => {
    const formats = ['*', '_', '`', '*_'];
    for (const before of formats) {
      for (const after of formats) {
        for (const [left, right] of [
          ['x', 'y'],
          [' ', ' '],
          ['x', ' '],
          [' ', 'y'],
        ]) {
          for (const typed of [' ', '😀', '!', 'z']) {
            const runs = [before + left, 'dogcat', after + right];
            let editor: LexicalEditor | undefined;
            expect(() => {
              editor = typeInto(runs, 1, 3, typed);
            }, JSON.stringify({runs, typed})).not.toThrow();
            const out = read(editor!);
            expect(out.map(([, text]) => text).join('')).toBe(
              left + 'dog' + typed + 'cat' + right,
            );
            expectFreshParse(editor!, 'keyword');
          }
        }
      }
    }
  });

  test('IME composition between two formatted nodes settles, and so does its end', () => {
    const editor = makeEditor();
    setUp(editor, ['*x', 'dogcat', '*y']);
    editor.update(
      () => {
        const node = $paragraph().getChildAtIndex(1) as TextNode;
        $select(node, 3);
        $setCompositionKey(node.getKey());
      },
      {discrete: true},
    );
    for (const typed of ['、', ' ']) {
      expect(() =>
        editor.update(
          () => {
            const node = $paragraph().getChildAtIndex(1) as TextNode;
            $select(node, 3).insertText(typed);
          },
          {discrete: true},
        ),
      ).not.toThrow();
    }
    expect(() =>
      editor.update(
        () => {
          $setCompositionKey(null);
          for (const node of $paragraph().getChildren()) {
            node.markDirty();
          }
        },
        {discrete: true},
      ),
    ).not.toThrow();
    expect(
      read(editor)
        .map(([, text]) => text)
        .join(''),
    ).toBe('xdog 、caty');
    expectFreshParse(editor, 'keyword');
  });

  test('pasting formatted runs around a keyword settles', () => {
    const editor = makeEditor();
    setUp(editor, ['dogcat']);
    expect(() =>
      editor.update(
        () => {
          const node = $paragraph().getFirstChildOrThrow() as TextNode;
          $select(node, 3).insertNodes([
            $createRun('*x'),
            $createRun(' dog '),
            $createRun('*y'),
          ]);
        },
        {discrete: true},
      ),
    ).not.toThrow();
    expect(
      read(editor)
        .map(([, text]) => text)
        .join(''),
    ).toBe('dogx dog ycat');
    expectFreshParse(editor, 'keyword');
  });

  test('bolding the text before an entity turns it back into text', () => {
    const editor = makeEditor();
    setUp(editor, ['xdog cat']);
    editor.update(
      () => {
        const node = $paragraph().getFirstChildOrThrow() as TextNode;
        const [, rest] = node.splitText(1);
        ($paragraph().getFirstChildOrThrow() as TextNode).toggleFormat('bold');
        rest.markDirty();
      },
      {discrete: true},
    );
    expectFreshParse(editor, 'keyword');
  });

  test('typing a letter before an entity after text in another format turns it back into text', () => {
    const editor = makeEditor();
    setUp(editor, ['_😀', 'dog', '*!']);
    expect(read(editor)).toEqual([
      ['text', '😀', 2],
      ['test-keyword', 'dog', 0],
      ['text', '!', B],
    ]);
    editor.update(
      () => {
        const node = $paragraph().getChildAtIndex(1) as TextNode;
        $select(node, 0).insertText('a');
      },
      {discrete: true},
    );
    expect(read(editor)).toEqual([
      ['text', '😀', 2],
      ['text', 'adog', 0],
      ['text', '!', B],
    ]);
  });

  test('an earlier match that ends where the text ends is handled as before', () => {
    // `<word> dog` at the end of the text, or else `dog` anywhere.
    const phrase = (text: string): null | EntityMatch => {
      const whole = /[a-z]+ dog$/.exec(text);
      const word = keywordMatch(text);
      if (whole !== null && (word === null || whole.index <= word.start)) {
        return {end: whole.index + whole[0].length, start: whole.index};
      }
      return word;
    };
    const editor = createEditor({
      nodes: [KeywordNode],
      onError: e => {
        throw e;
      },
    });
    registerLexicalTextEntity(editor, phrase, KeywordNode, node =>
      $create(KeywordNode).setTextContent(node.getTextContent()),
    );
    setUp(editor, ['*z', 'ab dog!']);
    expect(read(editor)).toEqual([
      ['text', 'z', B],
      ['text', 'ab ', 0],
      ['test-keyword', 'dog', 0],
      ['text', '!', 0],
    ]);
  });

  test('a matcher that needs the text after a match settles as before', () => {
    // `dog` when " cat" follows it, or when it is all of the text.
    const followed = (text: string): null | EntityMatch => {
      const m = /^dog$|dog(?= cat)/.exec(text);
      return m === null ? null : {end: m.index + m[0].length, start: m.index};
    };
    const editor = createEditor({
      nodes: [KeywordNode],
      onError: e => {
        throw e;
      },
    });
    registerLexicalTextEntity(editor, followed, KeywordNode, node =>
      $create(KeywordNode).setTextContent(node.getTextContent()),
    );
    setUp(editor, ['*x', '_a dog cat']);
    const I = 2; // IS_ITALIC
    expect(read(editor)).toEqual([
      ['text', 'x', B],
      ['text', 'a ', I],
      ['test-keyword', 'dog', I],
      ['text', ' cat', I],
    ]);
  });

  test('a match at the start of a node that needs the text after it settles after a formatted node', () => {
    // A hashtag when a space follows it, or when it is all of the text.
    const spaced = (text: string): null | EntityMatch => {
      const m = /^#[a-z]+$|#[a-z]+(?= )/.exec(text);
      return m === null ? null : {end: m.index + m[0].length, start: m.index};
    };
    const make = () => {
      const editor = createEditor({
        nodes: [TagNode],
        onError: e => {
          throw e;
        },
      });
      registerLexicalTextEntity(editor, spaced, TagNode, node =>
        $create(TagNode).setTextContent(node.getTextContent()),
      );
      return editor;
    };
    const typed = make();
    setUp(typed, ['*x', '#tagx']);
    typed.update(
      () => {
        $select($paragraph().getChildAtIndex(1) as TextNode, 4).insertText(' ');
      },
      {discrete: true},
    );
    expect(read(typed)).toEqual([
      ['text', 'x', B],
      ['test-tag', '#tag', 0],
      ['text', ' x', 0],
    ]);

    // Removing the space after the entity turns it back into text at once,
    // as a fresh parse of the text does.
    const removed = make();
    setUp(removed, ['*g', 'g#x ']);
    expect(read(removed)).toEqual([
      ['text', 'g', B],
      ['text', 'g', 0],
      ['test-tag', '#x', 0],
      ['text', ' ', 0],
    ]);
    removed.update(
      () => {
        $paragraph().getLastChildOrThrow().remove();
      },
      {discrete: true},
    );
    expect(read(removed)).toEqual([
      ['text', 'g', B],
      ['text', 'g#x', 0],
    ]);
  });

  test('typing before a formatted node with a token or segmented match leaves it as it was', () => {
    for (const mode of ['token', 'segmented'] as const) {
      const editor = createEditor({
        nodes: [TagNode],
        onError: e => {
          throw e;
        },
      });
      registerLexicalTextEntity(editor, tagMatch, TagNode, node =>
        $create(TagNode).setTextContent(node.getTextContent()).setMode(mode),
      );
      setUp(editor, ['#', '*#b ']);
      expect(() =>
        editor.update(
          () => {
            $select($paragraph().getChildAtIndex(0) as TextNode, 1).insertText(
              ' ',
            );
          },
          {discrete: true},
        ),
      ).not.toThrow();
      expect(read(editor)).toEqual([
        ['text', '# ', 0],
        ['text', '#b ', B],
      ]);
    }
  });

  test('a node after an entity in the same format and style but another detail is not its source', () => {
    const spaced = (text: string): null | EntityMatch => {
      const m = /^#[a-z]+$|#[a-z]+(?= )/.exec(text);
      return m === null ? null : {end: m.index + m[0].length, start: m.index};
    };
    const editor = createEditor({
      nodes: [TagNode],
      onError: e => {
        throw e;
      },
    });
    registerLexicalTextEntity(editor, spaced, TagNode, node =>
      $create(TagNode).setTextContent(node.getTextContent()),
    );
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('#x'),
            $createTextNode(' ').setDetail(2), // IS_UNMERGEABLE
          ),
        );
      },
      {discrete: true},
    );
    expect(read(editor)[0]).toEqual(['test-tag', '#x', 0]);
    editor.update(
      () => {
        $select($paragraph().getChildAtIndex(0) as TextNode, 0).insertText('g');
      },
      {discrete: true},
    );
    expect(read(editor)).toEqual([
      ['text', 'g#x', 0],
      ['text', ' ', 0],
    ]);
  });

  test('an entity after a node with an earlier match is checked too', () => {
    const spaced = (text: string): null | EntityMatch => {
      const m = /^#[a-z]+$|#[a-z]+(?= )/.exec(text);
      return m === null ? null : {end: m.index + m[0].length, start: m.index};
    };
    const editor = createEditor({
      nodes: [TagNode],
      onError: e => {
        throw e;
      },
    });
    registerLexicalTextEntity(editor, spaced, TagNode, node =>
      $create(TagNode).setTextContent(node.getTextContent()),
    );
    setUp(editor, ['*x', '_z ', '#b ']);
    expect(read(editor)[2]).toEqual(['test-tag', '#b', 0]);
    editor.update(
      () => {
        ($paragraph().getChildAtIndex(1) as TextNode).setTextContent('#a ');
      },
      {discrete: true},
    );
    editor.update(
      () => {
        $paragraph().getLastChildOrThrow().remove();
      },
      {discrete: true},
    );
    const out = read(editor);
    expect(out).toEqual(freshParse(toRuns(out), 'tag', spaced));
  });

  test('removing the text between an entity and a token after it turns the entity back into text', () => {
    const congrats = (text: string): null | EntityMatch => {
      const m = /(^|[^a-z])(congrats)(?=[^a-z]|$)/i.exec(text);
      return m === null
        ? null
        : {end: m.index + m[1].length + 8, start: m.index + m[1].length};
    };
    const editor = createEditor({
      nodes: [KeywordNode],
      onError: e => {
        throw e;
      },
    });
    registerLexicalTextEntity(editor, congrats, KeywordNode, node =>
      $create(KeywordNode).setTextContent(node.getTextContent()),
    );
    setUp(editor, ['_!', '*!congrats ']);
    editor.update(
      () => {
        $paragraph().append($createRun('*Alice').setMode('token'));
      },
      {discrete: true},
    );
    expect(read(editor)).toEqual([
      ['text', '!', 2],
      ['text', '!', B],
      ['test-keyword', 'congrats', B],
      ['text', ' ', B],
      ['text', 'Alice', B],
    ]);
    editor.update(
      () => {
        $paragraph().getChildAtIndex(3)!.remove();
      },
      {discrete: true},
    );
    expect(read(editor)).toEqual([
      ['text', '!', 2],
      ['text', '!congrats', B],
      ['text', 'Alice', B],
    ]);
  });

  test('an entity is not kept by text after it in another format', () => {
    const spaced = (text: string): null | EntityMatch => {
      const m = /^#[a-z]+$|#[a-z]+(?= )/.exec(text);
      return m === null ? null : {end: m.index + m[0].length, start: m.index};
    };
    const editor = createEditor({
      nodes: [TagNode],
      onError: e => {
        throw e;
      },
    });
    registerLexicalTextEntity(editor, spaced, TagNode, node =>
      $create(TagNode).setTextContent(node.getTextContent()),
    );
    setUp(editor, ['#x', '* ']);
    expect(read(editor)).toEqual([
      ['test-tag', '#x', 0],
      ['text', ' ', B],
    ]);
    editor.update(
      () => {
        $select($paragraph().getChildAtIndex(0) as TextNode, 0).insertText('g');
      },
      {discrete: true},
    );
    // As a fresh parse of "g#x" and a bold " " makes it.
    expect(read(editor)).toEqual([
      ['text', 'g#x', 0],
      ['text', ' ', B],
    ]);
  });

  test('an entity is checked again in each update', () => {
    const spaced = (text: string): null | EntityMatch => {
      const m = /^#[a-z]+$|#[a-z]+(?= )/.exec(text);
      return m === null ? null : {end: m.index + m[0].length, start: m.index};
    };
    const editor = createEditor({
      nodes: [TagNode],
      onError: e => {
        throw e;
      },
    });
    registerLexicalTextEntity(editor, spaced, TagNode, node =>
      $create(TagNode).setTextContent(node.getTextContent()),
    );
    setUp(editor, ['*#ab#ab ', '_a']);
    expect(read(editor)).toEqual([
      ['text', '#ab', B],
      ['test-tag', '#ab', B],
      ['text', ' ', B],
      ['text', 'a', 2],
    ]);
    editor.update(
      () => {
        $select($paragraph().getChildAtIndex(1) as TextNode, 2).insertText('x');
      },
      {discrete: true},
    );
    editor.update(
      () => {
        ($paragraph().getChildAtIndex(1) as TextNode).toggleFormat('bold');
      },
      {discrete: true},
    );
    const out = read(editor);
    expect(out).toEqual(freshParse(toRuns(out), 'tag', spaced));
  });

  test('typing in text before a formatted hashtag marks only that text dirty, so history merges the keystrokes', () => {
    const editor = makeEditor('tag');
    setUp(editor, ['*a', '#foo ', '_#bar']);
    const dirty: number[] = [];
    editor.registerUpdateListener(({dirtyLeaves}) => {
      dirty.push(dirtyLeaves.size);
    });
    for (const c of 'xyz') {
      editor.update(
        () => {
          const node = $paragraph().getChildAtIndex(1) as TextNode;
          $select(node, node.getTextContentSize() - 2).insertText(c);
        },
        {discrete: true},
      );
    }
    expect(dirty).toEqual([1, 1, 1]);
  });

  test('typing in text with a match before a formatted hashtag marks only that text dirty', () => {
    // With @lexical/hashtag's own matcher.
    const editor = createEditor({
      nodes: [HashtagNode],
      onError: e => {
        throw e;
      },
    });
    const config = HashtagExtension.config;
    if (config === undefined) {
      throw new Error('HashtagExtension has a config');
    }
    registerLexicalTextEntity(
      editor,
      config.getHashtagMatch,
      HashtagNode,
      node => $createHashtagNode(node.getTextContent()),
    );
    setUp(editor, ['*#x', '#y!ab#', '_#z']);
    expect(read(editor)[0]).toEqual(['hashtag', '#x', B]);
    const dirty: number[] = [];
    editor.registerUpdateListener(({dirtyLeaves}) => {
      dirty.push(dirtyLeaves.size);
    });
    for (const c of 'cde') {
      editor.update(
        () => {
          const node = $paragraph().getChildAtIndex(1) as TextNode;
          $select(node, node.getTextContentSize() - 2).insertText(c);
        },
        {discrete: true},
      );
    }
    expect(dirty).toEqual([1, 1, 1]);
  });

  test('typing that makes a match at the start of the next node one leaves it text until that node changes', () => {
    const editor = makeEditor('tag');
    setUp(editor, ['a', '*b', '#foo #bar']);
    expect(read(editor)).toEqual([
      ['text', 'a', 0],
      ['text', 'b', B],
      ['text', '#foo ', 0],
      ['test-tag', '#bar', 0],
    ]);
    editor.update(
      () => {
        ($paragraph().getChildAtIndex(1) as TextNode).spliceText(
          1,
          0,
          ' ',
          false,
        );
      },
      {discrete: true},
    );
    expect(read(editor)).toEqual([
      ['text', 'a', 0],
      ['text', 'b ', B],
      ['text', '#foo ', 0],
      ['test-tag', '#bar', 0],
    ]);
    editor.update(
      () => {
        $paragraph().getChildAtIndex(2)!.markDirty();
      },
      {discrete: true},
    );
    expect(read(editor)).toEqual([
      ['text', 'a', 0],
      ['text', 'b ', B],
      ['test-tag', '#foo', 0],
      ['text', ' ', 0],
      ['test-tag', '#bar', 0],
    ]);
  });

  test('a token or segmented entity with text after it in its node settles', () => {
    for (const mode of ['token', 'segmented'] as const) {
      const editor = createEditor({
        nodes: [TagNode],
        onError: e => {
          throw e;
        },
      });
      registerLexicalTextEntity(editor, tagMatch, TagNode, node =>
        $create(TagNode).setTextContent(node.getTextContent()).setMode(mode),
      );
      setUp(editor, ['#a b']);
      expect(read(editor)).toEqual([
        ['test-tag', '#a', 0],
        ['text', ' b', 0],
      ]);
      editor.update(
        () => {
          $select($paragraph().getLastChild() as TextNode, 2).insertText('c');
        },
        {discrete: true},
      );
      expect(read(editor)).toEqual([
        ['test-tag', '#a', 0],
        ['text', ' bc', 0],
      ]);
    }
  });

  test('a token or segmented entity after a match left as text settles', () => {
    for (const mode of ['token', 'segmented'] as const) {
      const editor = createEditor({
        nodes: [TagNode],
        onError: e => {
          throw e;
        },
      });
      registerLexicalTextEntity(editor, tagMatch, TagNode, node =>
        $create(TagNode).setTextContent(node.getTextContent()).setMode(mode),
      );
      setUp(editor, [' DOG x DOG', '*_#ab ##ab']);
      expect(() =>
        editor.update(
          () => {
            const node = $paragraph().getChildAtIndex(1) as TextNode;
            const selection = $createRangeSelection();
            selection.anchor.set(node.getKey(), 5, 'text');
            selection.focus.set(node.getKey(), 7, 'text');
            $setSelection(selection);
            selection.insertText('x');
          },
          {discrete: true},
        ),
      ).not.toThrow();
      // `#x` is turned back into text twice, then kept, and takes the `b` its
      // match extends into (3: bold and italic).
      expect(read(editor)).toEqual([
        ['text', ' DOG x DOG', 0],
        ['text', '#ab ', 3],
        ['test-tag', '#xb', 3],
      ]);
    }
  });

  test('an update that fails does not count toward the next one', () => {
    const editor = createEditor({
      nodes: [TagNode],
      onError: e => {
        throw e;
      },
    });
    registerLexicalTextEntity(editor, tagMatch, TagNode, node =>
      $create(TagNode).setTextContent(node.getTextContent()).setMode('token'),
    );
    let failures = 2;
    editor.registerNodeTransform(TextNode, node => {
      if (failures > 0 && node.getTextContent() === '#foo x') {
        failures--;
        throw new Error('fail this update');
      }
    });
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('a').setFormat('bold'),
              $create(TagNode).setTextContent('#foo').setMode('token'),
              $createTextNode(' x'),
            ),
          );
      },
      {discrete: true, skipTransforms: true},
    );
    for (let i = 0; i < 3; i++) {
      try {
        editor.update(
          () => {
            $paragraph().getLastChildOrThrow().markDirty();
          },
          {discrete: true},
        );
      } catch {
        // The first two updates fail and are discarded.
      }
    }
    expect(failures).toBe(0);
    expect(read(editor)).toEqual([
      ['text', 'a', B],
      ['text', '#foo x', 0],
    ]);
  });

  test('two registrations, one making token or segmented entities, settle', () => {
    const upperMatch = (text: string): null | EntityMatch => {
      const m = /[A-Z]+/.exec(text);
      return m === null ? null : {end: m.index + m[0].length, start: m.index};
    };
    const caseKeywordMatch = (text: string) => keywordMatch(text.toLowerCase());
    for (const mode of ['token', 'segmented'] as const) {
      for (const tokenFirst of [true, false]) {
        const editor = createEditor({
          nodes: [KeywordNode, TagNode],
          onError: e => {
            throw e;
          },
        });
        const registerToken = () =>
          registerLexicalTextEntity(editor, upperMatch, TagNode, node =>
            $create(TagNode)
              .setTextContent(node.getTextContent())
              .setMode(mode),
          );
        if (tokenFirst) {
          registerToken();
        }
        registerLexicalTextEntity(editor, caseKeywordMatch, KeywordNode, node =>
          $create(KeywordNode).setTextContent(node.getTextContent()),
        );
        if (!tokenFirst) {
          registerToken();
        }
        setUp(editor, ['catDOGg']);
        expect(read(editor)).toEqual([
          ['text', 'cat', 0],
          ['test-tag', 'DOG', 0],
          ['text', 'g', 0],
        ]);
        setUp(editor, ['xa', '*d', 'DOG!dog']);
        const settled: [string, string, number][] = [
          ['text', 'd', B],
          ['test-tag', 'DOG', 0],
          ...((tokenFirst
            ? [['text', '!dog', 0]]
            : [
                ['text', '!', 0],
                ['test-keyword', 'dog', 0],
              ]) as [string, string, number][]),
        ];
        expect(read(editor)).toEqual([['text', 'xa', 0], ...settled]);
        editor.update(
          () => {
            $select($paragraph().getChildAtIndex(0) as TextNode, 2).insertText(
              'x',
            );
          },
          {discrete: true},
        );
        expect(read(editor)).toEqual([['text', 'xax', 0], ...settled]);
      }
    }
  });

  test('a createNode that adds text or changes its case settles as before', () => {
    const anywhere = (text: string): null | EntityMatch => {
      const m = /dog|cat/.exec(text);
      return m === null ? null : {end: m.index + m[0].length, start: m.index};
    };
    const settle = (runs: Run[], createText: (text: string) => string): Out => {
      const editor = createEditor({
        nodes: [KeywordNode],
        onError: e => {
          throw e;
        },
      });
      registerLexicalTextEntity(editor, anywhere, KeywordNode, node =>
        $create(KeywordNode).setTextContent(createText(node.getTextContent())),
      );
      setUp(editor, runs);
      return read(editor);
    };
    const I = 2; // IS_ITALIC
    expect(settle(['*z', 'x', '_dog', '*!'], text => text + ' ')).toEqual([
      ['text', 'z', B],
      ['text', 'x', 0],
      ['test-keyword', 'dog', I],
      ['text', ' ', I],
      ['text', '!', B],
    ]);
    // `dog` before "cat", or `DOG`: the entity `createNode` makes is a
    // match after the bold "x" even though the text it replaces is one only
    // with the "cat" after it.
    const before = (text: string): null | EntityMatch => {
      const m = /dog(?=cat)|DOG/.exec(text);
      return m === null ? null : {end: m.index + m[0].length, start: m.index};
    };
    const upper = createEditor({
      nodes: [KeywordNode],
      onError: e => {
        throw e;
      },
    });
    registerLexicalTextEntity(upper, before, KeywordNode, node =>
      $create(KeywordNode).setTextContent(node.getTextContent().toUpperCase()),
    );
    setUp(upper, ['*x', 'dogcat', '*y']);
    expect(read(upper)).toEqual([
      ['text', 'x', B],
      ['test-keyword', 'DOG', 0],
      ['text', 'cat', 0],
      ['text', 'y', B],
    ]);
    expect(
      settle(['*z', 'xdog', '_dog cat', '*!'], text => text.toUpperCase()),
    ).toEqual([
      ['text', 'z', B],
      ['text', 'xDOGDOG', 0],
      ['text', ' CAT', I],
      ['text', '!', B],
    ]);
  });

  test('typing in a long text node before an entity calls getMatch a few times, however long it is', () => {
    for (const repeat of [2000, 8000]) {
      let calls = 0;
      const editor = createEditor({
        nodes: [KeywordNode],
        onError: e => {
          throw e;
        },
      });
      registerLexicalTextEntity(
        editor,
        text => {
          calls++;
          return keywordMatch(text.toLowerCase());
        },
        KeywordNode,
        node => $create(KeywordNode).setTextContent(node.getTextContent()),
      );
      // "do" + "g" is a match that starts in the bold node, so the long node
      // is left as text, and the entity after it stays one.
      editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createRun('*do'),
              $createTextNode('g' + ' cat'.repeat(repeat) + ' '),
              $create(KeywordNode).setTextContent('dog'),
            ),
          );
        },
        {discrete: true},
      );
      calls = 0;
      editor.update(
        () => {
          ($paragraph().getChildAtIndex(1) as TextNode).spliceText(
            3,
            0,
            'x',
            false,
          );
        },
        {discrete: true},
      );
      expect(calls).toBeLessThanOrEqual(10);
      expect(read(editor)[2]).toEqual(['test-keyword', 'dog', 0]);
    }
  });

  test('a createNode that changes the text still makes an entity, as before', () => {
    const editor = createEditor({
      nodes: [KeywordNode],
      onError: e => {
        throw e;
      },
    });
    registerLexicalTextEntity(
      editor,
      text => lookbehindMatch(text, 'DOG') ?? lookbehindMatch(text, 'dog'),
      KeywordNode,
      node =>
        $create(KeywordNode).setTextContent(
          node.getTextContent().toLowerCase(),
        ),
    );
    setUp(editor, ['* ', 'DOGcat', '*y']);
    editor.update(
      () => {
        const node = $paragraph().getChildAtIndex(1) as TextNode;
        $select(node, 3).insertText(' ');
      },
      {discrete: true},
    );
    expect(read(editor)).toEqual([
      ['text', ' ', B],
      ['test-keyword', 'dog', 0],
      ['text', ' cat', 0],
      ['text', 'y', B],
    ]);
  });
});

/** Mulberry32, so a failure names a seed that reproduces it. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function $markAll(): void {
  for (const node of $paragraph().getChildren()) {
    node.markDirty();
  }
}

/** Runs `fn`, and returns the error it throws as a message, or null. */
function thrown(fn: () => void): null | string {
  try {
    fn();
    return null;
  } catch (e) {
    return String(e).slice(0, 80);
  }
}

const SEEDS = Number(process.env.TEXT_ENTITY_SETTLE_SEEDS ?? 2000);
const MATCHER_NAMES: Matcher[] = ['keyword', 'tag', 'lookbehind'];

describe('registerLexicalTextEntity on random layouts', () => {
  const PIECES: Record<Matcher, string[]> = {
    keyword: ['dog', 'cat', ' ', 'x', 'a', '#', '😀', '!', 'do', 'g'],
    lookbehind: ['dog', ' ', 'x', 'd', 'og', '😀', '!'],
    tag: ['#', '#a', '#ab', 'a', 'b', ' ', '😀', '!', 'x'],
  };
  const TYPED = [' ', '😀', 'a', 'x', '#', 'g', 'd', '!', '\u00a0'];
  const FORMATS = ['', '*', '_', '*_', '`'];

  function randomRuns(random: () => number, matcher: Matcher): Run[] {
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
    const runs: Run[] = [];
    let lastFormat: null | string = null;
    for (let i = 2 + Math.floor(random() * 3); i > 0; i--) {
      let format = pick(FORMATS);
      if (format === lastFormat) {
        format = format === '' ? '*' : '';
      }
      lastFormat = format;
      let text = '';
      for (let j = 1 + Math.floor(random() * 4); j > 0; j--) {
        text += pick(PIECES[matcher]);
      }
      runs.push(format + text);
    }
    return runs;
  }

  for (const matcher of MATCHER_NAMES) {
    // A fresh parse settles, and transforming every node again leaves it as
    // it is.
    test(`${matcher}: ${SEEDS} random layouts parse, and parse again the same`, () => {
      const failures: string[] = [];
      for (let seed = 0; seed < SEEDS && failures.length < 5; seed++) {
        const random = rng(seed * 7 + MATCHER_NAMES.indexOf(matcher));
        const runs = randomRuns(random, matcher);
        const editor = makeEditor(matcher);
        const label = `seed ${seed} ${JSON.stringify(runs)}`;
        const error = thrown(() => setUp(editor, runs));
        if (error !== null) {
          failures.push(`${label}: ${error}`);
          continue;
        }
        const parsed = read(editor);
        const again = thrown(() => editor.update($markAll, {discrete: true}));
        if (again !== null) {
          failures.push(`${label} again: ${again}`);
        } else if (JSON.stringify(read(editor)) !== JSON.stringify(parsed)) {
          failures.push(`${label} again: ${JSON.stringify(read(editor))}`);
        }
      }
      expect(failures).toEqual([]);
    });

    // #9637's shape: a node with random text between two nodes of other
    // formats whose text has no match of its own, and starts none with it
    // (a hashtag's `#` would). Typing or deleting anywhere in it settles on
    // the entities a fresh parse of the result finds.
    test(`${matcher}: ${SEEDS} random edits between two formatted nodes settle on a fresh parse`, () => {
      const NEIGHBOURS = ['x', 'y', ' ', '!', '😀', 'a', 'xa', ' !'].concat(
        matcher === 'tag' ? [] : ['#'],
      );
      const failures: string[] = [];
      for (let seed = 0; seed < SEEDS && failures.length < 5; seed++) {
        const random = rng(seed * 7 + 3 + MATCHER_NAMES.indexOf(matcher));
        const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
        const [middle] = randomRuns(random, matcher);
        const runs = [
          pick(FORMATS.slice(1)) + pick(NEIGHBOURS),
          parseRun(middle).text,
          pick(FORMATS.slice(1)) + pick(NEIGHBOURS),
        ];
        const editor = makeEditor(matcher);
        const label0 = `seed ${seed} ${JSON.stringify(runs)}`;
        const setUpError = thrown(() => setUp(editor, runs));
        if (setUpError !== null) {
          failures.push(`${label0}: ${setUpError}`);
          continue;
        }
        const nodes = read(editor);
        // An edit in one of the nodes the middle text became.
        const index = 1 + Math.floor(random() * (nodes.length - 2));
        const size = nodes[index][1].length;
        const typing = size === 0 || random() < 0.7;
        const offset = Math.floor(random() * (typing ? size + 1 : size));
        const typed = pick(TYPED);
        const label = `${label0} ${JSON.stringify(nodes)} ${
          typing ? `type ${JSON.stringify(typed)}` : 'delete'
        } at ${index}:${offset}`;
        const error = thrown(() =>
          editor.update(
            () => {
              const node = $paragraph().getChildAtIndex(index) as TextNode;
              if (typing) {
                $select(node, offset).insertText(typed);
              } else {
                node.spliceText(offset, 1, '', false);
              }
            },
            {discrete: true},
          ),
        );
        if (error !== null) {
          failures.push(`${label}: ${error}`);
          continue;
        }
        const out = read(editor);
        const fresh = freshParse(toRuns(out), matcher);
        if (JSON.stringify(out) !== JSON.stringify(fresh)) {
          failures.push(
            `${label}: ${JSON.stringify(out)} != ${JSON.stringify(fresh)}`,
          );
        }
      }
      expect(failures).toEqual([]);
    });

    // Any edit (typing or deleting anywhere, or bolding a node) settles, and
    // so does transforming every node again.
    test(`${matcher}: ${SEEDS} random sessions of 4 edits anywhere settle`, () => {
      const failures: string[] = [];
      for (let seed = 0; seed < SEEDS && failures.length < 5; seed++) {
        const random = rng(seed * 7 + 5 + MATCHER_NAMES.indexOf(matcher));
        const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
        const runs = randomRuns(random, matcher);
        const editor = makeEditor(matcher);
        if (thrown(() => setUp(editor, runs)) !== null) {
          continue;
        }
        for (let edit = 0; edit < 4; edit++) {
          const nodes = read(editor);
          if (nodes.length === 0) {
            break;
          }
          const index = Math.floor(random() * nodes.length);
          const size = nodes[index][1].length;
          const op = random();
          const offset = Math.floor(random() * (size + 1));
          const typed = pick(TYPED);
          const label = `seed ${seed} edit ${edit} ${JSON.stringify(nodes)} op ${op.toFixed(2)} at ${index}:${offset} ${JSON.stringify(typed)}`;
          const error = thrown(() =>
            editor.update(
              () => {
                const node = $paragraph().getChildAtIndex(index) as TextNode;
                if (op < 0.6) {
                  $select(node, offset).insertText(typed);
                } else if (op < 0.85) {
                  if (size > 0) {
                    node.spliceText(Math.min(offset, size - 1), 1, '', false);
                  }
                } else {
                  node.toggleFormat('bold');
                }
              },
              {discrete: true},
            ),
          );
          const again =
            error ?? thrown(() => editor.update($markAll, {discrete: true}));
          if (again !== null) {
            failures.push(`${label}: ${again}`);
            break;
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
