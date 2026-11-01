/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {defineExtension, type LexicalEditor} from 'lexical';

/**
 * Marks an editor as headless. Use it with `buildEditorFromExtensions` for an
 * editor that will never be attached to the DOM, for example on a server or
 * in tests.
 *
 * An editor with no root element already skips reconciliation and DOM
 * selection, so this extension is not required for that. What it adds:
 *
 * - `editor.setRootElement(element)` throws, so the editor cannot be attached
 *   to the DOM by mistake. `setRootElement(null)` is still allowed, which is
 *   what `editor.dispose()` calls.
 * - Nested editors created with this editor as their `parentEditor` are
 *   headless too.
 * - Extensions that only do DOM work can check the flag and skip registering
 *   it, as the code gutter in `@lexical/code-core` does.
 *
 * Unlike {@link createHeadlessEditor}, listener registration methods such as
 * `registerRootListener` keep working, so extensions that register them can
 * be used in a headless editor. Those listeners never see a root element.
 */
export const HeadlessExtension = defineExtension({
  build: (editor: LexicalEditor) => {
    markEditorHeadless(editor);
  },
  name: '@lexical/headless/Headless',
});

function markEditorHeadless(editor: LexicalEditor): void {
  editor._headless = true;
  const setRootElement = editor.setRootElement;
  editor.setRootElement = function (nextRootElement) {
    invariant(
      nextRootElement === null,
      'HeadlessExtension: setRootElement is not supported in headless mode',
    );
    setRootElement.call(this, nextRootElement);
  };
}
