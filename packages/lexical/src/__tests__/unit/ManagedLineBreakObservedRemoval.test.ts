/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * The editor's MutationObserver reverts DOM changes it did not make. It puts
 * a removed node of a block's managed line break (the keyless `<br>` the
 * reconciler adds after a block's last inline decorator or LineBreakNode, or
 * in an empty block) back where it was, and once it has seen every record of
 * a batch, `reconcileObservedMutation` puts each changed block back together:
 * it moves the keyed children into place and rebuilds the line break if it is
 * no longer whole. After a batch that removes or moves keyed children, that
 * line break, or both, the DOM must again be what Lexical renders for the
 * unchanged editor state, with no error reported, and nodes Lexical does not
 * manage (a slot's boundaries, DOM marked with setDOMUnmanaged) must keep
 * their place. That holds too for a change the observer recorded but had not
 * reported when a commit disconnected it to render.
 *
 * jsdom models the Chromium / Firefox shape of the managed line break (a
 * plain `<br>`); the WebKit img+br shape and native editing are covered by
 * `__tests__/browser/ManagedLineBreakObservedRemoval.test.ts`.
 */

import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$assertNodeType, expectHtmlToBeEqual} from '../utils';
import {
  BlockDecoratorNode,
  decorators,
  FramedBlockNode,
  InlineDecoratorNode,
  managedLineBreak,
  MarkedBlockNode,
  type MountedEditor,
  mountEditor,
  observeBatch,
  remove,
  renderFresh,
  unmanagedSpan,
  WrappedBlockNode,
} from '../utils/observedMutation';

/** The observer restored exactly what Lexical rendered, and nothing changed. */
function expectRestored({
  editor,
  errors,
  renderedHTML,
  renderedJSON,
  root,
}: MountedEditor): void {
  expect(errors).toEqual([]);
  expectHtmlToBeEqual(root.innerHTML, renderedHTML);
  expect(editor.getEditorState().toJSON()).toEqual(renderedJSON);
}

/** The DOM is what a fresh editor renders for the current editor state. */
function expectRendersEditorState({editor, errors, root}: MountedEditor) {
  expect(errors).toEqual([]);
  expectHtmlToBeEqual(root.innerHTML, renderFresh(editor));
}

/** Append text to the first block, marking it dirty. */
function appendTextToFirstBlock({editor}: MountedEditor, text: string): void {
  editor.update(
    () => {
      $assertNodeType($getRoot().getFirstChild(), $isElementNode).append(
        $createTextNode(text),
      );
    },
    {discrete: true},
  );
}

/**
 * As an extension decorating a block would, run `add` on the first block in
 * one batch; then run `mutate` in a second batch. The revert must leave the
 * DOM as it was after the first batch.
 */
async function expectUnmanagedKept(
  mounted: MountedEditor,
  add: (block: HTMLElement) => void,
  mutate: (block: HTMLElement) => void,
): Promise<void> {
  const {block, errors, root} = mounted;
  await observeBatch(root, () => add(block));
  const withUnmanaged = root.innerHTML;
  await observeBatch(root, () => mutate(block));
  expect(errors).toEqual([]);
  expectHtmlToBeEqual(root.innerHTML, withUnmanaged);
}

/** Swap `block`'s unmanaged span for an equal one, in one batch. */
function swapUnmanagedSpan(block: HTMLElement): void {
  const span = block.querySelector('[data-unmanaged]')!;
  block.insertBefore(unmanagedSpan(span.textContent!), span);
  remove(span);
}

/** `html` without the elements that match `selector`. */
function withoutDOM(html: string, selector: string): string {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  body.querySelectorAll(selector).forEach(element => element.remove());
  return body.innerHTML;
}

const textSpans = (element: Element) =>
  element.querySelectorAll('[data-lexical-text]');

const $endingWithDecorator = () =>
  $createParagraphNode().append(
    $createTextNode('ab'),
    $create(InlineDecoratorNode),
  );
const $endingWithLineBreak = () =>
  $createParagraphNode().append($createTextNode('ab'), $createLineBreakNode());
const $tokens = () =>
  $createParagraphNode().append(
    $createTextNode('ab').setMode('token'),
    $createTextNode('cd').setMode('token'),
    $createTextNode('ef').setMode('token'),
  );

