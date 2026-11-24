/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$handleDecoratorClickModifiers} from '@lexical/extension';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$isDecoratorBlockNode} from '@lexical/react/LexicalDecoratorBlockNode';
import {useLexicalNodeSelection} from '@lexical/react/useLexicalNodeSelection';
import {$getNearestBlockElementAncestorOrThrow} from '@lexical/utils';
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  type ElementFormatType,
  FORMAT_ELEMENT_COMMAND,
  getComposedEventTarget,
  mergeRegister,
  type NodeKey,
} from 'lexical';
import * as React from 'react';
import {type JSX, type ReactNode, useEffect, useRef} from 'react';

type Props = Readonly<{
  children: ReactNode;
  format?: ElementFormatType | null;
  nodeKey: NodeKey;
  className: Readonly<{
    base: string;
    focus: string;
  }>;
}>;

/**
 * A wrapper component for the contents of a {@link DecoratorBlockNode} that
 * keeps the block in sync with node selection and element alignment. It renders
 * its `children` inside a container that reflects the node's `format`
 * alignment, responds to `FORMAT_ELEMENT_COMMAND` to update that alignment, and
 * toggles the node's selection when the container is clicked.
 *
 * @returns The element to render for the decorator block.
 */
export function BlockWithAlignableContents({
  children,
  format,
  nodeKey,
  className,
}: Props): JSX.Element {
  const [editor] = useLexicalComposerContext();

  const [isSelected, setSelected, clearSelection] =
    useLexicalNodeSelection(nodeKey);
  const ref = useRef(null);

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        FORMAT_ELEMENT_COMMAND,
        formatType => {
          if (isSelected) {
            const selection = $getSelection();

            if ($isNodeSelection(selection)) {
              const node = $getNodeByKey(nodeKey);

              if ($isDecoratorBlockNode(node)) {
                node.setFormat(formatType);
              }
            } else if ($isRangeSelection(selection)) {
              const nodes = selection.getNodes();

              for (const node of nodes) {
                if ($isDecoratorBlockNode(node)) {
                  node.setFormat(formatType);
                } else {
                  const element = $getNearestBlockElementAncestorOrThrow(node);
                  element.setFormat(formatType);
                }
              }
            }

            return true;
          }

          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        CLICK_COMMAND,
        event => {
          if (getComposedEventTarget(event) === ref.current) {
            event.preventDefault();
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
  }, [clearSelection, editor, isSelected, nodeKey, setSelected]);

  return (
    <div
      className={[className.base, isSelected ? className.focus : null]
        .filter(Boolean)
        .join(' ')}
      ref={ref}
      style={{
        textAlign: format ? format : undefined,
      }}>
      {children}
    </div>
  );
}
