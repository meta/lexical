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
  domOverride,
  DOMRenderExtension,
  sel,
} from '@lexical/html';
import {
  $createNodeSelection,
  $createParagraphNode,
  $getAdjacentNode,
  $getSelection,
  $getSlot,
  $getSlotHost,
  $getSlotNameWithinHost,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  $setSlot,
  COMMAND_PRIORITY_BEFORE_EDITOR,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  defineExtension,
  isModifierMatch,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalCommand,
  type LexicalNode,
  mergeRegister,
  type NodeKey,
  type PointType,
} from 'lexical';

import {registerHostChromeSelection} from '../../nodes/hostChromeSelection';
import {
  $insertSlotHostAtRoot,
  $isSlotHostTextEmpty,
  registerSlotHostArrowEscape,
  registerSlotHostBackspace,
} from '../../nodes/slotHostEscape';
import {$appendInline} from '../../nodes/slotImport';
import {$createCardNode, $isCardNode, CardNode} from './CardNode';

export const INSERT_CARD_COMMAND: LexicalCommand<void> = createCommand(
  'INSERT_CARD_COMMAND',
);

// Promote a RangeSelection adjacent to a CardNode boundary into a
// NodeSelection on the Card. Once the NodeSelection is set, the
// lexical-rich-text KEY_ARROW_* handlers already step out of it via
// selectPrevious()/selectNext(), so there's no NodeSelection branch
// here — this only handles the range→node promotion.
//
// Priority needs to run before lexical-rich-text's EDITOR-priority
// RangeSelection branch so we can intercept the caret step into the
// Card's title interior. BEFORE_EDITOR is the same bucket but unshifted
// to the queue head — the lowest priority that still wins this race.
function $handleCardArrow(
  event: KeyboardEvent | null,
  isBackward: boolean,
): boolean {
  const selection = $getSelection();
  // Only a plain arrow promotes to a NodeSelection; any modifier (shift = extend
  // selection, alt/ctrl = word jump, meta = line/doc jump) is OS navigation that
  // must pass through rather than be swallowed by the promotion.
  if (
    !$isRangeSelection(selection) ||
    (event !== null && !isModifierMatch(event, {}))
  ) {
    return false;
  }
  const adjacent = $getAdjacentNode(selection.focus, isBackward);
  if (!$isCardNode(adjacent)) {
    return false;
  }
  event?.preventDefault();
  const ns = $createNodeSelection();
  ns.add(adjacent.getKey());
  $setSelection(ns);
  return true;
}

// Walk up from `start` looking for a slot child whose host is a Card; report
// which named slot (or the body's regular children) the caret sits in.
// Returns `null` when the caret is not inside a CardNode at all. Used by the
// Tab handler — the first real consumer of `$getSlotNameWithinHost`, which
// answers "which named slot does this node sit in?" so an event-bubbling
// handler can establish relative order between slots and children.
function $findCardSlotContext(
  start: LexicalNode,
):
  | {card: CardNode; in: 'title'; slotValue: LexicalNode}
  | {card: CardNode; in: 'body'}
  | null {
  let cursor: LexicalNode | null = start;
  while (cursor !== null) {
    const slotName = $getSlotNameWithinHost(cursor);
    if (slotName === 'title') {
      const host = $getSlotHost(cursor);
      if ($isCardNode(host)) {
        return {card: host, in: 'title', slotValue: cursor};
      }
    }
    const parent: LexicalNode | null = cursor.getParent();
    if ($isCardNode(parent)) {
      return {card: parent, in: 'body'};
    }
    cursor = parent ?? $getSlotHost(cursor);
  }
  return null;
}

// True when `point` sits at the very end of `block`'s text content — the
// caret is on the block's last text child at the text length, or on an empty
// block at offset 0. Used by the Tab handler so it only fires at the slot's
// trailing edge and leaves Tab as a normal indent everywhere else.
function $isAtBlockEnd(point: PointType, block: LexicalNode): boolean {
  if (!$isElementNode(block)) {
    return false;
  }
  const last = block.getLastDescendant();
  if (last === null) {
    return point.key === block.getKey() && point.offset === 0;
  }
  if ($isTextNode(last)) {
    return (
      point.key === last.getKey() && point.offset === last.getTextContentSize()
    );
  }
  return false;
}

