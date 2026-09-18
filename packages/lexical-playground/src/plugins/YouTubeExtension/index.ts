/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {defineImportRule, DOMImportExtension, sel} from '@lexical/html';
import {$insertNodeToNearestRoot} from '@lexical/utils';
import {
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  defineExtension,
  type LexicalCommand,
} from 'lexical';

import {$createYouTubeNode, YouTubeNode} from '../../nodes/YouTubeNode';

export const INSERT_YOUTUBE_COMMAND: LexicalCommand<string> = createCommand(
  'INSERT_YOUTUBE_COMMAND',
);

const YouTubeImportRule = defineImportRule({
  $import: ctx => [$createYouTubeNode(ctx.captures.id[0])],
  match: sel
    .tag('iframe')
    .attr('data-lexical-youtube', /^.+$/, {capture: 'id'}),
  name: '@lexical/playground/youtube',
});

export const YouTubeExtension = defineExtension({
  dependencies: [
    configExtension(DOMImportExtension, {
      rules: [YouTubeImportRule],
    }),
  ],
  name: '@lexical/playground/YouTube',
  nodes: [YouTubeNode],
  register: editor =>
    editor.registerCommand(
      INSERT_YOUTUBE_COMMAND,
      payload => {
        const youTubeNode = $createYouTubeNode(payload);
        $insertNodeToNearestRoot(youTubeNode);

        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});
