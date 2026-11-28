/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createHashtagNode,
  HashtagExtension,
  HashtagNode,
} from '@lexical/hashtag';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $addMarkID,
  $getNodeMarkIDs,
  MarkExtension,
  MarkStateExtension,
} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isRangeSelection,
  $setSelection,
  $setState,
  createEditor,
  createState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {type EntityMatch, registerLexicalTextEntity} from '../..';

/**
 * #9704: joining a block onto text that ends in another format (or a tab)
 * turns a hashtag at the start of the joined block into text (`word#tag`
 * holds no hashtag), and its characters keep their NodeState (comment ids
 * stored as NodeState included).
 */

// A NodeState on the hashtag, as a comment mark stored as NodeState is.
const note = createState('note', {
  parse: v => (typeof v === 'string' ? v : ''),
});

function createHashtagEditor(): LexicalEditor {
  const editor = createEditor({
    nodes: [HashtagNode, ListNode, ListItemNode],
    onError: e => {
      throw e;
    },
  });
  editor.setRootElement(document.createElement('div'));
  registerLexicalTextEntity(
    editor,
    HashtagExtension.config!.getHashtagMatch,
    HashtagNode,
    node => $createHashtagNode(node.getTextContent()),
  );
  return editor;
}

// [type, text, format, state] for every text node.
const read = (editor: LexicalEditor) =>
  editor.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => [
        n.getType(),
        n.getTextContent(),
        n.getFormat(),
        $getState(n, note),
      ]),
  );

// Backspace at the start of the last block: select from the end of the first
// block to the start of the last one and remove.
function $joinLastBlock(): void {
  const last = (
    $getRoot().getFirstChildOrThrow() as ElementNode
  ).getLastDescendant() as TextNode;
  const first = (
    $getRoot().getLastChildOrThrow() as ElementNode
  ).getFirstDescendant() as TextNode;
  const s = $createRangeSelection();
  s.anchor.set(last.getKey(), last.getTextContentSize(), 'text');
  s.focus.set(first.getKey(), 0, 'text');
  $setSelection(s);
  s.removeText();
  $setSelection(null);
}

const $list = (...children: LexicalNode[]) =>
  $createListNode('bullet').append($createListItemNode().append(...children));

describe('joining blocks before a hashtag keeps its NodeState (#9704)', () => {
  test('#9704: a list item that starts with a hashtag, joined onto italic text', () => {
    const editor = createHashtagEditor();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('one '),
            $createTextNode('word').setFormat('italic'),
          ),
          $list(
            $setState($createHashtagNode('#tag'), note, 'c1'),
            $createTextNode(' more'),
          ),
        );
      },
      {discrete: true},
    );
    editor.update($joinLastBlock, {discrete: true});
    // "word#tag" is no hashtag (a fresh parse finds none), so the hashtag
    // becomes text; its characters keep their NodeState.
    expect(read(editor)).toEqual([
      ['text', 'one ', 0, ''],
      ['text', 'word', 2, ''],
      ['text', '#tag', 0, 'c1'],
      ['text', ' more', 0, ''],
    ]);
  });

  test('the same with backspace from the start of the item (deleteCharacter)', () => {
    const editor = createHashtagEditor();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('one '),
            $createTextNode('word').setFormat('italic'),
          ),
          $createParagraphNode().append(
            $setState($createHashtagNode('#tag'), note, 'c1'),
            $createTextNode(' more'),
          ),
        );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const hashtag = (
          $getRoot().getLastChildOrThrow() as ElementNode
        ).getFirstDescendant() as TextNode;
        hashtag.select(0, 0).deleteCharacter(true);
        $setSelection(null);
      },
      {discrete: true},
    );
    expect(read(editor)).toEqual([
      ['text', 'one ', 0, ''],
      ['text', 'word', 2, ''],
      ['text', '#tag', 0, 'c1'],
      ['text', ' more', 0, ''],
    ]);
  });

  test('forward delete at the end of the text before it', () => {
    const editor = createHashtagEditor();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('one '),
            $createTextNode('word').setFormat('bold'),
          ),
          $createParagraphNode().append(
            $setState($createHashtagNode('#tag'), note, 'c1'),
          ),
        );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const word = (
          $getRoot().getFirstChildOrThrow() as ElementNode
        ).getLastDescendant() as TextNode;
        word.select(4, 4).deleteCharacter(false);
        $setSelection(null);
      },
      {discrete: true},
    );
    expect(read(editor)).toEqual([
      ['text', 'one ', 0, ''],
      ['text', 'word', 1, ''],
      ['text', '#tag', 0, 'c1'],
    ]);
  });

  test('the block before ends with a tab, the text and tab carry NodeState', () => {
    // From a long-session test: a block ending with a tab (both with comment
    // marks) joined with a list item starting with a commented hashtag.
    const editor = createHashtagEditor();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $setState($createTextNode('t5015z t5016z'), note, 'c1,c4'),
            $setState($createTabNode(), note, 'c1,c4'),
          ),
          $list(
            $setState($createHashtagNode('#t5017z'), note, 'c1,c4'),
            $setState($createTextNode(' t5018z'), note, 'c4'),
          ),
        );
      },
      {discrete: true},
    );
    editor.update($joinLastBlock, {discrete: true});
    const rows = read(editor);
    expect(editor.read(() => $getRoot().getTextContent())).toBe(
      't5015z t5016z\t#t5017z t5018z',
    );
    // Whatever the hashtag becomes, its characters keep their NodeState
    expect(rows.find(r => String(r[1]).includes('#t5017z'))?.[3]).toBe('c1,c4');
  });
});

