/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$isCodeNode} from '@lexical/code-core';
import {effect, namedSignals} from '@lexical/extension';
import {
  $setRenderContextValue,
  createRenderState,
  domOverride,
  type DOMOverrideOptions,
  DOMRenderExtension,
} from '@lexical/html';
import {ListItemNode} from '@lexical/list';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {$canShowPlaceholder} from '@lexical/text';
import {
  $findMatchingParent,
  $getDocument,
  $isTabNode,
  configExtension,
  defineExtension,
  type ElementNode,
  getStyleObjectFromCSS,
  isHTMLElement,
  LineBreakNode,
  mergeRegister,
  ParagraphNode,
  safeCast,
  TabNode,
  TextNode,
} from 'lexical';

/**
 * Surfaces a visible marker for each non-printing character in the editor.
 * Currently covers:
 * - `LineBreakNode` (`↵`) — wraps each `<br>` in a `<span>` carrying the
 *   marker, and exposes the inner `<br>` through `$getDOMSlot` so selection /
 *   caret logic targets the canonical content element.
 * - `ParagraphNode` / `HeadingNode` / `ListItemNode` / `QuoteNode` (`¶`) —
 *   shared `data-lexical-visible-non-printing-block` attribute on the block's
 *   DOM, visual rendered via CSS `::after`. The marker is `position: absolute`
 *   and `:has(> br:last-child)` snaps it to `bottom: 0` so a trailing
 *   placeholder `<br>` (added by `$reconcileElementTerminatingLineBreak` when
 *   Shift+Enter ends the block) shares the empty line instead of bumping the
 *   marker onto a new one. The direct-child selector keeps a wrapped
 *   `LineBreakNode`'s inner `<br>` from accidentally matching.
 * - `TabNode` (`→`) — `data-` attribute marker rendered via CSS `::before`,
 *   centered with `position: absolute; transform: translate(-50%, -50%)` so the
 *   arrow sits in the middle of the tab whitespace rather than at the left
 *   edge. Indent applied via `INDENT_CONTENT_COMMAND` (Tab on a block-start
 *   caret) does not create a `TabNode` and is therefore not marked, matching
 *   Word's "Show formatting marks" behaviour where indent and literal tabs are
 *   distinct.
 * - Space (` `, U+0020) (`·`) — an inline WOFF2 with `unicode-range: U+0020`
 *   remaps only the space glyph to a middle-dot shape, gated by the editor
 *   root's `data-lexical-visible-non-printing-active` attribute. A
 *   `TextNode` `$createDOM` / `$updateDOM` override prepends our font in
 *   front of any inline `style="font-family"` so the toolbar font-family
 *   selector can't strip the marker via specificity. Zero text-content
 *   mutation, so IME composition, selection, and caret behaviour stay
 *   intact.
 *
 * Demonstrates the extension-driven path for leaf and block node categories:
 * no subclassing required, behaviour attaches via `DOMRenderExtension`
 * configuration.
 *
 * `disabled` toggles the markers at runtime without recreating the editor.
 * The overrides are installed conditionally via `disabledForEditor`, so when
 * disabled they are removed from the render pipeline entirely rather than
 * no-oping per node. Flipping the signal mirrors it into the editor render
 * context with `$setRenderContextValue`, which recompiles the render config
 * and recreates the existing DOM through the new config. The empty-root
 * listener is registered inside the `effect` callback so it tears down when
 * the extension is disabled instead of running forever.
 */
const VISIBLE_NON_PRINTING_LINEBREAK_ATTR =
  'data-lexical-visible-non-printing-linebreak';
const VISIBLE_NON_PRINTING_BLOCK_ATTR =
  'data-lexical-visible-non-printing-block';
const VISIBLE_NON_PRINTING_EMPTY_ROOT_ATTR =
  'data-lexical-visible-non-printing-empty-root';
const VISIBLE_NON_PRINTING_ACTIVE_ATTR =
  'data-lexical-visible-non-printing-active';
const VISIBLE_NON_PRINTING_TAB_ATTR = 'data-lexical-visible-non-printing-tab';

export interface VisibleNonPrintingConfig {
  disabled: boolean;
}

/**
 * Editor render context state mirroring the extension's `disabled` signal.
 */
export const VisibleNonPrintingDisabled = createRenderState(
  'visibleNonPrintingDisabled',
  () => false,
);

function $skipForCodeChild(node: LineBreakNode): boolean {
  // Code blocks convey line structure visually — skip the visible
  // linebreak wrap anywhere inside a `CodeNode`.
  return $findMatchingParent(node, $isCodeNode) !== null;
}

function hasOurWrap(dom: HTMLElement): boolean {
  return (
    dom.tagName === 'SPAN' &&
    dom.hasAttribute(VISIBLE_NON_PRINTING_LINEBREAK_ATTR)
  );
}

