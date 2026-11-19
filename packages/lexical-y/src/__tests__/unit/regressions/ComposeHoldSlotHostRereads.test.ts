/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes `abc` in an inline container, in a line that is a named slot's
// value; B types R in it, held. The slot's host is an element (nested two
// or three deep in other hosts' slots) or a decorator (at the top level, or
// itself in an element host's slot). A then changes a slot holding what is
// composed in: removes it, moves its value to the host's other, occupied
// slot, or replaces a value with a copy of it under new keys (alone, or
// with an unwrap or a removal of the inline container, or a merge of the
// composed text into the text before it, in the same update: Lexical then
// merges the copied text into fewer text nodes), as a local edit or as an
// app's selection transform inside a remote read. Each is refused: no
// character is typed (a copy holds the text it replaces), and
// each would delete R with the shared node it is stored in. A reads the
// document again, slots of decorators and of nested hosts included, so
// every peer and a fresh reader show R once, as stored.

import {
  $create,
  $createParagraphNode,
  $getDocument,
  $getEditor,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $hasUpdateTag,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $parseSerializedNode,
  $removeSlot,
  $setCompositionKey,
  $setSelection,
  $setSlot,
  COLLABORATION_TAG,
  DecoratorNode,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type SerializedLexicalNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, setup} from '../../utils/harness';

