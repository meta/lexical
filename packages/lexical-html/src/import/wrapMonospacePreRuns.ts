/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {isDOMDocumentNode, isDOMTextNode, isHTMLElement} from 'lexical';

/**
 * True for an element with both `font-family: …monospace…` and
 * `white-space: pre*` inline, the style VS Code puts on code it copies.
 */
function isMonospacePre(node: Node): node is HTMLElement {
  return (
    isHTMLElement(node) &&
    /monospace/i.test(node.style.fontFamily) &&
    node.style.whiteSpace.startsWith('pre')
  );
}

function isBlankText(node: Node): boolean {
  return isDOMTextNode(node) && !/\S/.test(node.textContent || '');
}

/**
 * Code copied from VS Code reaches the clipboard in two shapes. Chrome wraps
 * the lines in one monospace `white-space: pre` `<div>`, which the legacy
 * `importDOM` converters turn into a single CodeNode. Safari instead writes a
 * flat run of sibling `<div>` (one per line) and `<br>` elements, each with
 * those styles, and the converters, which see one element at a time, turn
 * every line into its own CodeNode (#5569).
 *
 * This preprocess wraps each such run of two or more siblings, at least one
 * of them a `<div>`, in a `<div>` with the same `font-family` and
 * `white-space`, i.e. the Chrome shape. Elements already inside a monospace
 * `white-space: pre` element are left alone. `DOMImportExtension` handles the
 * Safari shape with its own rules, so this is only used by
 * `$generateNodesFromDOM`.
 */
export function wrapMonospacePreSiblingRunsDOM(
  dom: Document | ParentNode,
): void {
  const root: ParentNode = isDOMDocumentNode(dom) ? dom.body : dom;
  if (root) {
    wrapRuns(root);
  }
}

function wrapRuns(parent: ParentNode): void {
  let child = parent.firstChild;
  while (child !== null) {
    if (!isMonospacePre(child)) {
      if (isHTMLElement(child)) {
        wrapRuns(child);
      }
      child = child.nextSibling;
      continue;
    }
    // Collect the run, skipping whitespace-only text between its elements.
    const run: HTMLElement[] = [child];
    let next: ChildNode | null = child.nextSibling;
    let end: ChildNode | null = next;
    while (next !== null && (isBlankText(next) || isMonospacePre(next))) {
      if (isMonospacePre(next)) {
        run.push(next);
        end = next.nextSibling;
      }
      next = next.nextSibling;
    }
    const first = run.find(el => el.tagName === 'DIV');
    if (
      first !== undefined &&
      run.length > 1 &&
      run.every(el => el.tagName === 'DIV' || el.tagName === 'BR')
    ) {
      const wrapper = child.ownerDocument.createElement('div');
      wrapper.style.fontFamily = first.style.fontFamily;
      wrapper.style.whiteSpace = first.style.whiteSpace;
      parent.insertBefore(wrapper, child);
      const last = run[run.length - 1];
      let node: Node | null = child;
      while (node !== null) {
        const following: Node | null = node.nextSibling;
        if (isHTMLElement(node)) {
          wrapper.appendChild(node);
          // The wrapper carries the styles now. Left on a line, they would
          // make the legacy converters turn it into a CodeNode nested in the
          // block.
          node.style.removeProperty('font-family');
          node.style.removeProperty('white-space');
        } else {
          // Blank text between the lines would become a line of its own
          // inside the `white-space: pre` wrapper.
          parent.removeChild(node);
        }
        if (node === last) {
          break;
        }
        node = following;
      }
      child = wrapper.nextSibling;
    } else {
      child = end;
    }
  }
}
