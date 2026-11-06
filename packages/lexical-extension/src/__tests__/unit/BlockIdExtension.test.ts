/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $generateJSONFromSelectedNodes,
  $generateNodesFromSerializedNodes,
  $insertGeneratedNodes,
} from '@lexical/clipboard';
import {$createCodeNode, CodeExtension} from '@lexical/code-core';
import {
  $createHorizontalRuleNode,
  $defaultIsIdentifiedBlock,
  $getBlockById,
  $getBlockId,
  $isRootChildBlock,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  generateBlockId,
  getExtensionDependencyFromEditor,
  HorizontalRuleExtension,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  INSERT_UNORDERED_LIST_COMMAND,
  ListExtension,
} from '@lexical/list';
import {
  $convertFromMarkdownString,
  HEADING,
  ORDERED_LIST,
  QUOTE,
  UNORDERED_LIST,
} from '@lexical/markdown';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableNodeWithDimensions,
  $createTableRowNode,
  $isTableCellNode,
  TableExtension,
} from '@lexical/table';
import {
  $copyNode,
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $parseSerializedNode,
  $setState,
  COLLABORATION_TAG,
  configExtension,
  DecoratorNode,
  DELETE_CHARACTER_COMMAND,
  ElementNode,
  HISTORY_MERGE_TAG,
  HISTORY_PUSH_TAG,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  PASTE_TAG,
  REDO_COMMAND,
  type SerializedEditorState,
  type SerializedElementNode,
  type SerializedLexicalNode,
  UNDO_COMMAND,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test, vi} from 'vitest';

import {
  $documentKey,
  deriveDuplicateId,
  derivePositionalId,
} from '../../internal/positionalBlockId';

/** The id of the k-th later holder of the repeated id `id`. */
function D(id: string, k: number): string {
  return deriveDuplicateId(id, String(k));
}

function counter(prefix = 'b') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

interface BuildOptions {
  generateId?: () => string;
  $isIdentifiedBlock?: (node: LexicalNode) => boolean;
  disabled?: boolean;
  /** Skip {@link asEdited}: the first content the editor gets is a load. */
  fresh?: boolean;
  history?: boolean;
}

/**
 * The first content an empty editor gets is a load, so its blocks get
 * positional ids (tested on their own). These tests are about edits, so their
 * editors have had content once and the first blocks they add get ids from
 * `generateId`.
 */
function asEdited<T extends LexicalEditor>(editor: T): T {
  const options = {discrete: true, tag: HISTORY_MERGE_TAG} as const;
  editor.update(() => {
    $getRoot().append($createParagraphNode());
  }, options);
  editor.update(() => {
    $getRoot().clear();
  }, options);
  return editor;
}

function build(options: BuildOptions = {}): LexicalEditorWithDispose {
  let clock = 0;
  const editor = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      ListExtension,
      TableExtension,
      HorizontalRuleExtension,
      ...(options.history
        ? [
            configExtension(HistoryExtension, {
              // History is disabled by default where there is no window.
              disabled: false,
              now: () => (clock += 10000),
            }),
          ]
        : []),
      configExtension(BlockIdExtension, {
        generateId: options.generateId || counter(),
        ...(options.$isIdentifiedBlock
          ? {$isIdentifiedBlock: options.$isIdentifiedBlock}
          : {}),
        disabled: options.disabled || false,
      }),
    ],
    name: '[block-id-test]',
  });
  return options.fresh ? editor : asEdited(editor);
}

function update(
  editor: LexicalEditor,
  fn: () => void,
  tag?: string | string[],
): void {
  editor.update(fn, {discrete: true, tag});
}

/**
 * The positional id of `place` (e.g. `'0'`, `'2.1'`, `'3#1'` for a retry) in
 * the editor's current content.
 */
function P(editor: LexicalEditor, place: string): string {
  return derivePositionalId(editor.read($documentKey), place);
}

/**
 * Shows the positional ids of places in the editor's current content as
 * `@place` (`@2`, `@0.1`, `@3#1`). Naming blocks does not change the content
 * they are hashed from, so ids given by a load or a repair show this way
 * until the content changes.
 */
function aliases(editor: LexicalEditor): Map<string, string> {
  const documentKey = editor.read($documentKey);
  const map = new Map<string, string>();
  for (let i = 0; i < 32; i++) {
    for (const place of [
      String(i),
      ...Array.from({length: 8}, (_, j) => `${i}.${j}`),
    ]) {
      map.set(derivePositionalId(documentKey, place), `@${place}`);
      map.set(derivePositionalId(documentKey, `${place}#1`), `@${place}#1`);
    }
  }
  return map;
}

/** `type:text:id` for each child of the root (positional ids aliased). */
function blocks(editor: LexicalEditor): string[] {
  const shown = aliases(editor);
  const alias = (id: string | null) =>
    id === null ? null : (shown.get(id) ?? id);
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(
        node =>
          `${node.getType()}:${node.getTextContent()}:${alias($getBlockId(node))}`,
      ),
  );
}

/** The ids of the children of the root (positional ids aliased). */
function ids(editor: LexicalEditor): (string | null)[] {
  const shown = aliases(editor);
  const alias = (id: string | null) =>
    id === null ? null : (shown.get(id) ?? id);
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(node => alias($getBlockId(node))),
  );
}

function $paragraph(text: string): ElementNode {
  return $createParagraphNode().append($createTextNode(text));
}

/** A deep copy that keeps NodeState, as a Lexical-JSON paste does. */
function $deepCopy<T extends LexicalNode>(node: T): T {
  const serialize = (n: LexicalNode): SerializedLexicalNode => {
    const json = n.exportJSON();
    if ($isElementNode(n)) {
      (json as SerializedElementNode).children = n.getChildren().map(serialize);
    }
    return json;
  };
  return $parseSerializedNode(serialize(node)) as T;
}

function $nth(index: number): ElementNode {
  const node = $getRoot().getChildAtIndex(index);
  assert($isElementNode(node), `child ${index} is an element`);
  return node;
}

/** Put a collapsed selection at `offset` characters into block `index`. */
function $caret(index: number, offset: number): void {
  const block = $nth(index);
  const text = block.getFirstDescendant();
  if ($isTextNode(text)) {
    text.select(offset, offset);
  } else {
    block.select(0, 0);
  }
}

/** Select from the start of block `from` to the end of block `to`. */
function $selectBlocks(from: number, to: number): void {
  const first = $nth(from).getFirstDescendant();
  const last = $nth(to).getLastDescendant();
  assert($isTextNode(first) && $isTextNode(last));
  first.select(0, 0);
  const range = $getSelection();
  assert($isRangeSelection(range));
  range.focus.set(last.getKey(), last.getTextContentSize(), 'text');
}

function seed(editor: LexicalEditor, texts: string[]): void {
  update(editor, () => {
    $getRoot()
      .clear()
      .append(...texts.map($paragraph));
  });
}

