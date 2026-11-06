/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * The editor's MutationObserver reverts DOM changes it did not make. A block
 * whose last child is an inline decorator or a LineBreakNode ends with a
 * managed line break — a keyless `<br>`, preceded on WebKit by an in-flow
 * `<img>` (see WebkitLinebreakImg.test.ts). When native editing or an
 * extension removes or moves, in one observer batch, keyed children of such a
 * block, that line break, or both, the revert must leave the DOM exactly as
 * Lexical renders the unchanged editor state: keyed children back in order,
 * the managed line break present once and last, nodes Lexical does not
 * manage kept in place, and no error. That holds too for a change the
 * observer recorded but had not reported when a commit disconnected it.
 *
 * Running in browser mode exercises the real engine: WebKit renders the
 * img+br line break and Chromium / Firefox the plain br, from the same file,
 * and native editing produces the batches. The jsdom tests in
 * `__tests__/unit/ManagedLineBreakObservedRemoval.test.ts` cover the shapes
 * that are the same in every engine.
 */

import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  IS_APPLE_WEBKIT,
  IS_IOS,
  IS_SAFARI,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$assertNodeType} from '../utils/assertNodeType';
import {
  decorators,
  InlineDecoratorNode,
  managedLineBreak,
  MarkedBlockNode,
  type MountedEditor,
  mountEditor,
  observeBatch,
  remove,
  renderFresh,
  unmanagedSpan,
} from '../utils/observedMutation';

// Matches the `webkitHack` gate in ElementDOMSlot.setManagedLineBreak.
const EXPECTS_IMG_HACK = IS_SAFARI || IS_IOS || IS_APPLE_WEBKIT;

/**
 * Browser-safe stand-in for the unit tests' `expectHtmlToBeEqual`, whose
 * prettier dependency does not load in the browser: prints one node per line
 * so a failure diff names the nodes that differ.
 */
function expectHtmlToBeEqual(actual: string, expected: string): void {
  expect(prettifyHtml(actual)).toBe(prettifyHtml(expected));
}

function prettifyHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const lines: string[] = [];
  const visit = (node: Node, depth: number) => {
    const indent = '  '.repeat(depth);
    if (node.nodeType !== Node.ELEMENT_NODE) {
      lines.push(indent + JSON.stringify(node.textContent));
      return;
    }
    const element = node as Element;
    const attributes = Array.from(element.attributes, ({name, value}) =>
      value === '' ? ` ${name}` : ` ${name}="${value}"`,
    )
      .sort()
      .join('');
    lines.push(`${indent}<${element.localName}${attributes}>`);
    element.childNodes.forEach(child => visit(child, depth + 1));
  };
  template.content.childNodes.forEach(child => visit(child, 0));
  return lines.join('\n');
}

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

const $endingWithDecorator = () =>
  $createParagraphNode().append(
    $createTextNode('ab'),
    $create(InlineDecoratorNode),
  );
const $endingWithLineBreak = () =>
  $createParagraphNode().append($createTextNode('ab'), $createLineBreakNode());
const lastLineBreakNode = (block: Element) => {
  const lineBreak = managedLineBreak(block);
  return lineBreak[lineBreak.length - 1];
};