class Box extends ElementNode {
  $config() {
    return this.config('slot_reread_box', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isInline() {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM() {
    return false;
  }
}

class Host extends ElementNode {
  $config() {
    return this.config('slot_reread_host', {
      children: 'block',
      extends: ElementNode,
      slots: ['title', 'other'],
    });
  }
  createDOM() {
    return $getDocument().createElement('div');
  }
  updateDOM() {
    return false;
  }
}

class Widget extends DecoratorNode<null> {
  $config() {
    return this.config('slot_reread_widget', {
      extends: DecoratorNode,
      slots: ['title', 'other'],
    });
  }
  isInline() {
    return false;
  }
  createDOM() {
    return $getDocument().createElement('div');
  }
  updateDOM() {
    return false;
  }
  decorate() {
    return null;
  }
}

/** A reaction an app runs once, from a selection transform in a read. */
const reactions = new WeakMap<LexicalEditor, () => void>();

class Hook extends TextNode {
  $config() {
    return this.config('slot_reread_hook', {extends: TextNode});
  }
  // Merged with the text next to it as Lexical merges plain text (a copy's
  // text nodes then become one).
  isSimpleText() {
    return true;
  }
  selectionTransform() {
    const editor = $getEditor();
    const reaction = reactions.get(editor);
    if (reaction !== undefined && $hasUpdateTag(COLLABORATION_TAG)) {
      reactions.delete(editor);
      reaction();
    }
  }
}

const $hook = (text: string) => $create(Hook).setTextContent(text);

/** Every node, through children and named slots, in document order. */
function $walk(node: LexicalNode = $getRoot()): LexicalNode[] {
  return [
    node,
    ...($isElementNode(node) ? node.getChildren().flatMap(c => $walk(c)) : []),
    ...$getSlotNames(node).flatMap(name => {
      const value = $getSlot(node as ElementNode, name);
      return value === null ? [] : $walk(value);
    }),
  ];
}

const $texts = () =>
  $walk()
    .filter($isTextNode)
    .map(n => n.getTextContent())
    .join('|');

/** The composed text: the text node inside the Box. */
const $composed = (): TextNode =>
  $walk().find(
    (n): n is TextNode => $isTextNode(n) && n.getParent() instanceof Box,
  )!;

/** The slot hosts above the composed text, innermost first. */
function $slotChain(): {host: LexicalNode; name: string}[] {
  const out: {host: LexicalNode; name: string}[] = [];
  for (
    let n: LexicalNode | null = $composed();
    n !== null;
    n = n.getParent() ?? $getSlotHost(n)
  ) {
    const host = n.getParent() === null ? $getSlotHost(n) : null;
    if (host !== null) {
      const at = n;
      const name = $getSlotNames(host).find(s =>
        $getSlot(host as ElementNode, s)?.is(at),
      )!;
      out.push({host, name});
    }
  }
  return out;
}

/** A copy of `node` under new keys, with its children and named slots. */
function $copy(node: LexicalNode): LexicalNode {
  const json = (n: LexicalNode): SerializedLexicalNode => {
    const out = n.exportJSON() as SerializedLexicalNode & {
      children?: SerializedLexicalNode[];
      $slots?: Record<string, SerializedLexicalNode>;
    };
    if ($isElementNode(n)) {
      out.children = n.getChildren().map(json);
    }
    const names = $getSlotNames(n);
    if (names.length > 0) {
      out.$slots = Object.fromEntries(
        names.flatMap(name => {
          const value = $getSlot(n as ElementNode, name);
          return value === null ? [] : [[name, json(value)]];
        }),
      );
    }
    return out;
  };
  return $parseSerializedNode(json(node));
}

type HostKind = 'nested element hosts' | 'decorator' | 'decorator in a host';
type Edit =
  | 'remove'
  | 'move to the occupied slot'
  | 'replace with a copy'
  | 'unwrap the Box, then replace with a copy'
  | 'replace with a copy, then unwrap the copied Box'
  | 'remove the Box, then replace with a copy'
  | 'merge the composed text into the text before it, then replace with a copy';

/** The composed line, in a slot of `kind`'s host(s). */
function $build(kind: HostKind) {
  const line = $createParagraphNode().append(
    $hook('left'),
    $create(Box).append($hook('abc')),
    $hook('post'),
  );
  let content: LexicalNode;
  if (kind === 'nested element hosts') {
    content = line;
    for (let depth = 0; depth < 3; depth++) {
      const host = $create(Host);
      $setSlot(host, 'title', content);
      if (depth % 2 === 0) {
        $setSlot(
          host,
          'other',
          $createParagraphNode().append($hook('occupied')),
        );
      }
      content = host;
    }
  } else {
    const widget = $create(Widget);
    $setSlot(widget, 'title', line);
    $setSlot(widget, 'other', $createParagraphNode().append($hook('aside')));
    content = widget;
    if (kind === 'decorator in a host') {
      content = $setSlot($create(Host), 'title', content);
    }
  }
  $getRoot().append(
    $createParagraphNode().append($hook('lead')),
    content,
    $createParagraphNode().append($hook('separator')),
  );
}

/** A's edit of a slot holding what is composed in. */
function $edit(kind: HostKind, edit: Edit) {
  const chain = $slotChain();
  // The middle host's slot for nested element hosts, the decorator's for
  // the others.
  const {host, name} =
    kind === 'nested element hosts' && edit === 'replace with a copy'
      ? chain[1]
      : chain[0];
  // A copy of the composed line's slot value with another edit of that line
  // in the same update: the copy's text is the old value's text nodes, runs
  // of their own (their container goes), which Lexical merges into fewer
  // text nodes in the copy.
  const $copySlot = () =>
    $setSlot(
      host as ElementNode,
      name,
      $copy($getSlot(host as ElementNode, name)!),
    );
  const $unwrap = (box: ElementNode) => {
    for (const child of box.getChildren()) {
      box.insertBefore(child);
    }
    box.remove();
  };
  if (edit === 'unwrap the Box, then replace with a copy') {
    $unwrap($composed().getParentOrThrow());
    $copySlot();
  } else if (edit === 'replace with a copy, then unwrap the copied Box') {
    $copySlot();
    $unwrap(
      $walk($getSlot(host as ElementNode, name)!).find(
        (n): n is Box => n instanceof Box,
      )!,
    );
  } else if (edit === 'remove the Box, then replace with a copy') {
    $composed().getParentOrThrow().remove();
    $copySlot();
  } else if (
    edit ===
    'merge the composed text into the text before it, then replace with a copy'
  ) {
    const text = $composed();
    const box = text.getParentOrThrow();
    const before = box.getPreviousSibling() as TextNode;
    before.spliceText(0, before.getTextContentSize(), '');
    box.insertBefore(text);
    box.remove();
    before.getLatest().mergeWithSibling(text.getLatest());
    $copySlot();
  } else if (edit === 'remove') {
    $removeSlot(host as ElementNode, name);
  } else if (edit === 'move to the occupied slot') {
    $setSlot(
      host as ElementNode,
      name === 'title' ? 'other' : 'title',
      $getSlot(host as ElementNode, name)!,
    );
  } else {
    $setSlot(
      host as ElementNode,
      name,
      $copy($getSlot(host as ElementNode, name)!),
    );
  }
  // A selection left on a node the edit took out is cleared, as an app's
  // edit must (Lexical refuses to commit a selection on a removed node).
  const selection = $getSelection();
  if (
    $isRangeSelection(selection) &&
    !(
      selection.anchor.getNode().isAttached() &&
      selection.focus.getNode().isAttached()
    )
  ) {
    $setSelection(null);
  }
}

describe('a refused change of a slot of a decorator or a nested host, under a hold', () => {
  const shapes: [HostKind, Edit][] = [
    ['nested element hosts', 'replace with a copy'],
    ['decorator', 'remove'],
    ['decorator', 'move to the occupied slot'],
    ['decorator', 'replace with a copy'],
    ['decorator in a host', 'remove'],
    ['decorator in a host', 'move to the occupied slot'],
    ['decorator in a host', 'replace with a copy'],
    ...(
      ['nested element hosts', 'decorator', 'decorator in a host'] as const
    ).flatMap(kind =>
      (
        [
          'unwrap the Box, then replace with a copy',
          'replace with a copy, then unwrap the copied Box',
          'remove the Box, then replace with a copy',
          'merge the composed text into the text before it, then replace with a copy',
        ] as const
      ).map((edit): [HostKind, Edit] => [kind, edit]),
    ),
  ];
  for (const [kind, edit] of shapes) {
    for (const mode of ['local', 'read-edit'] as const) {
      for (const gc of [false, true]) {
        for (const ids of [
          [1, 2, 3],
          [3, 2, 1],
        ]) {
          test(`${kind}: ${edit} (${mode}) is refused, and A shows R once, as stored (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await setup(() => $build(kind), {
              gc,
              ids,
              nodes: [...NODES, Box, Host, Widget, Hook],
            });
            const {a, b, c} = t;
            const dom = document.createElement('div');
            dom.contentEditable = 'true';
            document.body.append(dom);
            a.editor.setRootElement(dom);
            dom.focus();
            onTestFinished(() => {
              a.editor.setRootElement(null);
              dom.remove();
              t.peers.forEach(p => p.stop());
            });
            // A composes in `abc`; B types R in it, held.
            a.update(() => {
              const n = $composed();
              n.select(1, 1);
              $setCompositionKey(n.getKey());
            });
            await t.sync();
            b.update(() => {
              $composed().spliceText(1, 0, 'R');
              $setSelection(null);
            });
            await t.sync();
            expect(a.read($texts)).not.toContain('R');
            const stored = b.read($texts);
            a.warnings.length = 0;
            if (mode === 'local') {
              a.update(() => $edit(kind, edit));
            } else {
              reactions.set(a.editor, () => $edit(kind, edit));
              c.update(() => {
                const n = $walk().find(
                  (x): x is TextNode =>
                    $isTextNode(x) && x.getTextContent() === 'separator',
                )!;
                n.spliceText(9, 0, '!');
                $setSelection(null);
              });
            }
            await t.sync();
            expect(a.warnings).toHaveLength(1);
            expect(a.warnings[0]).toMatch(
              /would delete or leave behind text a collaborator wrote/,
            );
            a.warnings.length = 0;
            a.update(() => $setCompositionKey(null));
            await t.sync();
            const fresh = await freshReader(a);
            onTestFinished(() => fresh.stop());
            const want = mode === 'local' ? stored : `${stored}!`;
            for (const p of [...t.peers, fresh]) {
              expect(p.read($texts)).toBe(want);
              expect(JSON.stringify(p.json())).toBe(
                JSON.stringify(fresh.json()),
              );
            }
            expect(want.split('R')).toHaveLength(2);
            expect(a.warnings).toEqual([]);
          });
        }
      }
    }
  }
});
