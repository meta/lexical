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
import {HistoryExtension} from '@lexical/history';
import {$createMarkNode, $isMarkNode, MarkNode} from '@lexical/mark';
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  $setState,
  createEditor,
  createState,
  type ElementNode,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
  REDO_COMMAND,
  type SerializedTextNode,
  TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {type EntityMatch, registerLexicalTextEntity} from '../..';

// Ad-hoc NodeState, as an app keeps comment ids or block ids on text.
const note = createState('note', {
  parse: v => (typeof v === 'string' ? v : ''),
});
// Reference-typed state: the carried value is the same object.
const ids = createState('ids', {
  isEqual: (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]),
  parse: (v): readonly string[] =>
    Array.isArray(v) ? v.filter(x => typeof x === 'string') : [],
});

// A keyword-style entity (normal mode) and a token entity (mention-like).
class KeywordNode extends TextNode {
  $config() {
    return this.config('test-keyword', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
}
function $createKeywordNode(text: string): KeywordNode {
  return $applyNodeReplacement(new KeywordNode(text));
}
const getKeywordMatch = (text: string): null | EntityMatch => {
  const m = /(^|[^A-Za-z])(cat)(?![A-Za-z])/.exec(text);
  return m === null
    ? null
    : {end: m.index + m[1].length + 3, start: m.index + m[1].length};
};

class MentionNode extends TextNode {
  $config() {
    return this.config('test-mention', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
}
function $createMentionNode(text: string): MentionNode {
  return $applyNodeReplacement(new MentionNode(text)).setMode('token');
}
const getMentionMatch = (text: string): null | EntityMatch => {
  const m = /@[a-z]+/.exec(text);
  return m === null ? null : {end: m.index + m[0].length, start: m.index};
};

// An entity whose own $config declares a state (nested and flat).
const entityOwn = createState('entityOwn', {
  parse: v => (typeof v === 'string' ? v : ''),
});
const entityFlat = createState('entityFlat', {
  parse: v => (typeof v === 'string' ? v : ''),
});
class StatefulEntityNode extends TextNode {
  $config() {
    return this.config('test-stateful-entity', {
      extends: TextNode,
      stateConfigs: [{flat: true, stateConfig: entityFlat}, entityOwn],
    });
  }
  isTextEntity(): true {
    return true;
  }
}
const getHashMatch = (text: string): null | EntityMatch => {
  const m = /#\w+/.exec(text);
  return m === null ? null : {end: m.index + m[0].length, start: m.index};
};

const getHashtagMatch = HashtagExtension.config!.getHashtagMatch;

function createHashtagEditor(
  nodes: readonly (typeof TextNode | typeof MarkNode)[] = [],
): LexicalEditor {
  const editor = createEditor({
    nodes: [HashtagNode, ...nodes],
    onError: e => {
      throw e;
    },
  });
  editor.setRootElement(document.createElement('div'));
  registerLexicalTextEntity(editor, getHashtagMatch, HashtagNode, node =>
    $createHashtagNode(node.getTextContent()),
  );
  return editor;
}

type Row = [string, string, string];
// [type, text, note] of every text node
const read = (editor: LexicalEditor): Row[] =>
  editor.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map((n): Row => [n.getType(), n.getTextContent(), $getState(n, note)]),
  );

const update = (editor: LexicalEditor, fn: () => void) =>
  editor.update(
    () => {
      fn();
      $setSelection(null);
    },
    {discrete: true},
  );

const $paragraph = (...children: LexicalNode[]) =>
  $createParagraphNode().append(...children);
const $text = (i: number): TextNode => $getRoot().getAllTextNodes()[i];

describe('registerLexicalTextEntity keeps NodeState', () => {
  test('#9703: a hashtag that stops matching keeps its NodeState when it becomes text (typing before it)', () => {
    const editor = createHashtagEditor();
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('one '),
          $setState($createHashtagNode('#tag'), note, 'c1'),
          $createTextNode(' more'),
        ),
      );
    });
    update(editor, () => {
      $text(1).select(0, 0).insertText('x');
    });
    expect(read(editor)).toEqual([
      ['text', 'one x', ''],
      ['text', '#tag', 'c1'],
      ['text', ' more', ''],
    ]);
  });

