/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A change that only touches formats or marks is written as format items,
// never as a delete and a re-insert of the text it touches. Resolving a
// comment whose words were followed by a space and a bold run
// ("…redanox [redanux redapax redapex](c1) **redapix…**") lets Lexical's
// normalization merge the words and the space into the text before them.
// The writer gave that merged text to the node it was merged into whenever
// the node's own old text happened to end like it ("redanox " and
// "redapex "), so the words were deleted and inserted again: two clients
// resolving at once showed them twice, a word a peer deleted meanwhile came
// back, and text a peer typed right after them moved in front (soak S3-8).
// A format given to the start of a node, or taken from it, that merges it
// into the run before (Lexical splits the node first) took the same path.
// (A MarkNode is stored as a node of its own: wrapping text in one moves the
// text, see y.md.)

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createLinkNode,
  $isLinkNode,
  $toggleLink,
  LinkNode,
} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $addMarkID,
  $getNodeMarkIDs,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
import {
  $createTableNodeWithDimensions,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $setSelection,
  configExtension,
  defineExtension,
  type ElementNode,
  type LexicalNode,
  type RangeSelection,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {ColContainerNode, ColContentNode, ColTitleNode} from '../utils/harness';

const HEAD = 'Redanax redanex redanix redanox ';
const WORDS = 'redanux redapax redapex';
const NEIGHBOUR = 'redapix redapox';
const TAIL = '.';
const WORDS_URL = 'https://words.example';
const NEIGHBOUR_URL = 'https://neighbour.example';

/** What a change sets on the words or clears from them. */
type Kind = 'comment' | 'bold' | 'italic' | 'code' | 'link';
type Format = 'bold' | 'italic' | 'code';
const isFormat = (kind: string): kind is Format =>
  kind === 'bold' || kind === 'italic' || kind === 'code';
/** How the neighbouring run is formatted. */
type Neighbour = 'bold' | 'plain' | 'link' | 'code';
type Position = 'start' | 'middle' | 'end';
type Concurrent = 'none' | 'the same change' | 'a deleted word' | 'typing';

/**
 * A run of the line: plain, bold, code, a link to another URL than the
 * change's, or with what a change sets.
 */
type Seg = {text: string; as: 'plain' | 'other link' | Kind};

function peer(id: number) {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  const errors: unknown[] = [];
  const warnings: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
        MarkStateExtension,
      ],
      name: 'format-only/' + id,
      nodes: [
        LinkNode,
        ListNode,
        ListItemNode,
        TableNode,
        TableRowNode,
        TableCellNode,
        ColContainerNode,
        ColTitleNode,
        ColContentNode,
      ],
      onError: e => {
        errors.push(e);
        throw e;
      },
      onWarn: e => {
        warnings.push(String(e && (e as Error).message));
      },
    }),
  );
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.binding;
  // The text this peer's own writes insert and delete.
  const written = {deleted: '', inserted: ''};
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (!tr.local) {
      return;
    }
    Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        written.inserted += s.content.str;
      }
    });
    Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        written.deleted += s.content.str;
      }
    });
  });
  return {
    binding,
    doc,
    editor,
    errors,
    json: () => JSON.stringify(editor.getEditorState().toJSON()),
    update(fn: () => void) {
      editor.update(fn, {discrete: true});
    },
    warnings,
    written,
  };
}
type Peer = ReturnType<typeof peer>;

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function sync(peers: Peer[]) {
  for (let round = 0; round < 2; round++) {
    for (const from of peers) {
      for (const to of peers) {
        if (from !== to) {
          Y.applyUpdate(
            to.doc,
            Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
            'net',
          );
        }
      }
    }
    await flush();
  }
}

/**
 * Where the line is: a paragraph, a list item, a table cell's paragraph, a
 * collapsible's title (an inline container), or a paragraph in an update
 * that also adds a paragraph after it (the root's structure is written).
 */
type Where =
  | 'paragraph'
  | 'list item'
  | 'table cell'
  | 'collapsible title'
  | 'paragraph, with a paragraph added';