// Mirror of $isAtBlockEnd for the leading edge.
function $isAtBlockStart(point: PointType, block: LexicalNode): boolean {
  if (!$isElementNode(block)) {
    return false;
  }
  const first = block.getFirstDescendant();
  if (first === null) {
    return point.key === block.getKey() && point.offset === 0;
  }
  if ($isTextNode(first)) {
    return point.key === first.getKey() && point.offset === 0;
  }
  return false;
}

// Tab moves focus between the title slot and the body, but only at the slot
// boundary — Tab at the end of the title slot's last paragraph drops the
// caret at the start of the body, Shift+Tab at the start of the body's first
// paragraph drops it at the end of the title slot. Mid-title and mid-body
// Tab / Shift+Tab fall through to the rich-text indent default. This is a
// small PoC for the use case `$getSlotNameWithinHost` was introduced for: an
// event handler that needs to know which slot the caret came from so it can
// pick the right destination.
function $handleCardTab(
  event: KeyboardEvent | null,
  isBackward: boolean,
): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }
  const context = $findCardSlotContext(selection.anchor.getNode());
  if (context === null) {
    return false;
  }
  if (!isBackward && context.in === 'title') {
    // The slot value IS the caret block: the title is a bare single-line
    // paragraph (the slot link itself is the virtual shadow root, no
    // container wrapper). $isAtBlockEnd reads getLastDescendant, so the
    // check is anchored at the slot's trailing edge either way.
    const titleBlock = context.slotValue;
    if (
      !$isElementNode(titleBlock) ||
      !$isAtBlockEnd(selection.anchor, titleBlock)
    ) {
      return false;
    }
    const bodyFirst = context.card.getFirstChild();
    if ($isElementNode(bodyFirst)) {
      event?.preventDefault();
      bodyFirst.selectStart();
      return true;
    }
    // No element body to receive the caret: seed an empty paragraph and move
    // into it. Falling through here would hand Tab to the rich-text indent
    // default, which indents the title paragraph instead of bridging.
    event?.preventDefault();
    const bodyParagraph = $createParagraphNode();
    if (bodyFirst === null) {
      context.card.append(bodyParagraph);
    } else {
      bodyFirst.insertBefore(bodyParagraph);
    }
    bodyParagraph.select();
    return true;
  } else if (isBackward && context.in === 'body') {
    const bodyFirst = context.card.getFirstChild();
    if (bodyFirst === null || !$isAtBlockStart(selection.anchor, bodyFirst)) {
      return false;
    }
    // The title slot value is itself the caret block (a bare paragraph), so
    // the caret lands at its end directly — no container to descend into.
    const titleSlot = $getSlot(context.card, 'title');
    if ($isElementNode(titleSlot)) {
      event?.preventDefault();
      titleSlot.selectEnd();
      return true;
    }
  }
  return false;
}

// Reconstruct a CardNode from its exported HTML (see CardNode.exportDOM): the
// named title slot rides a `<div data-lexical-slot="title">` child and the body
// is regular paragraph siblings. Re-attach the title via $setSlot (flattened to
// a single-line bare paragraph) and append every other direct child as a
// regular Card child. Slots are intentionally NOT auto-imported (mirroring the
// export side and NodeState) — a host opts in with a rule.
const CardImportRule = defineImportRule({
  $import: (ctx, el) => {
    // Clear any seeded default body paragraph so imported children replace it.
    const card = $createCardNode().clear();
    // Reuse the seeded title paragraph (cleared) as the title slot value so a
    // source HTML without a title wrapper can never carry over fabricated
    // content; imported title content is appended into it below.
    const prevTitle = $getSlot(card, 'title');
    const title = $isParagraphNode(prevTitle)
      ? prevTitle.clear()
      : $createParagraphNode();
    $setSlot(card, 'title', title);
    for (const domChild of Array.from(el.children)) {
      const slotName = domChild.getAttribute('data-lexical-slot');
      if (slotName === 'title') {
        $appendInline(title, ctx.$importChildren(domChild));
      } else {
        card.splice(card.getChildrenSize(), 0, ctx.$importOne(domChild));
      }
    }
    return [card];
  },
  match: sel.tag('div').classAll('lexical-card-node'),
  name: '@lexical/playground/card',
});

