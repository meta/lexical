/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A seeded property test of MarkStateExtension: random edit sequences on a
// few paragraphs with overlapping marks, checked after every step against a
// model of the text that tracks the ids of every character (a code point:
// typed text includes emoji). Every third seed replaces TextNode with a
// subclass through a node replacement.
//
// It runs twice: with every id in MarkStateExtension, and with the ids split
// between MarkStateExtension and a second mark flavor (CommentMarks), whose
// ids together must follow the same model: the rule is per id, so two
// flavors must not change each other's ids.
//
// MARK_STATE_PROPERTY_SEEDS and MARK_STATE_PROPERTY_STEPS run it longer
// (the defaults keep it to a couple of seconds), and MARK_STATE_PROPERTY_OPS
// limits it to a comma separated list of operations.

import {
  $generateJSONFromSelectedNodes,
  $generateNodesFromSerializedNodes,
  $insertGeneratedNodes,
} from '@lexical/clipboard';
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $addMarkID,
  $getMarkIDsAtSelection,
  $getNodeMarkIDs,
  $removeMarkID,
  type AnyMarkFlavorExtension,
  defineMarkExtension,
  MarkStateExtension,
} from '@lexical/mark';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  COMPOSITION_START_COMMAND,
  configExtension,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  FORMAT_TEXT_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  PASTE_COMMAND,
  REDO_COMMAND,
  TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

/** A character of the model and the ids it carries, sorted */
interface Char {
  c: string;
  ids: readonly string[];
}
type Model = Char[][];

const IDS = ['c1', 'c2', 'c3', 'c4', 'c5'];

const CommentMarks = defineMarkExtension({
  className: 'comment',
  name: '@test/CommentMarks',
  overlapClassName: 'comment-overlap',
  stateKey: 'commentIds',
});

/** In the two-flavor run, these ids go to CommentMarks */
const COMMENT_IDS: readonly string[] = ['c2', 'c4'];

let twoFlavors = false;

function flavorOf(id: string): AnyMarkFlavorExtension {
  return twoFlavors && COMMENT_IDS.includes(id)
    ? CommentMarks
    : MarkStateExtension;
}

/** The flavors of the current run, with their theme classes */
function flavors(): [AnyMarkFlavorExtension, string, string][] {
  return twoFlavors
    ? [
        [MarkStateExtension, 'mark', 'mark-overlap'],
        [CommentMarks, 'comment', 'comment-overlap'],
      ]
    : [[MarkStateExtension, 'mark', 'mark-overlap']];
}

/** The ids of every flavor on a node, sorted */
function $nodeIDs(node: LexicalNode): string[] {
  return union(
    ...flavors().map(([flavor]) => $getNodeMarkIDs(flavor, node)),
  ).slice();
}

const OPS = [
  'type',
  'type',
  'typeSameUpdate',
  'typeBold',
  'typeReplace',
  'typeReplace',
  'typeRemove',
  'pasteOutside',
  'ime',
  'backspace',
  'delete',
  'deleteRange',
  'enter',
  'format',
  'blockType',
  'mark',
  'unmark',
  'copyPaste',
  'cutPaste',
  'undo',
  'redo',
] as const;
type Op = (typeof OPS)[number];

