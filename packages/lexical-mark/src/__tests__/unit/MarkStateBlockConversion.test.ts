/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// Converting or normalizing blocks keeps the ids of every character: no text
// is inserted or deleted, so the document read as a sequence of (character,
// ids) pairs is the same before and after, whichever block types are
// involved, wherever the comments are and wherever the selection is.
//
// Every source block (paragraph, heading, quote, code with and without
// highlighting, an item of each list type, nested or not) is converted to
// every target (the same blocks, and no list), with text that holds a link
// or not, comments on part of it, inside the link, overlapping or on all of
// it, next to neighbouring blocks that a list conversion merges with (with
// text that lines up with the converted text, and marked text sharing its
// ids), and with the caret or a range at several places. Each case also
// checks that the conversion happened, and, with the caret, that text typed
// in the same update as the conversion changes the ids of no other
// character. Highlighted code only has to keep every id: a highlighting
// token gets every id its text had. Pasted blocks are converted the same
// way.

import {
  $generateJSONFromSelectedNodes,
  $generateNodesFromSerializedNodes,
  $insertGeneratedNodes,
} from '@lexical/clipboard';
import {$createCodeNode, CodeExtension} from '@lexical/code-core';
import {CodePrismExtension} from '@lexical/code-prism';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  $isListItemNode,
  $isListNode,
  $removeList,
  ListExtension,
  type ListType,
} from '@lexical/list';
import {$addMarkID, $getNodeMarkIDs, MarkStateExtension} from '@lexical/mark';
import {
  $createHeadingNode,
  $createQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKeyOrThrow,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

const SOURCES = [
  'paragraph',
  'heading',
  'quote',
  'code',
  'highlighted-code',
  'bullet',
  'number',
  'check',
  'nested-bullet',
  'nested-number',
] as const;
type Source = (typeof SOURCES)[number];

const TARGETS = [
  'paragraph',
  'heading',
  'quote',
  'code',
  'highlighted-code',
  'bullet',
  'number',
  'check',
  'no-list',
] as const;
type Target = (typeof TARGETS)[number];

/** The converted text; `beta` is a link in the `link` content */
const TEXT = 'alpha beta gamma ';

const CONTENTS = ['plain', 'link'] as const;
type Content = (typeof CONTENTS)[number];

/** Comments as [id, start, end) offsets in TEXT */
const MARKS: Record<string, [string, number, number][]> = {
  all: [['c1', 0, TEXT.length]],
  overlapping: [
    ['c1', 3, 8],
    ['c2', 7, 14],
  ],
  part: [['c1', 6, 10]],
  partial: [['c1', 7, 9]],
};

/**
 * - `alone`: nothing else in the document.
 * - `lined-up`: a list before it, of the target's type, whose only item is
 *   `gamma ` (the end of the converted text): a list conversion merges with
 *   it.
 * - `marked-before`: that list's item is `old gamma ` with `c4`, and the
 *   last character of the converted text has `c4` too.
 * - `marked-after`: a list of the target's type after it, with `c5` on its
 *   text, and `c5` on the first character of the converted text.
 */
const CONTEXTS = [
  'alone',
  'lined-up',
  'marked-before',
  'marked-after',
] as const;
type Context = (typeof CONTEXTS)[number];

/** Collapsed selections at offsets in TEXT, a range over it, and a range from it into the neighbour */
const SELECTIONS = ['0', '8', '16', '17', 'range', 'across'] as const;
type SelectionAt = (typeof SELECTIONS)[number];

function buildEditor(highlighting = false): LexicalEditor {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        ListExtension,
        LinkExtension,
        highlighting ? CodePrismExtension : CodeExtension,
        MarkStateExtension,
      ],
      name: 'block-conversion',
      onError: (e: Error) => {
        throw e;
      },
    }),
  );
}

/** The document as `character:ids` for every character, in order */
function $sequence(node: LexicalNode = $getRoot()): string[] {
  if ($isTextNode(node)) {
    const ids = $getNodeMarkIDs(node).join(',');
    return Array.from(node.getTextContent(), c => `${c}:${ids}`);
  }
  return $isElementNode(node)
    ? node.getChildren().flatMap(n => $sequence(n))
    : [];
}

function isCodeSource(source: Source): boolean {
  return source === 'code' || source === 'highlighted-code';
}

function listTypeOf(target: Target): ListType {
  return target === 'number' || target === 'check' ? target : 'bullet';
}