function paragraphJSON(text: string, id?: unknown): SerializedLexicalNode {
  return {
    ...(id === undefined ? {} : {$: {blockId: id}}),
    children: [
      {
        detail: 0,
        format: 0,
        mode: 'normal',
        style: '',
        text,
        type: 'text',
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
  } as SerializedLexicalNode;
}

function docJSON(children: SerializedLexicalNode[]): string {
  return JSON.stringify({
    root: {
      children,
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  });
}

/**
 * Every element and decorator below the root as `type`, with `:id` when it
 * has an id (positional ids aliased), indented by depth.
 */
function outline(editor: LexicalEditor): string[] {
  const shown = aliases(editor);
  return editor.read(() => {
    const out: string[] = [];
    const walk = (node: LexicalNode, depth: number) => {
      if ($isTextNode(node)) {
        return;
      }
      if (depth >= 0) {
        const id = $getBlockId(node);
        out.push(
          `${'  '.repeat(depth)}${node.getType()}` +
            (id === null ? '' : `:${shown.get(id) ?? id}`),
        );
      }
      if ($isElementNode(node)) {
        for (const child of node.getChildren()) {
          walk(child, depth + 1);
        }
      }
    };
    walk($getRoot(), -1);
    return out;
  });
}

/** Every identified block is found by $getBlockById under its own id. */
function expectAllIndexed(editor: LexicalEditor): void {
  const {$isIdentifiedBlock} = getExtensionDependencyFromEditor(
    editor,
    BlockIdExtension,
  ).output;
  editor.read(() => {
    const walk = (node: LexicalNode) => {
      if ($isIdentifiedBlock(node)) {
        const id = $getBlockId(node);
        expect(id, `${node.getType()} has an id`).not.toBeNull();
        expect($getBlockById(id!), `$getBlockById(${id})`).toBe(
          node.getLatest(),
        );
      }
      if ($isElementNode(node)) {
        node.getChildren().forEach(walk);
      }
    };
    walk($getRoot());
  });
}

function expectUnique(editor: LexicalEditor): void {
  const all = ids(editor);
  expect(all.every(id => typeof id === 'string')).toBe(true);
  expect(new Set(all).size).toBe(all.length);
}

describe('BlockIdExtension: assignment', () => {
  test('a block gets its id in the commit that creates it', () => {
    using editor = build();
    const committed: (string | null)[][] = [];
    editor.registerUpdateListener(({editorState}) => {
      committed.push(
        editorState.read(() => $getRoot().getChildren().map($getBlockId)),
      );
    });
    update(editor, () => {
      $getRoot().append($paragraph('one'), $createHorizontalRuleNode());
    });
    // One commit, already carrying both ids: nothing is left for a later
    // update to assign.
    expect(committed).toEqual([['b1', 'b2']]);
    expect(blocks(editor)).toEqual([
      'paragraph:one:b1',
      'horizontalrule:\n:b2',
    ]);
  });

  test('importJSON assigns ids in the same commit, keeps existing ones', () => {
    using editor = build({fresh: true});
    let commits = 0;
    editor.registerUpdateListener(() => commits++);
    editor.setEditorState(
      editor.parseEditorState(
        docJSON([
          paragraphJSON('kept', 'keep-me'),
          paragraphJSON('missing'),
          paragraphJSON('also kept', 'x_9-Z'),
        ]),
      ),
    );
    expect(commits).toBe(1);
    // A load: the missing id is positional (block 1), not generated.
    expect(blocks(editor)).toEqual([
      'paragraph:kept:keep-me',
      'paragraph:missing:@1',
      'paragraph:also kept:x_9-Z',
    ]);
  });

  test('a document opened without ids gets positional ids in the commit that loads it', () => {
    const json = docJSON([paragraphJSON('a'), paragraphJSON('b')]);
    using editor = buildEditorFromExtensions({
      $initialEditorState: json,
      dependencies: [
        RichTextExtension,
        configExtension(BlockIdExtension, {generateId: counter()}),
      ],
      name: '[opened]',
    });
    expect(blocks(editor)).toEqual(['paragraph:a:@0', 'paragraph:b:@1']);
  });

  test('a node a transform creates but never inserts does not delay the ids of a load', () => {
    const json = docJSON([paragraphJSON('a'), paragraphJSON('b')]);
    const load = (scratch: boolean) => {
      using editor = buildEditorFromExtensions({
        $initialEditorState: null,
        dependencies: [
          RichTextExtension,
          configExtension(BlockIdExtension, {generateId: counter()}),
        ],
        name: '[scratch]',
      });
      if (scratch) {
        editor.registerNodeTransform(ParagraphNode, () => {
          $createTextNode('scratch');
        });
      }
      const committed: (string | null)[][] = [];
      editor.registerUpdateListener(({editorState}) => {
        committed.push(
          editorState.read(() =>
            $getRoot()
              .getChildren()
              .map(child => $getBlockId(child)),
          ),
        );
      });
      editor.setEditorState(editor.parseEditorState(json));
      return committed;
    };
    const expected = load(false);
    expect(expected).toHaveLength(1);
    expect(expected[0].every(id => id !== null)).toBe(true);
    // One commit, with the ids an editor without the transform assigns.
    expect(load(true)).toEqual(expected);
  });

  test('a state from an editor without the extension is repaired', () => {
    using plain = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot().append($paragraph('a'), $paragraph('b'));
      },
      dependencies: [RichTextExtension],
      name: '[plain]',
    });
    plain.read(() => {});
    using editor = build();
    // Not parsed: setEditorState marks only the root dirty, so the index is
    // rebuilt and the missing ids are assigned by a follow-up update.
    editor.setEditorState(plain.getEditorState());
    expect(blocks(editor)).toEqual(['paragraph:a:@0', 'paragraph:b:@1']);
  });

  test('headless one-write recipe from the docs', () => {
    // Stored JSON without ids (or with some) …
    const stored = docJSON([
      paragraphJSON('Intro'),
      paragraphJSON('Body', 'b-body'),
    ]);
    // … is loaded, assigned, and serialized in one synchronous write.
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        configExtension(BlockIdExtension, {generateId: counter('id')}),
      ],
      name: '[server]',
    });
    editor.setEditorState(editor.parseEditorState(stored));
    const json: SerializedEditorState = editor.getEditorState().toJSON();
    // The missing id is positional: block 0 of this document.
    const intro = P(editor, '0');
    expect(json.root.children.map(child => child.$)).toEqual([
      {blockId: intro},
      {blockId: 'b-body'},
    ]);
    // An agent edit addressed by id, also synchronous.
    editor.update(
      () => {
        const block = $getBlockById('b-body');
        assert(block !== null);
        block.replace($paragraph('New body'));
      },
      {discrete: true},
    );
    const after = editor.getEditorState().toJSON();
    // The replacement sits where the removed block sat, so it keeps its id.
    expect(after.root.children.map(child => child.$)).toEqual([
      {blockId: intro},
      {blockId: 'b-body'},
    ]);
  });

  test('invalid stored ids read as absent and are replaced by place', () => {
    using editor = build({fresh: true});
    const invalid = [
      42,
      '',
      'x'.repeat(65),
      'a b',
      ' padded ',
      '"><script>',
      'line\r\nbreak',
      'nul\u0000x',
      'lone\ud800',
      'émoji👋',
      'doc:12',
    ];
    editor.setEditorState(
      editor.parseEditorState(
        docJSON([
          ...invalid.map(id => paragraphJSON('invalid', id)),
          paragraphJSON('max', 'y'.repeat(64)),
          paragraphJSON('short', 'bk3j9x0a2zq'),
          paragraphJSON('uuid', '123e4567-e89b-12d3-a456-426614174000'),
        ]),
      ),
    );
    expect(ids(editor)).toEqual([
      ...invalid.map((_, i) => `@${i}`),
      'y'.repeat(64),
      'bk3j9x0a2zq',
      '123e4567-e89b-12d3-a456-426614174000',
    ]);
    // The invalid values are gone from the saved JSON.
    const saved = JSON.stringify(editor.getEditorState().toJSON());
    expect(saved).not.toContain('a b');
    expect(saved).not.toContain('x'.repeat(65));
  });

  test('an invalid id from another replica is repaired like a missing one', () => {
    using editor = build();
    seed(editor, ['one']);
    editor.update(
      () => {
        $getRoot().append(
          $parseSerializedNode(paragraphJSON('remote', 'not valid!')),
        );
      },
      {discrete: true, skipTransforms: true, tag: COLLABORATION_TAG},
    );
    expect(ids(editor)).toEqual(['b1', '@1']);
  });

  test('an invalid id set with $setState reads as absent and is replaced', () => {
    using editor = build();
    seed(editor, ['one']);
    update(editor, () => {
      const node = $paragraph('two');
      $setState(node, blockIdState, 'not valid!');
      $getRoot().append(node);
      expect($getBlockId(node)).toBe(null);
    });
    expect(ids(editor)).toEqual(['b1', 'b2']);
    expect(JSON.stringify(editor.getEditorState().toJSON())).not.toMatch(
      /not valid/,
    );
    expectAllIndexed(editor);
  });

  test('generateId collisions are retried and a broken generator throws', () => {
    const sequence = ['dup', 'dup', 'dup', 'fresh'];
    using editor = build({generateId: () => sequence.shift() || 'dup'});
    update(editor, () => {
      $getRoot().append($paragraph('a'), $paragraph('b'));
    });
    expect(ids(editor)).toEqual(['dup', 'fresh']);
    expect(() =>
      update(editor, () => {
        $getRoot().append($paragraph('c'));
      }),
    ).toThrow(/generateId returned 32 ids in a row/);
  });

  test('invalid generateId values are discarded and generateId is called again', () => {
    let sequence: string[] = [];
    using editor = build({
      generateId: () =>
        sequence.length > 0 ? (sequence.shift() as string) : 'setup',
    });
    // Not a string at all, as an untyped generator might return.
    const notAString = undefined as unknown as string;
    sequence = [notAString, '', 'x'.repeat(65), 'a b', 'é', 'ok'];
    update(editor, () => {
      $getRoot().append($paragraph('a'));
    });
    expect(ids(editor)).toEqual(['ok']);
    using broken = build({generateId: () => 'not valid'});
    expect(() =>
      update(broken, () => {
        $getRoot().append($paragraph('a'));
      }),
    ).toThrow(/generateId returned 32 ids in a row/);
    using exhausted = build({generateId: () => notAString});
    expect(() =>
      update(exhausted, () => {
        $getRoot().append($paragraph('a'));
      }),
    ).toThrow(/generateId returned 32 ids in a row/);
  });

  test('the default generator makes 126-bit URL-safe ids', () => {
    const seen = new Set<string>();
    const used = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = generateBlockId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
      expect(blockIdState.parse(id)).toBe(id);
      seen.add(id);
      for (const ch of id) {
        used.add(ch);
      }
    }
    expect(seen.size).toBe(1000);
    // Every character carries 6 bits: all 64 symbols show up.
    expect(used.size).toBe(64);
  });

  test('markdown import assigns ids', () => {
    using editor = build();
    update(editor, () => {
      $convertFromMarkdownString(
        '# Title\n\nText\n\n> Quote\n\n- one\n- two\n\n1. first',
        [HEADING, QUOTE, UNORDERED_LIST, ORDERED_LIST],
      );
    });
    expect(outline(editor).map(line => line.replace(/:b\d+$/, ':id'))).toEqual([
      'heading:id',
      'paragraph:id',
      'quote:id',
      'list:id',
      '  listitem:id',
      '  listitem:id',
      'list:id',
      '  listitem:id',
    ]);
    expectAllIndexed(editor);
  });
});