describe('a paragraph ending with an inline decorator', () => {
  const $children = () => [$endingWithDecorator()];

  test('removing the decorator alone', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () =>
      remove(...decorators(mounted.block)),
    );
    expectRestored(mounted);
  });

  test('removing the decorator, then the line break', async () => {
    const mounted = mountEditor($children);
    const {block} = mounted;
    await observeBatch(mounted.root, () =>
      remove(...decorators(block), ...managedLineBreak(block)),
    );
    expectRestored(mounted);
  });

  test('removing the line break, then the decorator in a later record', async () => {
    const mounted = mountEditor($children);
    const {block} = mounted;
    await observeBatch(mounted.root, () =>
      remove(...managedLineBreak(block), ...decorators(block)),
    );
    expectRestored(mounted);
  });

  test('removing every child in one record', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () => {
      mounted.block.textContent = '';
    });
    expectRestored(mounted);
  });

  test('removing the line break alone', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () =>
      remove(...managedLineBreak(mounted.block)),
    );
    expectRestored(mounted);
  });

  test('moving the decorator to the start of the paragraph', async () => {
    const mounted = mountEditor($children);
    const {block} = mounted;
    await observeBatch(mounted.root, () => {
      block.insertBefore(decorators(block)[0], block.firstChild);
    });
    expectRestored(mounted);
  });

  test('moving the line break to the start of the paragraph', async () => {
    const mounted = mountEditor($children);
    const {block} = mounted;
    await observeBatch(mounted.root, () => {
      block.insertBefore(managedLineBreak(block)[0], block.firstChild);
    });
    expectRestored(mounted);
  });

  test("moving the line break into the decorator's DOM", async () => {
    const mounted = mountEditor($children);
    const {block} = mounted;
    await observeBatch(mounted.root, () => {
      decorators(block)[0].appendChild(managedLineBreak(block)[0]);
    });
    expectRestored(mounted);
  });

  test('adding a keyless <br> right after the line break', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () => {
      mounted.block.appendChild(document.createElement('br'));
    });
    expectRestored(mounted);
  });

  test('a later edit at the end of the paragraph still renders', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () =>
      remove(...decorators(mounted.block)),
    );
    appendTextToFirstBlock(mounted, 'c');
    expectRendersEditorState(mounted);
  });
});

describe('a paragraph ending with text and an inline decorator after a kept prefix', () => {
  test('removing the text, the last decorator and the line break', async () => {
    const mounted = mountEditor(() => [
      $createParagraphNode().append(
        $create(InlineDecoratorNode),
        $createTextNode('ab'),
        $create(InlineDecoratorNode),
      ),
    ]);
    const {block} = mounted;
    await observeBatch(mounted.root, () =>
      remove(
        textSpans(block)[0],
        decorators(block)[1],
        ...managedLineBreak(block),
      ),
    );
    expectRestored(mounted);
  });
});

describe('a paragraph with a LineBreakNode', () => {
  const keyedBreak = ({block}: MountedEditor) =>
    block.querySelector('br:not([data-lexical-managed-linebreak])')!;
  const $children = () => [$endingWithLineBreak()];

  test('removing the keyed line break alone at the end', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () => remove(keyedBreak(mounted)));
    expectRestored(mounted);
  });

  test('removing the managed line break, then the keyed one in a later record', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () =>
      remove(...managedLineBreak(mounted.block), keyedBreak(mounted)),
    );
    expectRestored(mounted);
  });

  test('removing the keyed line break, then the managed one', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () =>
      remove(keyedBreak(mounted), ...managedLineBreak(mounted.block)),
    );
    expectRestored(mounted);
  });

  test('removing a keyed line break between two texts', async () => {
    const mounted = mountEditor(() => [
      $createParagraphNode().append(
        $createTextNode('ab'),
        $createLineBreakNode(),
        $createTextNode('cd'),
      ),
    ]);
    await observeBatch(mounted.root, () => remove(keyedBreak(mounted)));
    expectRestored(mounted);
  });
});

describe('an empty paragraph', () => {
  test('removing its line break', async () => {
    const mounted = mountEditor(() => [$createParagraphNode()]);
    await observeBatch(mounted.root, () =>
      remove(...managedLineBreak(mounted.block)),
    );
    expectRestored(mounted);
  });
});