function $content(content: Content): LexicalNode[] {
  return content === 'link'
    ? [
        $createTextNode('alpha '),
        $createLinkNode('https://example.org').append($createTextNode('beta')),
        $createTextNode(' gamma '),
      ]
    : [$createTextNode(TEXT)];
}

/**
 * Append the source block to the root, holding `children`, and return the
 * block that holds them.
 */
function $appendSource(source: Source, children: LexicalNode[]): ElementNode {
  const root = $getRoot();
  switch (source) {
    case 'paragraph':
    case 'heading':
    case 'quote':
    case 'code':
    case 'highlighted-code': {
      const block =
        source === 'paragraph'
          ? $createParagraphNode()
          : source === 'heading'
            ? $createHeadingNode('h1')
            : source === 'quote'
              ? $createQuoteNode()
              : $createCodeNode();
      root.append(block.append(...children));
      return block;
    }
    case 'bullet':
    case 'number':
    case 'check': {
      const item = $createListItemNode().append(...children);
      root.append($createListNode(source).append(item));
      return item;
    }
    case 'nested-bullet':
    case 'nested-number': {
      const type = source === 'nested-bullet' ? 'bullet' : 'number';
      const item = $createListItemNode().append(...children);
      root.append(
        $createListNode(type).append(
          $createListItemNode().append($createTextNode('outer')),
          $createListItemNode().append($createListNode(type).append(item)),
        ),
      );
      return item;
    }
  }
}

/** The TextNode and offset at `offset` in the text of `block` */
function $locate(block: ElementNode, offset: number): [TextNode, number] {
  let remaining = offset;
  const texts = block.getAllTextNodes();
  for (const text of texts) {
    const size = text.getTextContentSize();
    if (remaining < size) {
      return [text, remaining];
    }
    remaining -= size;
  }
  const last = texts[texts.length - 1];
  return [last, last.getTextContentSize()];
}

function $select(
  [anchorBlock, anchorOffset]: [ElementNode, number],
  [focusBlock, focusOffset]: [ElementNode, number],
) {
  const selection = $createRangeSelection();
  const [anchorNode, anchorAt] = $locate(anchorBlock, anchorOffset);
  const [focusNode, focusAt] = $locate(focusBlock, focusOffset);
  selection.anchor.set(anchorNode.getKey(), anchorAt, 'text');
  selection.focus.set(focusNode.getKey(), focusAt, 'text');
  $setSelection(selection);
  return selection;
}

function $mark(block: ElementNode, id: string, start: number, end: number) {
  $addMarkID(id, $select([block, start], [block, end]));
}

function $convert(target: Target) {
  switch (target) {
    case 'paragraph':
      $setBlocksType($getSelection(), () => $createParagraphNode());
      break;
    case 'heading':
      $setBlocksType($getSelection(), () => $createHeadingNode('h2'));
      break;
    case 'quote':
      $setBlocksType($getSelection(), () => $createQuoteNode());
      break;
    case 'code':
    case 'highlighted-code':
      $setBlocksType($getSelection(), () => $createCodeNode());
      break;
    case 'bullet':
    case 'number':
    case 'check':
      $insertList(target);
      break;
    case 'no-list':
      $removeList();
      break;
  }
}

/** The nearest block of `node`, or `node` itself */
function $getBlockOf(node: LexicalNode): ElementNode {
  let current: LexicalNode = node;
  while (!($isElementNode(current) && !current.isInline())) {
    current = current.getParentOrThrow();
  }
  return current;
}

/** The type of a block, with the list type for a list item */
function $label(block: ElementNode): string {
  const parent = block.getParent();
  return $isListItemNode(block) && $isListNode(parent)
    ? `listitem:${parent.getListType()}`
    : block.getType();
}

/**
 * The label of the block that holds the converted text after `target`, for
 * text in a block labeled `from`
 */
function expectedLabel(from: string, target: Target): string {
  switch (target) {
    case 'bullet':
    case 'number':
    case 'check':
      return `listitem:${target}`;
    case 'no-list':
      return from.startsWith('listitem:') ? 'paragraph' : from;
    case 'highlighted-code':
      return 'code';
    default:
      return target;
  }
}

/** The block whose own text is `text`, or includes it with `partial` */
function $findTextBlock(text: string, partial = false): null | ElementNode {
  const texts = new Map<NodeKey, [ElementNode, string]>();
  for (const node of $getRoot().getAllTextNodes()) {
    const block = $getBlockOf(node);
    const entry = texts.get(block.getKey());
    texts.set(block.getKey(), [
      block,
      (entry ? entry[1] : '') + node.getTextContent(),
    ]);
  }
  for (const [block, content] of texts.values()) {
    if (partial ? content.includes(text) : content === text) {
      return block;
    }
  }
  return null;
}

