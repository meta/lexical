/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// What each structural command does in each kind of block container, with
// and without NodeStructureExtension: the root, a container that declares
// nothing (`box`), one that declares `children: 'block'` (`dbox`), a shadow
// root (`sbox`), each nested in one of its own kind (`2`), and a named slot
// holding a shadow root or a bare block. Every case starts from
// p("before") / CONTAINER / p("after"); the expected shapes leave out
// p("before") and p("after") when they are unchanged.

import {$createCodeNode, CodeExtension} from '@lexical/code-core';
import {
  $createHorizontalRuleNode,
  buildEditorFromExtensions,
  HorizontalRuleExtension,
  NodeStructureExtension,
} from '@lexical/extension';
import {LinkExtension} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  $removeList,
  ListExtension,
} from '@lexical/list';
import {registerMarkdownShortcuts} from '@lexical/markdown';
import {
  MdastCommonMarkExtension,
  MdastGfmExtension,
  MdastShortcutsExtension,
} from '@lexical/mdast';
import {$createOverflowNode, OverflowNode} from '@lexical/overflow';
import {
  $createHeadingNode,
  $createQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {$setBlocksType, $wrapNodes} from '@lexical/selection';
import {$insertNodeToNearestRoot} from '@lexical/utils';
import {
  $create,
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotNames,
  $isBlockContainer,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  $setSlot,
  configExtension,
  DecoratorNode,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  ElementNode,
  INDENT_CONTENT_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  OUTDENT_CONTENT_COMMAND,
  type RangeSelection,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

class PlainBoxNode extends ElementNode {
  $config() {
    return this.config('test_plain_box', {extends: ElementNode});
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
    return this.config('test_declared_box', {
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
    return this.config('test_shadow_box', {extends: ElementNode});
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
class ComponentNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_component', {extends: DecoratorNode});
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

type Ctx =
  | 'root'
  | 'plain'
  | 'plain2'
  | 'declared'
  | 'declared2'
  | 'shadow'
  | 'shadow2'
  | 'slot-shadow'
  | 'slot-bare';
const CTXS: Ctx[] = [
  'root',
  'plain',
  'plain2',
  'declared',
  'declared2',
  'shadow',
  'shadow2',
  'slot-shadow',
  'slot-bare',
];

function $box(
  kind: 'plain' | 'declared' | 'shadow',
  depth: number,
  inner: LexicalNode[],
): LexicalNode {
  const $make = (): ElementNode =>
    kind === 'plain'
      ? $create(PlainBoxNode)
      : kind === 'declared'
        ? $create(DeclaredBoxNode)
        : $create(ShadowBoxNode);
  let node: LexicalNode = $make().append(...inner);
  for (let i = 1; i < depth; i++) {
    node = $make().append(node);
  }
  return node;
}

/** root > p(before) > CONTAINER(inner) > p(after) */
function $build(ctx: Ctx, inner: () => LexicalNode[]): void {
  const root = $getRoot().clear();
  root.append($createParagraphNode().append($createTextNode('before')));
  if (ctx === 'root') {
    root.append(...inner());
  } else if (ctx === 'slot-shadow') {
    const c = $create(ComponentNode);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $setSlot(c as any, 'body', $create(ShadowBoxNode).append(...inner()));
    root.append(c);
  } else if (ctx === 'slot-bare') {
    const c = $create(ComponentNode);
    const [first] = inner();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $setSlot(c as any, 'body', first);
    root.append(c);
  } else {
    const kind = ctx.replace('2', '') as 'plain' | 'declared' | 'shadow';
    root.append($box(kind, ctx.endsWith('2') ? 2 : 1, inner()));
  }
  root.append($createParagraphNode().append($createTextNode('after')));
}

const NAMES: Record<string, string> = {
  code: 'code',
  heading: 'h',
  list: 'list',
  listitem: 'li',
  paragraph: 'p',
  quote: 'quote',
  test_component: 'component',
  test_declared_box: 'dbox',
  test_plain_box: 'box',
  test_shadow_box: 'sbox',
};

function $describeNode(n: LexicalNode): string {
  const type = n.getType();
  const name = NAMES[type] || type;
  if ($isTextNode(n)) {
    return JSON.stringify(n.getTextContent());
  }
  if (type === 'linebreak') {
    return 'br';
  }
  const extra: string[] = [];
  if ($isElementNode(n) && type !== 'listitem' && n.getIndent() > 0) {
    extra.push(`indent${n.getIndent()}`);
  }
  if (type === 'list') {
    extra.push((n as unknown as {getListType(): string}).getListType());
  }
  const slots = $getSlotNames(n)
    .map(s => `${s}:${$describeNode($getSlot(n, s)!)}`)
    .join(' ');
  const kids = $isElementNode(n)
    ? n.getChildren().map($describeNode).join(' ')
    : '';
  return `${name}${extra.length ? '[' + extra.join(',') + ']' : ''}${slots ? '{' + slots + '}' : ''}(${kids})`;
}

function $shape(): string {
  return $getRoot().getChildren().map($describeNode).join(' / ');
}

function $findText(text: string): TextNode {
  const visit = (n: LexicalNode): TextNode | null => {
    if ($isTextNode(n) && n.getTextContent() === text) {
      return n;
    }
    for (const s of $getSlotNames(n)) {
      const r = visit($getSlot(n, s)!);
      if (r) {
        return r;
      }
    }
    if ($isElementNode(n)) {
      for (const c of n.getChildren()) {
        const r = visit(c);
        if (r) {
          return r;
        }
      }
    }
    return null;
  };
  const found = visit($getRoot());
  if (!found) {
    throw new Error(`no text ${text}`);
  }
  return found;
}

function $selectRange(a: TextNode, ao: number, b: TextNode, bo: number) {
  const sel = $createRangeSelection();
  sel.anchor.set(a.getKey(), ao, 'text');
  sel.focus.set(b.getKey(), bo, 'text');
  $setSelection(sel);
}

const $p = (t: string) => $createParagraphNode().append($createTextNode(t));

interface Cmd {
  inner: () => LexicalNode[];
  /** run in the same update as the build (after it) */
  run: (editor: LexicalEditor) => void;
  /** typed after the build, in separate updates */
  type?: string;
}

const CMDS: Record<string, Cmd> = {
  'backspace-after-container': {
    inner: () => [$p('abc'), $p('def')],
    run: editor => {
      $findText('after').select(0, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    },
  },
  'backspace-at-container-start': {
    inner: () => [$p('abc'), $p('def')],
    run: editor => {
      $findText('abc').select(0, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    },
  },
  'delete-at-container-end': {
    inner: () => [$p('abc'), $p('def')],
    run: editor => {
      $findText('def').select(3, 3);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, false);
    },
  },
  'enter-empty-last-listitem': {
    inner: () => [
      $createListNode('bullet').append(
        $createListItemNode().append($createTextNode('abc')),
        $createListItemNode(),
      ),
    ],
    run: editor => {
      const list = $findText('abc')
        .getParentOrThrow()
        .getParentOrThrow() as ElementNode;
      (list.getLastChildOrThrow() as ElementNode).select();
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    },
  },
  indent: {
    inner: () => [$p('abc'), $p('def')],
    run: editor => {
      $findText('abc').select(1, 1);
      editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
    },
  },
  'insertList-collapsed': {
    inner: () => [$p('abc'), $p('def')],
    run: () => {
      $findText('abc').select(1, 1);
      $insertList('bullet');
    },
  },
  'insertList-quote-in-container': {
    inner: () => [$createQuoteNode().append($createTextNode('abc')), $p('def')],
    run: () => {
      $findText('abc').select(1, 1);
      $insertList('bullet');
    },
  },
  'insertList-range': {
    inner: () => [$p('abc'), $p('def')],
    run: () => {
      $selectRange($findText('abc'), 1, $findText('def'), 1);
      $insertList('number');
    },
  },
  'insertNodeToNearestRoot-hr-end': {
    inner: () => [$p('abc'), $p('def')],
    run: () => {
      $findText('def').select(3, 3);
      $insertNodeToNearestRoot($createHorizontalRuleNode());
    },
  },
  'insertNodeToNearestRoot-hr-mid': {
    inner: () => [$p('abc'), $p('def')],
    run: () => {
      $findText('abc').select(1, 1);
      $insertNodeToNearestRoot($createHorizontalRuleNode());
    },
  },
  'insertNodes-blocks': {
    inner: () => [$p('abc'), $p('def')],
    run: () => {
      $findText('abc').select(1, 1);
      ($getSelection() as ReturnType<typeof $createRangeSelection>).insertNodes(
        [$p('X'), $p('Y')],
      );
    },
  },
  'insertNodes-heading': {
    inner: () => [$p('abc'), $p('def')],
    run: () => {
      $findText('abc').select(1, 1);
      ($getSelection() as ReturnType<typeof $createRangeSelection>).insertNodes(
        [$createHeadingNode('h2').append($createTextNode('H'))],
      );
    },
  },
  'markdown-heading': {
    inner: () => [$createParagraphNode(), $p('def')],
    run: () => {
      // caret in the empty first paragraph of the container
      const def = $findText('def');
      const first = def.getParentOrThrow().getPreviousSibling() as ElementNode;
      first.select();
    },
    type: '# x',
  },
  'markdown-list': {
    inner: () => [$createParagraphNode(), $p('def')],
    run: () => {
      const def = $findText('def');
      const first = def.getParentOrThrow().getPreviousSibling() as ElementNode;
      first.select();
    },
    type: '- x',
  },
  outdent: {
    inner: () => [$p('abc').setIndent(1), $p('def')],
    run: editor => {
      $findText('abc').select(1, 1);
      editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
    },
  },
  removeList: {
    inner: () => [
      $createListNode('bullet').append(
        $createListItemNode().append($createTextNode('abc')),
        $createListItemNode().append($createTextNode('def')),
      ),
    ],
    run: () => {
      $findText('abc').select(1, 1);
      $removeList();
    },
  },
  'setBlocksType-code-range': {
    inner: () => [$p('abc'), $p('def')],
    run: () => {
      $selectRange($findText('abc'), 1, $findText('def'), 1);
      $setBlocksType($getSelection(), () => $createCodeNode());
    },
  },
  'setBlocksType-heading': {
    inner: () => [$p('abc'), $p('def')],
    run: () => {
      $findText('abc').select(1, 1);
      $setBlocksType($getSelection(), () => $createHeadingNode('h1'));
    },
  },
  'setBlocksType-quote': {
    inner: () => [$p('abc'), $p('def')],
    run: () => {
      $findText('abc').select(1, 1);
      $setBlocksType($getSelection(), () => $createQuoteNode());
    },
  },
  'wrapNodes-quote': {
    inner: () => [$p('abc'), $p('def')],
    run: () => {
      $findText('abc').select(1, 1);
      $wrapNodes($getSelection()!, () => $createQuoteNode());
    },
  },
};

/**
 * The expected shape for each command and context: one string when the
 * extension makes no difference, else [without, with] NodeStructureExtension.
 * A bare named slot holds one block, so the commands that need a second one
 * have no case there.
 */
const EXPECTED: Record<
  string,
  Partial<Record<Ctx, string | [string, string]>>
> = {
  'backspace-after-container': {
    declared: 'dbox(p("abc") p("defafter"))',
    declared2: 'dbox(dbox(p("abc") p("defafter")))',
    plain: 'box(p("abc") p("defafter"))',
    plain2: 'box(box(p("abc") p("defafter")))',
    root: 'p("abc") / p("defafter")',
    shadow: 'sbox(p("abc") p("def"))',
    shadow2: 'sbox(sbox(p("abc") p("def")))',
    'slot-bare': 'p("after")',
    'slot-shadow': 'p("after")',
  },
  'backspace-at-container-start': {
    declared: 'p("beforeabc") / dbox(p("def"))',
    declared2: 'p("beforeabc") / dbox(dbox(p("def")))',
    plain: 'p("beforeabc") / box(p("def"))',
    plain2: 'p("beforeabc") / box(box(p("def")))',
    root: 'p("beforeabc") / p("def")',
    shadow: 'sbox(p("abc") p("def"))',
    shadow2: 'sbox(sbox(p("abc") p("def")))',
    'slot-bare': 'component{body:p("abc")}()',
    'slot-shadow': 'component{body:sbox(p("abc") p("def"))}()',
  },
  'delete-at-container-end': {
    declared: 'dbox(p("abc") p("defafter"))',
    declared2: 'dbox(dbox(p("abc") p("defafter")))',
    plain: 'box(p("abc") p("defafter"))',
    plain2: 'box(box(p("abc") p("defafter")))',
    root: 'p("abc") / p("defafter")',
    shadow: 'sbox(p("abc") p("def"))',
    shadow2: 'sbox(sbox(p("abc") p("def")))',
    'slot-shadow': 'component{body:sbox(p("abc") p("def"))}()',
  },
  'enter-empty-last-listitem': {
    declared: [
      'dbox(list[bullet](li("abc") li() li()))',
      'dbox(list[bullet](li("abc")) p())',
    ],
    declared2: [
      'dbox(dbox(list[bullet](li("abc") li() li())))',
      'dbox(dbox(list[bullet](li("abc")) p()))',
    ],
    plain: 'box(list[bullet](li("abc") li() li()))',
    plain2: 'box(box(list[bullet](li("abc") li() li())))',
    root: 'list[bullet](li("abc")) / p()',
    shadow: 'sbox(list[bullet](li("abc")) p())',
    shadow2: 'sbox(sbox(list[bullet](li("abc")) p()))',
    'slot-bare': 'component{body:list[bullet](li("abc") li() li())}()',
    'slot-shadow': 'component{body:sbox(list[bullet](li("abc")) p())}()',
  },
  indent: {
    declared: 'dbox(p[indent1]("abc") p("def"))',
    declared2: 'dbox(dbox(p[indent1]("abc") p("def")))',
    plain: 'box(p[indent1]("abc") p("def"))',
    plain2: 'box(box(p[indent1]("abc") p("def")))',
    root: 'p[indent1]("abc") / p("def")',
    shadow: 'sbox(p[indent1]("abc") p("def"))',
    shadow2: 'sbox(sbox(p[indent1]("abc") p("def")))',
    'slot-bare': 'component{body:p[indent1]("abc")}()',
    'slot-shadow': 'component{body:sbox(p[indent1]("abc") p("def"))}()',
  },
  'insertList-collapsed': {
    declared: [
      'list[bullet](li(p("abc") p("def")))',
      'dbox(list[bullet](li("abc")) p("def"))',
    ],
    declared2: [
      'list[bullet](li(dbox(p("abc") p("def"))))',
      'dbox(dbox(list[bullet](li("abc")) p("def")))',
    ],
    plain: [
      'list[bullet](li(p("abc") p("def")))',
      'list[bullet](li("abc" br "def"))',
    ],
    plain2: [
      'list[bullet](li(box(p("abc") p("def"))))',
      'box(box(list[bullet](li("abc")) p("def")))',
    ],
    root: 'list[bullet](li("abc")) / p("def")',
    shadow: 'sbox(list[bullet](li("abc")) p("def"))',
    shadow2: 'sbox(sbox(list[bullet](li("abc")) p("def")))',
    'slot-bare': 'component{body:p("abc")}()',
    'slot-shadow': 'component{body:sbox(list[bullet](li("abc")) p("def"))}()',
  },
  'insertList-quote-in-container': {
    declared: [
      'list[bullet](li(quote("abc") p("def")))',
      'dbox(list[bullet](li("abc")) p("def"))',
    ],
    declared2: [
      'list[bullet](li(dbox(quote("abc") p("def"))))',
      'dbox(dbox(list[bullet](li("abc")) p("def")))',
    ],
    plain: [
      'list[bullet](li(quote("abc") p("def")))',
      'box(list[bullet](li("abc")) p("def"))',
    ],
    plain2: [
      'list[bullet](li(box(quote("abc") p("def"))))',
      'box(box(list[bullet](li("abc")) p("def")))',
    ],
    root: 'list[bullet](li("abc")) / p("def")',
    shadow: 'sbox(list[bullet](li("abc")) p("def"))',
    shadow2: 'sbox(sbox(list[bullet](li("abc")) p("def")))',
    'slot-bare': 'component{body:quote("abc")}()',
    'slot-shadow': 'component{body:sbox(list[bullet](li("abc")) p("def"))}()',
  },
  'insertList-range': {
    declared: [
      'list[number](li(p("abc") p("def")))',
      'dbox(list[number](li("abc") li("def")))',
    ],
    declared2: [
      'list[number](li(dbox(p("abc") p("def"))))',
      'dbox(dbox(list[number](li("abc") li("def"))))',
    ],
    plain: [
      'list[number](li(p("abc") p("def")))',
      'list[number](li("abc" br "def"))',
    ],
    plain2: [
      'list[number](li(box(p("abc") p("def"))))',
      'box(box(list[number](li("abc") li("def"))))',
    ],
    root: 'list[number](li("abc") li("def"))',
    shadow: 'sbox(list[number](li("abc") li("def")))',
    shadow2: 'sbox(sbox(list[number](li("abc") li("def"))))',
    'slot-shadow': 'component{body:sbox(list[number](li("abc") li("def")))}()',
  },
  'insertNodeToNearestRoot-hr-end': {
    declared: [
      'dbox(p("abc") p("def")) / horizontalrule()',
      'dbox(p("abc") p("def") horizontalrule() p())',
    ],
    declared2: [
      'dbox(dbox(p("abc") p("def"))) / horizontalrule()',
      'dbox(dbox(p("abc") p("def") horizontalrule() p()))',
    ],
    plain: 'box(p("abc") p("def")) / horizontalrule()',
    plain2: 'box(box(p("abc") p("def"))) / horizontalrule()',
    root: 'p("abc") / p("def") / horizontalrule()',
    shadow: 'sbox(p("abc") p("def") horizontalrule() p())',
    shadow2: 'sbox(sbox(p("abc") p("def") horizontalrule() p()))',
    'slot-shadow':
      'component{body:sbox(p("abc") p("def") horizontalrule() p())}()',
  },
  'insertNodeToNearestRoot-hr-mid': {
    declared: [
      'dbox(p("a")) / horizontalrule() / dbox(p("bc") p("def"))',
      'dbox(p("a") horizontalrule() p("bc") p("def"))',
    ],
    declared2: [
      'dbox(dbox(p("a"))) / horizontalrule() / dbox(dbox(p("bc") p("def")))',
      'dbox(dbox(p("a") horizontalrule() p("bc") p("def")))',
    ],
    plain: 'box(p("a")) / horizontalrule() / box(p("bc") p("def"))',
    plain2: 'box(box(p("a"))) / horizontalrule() / box(box(p("bc") p("def")))',
    root: 'p("a") / horizontalrule() / p("bc") / p("def")',
    shadow: 'sbox(p("a") horizontalrule() p("bc") p("def"))',
    shadow2: 'sbox(sbox(p("a") horizontalrule() p("bc") p("def")))',
    'slot-bare': 'component{body:p("a" horizontalrule() "bc")}()',
    'slot-shadow':
      'component{body:sbox(p("a") horizontalrule() p("bc") p("def"))}()',
  },
  'insertNodes-blocks': {
    declared: ['dbox(p("aXYbc") p("def"))', 'dbox(p("aX") p("Ybc") p("def"))'],
    declared2: [
      'dbox(dbox(p("aXYbc") p("def")))',
      'dbox(dbox(p("aX") p("Ybc") p("def")))',
    ],
    plain: 'box(p("aXYbc") p("def"))',
    plain2: 'box(box(p("aXYbc") p("def")))',
    root: 'p("aX") / p("Ybc") / p("def")',
    shadow: 'sbox(p("aX") p("Ybc") p("def"))',
    shadow2: 'sbox(sbox(p("aX") p("Ybc") p("def")))',
    'slot-bare': 'component{body:p("aXYbc")}()',
    'slot-shadow': 'component{body:sbox(p("aX") p("Ybc") p("def"))}()',
  },
  'insertNodes-heading': {
    declared: 'dbox(p("aHbc") p("def"))',
    declared2: 'dbox(dbox(p("aHbc") p("def")))',
    plain: 'box(p("aHbc") p("def"))',
    plain2: 'box(box(p("aHbc") p("def")))',
    root: 'p("aHbc") / p("def")',
    shadow: 'sbox(p("aHbc") p("def"))',
    shadow2: 'sbox(sbox(p("aHbc") p("def")))',
    'slot-bare': 'component{body:p("aHbc")}()',
    'slot-shadow': 'component{body:sbox(p("aHbc") p("def"))}()',
  },
  'markdown-heading': {
    declared: ['dbox(p("# x") p("def"))', 'dbox(h("x") p("def"))'],
    declared2: ['dbox(dbox(p("# x") p("def")))', 'dbox(dbox(h("x") p("def")))'],
    plain: 'box(p("# x") p("def"))',
    plain2: 'box(box(p("# x") p("def")))',
    root: 'h("x") / p("def")',
    shadow: 'sbox(h("x") p("def"))',
    shadow2: 'sbox(sbox(h("x") p("def")))',
    'slot-shadow': 'component{body:sbox(h("x") p("def"))}()',
  },
  'markdown-list': {
    declared: [
      'dbox(p("- x") p("def"))',
      'dbox(list[bullet](li("x")) p("def"))',
    ],
    declared2: [
      'dbox(dbox(p("- x") p("def")))',
      'dbox(dbox(list[bullet](li("x")) p("def")))',
    ],
    plain: 'box(p("- x") p("def"))',
    plain2: 'box(box(p("- x") p("def")))',
    root: 'list[bullet](li("x")) / p("def")',
    shadow: 'sbox(list[bullet](li("x")) p("def"))',
    shadow2: 'sbox(sbox(list[bullet](li("x")) p("def")))',
    'slot-shadow': 'component{body:sbox(list[bullet](li("x")) p("def"))}()',
  },
  outdent: {
    declared: 'dbox(p("abc") p("def"))',
    declared2: 'dbox(dbox(p("abc") p("def")))',
    plain: 'box(p("abc") p("def"))',
    plain2: 'box(box(p("abc") p("def")))',
    root: 'p("abc") / p("def")',
    shadow: 'sbox(p("abc") p("def"))',
    shadow2: 'sbox(sbox(p("abc") p("def")))',
    'slot-bare': 'component{body:p("abc")}()',
    'slot-shadow': 'component{body:sbox(p("abc") p("def"))}()',
  },
  removeList: {
    declared: 'dbox(p("abc") p("def"))',
    declared2: 'dbox(dbox(p("abc") p("def")))',
    plain: 'box(p("abc") p("def"))',
    plain2: 'box(box(p("abc") p("def")))',
    root: 'p("abc") / p("def")',
    shadow: 'sbox(p("abc") p("def"))',
    shadow2: 'sbox(sbox(p("abc") p("def")))',
    'slot-bare': 'component{body:list[bullet](li("abc") li("def"))}()',
    'slot-shadow': 'component{body:sbox(p("abc") p("def"))}()',
  },
  'setBlocksType-code-range': {
    declared: 'dbox(code("abc") code("def"))',
    declared2: 'dbox(dbox(code("abc") code("def")))',
    plain: 'box(code("abc") code("def"))',
    plain2: 'box(box(code("abc") code("def")))',
    root: 'code("abc") / code("def")',
    shadow: 'sbox(code("abc") code("def"))',
    shadow2: 'sbox(sbox(code("abc") code("def")))',
    'slot-shadow': 'component{body:sbox(code("abc") code("def"))}()',
  },
  'setBlocksType-heading': {
    declared: 'dbox(h("abc") p("def"))',
    declared2: 'dbox(dbox(h("abc") p("def")))',
    plain: 'box(h("abc") p("def"))',
    plain2: 'box(box(h("abc") p("def")))',
    root: 'h("abc") / p("def")',
    shadow: 'sbox(h("abc") p("def"))',
    shadow2: 'sbox(sbox(h("abc") p("def")))',
    'slot-bare': 'component{body:p("abc")}()',
    'slot-shadow': 'component{body:sbox(h("abc") p("def"))}()',
  },
  'setBlocksType-quote': {
    declared: 'dbox(quote("abc") p("def"))',
    declared2: 'dbox(dbox(quote("abc") p("def")))',
    plain: 'box(quote("abc") p("def"))',
    plain2: 'box(box(quote("abc") p("def")))',
    root: 'quote("abc") / p("def")',
    shadow: 'sbox(quote("abc") p("def"))',
    shadow2: 'sbox(sbox(quote("abc") p("def")))',
    'slot-bare': 'component{body:p("abc")}()',
    'slot-shadow': 'component{body:sbox(quote("abc") p("def"))}()',
  },
  'wrapNodes-quote': {
    declared: ['quote("abc") / dbox(p("def"))', 'dbox(quote("abc") p("def"))'],
    declared2: [
      'quote("abc") / dbox(dbox(p("def")))',
      'dbox(dbox(quote("abc") p("def")))',
    ],
    plain: 'quote("abc") / box(p("def"))',
    plain2: 'quote("abc") / box(box(p("def")))',
    root: 'quote("abc") / p("def")',
    shadow: 'sbox(quote("abc") p("def"))',
    shadow2: 'sbox(sbox(quote("abc") p("def")))',
    'slot-bare': 'component{body:p("abc")}()',
    'slot-shadow': 'component{body:sbox(quote("abc") p("def"))}()',
  },
};

function $strip(shape: string): string {
  return shape
    .replace(/^p\("before"\) \/ /, '')
    .replace(/ \/ p\("after"\)$/, '');
}

function buildEditor(structure: boolean) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        ListExtension,
        LinkExtension,
        CodeExtension,
        HorizontalRuleExtension,
        ...(structure ? [NodeStructureExtension] : []),
      ],
      name: 'block-containers',
      nodes: () => [
        PlainBoxNode,
        DeclaredBoxNode,
        ShadowBoxNode,
        ComponentNode,
      ],
      onError: (e: Error) => {
        throw e;
      },
      register: e => registerMarkdownShortcuts(e),
    }),
  );
}

function $run(cmd: Cmd, ctx: Ctx, structure: boolean): string {
  using editor = buildEditor(structure);
  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  document.body.appendChild(rootElement);
  editor.setRootElement(rootElement);
  try {
    editor.update(() => $build(ctx, cmd.inner), {discrete: true});
    editor.update(() => cmd.run(editor), {discrete: true});
    for (const ch of cmd.type || '') {
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
    return $strip(editor.read(() => $shape()));
  } finally {
    editor.setRootElement(null);
    rootElement.remove();
  }
}

describe('structural commands in block containers', () => {
  const cases: [string, Ctx, boolean, string][] = [];
  for (const [cmd, byCtx] of Object.entries(EXPECTED)) {
    for (const ctx of CTXS) {
      const expected = byCtx[ctx];
      if (expected !== undefined) {
        for (const structure of [false, true]) {
          cases.push([
            cmd,
            ctx,
            structure,
            typeof expected === 'string'
              ? expected
              : expected[structure ? 1 : 0],
          ]);
        }
      }
    }
  }

  test.each(cases)(
    '%s in %s (NodeStructureExtension: %s)',
    (cmd, ctx, structure, expected) => {
      expect($run(CMDS[cmd], ctx, structure)).toBe(expected);
    },
  );

  test('every command has a row of cases', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(CMDS).sort());
  });

  test('a declared container behaves like a shadow root for every command but the joins at its edges', () => {
    for (const [cmd, byCtx] of Object.entries(EXPECTED)) {
      const at = (ctx: Ctx) => {
        const e = byCtx[ctx]!;
        return (typeof e === 'string' ? e : e[1]).replace(/dbox|sbox/g, 'B');
      };
      const joins = cmd.startsWith('backspace') || cmd.startsWith('delete');
      for (const [declared, shadow] of [
        ['declared', 'shadow'],
        ['declared2', 'shadow2'],
      ] as const) {
        if (joins) {
          expect(at(declared)).not.toBe(at(shadow));
        } else {
          expect(at(declared)).toBe(at(shadow));
        }
      }
    }
  });
});

describe('$isBlockContainer', () => {
  class DeclaredBoxSubclassNode extends DeclaredBoxNode {
    $config() {
      return this.config('test_declared_box_subclass', {
        extends: DeclaredBoxNode,
      });
    }
  }
  class InlineDeclaredBoxNode extends DeclaredBoxNode {
    $config() {
      return this.config('test_inline_declared_box', {
        extends: DeclaredBoxNode,
      });
    }
    isInline(): boolean {
      return true;
    }
  }
  test.each([
    ['absent', false],
    ['disabled', false],
    ['enforced', true],
  ] as const)(
    'reads a children: block declaration only where NodeStructureExtension enforces it (%s)',
    (mode, structure) => {
      using editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            RichTextExtension,
            ListExtension,
            ...(mode === 'absent'
              ? []
              : [
                  configExtension(NodeStructureExtension, {
                    disabled: mode === 'disabled',
                  }),
                ]),
          ],
          name: 'is-block-container',
          nodes: () => [
            PlainBoxNode,
            DeclaredBoxNode,
            DeclaredBoxSubclassNode,
            InlineDeclaredBoxNode,
            ShadowBoxNode,
          ],
        }),
      );
      editor.update(
        () => {
          const list = $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('x')),
          );
          const nodes = {
            declared: $create(DeclaredBoxNode),
            inherited: $create(DeclaredBoxSubclassNode),
            inline: $create(InlineDeclaredBoxNode),
            list,
            listItem: list.getFirstChildOrThrow(),
            paragraph: $createParagraphNode(),
            plain: $create(PlainBoxNode),
            quote: $createQuoteNode(),
            root: $getRoot(),
            shadow: $create(ShadowBoxNode),
            shadowQuote: $createQuoteNode({shadowRoot: true}),
            text: $createTextNode('x'),
          };
          const result = Object.fromEntries(
            Object.entries(nodes).map(([k, n]) => [k, $isBlockContainer(n)]),
          );
          expect(result).toEqual({
            declared: structure,
            inherited: structure,
            inline: false,
            list: false,
            listItem: false,
            paragraph: false,
            plain: false,
            quote: false,
            root: true,
            shadow: true,
            shadowQuote: true,
            text: false,
          });
          expect($isBlockContainer(null)).toBe(false);
        },
        {discrete: true},
      );
    },
  );
});

