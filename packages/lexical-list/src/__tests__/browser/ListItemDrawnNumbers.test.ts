/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The list's drawn-number cases in a real browser: the number compared with
// each item's `getValue()` is the marker the browser itself draws, read from
// its accessibility tree (a ListMarker per drawn item), not computed from the
// attributes.

import {
  $createListNode,
  $isListItemNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $getNearestNodeFromDOMNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';
import {cdp} from 'vitest/browser';

import {$item, LIST_EDIT_CASES} from '../unit/listEditCases';

interface FrameTree {
  frame: {id: string};
  childFrames?: FrameTree[];
}

interface AXNode {
  nodeId: string;
  parentId?: string;
  backendDOMNodeId?: number;
  role?: {value: string};
  name?: {value: string};
}

/**
 * The number the browser draws for each item, keyed by the item's position
 * among the editor's `<li>` elements.
 */
async function drawnMarkers(root: HTMLElement): Promise<Map<number, number>> {
  root.querySelectorAll('li').forEach((li, i) => {
    li.setAttribute('data-test-index', String(i));
  });
  // The test runs in a frame of the runner's page: read every frame's tree.
  const {frameTree} = (await cdp().send('Page.getFrameTree')) as {
    frameTree: FrameTree;
  };
  const frames: string[] = [];
  const walk = (t: FrameTree) => {
    frames.push(t.frame.id);
    (t.childFrames ?? []).forEach(walk);
  };
  walk(frameTree);
  const drawn = new Map<number, number>();
  for (const frameId of frames) {
    const {nodes} = (await cdp().send('Accessibility.getFullAXTree', {
      frameId,
    })) as {nodes: AXNode[]};
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    for (const marker of nodes) {
      if (
        marker.role?.value !== 'ListMarker' ||
        marker.parentId === undefined
      ) {
        continue;
      }
      const item = byId.get(marker.parentId);
      if (item?.backendDOMNodeId === undefined) {
        continue;
      }
      const {node} = (await cdp().send('DOM.describeNode', {
        backendNodeId: item.backendDOMNodeId,
      })) as {node: {attributes?: string[]}};
      const attrs = node.attributes ?? [];
      const at = attrs.indexOf('data-test-index');
      const number = Number.parseInt((marker.name?.value ?? '').trim(), 10);
      if (at >= 0 && !Number.isNaN(number)) {
        drawn.set(Number(attrs[at + 1]), number);
      }
    }
  }
  root.querySelectorAll('li').forEach(li => {
    li.removeAttribute('data-test-index');
  });
  return drawn;
}

/** Each drawn numbered item's `getValue()`, keyed like `drawnMarkers`. */
function modelNumbers(
  editor: LexicalEditor,
  {wrappers = false}: {wrappers?: boolean} = {},
): Map<number, number> {
  const root = editor.getRootElement()!;
  const out = new Map<number, number>();
  editor.read(() => {
    root.querySelectorAll('li').forEach((li, i) => {
      const first = li.firstElementChild;
      if (
        li.parentElement?.tagName !== 'OL' ||
        (!wrappers &&
          first !== null &&
          (first.tagName === 'OL' || first.tagName === 'UL'))
      ) {
        return;
      }
      const node = $getNearestNodeFromDOMNode(li);
      if ($isListItemNode(node)) {
        out.set(i, node.getValue());
      }
    });
  });
  return out;
}

function mount({hideWrapperMarkers = true} = {}): LexicalEditor {
  const editor = createEditor({
    nodes: [ListNode, ListItemNode, ParagraphNode, TextNode],
    onError: e => {
      throw e;
    },
  });
  // A list theme hides the marker of an item that only wraps a nested list.
  const style = document.createElement('style');
  style.textContent = hideWrapperMarkers
    ? 'li:has(> ol:first-child, > ul:first-child) { list-style-type: none; }'
    : '';
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(style, root);
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.setRootElement(null);
    root.remove();
    style.remove();
  });
  return editor;
}

test.each(LIST_EDIT_CASES.map(c => [c.name, c] as const))(
  '%s: the browser draws every item’s own number',
  async (_name, c) => {
    const editor = mount();
    const root = editor.getRootElement()!;
    editor.update(() => $getRoot().append(...c.$build()), {discrete: true});
    // A check list draws no numbers; every other case starts numbered.
    expect(await drawnMarkers(root), 'built').toEqual(modelNumbers(editor));
    editor.update(c.$edit, {discrete: true});
    expect(await drawnMarkers(root), 'edited').toEqual(modelNumbers(editor));
  },
);

test.each(LIST_EDIT_CASES.map(c => [c.name, c] as const))(
  '%s: with wrapper markers shown, each wrapper draws its own number too',
  async (_name, c) => {
    const editor = mount({hideWrapperMarkers: false});
    const root = editor.getRootElement()!;
    editor.update(() => $getRoot().append(...c.$build()), {discrete: true});
    expect(await drawnMarkers(root), 'built').toEqual(
      modelNumbers(editor, {wrappers: true}),
    );
    editor.update(c.$edit, {discrete: true});
    expect(await drawnMarkers(root), 'edited').toEqual(
      modelNumbers(editor, {wrappers: true}),
    );
  },
);

// Documented in the changeset: the browser counts what it draws, so a
// `reversed` list and a hidden item number from the browser's own count.
test('documented: a reversed list counts down from the browser count', async () => {
  const editor = mount();
  const root = editor.getRootElement()!;
  editor.update(
    () => {
      $getRoot().append(
        $createListNode('number').append($item('a'), $item('b'), $item('c')),
      );
    },
    {discrete: true},
  );
  root.querySelector('ol')!.setAttribute('reversed', '');
  // The model says 1, 2, 3; with no `value` the browser counts 3, 2, 1.
  expect(await drawnMarkers(root)).toEqual(
    new Map([
      [0, 3],
      [1, 2],
      [2, 1],
    ]),
  );
});

test('documented: an item hidden with display: none shifts the numbers after it', async () => {
  const editor = mount();
  const root = editor.getRootElement()!;
  editor.update(
    () => {
      $getRoot().append(
        $createListNode('number').append($item('a'), $item('b'), $item('c')),
      );
    },
    {discrete: true},
  );
  (root.querySelector('ol > li') as HTMLElement).style.display = 'none';
  // b and c are 2 and 3 in the model; the browser no longer counts a.
  expect(await drawnMarkers(root)).toEqual(
    new Map([
      [1, 1],
      [2, 2],
    ]),
  );
});