describe('BlockIdExtension: uniqueness', () => {
  test('duplicates in imported JSON: the earliest keeps the id', () => {
    using editor = build({fresh: true});
    editor.setEditorState(
      editor.parseEditorState(
        docJSON([
          paragraphJSON('first', 'x'),
          paragraphJSON('second', 'y'),
          paragraphJSON('copy of first', 'x'),
          paragraphJSON('another copy', 'x'),
          paragraphJSON('copy of second', 'y'),
        ]),
      ),
    );
    // A load: the later holders of a repeated id get ids derived from it and
    // their ordinal, so every reader of this JSON names the copies alike.
    expect(ids(editor)).toEqual(['x', 'y', D('x', 1), D('x', 2), D('y', 1)]);
  });

  test('deterministic and idempotent', () => {
    const json = docJSON([
      paragraphJSON('c', 'z'),
      paragraphJSON('a', 'z'),
      paragraphJSON('b'),
      paragraphJSON('d', 'z'),
    ]);
    const run = () => {
      // The default, random generator: the missing and repeated ids are
      // positional, so two loads still agree.
      using editor = build({fresh: true, generateId: generateBlockId});
      editor.setEditorState(editor.parseEditorState(json));
      return editor.getEditorState().toJSON();
    };
    const first = run();
    expect(run()).toEqual(first);
    // Loading the repaired document again changes nothing.
    using editor = build({generateId: counter('again')});
    editor.setEditorState(editor.parseEditorState(JSON.stringify(first)));
    expect(editor.getEditorState().toJSON()).toEqual(first);
    // And neither do more updates.
    update(editor, () => $nth(0).markDirty());
    expect(editor.getEditorState().toJSON()).toEqual(first);
  });

  test('a duplicate inserted after the original gets a fresh id', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      const original = $nth(0);
      const copy = $parseSerializedNode(original.exportJSON());
      expect($getBlockId(copy)).toBe('b1');
      $nth(1).insertAfter(copy);
    });
    expect(blocks(editor)).toEqual([
      'paragraph:one:b1',
      'paragraph:two:b2',
      'paragraph::b3',
    ]);
  });

  test('a duplicate inserted above the original yields to it', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      const copy = $parseSerializedNode($nth(1).exportJSON());
      expect($getBlockId(copy)).toBe('b2');
      $nth(0).insertBefore(copy);
    });
    // The original existed before this update, so it keeps b2 even though
    // the copy comes first in the document.
    expect(ids(editor)).toEqual(['b3', 'b1', 'b2']);
  });

  test('duplicating a block upward keeps the id on the original', () => {
    using editor = build();
    seed(editor, ['one', 'two', 'three']);
    update(editor, () => {
      $nth(0).insertBefore($deepCopy($nth(2)));
    });
    expect(blocks(editor)).toEqual([
      'paragraph:three:b4',
      'paragraph:one:b1',
      'paragraph:two:b2',
      'paragraph:three:b3',
    ]);
    editor.read(() => {
      expect($getBlockById('b3')).toBe($nth(3));
    });
  });

  test('blocks that all get an id in one local update: the first created keeps it', () => {
    using editor = build();
    seed(editor, ['one']);
    update(editor, () => {
      const copy = (text: string) => {
        const node = $paragraph(text);
        $setState(node, blockIdState, 'same');
        return node;
      };
      $nth(0).insertAfter(copy('later'));
      $nth(0).insertAfter(copy('earlier'));
    });
    // Only this editor makes the decision (and shares its result), so the
    // order the nodes were created in is enough, whatever their position.
    expect(blocks(editor)).toEqual([
      'paragraph:one:b1',
      'paragraph:earlier:b2',
      'paragraph:later:same',
    ]);
  });

  test('a committed duplicate: the earliest in document order keeps it, whatever the keys', () => {
    // Two editors receive the same duplicate with their nodes created in
    // opposite orders (as two replicas may after their changes merge), and must
    // repair it the same way.
    const repaired: string[][] = [];
    for (const createLaterFirst of [false, true]) {
      using editor = build();
      seed(editor, ['one']);
      editor.update(
        () => {
          const created = createLaterFirst
            ? [$paragraph('later'), $paragraph('earlier')]
            : [$paragraph('earlier'), $paragraph('later')];
          for (const node of created) {
            $setState(node, blockIdState, 'same');
          }
          const [earlier, later] = createLaterFirst
            ? [created[1], created[0]]
            : created;
          $nth(0).insertAfter(earlier);
          earlier.insertAfter(later);
        },
        {discrete: true, skipTransforms: true, tag: COLLABORATION_TAG},
      );
      repaired.push(blocks(editor));
    }
    // The later copy gets the id derived from the repeated id and its
    // ordinal, as every replica that repairs the same duplicate names it.
    expect(repaired[0]).toEqual([
      'paragraph:one:b1',
      'paragraph:earlier:same',
      `paragraph:later:${D('same', 1)}`,
    ]);
    expect(repaired[1]).toEqual(repaired[0]);
  });

  test('$copyNode does not copy the id', () => {
    using editor = build();
    seed(editor, ['one']);
    update(editor, () => {
      const copy = $copyNode($nth(0));
      expect($getState(copy, blockIdState)).toBeUndefined();
      $nth(0).insertBefore(copy);
    });
    // The original keeps its id even though the copy comes first.
    expect(ids(editor)).toEqual(['b2', 'b1']);
  });

  test('$copyNode right after loading JSON does not copy the stored id', () => {
    // NodeState read from JSON is only reset by $copyNode once its config is
    // known on the node; the load update reads every identified block's id,
    // so a copy made in the very next update starts without one.
    using editor = build();
    editor.setEditorState(
      editor.parseEditorState(docJSON([paragraphJSON('stored', 'x')])),
    );
    update(editor, () => {
      const copy = $copyNode($nth(0));
      expect($getState(copy, blockIdState)).toBeUndefined();
      $getRoot().append(copy);
    });
    expect(ids(editor)).toEqual(['x', 'b1']);
  });

  test('an explicit id that is already in use is repaired', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $setState($nth(1), blockIdState, 'b1');
    });
    expect(ids(editor)).toEqual(['b1', 'b3']);
    update(editor, () => {
      $setState($nth(0), blockIdState, 'b3');
    });
    // The first block claims the second block's id, but the second block
    // already had it and keeps it.
    expect(ids(editor)).toEqual(['b4', 'b3']);
  });

  test('copy and paste within one editor and between editors', () => {
    using source = build({generateId: counter('s')});
    using target = build({generateId: counter('t')});
    seed(source, ['alpha', 'beta']);
    seed(target, ['gamma']);
    let copied!: ReturnType<typeof $generateJSONFromSelectedNodes>;
    update(source, () => {
      $selectBlocks(0, 1);
      copied = $generateJSONFromSelectedNodes(source, $getSelection());
    });
    expect(copied.nodes.map(node => (node as {$?: unknown}).$)).toEqual([
      {blockId: 's1'},
      {blockId: 's2'},
    ]);
    const paste = (editor: LexicalEditor) =>
      update(editor, () => {
        $getRoot().selectEnd();
        $insertGeneratedNodes(
          editor,
          $generateNodesFromSerializedNodes(copied.nodes),
          $getSelection()!,
        );
      });
    // Into another editor that does not use the ids: they are kept.
    paste(target);
    expect(blocks(target)).toEqual([
      'paragraph:gammaalpha:t1',
      'paragraph:beta:s2',
    ]);
    // Into the same editor: the pasted copies yield to the originals.
    paste(source);
    expectUnique(source);
    expect(ids(source).slice(0, 2)).toEqual(['s1', 's2']);
  });

  function $copyBlocks(editor: LexicalEditor, from: number, to: number) {
    $selectBlocks(from, to);
    return $generateJSONFromSelectedNodes(editor, $getSelection());
  }

  function $pasteInto(
    editor: LexicalEditor,
    copied: ReturnType<typeof $generateJSONFromSelectedNodes>,
    block: ElementNode,
  ) {
    block.select();
    $insertGeneratedNodes(
      editor,
      $generateNodesFromSerializedNodes(copied.nodes),
      $getSelection()!,
    );
  }

  test('pasting a copy above the original: the original keeps its id', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $createParagraphNode(),
        $paragraph('alpha'),
        $paragraph('beta'),
      );
    });
    expect(ids(editor)).toEqual(['b1', 'b2', 'b3']);
    let copied!: ReturnType<typeof $generateJSONFromSelectedNodes>;
    update(editor, () => {
      copied = $copyBlocks(editor, 1, 2);
    });
    update(editor, () => $pasteInto(editor, copied, $nth(0)), PASTE_TAG);
    // The pasted blocks replace the empty paragraph (b1 goes with it). They
    // are new in this update, so they yield to the originals.
    expect(blocks(editor)).toEqual([
      'paragraph:alpha:b4',
      'paragraph:beta:b5',
      'paragraph:alpha:b2',
      'paragraph:beta:b3',
    ]);
  });

  test('cut and paste moves the ids with the blocks', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $paragraph('one'),
        $paragraph('two'),
        $paragraph('three'),
        $createParagraphNode(),
      );
    });
    let copied!: ReturnType<typeof $generateJSONFromSelectedNodes>;
    // Cut, in its own update…
    update(editor, () => {
      copied = $copyBlocks(editor, 0, 1);
      $nth(1).remove();
      $nth(0).remove();
    });
    expect(ids(editor)).toEqual(['b3', 'b4']);
    // …and paste later: nothing else has the ids, so the pasted blocks keep
    // them.
    update(editor, () => $pasteInto(editor, copied, $nth(1)), PASTE_TAG);
    expect(blocks(editor)).toEqual([
      'paragraph:three:b3',
      'paragraph:one:b1',
      'paragraph:two:b2',
    ]);
    // The same in a single update (a move done as remove + insert of a copy).
    update(editor, () => {
      const copy = $deepCopy($nth(0));
      $nth(0).remove();
      $nth(1).insertAfter(copy);
    });
    expect(blocks(editor)).toEqual([
      'paragraph:one:b1',
      'paragraph:two:b2',
      'paragraph:three:b3',
    ]);
  });

  test('undo of a paste restores the ids, redo the repaired ones', () => {
    using editor = build({history: true});
    update(editor, () => {
      $getRoot().append(
        $createParagraphNode(),
        $paragraph('alpha'),
        $paragraph('beta'),
      );
    });
    const before = blocks(editor);
    let copied!: ReturnType<typeof $generateJSONFromSelectedNodes>;
    update(editor, () => {
      copied = $copyBlocks(editor, 1, 2);
    });
    update(editor, () => $pasteInto(editor, copied, $nth(0)), PASTE_TAG);
    const after = blocks(editor);
    expect(after).toEqual([
      'paragraph:alpha:b4',
      'paragraph:beta:b5',
      'paragraph:alpha:b2',
      'paragraph:beta:b3',
    ]);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(blocks(editor)).toEqual(before);
    editor.read(() => {
      expect($getBlockById('b4')).toBeNull();
      expect($getBlockById('b5')).toBeNull();
      expect($getBlockById('b2')!.getTextContent()).toBe('alpha');
    });
    editor.dispatchCommand(REDO_COMMAND, undefined);
    expect(blocks(editor)).toEqual(after);
  });
});

