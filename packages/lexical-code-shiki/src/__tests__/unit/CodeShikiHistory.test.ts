/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$createCodeNode} from '@lexical/code';
import {
  CodeShikiExtension,
  loadCodeLanguage,
  loadCodeTheme,
} from '@lexical/code-shiki';
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {RichTextExtension} from '@lexical/rich-text';
import {$createTextNode, $getRoot, defineExtension} from 'lexical';
import {describe, expect, test} from 'vitest';

function createEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension, HistoryExtension, CodeShikiExtension],
      name: 'code-shiki-history-test',
    }),
  );
}

/**
 * @lexical/code-shiki triggers async `editor.update()` calls while loading
 * grammar (loadCodeLanguage) and theme (loadCodeTheme) via Shiki. Before the
 * fix, each concurrent transform fired its own Promise `.then()`, producing
 * isolated `HISTORY_PUSH` entries that polluted the undo stack. After the
 * fix, async updates are tagged with `HISTORY_MERGE_TAG` so they fold into
 * the preceding history entry.
 */
describe('CodeShiki async loads do not pollute history stack', () => {
  test('creating a CodeNode with an unloaded language does not push to the undo stack', async () => {
    using editor = createEditor();

    // typescript is not loaded yet at this point
    editor.update(
      () => {
        const codeNode = $createCodeNode('typescript');
        codeNode.append($createTextNode('const x = 1;'));
        $getRoot().append(codeNode);
      },
      {discrete: true},
    );

    // Wait for the async language/theme loads that the transform triggered.
    // Because of in-flight Map deduplication, these calls return the same
    // Promise that is already in flight.
    await loadCodeLanguage('typescript');
    await loadCodeTheme('poimandres');

    const {output} = getExtensionDependencyFromEditor(editor, HistoryExtension);

    // The merge-tag should have prevented any PUSH into the stack
    expect(output.canUndo.peek()).toBe(false);
  });
});
