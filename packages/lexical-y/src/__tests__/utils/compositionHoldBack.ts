/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The composition hold-back matrix (see CompositionHoldBack.test.ts): line
// shapes, collaborators' changes, and the ways a composition ends.

import {$createCodeNode} from '@lexical/code';
import {registerCodeHighlighting} from '@lexical/code-prism';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $addMarkID,
  $getNodeMarkIDs,
  $isMarkNode,
  $wrapSelectionInMarkNode,
} from '@lexical/mark';
import {$createHeadingNode, $isHeadingNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {$findMatchingParent} from '@lexical/utils';
import {
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type TextNode,
} from 'lexical';
import {expect} from 'vitest';

import {
  $block,
  $locateIn,
  $p,
  $selectIn,
  expectConverged,
  type Peer,
  type Setup,
  setup,
} from './harness';
import {prepareMarkState} from './sizeOps';

export type Shape = {
  /** The document, with the line composed in holding `alpha beta gamma`. */
  init: () => void;
  /** The composed line's path, once `prepare` ran. */
  path: number[];
  /** Edits made (and synced) before the composition: the line's history. */
  prepare?: (t: Setup) => Promise<void>;
  /** Whether the editors highlight code (a code block's derived nodes). */
  highlight?: boolean;
  /** Whether the line is an item of a group (a list item). */
  item?: boolean;
};

const $text = (s: string) => $p(s).getFirstChildOrThrow() as TextNode;

export const SHAPES: Record<string, Shape> = {
  'code line': {
    highlight: true,
    init: () =>
      $getRoot().append(
        $p('pre'),
        $createCodeNode('javascript').append($text('alpha beta gamma')),
        $p('omega'),
      ),
    path: [1],
  },
  // A line whose text is three nodes: the composition is in the last one.
  'formatted run': {
    init: () =>
      $getRoot().append(
        $p('pre'),
        $p('alpha ').append(
          $createTextNode('beta').toggleFormat('italic'),
          $createTextNode(' gamma'),
        ),
        $p('omega'),
      ),
    path: [1],
  },
  // A line made by joining two (Backspace at the start of the second): its
  // stored range holds the deleted marker between them (#9492).
  joined: {
    init: () =>
      $getRoot().append($p('pre'), $p('alpha beta'), $p(' gamma'), $p('omega')),
    path: [1],
    prepare: async t => {
      t.a.update(() => {
        const s = ($block([1]).getFirstChildOrThrow() as TextNode).select(
          10,
          10,
        );
        s.focus.set($block([2]).getFirstChildOrThrow().getKey(), 0, 'text');
        s.removeText();
      });
      await t.sync();
    },
  },
  'list item': {
    init: () =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($text('pre')),
          $createListItemNode().append($text('alpha beta gamma')),
          $createListItemNode().append($text('omega')),
        ),
      ),
    item: true,
    path: [0, 1],
  },
  plain: {
    init: () =>
      $getRoot().append($p('pre'), $p('alpha beta gamma'), $p('omega')),
    path: [1],
  },
  // A line made by splitting one (Enter): it ends at the new marker.
  split: {
    init: () =>
      $getRoot().append($p('pre'), $p('alpha beta gamma delta'), $p('omega')),
    path: [1],
    prepare: async t => {
      t.a.update(() => $selectIn([1], 16).insertParagraph());
      await t.sync();
    },
  },
  'table cell': {
    init: () =>
      $getRoot().append(
        $createTableNode().append(
          $createTableRowNode().append(
            $createTableCellNode().append(
              $p('pre'),
              $p('alpha beta gamma'),
              $p('omega'),
            ),
            $createTableCellNode().append($p('next')),
          ),
        ),
      ),
    path: [0, 0, 0, 1],
  },
};

/**
 * What a read of a collaborator's change promises for the composed line:
 * `held`, it keeps its nodes; `read`, the composed node keeps its key;
 * `replaced`, its class changes, so it is a new node.
 */
export type Expected = 'held' | 'read' | 'replaced';

/** Changes a collaborator makes to the composed line, mid-composition. */
export const REMOTE: Record<
  string,
  {
    promise: (shape: Shape) => Expected;
    /** The change, made by B in one update. */
    $edit?: (path: number[]) => void;
    /** The change, made by B (and C) in several updates (each synced). */
    run?: (t: Setup, path: number[]) => Promise<void>;
    /** Whether the change needs a third peer, C. */
    third?: boolean;
  }
