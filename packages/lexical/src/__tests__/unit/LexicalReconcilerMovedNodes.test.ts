/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getNodeByKey,
  $getRoot,
  $setSlot,
  createEditor,
  ElementNode,
  type LexicalNode,
  type NodeKey,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {
  $createTestDecoratorNode,
  $createTestElementNode,
  $createTestInlineElementNode,
  $createTestUpdateDOMTrueHostNode,
  TestDecoratorNode,
  TestElementNode,
  TestInlineElementNode,
  TestUpdateDOMTrueHostNode,
} from '../utils';

// Model a slot prelude plus a trailing decoration such as a drag handle.
class AnchoredElementNode extends ElementNode {
  $config() {
    return this.config('moved_nodes_anchored', {extends: ElementNode});
  }
  createDOM() {
    const dom = $getDocument().createElement('section');
    const prelude = $getDocument().createElement('header');
    const handle = $getDocument().createElement('footer');
    prelude.contentEditable = handle.contentEditable = 'false';
    dom.append(prelude, handle);
    return dom;
  }
  updateDOM() {
    return false;
  }
  getDOMSlot(dom: HTMLElement) {
    return super
      .getDOMSlot(dom)
      .withBefore(dom.lastChild)
      .withAfter(dom.firstChild);
  }
}

class TextAnchoredElementNode extends AnchoredElementNode {
  $config() {
    return this.config('moved_nodes_text_anchored', {
      extends: AnchoredElementNode,
    });
  }
  createDOM() {
    const dom = super.createDOM();
    dom.lastChild!.replaceWith(
      $getDocument().createTextNode('trailing-decoration'),
    );
    return dom;
  }
}

