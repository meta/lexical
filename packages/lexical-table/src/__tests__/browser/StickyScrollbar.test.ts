/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createTableNodeWithDimensions,
  $isTableNode,
  TableExtension,
} from '@lexical/table';
import {
  $getRoot,
  configExtension,
  defineExtension,
  type EditorThemeClasses,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

// The sticky scrollbar's behavior is entirely layout-driven (scrollWidth vs
// clientWidth, native scrollbar thickness, computed overflow-x), none of
// which jsdom can exercise. These tests assert against a real engine.
//
// Headless Chromium hides native scrollbars entirely (thickness 0), which is
// exactly the overlay-scrollbar condition the UNTHEMED fallback reacts to —
// so these tests theme the scrollbar with an explicit ::-webkit-scrollbar
// height (as the playground does) to exercise the real code path, and cover
// the unthemed fallback separately.
//
// Note: browser tests dispose with onTestFinished instead of `using` — see
// the note in BuildEditorFromExtensions.test.ts and AGENTS.md.

const EDITOR_WIDTH = 200;

// Empty auto-layout tables ignore <col> widths for their own width, so cell
// min-widths provide the horizontal overflow (2 columns -> 600px).
const OVERFLOW_CSS = 'th, td { min-width: 300px; }';
const THEMED_SCROLLBAR_CSS = [
  '.test-sticky-scrollbar { position: sticky; bottom: 0; overflow-x: scroll; overflow-y: hidden; }',
  '.test-sticky-scrollbar::-webkit-scrollbar { height: 8px; }',
].join('\n');

function setUpEditor(options: {css?: string; theme?: EditorThemeClasses} = {}) {
  const {css, theme} = options;
  let style: HTMLStyleElement | null = null;
  if (css) {
    style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }
  const container = document.createElement('div');
  container.style.width = `${EDITOR_WIDTH}px`;
  document.body.appendChild(container);
  const editor = buildEditorFromExtensions(
    defineExtension({
      afterRegistration(builtEditor) {
        const rootElement = document.createElement('div');
        rootElement.contentEditable = 'true';
        container.appendChild(rootElement);
        builtEditor.setRootElement(rootElement);
        return () => {
          document.body.removeChild(container);
          if (style) {
            document.head.removeChild(style);
          }
        };
      },
      dependencies: [
        configExtension(TableExtension, {hasStickyScrollbar: true}),
      ],
      name: 'sticky-scrollbar-test',
      theme: {tableScrollableWrapper: '', ...theme},
    }),
  );
  onTestFinished(() => editor.dispose());
  return {container, editor};
}

function $insertTable(): void {
  $getRoot()
    .clear()
    .append($createTableNodeWithDimensions(2, 2, false));
}

function getParts(editor: LexicalEditor) {
  const outer = editor
    .getRootElement()!
    .querySelector('[data-lexical-sticky-scrollbar]');
  expect(outer).not.toBeNull();
  const scrollable = outer!.firstElementChild as HTMLElement;
  const scrollbar = scrollable.nextElementSibling as HTMLElement;
  expect(scrollbar).not.toBeNull();
  return {outer: outer as HTMLElement, scrollable, scrollbar};
}

describe('sticky scrollbar (browser)', () => {
  test('shows the sticky scrollbar only while the table overflows', async () => {
    const {container, editor} = setUpEditor({
      css: [OVERFLOW_CSS, THEMED_SCROLLBAR_CSS].join('\n'),
      theme: {tableStickyScrollbar: 'test-sticky-scrollbar'},
    });
    editor.update($insertTable, {discrete: true});
    const {scrollable, scrollbar} = getParts(editor);
    expect(scrollable.scrollWidth).toBeGreaterThan(scrollable.clientWidth);
    await expect.poll(() => scrollbar.style.display).toBe('');
    const spacer = scrollbar.firstElementChild as HTMLElement;
    expect(spacer.style.width).toBe(`${scrollable.scrollWidth}px`);

    // Widening the container removes the overflow; the ResizeObserver on
    // the wrapper must hide the scrollbar without any editor update.
    container.style.width = '1000px';
    await expect.poll(() => scrollbar.style.display).toBe('none');

    container.style.width = `${EDITOR_WIDTH}px`;
    await expect.poll(() => scrollbar.style.display).toBe('');
  });

  test('mirrors scroll position between the wrapper and the sticky scrollbar', async () => {
    const {editor} = setUpEditor({
      css: [OVERFLOW_CSS, THEMED_SCROLLBAR_CSS].join('\n'),
      theme: {tableStickyScrollbar: 'test-sticky-scrollbar'},
    });
    editor.update($insertTable, {discrete: true});
    const {scrollable, scrollbar} = getParts(editor);
    await expect.poll(() => scrollbar.style.display).toBe('');

    scrollable.scrollLeft = 120;
    await expect.poll(() => Math.round(scrollbar.scrollLeft)).toBe(120);

    scrollbar.scrollLeft = 40;
    await expect.poll(() => Math.round(scrollable.scrollLeft)).toBe(40);
  });

  test('keeps a wrapper scrolled on every frame, as drag auto-scroll does', async () => {
    const {editor} = setUpEditor({
      css: [OVERFLOW_CSS, THEMED_SCROLLBAR_CSS].join('\n'),
      theme: {tableStickyScrollbar: 'test-sticky-scrollbar'},
    });
    editor.update($insertTable, {discrete: true});
    const {scrollable, scrollbar} = getParts(editor);
    await expect.poll(() => scrollbar.style.display).toBe('');

    // The wrapper's scroll event copies its position onto the scrollbar, and
    // the scrollbar's own scroll event for that copy arrives on the next
    // frame, after the wrapper has moved again. Copying that position back
    // would undo every other step.
    for (let frame = 0; frame < 10; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      scrollable.scrollLeft += 10;
    }
    await expect.poll(() => Math.round(scrollbar.scrollLeft)).toBe(100);
    expect(Math.round(scrollable.scrollLeft)).toBe(100);
  });

  test('hides the scrollbar when frozen rows make the wrapper unscrollable', async () => {
    // Mirrors the playground's frozen-rows styling, which switches the
    // wrapper to overflow-x: clip (scrollLeft writes are inert there). The
    // toggle clones the TableNode without replacing its DOM, so this also
    // covers the mutation-listener resync path that skips reattaching.
    const {editor} = setUpEditor({
      css: [
        OVERFLOW_CSS,
        THEMED_SCROLLBAR_CSS,
        // The wrapper must be class-styled: an inline overflow-x would beat
        // the frozen-row class rule (the playground uses the same compound
        // selector for this).
        '.test-wrapper { overflow-x: auto; }',
        '.test-wrapper.test-frozen-row { overflow-x: clip; }',
      ].join('\n'),
      theme: {
        tableFrozenRow: 'test-frozen-row',
        tableScrollableWrapper: 'test-wrapper',
        tableStickyScrollbar: 'test-sticky-scrollbar',
      },
    });
    editor.update($insertTable, {discrete: true});
    const {scrollable, scrollbar} = getParts(editor);
    await expect.poll(() => scrollbar.style.display).toBe('');

    editor.update(
      () => {
        const table = $getRoot().getFirstChildOrThrow();
        if ($isTableNode(table)) {
          table.setFrozenRows(1);
        }
      },
      {discrete: true},
    );
    expect(scrollable.classList.contains('test-frozen-row')).toBe(true);
    await expect.poll(() => scrollbar.style.display).toBe('none');

    editor.update(
      () => {
        const table = $getRoot().getFirstChildOrThrow();
        if ($isTableNode(table)) {
          table.setFrozenRows(0);
        }
      },
      {discrete: true},
    );
    await expect.poll(() => scrollbar.style.display).toBe('');
  });

  test('falls back to the native scrollbar when the unthemed proxy cannot render', async () => {
    // With no tableStickyScrollbar theme class, the proxy's height comes
    // entirely from classic native scrollbars — which headless Chromium
    // renders with zero thickness, the same as overlay-scrollbar platforms.
    // The fallback must keep the proxy hidden and restore the wrapper's
    // native scrollbar.
    const {editor} = setUpEditor({css: OVERFLOW_CSS});
    editor.update($insertTable, {discrete: true});
    const {scrollable, scrollbar} = getParts(editor);
    expect(scrollable.scrollWidth).toBeGreaterThan(scrollable.clientWidth);
    expect(scrollbar.style.display).toBe('none');
    expect(scrollable.style.scrollbarWidth).toBe('auto');
  });
});
