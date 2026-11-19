/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Property test of BlockIdExtension over random local edit sequences: typing,
// Enter, Backspace and forward-delete joins, range deletes, block type
// changes, moves, duplicates, pastes of several copies, indent and outdent,
// list conversion, moves into table cells, replace, undo and redo, and reloads
// of the state with an injected duplicate id. After every step each
// identified block must have exactly one id, the ids must be unique,
// $getBlockById must find every identified block, blocks that existed before
// the step must keep their ids (where the step does not restructure them),
// and undo and redo must return to a state seen before.
//
// CI runs a few seeds; set BLOCK_ID_PROPERTY_SEEDS (and optionally
// BLOCK_ID_PROPERTY_FIRST_SEED) to run more locally.

import {
  $getBlockById,
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  INSERT_UNORDERED_LIST_COMMAND,
  ListExtension,
} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableNodeWithDimensions,
  $isTableCellNode,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $parseSerializedNode,
  $setSelection,
  configExtension,
  DELETE_CHARACTER_COMMAND,
  type ElementNode,
  HISTORY_MERGE_TAG,
  HISTORY_PUSH_TAG,
  INDENT_CONTENT_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  OUTDENT_CONTENT_COMMAND,
  REDO_COMMAND,
  type SerializedEditorState,
  type SerializedElementNode,
  type SerializedLexicalNode,
  UNDO_COMMAND,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

const SEEDS = Number(process.env.BLOCK_ID_PROPERTY_SEEDS || 20);
const FIRST_SEED = Number(process.env.BLOCK_ID_PROPERTY_FIRST_SEED || 1);
const STEPS = 40;

function build(): LexicalEditorWithDispose {
  let clock = 0;
  let n = 0;
  const editor = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      ListExtension,
      TableExtension,
      configExtension(HistoryExtension, {
        disabled: false,
        now: () => (clock += 10000),
      }),
      configExtension(BlockIdExtension, {generateId: () => `b${++n}`}),
    ],
    name: '[block-id-property]',
  });
  // Deleting characters reads the DOM selection.
  editor.setRootElement(document.createElement('div'));
  // Have had content once, so that new blocks are edits, not a load.
  const options = {discrete: true, tag: HISTORY_MERGE_TAG} as const;
  editor.update(() => $getRoot().append($createParagraphNode()), options);
  editor.update(() => $getRoot().clear(), options);
  return editor;
}

function $p(text: string): ElementNode {
  return $createParagraphNode().append($createTextNode(text));
}

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

/** Every node below the root in document order (slots before children). */
function $all(): LexicalNode[] {
  const out: LexicalNode[] = [];
  const walk = (n: LexicalNode) => {
    out.push(n);
    for (const name of $getSlotNames(n)) {
      const slot = $getSlot(n, name);
      if (slot) {
        walk(slot);
      }
    }
    if ($isElementNode(n)) {
      n.getChildren().forEach(walk);
    }
  };
  $getRoot().getChildren().forEach(walk);
  return out;
}

interface Row {
  key: string;
  type: string;
  text: string;
  id: string | null;
  identified: boolean;
}

function rows(editor: LexicalEditor): Row[] {
  const isIdentified = getExtensionDependencyFromEditor(
    editor,
    BlockIdExtension,
  ).output.$isIdentifiedBlock;
  return editor.read(() =>
    $all()
      .filter(n => !$isTextNode(n))
      .map(n => ({
        id: $getBlockId(n),
        identified: isIdentified(n),
        key: n.getKey(),
        text: n.getTextContent(),
        type: n.getType(),
      })),
  );
}

/** `type:text:id` of the identified blocks in document order. */
function outline(editor: LexicalEditor): string[] {
  return rows(editor)
    .filter(r => r.identified)
    .map(r => `${r.type}:${r.text}:${r.id}`);
}