/** The block after the title that holds the line, and the line. */
function $makeLine(where: Where): [ElementNode, ElementNode] {
  if (where === 'list item') {
    const item = $createListItemNode();
    return [$createListNode('bullet').append(item), item];
  }
  if (where === 'table cell') {
    const table = $createTableNodeWithDimensions(1, 1, false);
    return [table, $lineIn(table, where)];
  }
  if (where === 'collapsible title') {
    const title = $create(ColTitleNode);
    return [
      $create(ColContainerNode).append(
        title,
        $create(ColContentNode).append(
          $createParagraphNode().append($createTextNode('body')),
        ),
      ),
      title,
    ];
  }
  const p = $createParagraphNode();
  return [p, p];
}

function $lineIn(block: ElementNode, where: Where): ElementNode {
  if (where === 'table cell') {
    return $assertNodeType(
      $assertNodeType(
        $assertNodeType(
          block.getFirstChildOrThrow(),
          $isElementNode,
        ).getFirstChildOrThrow(),
        $isElementNode,
      ).getFirstChildOrThrow(),
      $isElementNode,
    );
  }
  return where === 'list item' || where === 'collapsible title'
    ? $assertNodeType(block.getFirstChildOrThrow(), $isElementNode)
    : block;
}

/** The line, where the current test keeps it (see run). */
let WHERE: Where = 'paragraph';
const $line = () =>
  $lineIn($getRoot().getChildAtIndex(1) as ElementNode, WHERE);

/**
 * Select [from, to) of the line's text. An edge at a boundary between text
 * nodes is in the node before it, except a non-collapsed selection's start.
 */
function $select(from: number, to: number = from): RangeSelection {
  const texts = $line().getAllTextNodes();
  const sel = $createRangeSelection();
  let acc = 0;
  let anchored = false;
  for (let i = 0; i < texts.length; i++) {
    const size = texts[i].getTextContentSize();
    const last = i === texts.length - 1;
    if (
      !anchored &&
      (from < acc + size || (from === to && from === acc + size) || last)
    ) {
      sel.anchor.set(texts[i].getKey(), from - acc, 'text');
      anchored = true;
    }
    if (anchored && (to <= acc + size || last)) {
      sel.focus.set(texts[i].getKey(), to - acc, 'text');
      break;
    }
    acc += size;
  }
  $setSelection(sel);
  return sel;
}

function $append(p: ElementNode, seg: Seg): void {
  if (seg.text === '') {
    return;
  }
  const t = $createTextNode(seg.text);
  if (isFormat(seg.as)) {
    t.toggleFormat(seg.as);
  }
  if (seg.as === 'link' || seg.as === 'other link') {
    p.append(
      $createLinkNode(seg.as === 'link' ? WORDS_URL : NEIGHBOUR_URL).append(t),
    );
  } else {
    p.append(t);
  }
  if (seg.as === 'comment') {
    const sel = $createRangeSelection();
    sel.anchor.set(t.getKey(), 0, 'text');
    sel.focus.set(t.getKey(), seg.text.length, 'text');
    $addMarkID('c1', sel);
  }
}

/** Whether a text node carries what change `kind` sets. */
function $carries(t: TextNode, kind: Kind): boolean {
  if (kind === 'comment') {
    return $getNodeMarkIDs(t).includes('c1');
  }
  if (isFormat(kind)) {
    return t.hasFormat(kind);
  }
  for (let p: LexicalNode | null = t.getParent(); p; p = p.getParent()) {
    if ($isLinkNode(p) && p.getURL() === WORDS_URL) {
      return true;
    }
  }
  return false;
}

/** The line's text, and for each character whether it carries `kind`. */
function shown(p: Peer, kind: Kind): {text: string; mask: string} {
  return p.editor.getEditorState().read(() => {
    const texts = $line().getAllTextNodes();
    return {
      mask: texts
        .map(t =>
          ($carries(t, kind) ? '1' : '0').repeat(t.getTextContentSize()),
        )
        .join(''),
      text: $line().getTextContent(),
    };
  });
}