describe('with MarkStateExtension comments (#9704)', () => {
  test('a commented hashtag joined onto text in another format keeps its comment ids', () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          ListExtension,
          HashtagExtension,
          MarkExtension,
          MarkStateExtension,
        ],
        name: 'test',
        onError: (e: Error) => {
          throw e;
        },
      }),
    );
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('one '),
              $createTextNode('word').setFormat('italic'),
            ),
            $list($createHashtagNode('#tag'), $createTextNode(' more')),
          );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const hashtag = (
          $getRoot().getLastChildOrThrow() as ElementNode
        ).getFirstDescendant() as TextNode;
        $addMarkID('c1', hashtag.select(0, 4));
        $addMarkID('c4', hashtag.select(0, 4));
        $setSelection(null);
      },
      {discrete: true},
    );
    editor.update($joinLastBlock, {discrete: true});
    const ids = editor.read(() =>
      $getRoot()
        .getAllTextNodes()
        .map(n => [n.getTextContent(), $getNodeMarkIDs(n).join(',')]),
    );
    expect(ids.find(([text]) => text.includes('#tag'))).toEqual([
      '#tag',
      'c1,c4',
    ]);
    editor.dispose();
  });
});

describe('an entity turned back into text does not take the text after it first', () => {
  test('two hashtags turned into text: the text after them keeps its format, NodeState and the selection', () => {
    const editor = createHashtagEditor();
    editor.update(
      () => {
        const suffix = $setState(
          $createTextNode('z!').setFormat('italic'),
          note,
          'suffix',
        );
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('x'),
            $createTextNode('a').setFormat('bold'),
            $createHashtagNode('#b').setFormat('bold'),
            $setState($createHashtagNode('#c'), note, 'entity'),
            suffix,
          ),
        );
        suffix.select(2, 2);
      },
      {discrete: true},
    );
    expect(read(editor)).toEqual([
      ['text', 'x', 0, ''],
      ['text', 'a#b', 1, ''],
      ['text', '#c', 0, 'entity'],
      ['text', 'z!', 2, 'suffix'],
    ]);
    editor.read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      const {anchor} = selection as RangeSelection;
      expect([anchor.getNode().getTextContent(), anchor.offset]).toEqual([
        'z!',
        2,
      ]);
    });
  });
});

