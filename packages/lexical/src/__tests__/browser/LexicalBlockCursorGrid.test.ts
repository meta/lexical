/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createHorizontalRuleNode,
  buildEditorFromExtensions,
  HorizontalRuleExtension,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

// The block cursor is an absolutely positioned element whose position is left
// to the CSS static position, which only holds for block containers: a grid or
// flex container resolves it to the container's padding edge corner instead of
// next to the adjacent block. Reproducing that requires real layout, so these
// tests run in a browser (see the `browser` project in vitest.config.mts);
// jsdom has no layout engine.
const BLOCK_CURSOR_CSS = `
.test-blockCursor { display: block; pointer-events: none; position: absolute; }
`;

const THEME = {
  blockCursor: 'test-blockCursor',
  hr: 'test-hr',
};

function setUpEditor(
  $initialEditorState: () => void,
  rootStyles: Partial<CSSStyleDeclaration> = {},
): {editor: LexicalEditor; rootElement: HTMLElement} {
  const style = document.createElement('style');
  style.textContent = BLOCK_CURSOR_CSS;
  document.head.appendChild(style);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState,
      afterRegistration(builtEditor) {
        const rootElement = document.createElement('div');
        rootElement.contentEditable = 'true';
        Object.assign(rootElement.style, rootStyles);
        container.appendChild(rootElement);
        builtEditor.setRootElement(rootElement);
        return () => {
          document.body.removeChild(container);
          document.head.removeChild(style);
        };
      },
      dependencies: [RichTextExtension, HorizontalRuleExtension],
      name: '[block-cursor-grid-browser]',
      theme: THEME,
    }),
  );
  onTestFinished(() => editor.dispose());
  const rootElement = container.firstElementChild as HTMLElement;
  return {editor, rootElement};
}

/** A paragraph and a trailing horizontal rule: root children p0, hr. */
function $createContentAroundRule(): void {
  const first = $createParagraphNode();
  first.append($createTextNode('first'));
  $getRoot().append(first, $createHorizontalRuleNode());
}

/** Set a collapsed element-point selection on the root and let it settle. */
async function placeRootSelection(
  editor: LexicalEditor,
  offset: number,
): Promise<void> {
  editor.update(
    () => {
      $getRoot().select(offset, offset);
    },
    {discrete: true},
  );
  editor.focus();
  await new Promise(resolve => setTimeout(resolve, 60));
}

function expectCursorBeside(
  editor: LexicalEditor,
  hr: HTMLElement,
  side: 'before' | 'after',
): void {
  const cursor = editor._blockCursorElement;
  expect(cursor).not.toBeNull();
  const cursorRect = cursor!.getBoundingClientRect();
  const hrRect = hr.getBoundingClientRect();
  expect(cursorRect.top).toBeCloseTo(
    side === 'before' ? hrRect.top : hrRect.bottom,
    1,
  );
  expect(cursorRect.left).toBeCloseTo(hrRect.left, 1);
}

describe('block cursor position in grid containers', () => {
  test('cursor sits next to the rule when the caret is before it', async () => {
    const {editor, rootElement} = setUpEditor($createContentAroundRule, {
      display: 'grid',
    });
    const hr = rootElement.querySelector('hr') as HTMLElement;

    await placeRootSelection(editor, 1);
    expectCursorBeside(editor, hr, 'before');

    // The container was made the containing block for the cursor.
    expect(rootElement.style.position).toBe('relative');

    // Moving back into text removes the cursor and restores the container.
    editor.update(
      () => {
        $getRoot().getFirstChild()!.selectStart();
      },
      {discrete: true},
    );
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(editor._blockCursorElement).toBeNull();
    expect(rootElement.style.position).toBe('');
  });

  test('cursor sits next to the rule when the caret is after it', async () => {
    const {editor, rootElement} = setUpEditor($createContentAroundRule, {
      display: 'grid',
    });
    const hr = rootElement.querySelector('hr') as HTMLElement;

    await placeRootSelection(editor, 2);
    expectCursorBeside(editor, hr, 'after');
  });

  test('block containers keep relying on the static position', async () => {
    const {editor, rootElement} = setUpEditor($createContentAroundRule);

    await placeRootSelection(editor, 1);
    const cursor = editor._blockCursorElement;
    expect(cursor).not.toBeNull();
    expect(cursor!.style.top).toBe('');
    expect(cursor!.style.left).toBe('');
    expect(rootElement.style.position).toBe('');
  });
});
