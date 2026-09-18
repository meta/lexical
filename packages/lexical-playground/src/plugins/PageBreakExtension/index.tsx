/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {ReactExtension} from '@lexical/react/ReactExtension';
import {$insertNodeToNearestRoot} from '@lexical/utils';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  defineExtension,
  type LexicalCommand,
} from 'lexical';

import {$createPageBreakNode, PageBreakNode} from '../../nodes/PageBreakNode';

export const INSERT_PAGE_BREAK: LexicalCommand<undefined> = createCommand();

export const PageBreakExtension = defineExtension({
  dependencies: [ReactExtension],
  name: '@lexical/playground/PageBreak',
  nodes: () => [PageBreakNode],
  register: editor =>
    editor.registerCommand(
      INSERT_PAGE_BREAK,
      () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        const pgBreak = $createPageBreakNode();
        $insertNodeToNearestRoot(pgBreak);

        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});
