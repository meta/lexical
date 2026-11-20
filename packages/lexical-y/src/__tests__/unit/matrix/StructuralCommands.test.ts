/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Structural commands in block containers, where node structure is enforced
// (NodeStructureExtension in an unbound editor, and an editor bound with
// @lexical/y, which always enforces it): list conversion of each type, Enter
// in an empty last list item, pasting two paragraphs mid-text, inserting a
// horizontal rule at the nearest root, wrapping in a quote, the markdown
// block shortcuts, and Backspace and Delete at a container's edges, in the
// root, a container that declares nothing (`plain`), one that declares
// `children: 'block'` (`declared`), a shadow root, each nested in one of its
// own kind, a shadow root in a named slot of a block decorator, the
// downstream component's undeclared slot and a slot host's declared slot;
// unbound with NodeStructureExtension, and bound in every bind mode, also
// followed by a full reconcile. (A read-only document takes no commands.)
//
// The expected outcome of each cell comes from a model of the rule (a
// container acts as a root for these commands when it is a shadow root, or a
// class declaring `children: 'block'`), checked with predicates on the
// result, not from another tree's output.

import {$isCodeNode, CodeExtension} from '@lexical/code-core';
import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  buildEditorFromExtensions,
  HorizontalRuleExtension,
  HorizontalRuleNode,
  NodeStructureExtension,
} from '@lexical/extension';
import {LinkExtension} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  $isListItemNode,
  $isListNode,
  ListExtension,
  type ListType,
} from '@lexical/list';
import {
  type ElementTransformer,
  registerMarkdownShortcuts,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {$wrapNodes} from '@lexical/selection';
import {$insertNodeToNearestRoot} from '@lexical/utils';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $fullReconcile,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSlot,
  DecoratorNode,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  ElementNode,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$createSlotContainerNode} from '../../../../../lexical-playground/src/nodes/SlotContainerNode';
import {PullQuoteNode} from '../../../../../lexical-playground/src/plugins/PullQuoteExtension/PullQuoteNode';
import {seedYState} from '../../../headless';
import {
  bindFresh,
  type BindMode,
  type BoundEditor,
  catalogAppExtension,
  catalogHeadlessConfig,
  DEFAULT_CONFIG,
  NODE_SHAPES,
} from '../../catalog';
import {$createDownstreamComponent} from '../../catalog/downstream';

