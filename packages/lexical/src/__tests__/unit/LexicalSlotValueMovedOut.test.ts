/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $removeSlot,
  $setSlot,
  createEditor,
  DecoratorNode,
  type EditorState,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  mountSlotContainer,
  type NodeKey,
  type NodeMutation,
  ParagraphNode,
  setDOMUnmanaged,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// A slot value moved out of its slot in the same update in which the slot is
// removed (or its host is removed, or the slot gets another value). When the
// value's new place is rendered before its old host, the reconciler has
// already moved the value's DOM there when it cleans up the old slot, so the
// old slot container has to be the one it removes, not the value's new
// parent.

class Host extends ElementNode {
  $config() {
    return this.config('slot_moved_out_host', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('section');
  }
  updateDOM(): boolean {
    return false;
  }
}

class RebuiltHost extends ElementNode {
  $config() {
    return this.config('slot_moved_out_rebuilt_host', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('article');
  }
  updateDOM(): boolean {
    return true;
  }
}

class DecoratorHost extends DecoratorNode<null> {
  $config() {
    return this.config('slot_moved_out_decorator_host', {
      extends: DecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    return document.createElement('aside');
  }
  updateDOM(): boolean {
    return false;
  }
  decorate(): null {
    return null;
  }
  isInline(): boolean {
    return false;
  }
}

type Mounted = {
  editor: LexicalEditor;
  errors: string[];
  root: HTMLElement;
};

function mount(): Mounted {
  const errors: string[] = [];
  const editor = createEditor({
    namespace: 'slot-moved-out',
    nodes: [DecoratorHost, Host, RebuiltHost],
    onError: e => {
      errors.push(e.message);
    },
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  return {editor, errors, root};
}

function freshHTML(state: EditorState): string {
  const fresh = mount();
  fresh.editor.setEditorState(state.clone(null));
  const html = fresh.root.innerHTML;
  fresh.editor.setRootElement(null);
  fresh.root.remove();
  return html;
}

function $text(text: string): ParagraphNode {
  return $createParagraphNode().append($createTextNode(text));
}

const ORDERS = ['new place first', 'old host first'] as const;
const TARGETS = ['new element', 'existing element', 'rebuilt element'] as const;
const INTO = ['child', 'new slot', 'replaced slot value'] as const;
const LEAVES = [
  'slot removed',
  'host removed',
  'slot gets a new value',
] as const;

describe('a slot value moved out of its slot in one update', () => {
  for (const order of ORDERS) {
    for (const target of TARGETS) {
      for (const into of INTO) {
        for (const leaves of LEAVES) {
          test(`${order}, into a ${target} as a ${into}, ${leaves}`, () => {
            const {editor, errors, root} = mount();
            const destroyed: NodeKey[] = [];
            const created: NodeKey[] = [];
            editor.registerMutationListener(
              ParagraphNode,
              (mutations: Map<NodeKey, NodeMutation>) => {
                for (const [key, mutation] of mutations) {
                  if (mutation === 'destroyed') {
                    destroyed.push(key);
                  } else if (mutation === 'created') {
                    created.push(key);
                  }
                }
              },
              {skipInitialization: true},
            );
            const k: Record<string, NodeKey> = {};
            editor.update(
              () => {
                const a = new Host().append($text('a'));
                const value = $text('moved');
                $setSlot(a as never, 's0' as never, value);
                const t =
                  target === 'rebuilt element' ? new RebuiltHost() : new Host();
                t.append($text('t'));
                if (into === 'replaced slot value') {
                  const old = $text('replaced');
                  $setSlot(t as never, 's1' as never, old);
                  k.replaced = old.getKey();
                }
                const tail = $text('tail');
                if (target === 'new element') {
                  $getRoot().clear().append(a, tail);
                } else if (order === 'new place first') {
                  $getRoot().clear().append(t, a, tail);
                } else {
                  $getRoot().clear().append(a, t, tail);
                }
                k.a = a.getKey();
                k.t = t.getKey();
                k.value = value.getKey();
              },
              {discrete: true},
            );
            created.length = 0;
            editor.update(
              () => {
                const a = $getNodeByKey(k.a) as Host;
                const value = $getNodeByKey(k.value) as ParagraphNode;
                let t: ElementNode;
                if (target === 'new element') {
                  t = new Host().append($text('t'));
                  if (order === 'new place first') {
                    a.insertBefore(t);
                  } else {
                    a.insertAfter(t);
                  }
                  k.t = t.getKey();
                } else {
                  t = $getNodeByKey(k.t) as ElementNode;
                }
                if (leaves === 'slot removed') {
                  $removeSlot(a as never, 's0' as never);
                } else if (leaves === 'slot gets a new value') {
                  $removeSlot(a as never, 's0' as never);
                  $setSlot(a as never, 's0' as never, $text('new value'));
                } else {
                  $removeSlot(a as never, 's0' as never);
                }
                if (into === 'child') {
                  t.append(value);
                } else if (into === 'new slot') {
                  $setSlot(t as never, 's2' as never, value);
                } else {
                  $setSlot(t as never, 's1' as never, value);
                }
                if (leaves === 'host removed') {
                  a.remove();
                }
              },
              {discrete: true},
            );
            const state = editor.getEditorState();
            expect(errors).toEqual([]);
            // Removed nodes leave the DOM map. (A removed node under an
            // element built anew is a separate leak, left alone here.)
            if (target !== 'rebuilt element') {
              const stale = [...editor._keyToDOMMap.keys()].filter(
                key => !state._nodeMap.has(key),
              );
              expect(stale).toEqual([]);
            }
            // Every node's element is in the editor's DOM.
            const detached: string[] = [];
            state._nodeMap.forEach((node: LexicalNode, key: NodeKey) => {
              if (key === 'root') {
                return;
              }
              const el = editor.getElementByKey(key);
              if (el === null || !root.contains(el)) {
                detached.push(`${node.getType()}#${key}`);
              }
            });
            expect(detached).toEqual([]);
            expect(root.innerHTML).toBe(freshHTML(state));
            // The moved value is neither destroyed nor created again.
            expect(destroyed).not.toContain(k.value);
            expect(created).not.toContain(k.value);
            // A later update that inserts next to the new place works.
            editor.update(
              () => {
                $getNodeByKey(k.t)!.insertBefore($text('later'));
              },
              {discrete: true},
            );
            expect(errors).toEqual([]);
            expect(root.innerHTML).toBe(freshHTML(editor.getEditorState()));
            editor.setRootElement(null);
            root.remove();
          });
        }
      }
    }
  }
});

test('a slot container a decorator host placed elsewhere is removed, and the element the value moved into keeps its DOM', () => {
  const {editor, errors, root} = mount();
  const k: Record<string, NodeKey> = {};
  editor.update(
    () => {
      const host = new DecoratorHost();
      const dest = new Host().append($text('destination'));
      const value = $text('moved');
      $setSlot(host as never, 's0' as never, value);
      $getRoot().clear().append(dest, host, $text('tail'));
      k.host = host.getKey();
      k.dest = dest.getKey();
      k.value = value.getKey();
    },
    {discrete: true},
  );
  // The host places its slot container outside its own DOM, as a decorator
  // that renders the slot in its chrome does.
  const chrome = document.createElement('nav');
  setDOMUnmanaged(chrome);
  root.append(chrome);
  const container = mountSlotContainer(editor, k.host, 's0', chrome)!;
  const destDOM = editor.getElementByKey(k.dest)!;
  editor.update(
    () => {
      $removeSlot($getNodeByKey(k.host) as never, 's0' as never);
      ($getNodeByKey(k.dest) as ElementNode).append($getNodeByKey(k.value)!);
    },
    {discrete: true},
  );
  expect(errors).toEqual([]);
  expect(root.contains(destDOM)).toBe(true);
  expect(container.isConnected).toBe(false);
  expect(chrome.childElementCount).toBe(0);
  chrome.remove();
  expect(root.innerHTML).toBe(freshHTML(editor.getEditorState()));
  editor.setRootElement(null);
  root.remove();
});

test('a decorator slot value moved into an element rendered before its old host keeps that element and its own DOM', () => {
  const {editor, errors, root} = mount();
  const k: Record<string, NodeKey> = {};
  editor.update(
    () => {
      const host = new Host().append($text('a'));
      const dest = new Host().append($text('destination'));
      const value = new DecoratorHost();
      $setSlot(host as never, 's0' as never, value);
      $getRoot().clear().append(dest, host, $text('tail'));
      k.host = host.getKey();
      k.dest = dest.getKey();
      k.value = value.getKey();
    },
    {discrete: true},
  );
  const destDOM = editor.getElementByKey(k.dest)!;
  const valueDOM = editor.getElementByKey(k.value)!;
  editor.update(
    () => {
      $removeSlot($getNodeByKey(k.host) as never, 's0' as never);
      ($getNodeByKey(k.dest) as ElementNode).append($getNodeByKey(k.value)!);
    },
    {discrete: true},
  );
  expect(errors).toEqual([]);
  expect(root.contains(destDOM)).toBe(true);
  expect(editor.getElementByKey(k.value)).toBe(valueDOM);
  expect(root.contains(valueDOM)).toBe(true);
  expect(root.innerHTML).toBe(freshHTML(editor.getEditorState()));
  editor.setRootElement(null);
  root.remove();
});

describe('slot values swapped in one update', () => {
  for (const shape of [
    'between two slots of one host',
    'between two hosts, the later host first in the update',
    'between two hosts, the earlier host first in the update',
  ] as const) {
    test(shape, () => {
      const {editor, errors, root} = mount();
      const k: Record<string, NodeKey> = {};
      editor.update(
        () => {
          const first = new Host().append($text('first'));
          const second =
            shape === 'between two slots of one host'
              ? first
              : new Host().append($text('second'));
          const v = $text('v');
          const w = $text('w');
          $setSlot(first as never, 's0' as never, v);
          $setSlot(second as never, 's1' as never, w);
          if (second === first) {
            $getRoot().clear().append(first, $text('tail'));
          } else {
            $getRoot().clear().append(first, second, $text('tail'));
          }
          k.first = first.getKey();
          k.second = second.getKey();
          k.v = v.getKey();
          k.w = w.getKey();
        },
        {discrete: true},
      );
      const vDOM = editor.getElementByKey(k.v)!;
      const wDOM = editor.getElementByKey(k.w)!;
      editor.update(
        () => {
          const first = $getNodeByKey(k.first)!;
          const second = $getNodeByKey(k.second)!;
          const v = $getNodeByKey(k.v)!;
          const w = $getNodeByKey(k.w)!;
          if (
            shape === 'between two hosts, the later host first in the update'
          ) {
            $removeSlot(second as never, 's1' as never);
            $removeSlot(first as never, 's0' as never);
          } else {
            $removeSlot(first as never, 's0' as never);
            $removeSlot(second as never, 's1' as never);
          }
          $setSlot(first as never, 's0' as never, w);
          $setSlot(second as never, 's1' as never, v);
        },
        {discrete: true},
      );
      expect(errors).toEqual([]);
      expect(editor.getElementByKey(k.v)).toBe(vDOM);
      expect(editor.getElementByKey(k.w)).toBe(wDOM);
      expect(root.contains(vDOM)).toBe(true);
      expect(root.contains(wDOM)).toBe(true);
      expect(root.innerHTML).toBe(freshHTML(editor.getEditorState()));
      editor.setRootElement(null);
      root.remove();
    });
  }
});

test('a new element rendered before the old host that is removed in the same update keeps its DOM', () => {
  const {editor, errors, root} = mount();
  const k: Record<string, NodeKey> = {};
  editor.update(
    () => {
      const x = $text('x');
      const host = new Host().append($text('a'));
      const value = $text('moved');
      $setSlot(host as never, 's0' as never, value);
      $getRoot().clear().append(x, host, $text('tail'));
      k.x = x.getKey();
      k.host = host.getKey();
      k.value = value.getKey();
    },
    {discrete: true},
  );
  editor.update(
    () => {
      const host = $getNodeByKey(k.host)!;
      const t = new Host().append($text('t'));
      $getNodeByKey(k.x)!.insertBefore(t);
      $removeSlot(host as never, 's0' as never);
      t.append($getNodeByKey(k.value)!);
      host.remove();
      k.t = t.getKey();
    },
    {discrete: true},
  );
  expect(errors).toEqual([]);
  expect(root.contains(editor.getElementByKey(k.t))).toBe(true);
  expect(root.innerHTML).toBe(freshHTML(editor.getEditorState()));
  editor.setRootElement(null);
  root.remove();
});