describe('selections that pass over or sit on a container', () => {
  const $range = (empty: () => ElementNode) => {
    const a = $createTextNode('before');
    const b = $createTextNode('after');
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append(a),
        empty(),
        $createParagraphNode().append(b),
      );
    $selectRange(a, 1, b, 1);
  };
  const $inBox = (offset: number) => {
    const box = $create(DeclaredBoxNode).append($p('abc'));
    $getRoot().clear().append(box);
    box.select(offset, offset);
  };
  test.each([
    [
      'an empty declared box in a range: $insertList',
      () => {
        $range(() => $create(DeclaredBoxNode));
        $insertList('bullet');
      },
      'list[bullet](li("before")) / dbox() / list[bullet](li("after"))',
    ],
    [
      'an empty shadow root in a range: $insertList',
      () => {
        $range(() => $create(ShadowBoxNode));
        $insertList('bullet');
      },
      'list[bullet](li("before")) / sbox() / list[bullet](li("after"))',
    ],
    [
      'an empty declared box in a range: $setBlocksType',
      () => {
        $range(() => $create(DeclaredBoxNode));
        $setBlocksType($getSelection(), () => $createHeadingNode('h1'));
      },
      'h("before") / dbox() / h("after")',
    ],
    [
      'an element point on a declared box: insertParagraph',
      () => {
        $inBox(1);
        ($getSelection() as RangeSelection).insertParagraph();
      },
      'dbox(p("abc") p())',
    ],
    [
      'an element point on a declared box: insertNodes',
      () => {
        $inBox(1);
        ($getSelection() as RangeSelection).insertNodes([$p('X')]);
      },
      'dbox(p("abc") p("X"))',
    ],
    [
      'an element point on a declared box: $insertList',
      () => {
        $inBox(0);
        $insertList('bullet');
      },
      'dbox(list[bullet](li("abc")))',
    ],
    [
      'a range from before a declared box into it: $insertList',
      () => {
        const a = $createTextNode('before');
        const b = $createTextNode('in');
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(a),
            $create(DeclaredBoxNode).append($createParagraphNode().append(b)),
          );
        $selectRange(a, 1, b, 1);
        $insertList('bullet');
      },
      'list[bullet](li("before")) / dbox(list[bullet](li("in")))',
    ],
    [
      'a horizontal rule selected in a declared box: $insertList',
      () => {
        const hr = $createHorizontalRuleNode();
        $getRoot()
          .clear()
          .append($create(DeclaredBoxNode).append($p('abc'), hr));
        const selection = $createNodeSelection();
        selection.add(hr.getKey());
        $setSelection(selection);
        $insertList('bullet');
      },
      'dbox(p("abc") horizontalrule())',
    ],
    [
      'a horizontal rule selected in a shadow root: $insertList',
      () => {
        const hr = $createHorizontalRuleNode();
        $getRoot()
          .clear()
          .append($create(ShadowBoxNode).append($p('abc'), hr));
        const selection = $createNodeSelection();
        selection.add(hr.getKey());
        $setSelection(selection);
        $insertList('bullet');
      },
      'sbox(p("abc") horizontalrule())',
    ],
    [
      'a range over a horizontal rule in a declared box: $insertList',
      () => {
        $getRoot()
          .clear()
          .append(
            $create(DeclaredBoxNode).append(
              $p('abc'),
              $createHorizontalRuleNode(),
              $p('def'),
            ),
          );
        $selectRange($findText('abc'), 1, $findText('def'), 1);
        $insertList('bullet');
      },
      'dbox(list[bullet](li("abc")) horizontalrule() list[bullet](li("def")))',
    ],
    [
      'a range over a horizontal rule in a declared box: $wrapNodes',
      () => {
        $getRoot()
          .clear()
          .append(
            $create(DeclaredBoxNode).append(
              $p('abc'),
              $createHorizontalRuleNode(),
              $p('def'),
            ),
          );
        $selectRange($findText('abc'), 1, $findText('def'), 1);
        $wrapNodes($getSelection()!, () => $createQuoteNode());
      },
      'dbox(quote("abc") horizontalrule() quote("def"))',
    ],
    [
      'a range over a horizontal rule at the root: $wrapNodes',
      () => {
        $getRoot()
          .clear()
          .append($p('abc'), $createHorizontalRuleNode(), $p('def'));
        $selectRange($findText('abc'), 1, $findText('def'), 1);
        $wrapNodes($getSelection()!, () => $createQuoteNode());
      },
      'quote("abc") / horizontalrule() / quote("def")',
    ],
    [
      'a range over a quote and a paragraph in a box that declares nothing: $insertList',
      () => {
        $getRoot()
          .clear()
          .append(
            $create(PlainBoxNode).append(
              $createQuoteNode().append($createTextNode('y')),
              $p('x'),
            ),
          );
        $selectRange($findText('y'), 0, $findText('x'), 1);
        $insertList('bullet');
      },
      'box(list[bullet](li("y") li("x")))',
    ],
    [
      'an empty declared box with a slot, element point: $wrapNodes',
      () => {
        const box = $create(DeclaredBoxNode);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        $setSlot(box as any, 'aside', $p('slot'));
        $getRoot().clear().append($p('before'), box, $p('after'));
        box.select(0, 0);
        $wrapNodes($getSelection()!, () => $createQuoteNode());
      },
      'p("before") / dbox{aside:p("slot")}(quote()) / p("after")',
    ],
    [
      'an empty declared box with a slot, node selected: $insertList',
      () => {
        const box = $create(DeclaredBoxNode);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        $setSlot(box as any, 'aside', $p('slot'));
        $getRoot().clear().append($p('before'), box, $p('after'));
        const selection = $createNodeSelection();
        selection.add(box.getKey());
        $setSelection(selection);
        $insertList('bullet');
      },
      'p("before") / dbox{aside:p("slot")}() / p("after")',
    ],
    [
      'a declared box holding only a block decorator, element point: $insertList',
      () => {
        const box = $create(DeclaredBoxNode).append($create(ComponentNode));
        $getRoot().clear().append($p('before'), box, $p('after'));
        box.select(0, 0);
        $insertList('bullet');
      },
      'p("before") / dbox(component()) / p("after")',
    ],
    [
      'a declared box as a named-slot value: $wrapNodes',
      () => {
        const host = $create(ComponentNode);
        const body = $create(DeclaredBoxNode).append($p('abc'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        $setSlot(host as any, 'body', body);
        $getRoot().clear().append(host);
        $findText('abc').select(1, 1);
        $wrapNodes($getSelection()!, () => $createQuoteNode());
      },
      'component{body:dbox(quote("abc"))}()',
    ],
    [
      'an empty quote and a paragraph of a box that declares nothing, node selected: $insertList',
      () => {
        const quote = $createQuoteNode();
        const text = $createTextNode('x');
        const box = $create(PlainBoxNode).append(
          quote,
          $createParagraphNode().append(text),
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        $setSlot(box as any, 'aside', $p('slot'));
        $getRoot().clear().append(box);
        const selection = $createNodeSelection();
        selection.add(quote.getKey());
        selection.add(text.getKey());
        $setSelection(selection);
        $insertList('bullet');
      },
      'box{aside:p("slot")}(list[bullet](li() li("x")))',
    ],
    [
      'removing the only, empty, declared box of a shadow root',
      () => {
        const shadow = $create(ShadowBoxNode).append($create(DeclaredBoxNode));
        $getRoot().clear().append(shadow);
        shadow.select(0, 1);
        ($getSelection() as RangeSelection).removeText();
      },
      'sbox(p())',
    ],
    [
      'the caret in an empty declared box: $setBlocksType',
      () => {
        const box = $create(DeclaredBoxNode);
        $getRoot().clear().append($p('before'), box, $p('after'));
        box.select(0, 0);
        $setBlocksType($getSelection(), () => $createHeadingNode('h1'));
      },
      'p("before") / dbox(h()) / p("after")',
    ],
  ] as const)('%s (NodeStructureExtension)', (_name, $act, expected) => {
    using editor = buildEditor(true);
    editor.update($act, {discrete: true});
    expect(editor.read(() => $shape())).toBe(expected);
  });

  test('with no active editor, a declared box is not a container', () => {
    using editor = buildEditor(true);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($create(DeclaredBoxNode).append($p('x')));
      },
      {discrete: true},
    );
    expect(
      editor
        .getEditorState()
        .read(() => $isBlockContainer($getRoot().getFirstChild())),
    ).toBe(false);
    expect(
      editor.read(() => $isBlockContainer($getRoot().getFirstChild())),
    ).toBe(true);
  });
});

