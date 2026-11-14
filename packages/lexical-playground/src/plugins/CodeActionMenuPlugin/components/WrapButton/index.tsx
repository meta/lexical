/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {$isCodeNode} from '@lexical/code';
import {$getNodeByKey, type LexicalEditor, type NodeKey} from 'lexical';

interface Props {
  editor: LexicalEditor;
  getCodeKey: () => NodeKey | null;
  isWrapped: boolean;
}

export function WrapButton({editor, getCodeKey, isWrapped}: Props) {
  // Find the node by key rather than through the hovered code element. With
  // line numbers only on wrapped blocks, toggling wrap replaces that element.
  function handleClick(): void {
    const key = getCodeKey();
    if (key === null) {
      return;
    }
    editor.update(() => {
      const codeNode = $getNodeByKey(key);
      if ($isCodeNode(codeNode)) {
        codeNode.setWordWrap(!codeNode.getWordWrap());
      }
    });
  }

  return (
    <button
      className="menu-item"
      onClick={handleClick}
      aria-label="wrap"
      aria-pressed={isWrapped}
      title="Wrap lines">
      <i className="format wrap" />
    </button>
  );
}