function xorshift(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function union(...sets: (readonly string[])[]): readonly string[] {
  return Array.from(new Set(sets.flat())).sort();
}

function intersect(
  a: readonly string[],
  b: readonly string[],
): readonly string[] {
  return a.filter(id => b.includes(id));
}

function cloneModel(model: Model): Model {
  return model.map(block => block.slice());
}

function describeModel(model: Model): string {
  return model
    .map(block => {
      const runs: string[] = [];
      let text = '';
      let key: null | string = null;
      for (const {c, ids} of block) {
        const k = ids.join(',');
        if (k !== key && key !== null) {
          runs.push(JSON.stringify(text) + (key ? `[${key}]` : ''));
          text = '';
        }
        key = k;
        text += c;
      }
      if (key !== null) {
        runs.push(JSON.stringify(text) + (key ? `[${key}]` : ''));
      }
      return '(' + runs.join(' ') + ')';
    })
    .join(' / ');
}

function $documentModel(): Model {
  return $getRoot()
    .getChildren()
    .map(block =>
      $assertNodeType(block, $isElementNode)
        .getAllTextNodes()
        .flatMap(node => {
          const ids = $nodeIDs(node);
          return Array.from(node.getTextContent(), c => ({c, ids}));
        }),
    );
}

/**
 * A point at a character (code point) offset of a block. At a boundary
 * between two TextNodes, `preferNext` picks the start of the next one.
 */
function $point(block: number, offset: number, preferNext: boolean) {
  const element = $assertNodeType(
    $getRoot().getChildAtIndex(block),
    $isElementNode,
  );
  const texts = element.getAllTextNodes();
  if (texts.length === 0) {
    return {key: element.getKey(), offset: 0, type: 'element' as const};
  }
  let acc = 0;
  for (let i = 0; i < texts.length; i++) {
    const chars = Array.from(texts[i].getTextContent());
    const size = chars.length;
    if (
      offset < acc + size ||
      (offset === acc + size && (!preferNext || i === texts.length - 1))
    ) {
      return {
        key: texts[i].getKey(),
        offset: chars.slice(0, offset - acc).join('').length,
        type: 'text' as const,
      };
    }
    acc += size;
  }
  throw new Error(`offset ${offset} out of range in block ${block}`);
}

function $select(
  [b1, o1, p1]: [number, number, boolean],
  [b2, o2, p2]: [number, number, boolean],
  backward = false,
) {
  const selection = $createRangeSelection();
  const start = $point(b1, o1, p1);
  const end = $point(b2, o2, p2);
  const [anchor, focus] = backward ? [end, start] : [start, end];
  selection.anchor.set(anchor.key, anchor.offset, anchor.type);
  selection.focus.set(focus.key, focus.offset, focus.type);
  $setSelection(selection);
  return selection;
}

/** Insert `chars` at `offset`, as the documented rule says */
function insertChars(
  block: Char[],
  offset: number,
  chars: readonly Char[],
  replaced: readonly Char[] = [],
) {
  const before = offset > 0 ? block[offset - 1].ids : [];
  const after = offset < block.length ? block[offset].ids : [];
  let shared: readonly string[] = intersect(before, after);
  if (replaced.length > 0) {
    shared = union(
      shared,
      replaced.map(ch => ch.ids).reduce((a, b) => intersect(a, b)),
    );
  }
  block.splice(
    offset,
    0,
    ...chars.map(ch => ({c: ch.c, ids: union(ch.ids, shared)})),
  );
}

class ReplacementTextNode extends TextNode {
  $config() {
    return this.config('property-replacement-text', {extends: TextNode});
  }
}

/** A paste event with `text` as its plain text clipboard data */
function pasteEvent(text: string): ClipboardEvent {
  const event = new Event('paste', {cancelable: true}) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      items: [],
      types: ['text/plain'],
    },
  });
  return event;
}

function createEditor(withReplacement: boolean) {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        configExtension(HistoryExtension, {delay: 0}),
        MarkStateExtension,
        ...(twoFlavors ? [CommentMarks] : []),
      ],
      name: '[root]',
      nodes: () =>
        withReplacement
          ? [
              ReplacementTextNode,
              {
                replace: TextNode,
                with: (node: TextNode) =>
                  $create(ReplacementTextNode).setTextContent(
                    node.getTextContent(),
                  ),
                withKlass: ReplacementTextNode,
              },
            ]
          : [],
      theme: {mark: 'mark', markOverlap: 'mark-overlap'},
    }),
  );
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  return editor;
}