function setup() {
  const errors: string[] = [];
  const editor = buildEditorFromExtensions({
    name: 'reconciler-moved-nodes',
    nodes: [
      AnchoredElementNode,
      TextAnchoredElementNode,
      TestDecoratorNode,
      TestElementNode,
      TestInlineElementNode,
      TestUpdateDOMTrueHostNode,
    ],
    onError: (error: Error) => {
      errors.push(error.message);
    },
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  return {editor, errors, root};
}

function check(
  s: ReturnType<typeof setup>,
  label = '',
  prepareFresh?: (fresh: ReturnType<typeof setup>) => void,
) {
  const fresh = setup();
  fresh.editor.setEditorState(
    fresh.editor.parseEditorState(
      JSON.stringify(s.editor.getEditorState().toJSON()),
    ),
  );
  prepareFresh?.(fresh);
  expect(fresh.errors, 'fresh render errors').toEqual([]);
  // Check both even when recovery produces a superficially correct DOM.
  expect({errors: s.errors, html: s.root.innerHTML}, label).toEqual({
    errors: [],
    html: fresh.root.innerHTML,
  });
  fresh.editor.dispose();
  fresh.root.remove();
}

for (const anchored of [false, true, 'text'] as const) {
  for (const mode of ['new', 'reuse', 'replace'] as const) {
    for (const childKind of [
      'text',
      'decorator',
      'block',
      'element-slot',
      'decorator-slot',
    ] as const) {
      test(`${mode} wrapper taking ${childKind}; anchored=${anchored}`, () => {
        const s = setup();
        const keys: Record<string, NodeKey> = {};
        s.editor.update(
          () => {
            const parent =
              anchored === 'text'
                ? new TextAnchoredElementNode()
                : anchored
                  ? new AnchoredElementNode()
                  : $createTestElementNode();
            const x = $createTextNode('x').setMode('token');
            const br = $createLineBreakNode();
            const y = $createTextNode('y').setMode('token');
            const m = $createTestInlineElementNode().append(
              $createTextNode('m'),
            );
            const w =
              childKind === 'text'
                ? $createTextNode('w').setMode('token')
                : childKind === 'decorator'
                  ? $createTestDecoratorNode()
                  : $createTestElementNode().append($createTextNode('w'));
            for (const [name, node] of Object.entries({br, m, parent, w, x}))
              keys[name] = node.getKey();
            $getRoot()
              .clear()
              .append(parent.append(x, br, y, m, w));
            if (mode !== 'new') {
              const wrapper =
                childKind === 'decorator-slot'
                  ? $createTestDecoratorNode().setIsInline(mode === 'replace')
                  : mode === 'replace'
                    ? $createTestUpdateDOMTrueHostNode()
                    : $createTestElementNode();
              keys.wrapper = wrapper.getKey();
              $getRoot().append($createTestElementNode().append(wrapper));
            }
          },
          {discrete: true},
        );
        s.editor.update(
          () => {
            const get = (name: string) => $getNodeByKey(keys[name])!;
            const w = get('w');
            let wrapper: LexicalNode;
            if (mode !== 'new') {
              wrapper = get('wrapper');
              if (childKind === 'decorator-slot') {
                (wrapper as TestDecoratorNode).setIsInline(false);
                $setSlot(
                  wrapper as TestDecoratorNode,
                  'body',
                  w as ElementNode,
                );
              } else if (childKind === 'element-slot') {
                $setSlot(wrapper as ElementNode, 'body', w as ElementNode);
              } else {
                (wrapper as ElementNode).append(w);
              }
            } else if (childKind === 'decorator-slot') {
              wrapper = $createTestDecoratorNode().setIsInline(false);
              $setSlot(wrapper as TestDecoratorNode, 'body', w as ElementNode);
            } else {
              const element = $createTestElementNode();
              if (childKind === 'element-slot')
                $setSlot(element, 'body', w as ElementNode);
              else element.append(w);
              wrapper = element;
            }
            const parent = get('parent') as ElementNode;
            parent.splice(0, parent.getChildrenSize(), [
              get('x'),
              get('m'),
              wrapper,
              get('br'),
            ]);
          },
          {discrete: true},
        );
        check(s);
      });
    }
  }
}

// Each step changes parentage, sibling order and wrapper identity. The tree is
// acyclic by construction; token text avoids accidental adjacent-text merging.
for (const variant of ['ordinary', 'replace', 'anchors'] as const) {
  test(`2,000 seeded forest updates: ${variant}`, () => {
    let seed = 19;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const shuffle = <T>(a: T[]) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = rand(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const $createElement = (i: number) =>
      variant === 'anchors'
        ? new AnchoredElementNode()
        : variant === 'replace' && i % 2 === 1
          ? $createTestUpdateDOMTrueHostNode()
          : $createTestElementNode();
    const s = setup();
    const keys: NodeKey[] = [];
    let previous: number[][] = [];
    for (let iteration = 0; iteration < 2000; iteration++) {
      const order = shuffle([0, 1, 2, 3, 4, 5]);
      const children: number[][] = Array.from({length: 7}, () => []);
      order.forEach((id, i) =>
        children[i === 0 || rand(3) === 0 ? 6 : order[rand(i)]].push(id),
      );
      for (let id = 6; id < 14; id++) children[rand(6)].push(id);
      children.forEach(shuffle);
      s.editor.update(
        () => {
          const nodes: LexicalNode[] = [];
          for (let i = 0; i < 14; i++) {
            nodes[i] =
              iteration === 0
                ? i < 6
                  ? $createElement(i)
                  : $createTextNode(`t${i}`).setMode('token')
                : $getNodeByKey(keys[i])!;
          }
          $getRoot().clear();
          nodes.forEach(n => {
            if (n instanceof ElementNode) n.clear();
          });
          if (iteration > 0) {
            for (let i = 0; i < 6; i++)
              if (rand(3) === 0) nodes[i] = $createElement(i);
          }
          nodes.forEach((node, i) => {
            keys[i] = node.getKey();
          });
          children.forEach((ids, parent) => {
            (parent === 6 ? $getRoot() : (nodes[parent] as ElementNode)).append(
              ...ids.map(i => nodes[i]),
            );
          });
        },
        {discrete: true},
      );
      check(s, JSON.stringify({children, iteration, previous}));
      previous = children;
    }
  }, 30000);
}

for (const anchored of [false, true]) {
  test(`first managed child and append path; anchored=${anchored}`, () => {
    const s = setup();
    let parentKey: NodeKey;
    let textKey: NodeKey;
    s.editor.update(
      () => {
        const parent = anchored
          ? new AnchoredElementNode()
          : $createTestElementNode();
        const text = $createTextNode('first');
        parentKey = parent.getKey();
        textKey = text.getKey();
        $getRoot().clear().append(parent.append(text));
      },
      {discrete: true},
    );
    s.editor.update(
      () => {
        const parent = $getNodeByKey(parentKey)! as ElementNode;
        parent.append(
          $createTestElementNode().append($getNodeByKey(textKey)!),
          $createLineBreakNode(),
        );
      },
      {discrete: true},
    );
    check(s);
  });
}

test('updates without cross-parent moves and JSON with fresh keys', () => {
  const s = setup();
  let textKey: NodeKey;
  s.editor.update(
    () => {
      const text = $createTextNode('before');
      textKey = text.getKey();
      $getRoot().clear().append(new AnchoredElementNode().append(text));
    },
    {discrete: true},
  );
  s.editor.update(
    () => {
      (
        $getNodeByKey(textKey)! as ReturnType<typeof $createTextNode>
      ).setTextContent('after');
      ($getRoot().getFirstChildOrThrow() as ElementNode).append(
        $createLineBreakNode(),
      );
    },
    {discrete: true},
  );
  check(s);
  const json = JSON.stringify(s.editor.getEditorState().toJSON());
  s.editor.setEditorState(s.editor.parseEditorState(json));
  check(s);
});

test('a moved decorator preserves its mounted nested editor', () => {
  const s = setup();
  const keys: Record<string, NodeKey> = {};
  s.editor.update(
    () => {
      const parent = $createTestElementNode();
      const x = $createTextNode('x').setMode('token');
      const br = $createLineBreakNode();
      const y = $createTextNode('y').setMode('token');
      const m = $createTestInlineElementNode().append($createTextNode('m'));
      const w = $createTestDecoratorNode();
      for (const [name, node] of Object.entries({br, m, parent, w, x}))
        keys[name] = node.getKey();
      $getRoot()
        .clear()
        .append(parent.append(x, br, y, m, w));
    },
    {discrete: true},
  );
  const mountNested = (
    owner: ReturnType<typeof setup>,
    wrapper: HTMLElement,
    json?: string,
  ) => {
    const nested = createEditor({
      namespace: 'reconciler-moved-nodes-nested',
      onError: e => {
        owner.errors.push(e.message);
      },
      parentEditor: owner.editor,
    });
    const nestedRoot = wrapper.ownerDocument.createElement('div');
    nestedRoot.contentEditable = 'true';
    wrapper.append(nestedRoot);
    nested.setRootElement(nestedRoot);
    onTestFinished(() => nested.setRootElement(null));
    if (json) nested.setEditorState(nested.parseEditorState(json));
    else
      nested.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('nested text')),
          );
        },
        {discrete: true},
      );
    return {nested, nestedRoot};
  };
  const wrapper = s.editor.getElementByKey(keys.w)!;
  const {nested, nestedRoot} = mountNested(s, wrapper);
  s.editor.update(
    () => {
      const get = (name: string) => $getNodeByKey(keys[name])!;
      const newWrapper = $createTestElementNode().append(get('w'));
      const parent = get('parent') as ElementNode;
      parent.splice(0, parent.getChildrenSize(), [
        get('x'),
        get('m'),
        newWrapper,
        get('br'),
      ]);
    },
    {discrete: true},
  );
  expect(s.editor.getElementByKey(keys.w)).toBe(wrapper);
  expect(nested.getRootElement()).toBe(nestedRoot);
  check(s, 'nested editor content survives', fresh => {
    mountNested(
      fresh,
      fresh.root.querySelector('[data-lexical-decorator]')!,
      JSON.stringify(nested.getEditorState().toJSON()),
    );
  });
});