function $type() {
  const selection = $getSelection();
  assert($isRangeSelection(selection) && selection.isCollapsed());
  selection.insertText('X');
}

interface Case {
  content: Content;
  context: Context;
  marks: string;
  selection: SelectionAt;
  /** Type `X` at the caret in the update that converts */
  typed: boolean;
}

function* cases(): Generator<Case> {
  for (const content of CONTENTS) {
    for (const marks of Object.keys(MARKS)) {
      for (const context of CONTEXTS) {
        for (const selection of SELECTIONS) {
          if (selection === 'across' && context === 'alone') {
            continue;
          }
          yield {content, context, marks, selection, typed: false};
          if (selection !== 'range' && selection !== 'across') {
            yield {content, context, marks, selection, typed: true};
          }
        }
      }
    }
  }
}

interface Built {
  /** Set the selection that the case converts */
  $select: () => void;
}

/**
 * Build the document for `c` in `editor`, with the converted block made by
 * `$appendBlock`. The comments are added in an update of their own, after
 * code highlighting has made its tokens.
 */
function build(
  editor: LexicalEditor,
  target: Target,
  c: Case,
  $appendBlock: () => ElementNode,
): Built {
  let blockKey!: NodeKey;
  let neighbourKey!: NodeKey;
  editor.update(
    () => {
      blockKey = neighbourKey = '';
      $buildContent();
    },
    {discrete: true},
  );
  editor.update($markContent, {discrete: true});
  function $buildContent() {
    const root = $getRoot();
    root.clear();
    const neighbour = $createListItemNode();
    if (c.context === 'lined-up' || c.context === 'marked-before') {
      neighbour.append(
        $createTextNode(c.context === 'lined-up' ? 'gamma ' : 'old gamma '),
      );
      root.append($createListNode(listTypeOf(target)).append(neighbour));
    }
    const block = $appendBlock();
    if (c.context === 'marked-after') {
      neighbour.append($createTextNode('delta'));
      root.append($createListNode(listTypeOf(target)).append(neighbour));
    }
    blockKey = block.getKey();
    neighbourKey = neighbour.getKey();
  }
  function $markContent() {
    const block = $assertNodeType(
      $getNodeByKeyOrThrow(blockKey),
      $isElementNode,
    );
    for (const [id, start, end] of MARKS[c.marks]) {
      $mark(block, id, start, end);
    }
    if (c.context === 'marked-before' || c.context === 'marked-after') {
      const neighbour = $assertNodeType(
        $getNodeByKeyOrThrow(neighbourKey),
        $isElementNode,
      );
      if (c.context === 'marked-before') {
        $mark(neighbour, 'c4', 0, 'old gamma '.length);
        $mark(block, 'c4', TEXT.length - 1, TEXT.length);
      } else {
        $mark(neighbour, 'c5', 0, 'delta'.length);
        $mark(block, 'c5', 0, 1);
      }
    }
  }
  return {
    $select: () => {
      const at = $assertNodeType(
        $getNodeByKeyOrThrow(blockKey),
        $isElementNode,
      );
      switch (c.selection) {
        case 'range':
          $select([at, 0], [at, TEXT.length]);
          break;
        case 'across': {
          const other = $assertNodeType(
            $getNodeByKeyOrThrow(neighbourKey),
            $isElementNode,
          );
          if (c.context === 'marked-after') {
            $select([at, 3], [other, 2]);
          } else {
            $select([other, 2], [at, 3]);
          }
          break;
        }
        default:
          $select([at, Number(c.selection)], [at, Number(c.selection)]);
      }
    },
  };
}