describe('DOM an extension adds with setDOMUnmanaged keeps its place', () => {
  const append = (block: HTMLElement) =>
    block.appendChild(unmanagedSpan('badge'));
  const prepend = (block: HTMLElement) =>
    block.insertBefore(unmanagedSpan('placeholder'), block.firstChild);
  const beforeLineBreak = (block: HTMLElement) =>
    block.insertBefore(unmanagedSpan('badge'), managedLineBreak(block)[0]);

  test.each([
    ['an inline decorator', $endingWithDecorator],
    ['a LineBreakNode', $endingWithLineBreak],
  ])(
    'after the line break of a paragraph ending with %s, when its text is removed',
    async (_, $paragraph) => {
      await expectUnmanagedKept(
        mountEditor(() => [$paragraph()]),
        append,
        block => remove(textSpans(block)[0]),
      );
    },
  );

  test.each([
    ['an inline decorator', $endingWithDecorator],
    ['a LineBreakNode', $endingWithLineBreak],
    ['nothing (an empty paragraph)', () => $createParagraphNode()],
  ])(
    'after the line break of a paragraph ending with %s, when the line break is removed',
    async (_, $paragraph) => {
      await expectUnmanagedKept(
        mountEditor(() => [$paragraph()]),
        append,
        block => remove(...managedLineBreak(block)),
      );
    },
  );

  test.each([
    ['an inline decorator', $endingWithDecorator],
    ['a LineBreakNode', $endingWithLineBreak],
  ])(
    'before the line break of a paragraph ending with %s, when the extension swaps it',
    async (_, $paragraph) => {
      await expectUnmanagedKept(
        mountEditor(() => [$paragraph()]),
        beforeLineBreak,
        swapUnmanagedSpan,
      );
    },
  );

  test('at the head of an empty paragraph, when its line break is removed', async () => {
    await expectUnmanagedKept(
      mountEditor(() => [$createParagraphNode()]),
      prepend,
      block => remove(...managedLineBreak(block)),
    );
  });

  test('at the head of an empty paragraph, when the extension swaps it', async () => {
    await expectUnmanagedKept(
      mountEditor(() => [$createParagraphNode()]),
      prepend,
      swapUnmanagedSpan,
    );
  });

  test('at the head of a paragraph, when its line break is removed', async () => {
    await expectUnmanagedKept(
      mountEditor(() => [$endingWithDecorator()]),
      prepend,
      block => remove(...managedLineBreak(block)),
    );
  });

  test('at the head of a paragraph, when its decorator is removed', async () => {
    await expectUnmanagedKept(
      mountEditor(() => [$endingWithDecorator()]),
      prepend,
      block => remove(...decorators(block)),
    );
  });

  test('between two children, when the child after it is removed', async () => {
    await expectUnmanagedKept(
      mountEditor(() => [$tokens()]),
      block => block.insertBefore(unmanagedSpan('badge'), textSpans(block)[1]),
      block => remove(textSpans(block)[1]),
    );
  });

  test('at the end of a paragraph without a line break, when a middle child is removed', async () => {
    await expectUnmanagedKept(
      mountEditor(() => [$tokens()]),
      append,
      block => remove(textSpans(block)[1]),
    );
  });
});

describe('stale keyed DOM put back by an edit', () => {
  test('the DOM a text node had before it was rendered anew', async () => {
    const mounted = mountEditor(() => [$tokens()]);
    const {block, editor, root} = mounted;
    const staleSpan = textSpans(block)[0];
    editor.update(
      () => {
        $assertNodeType(
          $assertNodeType(
            $getRoot().getFirstChild(),
            $isElementNode,
          ).getFirstChild(),
          $isTextNode,
        ).toggleFormat('code');
      },
      {discrete: true},
    );
    expect(staleSpan.isConnected).toBe(false);
    await observeBatch(root, () => {
      remove(block.lastElementChild!);
      block.appendChild(staleSpan);
    });
    expectRendersEditorState(mounted);
  });

  test('the DOM of a removed decorator', async () => {
    const mounted = mountEditor(() => [
      $createParagraphNode().append(
        $createTextNode('ab').setMode('token'),
        $create(InlineDecoratorNode),
        $createTextNode('cd').setMode('token'),
      ),
    ]);
    const {block, editor, root} = mounted;
    const staleDecorator = decorators(block)[0];
    editor.update(
      () => {
        $assertNodeType($getRoot().getFirstChild(), $isElementNode)
          .getChildAtIndex(1)!
          .remove();
      },
      {discrete: true},
    );
    expect(staleDecorator.isConnected).toBe(false);
    await observeBatch(root, () => {
      remove(textSpans(block)[1]);
      block.appendChild(staleDecorator);
    });
    expectRendersEditorState(mounted);
  });
});

