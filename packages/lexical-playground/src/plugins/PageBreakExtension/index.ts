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
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  defineExtension,
  type LexicalCommand,
} from 'lexical';

import {$createPageBreakNode, PageBreakNode} from '../../nodes/PageBreakNode';

export const INSERT_PAGE_BREAK: LexicalCommand<undefined> = createCommand();

const PageBreakImportRule = defineImportRule({
  $import: () => [$createPageBreakNode()],
  match: sel.tag('hr').attr('data-lexical-page-break', 'true'),
  name: '@lexical/playground/page-break',
});

// Backward compatibility: older playground exports rendered the page break
// as `<figure type="page-break">`. Match that form too so older documents
// still round-trip into a PageBreakNode instead of being silently dropped
// by the generic `<figure>` rule from ImagesExtension.
const PageBreakLegacyImportRule = defineImportRule({
  $import: () => [$createPageBreakNode()],
  match: sel.tag('figure').attr('type', 'page-break'),
  name: '@lexical/playground/page-break-legacy',
});

export const PageBreakExtension = defineExtension({
  dependencies: [
    configExtension(DOMImportExtension, {
      rules: [PageBreakImportRule, PageBreakLegacyImportRule],
    }),
  ],
  name: '@lexical/playground/PageBreak',
  nodes: [PageBreakNode],
  register: editor =>
    editor.registerCommand(
      INSERT_PAGE_BREAK,
      () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        const focusNode = selection.focus.getNode();
        if (focusNode !== null) {
          const pgBreak = $createPageBreakNode();
          $insertNodeToNearestRoot(pgBreak);
        }

        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});
