/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $isHeadingNode,
  HeadingNode,
  type HeadingTagType,
} from '@lexical/rich-text';
import {$getNextRightPreorderNode} from '@lexical/utils';
import {
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  type ElementNode,
  type LexicalEditor,
  type NodeKey,
  type NodeMutation,
  TextNode,
} from 'lexical';
import {type JSX, useEffect, useState} from 'react';

/**
 * A single entry in the table of contents, as a tuple of the heading node's
 * {@link NodeKey}, its text content, and its heading tag (for example `'h1'`).
 */
export type TableOfContentsEntry = [
  key: NodeKey,
  text: string,
  tag: HeadingTagType,
];

function toEntry(heading: HeadingNode): TableOfContentsEntry {
  return [heading.getKey(), heading.getTextContent(), heading.getTag()];
}

function $insertHeadingIntoTableOfContents(
  prevHeading: HeadingNode | null,
  newHeading: HeadingNode | null,
  currentTableOfContents: TableOfContentsEntry[],
): TableOfContentsEntry[] {
  if (newHeading === null) {
    return currentTableOfContents;
  }
  const newEntry: TableOfContentsEntry = toEntry(newHeading);
  let newTableOfContents: TableOfContentsEntry[] = [];
  if (prevHeading === null) {
    // check if key already exists
    if (
      currentTableOfContents.length > 0 &&
      currentTableOfContents[0][0] === newHeading.__key
    ) {
      return currentTableOfContents;
    }
    newTableOfContents = [newEntry, ...currentTableOfContents];
  } else {
    for (let i = 0; i < currentTableOfContents.length; i++) {
      const key = currentTableOfContents[i][0];
      newTableOfContents.push(currentTableOfContents[i]);
      if (key === prevHeading.getKey() && key !== newHeading.getKey()) {
        // check if key already exists
        if (
          i + 1 < currentTableOfContents.length &&
          currentTableOfContents[i + 1][0] === newHeading.__key
        ) {
          return currentTableOfContents;
        }
        newTableOfContents.push(newEntry);
      }
    }
  }
  return newTableOfContents;
}

function $deleteHeadingFromTableOfContents(
  key: NodeKey,
  currentTableOfContents: TableOfContentsEntry[],
): TableOfContentsEntry[] {
  const newTableOfContents = [];
  for (const heading of currentTableOfContents) {
    if (heading[0] !== key) {
      newTableOfContents.push(heading);
    }
  }
  return newTableOfContents;
}

function $updateHeadingInTableOfContents(
  heading: HeadingNode,
  currentTableOfContents: TableOfContentsEntry[],
): TableOfContentsEntry[] {
  const newTableOfContents: TableOfContentsEntry[] = [];
  for (const oldHeading of currentTableOfContents) {
    if (oldHeading[0] === heading.getKey()) {
      newTableOfContents.push(toEntry(heading));
    } else {
      newTableOfContents.push(oldHeading);
    }
  }
  return newTableOfContents;
}

/**
 * Returns the updated table of contents, placing the given `heading` before the given `prevHeading`. If `prevHeading`
 * is undefined, `heading` is placed at the start of table of contents
 */
function $updateHeadingPosition(
  prevHeading: HeadingNode | null,
  heading: HeadingNode,
  currentTableOfContents: TableOfContentsEntry[],
): TableOfContentsEntry[] {
  const newTableOfContents: TableOfContentsEntry[] = [];
  const newEntry: TableOfContentsEntry = toEntry(heading);

  if (!prevHeading) {
    newTableOfContents.push(newEntry);
  }
  for (const oldHeading of currentTableOfContents) {
    if (oldHeading[0] === heading.getKey()) {
      continue;
    }
    newTableOfContents.push(oldHeading);
    if (prevHeading && oldHeading[0] === prevHeading.getKey()) {
      newTableOfContents.push(newEntry);
    }
  }

  return newTableOfContents;
}

function $getPreviousHeading(node: HeadingNode): HeadingNode | null {
  let prevHeading = $getNextRightPreorderNode(node);
  while (prevHeading !== null && !$isHeadingNode(prevHeading)) {
    prevHeading = $getNextRightPreorderNode(prevHeading);
  }
  return prevHeading;
}

type Props = {
  children: (
    values: TableOfContentsEntry[],
    editor: LexicalEditor,
  ) => JSX.Element;
};