describe("moving a block's managed line break right after another block's", () => {
  test.each([
    ['an inline decorator', $endingWithDecorator],
    ['a LineBreakNode', $endingWithLineBreak],
    ['nothing (an empty paragraph)', () => $createParagraphNode()],
  ])('from a paragraph ending with %s', async (_, $createSource) => {
    const mounted = mountEditor(() => [
      $endingWithDecorator(),
      $createSource(),
    ]);
    const [target, source] = Array.from(mounted.root.children);
    await observeBatch(mounted.root, () => {
      target.append(...managedLineBreak(source));
    });
    expectRestored(mounted);
  });

  test('into an empty paragraph', async () => {
    const mounted = mountEditor(() => [
      $createParagraphNode(),
      $endingWithDecorator(),
    ]);
    const [target, source] = Array.from(mounted.root.children);
    await observeBatch(mounted.root, () => {
      target.append(...managedLineBreak(source));
    });
    expectRestored(mounted);
  });
});

describe('an element whose DOM slot keeps a marker after its children', () => {
  const $children = () => [
    $create(MarkedBlockNode).append(
      $createTextNode('ab'),
      $create(InlineDecoratorNode),
    ),
  ];

  test('removing the trailing inline decorator alone', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () =>
      remove(...decorators(mounted.block)),
    );
    expectRestored(mounted);
  });

  test('removing the trailing inline decorator and the line break', async () => {
    const mounted = mountEditor($children);
    const {block} = mounted;
    await observeBatch(mounted.root, () =>
      remove(...decorators(block), ...managedLineBreak(block)),
    );
    expectRestored(mounted);
  });

  test('removing every child and the marker in one record, then an edit', async () => {
    const mounted = mountEditor($children);
    const {block, editor, errors, root} = mounted;
    await observeBatch(root, () => {
      block.textContent = '';
    });
    appendTextToFirstBlock(mounted, 'c');
    expect(errors).toEqual([]);
    // Whether the marker is put back is not checked here; the rest is.
    expectHtmlToBeEqual(
      withoutDOM(root.innerHTML, '[data-marker]'),
      withoutDOM(renderFresh(editor), '[data-marker]'),
    );
  });

  test('removing the last text child', async () => {
    const mounted = mountEditor(() => [
      $create(MarkedBlockNode).append(
        $createTextNode('ab').setMode('token'),
        $createTextNode('cd').setMode('token'),
      ),
    ]);
    await observeBatch(mounted.root, () => remove(textSpans(mounted.block)[1]));
    expectRestored(mounted);
  });

  const $blockThenDecorator = () => [
    $create(MarkedBlockNode).append(
      $createParagraphNode().append($createTextNode('ab')),
      $create(BlockDecoratorNode),
    ),
  ];

  test('removing the first child before a trailing block decorator', async () => {
    const mounted = mountEditor($blockThenDecorator);
    await observeBatch(mounted.root, () =>
      remove(mounted.block.querySelector('p')!),
    );
    expectRestored(mounted);
    // Reconciling the block again must find its trailing decorator anchor
    // where it renders one.
    mounted.editor.update(
      () => {
        const block = $assertNodeType(
          $getRoot().getFirstChild(),
          $isElementNode,
        );
        block.markDirty();
        $assertNodeType(block.getFirstChild(), $isParagraphNode).append(
          $createTextNode('c'),
        );
      },
      {discrete: true},
    );
    expectRendersEditorState(mounted);
  });

  test('removing every child before its trailing decorator anchor', async () => {
    const mounted = mountEditor($blockThenDecorator);
    const {block} = mounted;
    await observeBatch(mounted.root, () =>
      remove(block.querySelector('p')!, ...decorators(block)),
    );
    expectRestored(mounted);
  });
});