/** Make change `kind` (`add` or `remove`) on [from, to) of the line. */
function $change(kind: Kind, add: boolean, from: number, to: number): void {
  if (kind === 'comment') {
    if (add) {
      $addMarkID('c1', $select(from, to));
    } else if (from === 0 && to < 0) {
      // Resolve: remove it everywhere.
      $removeMarkID('c1');
    } else {
      $removeMarkID('c1', $select(from, to));
    }
  } else if (isFormat(kind)) {
    // Set or clear it on every selected character.
    $select(from, to).formatText(kind, add ? null : 0);
  } else {
    $select(from, to);
    $toggleLink(add ? WORDS_URL : null);
  }
}

async function expectConverged(peers: Peer[]) {
  for (const p of peers) {
    expect(p.errors).toEqual([]);
    expect(p.warnings.filter(w => w.includes('self-check'))).toEqual([]);
    expect(p.json()).toBe(peers[0].json());
  }
  const fresh = peer(99);
  Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(peers[0].doc), 'load');
  fresh.binding.initialize();
  await flush();
  expect(fresh.json()).toBe(peers[0].json());
  expect(fresh.errors).toEqual([]);
}

type Case = {
  kind: Kind;
  add: boolean;
  segs: Seg[];
  /** The change's range in the line's text ([0, -1): everywhere). */
  from: number;
  to: number;
  /** Where the words start, and where a peer types. */
  words: number;
  typeAt: number;
  where?: Where;
};

async function run(c: Case, concurrent: Concurrent): Promise<void> {
  WHERE = c.where ?? 'paragraph';
  const a = peer(1);
  const b = peer(2);
  a.update(() => {
    const [block, line] = $makeLine(WHERE);
    $getRoot()
      .clear()
      .append($createParagraphNode().append($createTextNode('Title')), block);
    c.segs.forEach(seg => $append(line, seg));
    $setSelection(null);
  });
  a.binding.initialize();
  await flush();
  await sync([a, b]);
  b.binding.initialize();
  await flush();
  const before = shown(a, c.kind);
  expect(shown(b, c.kind)).toEqual(before);
  expect(before.mask).toBe(
    c.segs
      .map(seg => (seg.as === c.kind ? '1' : '0').repeat(seg.text.length))
      .join(''),
  );
  const [from, to] =
    c.to < 0 ? [c.words, c.words + WORDS.length] : [c.from, c.to];
  const after =
    before.mask.slice(0, from) +
    (c.add ? '1' : '0').repeat(to - from) +
    before.mask.slice(to);
  for (const p of [a, b]) {
    p.written.inserted = p.written.deleted = '';
  }
  a.update(() => {
    $setSelection(null);
    $change(c.kind, c.add, c.from, c.to);
    if (WHERE === 'paragraph, with a paragraph added') {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Added')),
      );
    }
  });
  // Format items only: no text is deleted or inserted (but the added
  // paragraph's).
  expect(a.written).toEqual({
    deleted: '',
    inserted: WHERE === 'paragraph, with a paragraph added' ? 'Added' : '',
  });
  expect(shown(a, c.kind)).toEqual({mask: after, text: before.text});
  let want = {mask: after, text: before.text};
  if (concurrent === 'the same change') {
    b.update(() => {
      $setSelection(null);
      $change(c.kind, c.add, c.from, c.to);
    });
    expect(b.written).toEqual({deleted: '', inserted: ''});
  } else if (concurrent === 'a deleted word') {
    // "redapax " goes.
    const [d0, d1] = [c.words + 8, c.words + 16];
    b.update(() => {
      $select(d0, d1).removeText();
    });
    want = {
      mask: after.slice(0, d0) + after.slice(d1),
      text: before.text.slice(0, d0) + before.text.slice(d1),
    };
  } else if (concurrent === 'typing') {
    b.update(() => {
      $select(c.typeAt).insertText('zzz ');
    });
    // (What the typed text carries depends on where it was typed.)
    want = {
      mask: '',
      text:
        before.text.slice(0, c.typeAt) + 'zzz ' + before.text.slice(c.typeAt),
    };
  }
  await sync([a, b]);
  for (const p of [a, b]) {
    const now = shown(p, c.kind);
    expect(now.text).toBe(want.text);
    if (concurrent !== 'typing') {
      expect(now.mask).toBe(want.mask);
    }
  }
  await expectConverged([a, b]);
}