export const CardExtension = defineExtension({
  dependencies: [
    // No ClickAfterLastBlockExtension override: CardNode.isShadowRoot() is
    // true, so `$defaultShouldInsertAfter` already matches a trailing Card
    // (see the CardNode unit test pinning this). An override here would also
    // clobber the app-level predicate — the extension's last-wins shallow
    // config merge drops every other contributor's terms.
    // Mirror the NodeSelection state onto a `data-selected` attribute on each
    // Card's host DOM so CSS can render the selected outline. The Card's
    // chrome is rendered through `decorate()`, but selecting the whole Card is
    // driven from the extension's CLICK_COMMAND below, so the attribute is set
    // here rather than via `useLexicalNodeSelection` inside the component.
    configExtension(NodeSelectionDataSelectedExtension, {
      nodes: [CardNode],
    }),
    // The Card renders its slots entirely in-lexical (no React chrome), so
    // it attaches the title synchronously through the render config:
    // returning the host DOM reveals the container in its default
    // slots-first position within the same commit that renders it — the
    // named-slot analog of $getDOMSlot.
    configExtension(DOMRenderExtension, {
      overrides: [
        domOverride([CardNode], {
          $getSlotTargetElement: (_node, _slotName, hostDom) => hostDom,
        }),
      ],
    }),
    // The Card's HTML import rule rides its own extension (like every other
    // node extension that registers its own DOM-import rules). CoreImport
    // supplies the paragraph/text rules the rule's children-import relies on
    // and orders this host rule ahead of the generic block rules.
    CoreImportExtension,
    configExtension(DOMImportExtension, {
      rules: [CardImportRule],
    }),
  ],
  name: '@lexical/playground/Card',
  register: editor => {
    return mergeRegister(
      editor.registerCommand(
        INSERT_CARD_COMMAND,
        () => {
          $insertSlotHostAtRoot($createCardNode());
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand(
        KEY_ARROW_RIGHT_COMMAND,
        event => $handleCardArrow(event, false),
        COMMAND_PRIORITY_BEFORE_EDITOR,
      ),
      editor.registerCommand(
        KEY_ARROW_LEFT_COMMAND,
        event => $handleCardArrow(event, true),
        COMMAND_PRIORITY_BEFORE_EDITOR,
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        event => $handleCardTab(event, event.shiftKey),
        COMMAND_PRIORITY_BEFORE_EDITOR,
      ),
      // Click on the Card chrome (outside its slot wrappers) selects the whole
      // Card as a NodeSelection, with a matching mousedown that suppresses the
      // native caret the browser would otherwise drop there.
      registerHostChromeSelection(editor, $isCardNode),
      // ArrowDown/Up at the Card's bottom/top edge steps out of it.
      registerSlotHostArrowEscape(editor, $isCardNode),
      // Backspace deletes an empty Card (from the start of its title slot or
      // the block right after it), and a select-all that spans a first-block
      // Card replaces the whole Card with a paragraph.
      registerSlotHostBackspace(editor, $isCardNode, $isSlotHostTextEmpty),
      // Mirror the caret's slot context onto a `data-current-slot` attribute
      // on the active Card so CSS can render a focus hint. The (cardKey,
      // slot) memo + read-scope-outside mutation mirror the
      // NodeSelectionDataSelectedExtension shape so this stays off the
      // every-keystroke hot path; the matching CSS sticks to border-color
      // and box-shadow (no `content` / `display` changes) to avoid any
      // layout reflow on the same frame as a forward-delete keystroke,
      // which would otherwise drop the keystroke in Firefox / WebKit.
      (() => {
        let prevCardKey: NodeKey | null = null;
        let prevSlot: 'title' | 'body' | null = null;
        return editor.registerUpdateListener(({editorState}) => {
          let activeCardKey: NodeKey | null = null;
          let activeSlot: 'title' | 'body' | null = null;
          editorState.read(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              const context = $findCardSlotContext(selection.anchor.getNode());
              if (context !== null) {
                activeCardKey = context.card.getKey();
                activeSlot = context.in;
              }
            }
          });
          if (prevCardKey === activeCardKey && prevSlot === activeSlot) {
            return;
          }
          if (prevCardKey !== null && prevCardKey !== activeCardKey) {
            const dom = editor.getElementByKey(prevCardKey);
            if (dom !== null) {
              dom.removeAttribute('data-current-slot');
            }
          }
          if (activeCardKey !== null && activeSlot !== null) {
            const dom = editor.getElementByKey(activeCardKey);
            if (dom !== null) {
              dom.setAttribute('data-current-slot', activeSlot);
            }
          }
          prevCardKey = activeCardKey;
          prevSlot = activeSlot;
        });
      })(),
    );
  },
});
