/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Contract C10: splitting and joining the lines of every block type, in
// every place the catalog puts one, while other peers type in the text the
// edit moves. For each catalog shape, every line that holds plain text is a
// target, one per place (its type and the types of its ancestors, with `*`
// for a shadow root). Three peers make concurrent edits, delivered in a
// seeded random order: A splits the line (Enter) or joins it with the next
// one (Backspace at the start of the second, Delete at the end of the
// first), B and C type in the text around the edit. Every peer and a fresh
// reader must show what one editor shows after the same edits made one
// after another (the typing first): no typed character lost, duplicated or
// moved to another line, no text left outside its line, and every peer
// showing the same document.
//
// The generator is driven by the registered node classes, not a list: every
// registered element type is a target's line or ancestor, or an inline
// element inside a target's line, or listed in SKIPPED with the reason, and
// a decorator type is skipped with its reason. A new class that no shape
// builds fails here (and in NodeCatalog.test.ts).
//
// Also: no line class is stored as a node of its own in a container's
// sequence (lines are text ended by a marker). A node of its own holds one
// line's text, so a split or a join copies text from one node to another,
// and a peer's typing in the copied text is lost (see
// regressions/ShadowRootQuoteSplitJoin.test.ts).
//
// MATRIX_FULL=1 runs 40 seeds per target (default 3).