> = {
  // B centers the line: its marker's attributes are held back.
  align: {
    $edit: path => $block(path).setFormat('center'),
    promise: () => 'held',
  },
  // B centers the line, then presses Enter at the end of the line before:
  // a read of the lines around it keeps what is held.
  'align, then Enter in the line before': {
    promise: () => 'held',
    run: async (t, path) => {
      t.b.update(() => $block(path).setFormat('center'));
      await t.sync();
      const before = [...path.slice(0, -1), path[path.length - 1] - 1];
      t.b.update(() => $block(before).selectEnd().insertParagraph());
      await t.sync();
    },
  },
  comment: {
    $edit: path => {
      $addMarkID('c1', $selectIn(path, 6, 10));
    },
    promise: () => 'held',
  },
  // B composes at the same place too, commits, and comments the word it
  // committed (S7-28).
  composition: {
    promise: () => 'held',
    run: async (t, path) => {
      let key: NodeKey = '';
      t.b.update(() => {
        const [node, offset] = $locateIn($block(path), 16);
        node.select(offset, offset);
        $setCompositionKey(node.getKey());
        key = node.getKey();
      });
      let at = 0;
      let prev = '';
      for (const next of ['n', 'に', '日本']) {
        t.b.update(() => {
          const node = $getNodeByKey(key) as TextNode;
          at = at === 0 ? $composedAt(node) : at;
          const text = node.getTextContent();
          node.setTextContent(
            text.slice(0, at) + next + text.slice(at + prev.length),
          );
          node.select(at + next.length, at + next.length);
        });
        prev = next;
        await t.sync();
      }
      t.b.update(() => {
        $setCompositionKey(null);
        const node = $getNodeByKey(key) as TextNode;
        const s = node.select(at + 1, at + 2);
        $addMarkID('c2', s);
      });
      await t.sync();
    },
  },
  delete: {
    $edit: path => $selectIn(path, 6, 11).removeText(),
    promise: () => 'read',
  },
  format: {
    $edit: path => $selectIn(path, 6, 10).formatText('bold'),
    promise: () => 'held',
  },
  insert: {
    $edit: path => $selectIn(path, 6).insertText('XY '),
    promise: () => 'held',
  },
  // B types a word in the line and deletes text before it (read at once,
  // the word held), then C types inside B's word (S7-37).
  'insert, a delete, an insert in it': {
    promise: () => 'read',
    run: async (t, path) => {
      t.b.update(() => $selectIn(path, 6).insertText('XY '));
      t.b.update(() => $selectIn(path, 0, 2).removeText());
      await t.sync();
      t.c.update(() => $selectIn(path, 5).insertText('kc1z '));
      await t.sync();
    },
    third: true,
  },
  join: {
    // Delete at the end of the line: the next line joins it.
    $edit: path => $block(path).selectEnd().deleteCharacter(false),
    promise: () => 'read',
  },
  // A comment as a MarkNode around the word: the word moves into it.
  mark: {
    $edit: path =>
      $wrapSelectionInMarkNode($selectIn(path, 6, 10), false, 'm1'),
    promise: () => 'read',
  },
  // Paragraphs pasted into the line, then a word typed in them (S7-28).
  paste: {
    $edit: path => {
      $selectIn(path, 6).insertNodes([$p('pa1z pa2z'), $p('pb1z pb2z ')]);
      $getSelection()!.insertText('kb9z ');
    },
    promise: () => 'held',
  },

  'paste at the start': {
    $edit: path => {
      $selectIn(path, 0).insertNodes([$p('pa1z pa2z'), $p('pb1z pb2z ')]);
      $getSelection()!.insertText('kb9z ');
    },
    // Lines made before the line are read at once; Lexical makes a list
    // item pasted into at its start a paragraph, which is read with them.
    promise: shape => (shape.item ? 'read' : 'held'),
  },
  retype: {
    $edit: path =>
      $setBlocksType($selectIn(path, 0), () => $createHeadingNode('h2')),
    // A code line's text, code highlights, becomes plain text.
    promise: shape => (shape.highlight ? 'replaced' : 'held'),
  },
  split: {
    $edit: path => $selectIn(path, 11).insertParagraph(),
    promise: () => 'held',
  },
};

/** How the composition ends, or the local edit made while composing. */
export const ENDS = [
  'completed',
  'cancelled',
  'cut short by a blur',
  'Enter',
  'Shift+Enter',
  'Backspace across lines',
  'Delete across lines',
  'a paste',
  'a change of the line type',
] as const;

/** The local edits of the line's structure made while composing. */
const STRUCTURAL: ReadonlySet<string> = new Set([
  'Enter',
  'Shift+Enter',
  'Backspace across lines',
  'Delete across lines',
  'a paste',
  'a change of the line type',
]);

/** The nodes of line `key`: keys, types, formats and texts. */
function $lineShape(key: NodeKey): string {
  const line = $getNodeByKey(key) as ElementNode;
  const nodes: string[] = [`${line.getKey()}:${line.getType()}`];
  const walk = (node: LexicalNode) => {
    nodes.push(
      `${node.getKey()}:${node.getType()}:${
        $isTextNode(node) ? `${node.getFormat()}:${node.getTextContent()}` : ''
      }`,
    );
    if ($isElementNode(node)) {
      node.getChildren().forEach(walk);
    }
  };
  line.getChildren().forEach(walk);
  return nodes.join(' | ');
}