/** The line, the words at `position`, `gap` between them and the neighbour. */
function wordsCase(
  kind: Kind,
  add: boolean,
  neighbour: Neighbour,
  position: Position,
  gap: string,
): Case {
  const words: Seg = {as: add ? 'plain' : kind, text: WORDS};
  const n: Seg = {
    as: neighbour === 'link' ? 'other link' : neighbour,
    text: NEIGHBOUR,
  };
  const g: Seg = {as: 'plain', text: gap};
  const head: Seg = {as: 'plain', text: HEAD};
  const tail: Seg = {as: 'plain', text: TAIL};
  const segs =
    position === 'start'
      ? [words, g, n, tail]
      : position === 'middle'
        ? [head, words, g, n, tail]
        : [head, n, g, words];
  const at =
    position === 'start'
      ? 0
      : position === 'middle'
        ? HEAD.length
        : HEAD.length + NEIGHBOUR.length + gap.length;
  const end = at + WORDS.length;
  return {
    add,
    // Resolving a comment removes it everywhere.
    from: kind === 'comment' && !add ? 0 : at,
    kind,
    segs,
    to: kind === 'comment' && !add ? -1 : end,
    // Right after the words and the gap (at the end of the line, after the
    // words).
    typeAt: position === 'end' ? end : end + gap.length,
    words: at,
  };
}

const KINDS: Kind[] = ['comment', 'bold', 'italic', 'code', 'link'];
/** The kinds every concurrent edit runs with (the others: the same change). */
const ALL_CONCURRENT: Kind[] = ['comment', 'bold', 'link'];
const NEIGHBOURS: Neighbour[] = ['bold', 'plain', 'link', 'code'];
const POSITIONS: Position[] = ['start', 'middle', 'end'];
const WHAT: Record<Kind, string> = {
  bold: 'bold',
  code: 'code',
  comment: 'a comment (MarkStateExtension)',
  italic: 'italic',
  link: 'a link',
};
const MEANWHILE: Record<Exclude<Concurrent, 'none'>, string> = {
  'a deleted word': 'deletes one of the words',
  'the same change': 'makes the same change',
  typing: 'types after them',
};