describe('@lexical/mdast shortcuts in block containers', () => {
  function buildMdastEditor(structure: boolean) {
    return buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          MdastGfmExtension,
          MdastShortcutsExtension,
          ...(structure ? [NodeStructureExtension] : []),
        ],
        name: 'block-containers-mdast',
        nodes: () => [PlainBoxNode, DeclaredBoxNode, ShadowBoxNode],
        onError: (e: Error) => {
          throw e;
        },
      }),
    );
  }
  test.each([
    ['root', false, '# ', 'h("x") / p("def")'],
    ['declared', false, '# ', 'dbox(p("# x") p("def"))'],
    ['declared', true, '# ', 'dbox(h("x") p("def"))'],
    ['declared', true, '- ', 'dbox(list[bullet](li("x")) p("def"))'],
    ['declared', true, '> ', 'dbox(quote("x") p("def"))'],
    ['plain', true, '# ', 'box(p("# x") p("def"))'],
    ['shadow', false, '# ', 'sbox(h("x") p("def"))'],
  ] as const)(
    'typing %s in %s (NodeStructureExtension: %s) %s',
    (ctx, structure, marker, expected) => {
      using editor = buildMdastEditor(structure);
      editor.update(
        () => {
          $build(ctx, () => [$createParagraphNode(), $p('def')]);
          const def = $findText('def');
          (def.getParentOrThrow().getPreviousSibling() as ElementNode).select();
        },
        {discrete: true},
      );
      for (const ch of marker + 'x') {
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
      expect(editor.read(() => $strip($shape()))).toBe(expected);
    },
  );
});