function check(
  editor: LexicalEditor,
  model: Model,
  random: () => number,
  fail: (message: string) => never,
) {
  const doc = editor.read($documentModel);
  if (describeModel(doc) !== describeModel(model)) {
    fail(
      `document\n  got:  ${describeModel(doc)}\n  want: ${describeModel(model)}`,
    );
  }
  const normalize = (map: ReadonlyMap<string, readonly string[]>) =>
    JSON.stringify(
      Array.from(map, ([id, keys]) => [id, keys.slice().sort()]).sort((a, b) =>
        a[0] < b[0] ? -1 : 1,
      ),
    );
  for (const [flavor, mark, overlap] of flavors()) {
    const output = getExtensionDependencyFromEditor(
      editor,
      flavor,
    ).output.markIDNodeKeys.peek();
    editor.read(() => {
      // markIDNodeKeys against a full recomputation
      const expected = new Map<string, string[]>();
      for (const node of $getRoot().getAllTextNodes()) {
        for (const id of $getNodeMarkIDs(flavor, node)) {
          expected.set(id, [...(expected.get(id) || []), node.getKey()]);
        }
      }
      if (normalize(output) !== normalize(expected)) {
        fail(
          `${flavor.name} markIDNodeKeys\n  got:  ${normalize(output)}\n  want: ${normalize(expected)}`,
        );
      }
      // The DOM of each flavor
      for (const node of $getRoot().getAllTextNodes()) {
        const ids = $getNodeMarkIDs(flavor, node);
        const dom = editor.getElementByKey(node.getKey());
        if (
          dom === null ||
          dom.getAttribute(flavor.attribute) !==
            (ids.length > 0 ? ids.join(' ') : null) ||
          dom.classList.contains(mark) !== ids.length > 0 ||
          dom.classList.contains(overlap) !== ids.length > 1
        ) {
          fail(
            `${flavor.name} DOM of ${JSON.stringify(node.getTextContent())}`,
          );
        }
      }
    });
  }
  editor.read(() => {
    // No equal siblings left unmerged
    for (const block of $getRoot().getChildren()) {
      const children = $assertNodeType(block, $isElementNode).getChildren();
      children.forEach((node, i) => {
        if (!$isTextNode(node)) {
          return;
        }
        const next = children[i + 1];
        if (
          $isTextNode(next) &&
          node.isSimpleText() &&
          next.isSimpleText() &&
          node.getFormat() === next.getFormat() &&
          node.getStyle() === next.getStyle() &&
          flavors().every(
            ([flavor]) =>
              $getNodeMarkIDs(flavor, node).join() ===
              $getNodeMarkIDs(flavor, next).join(),
          )
        ) {
          fail(`unmerged ${node.getTextContent()}|${next.getTextContent()}`);
        }
      });
    }
  });
  // $getMarkIDsAtSelection against the characters it covers
  for (let k = 0; k < 4; k++) {
    const b1 = Math.floor(random() * model.length);
    const b2 = Math.min(model.length - 1, b1 + (random() < 0.3 ? 1 : 0));
    const o1 = Math.floor(random() * (model[b1].length + 1));
    let o2 = Math.floor(random() * (model[b2].length + 1));
    if (b1 === b2 && o2 < o1) {
      o2 = o1 + Math.floor(random() * (model[b1].length - o1 + 1));
    }
    const backward = random() < 0.5;
    const chars =
      b1 === b2
        ? model[b1].slice(o1, o2)
        : [...model[b1].slice(o1), ...model[b2].slice(0, o2)];
    editor.read(() => {
      const selection = $createRangeSelection();
      const start = $point(b1, o1, true);
      const end = $point(b2, o2, false);
      const [anchor, focus] = backward ? [end, start] : [start, end];
      selection.anchor.set(anchor.key, anchor.offset, anchor.type);
      selection.focus.set(focus.key, focus.offset, focus.type);
      if (selection.isCollapsed()) {
        const node = selection.anchor.getNode();
        if (
          $isTextNode(node) &&
          start.offset > 0 &&
          start.offset < node.getTextContentSize()
        ) {
          const got = union(
            ...flavors().map(([flavor]) =>
              $getMarkIDsAtSelection(flavor, selection),
            ),
          ).join();
          if (got !== model[b1][o1].ids.join()) {
            fail(`ids at the caret ${b1}:${o1}: ${got}`);
          }
        }
        return;
      }
      if (chars.length === 0) {
        return;
      }
      const any = union(...chars.map(ch => ch.ids)).join();
      const all = chars
        .map(ch => ch.ids)
        .reduce((a, b) => intersect(a, b))
        .join();
      // The flavors have disjoint ids, so the ids of all of them shared by
      // every character are the union of each flavor's shared ids
      const gotAny = union(
        ...flavors().map(([flavor]) =>
          $getMarkIDsAtSelection(flavor, selection, 'any'),
        ),
      ).join();
      const gotAll = union(
        ...flavors().map(([flavor]) =>
          $getMarkIDsAtSelection(flavor, selection, 'all'),
        ),
      ).join();
      if (gotAny !== any || gotAll !== all) {
        fail(
          `ids of ${b1}:${o1}-${b2}:${o2}: any ${gotAny} (want ${any}), all ${gotAll} (want ${all})`,
        );
      }
    });
  }
}

