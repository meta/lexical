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
import {$getRoot} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';

// A table sized by its content, whose columns are narrowed, lays out like a
// table rendered at the new widths from the start. When the width change
// replaced the table's <col>s with new ones, the narrowed table kept its old
// width until it was laid out from scratch (Chromium inside a grid
// max-content track; WebKit there and with `width: max-content`), so a
// horizontal scrollbar stayed after a column resize.

const SHAPES = {
  'a grid max-content track': [
    '.test-wrapper { display: grid; grid-template-columns: max-content; overflow-x: auto; }',
    'table { border-collapse: collapse; table-layout: fixed; }',
  ].join('\n'),
  'a max-content table': [
    '.test-wrapper { overflow-x: auto; }',
    'table { border-collapse: collapse; table-layout: fixed; width: max-content; }',
  ].join('\n'),
};

function mount(css: string) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.style.width = '400px';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions({
    dependencies: [TableExtension],
    name: 'test/colgroup-width-change',
    theme: {tableScrollableWrapper: 'test-wrapper'},
  });
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
    style.remove();
  });
  return {editor, root};
}

const nextFrame = () =>
  new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

for (const [shape, css] of Object.entries(SHAPES)) {
  test(`narrowed columns lay out like fresh ones in ${shape}`, async () => {
    const {editor, root} = mount(css);
    editor.update(
      () => {
        const narrowed = $createTableNodeWithDimensions(2, 3, false);
        narrowed.setColWidths([300, 300, 300]);
        const fresh = $createTableNodeWithDimensions(2, 3, false);
        fresh.setColWidths([80, 80, 80]);
        $getRoot().clear().append(narrowed, fresh);
      },
      {discrete: true},
    );
    const [narrowed, fresh] = Array.from(root.querySelectorAll('table'));
    assert(narrowed !== undefined && fresh !== undefined);
    expect(narrowed.getBoundingClientRect().width).toBe(900);
    await nextFrame();

    editor.update(
      () => {
        const table = $getRoot().getFirstChild();
        assert($isTableNode(table));
        table.setColWidths([80, 80, 80]);
      },
      {discrete: true},
    );
    await nextFrame();

    expect(narrowed.getBoundingClientRect().width).toBe(
      fresh.getBoundingClientRect().width,
    );
    expect(narrowed.parentElement!.scrollWidth).toBe(
      fresh.parentElement!.scrollWidth,
    );
  });
}