describe('BlockIdExtension: split and merge', () => {
  function enter(editor: LexicalEditor, index: number, offset: number) {
    update(editor, () => {
      $caret(index, offset);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
  }

  test.each([
    ['start', 0, ['paragraph::b3', 'paragraph:hello:b1']],
    ['middle', 2, ['paragraph:he:b1', 'paragraph:llo:b3']],
    ['end', 5, ['paragraph:hello:b1', 'paragraph::b3']],
  ])('Enter at the %s of a paragraph', (_, offset, expected) => {
    using editor = build();
    seed(editor, ['hello', 'next']);
    enter(editor, 0, offset);
    expect(blocks(editor)).toEqual([...expected, 'paragraph:next:b2']);
  });

  test.each([
    ['start', 0, ['paragraph::b3', 'heading:hello:b1']],
    ['middle', 2, ['heading:he:b1', 'heading:llo:b3']],
    ['end', 5, ['heading:hello:b1', 'paragraph::b3']],
  ])('Enter at the %s of a heading', (_, offset, expected) => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $createHeadingNode('h1').append($createTextNode('hello')),
        $paragraph('next'),
      );
    });
    enter(editor, 0, offset);
    expect(blocks(editor)).toEqual([...expected, 'paragraph:next:b2']);
  });

  test.each([
    // QuoteNode.insertNewAfter creates a paragraph, so Enter at the start
    // leaves an empty quote above and moves the text into a paragraph. The
    // text keeps its id.
    ['start', 0, ['quote::b3', 'paragraph:hello:b1']],
    ['middle', 2, ['quote:he:b1', 'paragraph:llo:b3']],
    ['end', 5, ['quote:hello:b1', 'paragraph::b3']],
  ])('Enter at the %s of a quote', (_, offset, expected) => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $createQuoteNode().append($createTextNode('hello')),
        $paragraph('next'),
      );
    });
    enter(editor, 0, offset);
    expect(blocks(editor)).toEqual([...expected, 'paragraph:next:b2']);
  });

  test.each([
    ['start', 0, [':b4', 'one:b1']],
    ['middle', 1, ['o:b1', 'ne:b4']],
    ['end', 3, ['one:b1', ':b4']],
  ])('Enter at the %s of a list item (nested ids)', (_, offset, expected) => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $selectBlocks(0, 1);
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    });
    const items = () =>
      editor.read(() =>
        $nth(0)
          .getChildren()
          .map(item => `${item.getTextContent()}:${$getBlockId(item)}`),
      );
    // The items took the paragraphs' content, and with it their ids; the
    // list is a new block.
    expect(ids(editor)).toEqual(['b3']);
    expect(items()).toEqual(['one:b1', 'two:b2']);
    update(editor, () => {
      const item = $assertNodeType(
        $nth(0).getFirstChildOrThrow(),
        $isElementNode,
      );
      const text = item.getFirstDescendant();
      assert($isTextNode(text));
      text.select(offset, offset);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    expect(items()).toEqual([...expected, 'two:b2']);
  });

  test('Backspace join keeps the surviving block id', () => {
    using editor = build();
    seed(editor, ['one', 'two', 'three']);
    update(editor, () => {
      $caret(1, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    expect(blocks(editor)).toEqual([
      'paragraph:onetwo:b1',
      'paragraph:three:b3',
    ]);
    // Forward delete at the end joins the next block into this one.
    update(editor, () => {
      $caret(0, 6);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, false);
    });
    expect(blocks(editor)).toEqual(['paragraph:onetwothree:b1']);
  });

  test('Backspace into a heading keeps the heading id', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $createHeadingNode('h2').append($createTextNode('Title')),
        $paragraph('body'),
      );
    });
    update(editor, () => {
      $caret(1, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    expect(blocks(editor)).toEqual(['heading:Titlebody:b1']);
  });

  test('Backspace at the start of a heading after a paragraph joins into the paragraph', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $paragraph('before'),
        $createHeadingNode('h2').append($createTextNode('Title')),
      );
    });
    update(editor, () => {
      $caret(1, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    expect(blocks(editor)).toEqual(['paragraph:beforeTitle:b1']);
  });
});

describe('BlockIdExtension: type changes and moves', () => {
  test.each([
    ['heading', () => $createHeadingNode('h1')],
    ['quote', () => $createQuoteNode()],
  ])('paragraph to %s keeps the id', (type, $createBlock) => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $caret(1, 1);
      $setBlocksType($getSelection(), $createBlock as () => ElementNode);
    });
    expect(blocks(editor)).toEqual(['paragraph:one:b1', `${type}:two:b2`]);
    // And back.
    update(editor, () => {
      $caret(1, 1);
      $setBlocksType($getSelection(), $createParagraphNode);
    });
    expect(blocks(editor)).toEqual(['paragraph:one:b1', 'paragraph:two:b2']);
  });

  test('several blocks at once, including empty ones, keep their ids', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $paragraph('a'),
        $createParagraphNode(),
        $createParagraphNode(),
        $paragraph('d'),
      );
    });
    update(editor, () => {
      $getRoot().select(0, 4);
      $setBlocksType($getSelection(), () => $createHeadingNode('h3'));
    });
    expect(blocks(editor)).toEqual([
      'heading:a:b1',
      'heading::b2',
      'heading::b3',
      'heading:d:b4',
    ]);
  });

  test('paragraph to list: the item keeps the id, the list is new', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $caret(1, 0);
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    });
    expect(outline(editor)).toEqual([
      'paragraph:b1',
      'list:b3',
      '  listitem:b2',
    ]);
  });

  test('paragraph to list with $isRootChildBlock keeps the id on the list', () => {
    using editor = build({$isIdentifiedBlock: $isRootChildBlock});
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $caret(1, 0);
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    });
    expect(outline(editor)).toEqual(['paragraph:b1', 'list:b2', '  listitem']);
  });

  test('moving a block (drag and drop) moves its id', () => {
    using editor = build();
    seed(editor, ['one', 'two', 'three']);
    update(editor, () => {
      $nth(2).insertAfter($nth(0));
    });
    expect(blocks(editor)).toEqual([
      'paragraph:two:b2',
      'paragraph:three:b3',
      'paragraph:one:b1',
    ]);
    update(editor, () => {
      $nth(0).insertBefore($nth(2));
    });
    expect(ids(editor)).toEqual(['b1', 'b2', 'b3']);
  });

  test('replacing a block by hand keeps its id unless the new block has one', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $nth(0).replace($paragraph('uno'));
    });
    expect(ids(editor)).toEqual(['b1', 'b2']);
    update(editor, () => {
      const replacement = $paragraph('dos');
      $setState(replacement, blockIdState, 'explicit');
      $nth(1).replace(replacement);
    });
    expect(ids(editor)).toEqual(['b1', 'explicit']);
  });

  test('removing a block and appending a new one elsewhere does not reuse the id', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $nth(0).remove();
      $getRoot().append($paragraph('three'));
    });
    expect(ids(editor)).toEqual(['b2', 'b3']);
  });
});

