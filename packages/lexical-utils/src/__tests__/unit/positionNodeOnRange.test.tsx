/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {positionNodeOnRange, selectionAlwaysOnDisplay} from '@lexical/utils';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type LexicalEditor,
} from 'lexical';
import {createTestEditor} from 'lexical/src/__tests__/utils';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// jsdom has no layout: give every Range a single 10px box so that
// createRectsFromDOMRange() produces one rect and positionNodeOnRange()
// actually builds its wrapper.
Range.prototype.getClientRects = function (): DOMRectList {
  const rect = {
    bottom: 10,
    height: 10,
    left: 0,
    right: 10,
    top: 0,
    width: 10,
    x: 0,
    y: 0,
  };
  const rects = [{...rect, toJSON: () => rect} as DOMRect];
  return {
    item: (i: number) => rects[i] || null,
    length: rects.length,
    [Symbol.iterator]: function* () {
      yield* rects;
    },
  } as unknown as DOMRectList;
};

/**
 * positionNodeOnRange() prepends exactly one `position: relative` wrapper div
 * to the root element's parent per live invocation, so counting them across
 * the document measures how many highlight overlays are currently attached.
 */
function countOverlays(): number {
  return document.querySelectorAll('body div[style*="position: relative"]')
    .length;
}

describe('positionNodeOnRange', () => {
  let elements: HTMLElement[] = [];

  function createRootElement(): HTMLDivElement {
    const container = document.createElement('div');
    const rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    container.appendChild(rootElement);
    document.body.appendChild(container);
    elements.push(container);
    return rootElement;
  }

  async function seed(editor: LexicalEditor): Promise<void> {
    await editor.update(
      () => {
        const text = $createTextNode('hello');
        $getRoot().clear().append($createParagraphNode().append(text));
        const selection = $createRangeSelection();
        selection.anchor.set(text.getKey(), 0, 'text');
        selection.focus.set(text.getKey(), 5, 'text');
        $setSelection(selection);
      },
      {discrete: true},
    );
  }

  beforeEach(() => {
    elements = [];
  });

  afterEach(() => {
    for (const element of elements) {
      element.remove();
    }
  });

  it('keeps the wide selected area beside a vertically shifted inline box', () => {
    const rootElement = createRootElement();
    const editor = createTestEditor();
    editor.setRootElement(rootElement);
    const range = document.createRange();
    const wide = new DOMRect(128, 90, 900, 18);
    const narrow = new DOMRect(128, 89.5, 12, 18);
    vi.spyOn(range, 'getClientRects').mockReturnValue([
      wide,
      narrow,
    ] as unknown as DOMRectList);
    const onReposition = vi.fn();
    const cleanup = positionNodeOnRange(editor, range, onReposition);

    try {
      expect(onReposition).toHaveBeenCalled();
      const nodes = onReposition.mock.lastCall![0] as HTMLElement[];
      expect(nodes.map(node => node.style.width)).toEqual(['900px', '12px']);
    } finally {
      cleanup();
      editor.setRootElement(null);
    }
  });

  it.each([0, 1])(
    'notifies when overlay rectangles shrink to %i',
    async remaining => {
      const rootElement = createRootElement();
      const editor = createTestEditor();
      editor.setRootElement(rootElement);
      const range = document.createRange();
      range.selectNodeContents(rootElement);
      let rects = [new DOMRect(0, 0, 10, 10), new DOMRect(0, 20, 10, 10)];
      vi.spyOn(range, 'getClientRects').mockImplementation(
        () => rects as unknown as DOMRectList,
      );
      const onReposition = vi.fn();
      const cleanup = positionNodeOnRange(editor, range, onReposition);

      try {
        expect(onReposition).toHaveBeenCalledTimes(1);
        expect(onReposition.mock.lastCall![0]).toHaveLength(2);
        rects = rects.slice(0, remaining);
        rootElement.setAttribute('data-layout', 'hidden');

        await vi.waitFor(() => {
          expect(onReposition).toHaveBeenCalledTimes(2);
        });
        expect(onReposition.mock.lastCall![0]).toHaveLength(remaining);
      } finally {
        cleanup();
        editor.setRootElement(null);
      }
    },
  );

  it('removes the overlay of an invocation that lands after it was disposed of', () => {
    const firstRootElement = createRootElement();
    const secondRootElement = createRootElement();
    const editor = createTestEditor();
    editor.setRootElement(firstRootElement);

    // An owner that shows a highlight and drops it whenever the root element
    // changes -- the shape markSelection() has. The owner's root listener is
    // registered first and the highlight is created later, so the highlight's
    // own root listener sits after the owner's in the registry and is still
    // invoked by the pass that unregisters it.
    let removeHighlight: null | (() => void) = null;
    const removeOwner = editor.registerRootListener(rootElement => {
      if (rootElement === null) {
        return;
      }
      return () => {
        if (removeHighlight !== null) {
          removeHighlight();
          removeHighlight = null;
        }
      };
    });

    // Assigned at the call site rather than from inside showHighlight() so
    // that the assignment stays visible to control flow analysis, which does
    // not look into a nested function.
    function showHighlight(): () => void {
      const rootElement = editor.getRootElement()!;
      const range = rootElement.ownerDocument.createRange();
      range.selectNodeContents(rootElement);
      return positionNodeOnRange(editor, range, () => {});
    }

    try {
      removeHighlight = showHighlight();
      expect(countOverlays()).toBe(1);

      editor.setRootElement(secondRootElement);
      removeHighlight = showHighlight();
      expect(countOverlays()).toBe(1);
    } finally {
      removeOwner();
      if (removeHighlight !== null) {
        removeHighlight();
      }
    }

    expect(countOverlays()).toBe(0);
  });

  it('leaves no overlay behind when the root element changed while marking', async () => {
    const firstRootElement = createRootElement();
    const secondRootElement = createRootElement();
    const outside = document.createElement('div');
    outside.appendChild(document.createTextNode('outside'));
    document.body.appendChild(outside);
    elements.push(outside);

    const editor = createTestEditor();
    editor.setRootElement(firstRootElement);
    await seed(editor);

    const selectOutsideOfTheEditor = () => {
      const outsideText = outside.firstChild!;
      document.getSelection()!.setBaseAndExtent(outsideText, 0, outsideText, 1);
      document.dispatchEvent(new Event('selectionchange'));
    };

    const cleanup = selectionAlwaysOnDisplay(editor, vi.fn());
    try {
      selectOutsideOfTheEditor();
      expect(countOverlays()).toBe(1);

      // Re-mounting the editor on another element: a React re-render that
      // swaps the contenteditable, StrictMode's double mount, a portal move.
      editor.setRootElement(secondRootElement);
      selectOutsideOfTheEditor();
      expect(countOverlays()).toBe(1);
    } finally {
      cleanup();
    }

    expect(countOverlays()).toBe(0);
  });

  it('does not re-insert its overlay after the root element was detached from the document', async () => {
    const rootElement = createRootElement();
    const container = rootElement.parentElement!;
    const editor = createTestEditor();
    editor.setRootElement(rootElement);
    const range = document.createRange();
    range.selectNodeContents(rootElement);
    const cleanup = positionNodeOnRange(editor, range, () => {});

    try {
      // The host removes the editor's DOM before the editor is told, e.g. a
      // framework tearing down a subtree before it unmounts the components in it.
      container.remove();

      // Re-inserting the overlay is itself a mutation the observer reacts to,
      // so a re-insert on every mutation never yields. Stop it after a few
      // rounds so the test fails instead of hanging.
      const insertBefore = container.insertBefore.bind(container);
      const insertBeforeSpy = vi
        .spyOn(container, 'insertBefore')
        .mockImplementation(<T extends Node>(node: T, child: Node | null) =>
          insertBeforeSpy.mock.calls.length > 10
            ? node
            : insertBefore(node, child),
        );

      rootElement.setAttribute('data-layout', 'detached');
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(insertBeforeSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
      editor.setRootElement(null);
    }
  });
});
