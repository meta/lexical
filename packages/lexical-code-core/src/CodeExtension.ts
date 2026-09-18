/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {CoreImportExtension, DOMImportExtension} from '@lexical/html';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  configExtension,
  defineExtension,
  KEY_ENTER_COMMAND,
  mergeRegister,
  TabNode,
} from 'lexical';

import {CodeHighlightNode} from './CodeHighlightNode';
import {
  $installVscodeCodePasteOverlay,
  CodeImportRules,
} from './CodeImportExtension';
import {$exitCodeNodeOnEnter, $isCodeNode, CodeNode} from './CodeNode';

/**
 * Add code blocks to the editor (syntax highlighting provided separately)
 */
export const CodeExtension = defineExtension({
  dependencies: [
    // DOMImportExtension support for the nodes registered here. Inert
    // unless the editor routes HTML through the pipeline (e.g. via
    // ClipboardDOMImportExtension or $generateNodesFromDOMViaExtension).
    CoreImportExtension,
    configExtension(DOMImportExtension, {
      preprocess: [$installVscodeCodePasteOverlay],
      rules: CodeImportRules,
    }),
  ],
  name: '@lexical/code',
  nodes: () => [CodeNode, CodeHighlightNode],
  register(editor) {
    return mergeRegister(
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        event => {
          const selection = $getSelection();
          if ($isRangeSelection(selection) && $exitCodeNodeOnEnter(selection)) {
            if (event !== null) {
              event.preventDefault();
            }
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerNodeTransform(TabNode, node => {
        if (node.getFormat() !== 0 && $isCodeNode(node.getParent())) {
          node.setFormat(0);
        }
      }),
    );
  },
});

/**
 * Bundles {@link CodeImportRules} together with the runtime
 * {@link CodeExtension}.
 *
 * @experimental
 * @deprecated {@link CodeExtension} now registers
 * {@link CodeImportRules} (and `CoreImportExtension`) itself — depend on
 * it directly instead.
 */
export const CodeImportExtension = defineExtension({
  dependencies: [CodeExtension],
  name: '@lexical/code/Import',
});