describe('BlockIdExtension: undo and redo', () => {
  test('restore exact ids', () => {
    using editor = build({history: true});
    seed(editor, ['one', 'two']);
    const snapshots: string[][] = [blocks(editor)];
    const step = (fn: () => void) => {
      update(editor, fn, HISTORY_PUSH_TAG);
      snapshots.push(blocks(editor));
    };
    step(() => {
      $caret(0, 1);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    step(() => {
      $caret(2, 0);
      $setBlocksType($getSelection(), () => $createHeadingNode('h1'));
    });
    step(() => {
      $caret(1, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    step(() => {
      $nth(1).insertBefore($nth(0));
    });
    for (let i = snapshots.length - 2; i >= 0; i--) {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      expect(blocks(editor)).toEqual(snapshots[i]);
      editor.read(() => {
        for (const block of $getRoot().getChildren()) {
          expect($getBlockById($getBlockId(block)!)).toBe(block);
        }
      });
    }
    for (let i = 1; i < snapshots.length; i++) {
      editor.dispatchCommand(REDO_COMMAND, undefined);
      expect(blocks(editor)).toEqual(snapshots[i]);
    }
  });
});

describe('BlockIdExtension: index', () => {
  test('$getBlockById finds blocks and follows changes', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    editor.read(() => {
      expect($getBlockById('b1')!.getTextContent()).toBe('one');
      expect($getBlockById('b2')!.getTextContent()).toBe('two');
      expect($getBlockById('nope')).toBeNull();
    });
    update(editor, () => {
      $nth(0).remove();
      // Removed in this update: no longer found, even before the commit.
      expect($getBlockById('b1')).toBeNull();
    });
    editor.read(() => {
      expect($getBlockById('b1')).toBeNull();
      expect($getBlockById('b2')!.getTextContent()).toBe('two');
    });
    update(editor, () => {
      $setState($nth(0), blockIdState, 'renamed');
    });
    editor.read(() => {
      expect($getBlockById('b2')).toBeNull();
      expect($getBlockById('renamed')!.getTextContent()).toBe('two');
    });
  });

  test('typing does not evaluate $isIdentifiedBlock for untouched blocks', () => {
    const predicate = vi.fn($defaultIsIdentifiedBlock);
    using editor = build({$isIdentifiedBlock: predicate});
    seed(
      editor,
      Array.from({length: 1000}, (_, i) => `block ${i}`),
    );
    expect(new Set(ids(editor)).size).toBe(1000);
    predicate.mockClear();
    update(editor, () => {
      $caret(500, 3);
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      selection.insertText('x');
    });
    // O(dirty), as documented for $isIdentifiedBlock: the edited text's
    // block and its ancestors, not the document. The bounds are loose on
    // purpose; a full scan would make 1000+ calls.
    expect(predicate.mock.calls.length).toBeLessThan(10);
    predicate.mockClear();
    update(editor, () => {
      $caret(500, 3);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    expect(predicate.mock.calls.length).toBeLessThan(20);
    expectUnique(editor);
  });

  test('nested blocks in lists and tables, with table cells added', () => {
    using editor = build({
      $isIdentifiedBlock: node =>
        $defaultIsIdentifiedBlock(node) || $isTableCellNode(node),
    });
    update(editor, () => {
      $getRoot().append(
        $createTableNodeWithDimensions(2, 2, false),
        $paragraph('a'),
        $paragraph('b'),
      );
    });
    update(editor, () => {
      $selectBlocks(1, 2);
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    });
    expect(outline(editor)).toEqual([
      'table:b1',
      '  tablerow',
      '    tablecell:b2',
      '      paragraph:b3',
      '    tablecell:b4',
      '      paragraph:b5',
      '  tablerow',
      '    tablecell:b6',
      '      paragraph:b7',
      '    tablecell:b8',
      '      paragraph:b9',
      'list:b12',
      '  listitem:b10',
      '  listitem:b11',
    ]);
    editor.read(() => {
      expect($getBlockById('b4')!.getType()).toBe('tablecell');
      expect($getBlockById('b11')!.getTextContent()).toBe('b');
      expect($getBlockById('b12')!.getType()).toBe('list');
    });
  });

  test('disabled stops assignment; enabling assigns everything', () => {
    using editor = build({disabled: true});
    const {disabled} = getExtensionDependencyFromEditor(
      editor,
      BlockIdExtension,
    ).output;
    seed(editor, ['one', 'two']);
    expect(ids(editor)).toEqual([null, null]);
    update(editor, () => {
      $setState($nth(1), blockIdState, 'manual');
    });
    editor.read(() => {
      // Not indexed while disabled: found by a scan.
      expect($getBlockById('manual')!.getTextContent()).toBe('two');
    });
    disabled.value = false;
    // Blocks left without an id are named by their place.
    expect(ids(editor)).toEqual(['@0', 'manual']);
    const first = P(editor, '0');
    editor.read(() => {
      expect($getBlockById(first)!.getTextContent()).toBe('one');
    });
    disabled.value = true;
    update(editor, () => {
      $getRoot().append($paragraph('three'));
    });
    // Existing ids are kept; new blocks are left alone.
    expect(ids(editor)).toEqual([first, 'manual', null]);
  });
});

describe('BlockIdExtension: transforms skipped', () => {
  test('a change applied without transforms (remote) is repaired in a follow-up', () => {
    using editor = build();
    seed(editor, ['one']);
    let taggedCommits = 0;
    let followUps = 0;
    editor.registerUpdateListener(({tags}) => {
      if (tags.has(COLLABORATION_TAG)) {
        taggedCommits++;
      } else {
        followUps++;
      }
    });
    editor.update(
      () => {
        const copy = $parseSerializedNode($nth(0).exportJSON());
        $getRoot().append(copy, $paragraph('no id'));
      },
      {discrete: true, skipTransforms: true, tag: COLLABORATION_TAG},
    );
    // Reading flushes the follow-up update queued by the listener.
    const after = blocks(editor);
    expect(taggedCommits).toBe(1);
    expect(followUps).toBe(1);
    // The remote blocks left unnamed are named as every replica that receives
    // them names them: the copy by the repeated id and its ordinal, the
    // block without an id by its place.
    expect(after).toEqual([
      'paragraph:one:b1',
      // exportJSON does not include children, so the copy is empty.
      `paragraph::${D('b1', 1)}`,
      'paragraph:no id:@2',
    ]);
  });

  test('transforms in an update tagged COLLABORATION_TAG leave the repair to the follow-up', () => {
    using editor = build();
    seed(editor, ['one']);
    const commits: string[][] = [];
    editor.registerUpdateListener(({tags, editorState}) => {
      commits.push([
        tags.has(COLLABORATION_TAG) ? 'tagged' : 'follow-up',
        ...editorState.read(() =>
          $getRoot()
            .getChildren()
            .map(n => `${$getBlockId(n)}`),
        ),
      ]);
    });
    update(
      editor,
      () => {
        $getRoot().append($paragraph('remote'));
      },
      COLLABORATION_TAG,
    );
    editor.read(() => {});
    expect(commits).toEqual([
      ['tagged', 'b1', 'null'],
      ['follow-up', 'b1', P(editor, '1')],
    ]);
  });
});

describe('BlockIdExtension: misc', () => {
  test('headings created by Enter at start keep ids unique', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append($createHeadingNode('h1').append($createTextNode('A')));
    });
    update(editor, () => {
      $caret(0, 0);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    expect(blocks(editor)).toEqual(['paragraph::b2', 'heading:A:b1']);
    editor.read(() => {
      expect($isParagraphNode($nth(0))).toBe(true);
      expect($isHeadingNode($nth(1))).toBe(true);
    });
  });
});

describe('BlockIdExtension: documents stored without ids', () => {
  /** A fresh editor with the default, random generator. */
  function reader(
    options: Pick<BuildOptions, '$isIdentifiedBlock'> = {},
  ): LexicalEditorWithDispose {
    return build({...options, fresh: true, generateId: generateBlockId});
  }

  function load(editor: LexicalEditor, json: string): void {
    editor.setEditorState(editor.parseEditorState(json));
  }

  /** The ids of the root's children, unaliased. */
  function rawIds(editor: LexicalEditor): (string | null)[] {
    return editor.read(() => $getRoot().getChildren().map($getBlockId));
  }

  const stored = docJSON([
    paragraphJSON('Intro'),
    paragraphJSON('Body'),
    paragraphJSON('Outro'),
  ]);

  test('two reads name the blocks the same way, by place, without a write', () => {
    using first = reader();
    using second = reader();
    load(first, stored);
    load(second, stored);
    expect(rawIds(first)).toEqual(rawIds(second));
    expect(ids(first)).toEqual(['@0', '@1', '@2']);
    // The same format as generated ids.
    for (const id of rawIds(first)) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    }
  });

  test('blocks at the same place in different documents or versions get different ids', () => {
    using v1 = reader();
    using v2 = reader();
    load(v1, stored);
    load(
      v2,
      docJSON([
        paragraphJSON('Budget'),
        paragraphJSON('Body'),
        paragraphJSON('Outro'),
      ]),
    );
    const a = rawIds(v1);
    const b = rawIds(v2);
    expect(a.filter(id => b.includes(id))).toEqual([]);
  });

  test('stored ids are kept, missing ones are positional, and a taken positional id is retried', () => {
    using probe = reader();
    load(probe, stored);
    const place0 = P(probe, '0');
    // Another block already holds the id that block 0's place derives (the
    // document's key ignores ids, so it is the same document).
    using editor = reader();
    load(
      editor,
      docJSON([
        paragraphJSON('Intro'),
        paragraphJSON('Body', place0),
        paragraphJSON('Outro', 'kept'),
      ]),
    );
    expect(ids(editor)).toEqual(['@0#1', '@0', 'kept']);
    expect(rawIds(editor)[1]).toBe(place0);
  });

  test('blocks created later get generated ids', () => {
    using probe = reader();
    load(probe, stored);
    const read = rawIds(probe);
    using editor = build({fresh: true});
    load(editor, stored);
    update(editor, () => {
      $caret(0, 5);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    update(editor, () => {
      $nth(3).insertAfter($deepCopy($nth(0)));
    });
    // The loaded blocks keep the ids they were read with; the split's new
    // block and the copy get ids from `generateId`.
    expect(blocks(editor)).toEqual([
      `paragraph:Intro:${read[0]}`,
      'paragraph::b1',
      `paragraph:Body:${read[1]}`,
      `paragraph:Outro:${read[2]}`,
      'paragraph:Intro:b2',
    ]);
  });

  test('the first content of an empty editor is a load: initial state functions and the default paragraph', () => {
    const $initial = () => {
      $getRoot().append($paragraph('one'), $paragraph('two'));
    };
    const make = ($initialEditorState?: () => void) =>
      buildEditorFromExtensions({
        ...($initialEditorState ? {$initialEditorState} : {}),
        dependencies: [RichTextExtension, BlockIdExtension],
        name: '[initial]',
      });
    using a = make($initial);
    using b = make($initial);
    expect(rawIds(a)).toEqual(rawIds(b));
    expect(ids(a)).toEqual(['@0', '@1']);
    using c = make();
    using d = make();
    expect(rawIds(c)).toEqual(rawIds(d));
    expect(ids(c)).toEqual(['@0']);
    // The next blocks are edits: random.
    update(a, () => {
      $getRoot().append($paragraph('three'));
    });
    update(b, () => {
      $getRoot().append($paragraph('three'));
    });
    expect(rawIds(a)[2]).not.toBe(rawIds(b)[2]);
  });

  test('a state that replaces the content wholesale is a load; blocks added by updates are edits', () => {
    using editor = build();
    seed(editor, ['old']);
    expect(ids(editor)).toEqual(['b1']);
    load(editor, stored);
    expect(ids(editor)).toEqual(['@0', '@1', '@2']);
    const loaded = rawIds(editor);
    update(editor, () => {
      $getRoot().append($paragraph('new'));
    });
    expect(rawIds(editor)).toEqual([...loaded, 'b2']);
    // Replacing every block in an update is an edit: the new blocks take the
    // places, and so the ids, of the blocks they replaced (as a type change
    // does), and the rest are generated.
    update(editor, () => {
      $getRoot()
        .clear()
        .append(
          ...['x', 'y', 'z', 'w', 'v', 'u'].map(text => $paragraph(text)),
        );
    });
    expect(rawIds(editor)).toEqual([...loaded, 'b2', 'b3', 'b4']);
  });

  test('a state from an editor without the extension gets the ids its JSON gets', () => {
    using plain = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot().append($paragraph('a'), $createHeadingNode('h2'));
      },
      dependencies: [RichTextExtension],
      name: '[plain]',
    });
    plain.read(() => {});
    using fromState = reader();
    fromState.setEditorState(plain.getEditorState());
    using fromJSON = reader();
    load(fromJSON, JSON.stringify(plain.getEditorState().toJSON()));
    expect(rawIds(fromState)).toEqual(rawIds(fromJSON));
    expect(ids(fromState)).toEqual(['@0', '@1']);
  });

  test("a person's first edits keep the ids a reader read", () => {
    using probe = reader();
    load(probe, stored);
    const read = rawIds(probe);
    using editor = build({fresh: true});
    load(editor, stored);
    // Enter at the start of block 0, and block 1 becomes a heading.
    update(editor, () => {
      $caret(0, 0);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    update(editor, () => {
      $caret(2, 0);
      $setBlocksType($getSelection(), () => $createHeadingNode('h1'));
    });
    expect(blocks(editor)).toEqual([
      'paragraph::b1',
      `paragraph:Intro:${read[0]}`,
      `heading:Body:${read[1]}`,
      `paragraph:Outro:${read[2]}`,
    ]);
    editor.read(() => {
      expect(read.map(id => $getBlockById(id!)!.getTextContent())).toEqual([
        'Intro',
        'Body',
        'Outro',
      ]);
    });
  });

  test('nested blocks are named by their path among identified blocks', () => {
    using plain = buildEditorFromExtensions({
      $initialEditorState: () =>
        $convertFromMarkdownString('Title\n\n- one\n- two\n\nEnd', [
          UNORDERED_LIST,
        ]),
      dependencies: [RichTextExtension, ListExtension],
      name: '[plain]',
    });
    plain.read(() => {});
    const json = JSON.stringify(plain.getEditorState().toJSON());
    using editor = reader();
    load(editor, json);
    const documentKey = editor.read($documentKey);
    const expected = ['0', '1', '1.0', '1.1', '2'].map(place =>
      derivePositionalId(documentKey, place),
    );
    const actual = editor.read(() => {
      const out: (string | null)[] = [];
      for (const block of $getRoot().getChildren()) {
        out.push($getBlockId(block));
        if ($isElementNode(block) && block.getType() === 'list') {
          out.push(...block.getChildren().map($getBlockId));
        }
      }
      return out;
    });
    expect(actual).toEqual(expected);
  });

  test('a load assigns every id in its own commit and is idempotent', () => {
    using editor = reader();
    let commits = 0;
    editor.registerUpdateListener(() => commits++);
    load(editor, stored);
    expect(commits).toBe(1);
    const once = editor.getEditorState().toJSON();
    using again = reader();
    load(again, JSON.stringify(once));
    expect(again.getEditorState().toJSON()).toEqual(once);
  });
});

describe('BlockIdExtension: the default predicate', () => {
  /** An element that declares no structure, like most app classes. */
  class BoxNode extends ElementNode {
    $config() {
      return this.config('block-id-box', {extends: ElementNode});
    }
  }

  function buildWithBox(): LexicalEditorWithDispose {
    return asEdited(
      buildEditorFromExtensions({
        $initialEditorState: null,
        dependencies: [
          RichTextExtension,
          ListExtension,
          TableExtension,
          HorizontalRuleExtension,
          CodeExtension,
          LinkExtension,
          configExtension(BlockIdExtension, {generateId: counter()}),
        ],
        name: '[block-id-default]',
        nodes: [BoxNode],
      }),
    );
  }

  test('root children, nested blocks that hold text, nested block decorators', () => {
    using editor = buildWithBox();
    update(editor, () => {
      const cell = (...children: LexicalNode[]) =>
        $createTableCellNode().append(...children);
      $getRoot().append(
        $createTableNode().append(
          $createTableRowNode().append(
            cell(
              $createHeadingNode('h2').append($createTextNode('h')),
              $createQuoteNode().append($createTextNode('q')),
              $createCodeNode().append($createTextNode('c')),
            ),
            cell(
              $createHorizontalRuleNode(),
              $create(BoxNode).append($paragraph('in a box')),
              $createQuoteNode({shadowRoot: true}).append($paragraph('sq')),
              $createParagraphNode().append(
                $createLinkNode('https://lexical.dev').append(
                  $createTextNode('link'),
                ),
              ),
            ),
          ),
        ),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append(
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('two')),
            ),
          ),
        ),
        $create(BoxNode).append($paragraph('in a box')),
        $createQuoteNode({shadowRoot: true}).append($paragraph('sq')),
      );
    });
    // A list item that only holds a nested list is still a list item: its
    // class declares inline children.
    expect(outline(editor)).toEqual([
      'table:b1',
      '  tablerow',
      '    tablecell',
      '      heading:b2',
      '      quote:b3',
      '      code:b4',
      '    tablecell',
      '      horizontalrule:b5',
      '      block-id-box',
      '        paragraph:b6',
      '      quote',
      '        paragraph:b7',
      '      paragraph:b8',
      '        link',
      'list:b9',
      '  listitem:b10',
      '  listitem:b11',
      '    list',
      '      listitem:b12',
      'block-id-box:b13',
      '  paragraph:b14',
      'quote:b15',
      '  paragraph:b16',
    ]);
    editor.read(() => {
      const visit = (node: LexicalNode) => {
        if (!$isTextNode(node)) {
          // Exactly the nodes the predicate identifies have ids.
          expect($getBlockId(node) !== null).toBe(
            $defaultIsIdentifiedBlock(node),
          );
        }
        if ($isElementNode(node)) {
          node.getChildren().forEach(visit);
        }
      };
      $getRoot().getChildren().forEach(visit);
    });
    expectUnique(editor);
  });

  test('ids stored on the root children are kept; nested blocks get positional ids', () => {
    // Written with the previous default: ids on the root's children only.
    using writer = build({
      $isIdentifiedBlock: $isRootChildBlock,
      generateId: counter('r'),
    });
    update(writer, () => {
      $getRoot().append(
        $paragraph('Title'),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append($createTextNode('two')),
        ),
        $createTableNodeWithDimensions(1, 2, false),
      );
    });
    const stored = JSON.stringify(writer.getEditorState().toJSON());
    const read = () => {
      const editor = build({fresh: true, generateId: generateBlockId});
      editor.setEditorState(editor.parseEditorState(stored));
      return editor;
    };
    using first = read();
    using second = read();
    expect(outline(first)).toEqual([
      'paragraph:r1',
      'list:r2',
      '  listitem:@1.0',
      '  listitem:@1.1',
      'table:r3',
      '  tablerow',
      '    tablecell',
      '      paragraph:@2.0',
      '    tablecell',
      '      paragraph:@2.1',
    ]);
    expect(first.getEditorState().toJSON()).toEqual(
      second.getEditorState().toJSON(),
    );
    // Stored once, they are ordinary ids: loading again changes nothing.
    const saved = JSON.stringify(first.getEditorState().toJSON());
    using again = build({fresh: true, generateId: generateBlockId});
    again.setEditorState(again.parseEditorState(saved));
    expect(JSON.stringify(again.getEditorState().toJSON())).toBe(saved);
  });
});

describe('BlockIdExtension: the index finds every identified block', () => {
  /** Ids on the root's children only, as `$isRootChildBlock` writes them. */
  function rootOnlyDocument(): string {
    using writer = build({
      $isIdentifiedBlock: $isRootChildBlock,
      generateId: counter('r'),
    });
    update(writer, () => {
      $getRoot().append(
        $paragraph('Title'),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append($createTextNode('two')),
        ),
        $createTableNodeWithDimensions(1, 2, false),
      );
    });
    return JSON.stringify(writer.getEditorState().toJSON());
  }

  test('a document with ids on the root children only, via setEditorState', () => {
    using editor = build({fresh: true});
    editor.setEditorState(editor.parseEditorState(rootOnlyDocument()));
    expect(ids(editor)).toEqual(['r1', 'r2', 'r3']);
    expectAllIndexed(editor);
    // Typing in an item keeps it that way.
    update(editor, () => {
      const item = $assertNodeType(
        $nth(1).getFirstChildOrThrow(),
        $isElementNode,
      );
      $assertNodeType(item.getFirstChildOrThrow(), $isTextNode).setTextContent(
        'one!',
      );
    });
    expectAllIndexed(editor);
  });

  test('a document with ids on the root children only, as the initial state', () => {
    const stored = rootOnlyDocument();
    using editor = buildEditorFromExtensions({
      $initialEditorState: stored,
      dependencies: [
        RichTextExtension,
        ListExtension,
        TableExtension,
        BlockIdExtension,
      ],
      name: '[block-id-initial]',
    });
    expect(ids(editor)).toEqual(['r1', 'r2', 'r3']);
    expectAllIndexed(editor);
  });

  test.each([
    [
      'list',
      () =>
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('item')),
        ),
    ],
    ['table', () => $createTableNodeWithDimensions(1, 1, false)],
  ])('a %s given an id with $setState before it is inserted', (_, $make) => {
    using editor = build();
    seed(editor, ['p']);
    update(editor, () => {
      const block = $make();
      $setState(block, blockIdState, 'my-block');
      $getRoot().append(block);
    });
    expect(ids(editor)).toEqual(['b1', 'my-block']);
    expectAllIndexed(editor);
    editor.read(() => {
      expect($getBlockById('my-block')).toBe($nth(1).getLatest());
    });
  });

  test('a copy of a list whose items got ids alongside it yields to it', () => {
    using editor = build();
    update(editor, () => {
      const list = $createListNode('bullet').append(
        $createListItemNode().append($createTextNode('item')),
      );
      $setState(list, blockIdState, 'my-list');
      $getRoot().append($paragraph('before'), list, $paragraph('after'));
    });
    update(editor, () => {
      const item = $assertNodeType(
        $nth(1).getFirstChildOrThrow(),
        $isElementNode,
      );
      $assertNodeType(item.getFirstChildOrThrow(), $isTextNode).setTextContent(
        'item!',
      );
    });
    const originalKey = editor.read(() => $nth(1).getKey());
    update(editor, () => {
      $nth(0).insertBefore($deepCopy($nth(1)));
    });
    expectUnique(editor);
    expectAllIndexed(editor);
    editor.read(() => {
      expect($getBlockById('my-list')!.getKey()).toBe(originalKey);
    });
  });

  test('setEditorState of a list whose items repeat an id', () => {
    using editor = build();
    seed(editor, ['one']);
    const json = editor.getEditorState().toJSON();
    const item = (text: string) => ({
      $: {blockId: 'X'},
      children: [
        {
          detail: 0,
          format: 0,
          mode: 'normal',
          style: '',
          text,
          type: 'text',
          version: 1,
        },
      ],
      direction: null,
      format: '',
      indent: 0,
      type: 'listitem',
      value: 1,
      version: 1,
    });
    json.root.children.push({
      $: {blockId: 'L'},
      children: [item('a'), item('b')],
      direction: null,
      format: '',
      indent: 0,
      listType: 'bullet',
      start: 1,
      tag: 'ul',
      type: 'list',
      version: 1,
    } as unknown as SerializedLexicalNode);
    editor.setEditorState(editor.parseEditorState(json));
    expectAllIndexed(editor);
    editor.read(() => {
      expect($getBlockById('L')!.getType()).toBe('list');
      expect($getBlockById('X')!.getTextContent()).toBe('a');
    });
  });
});

