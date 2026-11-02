/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The textFormat and textStyle of an inline element the binding stores as a
// wrapper (link, autolink, mark, overflow), over every nesting of them: the
// catalog's inline elements one to two deep in every order (three with
// MATRIX_FULL=1), around plain, formatted and styled text, two texts, a line
// break, text next to a nested wrapper or an inline decorator, an inline
// decorator alone and a line break alone, with and without text fields of
// their own.
//
// - An author's JSON equals a fresh reader's after a format or style change
//   over the paragraph or over the wrapped text alone (#9597's fix stores
//   them only where Lexical serializes them; for a wrapper whose text sits
//   in another wrapper, a mark in a link, Lexical serializes them only
//   since this fix, so the two agree).
// - A wrapper one client removes stays removed while another formats a range
//   covering it, in both client id orders (#9597: the format wrote the
//   wrapper's value again and brought it back).

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createAutoLinkNode,
  $createLinkNode,
  $isAutoLinkNode,
  $isLinkNode,
} from '@lexical/link';
import {$createMarkNode, $isMarkNode} from '@lexical/mark';
import {$createOverflowNode, $isOverflowNode} from '@lexical/overflow';
import {$patchStyleText} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getEditor,
  $getRoot,
  $isElementNode,
  $setSelection,
  $setState,
  configExtension,
  createState,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type SerializedEditorState,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$createEquationNode} from '../../../../../lexical-playground/src/nodes/EquationNode';
import {YCollabExtension} from '../../..';
import {createYDoc, readYState, seedYState} from '../../../headless';
import {catalogAppExtension, catalogHeadlessConfig} from '../../catalog';

const config = catalogHeadlessConfig();

type Kind = 'link' | 'autolink' | 'mark' | 'mark2' | 'overflow';
const KINDS: readonly Kind[] = [
  'link',
  'autolink',
  'mark',
  'mark2',
  'overflow',
];

function $create(kind: Kind): ElementNode {
  switch (kind) {
    case 'link':
      return $createLinkNode('https://wrapped.test');
    case 'autolink':
      return $createAutoLinkNode('https://auto.test');
    case 'mark':
      return $createMarkNode(['c1']);
    case 'mark2':
      return $createMarkNode(['c2']);
    case 'overflow':
      return $createOverflowNode();
  }
}

/** Whether `node` is the wrapper `kind` makes. */
function $is(kind: Kind, node: LexicalNode): boolean {
  switch (kind) {
    case 'link':
      return $isLinkNode(node) && !$isAutoLinkNode(node);
    case 'autolink':
      return $isAutoLinkNode(node);
    case 'mark':
    case 'mark2':
      return (
        $isMarkNode(node) &&
        node.getIDs().includes(kind === 'mark' ? 'c1' : 'c2')
      );
    case 'overflow':
      return $isOverflowNode(node);
  }
}

// MATRIX_FULL=1 nests three deep; the default run two (every pair, in both
// orders).
const DEPTH = process.env.MATRIX_FULL === '1' ? 3 : 2;

/** Every chain of wrappers, outermost first, one to DEPTH deep. */
function chains(): Kind[][] {
  const out: Kind[][] = [];
  const grow = (chain: Kind[]) => {
    if (chain.length > 0) {
      out.push(chain);
    }
    if (chain.length === DEPTH) {
      return;
    }
    for (const k of KINDS) {
      const links = [...chain, k].filter(c => c === 'link' || c === 'autolink');
      if (!chain.includes(k) && links.length <= 1) {
        grow([...chain, k]);
      }
    }
  };
  grow([]);
  return out;
}

type Leaf =
  | 'text'
  | 'bold'
  | 'styled'
  | 'two-texts'
  | 'line-break'
  | 'text+wrapper'
  | 'text+decorator'
  | 'decorator'
  | 'no-text';
const LEAVES: readonly Leaf[] = [
  'text',
  'bold',
  'styled',
  'two-texts',
  'line-break',
  'text+wrapper',
  'text+decorator',
  'decorator',
  'no-text',
];

