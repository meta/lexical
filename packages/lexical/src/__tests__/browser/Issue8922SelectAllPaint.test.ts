/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Regression test for #8922 — select-all must actually *paint* a selection
 * highlight when the document's first or last top-level node is a block
 * DecoratorNode.
 *
 * Browsers silently drop the highlight for the whole document when a range
 * endpoint is an element-boundary DOM position immediately adjacent to a
 * block-level `contenteditable=false` child; the Lexical selection and the DOM
 * Range both survive, so only the rendered pixels tell the two apart. Without
 * the fix WebKit fails all three decorator cases below and Chromium fails the
 * both-edges one; Firefox paints them all either way.
 *
 * The editor paints into a `::selection` colour no other pixel in the fixture
 * uses, so counting those pixels is a stable proxy for "the user can see the
 * selection" — and it ignores the (differently coloured, blinking) caret.
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $selectAll,
  DecoratorNode,
  type LexicalNode,
} from 'lexical';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  onTestFinished,
  test,
} from 'vitest';
import {page} from 'vitest/browser';

const SELECTION_COLOR = 'rgb(0, 0, 255)';

class TestBlockDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_block_decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.style.height = '30px';
    dom.style.background = 'rgb(221, 221, 221)';
    dom.textContent = 'DECORATOR';
    return dom;
  }
  updateDOM(): false {
    return false;
  }
  isInline(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

const ext = defineExtension({
  dependencies: [RichTextExtension],
  name: '[8922-browser]',
  nodes: [TestBlockDecoratorNode],
});

let style: HTMLStyleElement;

beforeAll(() => {
  style = document.createElement('style');
  style.textContent = `
    .issue8922-editor { background: rgb(255, 255, 255); color: rgb(0, 0, 0); }
    .issue8922-editor ::selection,
    .issue8922-editor::selection { background: ${SELECTION_COLOR}; color: ${SELECTION_COLOR}; }
  `;
  document.head.appendChild(style);
});

afterAll(() => {
  document.head.removeChild(style);
});

function mountEditor(decorators: {leading: boolean; trailing: boolean}) {
  const container = document.createElement('div');
  container.className = 'issue8922-editor';
  document.body.appendChild(container);
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  container.appendChild(contentEditable);

  const editor = buildEditorFromExtensions(ext);
  editor.setRootElement(contentEditable);
  editor.update(
    () => {
      const children: LexicalNode[] = [
        $createParagraphNode().append($createTextNode('hello')),
        $createParagraphNode().append($createTextNode('world')),
      ];
      if (decorators.leading) {
        children.unshift(new TestBlockDecoratorNode());
      }
      if (decorators.trailing) {
        children.push(new TestBlockDecoratorNode());
      }
      $getRoot()
        .clear()
        .append(...children);
    },
    {discrete: true},
  );

  onTestFinished(() => {
    editor.setRootElement(null);
    document.body.removeChild(container);
  });

  return {container, editor};
}

/**
 * A real highlight covers thousands of pixels, while subpixel text
 * antialiasing leaves a handful of same-hued fringes behind on some font
 * stacks (Windows rasterizes the decorator's label into ~16 of them). Compare
 * the before / after counts against a floor between those two scales rather
 * than against zero, so the assertion tracks "the highlight appeared" instead
 * of "nothing else in the fixture is ever bluish".
 */
const MIN_HIGHLIGHT_PIXELS = 200;

/** Number of pixels painted in the `::selection` colour. */
async function countSelectionPixels(): Promise<number> {
  // `save: false` resolves to the raw base64 string; with `save: true` it is
  // `{path, base64}`. Accept either so the helper survives that detail.
  const shot: unknown = await page.screenshot({base64: true, save: false});
  const base64 =
    typeof shot === 'string' ? shot : (shot as {base64: string}).base64;
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0);
  const {data} = context.getImageData(0, 0, canvas.width, canvas.height);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] > 150) {
      count++;
    }
  }
  return count;
}

describe('select-all paints a highlight around boundary decorators (#8922)', () => {
  test.each([
    ['no decorators', {leading: false, trailing: false}],
    ['leading block decorator', {leading: true, trailing: false}],
    ['trailing block decorator', {leading: false, trailing: true}],
    ['decorators on both edges', {leading: true, trailing: true}],
  ] as const)('%s', async (_label, decorators) => {
    const {editor} = mountEditor(decorators);
    const before = await countSelectionPixels();

    editor.update(() => void $selectAll(), {discrete: true});
    // Let the compositor paint the new selection before sampling pixels.
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    const after = await countSelectionPixels();

    // Without the fix this delta is 0 — the browser paints no highlight at all.
    expect(after - before).toBeGreaterThan(MIN_HIGHLIGHT_PIXELS);
  });
});
