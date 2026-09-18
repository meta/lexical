/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {defineExtension} from '@lexical/extension';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {act, type ReactElement, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {describe, expect, onTestFinished, test} from 'vitest';

import {type MenuResolution, useMenuAnchorRef} from '../../shared/LexicalMenu';

// The anchor is absolutely positioned, so where it lands depends on the
// containing block its `parent` sits in. jsdom reports every rect as zero, so
// this has to run against a real layout engine.
const extension = defineExtension({
  dependencies: [RichTextExtension],
  name: '[root]',
});

// Where the caret would be, in viewport coordinates.
const CARET_RECT = {height: 18, left: 150, top: 250, width: 2};

function renderReact(ui: ReactElement): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  onTestFinished(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
}

let anchorElement: HTMLElement | null = null;
// Set by the probe so a test can open the menu after the initial render, the
// way a typeahead trigger does.
let openMenu: (() => void) | null = null;

function MenuAnchorProbe({
  parent,
  initiallyOpen = true,
}: {
  parent?: HTMLElement;
  initiallyOpen?: boolean;
}): null {
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  openMenu = () => setIsOpen(true);
  const resolution = useMemo<MenuResolution | null>(
    () =>
      isOpen
        ? {
            getRect: () =>
              new DOMRect(
                CARET_RECT.left,
                CARET_RECT.top,
                CARET_RECT.width,
                CARET_RECT.height,
              ),
          }
        : null,
    [isOpen],
  );
  anchorElement = useMenuAnchorRef(
    resolution,
    () => {},
    'test-menu-anchor',
    parent,
  ).current;
  return null;
}

function createPositionedParent(scrollable = false): HTMLElement {
  const parent = document.createElement('div');
  // A positioned ancestor establishes a containing block for the absolutely
  // positioned anchor, so anchor coordinates are relative to this box.
  parent.style.position = 'relative';
  parent.style.marginLeft = '120px';
  parent.style.marginTop = '200px';
  parent.style.width = '400px';
  parent.style.height = '300px';
  if (scrollable) {
    parent.style.overflow = 'auto';
    const spacer = document.createElement('div');
    spacer.style.height = '1000px';
    parent.appendChild(spacer);
  }
  document.body.appendChild(parent);
  onTestFinished(() => parent.remove());
  return parent;
}

/**
 * The anchor should land at the caret regardless of the containing block it is
 * positioned in. Compared with a sub-pixel tolerance because engines resolve
 * fractional scroll offsets and `px` values differently.
 */
function expectAtCaret(rect: DOMRect): void {
  expect(rect.left).toBeCloseTo(CARET_RECT.left, 0);
  expect(rect.top).toBeCloseTo(CARET_RECT.top + 3, 0);
}

describe('useMenuAnchorRef positioning (browser)', () => {
  test('anchors the menu at the caret when parent is the document body', () => {
    renderReact(
      <LexicalExtensionComposer extension={extension}>
        <MenuAnchorProbe />
      </LexicalExtensionComposer>,
    );
    expect(anchorElement).not.toBeNull();
    const rect = anchorElement!.getBoundingClientRect();
    expectAtCaret(rect);
  });

  test('anchors the menu at the caret when parent is a positioned element', () => {
    const parent = createPositionedParent();
    renderReact(
      <LexicalExtensionComposer extension={extension}>
        <MenuAnchorProbe parent={parent} />
      </LexicalExtensionComposer>,
    );
    expect(anchorElement).not.toBeNull();
    expect(parent.contains(anchorElement!)).toBe(true);
    // Without accounting for the containing block the anchor is pushed down
    // and right by the parent's own offset.
    const rect = anchorElement!.getBoundingClientRect();
    expectAtCaret(rect);
  });

  // The anchor is removed from the DOM whenever the menu closes, so every open
  // after the initial render positions an element that is still detached --
  // which is the only path a typeahead ever takes, since its resolution starts
  // out null.
  test('anchors the menu at the caret when the menu opens after mount', () => {
    const parent = createPositionedParent();
    renderReact(
      <LexicalExtensionComposer extension={extension}>
        <MenuAnchorProbe parent={parent} initiallyOpen={false} />
      </LexicalExtensionComposer>,
    );
    act(() => {
      openMenu!();
    });
    expect(anchorElement).not.toBeNull();
    expect(parent.contains(anchorElement!)).toBe(true);
    const rect = anchorElement!.getBoundingClientRect();
    expectAtCaret(rect);
  });

  test('anchors the menu at the caret when the positioned parent is scrolled', () => {
    const parent = createPositionedParent(true);
    parent.scrollTop = 250;
    // Not asserted exactly: Firefox lands on a fractional scroll offset
    // (250.133...) rather than the integer it was given.
    expect(parent.scrollTop).toBeGreaterThan(0);
    renderReact(
      <LexicalExtensionComposer extension={extension}>
        <MenuAnchorProbe parent={parent} />
      </LexicalExtensionComposer>,
    );
    expect(anchorElement).not.toBeNull();
    const rect = anchorElement!.getBoundingClientRect();
    expectAtCaret(rect);
  });
});