import * as Y from '@y/y';
import {
  $createRangeSelection,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $isTextNode,
  $setSelection,
  DecoratorNode,
  ElementNode,
  type LexicalNode,
  RootNode,
  type TextNode,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {describeStorage} from '../../..';
import {
  $appendShapes,
  CatalogNet,
  firstDifference,
  NODE_SHAPES,
  type NodeShape,
  prng,
} from '../../catalog';

const FULL = process.env.MATRIX_FULL === '1';
const SEEDS = FULL ? 40 : 3;
const LIMIT = 400;

/** Places with a known failure, each with what fixes it. */
const NESTED_INLINE =
  'an inline element stored as a node of its own (`nested`, not a format): Enter inside it makes a second node and copies the text after the caret into it, so typing there stays in the first (open, found by #9905)';
const OPEN: ReadonlyMap<string, string> = new Map([
  [
    'quote* > paragraph',
    'a quote that is a shadow root is stored as a line whose paragraphs are nodes of their own (regressions/ShadowRootQuoteSplitJoin.test.ts); fixed by the follow-up layout 5 pull request',
  ],
  ['paragraph > overflow', NESTED_INLINE],
  ['paragraph > autolink', NESTED_INLINE],
  ['paragraph > mark', NESTED_INLINE],
]);

/** Registered element types no target reaches, with the reason. */
const SKIPPED: ReadonlyMap<string, string> = new Map([
  [
    'artificial',
    'internal to the DOM import of lexical; never in an editor state',
  ],
  ['review', "the catalog's review holds no text (an empty body and slot)"],
]);

/** A step from a node to one of its children: an index, or a slot name. */
type Step = number | string;

type Target = {
  /** The line's type and its ancestors' types, outermost first. */
  place: string;
  shape: NodeShape;
  /** From the root to the line. */
  path: Step[];
  /**
   * The plain text typed in, from the line: the index of a child of the
   * line, then for text inside an inline element, its index there.
   */
  textAt: number[];
};

const nets: CatalogNet[] = [];
afterEach(() => {
  for (const n of nets.splice(0)) {
    n.dispose();
  }
});

const elide = (json: unknown) =>
  JSON.parse(JSON.stringify(json), (key, value) =>
    key === 'editorState' && value !== null && typeof value === 'object'
      ? '(nested editor)'
      : value,
  );

const label = (node: LexicalNode) =>
  node.getType() +
  ($isElementNode(node) && !node.isInline() && node.isShadowRoot() ? '*' : '');

function $resolve(path: readonly Step[]): LexicalNode {
  let node: LexicalNode = $getRoot();
  for (const step of path) {
    const next: LexicalNode | null =
      typeof step === 'number'
        ? (node as ElementNode).getChildAtIndex(step)
        : $getSlot(node, step);
    if (next === null) {
      throw new Error(`no node at ${path.join('/')}`);
    }
    node = next;
  }
  return node;
}

function $children(node: LexicalNode): [Step, LexicalNode][] {
  const out: [Step, LexicalNode][] = [];
  if ($isElementNode(node)) {
    node.getChildren().forEach((c, i) => out.push([i, c]));
  }
  for (const name of $getSlotNames(node)) {
    const slot = $getSlot(node, name);
    if (slot !== null) {
      out.push([name, slot]);
    }
  }
  return out;
}

/** The index of a child of `line` that is plain text of 4 or more. */
function $plainTextIndex(line: ElementNode): number {
  return line
    .getChildren()
    .findIndex(
      c =>
        $isTextNode(c) &&
        c.getType() === 'text' &&
        c.isSimpleText() &&
        c.getTextContentSize() >= 4,
    );
}

/** Every target of every shape, one per place, and what they reach. */
function collectTargets(): {
  targets: Target[];
  reached: Set<string>;
  registered: Map<string, 'element' | 'decorator'>;
} {
  const targets: Target[] = [];
  const errors: string[] = [];
  const reached = new Set<string>();
  const registered = new Map<string, 'element' | 'decorator'>();
  const registry = new CatalogNet('y');
  for (const [type, {klass}] of registry.add('registry').editor._nodes) {
    if (klass.prototype instanceof RootNode || klass === RootNode) {
      continue;
    }
    if (klass.prototype instanceof DecoratorNode) {
      registered.set(type, 'decorator');
    } else if (klass.prototype instanceof ElementNode) {
      registered.set(type, 'element');
    }
  }
  registry.dispose();
  const places = new Set<string>();
  for (const shape of NODE_SHAPES) {
    // A peer per shape: a peer that built another shape before reads this
    // one's slots as it found them then.
    const net = new CatalogNet('y');
    const peer = net.add('collect');
    peer.update(() => {
      $getRoot().clear();
      $appendShapes([shape]);
      const walk = (node: LexicalNode, path: Step[], above: string[]) => {
        for (const [step, child] of $children(node)) {
          const here = [
            ...above,
            (typeof step === 'string' ? `[${step}] ` : '') + label(child),
          ];
          // A decorator holds text only in its slots.
          if ($isElementNode(child) && !child.isInline()) {
            const linePath = [...path, step];
            const textIndex = $plainTextIndex(child);
            const inlines = child
              .getChildren()
              .filter(c => $isElementNode(c) && c.isInline())
              .map(c => c.getType());
            const place =
              here.join(' > ') +
              (inlines.length > 0
                ? `[${[...new Set(inlines)].join(',')}]`
                : '');
            const add = (at: string, textAt: number[], types: string[]) => {
              if (!places.has(at)) {
                places.add(at);
                targets.push({path: linePath, place: at, shape, textAt});
                for (const t of types) {
                  reached.add(t.replace(/^\[.*\] /, '').replace(/\*$/, ''));
                }
              }
            };
            if (textIndex >= 0) {
              add(place, [textIndex], here);
            }
            // Text inside each inline element of the line (a link, a
            // comment): a target of its own.
            child.getChildren().forEach((c, i) => {
              if ($isElementNode(c) && c.isInline()) {
                const j = $plainTextIndex(c);
                if (j >= 0) {
                  add(
                    `${here.join(' > ')} > ${c.getType()}`,
                    [i, j],
                    [...here, c.getType()],
                  );
                }
              }
            });
          }
          walk(child, [...path, step], here);
        }
      };
      walk($getRoot(), [], []);
    });
    errors.push(...peer.errors.map(String));
    net.dispose();
  }
  if (errors.length > 0) {
    throw new Error(`collecting targets threw: ${errors.join('; ')}`);
  }
  return {reached, registered, targets};
}

type Scenario = 'split' | 'join-backspace' | 'join-delete';
const SCENARIOS: readonly Scenario[] = [
  'split',
  'join-backspace',
  'join-delete',
];

function $caret(text: TextNode, offset: number) {
  const selection = $createRangeSelection();
  selection.anchor.set(text.getKey(), offset, 'text');
  selection.focus.set(text.getKey(), offset, 'text');
  // Typing continues the text's format and style.
  selection.format = text.getFormat();
  selection.style = text.getStyle();
  $setSelection(selection);
  return selection;
}

function $textOf(path: readonly Step[], textAt: readonly number[]): TextNode {
  let node: LexicalNode | null = $resolve(path);
  for (const i of textAt) {
    node = $isElementNode(node) ? node.getChildAtIndex(i) : null;
  }
  if (!$isTextNode(node)) {
    throw new Error(`no text at ${path.join('/')}#${textAt.join('/')}`);
  }
  return node;
}

/** The first text of the line after the target, when it is plain text. */
function $secondText(path: readonly Step[]): TextNode | null {
  const next = ($resolve(path) as ElementNode).getNextSibling();
  const text =
    $isElementNode(next) && !next.isInline() ? next.getFirstChild() : null;
  return $isTextNode(text) && text.getType() === 'text' && text.isSimpleText()
    ? text
    : null;
}

const B_TYPES = '\u00a7b';
const C_TYPES = '\u00a7c';

type Plan = {
  /** Split the target in half before the race (the two lines to join). */
  prepare: boolean;
  /** The structural edit, made by A. */
  $edit: () => void;
  /** The same edit made after the typing, by the oracle's one editor. */
  $editAfterTyping: () => void;
  $typeB: () => void;
  $typeC: () => void;
};

function planFor(
  target: Target,
  scenario: Scenario,
  rand: () => number,
  size: number,
): Plan {
  const {path, textAt} = target;
  const at = (lo: number, hi: number) =>
    lo + Math.floor(rand() * (hi - lo + 1));
  const $first = () => $textOf(path, textAt);
  if (scenario === 'split') {
    // Inside the text: at an edge, typing can go to a neighbour.
    const s = at(2, size - 2);
    const o = at(s + 1, size - 1);
    const c = at(1, s - 1);
    return {
      $edit: () => {
        $caret($first(), s).insertParagraph();
      },
      $editAfterTyping: () => {
        $caret($first(), s + C_TYPES.length).insertParagraph();
      },
      $typeB: () => {
        $caret($first(), o).insertText(B_TYPES);
      },
      $typeC: () => {
        $caret($first(), c).insertText(C_TYPES);
      },
      prepare: false,
    };
  }
  const half = Math.floor(size / 2);
  const j = at(1, half - 1);
  const k = at(1, size - half - 1);
  const $join = () => {
    if (scenario === 'join-backspace') {
      $caret($secondText(path)!, 0).deleteCharacter(true);
    } else {
      const t = $first();
      $caret(t, t.getTextContentSize()).deleteCharacter(false);
    }
  };
  return {
    $edit: $join,
    $editAfterTyping: $join,
    $typeB: () => {
      $caret($secondText(path)!, k).insertText(B_TYPES);
    },
    $typeC: () => {
      $caret($first(), j).insertText(C_TYPES);
    },
    prepare: true,
  };
}

function $init(target: Target, prepare: boolean) {
  $getRoot().clear();
  $appendShapes([target.shape]);
  if (prepare) {
    const text = $textOf(target.path, target.textAt);
    $caret(text, Math.floor(text.getTextContentSize() / 2)).insertParagraph();
  }
}

function newPeers(count: number, $prepare: () => void) {
  const net = new CatalogNet('y');
  nets.push(net);
  const peers = Array.from({length: count}, (_, i) =>
    net.add(String.fromCharCode(65 + i)),
  );
  const [a] = peers;
  a.update($prepare);
  if (a.yBinding !== null) {
    a.yBinding.initialize();
    a.flush();
  }
  const opened = net.settle(LIMIT);
  if (opened.left > 0) {
    throw new Error(`opening did not settle: ${JSON.stringify(opened)}`);
  }
  return {net, peers};
}

/** The target's plain text from offset 2 (what Enter at 2 takes away). */
function text2(target: Target): string {
  const net = new CatalogNet('y');
  try {
    const peer = net.add('probe');
    peer.update(() => $init(target, false));
    return peer.editor.read(() =>
      $textOf(target.path, target.textAt).getTextContent().slice(2),
    );
  } finally {
    net.dispose();
  }
}

/**
 * Why `scenario` cannot run on `target` (null: it can). A split needs Enter
 * to split the line; a join needs two lines after Enter in the middle of the
 * text, the first ending with the text and the second starting with plain
 * text, where the peers type.
 */
function whyNot(target: Target, scenario: Scenario): string | null {
  const net = new CatalogNet('y');
  const type = target.place.split(' > ').pop();
  try {
    const peer = net.add('probe');
    if (scenario === 'split') {
      // Enter must split the line: the text after the caret goes to a new
      // line. Where the type moves it into a line that exists (a move),
      // typing in it is lost wherever the text is stored (see Limits).
      peer.update(() => $init(target, false));
      const tail = text2(target);
      const before = new Set(peer.editor.getEditorState()._nodeMap.keys());
      const lineKey = peer.editor.read(() => $resolve(target.path).getKey());
      peer.update(() => {
        $caret($textOf(target.path, target.textAt), 2).insertParagraph();
      });
      return peer.editor.read(() => {
        const text = [...peer.editor.getEditorState()._nodeMap.values()].find(
          n =>
            $isTextNode(n) &&
            n.isAttached() &&
            n.getTextContent().endsWith(tail),
        );
        let line = text === undefined ? null : text.getParent();
        while ($isElementNode(line) && line.isInline()) {
          line = line.getParent();
        }
        return line !== null &&
          before.has(line.getKey()) &&
          line.getKey() !== lineKey
          ? `Enter inside ${type} moves the text after the caret into a line that exists (a move, not a split)`
          : null;
      });
    }
    peer.update(() => $init(target, true));
    return peer.editor.read(() => {
      const first = $textOf(target.path, target.textAt);
      const line = $resolve(target.path) as ElementNode;
      if (!line.getLastChild()!.is(first) || first.getTextContentSize() < 2) {
        return `after Enter in the middle of the text, the first line does not end with it`;
      }
      const second = $secondText(target.path);
      if (second === null || second.getTextContentSize() < 2) {
        return `Enter inside ${type} does not make a second line starting with plain text`;
      }
      return null;
    });
  } finally {
    net.dispose();
  }
}

/** What a run shows that it should not; empty when it passes. */
function run(target: Target, scenario: Scenario, seed: number): string[] {
  const rand = prng(seed);
  const size = (() => {
    const {peers} = newPeers(1, () => $init(target, false));
    return peers[0].editor.read(() =>
      $textOf(target.path, target.textAt).getTextContentSize(),
    );
  })();
  const plan = planFor(target, scenario, rand, size);

  // The oracle: one editor, the typing first, then the edit.
  const oracle = newPeers(1, () => $init(target, plan.prepare)).peers[0];
  oracle.update(plan.$typeB);
  oracle.update(plan.$typeC);
  oracle.update(plan.$editAfterTyping);
  const expected = elide(oracle.json());

  const {net, peers} = newPeers(3, () => $init(target, plan.prepare));
  const [a, b, c] = peers;
  a.update(plan.$edit);
  b.update(plan.$typeB);
  c.update(plan.$typeC);
  const settled = net.settle(LIMIT, length => Math.floor(rand() * length));
  const out: string[] = [];
  if (settled.left > 0) {
    out.push(`did not settle: ${settled.left} messages left`);
  }
  const freshNet = new CatalogNet('y');
  nets.push(freshNet);
  // Client ids are per network (1000 on): the fresh reader takes one that
  // none of the three peers has.
  for (const p of peers) {
    freshNet.add(`unused ${p.name}`);
  }
  const fresh = freshNet.add('fresh');
  fresh.apply(Y.encodeStateAsUpdate(a.doc as Y.Doc));
  for (const p of [...peers, oracle, fresh]) {
    for (const e of p.errors) {
      out.push(`${p.name} error: ${String(e).slice(0, 200)}`);
    }
    for (const w of p.warnings.filter(x => x.includes('self-check'))) {
      out.push(`${p.name}: ${w.slice(0, 200)}`);
    }
  }
  for (const p of [...peers, fresh]) {
    const text = p.editor.read(() => $getRoot().getTextContent());
    for (const typed of [B_TYPES, C_TYPES]) {
      const n = text.split(typed).length - 1;
      if (n !== 1) {
        out.push(`${p.name} shows ${JSON.stringify(typed)} ${n} times`);
      }
    }
    const d = firstDifference(elide(p.json()), expected);
    if (d !== null) {
      out.push(`${p.name} differs from one editor at ${d}`);
    }
  }
  return out;
}

const COLLECTED = collectTargets();

describe('C10: split and join of every line type ‖ typing in the moved text', () => {
  test('every registered element type is reached or skipped with a reason', () => {
    const {reached, registered} = COLLECTED;
    const missing: string[] = [];
    for (const [type, kind] of registered) {
      if (kind === 'element' && !reached.has(type) && !SKIPPED.has(type)) {
        missing.push(type);
      }
    }
    expect(missing).toEqual([]);
    // A skipped type that a target reaches is no longer skipped.
    expect([...SKIPPED.keys()].filter(t => reached.has(t))).toEqual([]);
  });

  for (const target of COLLECTED.targets) {
    for (const scenario of SCENARIOS) {
      const reason = whyNot(target, scenario);
      const name = `${target.place} (${target.shape.name}), ${scenario}`;
      if (reason !== null) {
        test.skip(`${name}: ${reason}`, () => {});
        continue;
      }
      for (let seed = 1; seed <= SEEDS; seed++) {
        (OPEN.has(target.place) ? test.fails : test)(
          `${name}, seed ${seed}`,
          () => {
            expect(run(target, scenario, seed)).toEqual([]);
          },
        );
      }
    }
  }
});

describe('C10: no line class is stored as a node of its own in a sequence', () => {
  for (const shape of NODE_SHAPES) {
    const open = shape.name === 'quote/shadow-root';
    (open ? test.fails : test)(shape.name, () => {
      const {peers} = newPeers(1, () => {
        $getRoot().clear();
        $appendShapes([shape]);
      });
      const [a] = peers;
      const kinds = describeStorage(a.editor, a.yBinding!);
      const found: string[] = [];
      const walk = (node: Y.Node, where: string) => {
        for (const child of node.toArray()) {
          if (!(child instanceof Y.Node)) {
            continue;
          }
          const name = child.name ?? '';
          const m = /^[bi]:(.*)$/.exec(name);
          if (m !== null && kinds[m[1]] === 'line') {
            found.push(`${where} > ${name}`);
          }
          walk(child, `${where} > ${name}`);
        }
        for (const [key, value] of Object.entries(node.getAttrs())) {
          if (key.startsWith('slot:') && value instanceof Y.Node) {
            walk(value, `${where} > ${key}`);
          }
        }
      };
      walk(a.yBinding!.root, 'root');
      expect(found).toEqual([]);
    });
  }
});
