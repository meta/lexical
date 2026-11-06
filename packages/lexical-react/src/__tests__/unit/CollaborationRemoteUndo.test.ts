/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {expect, it} from 'vitest';
import {encodeStateAsUpdate, type UndoManager} from 'yjs';

import {type Client, createTestConnection, waitForReact} from '../utils';

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'local undo preserves remote text (v2: %s, new paragraph: %s)',
  async (useV2, newParagraph) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const connection = createTestConnection(useV2);
    const a = connection.createClient('1');
    const b = connection.createClient('2');
    let reloaded: Client | undefined;
    a.start(container);
    b.start(container);
    try {
      await waitForReact(() => {});
      await waitForReact(() =>
        a.update(() => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('Release notes')),
            );
          if (!newParagraph) $getRoot().append($createParagraphNode());
        }),
      );
      const manager = (a.getEditor() as unknown as Record<symbol, UndoManager>)[
        Symbol.for('@lexical/yjs/UndoManager')
      ];
      manager.stopCapturing();
      await waitForReact(() =>
        a.update(() => {
          if (newParagraph) $getRoot().append($createParagraphNode());
          $getRoot()
            .getLastChildOrThrow()
            .selectEnd()
            .insertText('This is a test. ');
        }),
      );
      await waitForReact(() =>
        b.update(() => {
          const paragraph = $getRoot().getLastChildOrThrow();
          if (!$isElementNode(paragraph)) throw new Error('Expected paragraph');
          const last = paragraph.getLastDescendant();
          if (!$isTextNode(last)) throw new Error('Expected shared text');
          last.selectEnd().insertText('Word');
        }),
      );
      const text = () =>
        a.getEditorState().read(() => $getRoot().getTextContent());
      expect(text()).toBe('Release notes\n\nThis is a test. Word');
      await waitForReact(() =>
        a.getEditor().dispatchCommand(UNDO_COMMAND, undefined),
      );
      expect(text()).toBe('Release notes\n\nWord');
      expect(b.getEditorState().read(() => $getRoot().getTextContent())).toBe(
        text(),
      );
      reloaded = connection.createClient('3');
      reloaded._updates.push(encodeStateAsUpdate(a.getDoc()));
      reloaded.start(container);
      await waitForReact(() => {});
      expect(
        reloaded.getEditorState().read(() => $getRoot().getTextContent()),
      ).toBe(text());
      await waitForReact(() =>
        a.getEditor().dispatchCommand(REDO_COMMAND, undefined),
      );
      expect(text()).toBe('Release notes\n\nThis is a test. Word');
    } finally {
      reloaded?.stop();
      a.stop();
      b.stop();
      container.remove();
    }
  },
);