function $leaf(leaf: Leaf): LexicalNode[] {
  switch (leaf) {
    case 'text':
      return [$createTextNode('wrapped words')];
    case 'bold':
      return [$createTextNode('wrapped words').setFormat('bold')];
    case 'styled':
      return [$createTextNode('wrapped words').setStyle('color: red')];
    case 'two-texts':
      return [
        $createTextNode('wrapped '),
        $createTextNode('words').setFormat('italic'),
      ];
    case 'line-break':
      return [
        $createTextNode('wrapped'),
        $createLineBreakNode(),
        $createTextNode('words'),
      ];
    case 'text+wrapper':
      return [
        $createTextNode('wrapped '),
        $createMarkNode(['c9']).append($createTextNode('words')),
      ];
    case 'text+decorator':
      return [$createTextNode('wrapped '), $createEquationNode('x^2', true)];
    case 'decorator':
      return [$createEquationNode('x^2', true)];
    case 'no-text':
      return [$createLineBreakNode()];
  }
}

type Fields = 'none' | 'own';

function $build(chain: readonly Kind[], leaf: Leaf, fields: Fields): void {
  let inner: LexicalNode[] = $leaf(leaf);
  for (let i = chain.length - 1; i >= 0; i--) {
    const wrapper = $create(chain[i]).append(...inner);
    if (fields === 'own') {
      wrapper.setTextFormat(2).setTextStyle('font-size: 12px');
    }
    inner = [wrapper];
  }
  $getRoot()
    .clear()
    .append(
      $createParagraphNode().append(
        $createTextNode('before '),
        ...inner,
        $createTextNode(' after'),
      ),
    );
}

function client(seed: Uint8Array, id: number) {
  const doc = createYDoc(seed);
  doc.clientID = id;
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        catalogAppExtension(),
        configExtension(YCollabExtension, {doc, schemaVersion: 1}),
      ],
      name: `wrapper-text-fields-${id}`,
    }),
  );
  return {doc, editor};
}

function sync(a: {doc: Y.Doc}, b: {doc: Y.Doc}): void {
  const ua = Y.encodeStateAsUpdate(a.doc);
  const ub = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, ub);
  Y.applyUpdate(b.doc, ua);
}

function $json(): SerializedEditorState {
  return $getEditor().getEditorState().toJSON();
}

function json(editor: LexicalEditor): SerializedEditorState {
  return editor.read($json);
}

function fresh(doc: Y.Doc): SerializedEditorState {
  return readYState(Y.encodeStateAsUpdate(doc), config, $json);
}

/** The text nodes inside the outermost wrapper. */
function $wrappedTexts(): TextNode[] {
  const paragraph = $getRoot().getFirstChildOrThrow() as ElementNode;
  const out: TextNode[] = [];
  for (const child of paragraph.getChildren()) {
    if ($isElementNode(child)) {
      out.push(...child.getAllTextNodes());
    }
  }
  return out;
}

function $selectAll(): ReturnType<typeof $createRangeSelection> {
  const texts = $getRoot().getAllTextNodes();
  const first = texts[0];
  const last = texts[texts.length - 1];
  const selection = $createRangeSelection();
  selection.anchor.set(first.getKey(), 0, 'text');
  selection.focus.set(last.getKey(), last.getTextContentSize(), 'text');
  $setSelection(selection);
  return selection;
}

function $selectWrapped(): ReturnType<typeof $createRangeSelection> | null {
  const texts = $wrappedTexts();
  if (texts.length === 0) {
    return null;
  }
  const first = texts[0];
  const last = texts[texts.length - 1];
  const selection = $createRangeSelection();
  selection.anchor.set(first.getKey(), 0, 'text');
  selection.focus.set(last.getKey(), last.getTextContentSize(), 'text');
  $setSelection(selection);
  return selection;
}

type Op = 'format-all' | 'format-wrapped' | 'style-all' | 'style-wrapped';
const OPS: readonly Op[] = [
  'format-all',
  'format-wrapped',
  'style-all',
  'style-wrapped',
];

/** Runs `op`; false when it has nothing to act on. */
function $op(op: Op): boolean {
  const selection =
    op === 'format-all' || op === 'style-all' ? $selectAll() : $selectWrapped();
  if (selection === null) {
    return false;
  }
  if (op === 'format-all' || op === 'format-wrapped') {
    selection.formatText('code');
  } else {
    $patchStyleText(selection, {color: 'blue'});
  }
  return true;
}

/** Moves the children of the wrapper `kind` out of it and removes it. */
function $unwrap(kind: Kind): void {
  const visit = (node: ElementNode) => {
    for (const child of node.getChildren()) {
      if ($isElementNode(child)) {
        if ($is(kind, child)) {
          for (const grandchild of child.getChildren()) {
            child.insertBefore(grandchild);
          }
          child.remove();
        } else {
          visit(child);
        }
      }
    }
  };
  visit($getRoot());
}