describe('an element whose DOM slot keeps a header before its children and a footer after them', () => {
  const header = ({block}: MountedEditor) =>
    block.querySelector('[data-header]')!;

  /**
   * What Lexical rendered, apart from the header an edit removed, which is
   * not checked here.
   */
  function expectRestoredApartFromHeader(mounted: MountedEditor): void {
    expect(mounted.errors).toEqual([]);
    expectHtmlToBeEqual(
      withoutDOM(mounted.root.innerHTML, '[data-header]'),
      withoutDOM(mounted.renderedHTML, '[data-header]'),
    );
  }

  test.each([
    ['a text node', () => [$createTextNode('ab')]],
    [
      'a text node and an inline decorator',
      () => [$createTextNode('ab'), $create(InlineDecoratorNode)],
    ],
  ] as [string, () => LexicalNode[]][])(
    'removing the header and the text of a block holding %s',
    async (_, $children) => {
      const mounted = mountEditor(() => [
        $create(FramedBlockNode).append(...$children()),
      ]);
      await observeBatch(mounted.root, () =>
        remove(header(mounted), textSpans(mounted.block)[0]),
      );
      expectRestoredApartFromHeader(mounted);
    },
  );
});

describe('an element whose children live in an inner element', () => {
  test('removing the trailing inline decorator and the line break', async () => {
    const mounted = mountEditor(() => [
      $create(WrappedBlockNode).append(
        $createTextNode('ab'),
        $create(InlineDecoratorNode),
      ),
    ]);
    const inner = mounted.block.firstElementChild!;
    await observeBatch(mounted.root, () =>
      remove(...decorators(inner), ...managedLineBreak(inner)),
    );
    expectRestored(mounted);
  });
});

describe('the root ending with a block decorator', () => {
  const $children = () => [
    $createParagraphNode().append($createTextNode('ab')),
    $create(BlockDecoratorNode),
  ];
  const anchor = ({root}: MountedEditor) =>
    root.querySelector(':scope > [data-lexical-decorator-boundary]')!;

  test('removing the block decorator', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () => remove(...decorators(mounted.root)));
    expectRestored(mounted);
  });

  test('removing the paragraph and the block decorator', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () =>
      remove(mounted.block, ...decorators(mounted.root)),
    );
    expectRestored(mounted);
  });

  test('removing the trailing decorator anchor alone', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () => remove(anchor(mounted)));
    expectRestored(mounted);
  });

  test('moving the paragraph after the trailing decorator anchor', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () => {
      mounted.root.appendChild(mounted.block);
    });
    expectRestored(mounted);
  });
});

// The reconciler disconnects the observer while it renders a commit, which
// drops what the observer has recorded and not yet reported, such as a change
// made inside a discrete update. That change is reverted first.
describe('a DOM change recorded before a commit runs', () => {
  test.each([
    ['an element between two children', 1, () => document.createElement('i')],
    ['an element at the head', 0, () => document.createElement('i')],
    ['a text node between two children', 1, () => document.createTextNode('z')],
  ])(
    'adding %s inside a discrete update, then removing a child',
    async (_, index, createDOM) => {
      const mounted = mountEditor(() => [$tokens()]);
      const {block, editor, renderedHTML, root} = mounted;
      editor.update(
        () => {
          block.insertBefore(createDOM(), textSpans(block)[index]);
          $getRoot().getFirstChildOrThrow().markDirty();
        },
        {discrete: true},
      );
      expectHtmlToBeEqual(root.innerHTML, renderedHTML);
      await observeBatch(root, () => remove(textSpans(block)[2]));
      expectRestored(mounted);
    },
  );

  test('changing text inside an update that fails', () => {
    const {block, editor, errors, renderedJSON} = mountEditor(() => [
      $createParagraphNode().append($createTextNode('ab')),
    ]);
    editor.update(
      () => {
        textSpans(block)[0].firstChild!.nodeValue = 'cd';
        // Selecting a node that is never attached fails the update.
        $createTextNode('ef').select();
      },
      {discrete: true},
    );
    expect(errors).toEqual([
      expect.stringContaining('selection has been lost'),
    ]);
    expect(editor.getEditorState().toJSON()).toEqual(renderedJSON);
  });
});