describe('a block ending with an inline decorator', () => {
  const $children = () => [$endingWithDecorator()];

  test("renders the engine's managed line break", () => {
    const {block} = mountEditor($children);
    expect(managedLineBreak(block).map(node => node.nodeName)).toEqual(
      EXPECTS_IMG_HACK ? ['IMG', 'BR'] : ['BR'],
    );
  });

  test('removing the decorator alone', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () =>
      remove(...decorators(mounted.block)),
    );
    expectRestored(mounted);
  });

  test('removing the decorator, then its line break', async () => {
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
      remove(...managedLineBreak(block).reverse(), ...decorators(block)),
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

  // WebKit's img+br pair can lose its nodes in either order, or only one of
  // them; elsewhere the line break is a single node.
  const lineBreakRemovals: [name: string, indexes: number[]][] =
    EXPECTS_IMG_HACK
      ? [
          ['the line break', [0, 1]],
          ['the line break in reverse order', [1, 0]],
          ['the img of the line break', [0]],
          ['the br of the line break', [1]],
        ]
      : [['the line break', [0]]];
  test.each(lineBreakRemovals)(
    'removing %s alone, then a later edit at the end',
    async (_, indexes) => {
      const mounted = mountEditor($children);
      const lineBreak = managedLineBreak(mounted.block);
      await observeBatch(mounted.root, () =>
        remove(...indexes.map(index => lineBreak[index])),
      );
      expectRestored(mounted);
      appendTextToFirstBlock(mounted, 'c');
      expectRendersEditorState(mounted);
    },
  );

  test('moving the first node of the line break to the end', async () => {
    const mounted = mountEditor($children);
    const {block} = mounted;
    await observeBatch(mounted.root, () => {
      block.appendChild(managedLineBreak(block)[0]);
    });
    expectRestored(mounted);
  });

  // On WebKit the last node of the line break is the <br> after the <img>,
  // which the editor does not hold on to.
  test('moving the last node of the line break into the decorator', async () => {
    const mounted = mountEditor($children);
    const {block} = mounted;
    await observeBatch(mounted.root, () => {
      decorators(block)[0].appendChild(lastLineBreakNode(block));
    });
    expectRestored(mounted);
  });

  test('moving the line break into the decorator', async () => {
    const mounted = mountEditor($children);
    const {block} = mounted;
    await observeBatch(mounted.root, () => {
      decorators(block)[0].append(...managedLineBreak(block));
    });
    expectRestored(mounted);
  });

  test('moving the last node of the line break into an unmanaged node', async () => {
    await expectUnmanagedKept(
      mountEditor($children),
      block =>
        block.insertBefore(unmanagedSpan('badge'), managedLineBreak(block)[0]),
      block => {
        block
          .querySelector('[data-unmanaged]')!
          .appendChild(lastLineBreakNode(block));
      },
    );
  });

  test('removing the line break keeps an unmanaged node after it', async () => {
    await expectUnmanagedKept(
      mountEditor($children),
      block => block.appendChild(unmanagedSpan('badge')),
      block => remove(...managedLineBreak(block)),
    );
  });

  test('moving the decorator to the start of the block', async () => {
    const mounted = mountEditor($children);
    const {block} = mounted;
    await observeBatch(mounted.root, () => {
      block.insertBefore(decorators(block)[0], block.firstChild);
    });
    expectRestored(mounted);
  });

  test('removing the text keeps an unmanaged node after the line break', async () => {
    await expectUnmanagedKept(
      mountEditor($children),
      block => block.appendChild(unmanagedSpan('badge')),
      block => remove(block.querySelector('[data-lexical-text]')!),
    );
  });

  test('swapping an unmanaged node kept before the line break', async () => {
    await expectUnmanagedKept(
      mountEditor($children),
      block =>
        block.insertBefore(unmanagedSpan('badge'), managedLineBreak(block)[0]),
      block => {
        const badge = block.querySelector('[data-unmanaged]')!;
        block.insertBefore(unmanagedSpan('badge'), badge);
        remove(badge);
      },
    );
  });

  // On WebKit a <br> right after the line break's <img> takes the place of
  // the pair's <br> unless it is the editor's own.
  test('replacing the last node of the line break with a plain <br>', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () => {
      lastLineBreakNode(mounted.block).replaceWith(
        document.createElement('br'),
      );
    });
    expectRestored(mounted);
  });

  test("replacing the last node of the line break with a LineBreakNode's <br>", async () => {
    const mounted = mountEditor(() => [
      $createParagraphNode().append(
        $createTextNode('ab'),
        $createLineBreakNode(),
        $create(InlineDecoratorNode),
      ),
    ]);
    const {block} = mounted;
    await observeBatch(mounted.root, () => {
      lastLineBreakNode(block).replaceWith(
        block.querySelector('br:not([data-lexical-managed-linebreak])')!,
      );
    });
    expectRestored(mounted);
  });

  test("adding a plain <br> right after the line break's first node", async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () => {
      managedLineBreak(mounted.block)[0].after(document.createElement('br'));
    });
    expectRestored(mounted);
  });

  test('a later edit at the end of a block whose decorator was removed', async () => {
    const mounted = mountEditor($children);
    await observeBatch(mounted.root, () =>
      remove(...decorators(mounted.block)),
    );
    appendTextToFirstBlock(mounted, 'c');
    expectRendersEditorState(mounted);
  });
});

describe('a block ending with text and an inline decorator after a kept prefix', () => {
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
        block.querySelector('[data-lexical-text]')!,
        decorators(block)[1],
        ...managedLineBreak(block),
      ),
    );
    expectRestored(mounted);
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
});