function run(seed: number, steps: number, ops: readonly Op[]) {
  const random = xorshift(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)];
  const editor = createEditor(seed % 3 === 0);
  const log: string[] = [];
  const fail = (message: string): never => {
    throw new Error(`${message}\n${log.slice(-20).join('\n')}`);
  };
  const update = (fn: () => void) => editor.update(fn, {discrete: true});
  update(() => {
    const root = $getRoot().clear();
    for (let i = 0; i < 3; i++) {
      const length = 4 + Math.floor(random() * 10);
      const text = Array.from({length}, () =>
        String.fromCharCode(97 + Math.floor(random() * 26)),
      ).join('');
      root.append($createParagraphNode().append($createTextNode(text)));
    }
  });
  for (let i = 0; i < 6; i++) {
    const id = pick(IDS);
    const b1 = Math.floor(random() * 3);
    const b2 = Math.min(2, b1 + (random() < 0.3 ? 1 : 0));
    const length = (b: number) =>
      editor.read(() => $getRoot().getChildAtIndex(b)!.getTextContentSize());
    const o1 = Math.floor(random() * length(b1));
    const o2 =
      b1 === b2
        ? o1 + 1 + Math.floor(random() * (length(b1) - o1))
        : Math.floor(random() * (length(b2) + 1));
    update(() => {
      $addMarkID(
        flavorOf(id),
        id,
        $select([b1, o1, true], [b2, o2, false], random() < 0.5),
      );
    });
  }
  editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  let model = editor.read($documentModel);
  check(editor, model, random, fail);

  const history = getExtensionDependencyFromEditor(editor, HistoryExtension)
    .output.historyState;
  const undoDepth = () => history.peek().undoStack.length;
  const past: Model[] = [];
  const future: Model[] = [];
  /** An update that may add an undo entry, with its effect on the model */
  const commit = (fn: () => void, apply: () => void) => {
    const before = cloneModel(model);
    const depth = undoDepth();
    update(fn);
    apply();
    if (undoDepth() > depth) {
      past.push(before);
      future.length = 0;
    }
  };
  let typed = 0;
  // Typed letters are lowercase half of the time, so they can equal the
  // letters around them or the letters they replace
  const nextLetter = () =>
    random() < 0.5
      ? String.fromCharCode(97 + Math.floor(random() * 26))
      : String.fromCharCode(65 + (typed++ % 26));
  // Sometimes an emoji, some of which share their first code unit
  const nextChar = () =>
    random() < 0.1
      ? pick(['\u{1F600}', '\u{1F603}', '\u{1F642}'])
      : nextLetter();
  const removeEverywhere = (id: string) => {
    model = model.map(block =>
      block.map(ch => ({c: ch.c, ids: ch.ids.filter(other => other !== id)})),
    );
  };

  for (let step = 0; step < steps; step++) {
    const op = pick(ops);
    const b = Math.floor(random() * model.length);
    const length = model[b].length;
    const offset = Math.floor(random() * (length + 1));
    const preferNext = random() < 0.5;
    const caret: [number, number, boolean] = [b, offset, preferNext];
    let note = `${step} ${op} ${b}:${offset}${preferNext ? '>' : '<'}`;
    switch (op) {
      case 'type':
      case 'typeSameUpdate': {
        const c = nextChar();
        if (op === 'type') {
          update(() => $select(caret, caret));
        }
        commit(
          () => {
            if (op === 'typeSameUpdate') {
              $select(caret, caret);
            }
            editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, c);
          },
          () => insertChars(model[b], offset, [{c, ids: []}]),
        );
        break;
      }
      case 'typeBold': {
        // A format toggled at the caret puts the text in a new TextNode
        const c = nextChar();
        update(() => $select(caret, caret));
        commit(
          () => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.toggleFormat('bold');
            }
            editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, c);
          },
          () => insertChars(model[b], offset, [{c, ids: []}]),
        );
        break;
      }
      case 'typeReplace': {
        // A selection replaced by typed or autocorrected text, which often
        // shares letters with the text it replaces
        const b2 = b < model.length - 1 && random() < 0.2 ? b + 1 : b;
        let end = Math.floor(random() * (model[b2].length + 1));
        if (b2 === b) {
          if (offset === length) {
            continue;
          }
          end = offset + 1 + Math.floor(random() * (length - offset));
        }
        const selected =
          b2 === b
            ? model[b].slice(offset, end)
            : [...model[b].slice(offset), ...model[b2].slice(0, end)];
        const word = selected.map(ch => ch.c);
        const kind = Math.floor(random() * 6);
        let text: string;
        if (kind === 0 || word.length === 0) {
          text = nextChar();
        } else if (kind === 1) {
          // Its first letter, as when retyping a word
          text = word[0];
        } else if (kind === 2) {
          // Its last letter
          text = word[word.length - 1];
        } else if (kind === 3) {
          // Two letters swapped, as autocorrect fixes them
          const at = Math.floor(random() * word.length);
          const chars = word.slice();
          if (at + 1 < chars.length) {
            [chars[at], chars[at + 1]] = [chars[at + 1], chars[at]];
          }
          text = chars.join('');
        } else if (kind === 4) {
          // Its start, then new letters
          text =
            word.slice(0, 1 + Math.floor(random() * word.length)).join('') +
            nextChar();
        } else {
          // New letters, then its end
          text =
            nextChar() +
            word.slice(Math.floor(random() * word.length)).join('');
        }
        // The selection is committed first (as when the user selects), or
        // set in the same update (as a beforeinput target range sets it)
        const separate = random() < 0.5;
        // A string, or the replacement text of an autocorrection
        const payload =
          random() < 0.5
            ? text
            : {
                data: null,
                dataTransfer: {
                  getData: (type: string) =>
                    type === 'text/plain' ? text : '',
                  types: ['text/plain'],
                },
                inputType: 'insertReplacementText',
              };
        note += ` to ${b2}:${end} ${JSON.stringify(text)}${separate ? ' committed' : ''}${typeof payload === 'string' ? '' : ' replacement'}`;
        if (separate) {
          update(() => $select(caret, [b2, end, false]));
        }
        commit(
          () => {
            if (!separate) {
              $select(caret, [b2, end, false]);
            }
            editor.dispatchCommand(
              CONTROLLED_TEXT_INSERTION_COMMAND,
              payload as string,
            );
          },
          () => {
            if (b2 === b) {
              model[b].splice(offset, end - offset);
            } else {
              model[b] = [
                ...model[b].slice(0, offset),
                ...model[b2].slice(end),
              ];
              model.splice(b2, 1);
            }
            insertChars(
              model[b],
              offset,
              Array.from(text, c => ({c, ids: []})),
              selected,
            );
          },
        );
        break;
      }
      case 'typeRemove': {
        // An id removed in the same update as typed text, before or after
        // it, replacing a selection or at the caret
        const end =
          offset < length && random() < 0.5
            ? offset + 1 + Math.floor(random() * (length - offset))
            : offset;
        const c = nextChar();
        const id = pick(IDS);
        const removeFirst = random() < 0.5;
        note += ` to ${end} ${JSON.stringify(c)} ${id}${removeFirst ? ' first' : ''}`;
        update(() => $select(caret, [b, end, false]));
        commit(
          () => {
            if (removeFirst) {
              $removeMarkID(flavorOf(id), id);
            }
            editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, c);
            if (!removeFirst) {
              $removeMarkID(flavorOf(id), id);
            }
          },
          () => {
            removeEverywhere(id);
            const selected = model[b].splice(offset, end - offset);
            insertChars(model[b], offset, [{c, ids: []}], selected);
          },
        );
        break;
      }
      case 'pasteOutside': {
        // A paste event, which dispatches PASTE_COMMAND outside an update,
        // over a selection or at the caret, often of text that starts with
        // the letter it replaces
        const end =
          offset < length && random() < 0.6
            ? offset + 1 + Math.floor(random() * (length - offset))
            : offset;
        const selected = model[b].slice(offset, end);
        const text =
          selected.length > 0 && random() < 0.5
            ? selected[0].c + nextChar()
            : nextChar() + nextChar();
        note += ` to ${end} ${JSON.stringify(text)}`;
        update(() => $select(caret, [b, end, false]));
        const before = cloneModel(model);
        const depth = undoDepth();
        editor.dispatchCommand(PASTE_COMMAND, pasteEvent(text));
        editor.read(() => {});
        model[b].splice(offset, end - offset);
        insertChars(
          model[b],
          offset,
          Array.from(text, c => ({c, ids: []})),
          selected,
        );
        if (undoDepth() > depth) {
          past.push(before);
          future.length = 0;
        }
        break;
      }
      case 'ime': {
        if (length === 0) {
          continue;
        }
        const c = nextLetter();
        update(() => $select(caret, caret));
        commit(
          () => {
            editor.dispatchCommand(
              COMPOSITION_START_COMMAND,
              new CompositionEvent('compositionstart', {data: ''}),
            );
          },
          () => {},
        );
        commit(
          () => {
            // What the IME writes into the composing node
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) {
              throw new Error('no selection while composing');
            }
            const node = selection.anchor.getNode() as TextNode;
            const at = selection.anchor.offset;
            const text = node.getTextContent();
            if (at > 0 && text[at - 1] === '\u200b') {
              node.setTextContent(text.slice(0, at - 1) + c + text.slice(at));
              node.select(at, at);
            } else if (text[at] === '\u200b') {
              node.setTextContent(text.slice(0, at) + c + text.slice(at + 1));
              node.select(at + 1, at + 1);
            } else {
              node.setTextContent(text.slice(0, at) + c + text.slice(at));
              node.select(at + 1, at + 1);
            }
          },
          () => {},
        );
        commit(
          () => $setCompositionKey(null),
          () => insertChars(model[b], offset, [{c, ids: []}]),
        );
        break;
      }
      case 'backspace':
      case 'delete': {
        const backward = op === 'backspace';
        if (backward && b === 0 && offset === 0) {
          continue;
        }
        if (backward && offset > 0) {
          update(() => $select([b, offset - 1, true], [b, offset, false]));
        } else if (!backward && offset < length) {
          update(() => $select([b, offset, true], [b, offset + 1, false]));
        } else {
          update(() => $select(caret, caret));
        }
        commit(
          () => {
            editor.dispatchCommand(DELETE_CHARACTER_COMMAND, backward);
          },
          () => {
            if (backward && offset > 0) {
              model[b].splice(offset - 1, 1);
            } else if (backward) {
              model[b - 1].push(...model[b]);
              model.splice(b, 1);
            } else if (offset < length) {
              model[b].splice(offset, 1);
            } else if (b < model.length - 1) {
              model[b].push(...model[b + 1]);
              model.splice(b + 1, 1);
            }
          },
        );
        break;
      }
      case 'deleteRange': {
        const b2 = Math.min(model.length - 1, b + (random() < 0.4 ? 1 : 0));
        let o2 = Math.floor(random() * (model[b2].length + 1));
        if (b2 === b && o2 < offset) {
          o2 = offset + Math.floor(random() * (length - offset + 1));
        }
        if (b2 === b && o2 === offset) {
          continue;
        }
        note += ` to ${b2}:${o2}`;
        const backward = random() < 0.5;
        commit(
          () => {
            $select([b, offset, true], [b2, o2, false], backward);
            editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
          },
          () => {
            if (b2 === b) {
              model[b].splice(offset, o2 - offset);
            } else {
              model[b] = [...model[b].slice(0, offset), ...model[b2].slice(o2)];
              model.splice(b2, 1);
            }
          },
        );
        break;
      }
      case 'enter': {
        commit(
          () => {
            $select(caret, caret);
            editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
          },
          () => model.splice(b + 1, 0, model[b].splice(offset)),
        );
        break;
      }
      case 'format': {
        if (length === 0) {
          continue;
        }
        const o1 = Math.floor(random() * length);
        const o2 = o1 + 1 + Math.floor(random() * (length - o1));
        const format = random() < 0.5 ? 'bold' : 'italic';
        note += ` ${format} [${o1},${o2})`;
        const backward = random() < 0.5;
        commit(
          () => {
            $select([b, o1, true], [b, o2, false], backward);
            editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
          },
          () => {},
        );
        break;
      }
      case 'blockType': {
        const heading = random() < 0.5;
        commit(
          () => {
            $select(caret, caret);
            $setBlocksType($getSelection(), () =>
              heading ? $createHeadingNode('h1') : $createParagraphNode(),
            );
          },
          () => {},
        );
        break;
      }
      case 'mark':
      case 'unmark': {
        const id = pick(IDS);
        const b2 = Math.min(model.length - 1, b + (random() < 0.3 ? 1 : 0));
        let o2 = Math.floor(random() * (model[b2].length + 1));
        if (b2 === b && o2 < offset) {
          o2 = offset + Math.floor(random() * (length - offset + 1));
        }
        const backward = random() < 0.5;
        const everywhere = op === 'unmark' && random() < 0.3;
        note += ` ${id} to ${b2}:${o2}${everywhere ? ' everywhere' : ''}`;
        commit(
          () => {
            const selection = $select(
              [b, offset, true],
              [b2, o2, false],
              backward,
            );
            if (op === 'mark') {
              $addMarkID(flavorOf(id), id, selection);
            } else {
              $removeMarkID(flavorOf(id), id, everywhere ? null : selection);
            }
          },
          () => {
            const apply = (ch: Char): Char => ({
              c: ch.c,
              ids:
                op === 'mark'
                  ? union(ch.ids, [id])
                  : ch.ids.filter(other => other !== id),
            });
            if (everywhere) {
              model = model.map(block => block.map(apply));
            } else if (b2 === b) {
              model[b].splice(
                offset,
                o2 - offset,
                ...model[b].slice(offset, o2).map(apply),
              );
            } else {
              model[b].splice(
                offset,
                Infinity,
                ...model[b].slice(offset).map(apply),
              );
              model[b2].splice(0, o2, ...model[b2].slice(0, o2).map(apply));
            }
          },
        );
        break;
      }
      case 'copyPaste':
      case 'cutPaste': {
        if (length === 0) {
          continue;
        }
        const o1 = Math.floor(random() * length);
        const o2 = o1 + 1 + Math.floor(random() * (length - o1));
        const copied = model[b].slice(o1, o2);
        let json: null | ReturnType<typeof $generateJSONFromSelectedNodes> =
          null;
        commit(
          () => {
            const selection = $select([b, o1, true], [b, o2, false]);
            json = $generateJSONFromSelectedNodes(editor, selection);
            if (op === 'cutPaste') {
              selection.removeText();
            }
          },
          () => {
            if (op === 'cutPaste') {
              model[b].splice(o1, o2 - o1);
            }
          },
        );
        const tb = Math.floor(random() * model.length);
        const to = Math.floor(random() * (model[tb].length + 1));
        note += ` [${o1},${o2}) to ${tb}:${to}`;
        commit(
          () => {
            const selection = $select(
              [tb, to, preferNext],
              [tb, to, preferNext],
            );
            $insertGeneratedNodes(
              editor,
              $generateNodesFromSerializedNodes(json!.nodes),
              selection,
            );
          },
          () => insertChars(model[tb], to, copied),
        );
        break;
      }
      case 'undo':
      case 'redo': {
        const depth = undoDepth();
        const redoDepth = history.peek().redoStack.length;
        editor.dispatchCommand(
          op === 'undo' ? UNDO_COMMAND : REDO_COMMAND,
          undefined,
        );
        editor.read(() => {});
        if (op === 'undo' && undoDepth() < depth) {
          future.push(model);
          model = past.pop()!;
        } else if (
          op === 'redo' &&
          history.peek().redoStack.length < redoDepth
        ) {
          past.push(model);
          model = future.pop()!;
        }
        break;
      }
    }
    if (model.length === 0) {
      model = [[]];
    }
    log.push(`${note} => ${describeModel(model)}`);
    check(editor, model, random, fail);
  }
  editor.dispose();
}

describe.each([
  ['MarkStateExtension property test', false],
  ['MarkStateExtension property test with two mark flavors', true],
])('%s', (_title, withTwoFlavors) => {
  const seeds = Number(process.env.MARK_STATE_PROPERTY_SEEDS || 40);
  const steps = Number(process.env.MARK_STATE_PROPERTY_STEPS || 30);
  const ops = (process.env.MARK_STATE_PROPERTY_OPS || '')
    .split(',')
    .filter((op): op is Op => (OPS as readonly string[]).includes(op));

  test(`${seeds} random edit sequences of ${steps} steps keep the ids of every character`, () => {
    twoFlavors = withTwoFlavors;
    const failures: string[] = [];
    try {
      for (let seed = 1; seed <= seeds; seed++) {
        try {
          run(seed, steps, ops.length > 0 ? ops : OPS);
        } catch (error) {
          failures.push(`seed ${seed}: ${(error as Error).message}`);
        }
      }
    } finally {
      twoFlavors = false;
    }
    expect(failures.slice(0, 3).join('\n\n')).toBe('');
    expect(failures.length).toBe(0);
  }, 600_000);
});