/** Missing ids, repeated ids, and blocks the index does not find. */
function invariantProblems(editor: LexicalEditor): string[] {
  const problems: string[] = [];
  const identified = rows(editor).filter(r => r.identified);
  const seen = new Map<string, string>();
  for (const r of identified) {
    if (r.id === null) {
      problems.push(`no id: ${r.type}:${r.text}`);
      continue;
    }
    if (seen.has(r.id)) {
      problems.push(`dup ${r.id}: ${seen.get(r.id)} / ${r.type}:${r.text}`);
    }
    seen.set(r.id, `${r.type}:${r.text}`);
  }
  editor.read(() => {
    for (const r of identified) {
      if (r.id !== null) {
        const found = $getBlockById(r.id);
        if (found === null || found.getKey() !== r.key) {
          problems.push(
            `index ${r.id} -> ${found && found.getKey()} != ${r.key}`,
          );
        }
      }
    }
  });
  return problems;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function $textBlocks(): ElementNode[] {
  return $all().filter(
    (n): n is ElementNode =>
      $isParagraphNode(n) ||
      $isHeadingNode(n) ||
      $isQuoteNode(n) ||
      $isListItemNode(n),
  );
}

function $caretIn(block: ElementNode, offset: number): void {
  let rest = offset;
  for (const text of block.getAllTextNodes()) {
    if (text.getParent() && rest <= text.getTextContentSize()) {
      text.select(rest, rest);
      return;
    }
    rest -= text.getTextContentSize();
  }
  block.selectStart();
}

const OPS = [
  'type',
  'enter',
  'enter',
  'join',
  'fwdjoin',
  'rangeDelete',
  'setType',
  'move',
  'dup',
  'pasteMany',
  'indent',
  'outdent',
  'toList',
  'intoCell',
  'replace',
  'undo',
  'redo',
  'setStateDup',
] as const;

/** Which pre-existing blocks a step must leave on their ids. */
type Kept = 'all' | 'none' | 'enter';

function $edit(
  editor: LexicalEditor,
  op: (typeof OPS)[number],
  rnd: () => number,
  step: number,
): Kept {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const blocks = $textBlocks();
  if (blocks.length === 0) {
    $getRoot().append($p('x'));
    return 'all';
  }
  const b = pick(blocks);
  const off = Math.floor(rnd() * (b.getTextContentSize() + 1));
  switch (op) {
    case 'type': {
      $caretIn(b, off);
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      selection.insertText('z');
      return 'all';
    }
    case 'enter':
      $caretIn(b, off);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
      return 'enter';
    case 'join':
      b.selectStart();
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
      return 'none';
    case 'fwdjoin':
      b.selectEnd();
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, false);
      return 'none';
    case 'rangeDelete': {
      const c = pick(blocks);
      const [x, y] = b.isBefore(c) ? [b, c] : [c, b];
      const xt = x.getAllTextNodes();
      const yt = y.getAllTextNodes();
      if (xt.length && yt.length && !x.is(y)) {
        const start = Math.min(1, xt[0].getTextContentSize());
        xt[0].select(start, start);
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        const last = yt[yt.length - 1];
        selection.focus.set(
          last.getKey(),
          Math.min(1, last.getTextContentSize()),
          'text',
        );
        selection.removeText();
      }
      return 'none';
    }
    case 'setType':
      $caretIn(b, off);
      $setBlocksType($getSelection(), () =>
        pick([
          () => $createHeadingNode('h2'),
          () => $createQuoteNode(),
          () => $createParagraphNode(),
        ])(),
      );
      return 'none';
    case 'move': {
      $setSelection(null);
      const kids = $getRoot().getChildren();
      const moved = pick(kids);
      const target = pick(kids);
      if (!moved.is(target)) {
        if (rnd() < 0.5) {
          target.insertBefore(moved);
        } else {
          target.insertAfter(moved);
        }
      }
      return 'all';
    }
    case 'dup': {
      $setSelection(null);
      const copy = $deepCopy(b);
      if (rnd() < 0.5) {
        b.insertBefore(copy);
      } else {
        b.insertAfter(copy);
      }
      return 'all';
    }
    case 'pasteMany': {
      $setSelection(null);
      const src = pick($getRoot().getChildren());
      const n = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        pick($getRoot().getChildren()).insertAfter($deepCopy(src));
      }
      return 'all';
    }
    case 'indent':
      $caretIn(b, off);
      editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
      return 'none';
    case 'outdent':
      $caretIn(b, off);
      editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
      return 'none';
    case 'toList':
      $caretIn(b, off);
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
      return 'none';
    case 'intoCell': {
      $setSelection(null);
      const cells = $all().filter($isTableCellNode);
      if (cells.length && !$isListItemNode(b)) {
        const cell = pick(cells) as ElementNode;
        if (!b.isParentOf(cell)) {
          cell.append(b);
        }
      }
      return 'all';
    }
    case 'replace':
      $setSelection(null);
      if (!$isListItemNode(b)) {
        b.replace($p(`r${step}`));
      }
      return 'none';
    default:
      throw new Error(`not an edit: ${op}`);
  }
}