function count(editor: LexicalEditor, kind: Kind): number {
  return editor.read(() => {
    let n = 0;
    const visit = (node: ElementNode) => {
      for (const child of node.getChildren()) {
        if ($isElementNode(child)) {
          if ($is(kind, child)) {
            n++;
          }
          visit(child);
        }
      }
    };
    visit($getRoot());
    return n;
  });
}

/** The URLs of the wrappers `kind` (a link or an autolink). */
function urls(editor: LexicalEditor, kind: Kind): string[] {
  return editor.read(() => {
    const out: string[] = [];
    const visit = (node: ElementNode) => {
      for (const child of node.getChildren()) {
        if ($isElementNode(child)) {
          if ($is(kind, child) && $isLinkNode(child)) {
            out.push(child.getURL());
          }
          visit(child);
        }
      }
    };
    visit($getRoot());
    return out;
  });
}

const CHAINS = chains();

type Shape = {chain: Kind[]; leaf: Leaf; fields: Fields; label: string};
const SHAPES: Shape[] = [];
for (const chain of CHAINS) {
  for (const leaf of LEAVES) {
    for (const fields of ['none', 'own'] as const) {
      SHAPES.push({
        chain,
        fields,
        label: `${chain.join('>')}>${leaf}${fields === 'own' ? ' own' : ''}`,
        leaf,
      });
    }
  }
}

describe('an author and a fresh reader have the same JSON', () => {
  test.each(SHAPES)('$label', async ({chain, leaf, fields}) => {
    const seed = seedYState(config, () => $build(chain, leaf, fields));
    const author = client(seed, 101);
    const peer = client(seed, 102);
    await Promise.resolve();
    expect(json(author.editor)).toEqual(fresh(author.doc));
    for (const op of OPS) {
      let acted = false;
      author.editor.update(
        () => {
          acted = $op(op);
        },
        {discrete: true},
      );
      if (!acted) {
        continue;
      }
      sync(author, peer);
      await Promise.resolve();
      const expected = fresh(author.doc);
      expect(json(author.editor), `${op}: author`).toEqual(expected);
      expect(json(peer.editor), `${op}: peer`).toEqual(expected);
    }
  });
});

// A client deletes the wrapped text but not a line break or an inline
// decorator next to it, after (or while) a client formats over the wrapper
// (the other client, or the same one): the wrapper now holds no text, so
// Lexical serializes its text fields, and every client shows the stored ones
// (the formatting client's own, set while the wrapper held text, were not
// stored).
describe('a wrapper whose text a client deletes after a format over it', () => {
  const cells = SHAPES.filter(
    ({leaf}) => leaf === 'line-break' || leaf === 'text+decorator',
  ).flatMap(shape =>
    (['after', 'concurrent'] as const).flatMap(when =>
      (['peer', 'self'] as const).flatMap(who =>
        (
          [
            [1, 2],
            [2, 1],
          ] as [number, number][]
        ).map(ids => ({...shape, ids, when, who})),
      ),
    ),
  );
  test.each(cells)(
    '$label: $who deletes $when, ids $ids.0,$ids.1',
    async ({chain, leaf, fields, ids, when, who}) => {
      const seed = seedYState(config, () => $build(chain, leaf, fields));
      const a = client(seed, ids[0]);
      const b = client(seed, ids[1]);
      await Promise.resolve();
      b.editor.update(
        () => {
          $selectAll().formatText('bold');
        },
        {discrete: true},
      );
      if (when === 'after') {
        sync(a, b);
        await Promise.resolve();
      }
      (who === 'peer' ? a : b).editor.update(
        () => {
          for (const text of $wrappedTexts()) {
            text.remove();
          }
          $setSelection(null);
        },
        {discrete: true},
      );
      await Promise.resolve();
      sync(a, b);
      await Promise.resolve();
      const expected = fresh(a.doc);
      expect(json(a.editor), 'a = fresh').toEqual(expected);
      expect(json(b.editor), 'b = fresh').toEqual(expected);
    },
  );
});

