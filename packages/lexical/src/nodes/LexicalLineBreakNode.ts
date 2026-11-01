/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {KlassConstructor} from '../LexicalEditor';

import {GENERATED_LINEBREAK} from '../LexicalGeneratedJSON';
import {
  type DOMConversionOutput,
  LexicalNode,
  type SerializedLexicalNode,
} from '../LexicalNode';
import {
  $applyNodeReplacement,
  $getDocument,
  isBlockDomNode,
  isDOMTextNode,
} from '../LexicalUtils';

export type SerializedLineBreakNode = SerializedLexicalNode;

/** @noInheritDoc */
export class LineBreakNode extends LexicalNode {
  /** @internal */
  declare ['constructor']: KlassConstructor<typeof LineBreakNode>;

  $config() {
    return this.config('linebreak', {
      extends: LexicalNode,
      generated: GENERATED_LINEBREAK,
      importDOM: {
        br: (node: Node) => {
          if (isOnlyChildInBlockNode(node) || isLastChildInBlockNode(node)) {
            return null;
          }
          return {
            conversion: $convertLineBreakElement,
            priority: 0,
          };
        },
      },
    });
  }

  getTextContent(): '\n' {
    return '\n';
  }

  createDOM(): HTMLElement {
    return $getDocument().createElement('br');
  }

  updateDOM(): false {
    return false;
  }

  isInline(): true {
    return true;
  }
}

function $convertLineBreakElement(node: Node): DOMConversionOutput {
  return {node: $createLineBreakNode()};
}

/** Creates a LineBreakNode representing a soft line break (Shift+Enter). */
export function $createLineBreakNode(): LineBreakNode {
  return $applyNodeReplacement(new LineBreakNode());
}

/** Returns true if the given node is a LineBreakNode. */
export function $isLineBreakNode(
  node: LexicalNode | null | undefined,
): node is LineBreakNode {
  return node instanceof LineBreakNode;
}

/**
 * True when `node` is the sole non-whitespace child of a block DOM
 * element. Used by the LineBreak importer to drop stray `<br>` elements
 * that the legacy `$generateNodesFromDOM` also skipped (matches the
 * behavior of `LineBreakNode.importDOM`).
 *
 * @experimental
 */
export function isOnlyChildInBlockNode(node: Node): boolean {
  const parentElement = node.parentElement;
  if (parentElement !== null && isBlockDomNode(parentElement)) {
    const firstChild = parentElement.firstChild!;
    if (
      firstChild === node ||
      (firstChild.nextSibling === node && isWhitespaceDomTextNode(firstChild))
    ) {
      const lastChild = parentElement.lastChild!;
      if (
        lastChild === node ||
        (lastChild.previousSibling === node &&
          isWhitespaceDomTextNode(lastChild))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when `node` is the trailing non-whitespace child of a block DOM
 * element (excluding the only-child case). Used by the LineBreak
 * importer to drop trailing `<br>` elements like the Apple-interchange
 * clipboard artifact (matches `LineBreakNode.importDOM`).
 *
 * @experimental
 */
export function isLastChildInBlockNode(node: Node): boolean {
  const parentElement = node.parentElement;
  if (parentElement !== null && isBlockDomNode(parentElement)) {
    // check if node is first child, because only child dont count
    const firstChild = parentElement.firstChild!;
    if (
      firstChild === node ||
      (firstChild.nextSibling === node && isWhitespaceDomTextNode(firstChild))
    ) {
      return false;
    }

    // check if its last child
    const lastChild = parentElement.lastChild!;
    if (
      lastChild === node ||
      (lastChild.previousSibling === node && isWhitespaceDomTextNode(lastChild))
    ) {
      return true;
    }
  }
  return false;
}

function isWhitespaceDomTextNode(node: Node): boolean {
  return isDOMTextNode(node) && /^( |\t|\r?\n)+$/.test(node.textContent || '');
}