/**
 * Tracks every {@link HeadingNode} in the editor and keeps an ordered list of
 * {@link TableOfContentsEntry}s in sync as headings are added, removed, edited,
 * or moved. It is a render-prop component: `children` receives the current
 * entries and the editor and returns the element used to render the table of
 * contents.
 *
 * @returns The element returned by the `children` render prop.
 */
export function TableOfContentsPlugin({children}: Props): JSX.Element {
  const [tableOfContents, setTableOfContents] = useState<
    TableOfContentsEntry[]
  >([]);
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    // Set table of contents initial state
    let currentTableOfContents: TableOfContentsEntry[] = [];
    editor.read('latest', () => {
      const updateCurrentTableOfContents = (node: ElementNode) => {
        for (const child of node.getChildren()) {
          if ($isHeadingNode(child)) {
            currentTableOfContents.push([
              child.getKey(),
              child.getTextContent(),
              child.getTag(),
            ]);
          } else if ($isElementNode(child)) {
            updateCurrentTableOfContents(child);
          }
        }
      };

      updateCurrentTableOfContents($getRoot());
      setTableOfContents(currentTableOfContents);
    });

    const removeRootUpdateListener = editor.registerUpdateListener(
      ({editorState, dirtyElements}) => {
        editor.read(editorState, () => {
          const updateChildHeadings = (node: ElementNode) => {
            for (const child of node.getChildren()) {
              if ($isHeadingNode(child)) {
                const prevHeading = $getPreviousHeading(child);
                currentTableOfContents = $updateHeadingPosition(
                  prevHeading,
                  child,
                  currentTableOfContents,
                );
                setTableOfContents(currentTableOfContents);
              } else if ($isElementNode(child)) {
                updateChildHeadings(child);
              }
            }
          };

          // If a node is changes, all child heading positions need to be updated
          $getRoot()
            .getChildren()
            .forEach(node => {
              if ($isElementNode(node) && dirtyElements.get(node.__key)) {
                updateChildHeadings(node);
              }
            });
        });
      },
    );

    // Listen to updates to heading mutations and update state
    const removeHeaderMutationListener = editor.registerMutationListener(
      HeadingNode,
      (mutatedNodes: Map<string, NodeMutation>) => {
        editor.read('latest', () => {
          for (const [nodeKey, mutation] of mutatedNodes) {
            if (mutation === 'created') {
              const newHeading = $getNodeByKey(nodeKey);
              if ($isHeadingNode(newHeading)) {
                const prevHeading = $getPreviousHeading(newHeading);
                currentTableOfContents = $insertHeadingIntoTableOfContents(
                  prevHeading,
                  newHeading,
                  currentTableOfContents,
                );
              }
            } else if (mutation === 'destroyed') {
              currentTableOfContents = $deleteHeadingFromTableOfContents(
                nodeKey,
                currentTableOfContents,
              );
            } else if (mutation === 'updated') {
              const newHeading = $getNodeByKey(nodeKey);
              if ($isHeadingNode(newHeading)) {
                const prevHeading = $getPreviousHeading(newHeading);
                currentTableOfContents = $updateHeadingPosition(
                  prevHeading,
                  newHeading,
                  currentTableOfContents,
                );
              }
            }
          }
          setTableOfContents(currentTableOfContents);
        });
      },
      // Initialization is handled separately
      {skipInitialization: true},
    );

    // Listen to text node mutation updates
    const removeTextNodeMutationListener = editor.registerMutationListener(
      TextNode,
      (mutatedNodes: Map<string, NodeMutation>) => {
        editor.read('latest', () => {
          for (const [nodeKey, mutation] of mutatedNodes) {
            if (mutation === 'updated') {
              const currNode = $getNodeByKey(nodeKey);
              if (currNode !== null) {
                const parentNode = currNode.getParentOrThrow();
                if ($isHeadingNode(parentNode)) {
                  currentTableOfContents = $updateHeadingInTableOfContents(
                    parentNode,
                    currentTableOfContents,
                  );
                  setTableOfContents(currentTableOfContents);
                }
              }
            }
          }
        });
      },
      // Initialization is handled separately
      {skipInitialization: true},
    );

    return () => {
      removeHeaderMutationListener();
      removeTextNodeMutationListener();
      removeRootUpdateListener();
    };
  }, [editor]);

  return children(tableOfContents, editor);
}