  test('deleting the # of a hashtag keeps its NodeState (reverse transform, no match)', () => {
    const editor = createHashtagEditor();
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('one '),
          $setState($createHashtagNode('#tag'), note, 'c1'),
        ),
      );
    });
    update(editor, () => {
      $text(1).select(0, 1).removeText();
    });
    expect(read(editor)).toEqual([
      ['text', 'one ', ''],
      ['text', 'tag', 'c1'],
    ]);
  });

  test('a hashtag that becomes text merges into neighbors with the same NodeState', () => {
    const editor = createHashtagEditor();
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $setState($createTextNode('one '), note, 'c1'),
          $setState($createHashtagNode('#tag'), note, 'c1'),
          $setState($createTextNode(' more'), note, 'c1'),
        ),
      );
    });
    update(editor, () => {
      $text(1).select(0, 0).insertText('x');
    });
    expect(read(editor)).toEqual([['text', 'one x#tag more', 'c1']]);
  });

  test('a hashtag with no NodeState becomes text and merges as before', () => {
    const editor = createHashtagEditor();
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('one '),
          $createHashtagNode('#tag'),
          $createTextNode(' more'),
        ),
      );
    });
    update(editor, () => {
      $text(1).select(0, 0).insertText('x');
    });
    expect(read(editor)).toEqual([['text', 'one x#tag more', '']]);
    // No NodeState was created on the merged text
    editor.getEditorState().read(() => {
      expect($text(0).exportJSON().$).toBe(undefined);
    });
  });

  test('plain text with NodeState that becomes a hashtag keeps it', () => {
    const editor = createHashtagEditor();
    update(editor, () => {
      $getRoot().append(
        $paragraph($setState($createTextNode('a #'), note, 'c1')),
      );
    });
    update(editor, () => {
      // The "#" was there: the hashtag is not only inserted text
      $text(0).select(3, 3).insertText('tag');
    });
    expect(read(editor)).toEqual([
      ['text', 'a ', 'c1'],
      ['hashtag', '#tag', 'c1'],
    ]);
  });

  test('a hashtag made only of text inserted into a node does not take its NodeState', () => {
    // The inserted characters land in the node and get a copy of its
    // NodeState, which is not theirs (as on main; MarkStateExtension does not
    // add text inserted at a comment's edge to the comment either)
    for (const [at, inserted, expected] of [
      [
        1,
        ' #tag',
        [
          ['text', 'a ', 'c1'],
          ['hashtag', '#tag', ''],
        ],
      ],
      [
        0,
        '#tag ',
        [
          ['hashtag', '#tag', ''],
          ['text', ' a', 'c1'],
        ],
      ],
    ] as const) {
      const editor = createHashtagEditor();
      update(editor, () => {
        $getRoot().append(
          $paragraph($setState($createTextNode('a'), note, 'c1')),
        );
      });
      update(editor, () => {
        $text(0).select(at, at).insertText(inserted);
      });
      expect(read(editor)).toEqual(expected);
    }
  });

  test('state that createNode gives the entity wins over the text it replaces', () => {
    const editor = createEditor({
      nodes: [HashtagNode],
      onError: e => {
        throw e;
      },
    });
    editor.setRootElement(document.createElement('div'));
    registerLexicalTextEntity(editor, getHashtagMatch, HashtagNode, node =>
      $setState($createHashtagNode(node.getTextContent()), note, 'entity'),
    );
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $setState($setState($createTextNode('a #tag'), note, 'text'), ids, [
            'c1',
          ]),
        ),
      );
    });
    editor.getEditorState().read(() => {
      const [text, hashtag] = $getRoot().getAllTextNodes();
      expect($getState(text, note)).toBe('text');
      expect(hashtag.getType()).toBe('hashtag');
      expect($getState(hashtag, note)).toBe('entity');
      expect($getState(hashtag, ids)).toEqual(['c1']);
    });
  });

  test('text inserted after a hashtag that becomes a hashtag does not take the NodeState copied from it', () => {
    // The hashtag's transform splits the inserted text off with a copy of
    // its NodeState (as before); a hashtag made from that text does not
    // take that copy, which is not the inserted text's own.
    const editor = createHashtagEditor();
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('see '),
          $setState($createHashtagNode('#foo'), note, 'c1'),
        ),
      );
    });
    update(editor, () => {
      $text(1).select(4, 4).insertText(', x #bar y');
    });
    const rows = read(editor);
    expect(rows[1]).toEqual(['hashtag', '#foo', 'c1']);
    expect(rows.find(r => r[1] === '#bar')).toEqual(['hashtag', '#bar', '']);
  });

  test('a reference-typed state value is carried as the same object', () => {
    const editor = createHashtagEditor();
    const value = Object.freeze(['c1', 'c2']);
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('one '),
          $setState($createHashtagNode('#tag'), ids, value),
        ),
      );
    });
    update(editor, () => {
      $text(1).select(0, 1).removeText();
    });
    editor.getEditorState().read(() => {
      const node = $text(1);
      expect(node.getType()).toBe('text');
      expect($getState(node, ids)).toBe(value);
    });
  });

  test('NodeState read from JSON (not parsed yet) is carried and exported', () => {
    const editor = createHashtagEditor();
    editor.setEditorState(
      editor.parseEditorState({
        root: {
          children: [
            {
              children: [
                {
                  detail: 0,
                  format: 0,
                  mode: 'normal',
                  style: '',
                  text: 'one ',
                  type: 'text',
                  version: 1,
                },
                {
                  $: {comment: ['c1'], note: 'n1'},
                  detail: 0,
                  format: 0,
                  mode: 'normal',
                  style: '',
                  text: '#tag',
                  type: 'hashtag',
                  version: 1,
                },
              ],
              direction: null,
              format: '',
              indent: 0,
              textFormat: 0,
              textStyle: '',
              type: 'paragraph',
              version: 1,
            },
          ],
          direction: null,
          format: '',
          indent: 0,
          type: 'root',
          version: 1,
        },
      } as never),
    );
    update(editor, () => {
      $text(1).select(0, 0).insertText('x');
    });
    editor.getEditorState().read(() => {
      const json = $text(1).exportJSON() as SerializedTextNode & {
        $?: Record<string, unknown>;
      };
      expect(json.type).toBe('text');
      expect(json.text).toBe('#tag');
      expect(json.$).toEqual({comment: ['c1'], note: 'n1'});
      expect($getState($text(1), note)).toBe('n1');
    });
  });

  test('NodeState declared in the entity $config (nested and flat) is carried to the text', () => {
    const editor = createEditor({
      nodes: [StatefulEntityNode],
      onError: e => {
        throw e;
      },
    });
    editor.setRootElement(document.createElement('div'));
    registerLexicalTextEntity(editor, getHashMatch, StatefulEntityNode, node =>
      $applyNodeReplacement(new StatefulEntityNode(node.getTextContent())),
    );
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('one '),
          $setState(
            $setState(
              $setState(new StatefulEntityNode('#tag'), entityOwn, 'own'),
              entityFlat,
              'flat',
            ),
            note,
            'c1',
          ),
        ),
      );
    });
    update(editor, () => {
      $text(1).select(0, 1).removeText();
    });
    editor.getEditorState().read(() => {
      const node = $text(1);
      expect(node.getType()).toBe('text');
      expect($getState(node, note)).toBe('c1');
      expect($getState(node, entityOwn)).toBe('own');
      expect($getState(node, entityFlat)).toBe('flat');
      // TextNode does not declare `entityFlat` flat: it serializes nested
      expect(node.exportJSON()).toMatchObject({
        $: {entityFlat: 'flat', entityOwn: 'own', note: 'c1'},
      });
    });
    // Exported and imported again, the text keeps it
    const json = editor.getEditorState().toJSON();
    editor.setEditorState(editor.parseEditorState(json));
    editor.getEditorState().read(() => {
      const node = $text(1);
      expect($getState(node, entityOwn)).toBe('own');
      expect($getState(node, entityFlat)).toBe('flat');
    });
  });

  test('a key the plain text type declares with another config is parsed with that config', () => {
    // The entity and the text use different StateConfigs for the key "tag"
    const entityTag = createState('tag', {
      parse: v => (typeof v === 'string' ? v : ''),
    });
    const textTag = createState('tag', {
      parse: v => (typeof v === 'string' ? `text:${v}` : ''),
      unparse: (v: string) => v.replace(/^text:/, ''),
    });
    class TagEntityNode extends TextNode {
      $config() {
        return this.config('test-tag-entity', {
          extends: TextNode,
          stateConfigs: [entityTag],
        });
      }
      isTextEntity(): true {
        return true;
      }
    }
    class TagTextNode extends TextNode {
      $config() {
        return this.config('test-tag-text', {
          $transform: undefined,
          extends: TextNode,
          stateConfigs: [textTag],
        });
      }
    }
    const editor = createEditor({
      nodes: [
        TagEntityNode,
        TagTextNode,
        {
          replace: TextNode,
          with: (node: TextNode) => new TagTextNode(node.__text),
          withKlass: TagTextNode,
        },
      ],
      onError: e => {
        throw e;
      },
    });
    editor.setRootElement(document.createElement('div'));
    registerLexicalTextEntity(editor, getHashMatch, TagEntityNode, node =>
      $applyNodeReplacement(new TagEntityNode(node.getTextContent())),
    );
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('one '),
          $setState(new TagEntityNode('#tag'), entityTag, 'v'),
        ),
      );
    });
    update(editor, () => {
      $getRoot().getAllTextNodes()[1].select(0, 1).removeText();
    });
    editor.getEditorState().read(() => {
      const node = $getRoot().getAllTextNodes()[1];
      expect(node.getType()).toBe('test-tag-text');
      expect($getState(node, textTag)).toBe('text:v');
    });
  });

  test('a hashtag inside a MarkNode stays inside it when it becomes text', () => {
    const editor = createHashtagEditor([MarkNode]);
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('one '),
          $createMarkNode(['c1']).append(
            $setState($createHashtagNode('#tag'), note, 'n1'),
          ),
          $createTextNode(' more'),
        ),
      );
    });
    update(editor, () => {
      const hashtag = $getRoot().getAllTextNodes()[1];
      hashtag.select(0, 1).removeText();
    });
    editor.getEditorState().read(() => {
      const node = $getRoot().getAllTextNodes()[1];
      expect(node.getType()).toBe('text');
      expect(node.getTextContent()).toBe('tag');
      expect($getState(node, note)).toBe('n1');
      const mark = node.getParent();
      expect($isMarkNode(mark) && mark.getIDs()).toEqual(['c1']);
    });
  });

  test('undo and redo of a demotion restore the entity and the text with their NodeState', () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [HashtagExtension, HistoryExtension],
        name: 'test',
        onError: (e: Error) => {
          throw e;
        },
      }),
    );
    editor.setRootElement(document.createElement('div'));
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $paragraph(
              $createTextNode('one '),
              $setState($createHashtagNode('#tag'), note, 'c1'),
            ),
          );
        $text(0).select(0, 0);
      },
      {discrete: true, tag: HISTORY_PUSH_TAG},
    );
    const before = read(editor);
    editor.update(
      () => {
        $text(1).select(0, 0).insertText('x');
      },
      {discrete: true, tag: HISTORY_PUSH_TAG},
    );
    const after = read(editor);
    expect(after).toEqual([
      ['text', 'one x', ''],
      ['text', '#tag', 'c1'],
    ]);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(read(editor)).toEqual(before);
    editor.dispatchCommand(REDO_COMMAND, undefined);
    expect(read(editor)).toEqual(after);
    editor.dispose();
  });
});