const LEXICAL_SPACE_DOT_FONT = "'LexicalSpaceDot'";

const disabledForEditor = {
  disabledForEditor: ctx => ctx.get(VisibleNonPrintingDisabled),
} satisfies DOMOverrideOptions;

export const VisibleNonPrintingExtension = defineExtension({
  build: (editor, config) => namedSignals(config),
  config: safeCast<VisibleNonPrintingConfig>({disabled: false}),
  dependencies: [
    configExtension(DOMRenderExtension, {
      overrides: [
        domOverride(
          [LineBreakNode],
          {
            $createDOM: (node, $next) => {
              const inner = $next();
              if ($skipForCodeChild(node)) {
                return inner;
              }
              const wrapper = $getDocument().createElement('span');
              wrapper.setAttribute(VISIBLE_NON_PRINTING_LINEBREAK_ATTR, 'true');
              wrapper.appendChild(inner);
              return wrapper;
            },
            $getDOMSlot: (_node, dom, $next) => {
              const br = dom.querySelector(':scope > br');
              return isHTMLElement(br) ? $next().withElement(br) : $next();
            },
            $updateDOM: (node, _prev, dom, $next) => {
              const wantsWrap = !$skipForCodeChild(node);
              if (wantsWrap !== hasOurWrap(dom)) {
                return true;
              }
              return $next();
            },
          },
          disabledForEditor,
        ),
        domOverride<ElementNode>(
          [ParagraphNode, HeadingNode, ListItemNode, QuoteNode],
          {
            $decorateDOM: (node, _prevNode, dom) => {
              dom.setAttribute(VISIBLE_NON_PRINTING_BLOCK_ATTR, 'true');
              const nextTextStyle = getStyleObjectFromCSS(node.__textStyle);
              for (const prop of ['font-size', 'font-weight', 'font-family']) {
                dom.style.setProperty(
                  `--text-${prop}`,
                  nextTextStyle[prop] || null,
                );
              }
            },
          },
          disabledForEditor,
        ),
        domOverride(
          [TextNode, TabNode],
          {
            $decorateDOM: (node, _prev, dom) => {
              // TabNode descends from TextNode so we are going to hit this case either way
              if ($isTabNode(node)) {
                dom.setAttribute(VISIBLE_NON_PRINTING_TAB_ATTR, 'true');
                return;
              }
              // Prepend our space-dot font in front of any inline `font-family` set on a
              // TextNode's span (e.g. by the playground's font-family toolbar). The root
              // rule's `font-family` stack already covers spans without an inline style;
              // the inline one wins specificity, so we have to apply the override at the
              // node level. `unicode-range: U+0020` still scopes the substitution to the
              // space glyph alone, so the user's chosen face renders every other glyph.
              const inline =
                dom.style.fontFamily ||
                getStyleObjectFromCSS(node.__style)['font-family'] ||
                'var(--font-family)';
              if (inline.startsWith(LEXICAL_SPACE_DOT_FONT)) {
                return;
              }
              dom.style.fontFamily = `${LEXICAL_SPACE_DOT_FONT}, ${inline}`;
            },
          },
          disabledForEditor,
        ),
      ],
    }),
  ],
  name: '@lexical/playground/visible-non-printing',
  register: (editor, _config, state) => {
    const stores = state.getOutput();
    return effect(() => {
      const isDisabled = stores.disabled.value;
      $setRenderContextValue(VisibleNonPrintingDisabled, isDisabled, editor);
      if (isDisabled) {
        return;
      }
      return editor.registerRootListener(nextRoot => {
        if (nextRoot === null) {
          return;
        }
        nextRoot.setAttribute(VISIBLE_NON_PRINTING_ACTIVE_ATTR, 'true');
        const syncEmptyRootAttr = () => {
          const showPlaceholder = editor.read('latest', () =>
            $canShowPlaceholder(editor.isComposing()),
          );
          nextRoot.toggleAttribute(
            VISIBLE_NON_PRINTING_EMPTY_ROOT_ATTR,
            showPlaceholder,
          );
        };
        syncEmptyRootAttr();
        // mergeRegister tears down in LIFO order: the attribute removal runs
        // before the update listener unregister, so `syncEmptyRootAttr` can't
        // refire on a half-cleaned root between the two cleanups.
        return mergeRegister(
          editor.registerUpdateListener(syncEmptyRootAttr),
          () => {
            nextRoot.removeAttribute(VISIBLE_NON_PRINTING_ACTIVE_ATTR);
            nextRoot.removeAttribute(VISIBLE_NON_PRINTING_EMPTY_ROOT_ATTR);
          },
        );
      });
    });
  },
});
