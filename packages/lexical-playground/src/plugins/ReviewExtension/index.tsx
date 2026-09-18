/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {DecoratorComponentProps} from '@lexical/react/ReactPluginHostExtension';

import {namedSignals, WatchEditableExtension} from '@lexical/extension';
import {
  CoreImportExtension,
  defineImportRule,
  DOMImportExtension,
  sel,
} from '@lexical/html';
import {ReactExtension} from '@lexical/react/ReactExtension';
import {useExtensionDependency} from '@lexical/react/useExtensionComponent';
import {
  useExtensionSignalValue,
  useSignalValue,
} from '@lexical/react/useExtensionSignalValue';
import {useLexicalSlotRef} from '@lexical/react/useLexicalSlotRef';
import {
  $createParagraphNode,
  $getNodeByKey,
  $getSlot,
  $isParagraphNode,
  $setSlot,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  defineExtension,
  type LexicalCommand,
  type LexicalEditor,
  mergeRegister,
  NODE_STATE_DIRECT,
  type NodeKey,
} from 'lexical';
import {type JSX, type RefCallback, useCallback, useState} from 'react';
import {createPortal} from 'react-dom';

import {
  $insertSlotHostAtRoot,
  $isSlotHostTextEmpty,
  registerSlotHostArrowEscape,
  registerSlotHostBackspace,
} from '../../nodes/slotHostEscape';
import {$appendInline} from '../../nodes/slotImport';
import {$createReviewNode, $isReviewNode, ReviewNode} from './ReviewNode';

export const INSERT_REVIEW_COMMAND: LexicalCommand<void> = createCommand(
  'INSERT_REVIEW_COMMAND',
);

const STARS = [1, 2, 3, 4, 5];

// The getDOMSlot analog of useLexicalSlotRef: attaches the Review's hidden
// children element (where the reconciler renders the linked-list body prose)
// into the chrome and reveals it. Same idempotent no-cleanup-per-render shape
// as useLexicalSlotRef so a chrome re-render never detaches the element
// mid-edit; the final unmount parks it back hidden in the host DOM.
function useReviewChildren<T extends HTMLElement = HTMLElement>(
  editor: LexicalEditor,
  nodeKey: NodeKey,
): RefCallback<T | null> {
  return useCallback<RefCallback<T | null>>(
    target => {
      const hostDom = editor.getElementByKey(nodeKey);
      if (target === null || hostDom === null) {
        return;
      }
      const childrenEl = hostDom.querySelector<HTMLElement>(
        '.lexical-review-children',
      );
      if (childrenEl === null) {
        return;
      }
      if (childrenEl.parentElement !== target) {
        target.appendChild(childrenEl);
      }
      childrenEl.style.display = '';
      return () => {
        childrenEl.style.display = 'none';
        if (childrenEl.parentElement !== hostDom) {
          hostDom.appendChild(childrenEl);
        }
      };
    },
    [editor, nodeKey],
  );
}

// The interactive rating control — the React-driven part that distinguishes
// this demo from CardNode's static chrome. It mirrors the committed `rating`
// NodeState into React (via an update listener) and writes edits back through
// editor.update, so the value participates in undo/redo, copy/paste and collab
// like any other model state. The buttons live under the contentEditable=false
// shell, so clicking them sets the rating without moving the editor selection.
function ReviewStars({
  editor,
  node,
}: {
  editor: LexicalEditor;
  node: ReviewNode;
}): JSX.Element {
  const rating = node.getRating(NODE_STATE_DIRECT);
  const isEditable = useSignalValue(
    useExtensionDependency(WatchEditableExtension).output,
  );
  const [hover, setHover] = useState(0);
  const setStars = (value: number) =>
    editor.update(() => {
      // Clicking the current top star clears the rating back to zero.
      node.setRating(value === rating ? 0 : value);
    });
  const shown = (isEditable && hover) || rating;
  return (
    <div
      className="lexical-review-stars"
      aria-label={`Rating: ${rating} of 5`}
      onMouseLeave={() => setHover(0)}>
      {STARS.map(value => (
        <button
          key={value}
          type="button"
          className={
            value <= shown
              ? 'lexical-review-star lexical-review-star-on'
              : 'lexical-review-star'
          }
          aria-pressed={value <= rating}
          aria-label={`${value} star${value === 1 ? '' : 's'}`}
          disabled={!isEditable}
          onMouseEnter={() => setHover(value)}
          onClick={() => {
            if (isEditable) {
              setStars(value);
            }
          }}>
          ★
        </button>
      ))}
    </div>
  );
}

function ReviewChrome({
  editor,
  node,
}: {
  editor: LexicalEditor;
  node: ReviewNode;
}): JSX.Element {
  const nodeKey = node.getKey();
  const authorRef = useLexicalSlotRef<HTMLDivElement>(
    editor,
    nodeKey,
    'author',
  );
  const childrenRef = useReviewChildren<HTMLDivElement>(editor, nodeKey);
  // Testimonial layout: rating, then the quoted prose, then the attribution.
  return (
    <div className="lexical-review-chrome">
      <ReviewStars editor={editor} node={node} />
      <div className="lexical-review-body" ref={childrenRef} />
      <div className="lexical-review-author" ref={authorRef} />
    </div>
  );
}

