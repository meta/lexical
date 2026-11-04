/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment jsdom

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$selectIn, freshReader, setup} from '../../utils/harness';

// An app's mutation listener that edits the document (appends '#' to the
// last line, at most four times), in an editor with a DOM root: Lexical runs
// the update it makes at once, while it still notifies the listeners of the
// commit that triggered it.
describe.each([false, true])('an edit a mutation listener makes, gc %s', gc => {
  test('is stored as the editor shows it', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('zero')),
          $createParagraphNode().append($createTextNode('two')),
        ),
      {gc, ids: [1, 2, 3]},
    );
    const {a, b} = t;
    const host = document.createElement('div');
    host.contentEditable = 'true';
    document.body.append(host);
    a.editor.setRootElement(host);
    let made = 0;
    a.editor.registerMutationListener(
      TextNode,
      mutations => {
        if (made < 4 && mutations.size > 0) {
          made++;
          a.editor.update(() => {
            const last = $getRoot().getLastChild();
            const text = $isElementNode(last) ? last.getLastDescendant() : null;
            if ($isTextNode(text)) {
              text.setTextContent(text.getTextContent() + '#');
            }
          });
        }
      },
      {skipInitialization: true},
    );
    b.update(() => {
      $selectIn([0], 0, 2).formatText('bold');
      $setSelection(null);
    });
    await t.sync();
    a.update(() => {
      $selectIn([0], 1, 1);
    });
    await Promise.resolve();
    await t.sync();
    b.update(() => {
      $selectIn([0], 2, 3).formatText('italic');
      $setSelection(null);
    });
    await t.sync();
    expect(made).toBe(4);
    expect(a.read(() => $getRoot().getTextContent())).toBe('zero\n\ntwo####');
    expect(a.describe()).toBe((await freshReader(a)).describe());
    expect(b.describe()).toBe(a.describe());
    host.remove();
  });
});