describe('every path that turns an entity into text keeps NodeState', () => {
  test('the text transform: the entity before it stops matching with its text (prevMatch null)', () => {
    // A keyword followed by a letter in another node: "cat" + "s" is no
    // keyword, so the text transform of "s" turns the keyword into text.
    const editor = createEditor({
      nodes: [KeywordNode],
      onError: e => {
        throw e;
      },
    });
    editor.setRootElement(document.createElement('div'));
    registerLexicalTextEntity(editor, getKeywordMatch, KeywordNode, node =>
      $createKeywordNode(node.getTextContent()),
    );
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('a '),
          $setState($createKeywordNode('cat'), note, 'k1'),
          $createTextNode(' b'),
        ),
      );
    });
    update(editor, () => {
      $text(2).select(0, 0).insertText('s');
    });
    expect(read(editor)).toEqual([
      ['text', 'a ', ''],
      ['text', 'cat', 'k1'],
      ['text', 's b', ''],
    ]);
  });

  describe('the text transform: a token entity (mention-like) that text follows', () => {
    const createMentionEditor = () => {
      const editor = createEditor({
        nodes: [MentionNode],
        onError: e => {
          throw e;
        },
      });
      editor.setRootElement(document.createElement('div'));
      registerLexicalTextEntity(editor, getMentionMatch, MentionNode, node =>
        $createMentionNode(node.getTextContent()),
      );
      return editor;
    };
    test('with the same NodeState as the text: it keeps it and takes the text', () => {
      const editor = createMentionEditor();
      update(editor, () => {
        $getRoot().append(
          $paragraph(
            $createTextNode('hi '),
            $setState($createMentionNode('@bob'), note, 'm1'),
            $setState($createTextNode('x'), note, 'm1'),
          ),
        );
      });
      // Before this change, this looped forever: the entity became text
      // without its NodeState, which did not merge with "x".
      expect(read(editor)).toEqual([
        ['text', 'hi ', ''],
        ['test-mention', '@bobx', 'm1'],
      ]);
    });
    test('with other NodeState than the text: kept with its NodeState, the text stays apart', () => {
      const editor = createMentionEditor();
      update(editor, () => {
        $getRoot().append(
          $paragraph(
            $createTextNode('hi '),
            $setState($createMentionNode('@bob'), note, 'm1'),
            $createTextNode('x'),
          ),
        );
      });
      // It becomes text with its NodeState, which does not merge with "x",
      // and is made again; the third time it is kept, and "x" (which has
      // none) stays text rather than take "m1". Before, it became text
      // without its NodeState, merged and was made again without it.
      expect(read(editor)).toEqual([
        ['text', 'hi ', ''],
        ['test-mention', '@bob', 'm1'],
        ['text', 'x', ''],
      ]);
    });
    test('typed text after it: the selection stays after the typed text', () => {
      const editor = createMentionEditor();
      update(editor, () => {
        $getRoot().append(
          $paragraph(
            $createTextNode('hi '),
            $setState($createMentionNode('@bob'), note, 'm1'),
            $createTextNode('!'),
          ),
        );
      });
      editor.update(
        () => {
          // Paste "x yz" right after the mention
          $text(1).select(4, 4).insertText('x yz');
        },
        {discrete: true},
      );
      expect(read(editor)).toEqual([
        ['text', 'hi ', ''],
        ['test-mention', '@bob', 'm1'],
        ['text', 'x yz!', ''],
      ]);
      editor.read(() => {
        const selection = $getSelection();
        expect($isRangeSelection(selection)).toBe(true);
        const {anchor, focus} = selection as RangeSelection;
        expect([anchor.getNode().getTextContent(), anchor.offset]).toEqual([
          'x yz!',
          4,
        ]);
        expect(focus.is(anchor)).toBe(true);
      });
    });
    test('with other NodeState than text that its match extends into, which keeps it apart: kept, each keeps its own', () => {
      // Text with NodeState of its own never merges with it (before this
      // change, this looped forever). The third time it is kept, and the
      // text stays apart with its own NodeState.
      const editor = createMentionEditor();
      update(editor, () => {
        $getRoot().append(
          $paragraph(
            $createTextNode('hi '),
            $setState($createMentionNode('@bob'), note, 'm1'),
            $setState($createTextNode('x'), note, 'x1'),
          ),
        );
      });
      expect(read(editor)).toEqual([
        ['text', 'hi ', ''],
        ['test-mention', '@bob', 'm1'],
        ['text', 'x', 'x1'],
      ]);
    });

    test('with a value object distinct from the text after it, equal as JSON: each keeps its own', () => {
      // Two value objects are two values unless their `isEqual` says
      // otherwise, as when text nodes merge: the token does not take "x".
      const tag = createState('tag', {
        parse: v =>
          typeof v === 'object' && v !== null ? (v as {id: string}) : {id: ''},
      });
      const a = {id: 'c1'};
      const b = {id: 'c1'};
      const editor = createMentionEditor();
      update(editor, () => {
        $getRoot().append(
          $paragraph(
            $createTextNode('hi '),
            $setState($createMentionNode('@bob'), tag, a),
            $setState($createTextNode('x'), tag, b),
          ),
        );
      });
      editor.read(() => {
        const nodes = $getRoot().getAllTextNodes();
        expect(nodes.map(n => [n.getType(), n.getTextContent()])).toEqual([
          ['text', 'hi '],
          ['test-mention', '@bob'],
          ['text', 'x'],
        ]);
        expect($getState(nodes[1], tag)).toBe(a);
        expect($getState(nodes[2], tag)).toBe(b);
      });
    });
  });

  test('the text transform: the entity after it stops matching (nextMatch null)', () => {
    // "x" + "#tag": "x#tag" holds no hashtag, so the text transform of "x"
    // turns the hashtag after it into text.
    const editor = createHashtagEditor();
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('x').setFormat('bold'),
          $setState($createHashtagNode('#tag'), note, 'c1'),
        ),
      );
    });
    update(editor, () => {
      // Mark both dirty
      $text(0).markDirty();
      $text(1).markDirty();
    });
    const rows = read(editor);
    // On main's rules the hashtag either stays or becomes text; either way
    // its characters keep their NodeState.
    expect(rows.find(r => r[1] === '#tag')?.[2]).toBe('c1');
  });

  test('the reverse transform: adjacent entities both become text', () => {
    const editor = createHashtagEditor();
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $setState($createHashtagNode('#a'), note, 'c1'),
          $setState($createHashtagNode('#b'), note, 'c2'),
        ),
      );
    });
    // Both become text, then the first is a hashtag again: each keeps its
    // NodeState (before, both lost it)
    expect(read(editor)).toEqual([
      ['hashtag', '#a', 'c1'],
      ['text', '#b', 'c2'],
    ]);
  });

  test('the reverse transform: an entity followed by an entity', () => {
    const editor = createHashtagEditor();
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('one '),
          $setState($createHashtagNode('#a'), note, 'c1'),
        ),
      );
    });
    update(editor, () => {
      $text(1).insertAfter($setState($createHashtagNode('#b'), note, 'c2'));
    });
    const rows = read(editor);
    expect(rows.find(r => r[1] === '#a')?.[2]).toBe('c1');
    expect(rows.find(r => r[1] === '#b')?.[2]).toBe('c2');
  });

  test('joining two blocks across text of another format keeps the NodeState of every node', () => {
    const editor = createHashtagEditor();
    update(editor, () => {
      $getRoot().append(
        $paragraph(
          $createTextNode('one '),
          $setState($createTextNode('word').setFormat('italic'), note, 'w'),
        ),
        $paragraph(
          $setState($createHashtagNode('#tag'), note, 'c1'),
          $createTextNode(' more'),
        ),
      );
    });
    update(editor, () => {
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
    });
    const rows = read(editor);
    expect(rows.find(r => r[1] === 'word')?.[2]).toBe('w');
    expect(rows.find(r => r[1] === '#tag')?.[2]).toBe('c1');
    editor.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe('one word#tag more');
      expect($getRoot().getAllTextNodes().every($isTextNode)).toBe(true);
    });
  });
});