// React presentation for every ReviewNode: a portal into each host's DOM
// renders the chrome, and the chrome attaches the editable regions and the
// rating widget. This is the ElementNode equivalent of a DecoratorNode's
// decorate(), implemented in userland with a mutation listener.
export function ReviewPlugin({context}: DecoratorComponentProps): JSX.Element {
  const [editor] = context;
  const nodeMap = useExtensionSignalValue(ReactReviewExtension, 'nodeMap');
  return (
    <>
      {Array.from(nodeMap.entries(), ([key, node]) => {
        const dom = editor.getElementByKey(key);
        return dom === null
          ? null
          : createPortal(
              <ReviewChrome editor={editor} node={node} />,
              dom,
              key,
            );
      })}
    </>
  );
}

// Reconstruct a ReviewNode from its exported HTML (see ReviewNode.exportDOM):
// a `<div class="lexical-review-node" data-rating="N">` wrapping a
// `<div data-lexical-slot="author">` and the body prose as regular paragraph
// siblings. The author is a single-line slot flattened to its inline
// projection; the body imports through the normal child path; the `rating`
// NodeState is restored from the data attribute, clamped to 0-5 so
// hand-authored HTML can't push it out of range.
const ReviewImportRule = defineImportRule({
  $import: (ctx, el) => {
    // Clear any seeded default body paragraph so imported children replace it.
    const review = $createReviewNode().clear();
    // Clear the seeded empty paragraph
    // defensively so the import can never carry over fabricated content.
    const prevAuthor = $getSlot(review, 'author');
    const author = $isParagraphNode(prevAuthor)
      ? prevAuthor.clear()
      : $createParagraphNode();
    $setSlot(review, 'author', author);
    const rating = Number(el.getAttribute('data-rating'));
    if (Number.isFinite(rating)) {
      review.setRating(Math.max(0, Math.min(5, Math.round(rating))));
    }
    for (const domChild of Array.from(el.children)) {
      const slotName = domChild.getAttribute('data-lexical-slot');
      if (slotName === 'author') {
        $appendInline(author, ctx.$importChildren(domChild));
      } else {
        review.splice(review.getChildrenSize(), 0, ctx.$importOne(domChild));
      }
    }
    return [review];
  },
  match: sel.tag('div').classAll('lexical-review-node'),
  name: '@lexical/playground/review-host',
});

export const ReviewExtension = defineExtension({
  // The Review's HTML import rule rides its own extension — like every other
  // node extension that registers its own DOM-import rules — rather than a
  // central playground aggregate. CoreImportExtension supplies the
  // paragraph/text rules the rule's children-import relies on and orders this
  // host rule ahead of the generic block rules (the playground's always-on
  // ClipboardDOMImportExtension routes pastes through this pipeline).
  dependencies: [
    CoreImportExtension,
    configExtension(DOMImportExtension, {
      rules: [ReviewImportRule],
    }),
  ],
  name: '@lexical/playground/Review',
  nodes: [ReviewNode],
  register: editor =>
    mergeRegister(
      editor.registerCommand(
        INSERT_REVIEW_COMMAND,
        () => {
          $insertSlotHostAtRoot($createReviewNode());
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      // ArrowDown/Up at the Review's bottom/top edge steps out of it. The
      // helper reads the rendered order, so the Review's body-above-author
      // chrome needs no special handling here.
      registerSlotHostArrowEscape(editor, $isReviewNode),
      // Backspace deletes a text-empty Review (from the start of its body or the
      // block right after it), and a select-all that spans a first-block Review
      // replaces the whole Review with a paragraph. The rating is not counted as
      // content, so a rated-but-textless Review is deleted too.
      registerSlotHostBackspace(editor, $isReviewNode, $isSlotHostTextEmpty),
      // Unlike the Card / PullQuote, the Review deliberately has no
      // chrome-click / Escape whole-node NodeSelection: its React chrome is
      // interactive (the star widget) and its body is a getDOMSlot element, not
      // a `data-lexical-slot` wrapper, so there is no clean "chrome padding" hit
      // zone to promote from without stealing the rating clicks. Selecting and
      // deleting the whole box is instead covered by the select-all replace and
      // empty-host backspace above.
    ),
});

/**
 * This provides the in-editor React rendering for the review extension
 */
export const ReactReviewExtension = defineExtension({
  build: () => namedSignals({nodeMap: new Map<NodeKey, ReviewNode>()}),
  dependencies: [
    configExtension(ReactExtension, {
      decorators: [ReviewPlugin],
    }),
    WatchEditableExtension,
    ReviewExtension,
  ],
  name: '@lexical/playground/ReactReview',
  register: (editor, config, state) => {
    // Track all live ReviewNodes to render their portals
    const nodeMapSignal = state.getOutput().nodeMap;
    return editor.registerMutationListener(ReviewNode, nodes => {
      nodeMapSignal.value = editor.read('latest', () => {
        const nodeMap = new Map(nodeMapSignal.peek());
        for (const k of nodes.keys()) {
          const node = $getNodeByKey(k);
          if ($isReviewNode(node)) {
            nodeMap.set(k, node);
          } else {
            nodeMap.delete(k);
          }
        }
        return nodeMap;
      });
    });
  },
});