describe('BlockIdExtension: ids left on blocks that are not identified', () => {
  /** A root table moved into a cell of another table is not identified. */
  function nestTable(editor: LexicalEditor): string {
    update(editor, () => {
      $getRoot().append(
        $createTableNodeWithDimensions(1, 1, false),
        $paragraph('mid'),
        $createTableNodeWithDimensions(1, 1, false),
      );
    });
    const id = editor.read(() => $getBlockId($nth(2)))!;
    update(editor, () => {
      const row = $assertNodeType(
        $nth(0).getFirstChildOrThrow(),
        $isElementNode,
      );
      const cell = $assertNodeType(
        row.getFirstChildOrThrow(),
        $isTableCellNode,
      );
      cell.append($nth(2));
    });
    return id;
  }

  function $nestedTable(): ElementNode {
    const row = $assertNodeType($nth(0).getFirstChildOrThrow(), $isElementNode);
    const cell = $assertNodeType(row.getFirstChildOrThrow(), $isTableCellNode);
    return $assertNodeType(cell.getLastChildOrThrow(), $isElementNode);
  }

  test('the id stays in NodeState but is not indexed, and comes back with the block', () => {
    using editor = build();
    const id = nestTable(editor);
    editor.read(() => {
      expect($getBlockId($nestedTable())).toBe(id);
      expect($getBlockById(id)).toBeNull();
    });
    update(editor, () => {
      $getRoot().append($nestedTable());
    });
    expect(ids(editor)[2]).toBe(id);
    expectAllIndexed(editor);
  });

  test('a block that took the id meanwhile keeps it, wherever the original returns', () => {
    for (const where of ['above', 'below'] as const) {
      using editor = build();
      const id = nestTable(editor);
      // A copy of the nested table at the root: nothing identified holds
      // the id, so the copy keeps it.
      update(editor, () => {
        $nth(1).insertAfter($deepCopy($nestedTable()));
      });
      const copyKey = editor.read(() => $nth(2).getKey());
      expect(ids(editor)[2]).toBe(id);
      update(editor, () => {
        const original = $nestedTable();
        if (where === 'above') {
          $nth(0).insertBefore(original);
        } else {
          $getRoot().append(original);
        }
      });
      expectUnique(editor);
      expectAllIndexed(editor);
      editor.read(() => {
        expect($getBlockById(id)!.getKey(), where).toBe(copyKey);
      });
    }
  });
});