/** Reloads the state with one root child's id copied onto another. */
function reloadWithDuplicate(editor: LexicalEditor, rnd: () => number): void {
  const json = editor.getEditorState().toJSON();
  const kids = json.root.children as (SerializedLexicalNode & {
    $?: {blockId?: string};
  })[];
  if (kids.length < 2) {
    return;
  }
  const i = Math.floor(rnd() * kids.length);
  let j = Math.floor(rnd() * kids.length);
  if (j === i) {
    j = (j + 1) % kids.length;
  }
  const src = kids[i].$ && kids[i].$.blockId;
  if (!src) {
    return;
  }
  kids[j].$ = {...(kids[j].$ || {}), blockId: src};
  editor.setEditorState(editor.parseEditorState(json as SerializedEditorState));
  const rootIds = editor.read(() =>
    $getRoot()
      .getChildren()
      .map(n => $getBlockId(n)),
  );
  // The earlier holder keeps the id.
  expect(rootIds[Math.min(i, j)]).toBe(src);
}

/** Pre-existing identified blocks keep their ids, as `kept` requires. */
function expectKept(before: Row[], afterRows: Row[], kept: Kept): void {
  if (kept === 'none') {
    return;
  }
  const after = new Map(afterRows.map(r => [r.key, r]));
  for (const r of before) {
    const a = after.get(r.key);
    if (!r.identified || !a || !a.identified || r.id === null) {
      continue;
    }
    if (kept === 'enter' && a.id !== r.id) {
      // Enter at the start moves the id with the text to the new block.
      const moved = afterRows.find(x => x.id === r.id);
      if (
        moved &&
        !before.some(x => x.key === moved.key) &&
        moved.text === r.text &&
        a.text === ''
      ) {
        continue;
      }
    }
    expect(a.id, `${r.type}:${r.text} keeps its id`).toBe(r.id);
  }
  if (kept === 'all') {
    // No id moves onto a different pre-existing block.
    const keyOfId = new Map(
      before.filter(r => r.identified && r.id).map(r => [r.id, r.key]),
    );
    for (const a of after.values()) {
      const k = a.identified && a.id ? keyOfId.get(a.id) : undefined;
      if (k !== undefined && after.has(k) && after.get(k)!.identified) {
        expect(a.key, `${a.id} stays on ${k}`).toBe(k);
      }
    }
  }
}

describe('BlockIdExtension: property test over random edits', () => {
  for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
    test(`seed ${seed}`, () => {
      const rnd = mulberry32(seed);
      using editor = build();
      editor.update(
        () => {
          $getRoot().append(
            $p('alpha'),
            $createHeadingNode('h1').append($createTextNode('beta')),
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('li1')),
              $createListItemNode().append($createTextNode('li2')),
            ),
            $createTableNodeWithDimensions(2, 2, false),
            $p('gamma'),
          );
        },
        {discrete: true},
      );
      // Outlines on the undo and redo stacks, and every outline seen.
      const undoStack: string[][] = [outline(editor)];
      const redoStack: string[][] = [];
      const seen = new Set<string>([outline(editor).join('|')]);
      for (let step = 0; step < STEPS; step++) {
        const before = rows(editor);
        const op = OPS[Math.floor(rnd() * OPS.length)];
        let kept: Kept = 'none';
        if (op === 'undo') {
          if (undoStack.length > 1) {
            editor.dispatchCommand(UNDO_COMMAND, undefined);
            redoStack.push(undoStack.pop()!);
            expect(seen.has(outline(editor).join('|')), `undo at ${step}`).toBe(
              true,
            );
          }
        } else if (op === 'redo') {
          if (redoStack.length > 0) {
            editor.dispatchCommand(REDO_COMMAND, undefined);
            undoStack.push(redoStack.pop()!);
            expect(seen.has(outline(editor).join('|')), `redo at ${step}`).toBe(
              true,
            );
          }
        } else if (op === 'setStateDup') {
          reloadWithDuplicate(editor, rnd);
          undoStack.length = 0;
          undoStack.push(outline(editor));
          redoStack.length = 0;
          seen.add(outline(editor).join('|'));
        } else {
          const beforeJSON = JSON.stringify(editor.getEditorState().toJSON());
          editor.update(
            () => {
              kept = $edit(editor, op, rnd, step);
            },
            {discrete: true, tag: HISTORY_PUSH_TAG},
          );
          if (JSON.stringify(editor.getEditorState().toJSON()) !== beforeJSON) {
            undoStack.push(outline(editor));
            redoStack.length = 0;
          }
          seen.add(outline(editor).join('|'));
        }
        expect(
          invariantProblems(editor),
          `seed ${seed} step ${step} ${op}`,
        ).toEqual([]);
        expectKept(before, rows(editor), kept);
      }
    });
  }
});