describe('entities of two registrations that touch', () => {
  class MentionNode extends TextNode {
    $config() {
      return this.config('join-mention', {extends: TextNode});
    }
    isTextEntity(): true {
      return true;
    }
  }
  class SegmentedNode extends TextNode {
    $config() {
      return this.config('join-segmented', {extends: TextNode});
    }
    isTextEntity(): true {
      return true;
    }
  }
  const regexMatch =
    (regex: RegExp) =>
    (text: string): null | EntityMatch => {
      const m = regex.exec(text);
      return m === null ? null : {end: m.index + m[0].length, start: m.index};
    };
  test('typing before a hashtag that a token and a segmented entity follow settles', () => {
    let calls = 0;
    const counted =
      (getMatch: (text: string) => null | EntityMatch) => (text: string) => {
        calls++;
        return getMatch(text);
      };
    const editor = createEditor({
      nodes: [HashtagNode, MentionNode, SegmentedNode],
      onError: e => {
        throw e;
      },
    });
    registerLexicalTextEntity(
      editor,
      counted(HashtagExtension.config!.getHashtagMatch),
      HashtagNode,
      node => $createHashtagNode(node.getTextContent()),
    );
    registerLexicalTextEntity(
      editor,
      counted(regexMatch(/@[a-z]+/)),
      MentionNode,
      node =>
        $create(MentionNode)
          .setTextContent(node.getTextContent())
          .setMode('token'),
    );
    registerLexicalTextEntity(
      editor,
      counted(regexMatch(/\$[A-Z]+/)),
      SegmentedNode,
      node =>
        $create(SegmentedNode)
          .setTextContent(node.getTextContent())
          .setMode('segmented'),
    );
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('x'),
            $createTextNode(' #b').setFormat('bold'),
            $createTextNode('$B@x').setFormat('code'),
          ),
        );
      },
      {discrete: true},
    );
    calls = 0;
    editor.update(
      () => {
        const space = $getRoot().getAllTextNodes()[1];
        const selection = space.select(1, 1);
        selection.format = space.getFormat();
        selection.insertText('a');
      },
      {discrete: true},
    );
    expect(editor.read(() => $getRoot().getTextContent())).toBe('x a#b$B@x');
    // The transforms of the two that touch run a bounded number of times
    expect(calls).toBeLessThan(200);
  });
});

describe('a hashtag before differently formatted text', () => {
  test('typing before a bold word keeps its format and the caret position', () => {
    const editor = createHashtagEditor();
    editor.update(
      () => {
        const text = $createTextNode('foobar');
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('bold').setFormat('bold'),
            text,
            $createTextNode('bold').setFormat('bold'),
          ),
        );
        text.select(3, 3);
      },
      {discrete: true},
    );
    for (const character of ' #tag ') {
      editor.update(
        () => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            throw new Error('Expected a range selection');
          }
          selection.insertText(character);
        },
        {discrete: true},
      );
    }
    expect(read(editor)).toEqual([
      ['text', 'bold', 1, ''],
      ['text', 'foo ', 0, ''],
      ['hashtag', '#tag', 0, ''],
      ['text', ' bar', 0, ''],
      ['text', 'bold', 1, ''],
    ]);
    editor.read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) {
        expect(selection.isCollapsed()).toBe(true);
        expect(selection.anchor.getNode().getTextContent()).toBe(' bar');
        expect(selection.anchor.offset).toBe(1);
      }
    });
  });

  test.each([
    {
      end: 3,
      expected: [
        ['hashtag', '#fo', 1, ''],
        ['text', 'obar', 0, ''],
      ],
      start: 0,
    },
    {
      end: 7,
      expected: [
        ['hashtag', '#foo', 0, ''],
        ['text', 'bar', 1, ''],
      ],
      start: 4,
    },
  ])(
    'formatting a hashtag from $start to $end preserves the boundary',
    ({start, end, expected}) => {
      const editor = createHashtagEditor();
      editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createHashtagNode('#foobar')),
          );
        },
        {discrete: true},
      );
      editor.update(
        () => {
          $getRoot().getAllTextNodes()[0].select(start, end).formatText('bold');
        },
        {discrete: true},
      );
      expect(read(editor)).toEqual(expected);
    },
  );

  test('typing with bold enabled at the end stays outside the hashtag', () => {
    const editor = createHashtagEditor();
    editor.update(
      () => {
        const hashtag = $createHashtagNode('#foo');
        $getRoot().append($createParagraphNode().append(hashtag));
        hashtag.selectEnd().toggleFormat('bold');
      },
      {discrete: true},
    );
    for (const character of 'xy') {
      editor.update(
        () => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            throw new Error('Expected a range selection');
          }
          selection.insertText(character);
        },
        {discrete: true},
      );
    }
    expect(read(editor)).toEqual([
      ['hashtag', '#foo', 0, ''],
      ['text', 'xy', 1, ''],
    ]);
    editor.read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) {
        expect(selection.isCollapsed()).toBe(true);
        expect(selection.anchor.getNode().getTextContent()).toBe('xy');
        expect(selection.anchor.offset).toBe(2);
      }
    });
  });
});

