/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Regression tests for #8922 — "DecoratorNode resets the selection of all
 * content".
 *
 * Browsers drop the selection highlight for a range whose endpoint is an
 * element-boundary DOM position (`(element, 0)` /
 * `(element, childNodes.length)`) immediately adjacent to a block-level
 * `contenteditable=false` child. Select-all in a document whose first or last
 * top-level node is a block DecoratorNode produces exactly that shape, so the
 * whole selection goes invisible even though the Lexical selection and the DOM
 * Range are both intact. WebKit drops it as soon as either endpoint has that
 * shape (`document.execCommand('selectAll')` included); Chromium drops it when
 * both do. The reconciler parks a zero-size, out-of-flow `<img>` outside such a
 * boundary decorator to give the browser an editable inline box to canonicalize
 * the boundary position against.
 *
 * These tests pin the DOM shape (and the child-offset bookkeeping around it);
 * `__tests__/browser/Issue8922SelectAllPaint.test.ts` pins the paint itself in
 * a real browser.
 */

import {registerRichText} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $selectAll,
  DecoratorNode,
  type LexicalEditor,
} from 'lexical';
import {createTestEditor} from 'lexical/src/__tests__/utils';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

const BOUNDARY_SELECTOR = 'img[data-lexical-decorator-boundary="true"]';

class TestBlockDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_block_decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.setAttribute('data-test-decorator', 'true');
    return dom;
  }
  updateDOM(): false {
    return false;
  }
  isInline(): boolean {
    return false;
  }
  decorate(): null {
    return null;
  }
}

