/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$insertNodeToNearestRoot} from '@lexical/utils';
import {
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  defineExtension,
  type LexicalCommand,
} from 'lexical';

import {$createFigmaNode, FigmaNode} from '../../nodes/FigmaNode';

export const INSERT_FIGMA_COMMAND: LexicalCommand<string> = createCommand(
  'INSERT_FIGMA_COMMAND',
);

export const FigmaExtension = defineExtension({
  name: '@lexical/playground/Figma',
  nodes: [FigmaNode],
  register: editor =>
    editor.registerCommand(
      INSERT_FIGMA_COMMAND,
      payload => {
        const figmaNode = $createFigmaNode(payload);
        $insertNodeToNearestRoot(figmaNode);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});