describe('an entity that may not be kept does not grow', () => {
  class PhraseNode extends TextNode {
    $config() {
      return this.config('join-phrase', {extends: TextNode});
    }
    isTextEntity(): true {
      return true;
    }
  }
  const phraseMatch = (text: string): null | EntityMatch =>
    /^a .*cat$/.test(text) ? {end: text.length, start: 0} : null;
  test.each([7, 8])(
    'after text with %i earlier matches, a later match in the text after it is still made',
    repeat => {
      const editor = createEditor({
        nodes: [HashtagNode],
        onError: e => {
          throw e;
        },
      });
      registerLexicalTextEntity(
        editor,
        HashtagExtension.config!.getHashtagMatch,
        HashtagNode,
        node => $createHashtagNode(node.getTextContent()),
      );
      editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('#').setFormat('bold'),
              $createTextNode('a '),
              $createTextNode('#b').setFormat('italic'),
            ),
          );
        },
        {discrete: true},
      );
      editor.update(
        () => {
          $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent() === 'a ')!
            .spliceText(2, 0, '#x '.repeat(repeat));
        },
        {discrete: true},
      );
      editor.update(
        () => {
          $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent() === '#b')!
            .selectEnd()
            .insertNodes([$createTextNode('c rest #d').setFormat('bold')]);
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe(
          '#a ' + '#x '.repeat(repeat) + '#bc rest #d',
        );
        const hashtags = $getRoot()
          .getAllTextNodes()
          .filter(n => n.getType() === 'hashtag')
          .map(n => n.getTextContent());
        expect(hashtags).toContain('#d');
      });
    },
  );

  test.each([7, 8])(
    'after text with %i earlier matches, the text after it keeps its format and NodeState',
    repeat => {
      const editor = createEditor({
        nodes: [HashtagNode, PhraseNode],
        onError: e => {
          throw e;
        },
      });
      registerLexicalTextEntity(
        editor,
        HashtagExtension.config!.getHashtagMatch,
        HashtagNode,
        node => $createHashtagNode(node.getTextContent()),
      );
      registerLexicalTextEntity(editor, phraseMatch, PhraseNode, node =>
        $create(PhraseNode).setTextContent(node.getTextContent()),
      );
      const phraseText = 'a ' + '#x '.repeat(repeat) + 'cat';
      editor.update(
        () => {
          // Made in document order: the transforms run in that order
          const first = $createTextNode('y');
          const bold = $createTextNode('x').setFormat('bold');
          const phrase = $create(PhraseNode)
            .setTextContent(phraseText)
            .setFormat('bold');
          const hashtag = $setState($createHashtagNode('#c'), note, 'entity');
          const suffix = $setState(
            $createTextNode('z!').setFormat('italic'),
            note,
            'suffix',
          );
          $getRoot().append(
            $createParagraphNode().append(first, bold, phrase, hashtag, suffix),
          );
          // Comment ids too, as MarkStateExtension keeps them
          $addMarkID('entity', hashtag.select(0, 2));
          $addMarkID('suffix', suffix.select(0, 2));
          suffix.select(2, 2);
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('yx' + phraseText + '#cz!');
        const suffix = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent().includes('z'))!;
        expect([
          suffix.getTextContent(),
          suffix.getFormat(),
          $getState(suffix, note),
          $getNodeMarkIDs(suffix),
        ]).toEqual(['z!', 2, 'suffix', ['suffix']]);
        const selection = $getSelection() as RangeSelection;
        expect([
          selection.anchor.getNode().is(suffix),
          selection.anchor.offset,
        ]).toEqual([true, 2]);
      });
    },
  );
});
