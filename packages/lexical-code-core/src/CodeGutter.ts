/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getEditor,
  $getNodeByKey,
  $isLineBreakNode,
  type LexicalEditor,
} from 'lexical';

import {CodeNode} from './CodeNode';

/**
 * Write the line numbers of a {@link CodeNode} to the `data-gutter`
 * attribute of its DOM element as a newline separated list (`"1\n2\n3"`),
 * so a theme can render them with `content: attr(data-gutter)`. There is
 * one line per `LineBreakNode` child plus one. The attribute is only
 * rewritten when the number of children has changed since the last call.
 *
 * @param node The CodeNode whose gutter should be updated.
 */
function $updateCodeGutter(node: CodeNode): void {
  const codeElement = $getEditor().getElementByKey(node.getKey());
  if (codeElement === null) {
    return;
  }
  const children = node.getChildren();
  const childrenLength = children.length;
  // @ts-ignore: internal field
  if (childrenLength === codeElement.__cachedChildrenLength) {
    // Avoid updating the attribute if the children length hasn't changed.
    return;
  }
  // @ts-ignore:: internal field
  codeElement.__cachedChildrenLength = childrenLength;
  let gutter = '1';
  let count = 1;
  for (let i = 0; i < childrenLength; i++) {
    if ($isLineBreakNode(children[i])) {
      gutter += '\n' + ++count;
    }
  }
  codeElement.setAttribute('data-gutter', gutter);
}

/**
 * @internal
 * Keep the `data-gutter` attribute of every {@link CodeNode} in sync with its
 * line count, so a theme can render line numbers with
 * `content: attr(data-gutter)`.
 *
 * Both `@lexical/code-prism` and `@lexical/code-shiki` register this. In
 * headless mode there is no DOM to write to, so registration is skipped and
 * the returned teardown does nothing.
 *
 * @param editor The editor whose code blocks should carry a gutter.
 * @returns A teardown that removes the listener.
 */
export function registerCodeGutter(editor: LexicalEditor): () => void {
  if (editor._headless) {
    return () => {};
  }
  return editor.registerMutationListener(
    CodeNode,
    mutations => {
      editor.read('latest', () => {
        for (const [key, type] of mutations) {
          if (type !== 'destroyed') {
            const node = $getNodeByKey(key);
            if (node !== null) {
              $updateCodeGutter(node as CodeNode);
            }
          }
        }
      });
    },
    {skipInitialization: false},
  );
}
