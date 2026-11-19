/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  buildEditorFromExtensions,
  ClearEditorExtension,
  configExtension,
} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type AnyLexicalExtensionArgument,
  CLEAR_EDITOR_COMMAND,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

function setUpEditor(
  dependency: AnyLexicalExtensionArgument = ClearEditorExtension,
) {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('content')),
        );
      },
      dependencies: [dependency],
      name: 'clear-editor-test',
    }),
  );
}

describe('ClearEditorExtension', () => {
  test('CLEAR_EDITOR_COMMAND empties the document', () => {
    using editor = setUpEditor();
    editor.dispatchCommand(CLEAR_EDITOR_COMMAND);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('');
    });
  });

  test('a configured $onClear replaces the default behavior', () => {
    using editor = setUpEditor(
      configExtension(ClearEditorExtension, {
        $onClear: () => {
          const root = $getRoot();
          root.clear();
          root.append(
            $createParagraphNode().append($createTextNode('cleared')),
          );
        },
      }),
    );
    editor.dispatchCommand(CLEAR_EDITOR_COMMAND);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('cleared');
    });
  });

  test('$onClear runs inline when dispatched from inside an update', () => {
    using editor = setUpEditor();
    // The document-replacement idiom: clear (including any extension state
    // hooked to the command), then build the new document, atomically. The
    // handler must run $onClear synchronously in the current update — if it
    // wrapped it in editor.update(), the nested update would be QUEUED and
    // clear the editor after the content below was appended.
    editor.update(() => {
      editor.dispatchCommand(CLEAR_EDITOR_COMMAND);
      const root = $getRoot();
      root.clear();
      root.append(
        $createParagraphNode().append($createTextNode('replacement')),
      );
    });
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('replacement');
    });
  });
});