/** Whether a line (an element holding no block) satisfies `test`. */
function $hasLine(test: (line: ElementNode) => boolean): boolean {
  const walk = (node: LexicalNode): boolean =>
    $isElementNode(node) &&
    ((!node.isInline() && node !== $getRoot() && test(node)) ||
      node.getChildren().some(walk));
  return walk($getRoot());
}

/** Where the composed text is: the end of `gamma` in the composed node. */
function $composedAt(node: TextNode): number {
  return node.getTextContent().lastIndexOf('gamma') + 'gamma'.length;
}

export async function runCase(
  shape: Shape,
  remote: (typeof REMOTE)[string],
  end: (typeof ENDS)[number],
  ids: number[],
) {
  const t = await setup(shape.init, {
    ids: remote.third === true ? [...ids, 3] : ids,
    prepare: editor => {
      prepareMarkState(editor);
      if (shape.highlight) {
        registerCodeHighlighting(editor);
      }
    },
  });
  if (shape.prepare) {
    await shape.prepare(t);
  }
  const {path} = shape;
  // A starts composing at the end of "gamma".
  let key: NodeKey = '';
  t.a.update(() => {
    const [node, offset] = $locateIn($block(path), 16);
    node.select(offset, offset);
    $setCompositionKey(node.getKey());
    key = node.getKey();
  });
  let composed = '';
  const step = (next: string) =>
    t.a.update(() => {
      const node = $getNodeByKey(key) as TextNode;
      const at = $composedAt(node);
      const text = node.getTextContent();
      node.setTextContent(
        text.slice(0, at) + next + text.slice(at + composed.length),
      );
      node.select(at + next.length, at + next.length);
      composed = next;
    });
  step('k');
  await t.sync();
  step('か');
  await t.sync();
  const lineKey = t.a.read(() => $block(path).getKey());
  const before = t.a.read(() => $lineShape(lineKey));
  // B changes the line A composes in.
  if (remote.run !== undefined) {
    await remote.run(t, path);
  } else {
    t.b.update(() => remote.$edit!(path));
    await t.sync();
  }
  const promise = remote.promise(shape);
  if (promise === 'replaced') {
    // The composition goes on in the node of the new class.
    key = t.a.read(() => $locateIn($block(path), 0)[0].getKey());
  }
  t.a.read(() => {
    const node = $getNodeByKey(key);
    expect(node !== null && node.isAttached()).toBe(true);
    if (promise === 'held') {
      // The composed line keeps its nodes while composing.
      expect($lineShape(lineKey)).toBe(before);
    }
  });
  if (promise === 'replaced') {
    key = t.a.read(() =>
      $getRoot()
        .getAllTextNodes()
        .find(n => n.getTextContent().includes('gamma'))!
        .getKey(),
    );
  }
  step('かん');
  await t.sync();
  if (promise === 'held') {
    expect(t.a.read(() => $lineShape(lineKey))).toBe(
      before.replace('gammaか', 'gammaかん'),
    );
  }
  // B's change as B made it, which A must show in the end.
  const made = t.b.read(() => ({
    bold: $getRoot()
      .getAllTextNodes()
      .filter(n => n.hasFormat('bold'))
      .map(n => n.getTextContent())
      .join(''),
    centered: $hasLine(n => n.getFormatType() === 'center'),
    commented: $getRoot()
      .getAllTextNodes()
      .filter(n => $getNodeMarkIDs(n)?.includes('c1') === true)
      .map(n => n.getTextContent())
      .join(''),
    heading: $hasLine($isHeadingNode),
    marked: $getRoot()
      .getAllTextNodes()
      .filter(n => {
        const parent = n.getParent();
        return $isMarkNode(parent) && parent.getIDs().includes('m1');
      })
      .map(n => n.getTextContent())
      .join(''),
    text: $getRoot().getTextContent(),
  }));
  // The composition ends, or A edits the structure while composing.
  t.a.update(() => {
    const selection = $getSelection();
    const node = $getNodeByKey(key) as TextNode;
    const line = node.getParentOrThrow();
    const at = $composedAt(node);
    const text = node.getTextContent();
    if (end === 'completed') {
      node.setTextContent(text.slice(0, at) + '漢' + text.slice(at + 2));
      node.select(at + 1, at + 1);
    } else if (end === 'cancelled') {
      node.setTextContent(text.slice(0, at) + text.slice(at + 2));
      node.select(at, at);
    } else if (end === 'cut short by a blur') {
      $setSelection(null);
    } else if (!$isRangeSelection(selection)) {
      throw new Error('no caret');
    } else if (end === 'Enter') {
      selection.insertParagraph();
    } else if (end === 'Shift+Enter') {
      selection.insertLineBreak();
    } else if (end === 'Backspace across lines') {
      // At the start of the line: it joins the line before.
      const prev = line.getPreviousSibling();
      if ($isElementNode(prev)) {
        const first = line.getFirstChild();
        prev.append(...line.getChildren());
        line.remove();
        if ($isTextNode(first)) {
          first.select(0, 0);
        }
      }
    } else if (end === 'Delete across lines') {
      // At the end of the line: the line after joins it.
      const next = line.getNextSibling();
      if ($isElementNode(next)) {
        line.append(...next.getChildren());
        next.remove();
      }
    } else if (end === 'a paste') {
      selection.insertNodes([$p('P1'), $p('P2')]);
    } else {
      $setBlocksType(selection, () => $createHeadingNode('h3'));
    }
    if (!STRUCTURAL.has(end)) {
      $setCompositionKey(null);
    }
  });
  await t.sync();
  if (STRUCTURAL.has(end)) {
    // The composition goes on after the structural edit, and is committed.
    t.a.update(() => {
      const node = $getNodeByKey(key);
      if ($isTextNode(node) && node.isAttached()) {
        const at = $composedAt(node);
        const text = node.getTextContent();
        if (text.slice(at, at + 2) === 'かん') {
          node.setTextContent(text.slice(0, at) + '漢' + text.slice(at + 2));
          node.select(at + 1, at + 1);
        }
      }
      $setCompositionKey(null);
    });
    await t.sync();
  }
  await expectConverged(t.peers);
  // Nothing B did is lost.
  const final = t.a.read(() => $getRoot().getTextContent());
  const has = (s: string) => final.replace(/\n/g, '').includes(s);
  if (made.text.includes('XY')) {
    expect(has('XY')).toBe(true);
  }
  // Each word B or C pasted or typed shows once.
  for (const word of ['pa1z', 'pb2z', 'kb9z', 'kc1z', 'XY', '日本']) {
    const count = (text: string) => text.split(word).length - 1;
    expect(count(final)).toBe(count(made.text));
  }
  if (!made.text.includes('beta')) {
    expect(has('beta')).toBe(false);
  }
  // Comments, marks, formats and headings: as B made them (or as the
  // collaborators' edits left them, the same on every client).
  const texts = (peer: Peer, keep: (node: TextNode) => boolean) =>
    peer.read(() =>
      $getRoot()
        .getAllTextNodes()
        .filter(keep)
        .map(n => n.getTextContent())
        .join('|'),
    );
  const $commented = (n: TextNode) =>
    $getNodeMarkIDs(n)?.includes('c1') === true;
  const marked = (n: TextNode) => {
    const parent = n.getParent();
    return $isMarkNode(parent) && parent.getIDs().includes('m1');
  };
  const bold = (n: TextNode) => n.hasFormat('bold');
  const inHeading = (n: TextNode) => $isHeadingNode(n.getTopLevelElement());
  for (const keep of [$commented, marked, bold, inHeading]) {
    expect(texts(t.a, keep)).toBe(texts(t.b, keep));
  }
  if (made.commented !== '') {
    expect(texts(t.a, $commented)).toContain('beta');
  }
  if (made.marked !== '') {
    expect(texts(t.a, marked)).toContain('beta');
  }
  if (made.bold !== '') {
    expect(texts(t.a, bold)).toContain('beta');
  }
  // B's alignment or type, on the composed line and nowhere else: on the
  // line that holds its text (Backspace at its start makes it part of the
  // line before, which keeps its own), not on the lines around it (the line
  // after joins it with Delete at its end).
  const joined = end === 'Backspace across lines';
  const lineOf = (word: string, test: (line: ElementNode) => boolean) =>
    t.a.read(() => {
      const text = $getRoot()
        .getAllTextNodes()
        .find(n => n.getTextContent().includes(word));
      const line =
        text === undefined
          ? null
          : $findMatchingParent(text, n => $isElementNode(n) && !n.isInline());
      return line !== null && test(line as ElementNode);
    });
  for (const [made_, test] of [
    [made.heading, (line: ElementNode) => $isHeadingNode(line)],
    [made.centered, (line: ElementNode) => line.getFormatType() === 'center'],
  ] as const) {
    if (made_) {
      expect(lineOf('alpha', test)).toBe(!joined);
      expect(lineOf('pre', test)).toBe(false);
      if (end !== 'Delete across lines') {
        expect(lineOf('omega', test)).toBe(false);
      }
    }
  }
  if (end === 'completed') {
    expect(has('漢')).toBe(true);
  } else if (end === 'cancelled') {
    expect(final.includes('か')).toBe(false);
  }
}