describe('a change that only touches formats or marks writes format items only', () => {
  for (const kind of KINDS) {
    for (const add of [false, true]) {
      describe(`${add ? 'add' : 'remove'} ${WHAT[kind]}`, () => {
        for (const neighbour of NEIGHBOURS) {
          for (const position of POSITIONS) {
            for (const gap of [' ', '']) {
              test(`words at the ${position} of the line, next to a ${neighbour} run${gap === '' ? ' (no space)' : ''}`, async () => {
                await run(
                  wordsCase(kind, add, neighbour, position, gap),
                  'none',
                );
              });
            }
            for (const concurrent of ALL_CONCURRENT.includes(kind)
              ? (['the same change', 'a deleted word', 'typing'] as const)
              : (['the same change'] as const)) {
              test(`words at the ${position} of the line, next to a ${neighbour} run; meanwhile a peer ${MEANWHILE[concurrent]}`, async () => {
                await run(
                  wordsCase(kind, add, neighbour, position, ' '),
                  concurrent,
                );
              });
            }
          }
        }
      });
    }
  }

  // The change covers the start of a text node only: Lexical splits it, and
  // its first part (which keeps the node's key) merges into the run before,
  // which stores the same attributes: given them (after a run that has
  // them), or with them taken (after a plain run).
  describe('the first word of a node joins the run before it', () => {
    const first = 'redanux'.length;
    for (const kind of KINDS) {
      for (const add of [false, true]) {
        // add: plain words after a run that has the change's attributes;
        // remove: words that have them after plain text.
        const segs: Seg[] = add
          ? [
              {as: 'plain', text: HEAD},
              {as: kind, text: NEIGHBOUR},
              {as: 'plain', text: WORDS},
            ]
          : [
              {as: 'plain', text: HEAD},
              {as: kind, text: WORDS},
            ];
        const at = add ? HEAD.length + NEIGHBOUR.length : HEAD.length;
        const c: Case = {
          add,
          from: at,
          kind,
          segs,
          to: at + first,
          typeAt: at + WORDS.length,
          words: at,
        };
        for (const concurrent of [
          'none',
          'the same change',
          'a deleted word',
          'typing',
        ] as const) {
          test(`${add ? 'add' : 'remove'} ${WHAT[kind]}${concurrent === 'none' ? '' : `; meanwhile a peer ${MEANWHILE[concurrent]}`}`, async () => {
            await run(c, concurrent);
          });
        }
      }
    }
  });

  // The words in the middle of the line, before a space and a bold run, in
  // other places: each is written by another path (a line on its own, a
  // container's structure, an inline container).
  describe('other places', () => {
    for (const where of [
      'list item',
      'table cell',
      'collapsible title',
      'paragraph, with a paragraph added',
    ] as const) {
      for (const kind of ['comment', 'bold'] as const) {
        for (const concurrent of [
          'none',
          'the same change',
          'a deleted word',
          'typing',
        ] as const) {
          test(`remove ${WHAT[kind]} in a ${where}${concurrent === 'none' ? '' : `; meanwhile a peer ${MEANWHILE[concurrent]}`}`, async () => {
            await run(
              {...wordsCase(kind, false, 'bold', 'middle', ' '), where},
              concurrent,
            );
          });
        }
      }
    }
  });
});