// A client that formatted over a wrapper (synced) deletes the wrapper's text
// but not a line break or an inline decorator next to it, while the other
// client removes the wrapper, or for a link gives it another URL: the
// removal or the new URL stays on every client (the delete leaves the
// wrapper without text, and its text fields, set by the format while it
// held text and never stored, must not write its value again).
describe('a wrapper one client removes or retargets while the other deletes its text', () => {
  const cells = SHAPES.filter(
    ({leaf}) => leaf === 'line-break' || leaf === 'text+decorator',
  ).flatMap(shape =>
    shape.chain.flatMap(target =>
      (target === 'link' || target === 'autolink'
        ? (['remove', 'retarget'] as const)
        : (['remove'] as const)
      ).flatMap(change =>
        (
          [
            [1, 2],
            [2, 1],
          ] as [number, number][]
        ).map(ids => ({...shape, change, ids, target})),
      ),
    ),
  );
  test.each(cells)(
    '$label: $change $target, ids $ids.0,$ids.1',
    async ({chain, leaf, fields, change, ids, target}) => {
      const seed = seedYState(config, () => $build(chain, leaf, fields));
      const a = client(seed, ids[0]);
      const b = client(seed, ids[1]);
      await Promise.resolve();
      b.editor.update(
        () => {
          $selectAll().formatText('bold');
        },
        {discrete: true},
      );
      sync(a, b);
      await Promise.resolve();
      a.editor.update(
        () => {
          if (change === 'remove') {
            $unwrap(target);
          } else {
            const visit = (node: ElementNode) => {
              for (const child of node.getChildren()) {
                if ($isElementNode(child)) {
                  if ($is(target, child) && $isLinkNode(child)) {
                    child.setURL('https://new.test');
                  }
                  visit(child);
                }
              }
            };
            visit($getRoot());
          }
          $setSelection(null);
        },
        {discrete: true},
      );
      b.editor.update(
        () => {
          for (const text of $wrappedTexts()) {
            text.remove();
          }
          $setSelection(null);
        },
        {discrete: true},
      );
      await Promise.resolve();
      sync(a, b);
      await Promise.resolve();
      const expected = fresh(a.doc);
      expect(json(a.editor), 'a = fresh').toEqual(expected);
      expect(json(b.editor), 'b = fresh').toEqual(expected);
      if (change === 'remove') {
        expect(count(a.editor, target), 'a: removed').toBe(0);
        expect(count(b.editor, target), 'b: removed').toBe(0);
      } else {
        for (const editor of [a.editor, b.editor]) {
          expect(urls(editor, target), 'retargeted').toEqual([
            'https://new.test',
          ]);
        }
      }
    },
  );
});

// A wrapper with no text (only a line break or an inline decorator) that
// stores text fields of its own: one client appends text into it while the
// other removes it, or gives a link another URL. The removal or the new URL
// stays on every client: the append leaves the wrapper holding text, whose
// text fields are not written, and its value without them does not write the
// stored one again over the content it kept.
describe('a textless wrapper with stored text fields that a client appends text into', () => {
  const cells = SHAPES.filter(
    ({leaf, fields}) =>
      fields === 'own' && (leaf === 'no-text' || leaf === 'decorator'),
  ).flatMap(shape =>
    shape.chain.flatMap(target =>
      (target === 'link' || target === 'autolink'
        ? (['remove', 'retarget'] as const)
        : (['remove'] as const)
      ).flatMap(change =>
        (
          [
            [1, 2],
            [2, 1],
          ] as [number, number][]
        ).map(ids => ({...shape, change, ids, target})),
      ),
    ),
  );
  test.each(cells)(
    '$label: $change $target, ids $ids.0,$ids.1',
    async ({chain, leaf, fields, change, ids, target}) => {
      const seed = seedYState(config, () => $build(chain, leaf, fields));
      const a = client(seed, ids[0]);
      const b = client(seed, ids[1]);
      await Promise.resolve();
      a.editor.update(
        () => {
          if (change === 'remove') {
            $unwrap(target);
          } else {
            const visit = (node: ElementNode) => {
              for (const child of node.getChildren()) {
                if ($isElementNode(child)) {
                  if ($is(target, child) && $isLinkNode(child)) {
                    child.setURL('https://new.test');
                  }
                  visit(child);
                }
              }
            };
            visit($getRoot());
          }
          $setSelection(null);
        },
        {discrete: true},
      );
      b.editor.update(
        () => {
          // Into the innermost wrapper.
          let node = ($getRoot().getFirstChildOrThrow() as ElementNode)
            .getChildren()
            .find($isElementNode) as ElementNode;
          for (
            let inner = node.getChildren().find($isElementNode);
            inner !== undefined && $isElementNode(inner) && inner.isInline();
            inner = node.getChildren().find($isElementNode)
          ) {
            node = inner as ElementNode;
          }
          node.append($createTextNode('typed'));
          $setSelection(null);
        },
        {discrete: true},
      );
      await Promise.resolve();
      sync(a, b);
      await Promise.resolve();
      const expected = fresh(a.doc);
      expect(json(a.editor), 'a = fresh').toEqual(expected);
      expect(json(b.editor), 'b = fresh').toEqual(expected);
      if (change === 'remove') {
        expect(count(a.editor, target), 'a: removed').toBe(0);
      } else {
        expect(urls(a.editor, target), 'retargeted').toEqual([
          'https://new.test',
        ]);
      }
    },
  );
});