describe('fixes every editor gets', () => {
  const $emptyShadowInRange = () => {
    const a = $createTextNode('before');
    const b = $createTextNode('after');
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append(a),
        $create(ShadowBoxNode),
        $createParagraphNode().append(b),
      );
    $selectRange(a, 1, b, 1);
  };
  const $hrInShadow = () => {
    const hr = $createHorizontalRuleNode();
    $getRoot()
      .clear()
      .append($create(ShadowBoxNode).append($p('abc'), hr));
    const selection = $createNodeSelection();
    selection.add(hr.getKey());
    $setSelection(selection);
  };
  const cases = [
    [
      '$wrapNodes in an empty root',
      () => {
        $getRoot().clear().select(0, 0);
        $wrapNodes($getSelection()!, () => $createQuoteNode());
      },
      'quote()',
    ],
    [
      '$wrapNodes in an empty shadow root',
      () => {
        const shadow = $create(ShadowBoxNode);
        $getRoot().clear().append($p('before'), shadow, $p('after'));
        shadow.select(0, 0);
        $wrapNodes($getSelection()!, () => $createQuoteNode());
      },
      'p("before") / sbox(quote()) / p("after")',
    ],
    [
      '$insertList over an empty shadow root in a range',
      () => {
        $emptyShadowInRange();
        $insertList('bullet');
      },
      'list[bullet](li("before")) / sbox() / list[bullet](li("after"))',
    ],
    [
      '$insertList with a horizontal rule selected in a shadow root',
      () => {
        $hrInShadow();
        $insertList('bullet');
      },
      'sbox(p("abc") horizontalrule())',
    ],
  ] as const;
  test.each(
    cases.flatMap(([name, $act, expected]) =>
      [false, true].map(
        structure => [name, structure, $act, expected] as const,
      ),
    ),
  )('%s (NodeStructureExtension: %s)', (_name, structure, $act, expected) => {
    using editor = buildEditor(structure);
    editor.update($act, {discrete: true});
    expect(editor.read(() => $shape())).toBe(expected);
  });
});

