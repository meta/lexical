/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$appendNodeToHTML} from '@lexical/html';
import {
  $create,
  $createParagraphNode,
  $getDocument,
  $getEditor,
  $getSlot,
  $getState,
  $isElementNode,
  $markSlotEditable,
  $setSlot,
  $setState,
  createState,
  type DOMExportOutput,
  type EditorConfig,
  type ElementDOMSlot,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeStateVersion,
  setDOMUnmanaged,
  type StateConfigValue,
  type StateValueOrUpdater,
} from 'lexical';

// The star rating (0–5), persisted as NodeState rather than a bespoke
// serialized field, so it rides copy/paste, undo, collab and JSON for free.
// parse() doubles as the default (0) and the clamp for untrusted input.
const ratingState = createState('rating', {
  parse: (v): number =>
    typeof v === 'number' && v >= 0 && v <= 5 ? Math.round(v) : 0,
});

// The Review demonstrates an ElementNode whose React presentation goes beyond
// static chrome: an interactive star-rating widget. React owns a stateful
// control (click/hover to set the rating) that writes back to the model via
// NodeState, while the two text channels — the named `author` slot AND the
// linked-list body children (the testimonial prose) — are Lexical-managed
// editable islands the chrome attaches where it wants them. Both text channels
// use the same render-hidden-then-attach technique: the reconciler renders the
// slot container as a hidden placeholder (named-slots default), and createDOM
// applies the identical pattern to the getDOMSlot children element below.
// ReviewExtension's React chrome reveals each region (useLexicalSlotRef for the
// author, the children element by class) and renders the rating stars.
// Contrast with CardNode (in-lexical chrome via getSlotTargetElement, no
// stateful widget) and PullQuoteNode (DecoratorNode host).
export class ReviewNode extends ElementNode {
  $config() {
    return this.config('review', {
      extends: ElementNode,
      slots: ['author'],
      stateConfigs: [{flat: true, stateConfig: ratingState}],
    });
  }

  getRating(version?: NodeStateVersion): StateConfigValue<typeof ratingState> {
    return $getState(this, ratingState, version);
  }
  setRating(valueOrUpdater: StateValueOrUpdater<typeof ratingState>): this {
    return $setState(this, ratingState, valueOrUpdater);
  }

  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    const dom = $getDocument().createElement('div');
    dom.className = 'lexical-review-node';
    // The shell is chrome: only the slot containers and the children element
    // flip back to contentEditable=true (the reconciler opts slot containers
    // in automatically when the host DOM is non-editable).
    dom.contentEditable = 'false';
    // Decorator parity for a chrome-owning element: the React portal, the
    // attach/park moves, and the rating widget's clicks all mutate the shell's
    // children from outside the reconciler, so the mutation observer must skip
    // records under it (like it does for DecoratorNode DOM) instead of evicting
    // the chrome and reverting the moves. Selection stays Lexical-managed (no
    // captureSelection): the islands are Lexical content, not a foreign widget.
    setDOMUnmanaged(dom);
    // The children element: same hidden-placeholder technique as named-slot
    // containers, applied to the getDOMSlot channel. The reconciler renders the
    // linked-list children into it synchronously wherever it sits; the React
    // chrome attaches and reveals it.
    const children = $getDocument().createElement('div');
    children.className = 'lexical-review-children';
    children.style.display = 'none';
    // The body is a getDOMSlot editable island inside the contentEditable=false
    // shell. Apply the same explicit editability the reconciler gives a
    // named-slot container so it follows the editor's editable state — one
    // shared helper, so the two paths can't drift. updateDOM re-applies it so an
    // editable toggle reaches the island.
    $markSlotEditable(children, editor);
    dom.appendChild(children);
    return dom;
  }

  updateDOM(_prevNode: this, dom: HTMLElement): boolean {
    const children = dom.querySelector<HTMLElement>('.lexical-review-children');
    if (children !== null) {
      $markSlotEditable(children, $getEditor());
    }
    return false;
  }

  // Linked-list children (the review prose) render into the children element
  // rather than the shell. Resolved by class (not :scope >) so it is still
  // found after the chrome relocates it.
  getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    const childrenEl = element.querySelector<HTMLElement>(
      '.lexical-review-children',
    );
    const domSlot = super.getDOMSlot(element);
    return childrenEl !== null ? domSlot.withElement(childrenEl) : domSlot;
  }

  // Block-level inserts land in the body channel instead of splitting the
  // Review (mirrors CardNode).
  isShadowRoot(): true {
    return true;
  }

  // Make the Review round-trip through HTML (copy/paste, getHTML). Like
  // CardNode, the slots ride a separate Map so the exporter never descends
  // into them on its own — emit the `author` slot into a `data-lexical-slot`
  // wrapper that ReviewImportRule maps back with $setSlot. `author` is a
  // single-line bare paragraph, so it exports itself directly into the
  // wrapper; the body children serialize through the normal child path,
  // appended after this element by the outer $appendNodesToHTML loop. The
  // rating is NodeState — not a child or slot — so it can't serialize
  // implicitly either; round-trip it as a data attribute the import reads back
  // through setRating().
  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const element = $getDocument().createElement('div');
    element.className = 'lexical-review-node';
    element.setAttribute('data-rating', String(this.getRating()));
    const author = $getSlot(this, 'author');
    if ($isElementNode(author)) {
      const wrapper = $getDocument().createElement('div');
      wrapper.setAttribute('data-lexical-slot', 'author');
      $appendNodeToHTML(editor, author, wrapper);
      element.append(wrapper);
    }
    return {element};
  }
}

export function $createReviewNode(): ReviewNode {
  const node = $create(ReviewNode);
  // Seed empty fields; the author hint and prose hint are CSS placeholders, so
  // the model carries no placeholder TextNodes.
  $setSlot(node, 'author', $createParagraphNode());
  node.append($createParagraphNode());
  return node;
}

export function $isReviewNode(
  node: LexicalNode | null | undefined,
): node is ReviewNode {
  return node instanceof ReviewNode;
}