class TestInlineDecoratorNode extends TestBlockDecoratorNode {
  $config() {
    return this.config('test_inline_decorator', {
      extends: TestBlockDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  isInline(): boolean {
    return true;
  }
}

/** The root's child DOM nodes, tagged so assertions read like the markup. */
function rootChildNames(container: HTMLElement): string[] {
  return Array.from(container.childNodes, node =>
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement).matches(BOUNDARY_SELECTOR)
        ? 'boundary'
        : (node as HTMLElement).hasAttribute('data-test-decorator')
          ? 'decorator'
          : node.nodeName.toLowerCase()
      : `#${node.nodeName}`,
  );
}

describe('Issue #8922: select-all with a boundary block decorator', () => {
  let container: HTMLDivElement;
  let editor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    container.setAttribute('data-lexical-editor', 'true');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    editor = createTestEditor({
      nodes: [TestBlockDecoratorNode, TestInlineDecoratorNode],
    });
    registerRichText(editor);
    editor.setRootElement(container);
  });

  afterEach(() => {
    editor.setRootElement(null);
    document.body.removeChild(container);
  });

  function setRootChildren(...kinds: ('decorator' | 'text')[]): void {
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            ...kinds.map(kind =>
              kind === 'decorator'
                ? new TestBlockDecoratorNode()
                : $createParagraphNode().append($createTextNode('hello')),
            ),
          );
      },
      {discrete: true},
    );
  }

  test('a leading block decorator gets a boundary anchor in front of it', () => {
    setRootChildren('decorator', 'text', 'text');
    expect(rootChildNames(container)).toEqual([
      'boundary',
      'decorator',
      'p',
      'p',
    ]);
  });

  test('a trailing block decorator gets a boundary anchor after it', () => {
    setRootChildren('text', 'text', 'decorator');
    expect(rootChildNames(container)).toEqual([
      'p',
      'p',
      'decorator',
      'boundary',
    ]);
  });

  test('a decorator on both edges gets both anchors', () => {
    setRootChildren('decorator', 'text', 'decorator');
    expect(rootChildNames(container)).toEqual([
      'boundary',
      'decorator',
      'p',
      'decorator',
      'boundary',
    ]);
  });

  test('a single block decorator gets both anchors', () => {
    setRootChildren('decorator');
    expect(rootChildNames(container)).toEqual([
      'boundary',
      'decorator',
      'boundary',
    ]);
  });

  test('interior block decorators get no anchor (browsers paint those)', () => {
    setRootChildren('text', 'decorator', 'text');
    expect(rootChildNames(container)).toEqual(['p', 'decorator', 'p']);
  });

  test('a document with no decorators gets no anchors', () => {
    setRootChildren('text', 'text');
    expect(rootChildNames(container)).toEqual(['p', 'p']);
  });

  test('anchors are dropped when the boundary decorator moves inward', () => {
    setRootChildren('decorator', 'text');
    expect(container.querySelectorAll(BOUNDARY_SELECTOR)).toHaveLength(1);

    editor.update(
      () => {
        const root = $getRoot();
        root
          .getFirstChildOrThrow()
          .insertBefore($createParagraphNode().append($createTextNode('top')));
        root.getLastChildOrThrow().insertAfter($createParagraphNode());
      },
      {discrete: true},
    );

    expect(rootChildNames(container)).toEqual(['p', 'decorator', 'p', 'p']);
  });

  test('anchors are dropped when the boundary decorator is removed', () => {
    setRootChildren('decorator', 'text', 'decorator');
    expect(container.querySelectorAll(BOUNDARY_SELECTOR)).toHaveLength(2);

    editor.update(
      () => {
        const root = $getRoot();
        root.getFirstChildOrThrow().remove();
        root.getLastChildOrThrow().remove();
      },
      {discrete: true},
    );

    expect(rootChildNames(container)).toEqual(['p']);
  });

  test('an inline boundary decorator keeps its own linebreak hack instead', () => {
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(new TestInlineDecoratorNode()),
            $createParagraphNode().append($createTextNode('hello')),
          );
      },
      {discrete: true},
    );

    // Inline decorators paint fine at a boundary, so no anchor — the existing
    // managed line break is what they need. Outside Safari that line break is
    // a plain <br>; the Safari img+br shape is pinned by
    // LexicalWebkitLinebreakImg.test.ts.
    expect(container.querySelectorAll(BOUNDARY_SELECTOR)).toHaveLength(0);
    const managedLinebreaks = Array.from(
      container.querySelectorAll('[data-lexical-managed-linebreak="true"]'),
      node => node.nodeName.toLowerCase(),
    );
    expect(managedLinebreaks.length).toBeGreaterThan(0);
    expect(managedLinebreaks).not.toContain('img');
  });

  test('anchors do not shift the child offsets $selectAll resolves to', () => {
    setRootChildren('decorator', 'text', 'decorator');

    editor.update(
      () => {
        const selection = $selectAll();
        expect(selection.anchor.key).toBe('root');
        expect(selection.anchor.type).toBe('element');
        expect(selection.anchor.offset).toBe(0);
        expect(selection.focus.key).toBe('root');
        expect(selection.focus.type).toBe('element');
        expect(selection.focus.offset).toBe(3);
      },
      {discrete: true},
    );

    // The selection still spans every top-level node, anchors and all.
    editor.read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      expect(
        (selection as ReturnType<typeof $selectAll>)
          .getNodes()
          .filter(node => node.getParent() === $getRoot()),
      ).toEqual($getRoot().getChildren());
    });
  });

  test('the DOM selection lands on the boundary side of each anchor', () => {
    setRootChildren('decorator', 'text', 'decorator');
    editor.update(() => void $selectAll(), {discrete: true});

    const domSelection = document.getSelection()!;
    const children = rootChildNames(container);
    // Leading: `(root, 1)` sits between the anchor and the decorator; trailing:
    // `(root, 4)` sits between the decorator and the anchor. Both are positions
    // the browser can canonicalize against an editable inline box.
    expect(children).toEqual([
      'boundary',
      'decorator',
      'p',
      'decorator',
      'boundary',
    ]);
    expect(domSelection.anchorNode).toBe(container);
    expect(domSelection.anchorOffset).toBe(1);
    expect(domSelection.focusNode).toBe(container);
    expect(domSelection.focusOffset).toBe(4);
  });

  test('a DOM selection landing outside the anchors still resolves to the full range', () => {
    setRootChildren('decorator', 'text', 'decorator');

    // Simulate the browser handing back a boundary position on the far side of
    // each anchor (offset 0 and childNodes.length) — the reconciled Lexical
    // selection must still be the whole root.
    editor.update(
      () => {
        const selection = $selectAll();
        selection.anchor.set('root', 0, 'element');
        selection.focus.set('root', 3, 'element');
      },
      {discrete: true},
    );

    editor.read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      expect(
        (selection as ReturnType<typeof $selectAll>)
          .getNodes()
          .filter(node => node.getParent() === $getRoot()),
      ).toEqual($getRoot().getChildren());
    });
  });
});