// Chromium and Firefox dispatch no beforeinput for execCommand, so the engine
// edits the DOM natively and only the MutationObserver sees it. WebKit
// dispatches a cancelable beforeinput that Lexical handles itself, so there
// the editor state changes instead; comparing against a fresh render of the
// current state covers both. document.execCommand is deprecated, but it is
// used on purpose: it is the only way to have the engine edit the DOM itself
// (NativeTextInsertion.test.ts relies on it too).
describe('native editing with execCommand', () => {
  /**
   * Select from (start, startOffset) to (end, endOffset), and resolve once
   * the editor has seen the selection change.
   */
  function select(
    start: Node,
    startOffset: number,
    end: Node,
    endOffset: number,
  ): Promise<void> {
    const changed = new Promise<void>(resolve => {
      document.addEventListener('selectionchange', () => resolve(), {
        once: true,
      });
    });
    const range = document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return changed;
  }

  const textOf = (element: Element) =>
    element.querySelector('[data-lexical-text]')!.firstChild!;

  test.each([
    ['delete', ''],
    ['insertText', 'Z'],
  ])(
    'execCommand(%s) over a trailing inline decorator',
    async (command, value) => {
      const mounted = mountEditor(() => [$endingWithDecorator()]);
      const {block, root} = mounted;
      root.focus();
      await select(textOf(block), 2, block, block.childNodes.length);
      await observeBatch(root, () => {
        expect(document.execCommand(command, false, value)).toBe(true);
      });
      expectRendersEditorState(mounted);
    },
  );

  test('execCommand(delete) over a trailing LineBreakNode', async () => {
    const mounted = mountEditor(() => [$endingWithLineBreak()]);
    const {block, root} = mounted;
    root.focus();
    await select(textOf(block), 2, block, block.childNodes.length);
    await observeBatch(root, () => {
      expect(document.execCommand('delete')).toBe(true);
    });
    expectRendersEditorState(mounted);
  });

  // The engine edits both blocks while Lexical's input handling has already
  // changed the editor state, so the revert must put back what is on screen.
  // Where the engine dispatches no beforeinput, the editor inserts the text
  // as well, so the text it is left with is checked too: the text before the
  // selection, then what was typed and the text after it, each once.
  const $inlineDecorator = () => $create(InlineDecoratorNode);
  test.each([
    ['end', 'an inline decorator', () => [$inlineDecorator()], 'Zd'],
    [
      'end',
      'text and an inline decorator',
      () => [$createTextNode('ab'), $inlineDecorator()],
      'abZd',
    ],
    [
      'text',
      'text and an inline decorator',
      () => [$createTextNode('ab'), $inlineDecorator()],
      'aZd',
    ],
    [
      'end',
      'text and a LineBreakNode',
      () => [$createTextNode('ab'), $createLineBreakNode()],
      'abZd',
    ],
    ['end', 'nothing (an empty paragraph)', () => [], 'Zd'],
  ] as ['end' | 'text', string, () => LexicalNode[], string][])(
    'execCommand(insertText) from the %s of a block ending with %s into the next block',
    async (from, _, $firstChildren, text) => {
      const mounted = mountEditor(() => [
        $createParagraphNode().append(...$firstChildren()),
        $createParagraphNode().append(
          $inlineDecorator(),
          $createTextNode('cd'),
        ),
      ]);
      const {root} = mounted;
      const [first, second] = Array.from(root.children);
      root.focus();
      await (from === 'text'
        ? select(textOf(first), 1, textOf(second), 1)
        : select(
            first,
            first.childNodes.length - managedLineBreak(first).length,
            textOf(second),
            1,
          ));
      await observeBatch(root, () => {
        expect(document.execCommand('insertText', false, 'Z')).toBe(true);
      });
      expectRendersEditorState(mounted);
      expect(
        mounted.editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(node => node.getTextContent())
            .join(''),
        ),
      ).toBe(text);
    },
  );
});

// The reconciler disconnects the observer while it renders a commit, which
// drops what the observer has recorded and not yet reported. An engine
// reports a change after the commit that an update in the same task queued
// before it, so the change is reverted first.
describe('a DOM change recorded before a commit runs', () => {
  test('removing text after an update queued its commit', async () => {
    const mounted = mountEditor(() => [
      $createParagraphNode().append($createTextNode('ab')),
    ]);
    const {block, editor, root} = mounted;
    await observeBatch(root, () => {
      editor.update(() => {
        $assertNodeType($getRoot().getFirstChild(), $isElementNode).append(
          $create(InlineDecoratorNode),
        );
      });
      remove(block.querySelector('[data-lexical-text]')!);
    });
    expectRendersEditorState(mounted);
    expect(editor.read(() => $getRoot().getTextContent())).toBe('ab');
  });
});