function describeCase(source: string, target: Target, c: Case): string {
  return `${source} -> ${target}, ${c.content}, marks ${c.marks}, ${c.context}, selection ${c.selection}${c.typed ? ', typed' : ''}`;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether the characters of `after` are those of `before` with the same ids.
 * A code highlighting token is not split where its ids change, and gets every
 * id its text had (see the docs), so in highlighted code each character only
 * has to keep every id it had.
 */
function keepsIDs(
  before: string[],
  after: string[],
  inHighlightedCode: boolean,
): boolean {
  if (!inHighlightedCode) {
    return same(after, before);
  }
  return (
    after.length === before.length &&
    after.every((unit, i) => {
      const [c, ids] = [
        unit.slice(0, unit.indexOf(':')),
        unit.slice(unit.indexOf(':') + 1),
      ];
      const prev = before[i];
      const prevIDs = prev.slice(prev.indexOf(':') + 1);
      return (
        c === prev.slice(0, prev.indexOf(':')) &&
        (prevIDs === '' ||
          prevIDs.split(',').every(id => ids.split(',').includes(id)))
      );
    })
  );
}

describe('MarkStateExtension: converting blocks keeps the ids of every character', () => {
  describe.each(SOURCES)('from %s', source => {
    test.each(TARGETS)('to %s', target => {
      const highlighting =
        source === 'highlighted-code' || target === 'highlighted-code';
      const editor = buildEditor(highlighting);
      const failures: string[] = [];
      const run = (c: Case) => {
        const built = build(editor, target, c, () =>
          $appendSource(source, $content(c.content)),
        );
        const before = editor.read(() => $sequence());
        const from = editor.read(() =>
          $label($findTextBlock(TEXT) || $getRoot()),
        );
        editor.update(
          () => {
            built.$select();
            $convert(target);
            if (c.typed) {
              $type();
            }
          },
          {discrete: true},
        );
        return editor.read(() => {
          const block = $findTextBlock('alpha', true);
          return {
            after: $sequence(),
            before,
            from,
            label: block !== null ? $label(block) : 'missing',
          };
        });
      };
      for (const c of cases()) {
        if (isCodeSource(source) && c.content === 'link') {
          continue;
        }
        if (
          highlighting &&
          (c.context === 'marked-before' || c.context === 'marked-after') &&
          (isCodeSource(source) || c.selection === 'across')
        ) {
          // Comment ids on part of a code highlighting token, and text that a
          // range conversion merges into a code block, are re-tokenized
          // without them (#9491)
          continue;
        }
        if (c.typed && highlighting && c.content === 'link') {
          // Highlighting that unwraps the link puts the caret back at a wrong
          // offset (counted from the start of the code), so the typed text
          // is not right before the caret, as the inserted-text rule needs
          continue;
        }
        const {before, after, from, label} = run(c);
        const problems: string[] = [];
        if (label !== expectedLabel(from, target)) {
          problems.push(`  converted ${from} to ${label}`);
        }
        // The typed text gets the ids of the inserted-text rule where it can
        // compare the changed blocks with the previous state, and otherwise
        // those of the TextNode it lands in, so only the other characters are
        // checked
        const kept = c.typed
          ? after.filter(unit => !unit.startsWith('X:'))
          : after;
        if (c.typed && kept.length !== after.length - 1) {
          problems.push('  X was not typed once');
        }
        if (
          !keepsIDs(
            before,
            kept,
            highlighting && expectedLabel(from, target) === 'code',
          )
        ) {
          problems.push(`  before ${before.join(' ')}`);
        }
        if (problems.length > 0) {
          failures.push(
            [
              `${describeCase(source, target, c)}:`,
              ...problems,
              `  after  ${after.join(' ')}`,
            ].join('\n'),
          );
        }
      }
      expect(failures).toEqual([]);
    });
  });

  // The source block is copied with its comments, pasted into an empty
  // document, and the pasted blocks are converted: the pasted text keeps its
  // ids through both
  describe.each(SOURCES)('pasted %s', source => {
    test.each(TARGETS)('to %s', target => {
      const highlighting =
        source === 'highlighted-code' || target === 'highlighted-code';
      const from = buildEditor(highlighting);
      const failures: string[] = [];
      for (const c of cases()) {
        if (
          c.context !== 'alone' ||
          c.typed ||
          (isCodeSource(source) && c.content === 'link')
        ) {
          continue;
        }
        // A fresh editor: pasting into the document of the previous case in
        // the update that clears it would compare the pasted text with that
        // document's equal text
        const editor = buildEditor(highlighting);
        let json!: ReturnType<typeof $generateJSONFromSelectedNodes>;
        build(from, target, c, () =>
          $appendSource(source, $content(c.content)),
        );
        from.update(
          () => {
            const root = $getRoot();
            json = $generateJSONFromSelectedNodes(
              from,
              root.select(0, root.getChildrenSize()),
            );
          },
          {discrete: true},
        );
        const copied = from.read(() => $sequence());
        editor.update(
          () => {
            const paragraph = $createParagraphNode();
            $getRoot().append(paragraph);
            $insertGeneratedNodes(
              editor,
              $generateNodesFromSerializedNodes(json.nodes),
              paragraph.select(0, 0),
            );
          },
          {discrete: true},
        );
        const pasted = editor.read(() => $sequence());
        const pastedLabel = editor.read(() => {
          const block = $findTextBlock(TEXT);
          return block !== null ? $label(block) : 'missing';
        });
        editor.update(
          () => {
            const block = $findTextBlock(TEXT);
            assert(block !== null, 'the pasted text is in one block');
            if (c.selection === 'range') {
              $select([block, 0], [block, TEXT.length]);
            } else {
              const offset = Number(c.selection);
              $select([block, offset], [block, offset]);
            }
            $convert(target);
          },
          {discrete: true},
        );
        const after = editor.read(() => $sequence());
        const label = editor.read(() => {
          const block = $findTextBlock(TEXT);
          return block !== null ? $label(block) : 'missing';
        });
        if (
          !same(pasted, copied) ||
          !keepsIDs(
            copied,
            after,
            highlighting && expectedLabel(pastedLabel, target) === 'code',
          ) ||
          label !== expectedLabel(pastedLabel, target)
        ) {
          failures.push(
            `${describeCase(source, target, c)}:\n  copied ${copied.join(' ')}\n  pasted ${pasted.join(' ')}\n  after  ${after.join(' ')}, converted to ${label}`,
          );
        }
      }
      expect(failures).toEqual([]);
    });
  });

  describe('reported cases', () => {
    // #9490: the converted paragraph merges into the list above it, whose
    // item's text lines up with the end of the paragraph's text
    test('a paragraph turned into a list item keeps the comment on a link', () => {
      const editor = buildEditor();
      editor.update(
        () => {
          const commented = $createTextNode('abcd');
          $getRoot().append(
            $createListNode('number').append(
              $createListItemNode().append($createTextNode('echo ')),
            ),
            $createParagraphNode().append(
              $createLinkNode('https://example.org').append(commented),
              $createTextNode(' Z echo '),
            ),
          );
          $addMarkID('c0', commented.select(0, 4));
        },
        {discrete: true},
      );
      const before = editor.read(() => $sequence());
      editor.update(
        () => {
          $assertNodeType($getRoot().getLastChild(), $isElementNode)
            .getAllTextNodes()
            .at(-1)!
            .select(4, 4);
          $insertList('number');
        },
        {discrete: true},
      );
      expect(editor.read(() => $getRoot().getChildrenSize())).toBe(1);
      expect(editor.read(() => $sequence())).toEqual(before);
    });

    // #9490: the text of the paragraph lines up with the marked item above
    test('a paragraph turned into a list item does not take the comment of the item above', () => {
      const editor = buildEditor();
      editor.update(
        () => {
          const item = $createTextNode('old echo ');
          const space = $createTextNode(' ');
          $getRoot().append(
            $createListNode('bullet').append(
              $createListItemNode().append(item),
            ),
            $createParagraphNode().append($createTextNode('new echo'), space),
          );
          $addMarkID('c1', item.select(0, item.getTextContentSize()));
          $addMarkID('c1', space.select(0, 1));
        },
        {discrete: true},
      );
      const before = editor.read(() => $sequence());
      editor.update(
        () => {
          $assertNodeType($getRoot().getLastChild(), $isElementNode)
            .getAllTextNodes()[0]
            .selectEnd();
          $insertList('bullet');
        },
        {discrete: true},
      );
      expect(editor.read(() => $sequence())).toEqual(before);
    });

    // Code highlighting turns its tokens back into TextNodes when the code
    // block becomes a paragraph; with the code selected, the inserted-text
    // rule does not run, so the new TextNodes keep the ids on their own
    test('a comment on code text survives turning the code block into a paragraph', () => {
      const editor = buildEditor(true);
      editor.update(
        () => {
          $getRoot().append($createCodeNode().append($createTextNode(TEXT)));
        },
        {discrete: true},
      );
      editor.update(
        () => {
          const code = $assertNodeType(
            $getRoot().getFirstChild(),
            $isElementNode,
          );
          $mark(code, 'c1', 0, TEXT.length);
          $select([code, 0], [code, TEXT.length]);
        },
        {discrete: true},
      );
      const before = editor.read(() => $sequence());
      editor.update(() => $convert('paragraph'), {discrete: true});
      expect(
        editor.read(() => [
          $getRoot().getFirstChildOrThrow().getType(),
          ...$sequence(),
        ]),
      ).toEqual(['paragraph', ...before]);
      expect(before[0]).toBe('a:c1');
    });

    // A lone list item turned into another block with the caret at its end
    test.each(['paragraph', 'heading', 'quote'] as const)(
      'a list item turned into a %s keeps its comment',
      target => {
        const editor = buildEditor();
        editor.update(
          () => {
            const text = $createTextNode('alpha beta');
            $getRoot().append(
              $createListNode('bullet').append(
                $createListItemNode().append(text),
              ),
            );
            $addMarkID('c1', text.select(6, 10));
          },
          {discrete: true},
        );
        editor.update(
          () => {
            $getRoot().getAllTextNodes().at(-1)!.selectEnd();
            $convert(target);
          },
          {discrete: true},
        );
        expect(
          editor.read(() => [
            $getRoot().getFirstChildOrThrow().getType(),
            ...$getRoot()
              .getAllTextNodes()
              .map(text => `${text.getTextContent()}:${$getNodeMarkIDs(text)}`),
          ]),
        ).toEqual([target, 'alpha :', 'beta:c1']);
      },
    );
  });

  describe('moved text', () => {
    // A node that code moves is not inserted text, unlike a new node
    test('a node moved into a marked run keeps its ids, a new node joins the run', () => {
      const editor = buildEditor();
      editor.update(
        () => {
          const a = $createTextNode('aaa');
          const b = $createTextNode('bbb').toggleFormat('italic');
          $getRoot().append(
            $createParagraphNode().append(a, b),
            $createParagraphNode().append(
              $createTextNode('moved').toggleFormat('bold'),
            ),
          );
          $addMarkID('c1', a.select(0, 3));
          $addMarkID('c1', b.select(0, 3));
        },
        {discrete: true},
      );
      const marks = () =>
        editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(text => `${text.getTextContent()}:${$getNodeMarkIDs(text)}`),
        );
      editor.update(
        () => {
          const created = $createTextNode('new').toggleFormat('underline');
          $getRoot().getAllTextNodes()[0].insertAfter(created);
          created.selectEnd();
        },
        {discrete: true},
      );
      expect(marks()).toEqual(['aaa:c1', 'new:c1', 'bbb:c1', 'moved:']);
      editor.update(
        () => {
          const [, created, , moved] = $getRoot().getAllTextNodes();
          created.insertAfter(moved);
          moved.selectEnd();
        },
        {discrete: true},
      );
      expect(marks()).toEqual(['aaa:c1', 'new:c1', 'moved:', 'bbb:c1']);
    });
    test('a node moved into the text that replaces a selection: the new text keeps the replaced ids', () => {
      const editor = buildEditor();
      editor.update(
        () => {
          const replaced = $createTextNode('zzz');
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('keep').toggleFormat('bold'),
            ),
            $createParagraphNode().append(replaced),
          );
          $addMarkID('c1', replaced.select(0, 3));
          replaced.select(0, 3);
        },
        {discrete: true},
      );
      editor.update(
        () => {
          editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, 'Q');
          const [moved, inserted] = $getRoot().getAllTextNodes();
          inserted.insertBefore(moved);
          inserted.selectEnd();
        },
        {discrete: true},
      );
      expect(
        editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(text => `${text.getTextContent()}:${$getNodeMarkIDs(text)}`),
        ),
      ).toEqual(['keep:', 'Q:c1']);
    });

    test('a selection replaced in the update that turns its list item into a paragraph', () => {
      const editor = buildEditor();
      editor.update(
        () => {
          const a = $createTextNode('abc');
          const b = $createTextNode('def').toggleFormat('bold');
          $getRoot().append(
            $createListNode('bullet').append(
              $createListItemNode().append(a, b),
            ),
          );
          $addMarkID('c1', a.select(0, 3));
          $addMarkID('c1', b.select(0, 3));
          a.selectEnd();
        },
        {discrete: true},
      );
      editor.update(
        () => {
          $convert('paragraph');
          const [a, b] = $getRoot().getAllTextNodes();
          const selection = $createRangeSelection();
          selection.anchor.set(a.getKey(), 1, 'text');
          selection.focus.set(b.getKey(), 2, 'text');
          $setSelection(selection);
          editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, 'Q');
        },
        {discrete: true},
      );
      expect(editor.read(() => $sequence())).toEqual(['a:c1', 'Q:c1', 'f:c1']);
    });
  });
});