describe('BlockIdExtension: copies of lists that merge', () => {
  test('pasting copies, one of them right above the original: the merged list keeps the id', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $paragraph('p'),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('a')),
        ),
      );
    });
    const [listId, itemId] = editor.read(() => [
      $getBlockId($nth(1))!,
      $getBlockId($nth(1).getFirstChildOrThrow())!,
    ]);
    update(editor, () => {
      const list = $nth(1);
      $nth(0).insertBefore($deepCopy(list));
      // ListNode merges the original into this adjacent copy.
      list.insertBefore($deepCopy(list));
    });
    expectUnique(editor);
    expectAllIndexed(editor);
    editor.read(() => {
      const holder = $getBlockById(listId);
      assert($isElementNode(holder));
      // The list that holds the original item keeps the list's id.
      expect(
        holder.getChildren().some(item => $getBlockId(item) === itemId),
      ).toBe(true);
    });
  });

  test('copies on both sides of the original, merged over several transform passes: the merged list keeps the id', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $paragraph('p'),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('a')),
        ),
      );
    });
    const [listId, itemId] = editor.read(() => [
      $getBlockId($nth(1))!,
      $getBlockId($nth(1).getFirstChildOrThrow())!,
    ]);
    update(editor, () => {
      const list = $nth(1);
      list.insertBefore($deepCopy(list));
      list.insertBefore($deepCopy(list));
      list.insertAfter($deepCopy(list));
    });
    // ListNode merges the four lists one pair per transform pass. The copies
    // yield the id to the original in the first pass; once the original is
    // merged into the first copy, that copy continues it.
    expect(ids(editor)).toEqual(['b1', listId]);
    expectUnique(editor);
    expectAllIndexed(editor);
    editor.read(() => {
      const items = $nth(1).getChildren().map($getBlockId);
      expect(items).toContain(itemId);
    });
  });
});

