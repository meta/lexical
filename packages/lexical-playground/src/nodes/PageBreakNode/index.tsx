/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './index.css';

import {$handleDecoratorClickModifiers} from '@lexical/extension';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useLexicalNodeSelection} from '@lexical/react/useLexicalNodeSelection';
import {
  $getDocument,
  $getSelection,
  $isNodeSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  type LexicalNode,
  mergeRegister,
  type NodeKey,
  type SerializedLexicalNode,
} from 'lexical';
import * as React from 'react';
import {type JSX, useEffect} from 'react';

export type SerializedPageBreakNode = SerializedLexicalNode;

function PageBreakComponent({nodeKey}: {nodeKey: NodeKey}) {
  const [editor] = useLexicalComposerContext();
  const [isSelected, setSelected, clearSelection] =
    useLexicalNodeSelection(nodeKey);

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        CLICK_COMMAND,
        (event: MouseEvent) => {
          const pbElem = editor.getElementByKey(nodeKey);

          if (event.target === pbElem) {
            if ($handleDecoratorClickModifiers(event, nodeKey)) {
              return true;
            }
            const selection = $getSelection();
            const shouldSelect =
              !$isNodeSelection(selection) || !selection.has(nodeKey);
            if (!event.shiftKey) {
              clearSelection();
            }
            setSelected(shouldSelect);
            return true;
          }

          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [clearSelection, editor, nodeKey, setSelected]);

  useEffect(() => {
    const pbElem = editor.getElementByKey(nodeKey);
    if (pbElem !== null) {
      pbElem.className = isSelected ? 'selected' : '';
    }
  }, [editor, isSelected, nodeKey]);

  return null;
}

export class PageBreakNode extends DecoratorNode<JSX.Element> {
  $config() {
    return this.config('page-break', {extends: DecoratorNode});
  }

  createDOM(): HTMLElement {
    const el = $getDocument().createElement('hr');
    el.style.pageBreakAfter = 'always';
    el.setAttribute('data-lexical-page-break', 'true');
    return el;
  }

  getTextContent(): string {
    return '\n';
  }

  isInline(): false {
    return false;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    return <PageBreakComponent nodeKey={this.__key} />;
  }
}

export function $createPageBreakNode(): PageBreakNode {
  return new PageBreakNode();
}

export function $isPageBreakNode(
  node: LexicalNode | null | undefined,
): node is PageBreakNode {
  return node instanceof PageBreakNode;
}