// Removal races: every wrapper of a chain, removed by one client while the
// other formats a range covering it, in both id orders.
type Race = Shape & {removed: Kind; ids: [number, number]};
const RACES: Race[] = [];
for (const shape of SHAPES) {
  for (const removed of shape.chain) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ] as [number, number][]) {
      RACES.push({...shape, ids, removed});
    }
  }
}

/**
 * A link that holds no text (only an inline decorator or a line break):
 * Lexical serializes its textFormat and textStyle, so the binding stores
 * them in the link's value, and the format change still writes that value
 * and brings the removed link back (#9627).
 */
function knownTextlessLink({removed, leaf}: Race): boolean {
  return removed === 'link' && (leaf === 'decorator' || leaf === 'no-text');
}

describe('a wrapper one client removes stays removed while another formats over it', () => {
  for (const [known, races] of [
    [false, RACES.filter(r => !knownTextlessLink(r))],
    [true, RACES.filter(knownTextlessLink)],
  ] as const) {
    (known ? test.fails : test).each(races)(
      `$label: remove $removed, ids $ids.0,$ids.1${known ? ' (#9627)' : ''}`,
      async ({chain, leaf, fields, removed, ids}) => {
        const seed = seedYState(config, () => $build(chain, leaf, fields));
        const a = client(seed, ids[0]);
        const b = client(seed, ids[1]);
        await Promise.resolve();
        a.editor.update(() => $unwrap(removed), {discrete: true});
        expect(count(a.editor, removed)).toBe(0);
        b.editor.update(
          () => {
            $selectAll().formatText('code');
          },
          {discrete: true},
        );
        sync(a, b);
        await Promise.resolve();
        const expected = fresh(a.doc);
        expect(count(a.editor, removed), 'a').toBe(0);
        expect(count(b.editor, removed), 'b').toBe(0);
        expect(json(a.editor), 'a = fresh').toEqual(expected);
        expect(json(b.editor), 'b = fresh').toEqual(expected);
      },
    );
  }
});

const note = createState('wrapper-text-fields-note', {
  parse: (v: unknown) => (typeof v === 'string' ? v : ''),
});

/** The first wrapper `kind` makes, at any depth. */
function $find(kind: Kind): ElementNode {
  let found: ElementNode | null = null;
  const visit = (node: ElementNode) => {
    for (const child of node.getChildren()) {
      if (found === null && $isElementNode(child)) {
        if ($is(kind, child)) {
          found = child;
        } else {
          visit(child);
        }
      }
    }
  };
  visit($getRoot());
  if (found === null) {
    throw new Error(`no ${kind}`);
  }
  return found;
}

// A change to the link itself (here NodeState) writes its value again, and
// that write brings back a link a collaborator removed at the same time
// (#9629): not a text format or style, so not covered by #9597's fix.
describe('a link one client removes while another sets NodeState on it', () => {
  test.fails.each(
    ([['link'], ['link', 'mark'], ['mark', 'link']] as Kind[][]).flatMap(
      chain =>
        (
          [
            [1, 2],
            [2, 1],
          ] as [number, number][]
        ).map(ids => ({chain, ids, label: chain.join('>')})),
    ),
  )('$label: ids $ids.0,$ids.1 (#9629)', async ({chain, ids}) => {
    const seed = seedYState(config, () => $build(chain, 'text', 'none'));
    const a = client(seed, ids[0]);
    const b = client(seed, ids[1]);
    await Promise.resolve();
    a.editor.update(() => $unwrap('link'), {discrete: true});
    b.editor.update(() => void $setState($find('link'), note, 'checked'), {
      discrete: true,
    });
    sync(a, b);
    await Promise.resolve();
    expect(count(a.editor, 'link'), 'a').toBe(0);
    expect(count(b.editor, 'link'), 'b').toBe(0);
  });
});