describe('a new block put in an empty declared container', () => {
  const $emptyBox = () => {
    const box = $create(DeclaredBoxNode).setIndent(1).setFormat('center');
    $getRoot().clear().append($p('before'), box, $p('after'));
    return box;
  };
  test.each([
    [
      '$setBlocksType',
      () => $setBlocksType($getSelection(), () => $createHeadingNode('h1')),
      'p("before") / dbox[indent1](h()) / p("after")',
    ],
    [
      '$wrapNodes',
      () => $wrapNodes($getSelection()!, () => $createQuoteNode()),
      'p("before") / dbox[indent1](quote()) / p("after")',
    ],
  ] as const)(
    "%s does not take the container's indent and format",
    (_name, $act, expected) => {
      using editor = buildEditor(true);
      editor.update(
        () => {
          $emptyBox().select(0, 0);
          $act();
        },
        {discrete: true},
      );
      expect(editor.read(() => $shape())).toBe(expected);
      expect(
        editor.read(() => {
          const block = (
            $getRoot().getChildAtIndex(1) as ElementNode
          ).getFirstChild() as ElementNode;
          return block.getFormatType();
        }),
      ).toBe('');
    },
  );

  test('$setBlocksType keeps a range that starts in the empty container', () => {
    using editor = buildEditor(true);
    editor.update(
      () => {
        const box = $emptyBox();
        const selection = $createRangeSelection();
        selection.anchor.set(box.getKey(), 0, 'element');
        selection.focus.set($findText('after').getKey(), 2, 'text');
        $setSelection(selection);
        $setBlocksType($getSelection(), () => $createHeadingNode('h1'));
      },
      {discrete: true},
    );
    expect(editor.read(() => $shape())).toBe(
      'p("before") / dbox[indent1](h()) / h("after")',
    );
    expect(
      editor.read(() => {
        const selection = $getSelection() as RangeSelection;
        const at = (point: RangeSelection['anchor']) =>
          `${point.getNode().getType()}:${point.offset}`;
        return [at(selection.anchor), at(selection.focus)];
      }),
    ).toEqual(['heading:0', 'text:2']);
  });

  test('$setBlocksType keeps a backward range that ends in the empty container', () => {
    using editor = buildEditor(true);
    editor.update(
      () => {
        const box = $emptyBox();
        const selection = $createRangeSelection();
        selection.anchor.set($findText('after').getKey(), 2, 'text');
        selection.focus.set(box.getKey(), 0, 'element');
        $setSelection(selection);
        $setBlocksType($getSelection(), () => $createHeadingNode('h1'));
      },
      {discrete: true},
    );
    expect(editor.read(() => $shape())).toBe(
      'p("before") / dbox[indent1](h()) / h("after")',
    );
    expect(
      editor.read(() => {
        const selection = $getSelection() as RangeSelection;
        const at = (point: RangeSelection['anchor']) =>
          `${point.getNode().getType()}:${point.offset}`;
        return [at(selection.anchor), at(selection.focus)];
      }),
    ).toEqual(['text:2', 'heading:0']);
  });
});