// The update also deletes a run whose text equals the run that is merged
// ("same " deleted, the next "same " unformatted, so Lexical merges it into
// the text before). Which run was merged comes from Lexical's normalization,
// never from the text: the merged run keeps its own characters, so a peer's
// concurrent edit of it stays where it was made, and an edit of the deleted
// run goes with that run.
describe('a run deleted in the same update as an equal run is merged', () => {
  type Shape = {
    segs: Seg[];
    /** The index in `segs` of the run that is merged, and of one deleted. */
    merged: number;
    deleted: number;
    /** The author's update, on the line. */
    $edit: (line: ElementNode) => void;
  };
  const head: Seg = {as: 'plain', text: 'head '};
  const $unformat = (line: ElementNode, i: number, kind: Format) => {
    const t = line.getChildAtIndex(i) as TextNode;
    t.toggleFormat(kind);
  };
  const SHAPES: Record<string, Shape> = {
    'a comment resolved after a deleted run': {
      $edit: line => {
        line.getChildAtIndex(1)!.remove();
        $removeMarkID('c1');
      },
      deleted: 1,
      merged: 2,
      segs: [head, {as: 'bold', text: 'same '}, {as: 'comment', text: 'same '}],
    },
    'the first of two runs unformatted, the second deleted': {
      $edit: line => {
        line.getChildAtIndex(2)!.remove();
        $unformat(line, 1, 'bold');
      },
      deleted: 2,
      merged: 1,
      segs: [head, {as: 'bold', text: 'same '}, {as: 'italic', text: 'same '}],
    },
    'the part of a run before a deleted run joins the text before it': {
      $edit: line => {
        const t = line.getChildAtIndex(2) as TextNode;
        const [first] = t.splitText(5);
        first.toggleFormat('italic');
        line.getChildAtIndex(1)!.remove();
      },
      deleted: 1,
      merged: 2,
      segs: [
        head,
        {as: 'bold', text: 'same '},
        {as: 'italic', text: 'same more'},
      ],
    },
    'the second of two runs unformatted, the first deleted': {
      $edit: line => {
        line.getChildAtIndex(1)!.remove();
        $unformat(line, 1, 'italic');
      },
      deleted: 1,
      merged: 2,
      segs: [head, {as: 'bold', text: 'same '}, {as: 'italic', text: 'same '}],
    },
    'the second of two runs unformatted, the first deleted, before plain text':
      {
        $edit: line => {
          line.getChildAtIndex(1)!.remove();
          $unformat(line, 1, 'italic');
        },
        deleted: 1,
        merged: 2,
        segs: [
          head,
          {as: 'bold', text: 'same '},
          {as: 'italic', text: 'same '},
          {as: 'plain', text: 'tail'},
        ],
      },
    'the third of three runs unformatted, the first two deleted': {
      $edit: line => {
        line.getChildAtIndex(1)!.remove();
        line.getChildAtIndex(1)!.remove();
        $unformat(line, 1, 'italic');
      },
      deleted: 1,
      merged: 3,
      segs: [
        head,
        {as: 'bold', text: 'same '},
        {as: 'code', text: 'same '},
        {as: 'italic', text: 'same '},
      ],
    },
  };
  type Meanwhile =
    | 'none'
    | 'merged: delete'
    | 'merged: type'
    | 'deleted: delete';
  const MEANWHILE_TEXT: Record<Meanwhile, string> = {
    'deleted: delete':
      '; meanwhile a peer deletes the start of the deleted run',
    'merged: delete': '; meanwhile a peer deletes the start of the merged run',
    'merged: type': '; meanwhile a peer types at the start of the merged run',
    none: '',
  };
  const lineText = (p: Peer) =>
    p.editor.getEditorState().read(() => $line().getTextContent());
  for (const [name, shape] of Object.entries(SHAPES)) {
    for (const meanwhile of Object.keys(MEANWHILE_TEXT) as Meanwhile[]) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`${name}${MEANWHILE_TEXT[meanwhile]} (client ids ${ids})`, async () => {
          WHERE = 'paragraph';
          const a = peer(ids[0]);
          const b = peer(ids[1]);
          a.update(() => {
            const p = $createParagraphNode();
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode('Title')),
                p,
              );
            shape.segs.forEach(seg => $append(p, seg));
            $setSelection(null);
          });
          a.binding.initialize();
          await flush();
          await sync([a, b]);
          b.binding.initialize();
          await flush();
          // Each character, and whether the edits remove it.
          const chars = shape.segs.flatMap((seg, i) =>
            [...seg.text].map(c => ({
              c,
              gone:
                i !== shape.merged &&
                (i === shape.deleted ||
                  (i > shape.deleted && i < shape.merged)),
              seg: i,
            })),
          );
          const deletedText = chars
            .filter(x => x.gone)
            .map(x => x.c)
            .join('');
          for (const p of [a, b]) {
            p.written.inserted = p.written.deleted = '';
          }
          a.update(() => {
            $setSelection(null);
            shape.$edit($line());
            $setSelection(null);
          });
          expect(lineText(a)).toBe(
            chars
              .filter(x => !x.gone)
              .map(x => x.c)
              .join(''),
          );
          // The deleted runs' text goes, and no text is inserted.
          expect(a.written).toEqual({deleted: deletedText, inserted: ''});
          if (meanwhile !== 'none') {
            const at =
              meanwhile === 'deleted: delete' ? shape.deleted : shape.merged;
            b.update(() => {
              const t = $line().getChildAtIndex(at) as TextNode;
              if (meanwhile === 'merged: type') {
                t.select(0, 0).insertText('NEW ');
              } else {
                t.select(0, 2).removeText();
              }
              $setSelection(null);
            });
            const first = chars.findIndex(x => x.seg === at);
            if (meanwhile === 'merged: type') {
              chars.splice(
                first,
                0,
                ...[...'NEW '].map(c => ({c, gone: false, seg: at})),
              );
            } else {
              chars[first].gone = chars[first + 1].gone = true;
            }
          }
          await sync([a, b]);
          const want = chars
            .filter(x => !x.gone)
            .map(x => x.c)
            .join('');
          expect(lineText(a)).toBe(want);
          expect(lineText(b)).toBe(want);
          await expectConverged([a, b]);
        });
      }
    }
  }
});