describe('BlockIdExtension: a copy of a list pasted above another list', () => {
  test('the list it merges into keeps its id', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('l')),
        ),
        $paragraph('sep'),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('m')),
        ),
      );
    });
    const [copiedId, copiedItemId, listId, itemId] = editor.read(() => [
      $getBlockId($nth(0))!,
      $getBlockId($nth(0).getFirstChildOrThrow())!,
      $getBlockId($nth(2))!,
      $getBlockId($nth(2).getFirstChildOrThrow())!,
    ]);
    update(editor, () => {
      // ListNode merges the list below into the copy, which yields the
      // copied ids: the merged list continues the list below, as a new list
      // without an id does.
      $nth(2).insertBefore($deepCopy($nth(0)));
    });
    expectUnique(editor);
    expectAllIndexed(editor);
    editor.read(() => {
      expect($getBlockId($nth(0))).toBe(copiedId);
      expect($getBlockId($nth(0).getFirstChildOrThrow())).toBe(copiedItemId);
      const merged = $nth(2);
      expect($getBlockId(merged)).toBe(listId);
      const [copiedItem, item] = merged.getChildren().map($getBlockId);
      expect(copiedItem).not.toBe(copiedItemId);
      expect(copiedItem).not.toBeNull();
      expect(item).toBe(itemId);
    });
  });
});

describe('BlockIdExtension: more predicates and nesting', () => {
  class InlineDecorator extends DecoratorNode<null> {
    $config() {
      return this.config('block-id-inline-decorator', {extends: DecoratorNode});
    }
    isInline(): boolean {
      return true;
    }
    createDOM(): HTMLElement {
      return document.createElement('span');
    }
    updateDOM(): false {
      return false;
    }
    decorate(): null {
      return null;
    }
  }

  class BlockDecorator extends DecoratorNode<null> {
    $config() {
      return this.config('block-id-block-decorator', {extends: DecoratorNode});
    }
    isInline(): boolean {
      return false;
    }
    createDOM(): HTMLElement {
      return document.createElement('div');
    }
    updateDOM(): false {
      return false;
    }
    decorate(): null {
      return null;
    }
  }

  function buildWith(
    $isIdentifiedBlock?: (node: LexicalNode) => boolean,
  ): LexicalEditorWithDispose {
    return asEdited(
      buildEditorFromExtensions({
        $initialEditorState: null,
        dependencies: [
          RichTextExtension,
          ListExtension,
          TableExtension,
          configExtension(BlockIdExtension, {
            generateId: counter(),
            ...($isIdentifiedBlock ? {$isIdentifiedBlock} : {}),
          }),
        ],
        name: '[block-id-predicates]',
        nodes: [InlineDecorator, BlockDecorator],
      }),
    );
  }

  test('nested inline decorators get no id; a block decorator in a cell does', () => {
    using editor = buildWith();
    update(editor, () => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('a'),
          $create(InlineDecorator),
        ),
        $createListNode('bullet').append(
          $createListItemNode().append(
            $createTextNode('i'),
            $create(InlineDecorator),
          ),
        ),
        $createTableNode().append(
          $createTableRowNode().append(
            $createTableCellNode().append($create(BlockDecorator)),
          ),
        ),
      );
    });
    expect(outline(editor).map(line => line.replace(/:b\d+$/, ':id'))).toEqual([
      'paragraph:id',
      '  block-id-inline-decorator',
      'list:id',
      '  listitem:id',
      '    block-id-inline-decorator',
      'table:id',
      '  tablerow',
      '    tablecell',
      '      block-id-block-decorator:id',
    ]);
    expectAllIndexed(editor);
  });

  test('a custom predicate that is not composed from the default: headings at any depth', () => {
    using editor = buildWith(node => $isHeadingNode(node));
    update(editor, () => {
      $getRoot().append(
        $paragraph('p'),
        $createHeadingNode('h1').append($createTextNode('h')),
        $createTableNode().append(
          $createTableRowNode().append(
            $createTableCellNode().append(
              $createHeadingNode('h2').append($createTextNode('nested')),
            ),
          ),
        ),
      );
    });
    expect(outline(editor)).toEqual([
      'paragraph',
      'heading:b1',
      'table',
      '  tablerow',
      '    tablecell',
      '      heading:b2',
    ]);
    editor.read(() => {
      expect($getBlockById('b2')!.getTextContent()).toBe('nested');
    });
  });

  test.each([['copy'], ['cut']] as const)(
    '%s and paste of nested list items through the Lexical clipboard',
    mode => {
      using editor = buildWith();
      update(editor, () => {
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('one')),
            $createListItemNode().append($createTextNode('two')),
          ),
          $createParagraphNode(),
        );
      });
      const itemIds = () =>
        editor.read(() =>
          $getRoot()
            .getChildren()
            .flatMap(block =>
              $isElementNode(block) && block.getType() === 'list'
                ? block
                    .getChildren()
                    .map(
                      item => `${item.getTextContent()}:${$getBlockId(item)}`,
                    )
                : [],
            ),
        );
      const before = itemIds();
      let copied: ReturnType<typeof $generateJSONFromSelectedNodes> | null =
        null;
      update(editor, () => {
        const list = $nth(0);
        const first = $assertNodeType(
          list.getFirstChildOrThrow(),
          $isElementNode,
        );
        const last = $assertNodeType(
          list.getLastChildOrThrow(),
          $isElementNode,
        );
        const selection = first.select(0, 0);
        selection.focus.set(last.getKey(), last.getChildrenSize(), 'element');
        copied = $generateJSONFromSelectedNodes(editor, $getSelection());
        if (mode === 'cut') {
          list.remove();
        }
      });
      update(editor, () => {
        $getRoot().getLastChildOrThrow().selectEnd();
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        $insertGeneratedNodes(
          editor,
          $generateNodesFromSerializedNodes(copied!.nodes),
          selection,
        );
      });
      const after = itemIds();
      const all = after.map(entry => entry.split(':')[1]);
      expect(new Set(all).size).toBe(all.length);
      if (mode === 'copy') {
        // The originals keep their ids; the copies get new ones.
        expect(after.slice(0, 2)).toEqual(before);
        expect(after).toHaveLength(4);
      } else {
        expect(after).toEqual(before);
      }
      expectAllIndexed(editor);
    },
  );
});
