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
  $hasUpdateTag,
  $onUpdate,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_LOW,
  HISTORIC_TAG,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

import {createTestConnection, waitForReact} from '../utils';

describe.each([false, true])(
  'selection listener edits (collab V2: %s)',
  useV2 => {
    test.each(['remote', 'undo'])(
      'syncs a deferred local listener edit following a %s caret change',
      async origin => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const connection = createTestConnection(useV2);
        const first = connection.createClient('1');
        const second = connection.createClient('2');
        first.start(container);
        second.start(container);
        onTestFinished(() => {
          first.stop();
          second.stop();
          container.remove();
        });
        await waitForReact(() => {
          first.update(() => {
            $getRoot()
              .clear()
              .append($createParagraphNode().append($createTextNode('hello')));
          });
        });
        if (origin === 'undo') {
          await waitForReact(() => {
            second.update(() => {
              $getRoot().getAllTextNodes()[0].spliceText(0, 0, 'x');
            });
          });
        }
        await waitForReact(() => {
          second.update(() => $getRoot().getAllTextNodes()[0].select(2, 2));
        });
        const tag = origin === 'undo' ? HISTORIC_TAG : COLLABORATION_TAG;
        const edit = vi.fn(() => {
          expect($hasUpdateTag(COLLABORATION_TAG)).toBe(false);
          expect($hasUpdateTag(HISTORIC_TAG)).toBe(false);
          $getRoot().getAllTextNodes()[0].setFormat('bold');
        });
        const editor = second.getEditor();
        const removeListener = editor.registerCommand(
          SELECTION_CHANGE_COMMAND,
          () => {
            if ($hasUpdateTag(tag)) {
              // Local content edits must run after the remote/undo commit, in
              // an update that participates in Yjs synchronization normally.
              $onUpdate(() => editor.update(edit));
            }
            return false;
          },
          COMMAND_PRIORITY_LOW,
        );
        onTestFinished(removeListener);
        await waitForReact(() => {
          if (origin === 'undo') {
            editor.dispatchCommand(UNDO_COMMAND);
          } else {
            first.update(() => {
              $getRoot().getAllTextNodes()[0].spliceText(0, 0, 'x');
            });
          }
        });
        expect(edit).toHaveBeenCalledTimes(1);
        expect(
          editor.read(() => $getRoot().getAllTextNodes()[0].hasFormat('bold')),
        ).toBe(true);
        expect(first.getHTML()).toBe(second.getHTML());
        expect(first.getDocJSON()).toEqual(second.getDocJSON());
      },
    );
  },
);