class PlainBoxNode extends ElementNode {
  $config() {
    return this.config('catalog_plain_box', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
}
class DeclaredBoxNode extends ElementNode {
  $config() {
    return this.config('catalog_declared_box', {
      children: 'block',
      extends: ElementNode,
    });
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
}
class ShadowBoxNode extends ElementNode {
  $config() {
    return this.config('catalog_shadow_box', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
}
class SlotHostNode extends DecoratorNode<null> {
  $config() {
    return this.config('catalog_slot_host', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/** The `---` shortcut, as apps with horizontal rules add it. */
const HR_SHORTCUT: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  export: () => null,
  regExp: /^(---|\*\*\*|___)\s?$/,
  replace: parentNode => {
    const line = $createHorizontalRuleNode();
    if (parentNode.getNextSibling() !== null) {
      parentNode.replace(line);
    } else {
      parentNode.insertBefore(line);
    }
    line.selectNext();
  },
  type: 'element',
};

const BOX_NODES = [PlainBoxNode, DeclaredBoxNode, ShadowBoxNode, SlotHostNode];

/** The boxes, for a document seeded headless. */
const BoxNodes = defineExtension({
  name: 'catalog-structure-nodes',
  nodes: () => BOX_NODES,
});

/** What an editing app adds: rich text, rules, code, and the shortcuts. */
const EditingApp = defineExtension({
  dependencies: [
    BoxNodes,
    RichTextExtension,
    ListExtension,
    LinkExtension,
    CodeExtension,
    HorizontalRuleExtension,
  ],
  name: 'catalog-structure-editing',
  register: editor =>
    registerMarkdownShortcuts(editor, [...TRANSFORMERS, HR_SHORTCUT]),
});

type Kind =
  | 'root'
  | 'plain'
  | 'declared'
  | 'shadow'
  | 'slot'
  | 'component slot'
  | 'declared slot';
type Ctx = {kind: Kind; nested: boolean};
const CTXS: Ctx[] = [
  {kind: 'root', nested: false},
  ...(['plain', 'declared', 'shadow'] as const).flatMap(kind => [
    {kind, nested: false},
    {kind, nested: true},
  ]),
  {kind: 'slot', nested: false},
  {kind: 'component slot', nested: false},
  {kind: 'declared slot', nested: false},
];
const CTX_NAME: Record<Kind, string> = {
  'component slot': "the downstream component's undeclared slot",
  declared: 'declared',
  'declared slot': "a slot host's declared slot (a shadow root container)",
  plain: 'plain',
  root: 'root',
  shadow: 'shadow',
  slot: 'a shadow root in a named slot',
};
const ctxName = (c: Ctx) =>
  c.nested ? `${c.kind} in ${c.kind}` : CTX_NAME[c.kind];
const TYPE: Record<Kind, string> = {
  'component slot': 'catalog_downstream_component_slot',
  declared: 'catalog_declared_box',
  'declared slot': 'slot-container',
  plain: 'catalog_plain_box',
  root: 'root',
  shadow: 'catalog_shadow_box',
  slot: 'catalog_shadow_box',
};
/** Contexts whose container is a shadow root (an editing edge too). */
const SHADOW: Kind[] = ['shadow', 'slot', 'component slot', 'declared slot'];

function $box(
  kind: 'plain' | 'declared' | 'shadow',
  ...children: LexicalNode[]
) {
  const box =
    kind === 'plain'
      ? new PlainBoxNode()
      : kind === 'declared'
        ? new DeclaredBoxNode()
        : new ShadowBoxNode();
  return box.append(...children);
}

const $p = (text: string) =>
  text === ''
    ? $createParagraphNode()
    : $createParagraphNode().append($createTextNode(text));

/** p("before") / CONTAINER(...inner) / p("after"). */
function $build(ctx: Ctx, inner: () => LexicalNode[]) {
  const root = $getRoot().clear();
  const before = $p('before');
  const after = $p('after');
  switch (ctx.kind) {
    case 'root':
      root.append(before, ...inner(), after);
      return;
    case 'slot': {
      const host = new SlotHostNode();
      root.append(before, host, after);
      $setSlot(host, 'body', $box('shadow', ...inner()));
      return;
    }
    case 'component slot':
      root.append(
        before,
        $createDownstreamComponent('callout', {body: inner()}),
        after,
      );
      return;
    case 'declared slot': {
      const host = $create(PullQuoteNode);
      root.append(before, host, after);
      $setSlot(host, 'quote', $createSlotContainerNode().append(...inner()));
      return;
    }
    default: {
      const box = ctx.nested
        ? $box(ctx.kind, $box(ctx.kind, ...inner()))
        : $box(ctx.kind, ...inner());
      root.append(before, box, after);
    }
  }
}

function $all(keep: (n: LexicalNode) => boolean): LexicalNode[] {
  const out: LexicalNode[] = [];
  const walk = (n: LexicalNode) => {
    if (keep(n)) {
      out.push(n);
    }
    for (const name of $getSlotNames(n)) {
      const slot = $getSlot(n, name);
      if (slot !== null) {
        walk(slot);
      }
    }
    if ($isElementNode(n)) {
      n.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

const $text = (s: string) =>
  $all(n => $isTextNode(n) && n.getTextContent().includes(s))[0] as
    | TextNode
    | undefined;

const $caret = (s: string, offset: number) => $text(s)!.select(offset, offset);

/** The innermost container of the context (the root for `root`). */
function $container(ctx: Ctx): ElementNode | undefined {
  if (ctx.kind === 'root') {
    return $getRoot();
  }
  const boxes = $all(n => n.getType() === TYPE[ctx.kind]) as ElementNode[];
  return ctx.nested ? boxes[1] : boxes[0];
}

const $count = (ctx: Ctx) =>
  ctx.kind === 'root' ? 1 : $all(n => n.getType() === TYPE[ctx.kind]).length;

type Outcome =
  | 'in place'
  | 'not in place'
  | 'no list'
  | 'blocked at the edge'
  | 'joins across the edge';

type Cmd = {
  name: string;
  kind: 'structural' | 'list' | 'edge';
  inner: () => LexicalNode[];
  run: (editor: LexicalEditor) => void;
  type?: string;
  $check: (ctx: Ctx, before: number) => string;
};

/**
 * The rule (#9590): where structure is enforced, a shadow root or a class
 * declaring `children: 'block'` is a block container, so structural
 * commands act inside it; a container that declares nothing is one more
 * block, except that in a box inside a box (#9570) the paragraph holding
 * the selected text becomes a list in place. Only a shadow root is an
 * editing edge: Backspace and Delete cross the edges of every other
 * container.
 */
function model(cmd: Cmd, ctx: Ctx): Outcome {
  if (cmd.kind === 'edge') {
    return SHADOW.includes(ctx.kind)
      ? 'blocked at the edge'
      : 'joins across the edge';
  }
  if (
    ctx.kind === 'root' ||
    SHADOW.includes(ctx.kind) ||
    ctx.kind === 'declared'
  ) {
    return 'in place';
  }
  if (cmd.kind === 'list' && ctx.nested) {
    return 'in place';
  }
  return 'not in place';
}

const $paras = () => [$p('abc'), $p('def')];

/** An empty paragraph to type a shortcut into, before p("def"). */
const $emptyFirst = () => [$p(''), $p('def')];
const $selectEmpty = () =>
  (
    $all(
      n => $isParagraphNode(n) && n.getTextContent() === '',
    )[0] as ElementNode
  ).select(0, 0);

/** The text of every paragraph, in document order. */
const $paragraphs = () => $all($isParagraphNode).map(n => n.getTextContent());

/**
 * An edge row's outcome: blocked (every paragraph as it was, `inside` still
 * in the container) or joined (the two paragraphs at the edge are one,
 * `joined`, and the other paragraphs are as they were); anything else is
 * described as is.
 */
function $edge(
  ctx: Ctx,
  texts: string[],
  joined: string,
  inside: string,
): string {
  const now = $paragraphs();
  if (
    JSON.stringify(now) === JSON.stringify(texts) &&
    $all($isParagraphNode)
      .find(n => n.getTextContent() === inside)
      ?.getParent() === $container(ctx)
  ) {
    return 'blocked at the edge';
  }
  const expected = joined.startsWith('before')
    ? [joined, ...texts.slice(2)]
    : [...texts.slice(0, 2), joined];
  if (JSON.stringify(now) === JSON.stringify(expected)) {
    return 'joins across the edge';
  }
  return `paragraphs ${JSON.stringify(now)}`;
}

/** `made` is inside the container, which is still there, once. */
function $inside(
  ctx: Ctx,
  before: number,
  made: LexicalNode | undefined,
): Outcome {
  const container = $container(ctx);
  return container !== undefined &&
    made !== undefined &&
    $count(ctx) === before &&
    made.getParent() === container
    ? 'in place'
    : 'not in place';
}

const CMDS: Cmd[] = [
  ...(['bullet', 'number', 'check'] as const).map(
    (type: ListType): Cmd => ({
      $check: (ctx, before) => {
        const lists = $all(n => $isListNode(n) && n.getListType() === type);
        if (lists.length === 0) {
          return 'no list';
        }
        const list = lists.find(l => l.getTextContent().includes('abc'));
        const def = $text('def')?.getParent();
        return $inside(ctx, before, list) === 'in place' &&
          !list!.getTextContent().includes('def') &&
          $isParagraphNode(def) &&
          def.getParent() === $container(ctx)
          ? 'in place'
          : 'not in place';
      },
      inner: $paras,
      kind: 'list',
      name: `$insertList('${type}')`,
      run: () => {
        $caret('abc', 1);
        $insertList(type);
      },
    }),
  ),
  {
    $check: (ctx, before) => {
      const list = $all($isListNode)[0] as ElementNode | undefined;
      if (list === undefined || $inside(ctx, before, list) !== 'in place') {
        return 'not in place';
      }
      const next = list.getNextSibling();
      return list.getChildren().filter($isListItemNode).length === 1 &&
        $isParagraphNode(next) &&
        next.getTextContent() === ''
        ? 'in place'
        : 'not in place';
    },
    inner: () => [
      $createListNode('bullet').append(
        $createListItemNode().append($createTextNode('abc')),
        $createListItemNode(),
      ),
    ],
    kind: 'structural',
    name: 'Enter in an empty last list item',
    run: editor => {
      const items = $all($isListItemNode);
      (items[items.length - 1] as ElementNode).select(0, 0);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    },
  },
  {
    $check: (ctx, before) => {
      const x = $text('X')?.getParent();
      const y = $text('Y')?.getParent();
      return x !== y &&
        $inside(ctx, before, x ?? undefined) === 'in place' &&
        y?.getParent() === $container(ctx)
        ? 'in place'
        : 'not in place';
    },
    inner: $paras,
    kind: 'structural',
    name: 'insertNodes of two paragraphs mid-text',
    run: () => {
      $caret('abc', 1);
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.insertNodes([$p('X'), $p('Y')]);
      }
    },
  },
  {
    $check: (ctx, before) =>
      $inside(ctx, before, $all($isHorizontalRuleNode)[0]),
    inner: $paras,
    kind: 'structural',
    name: '$insertNodeToNearestRoot(horizontal rule)',
    run: () => {
      $caret('abc', 1);
      $insertNodeToNearestRoot($createHorizontalRuleNode());
    },
  },
  {
    $check: (ctx, before) =>
      $inside(
        ctx,
        before,
        $all(n => $isQuoteNode(n) && n.getTextContent().includes('abc'))[0],
      ),
    inner: $paras,
    kind: 'structural',
    name: '$wrapNodes in a quote',
    run: () => {
      $caret('abc', 1);
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $wrapNodes(selection, () => $createQuoteNode());
      }
    },
  },
  ...(
    [
      ['# ', (n: LexicalNode) => $isHeadingNode(n)],
      ['- ', (n: LexicalNode) => $isListNode(n)],
      ['> ', (n: LexicalNode) => $isQuoteNode(n)],
    ] as const
  ).map(
    ([shortcut, is]): Cmd => ({
      $check: (ctx, before) =>
        $inside(
          ctx,
          before,
          $all(n => is(n) && n.getTextContent().includes('abc'))[0],
        ),
      inner: $paras,
      kind: 'structural',
      name: `markdown "${shortcut}"`,
      run: () => $caret('abc', 0),
      type: shortcut,
    }),
  ),
  ...(
    [
      ['--- ', (n: LexicalNode) => $isHorizontalRuleNode(n)],
      ['``` ', (n: LexicalNode) => $isCodeNode(n)],
    ] as const
  ).map(
    ([shortcut, is]): Cmd => ({
      $check: (ctx, before) => $inside(ctx, before, $all(is)[0]),
      inner: $emptyFirst,
      kind: 'structural',
      name: `markdown "${shortcut.trim()}"`,
      run: () => $selectEmpty(),
      type: shortcut,
    }),
  ),
  {
    $check: ctx =>
      $edge(ctx, ['before', 'abc', 'def', 'after'], 'beforeabc', 'abc'),
    inner: $paras,
    kind: 'edge',
    name: "Backspace at the start of the container's first block",
    run: editor => {
      $caret('abc', 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    },
  },
  {
    $check: ctx =>
      $edge(ctx, ['before', 'abc', 'def', 'after'], 'defafter', 'def'),
    inner: $paras,
    kind: 'edge',
    name: "Delete at the end of the container's last block",
    run: editor => {
      $caret('def', 3);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, false);
    },
  },
];

type Mode =
  | 'unbound, NodeStructureExtension'
  | BindMode
  | 'extension, then a full reconcile';
const MODES: Mode[] = [
  'unbound, NodeStructureExtension',
  'binding',
  'extension',
  'extension-then-sync',
  'extension, then a full reconcile',
];

const CONFIG = {...DEFAULT_CONFIG, dom: 'jsdom' as const};

function open(mode: Mode, ctx: Ctx, inner: () => LexicalNode[]) {
  if (mode === 'unbound, NodeStructureExtension') {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => $build(ctx, inner),
        dependencies: [
          catalogAppExtension(CONFIG),
          EditingApp,
          NodeStructureExtension,
        ],
        name: 'catalog-structure-unbound',
        onError: e => {
          throw e;
        },
      }),
    );
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    editor.setRootElement(root);
    return {
      dispose: () => {
        editor.setRootElement(null);
        root.remove();
        editor.dispose();
      },
      editor: editor as LexicalEditor,
      errors: [] as unknown[],
    };
  }
  const state = seedYState(
    catalogHeadlessConfig(CONFIG, {
      extensions: [catalogAppExtension(CONFIG), BoxNodes],
    }),
    () => $build(ctx, inner),
  );
  const bound: BoundEditor = bindFresh(
    state,
    CONFIG,
    mode === 'extension, then a full reconcile' ? 'extension' : mode,
    undefined,
    {extraNodes: [EditingApp]},
  );
  return bound;
}

describe('structural commands in block containers, where structure is enforced', () => {
  for (const cmd of CMDS) {
    for (const ctx of CTXS) {
      for (const mode of MODES) {
        const want = model(cmd, ctx);
        test(`${cmd.name} in ${ctxName(ctx)} [${mode}]: ${want}`, async () => {
          const opened = open(mode, ctx, cmd.inner);
          const {editor} = opened;
          try {
            await Promise.resolve();
            const before = editor.read(() => $count(ctx));
            editor.update(() => cmd.run(editor), {discrete: true});
            for (const ch of cmd.type ?? '') {
              editor.update(
                () => {
                  const selection = $getSelection();
                  if ($isRangeSelection(selection)) {
                    selection.insertText(ch);
                  }
                },
                {discrete: true},
              );
            }
            if (mode === 'extension, then a full reconcile') {
              editor.update(() => $fullReconcile(), {discrete: true});
            }
            await Promise.resolve();
            expect(opened.errors).toEqual([]);
            expect(editor.read(() => cmd.$check(ctx, before))).toBe(want);
          } finally {
            opened.dispose();
          }
        });
      }
    }
  }
});

// The same commands where they turn the selected paragraph into another
// block (a list item, a heading, a quote), with the paragraph's inline
// content varied over the catalog's inline shapes: text in its modes, tabs,
// line breaks, hashtags and other text subclasses, links, marks, overflow,
// and inline decorators. Whatever the container, the block the command
// makes holds all of the paragraph's inline content, in order: its text,
// and the same inline nodes, with nothing split out into another block
// (where a command does not act, the paragraph keeps it).
// (Code highlight nodes live only in code blocks, so they are not here.)
const INLINE_SHAPES = NODE_SHAPES.filter(s => s.$inline !== undefined);
const INLINE_CTXS = CTXS.filter(
  c => !c.nested && ['root', 'plain', 'declared', 'shadow'].includes(c.kind),
);
const INLINE_MODES: Mode[] = ['unbound, NodeStructureExtension', 'extension'];

/**
 * Where the selection is when the command runs: a caret in the text before
 * the inline content, a caret inside the inline content's own text (for
 * shapes that have a text node of their own), or the whole paragraph.
 */
type Where = 'caret before it' | 'caret inside it' | 'the whole paragraph';
const WHERE: Where[] = [
  'caret before it',
  'caret inside it',
  'the whole paragraph',
];

/**
 * Puts the caret one character into the inline content: at offset 5 of the
 * paragraph's text, "abc " being 4 characters. Located by offset in the
 * leaves as they are after normalization, since the shape's text can merge
 * with the text around it. False where that character is not in a text
 * node (an inline decorator's text).
 */
function $caretInside(): boolean {
  let offset = 'abc '.length + 1;
  const walk = (n: LexicalNode): boolean => {
    if ($isElementNode(n)) {
      return n.getChildren().some(walk);
    }
    const size = n.getTextContentSize();
    if (offset < size || (offset === size && $isTextNode(n))) {
      if (!$isTextNode(n)) {
        return false;
      }
      n.select(offset, offset);
      offset = -1;
      return true;
    }
    offset -= size;
    return false;
  };
  return walk($blockOfAbc()!) && offset === -1;
}

/** Selects as `where` says; false where the shape has no such place. */
function $select(where: Where): boolean {
  if (where === 'caret before it') {
    $caret('abc', 1);
    return true;
  }
  if (where === 'caret inside it') {
    return $caretInside();
  }
  const block = $blockOfAbc()!;
  const texts = block.getAllTextNodes();
  const first = texts[0];
  const last = texts[texts.length - 1];
  const selection = first.select(0, 0);
  selection.focus.set(last.getKey(), last.getTextContentSize(), 'text');
  return true;
}

type BlockCmd = {
  name: string;
  /** Whether `node` is the block the command makes. */
  made: (node: LexicalNode) => boolean;
  run: () => void;
  /** The shortcuts are typed at the paragraph's start; they take no range. */
  type?: string;
};

const BLOCK_CMDS: BlockCmd[] = [
  ...(['bullet', 'number', 'check'] as const).map(
    (type): BlockCmd => ({
      made: n =>
        $isListItemNode(n) &&
        $isListNode(n.getParent()) &&
        (
          n.getParent() as ElementNode & {getListType(): string}
        ).getListType() === type,
      name: `$insertList('${type}')`,
      run: () => $insertList(type),
    }),
  ),
  {
    made: n => $isQuoteNode(n),
    name: '$wrapNodes in a quote',
    run: () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $wrapNodes(selection, () => $createQuoteNode());
      }
    },
  },
  ...(
    [
      ['# ', (n: LexicalNode) => $isHeadingNode(n)],
      ['- ', (n: LexicalNode) => $isListItemNode(n)],
      ['> ', (n: LexicalNode) => $isQuoteNode(n)],
    ] as const
  ).map(
    ([typed, made]): BlockCmd => ({
      made,
      name: `markdown "${typed}"`,
      run: () => $caret('abc', 0),
      type: typed,
    }),
  ),
];

/** The inline content of a block: its text and its inline node types. */
function $inlineContent(block: ElementNode, typed = ''): string {
  const types: string[] = [];
  const walk = (n: LexicalNode) => {
    if (n !== block && n.getType() !== 'text') {
      types.push(n.getType());
    }
    if ($isElementNode(n)) {
      n.getChildren().forEach(walk);
    }
  };
  walk(block);
  const text = block.getTextContent();
  return JSON.stringify({
    text:
      typed !== '' && text.startsWith(typed) ? text.slice(typed.length) : text,
    types,
  });
}

/** The block element holding the text "abc". */
function $blockOfAbc(): ElementNode | null {
  let node: LexicalNode | null = $text('abc') ?? null;
  while (node !== null && !($isElementNode(node) && !node.isInline())) {
    node = node.getParent();
  }
  return node;
}

describe("structural commands keep the selected paragraph's inline content together", () => {
  for (const shape of INLINE_SHAPES) {
    for (const cmd of BLOCK_CMDS) {
      for (const where of cmd.type === undefined ? WHERE : WHERE.slice(0, 1)) {
        for (const ctx of INLINE_CTXS) {
          for (const mode of INLINE_MODES) {
            // An inline decorator has no text node to put the caret in.
            const skip =
              where === 'caret inside it' && shape.kind === 'inline-decorator';
            (skip ? test.skip : test)(
              `${cmd.name}, ${where}, on a paragraph with ${shape.name} in ${ctxName(ctx)} [${mode}]${skip ? ' (skipped: no text node inside the decorator)' : ''}`,
              async () => {
                const $inner = () => [
                  $createParagraphNode().append(
                    $createTextNode('abc '),
                    ...shape.$inline!(),
                    $createTextNode(' end'),
                  ),
                ];
                const opened = open(mode, ctx, $inner);
                const {editor} = opened;
                try {
                  await Promise.resolve();
                  const before = editor.read(() =>
                    $inlineContent($blockOfAbc()!),
                  );
                  let placed = true;
                  editor.update(
                    () => {
                      placed = cmd.type !== undefined || $select(where);
                      if (placed) {
                        cmd.run();
                      }
                    },
                    {discrete: true},
                  );
                  expect(placed).toBe(true);
                  for (const ch of cmd.type ?? '') {
                    editor.update(
                      () => {
                        const selection = $getSelection();
                        if ($isRangeSelection(selection)) {
                          selection.insertText(ch);
                        }
                      },
                      {discrete: true},
                    );
                  }
                  await Promise.resolve();
                  expect(opened.errors).toEqual([]);
                  const result = editor.read(() => {
                    const block = $blockOfAbc();
                    if (block === null) {
                      return 'no block holds "abc"';
                    }
                    // Where a shortcut does not act (in a container that declares
                    // nothing, and in a declared one without the rule), the
                    // paragraph stays as it was.
                    // A command given a selection always makes its block.
                    const made =
                      cmd.made(block) ||
                      cmd.made(block.getParent() as LexicalNode) ||
                      (cmd.type !== undefined && $isParagraphNode(block))
                        ? block
                        : null;
                    if (made === null) {
                      return `"abc" is in a ${block.getType()}, not the made block`;
                    }
                    // A shortcut that did not act leaves its typed text.
                    return cmd.type !== undefined &&
                      !cmd.made(made) &&
                      !cmd.made(made.getParent() as LexicalNode)
                      ? $inlineContent(made, cmd.type)
                      : $inlineContent(made);
                  });
                  expect(result).toBe(before);
                } finally {
                  opened.dispose();
                }
              },
            );
          }
        }
      }
    }
  }
});
