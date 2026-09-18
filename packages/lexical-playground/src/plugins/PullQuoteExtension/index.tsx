/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {NodeSelectionDataSelectedExtension} from '@lexical/extension';
import {
  CoreImportExtension,
  defineImportRule,
  DOMImportExtension,
  sel,
} from '@lexical/html';
import {
  $createNodeSelection,
  $createParagraphNode,
  $getSelection,
  $getSlot,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_BEFORE_EDITOR,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  configExtension,
  createCommand,
  defineExtension,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalCommand,
  mergeRegister,
} from 'lexical';

import {registerHostChromeSelection} from '../../nodes/hostChromeSelection';
import {$createSlotContainerNode} from '../../nodes/SlotContainerNode';
import {
  $findSlotHost,
  $insertSlotHostAtRoot,
  $isSlotHostTextEmpty,
  registerSlotHostArrowEscape,
  registerSlotHostBackspace,
} from '../../nodes/slotHostEscape';
import {$appendInline} from '../../nodes/slotImport';
import {
  $createPullQuoteNode,
  $isPullQuoteNode,
  PullQuoteNode,
} from './PullQuoteNode';

export const INSERT_PULLQUOTE_COMMAND: LexicalCommand<void> = createCommand(
  'INSERT_PULLQUOTE_COMMAND',
);

// Enter while the PullQuote is the only selected node drops the caret into its
// quote slot, so the keyboard can step into the box the way a chrome click does.
function $handlePullQuoteEnter(event: KeyboardEvent | null): boolean {
  const selection = $getSelection();
  if (!$isNodeSelection(selection)) {
    return false;
  }
  const nodes = selection.getNodes();
  if (nodes.length !== 1 || !$isPullQuoteNode(nodes[0])) {
    return false;
  }
  const quote = $getSlot(nodes[0], 'quote');
  if (!$isElementNode(quote)) {
    return false;
  }
  event?.preventDefault();
  quote.selectStart();
  return true;
}

// Escape from inside either slot promotes the RangeSelection to a NodeSelection
// on the whole PullQuote — the inverse of $handlePullQuoteEnter, and the
// keyboard counterpart to the chrome click.
function $handlePullQuoteEscape(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return false;
  }
  const host = $findSlotHost(selection.anchor.getNode(), $isPullQuoteNode);
  if (host === null) {
    return false;
  }
  const nodeSelection = $createNodeSelection();
  nodeSelection.add(host.getKey());
  $setSelection(nodeSelection);
  return true;
}

// Reconstruct a PullQuoteNode from its exported HTML (see
// PullQuoteNode.exportDOM): a `<div class="lexical-pullquote-node">` wrapping a
// `<div data-lexical-slot="quote">` and `<div data-lexical-slot="attribution">`.
// The quote is multi-block, so it becomes a SlotContainerNode seeded with the
// imported children; the attribution is a single-line slot flattened to its
// inline projection. Both seeds are dropped first so an HTML fragment missing a
// slot can't inherit the default text. The host is a DecoratorNode with no
// children channel, so non-slot children land in the quote slot rather than
// being dropped.
const PullQuoteImportRule = defineImportRule({
  $import: (ctx, el) => {
    const quote = $createSlotContainerNode();
    const attribution = $createParagraphNode();
    const pullquote = $createPullQuoteNode(quote, attribution);
    for (const domChild of Array.from(el.children)) {
      const slotName = domChild.getAttribute('data-lexical-slot');
      if (slotName === 'quote') {
        quote.splice(quote.getChildrenSize(), 0, ctx.$importChildren(domChild));
      } else if (slotName === 'attribution') {
        $appendInline(attribution, ctx.$importChildren(domChild));
      } else {
        // import any orphans to the quote
        quote.splice(quote.getChildrenSize(), 0, ctx.$importOne(domChild));
      }
    }
    return [pullquote];
  },
  match: sel.tag('div').classAll('lexical-pullquote-node'),
  name: '@lexical/playground/pullquote-host',
});

export const PullQuoteExtension = defineExtension({
  dependencies: [
    // Mirror NodeSelection state onto a `data-selected` attribute on the
    // host DOM so CSS can render the selected outline.
    configExtension(NodeSelectionDataSelectedExtension, {
      nodes: [PullQuoteNode],
    }),
    // The PullQuote's HTML import rule rides its own extension (like every
    // other node extension that registers its own DOM-import rules). CoreImport
    // supplies the paragraph/text rules the rule's children-import relies on
    // and orders this host rule ahead of the generic block rules.
    CoreImportExtension,
    configExtension(DOMImportExtension, {
      rules: [PullQuoteImportRule],
    }),
  ],
  name: '@lexical/playground/PullQuote',
  register: editor => {
    return mergeRegister(
      editor.registerCommand(
        INSERT_PULLQUOTE_COMMAND,
        () => {
          $insertSlotHostAtRoot($createPullQuoteNode());
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      // Click on the PullQuote chrome (outside its slot wrappers) selects the
      // whole node as a NodeSelection, with a matching mousedown that
      // suppresses the native caret the browser would otherwise drop there.
      registerHostChromeSelection(editor, $isPullQuoteNode),
      // ArrowDown/Up at the PullQuote's bottom/top slot edge steps out of it.
      registerSlotHostArrowEscape(editor, $isPullQuoteNode),
      // Backspace deletes an empty PullQuote (from a slot start or the block
      // after it), like the Card / Review. The range-replace path is a no-op for
      // a DecoratorNode (it is already atomic, so a select-all deletes it).
      registerSlotHostBackspace(editor, $isPullQuoteNode, $isSlotHostTextEmpty),
      // Enter on the selected PullQuote drops the caret into its quote slot...
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        $handlePullQuoteEnter,
        COMMAND_PRIORITY_BEFORE_EDITOR,
      ),
      // ...and Escape from either slot selects the whole PullQuote again.
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        $handlePullQuoteEscape,
        COMMAND_PRIORITY_LOW,
      ),
    );
  },
});