describe("the character limit's OverflowNode", () => {
  function buildOverflowEditor(structure: boolean) {
    return buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          ListExtension,
          ...(structure ? [NodeStructureExtension] : []),
        ],
        name: 'block-containers-overflow',
        nodes: () => [OverflowNode, PlainBoxNode],
        onError: (e: Error) => {
          throw e;
        },
      }),
    );
  }
  test.each([
    [
      'in a paragraph',
      () => [
        $createParagraphNode().append(
          $createTextNode('abc'),
          $createOverflowNode().append($createTextNode('def')),
        ),
      ],
      'def',
      'list[bullet](li("abc" overflow("def")))',
    ],
    [
      'alone in a paragraph after another',
      () => [
        $p('abc'),
        $createParagraphNode().append(
          $createOverflowNode().append($createTextNode('ghi')),
        ),
      ],
      'ghi',
      'p("abc") / list[bullet](li(overflow("ghi")))',
    ],
    [
      'in a box that holds a quote',
      () => [
        $create(PlainBoxNode).append(
          $createQuoteNode().append($createTextNode('q')),
          $createParagraphNode().append(
            $createTextNode('abc'),
            $createOverflowNode().append($createTextNode('def')),
          ),
        ),
      ],
      'def',
      'box(quote("q") list[bullet](li("abc" overflow("def"))))',
    ],
  ] as const)(
    '$insertList with the caret in an OverflowNode %s',
    (name, $inner, text, expected) => {
      for (const structure of [false, true]) {
        if (name === 'in a box that holds a quote' && !structure) {
          continue;
        }
        using editor = buildOverflowEditor(structure);
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(...$inner());
            $findText(text).select(1, 1);
            $insertList('bullet');
          },
          {discrete: true},
        );
        expect(editor.read(() => $shape())).toBe(expected);
      }
    },
  );
});

// https://github.com/meta/lexical/issues/9570
describe('#9570: $insertList in a box inside a box', () => {
  test.each([
    ['box', false, 'list[bullet](li(box(p("abc"))))'],
    ['box', true, 'box(box(list[bullet](li("abc"))))'],
    ['dbox', false, 'list[bullet](li(dbox(p("abc"))))'],
    ['dbox', true, 'dbox(dbox(list[bullet](li("abc"))))'],
  ] as const)(
    '%s (NodeStructureExtension: %s) makes a list and keeps both boxes where the structure is enforced',
    (kind, structure, expected) => {
      using editor = buildEditor(structure);
      const $make = (): ElementNode =>
        kind === 'box' ? $create(PlainBoxNode) : $create(DeclaredBoxNode);
      editor.update(
        () => {
          const text = $createTextNode('abc');
          $getRoot()
            .clear()
            .append(
              $make().append(
                $make().append($createParagraphNode().append(text)),
              ),
            );
          text.select(1, 1);
          $insertList('bullet');
        },
        {discrete: true},
      );
      expect(editor.read(() => $shape())).toBe(expected);
    },
  );
});
