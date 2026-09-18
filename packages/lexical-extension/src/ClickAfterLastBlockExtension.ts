/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createParagraphNode,
  $getRoot,
  $isDecoratorNode,
  $isElementNode,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  registerEventListeners,
  safeCast,
  stopLexicalPropagation,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect, type Signal} from './signals';

/**
 * @experimental
 *
 * Default predicate matches {@link DecoratorNode} and shadow-root
 * `ElementNode`s (e.g. `TableNode`). Apps that want to also trigger on
 * other node types — `CodeNode`, custom non-editable blocks — should
 * compose this default in their own predicate rather than re-deriving
 * the check:
 *
 * ```ts
 * configExtension(ClickAfterLastBlockExtension, {
 *   $shouldInsertAfter: (node) =>
 *     $defaultShouldInsertAfter(node) || $isCodeNode(node),
 * });
 * ```
 */
export function $defaultShouldInsertAfter(node: LexicalNode): boolean {
  if ($isDecoratorNode(node)) {
    return true;
  }
  if ($isElementNode(node) && node.isShadowRoot()) {
    return true;
  }
  return false;
}

export interface ClickAfterLastBlockConfig {
  /** Set to `true` to disable this extension. */
  disabled: boolean;
  /**
   * Called inside the editor update with the last child of the root when
   * the user clicks the empty area below it. Return `true` to insert a
   * new paragraph after that node and select it; return `false` to leave
   * the click alone. Default is {@link $defaultShouldInsertAfter} — see
   * its docs for composition patterns.
   */
  $shouldInsertAfter: (node: LexicalNode) => boolean;
}

export interface ClickAfterLastBlockOutput {
  /** Set to `true` to disable this extension. */
  disabled: Signal<boolean>;
  /** Predicate signal — see {@link ClickAfterLastBlockConfig.$shouldInsertAfter}. */
  $shouldInsertAfter: Signal<(node: LexicalNode) => boolean>;
}

/**
 * Decide whether a click at `event` should be claimed by this extension.
 * Used by both the mousedown listener (to call preventDefault on the
 * browser's native caret pick) and the click listener (to actually
 * insert the paragraph). Factored out so the two handlers stay in sync
 * — they would otherwise share ~22 lines of byte-for-byte identical
 * logic and have to be maintained together.
 *
 * Read-only because it is called outside an editor.update; mutation
 * happens in the click handler's editor.update below.
 */
function shouldClaimClick(
  editor: LexicalEditor,
  rootElement: HTMLElement,
  event: MouseEvent,
  $shouldInsertAfter: (node: LexicalNode) => boolean,
): boolean {
  if (!editor.isEditable()) {
    return false;
  }
  // Only react to clicks on the root container itself. A click inside
  // an existing block is handled by the normal caret placement path.
  if (event.target !== rootElement) {
    return false;
  }
  return editor.read('latest', () => {
    const lastChild = $getRoot().getLastChild();
    if (lastChild === null) {
      return false;
    }
    const lastChildDOM = editor.getElementByKey(lastChild.getKey());
    if (lastChildDOM === null) {
      return false;
    }
    // Exclusive lower edge — clicks at exactly the bottom pixel fall
    // through to native handling, which is what users expect when
    // they click on a block's visible bottom border.
    if (event.clientY <= lastChildDOM.getBoundingClientRect().bottom) {
      return false;
    }
    return $shouldInsertAfter(lastChild);
  });
}

/**
 * Click handling for the empty area below the last block of the document.
 *
 * Without this extension, clicking the area below the last block when that
 * block is a {@link DecoratorNode}, a shadow-root ElementNode (e.g.
 * `TableNode`), or any other block that doesn't accept the click naturally
 * leaves the selection in an awkward place — `null` for a bare decorator,
 * or at the end of a table cell. Users typically expect a new paragraph
 * to appear below the block with the caret in it, matching the behavior
 * of editors like Notion.
 *
 * This extension intercepts clicks under those conditions, inserts a new
 * empty paragraph after the last block, and selects it.
 *
 * Closes #8544.
 */
export const ClickAfterLastBlockExtension = defineExtension({
  build: (_editor, config): ClickAfterLastBlockOutput => namedSignals(config),
  config: safeCast<ClickAfterLastBlockConfig>({
    $shouldInsertAfter: $defaultShouldInsertAfter,
    disabled: false,
  }),
  name: '@lexical/ClickAfterLastBlock',
  register: (editor, _config, _state) =>
    effect(() => {
      const output = _state.getOutput();
      if (output.disabled.value) {
        return;
      }
      return editor.registerRootListener(rootElement => {
        if (rootElement === null) {
          return;
        }
        // Two-phase: cancel native caret-pick at the earliest browser
        // event (mousedown), then claim the click for our own paragraph
        // insert. Without the mousedown leg the browser places a caret
        // on the previous text block before our editor.update lands,
        // visible as a one-frame cursor flicker.
        //
        // Side effect to be aware of: cancelling mousedown also cancels
        // native focus on that click. The subsequent paragraph.select()
        // inside editor.update DOM-focuses the root through the
        // reconciler, so the net effect is the same focused root, but
        // we are now responsible for the focus transition rather than
        // the browser.
        //
        // lexical core has a `pointerdown` listener that flips a
        // module-level `isSelectionChangeFromMouseDown` flag consumed
        // on the next selectionchange (LexicalEvents.ts). preventing
        // mousedown means no native selectionchange fires for this
        // click, so the flag never gets a chance to be consumed in the
        // wrong cycle. If you swap mousedown for pointerdown here you
        // also have to revisit that interaction.
        const onMouseDown = (event: MouseEvent) => {
          if (
            shouldClaimClick(
              editor,
              rootElement,
              event,
              output.$shouldInsertAfter.peek(),
            )
          ) {
            event.preventDefault();
          }
        };

        const onClick = (event: MouseEvent) => {
          if (
            !shouldClaimClick(
              editor,
              rootElement,
              event,
              output.$shouldInsertAfter.peek(),
            )
          ) {
            return;
          }
          event.preventDefault();
          // Tell lexical's root click handler to skip this event so the
          // default caret-placement logic in LexicalEvents.onClick exits
          // early. Without this the previous text block briefly receives
          // the caret before our paragraph insert lands.
          stopLexicalPropagation(event);
          editor.update(() => {
            const lastChild = $getRoot().getLastChild();
            if (lastChild === null) {
              return;
            }
            // Re-check inside the update — predicate may flip between
            // read and update if external transforms run.
            if (!output.$shouldInsertAfter.peek()(lastChild)) {
              return;
            }
            const paragraph = $createParagraphNode();
            lastChild.insertAfter(paragraph);
            paragraph.select();
          });
        };

        // Capture phase so the mousedown preventDefault runs before any
        // bubble-phase handler can react, and so the click flag is set
        // before lexical core's bubble-phase onClick reads it.
        return registerEventListeners(
          rootElement,
          {click: onClick, mousedown: onMouseDown},
          true,
        );
      });
    }),
});
