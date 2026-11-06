/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {effect, namedSignals, untracked} from '@lexical/extension';
import {
  $getRenderContextValue,
  $setRenderContextValue,
  createRenderState,
  domOverride,
  type DOMOverrideOptions,
  DOMRenderExtension,
  RenderContextExport,
} from '@lexical/html';
import {
  $getDocument,
  configExtension,
  defineExtension,
  isHTMLElement,
  type LexicalNode,
  LineBreakNode,
  safeCast,
} from 'lexical';

import {CodeExtension} from './CodeExtension';
import {$isCodeNode, CodeNode} from './CodeNode';

export interface CodeLineNumbersConfig {
  /**
   * When `true` the extension renders nothing, so code blocks have exactly
   * the DOM they have without it. Can be flipped at runtime through the
   * `disabled` output signal.
   */
  disabled: boolean;
  /**
   * When `true`, only code blocks with word wrap on
   * ({@link CodeNode.getWordWrap}) get the line number markup. Other blocks
   * render exactly as they do without the extension, so a theme can keep
   * numbering them with `data-gutter`, which can't follow wrapped rows.
   * Can be flipped at runtime through the `onlyWordWrapped` output signal.
   */
  onlyWordWrapped: boolean;
}

/** Set on the DOM of every CodeNode that has the line number markup. */
const CODE_LINE_NUMBERS_ATTR = 'data-lexical-code-line-numbers';
/** Set on the `<span>` wrapped around the `<br>` of a code LineBreakNode. */
const CODE_LINE_BREAK_ATTR = 'data-lexical-code-line-break';

type CodeLineNumbersMode = 'off' | 'all' | 'wordWrapped';

/** Editor render context state mirroring the extension's signals. */
const CodeLineNumbersModeState = createRenderState<CodeLineNumbersMode>(
  'codeLineNumbersMode',
  () => 'all',
);

function isLineBreakWrapper(dom: HTMLElement): boolean {
  return dom.hasAttribute(CODE_LINE_BREAK_ATTR);
}

function $hasLineNumbers(
  node: LexicalNode | null,
  mode: 'all' | 'wordWrapped',
): boolean {
  return $isCodeNode(node) && (mode === 'all' || node.getWordWrap());
}

/**
 * One set of overrides per mode. Exactly one set is installed at a time, so
 * a mode change swaps the sets, and the render runtime recompiles and
 * recreates the affected nodes without marking any node dirty.
 */
function lineNumberOverrides(mode: 'all' | 'wordWrapped') {
  const options = {
    disabledForEditor: ctx => ctx.get(CodeLineNumbersModeState) !== mode,
  } satisfies DOMOverrideOptions;
  return [
    domOverride(
      [LineBreakNode],
      {
        $createDOM: (node, $next) => {
          const dom = $next();
          if (
            !$hasLineNumbers(node.getParent(), mode) ||
            // The default exportDOM builds its element with $createDOM, so
            // HTML export and the clipboard come through here too. They get
            // the plain <br>, and overrides composed after this one change
            // that <br> rather than the wrapper.
            $getRenderContextValue(RenderContextExport)
          ) {
            return dom;
          }
          const wrapper = $getDocument().createElement('span');
          wrapper.setAttribute(CODE_LINE_BREAK_ATTR, 'true');
          wrapper.appendChild(dom);
          return wrapper;
        },
        $getDOMSlot: (_node, dom, $next) => {
          const slot = $next();
          const inner = dom.firstElementChild;
          return isLineBreakWrapper(dom) &&
            slot.element === dom &&
            isHTMLElement(inner)
            ? slot.withElement(inner)
            : slot;
        },
        $updateDOM: (node, _prevNode, dom, $next) => {
          const isWrapped = isLineBreakWrapper(dom);
          if (
            // Moved into or out of a numbered code block (e.g.
            // collapseAtStart or $setBlocksType), the reconciler reuses the
            // DOM.
            isWrapped !== $hasLineNumbers(node.getParent(), mode) ||
            // The browser removed the <br>; the mutation observer only
            // marks the node dirty, so recreate it here.
            (isWrapped && dom.firstElementChild === null)
          ) {
            return true;
          }
          return $next();
        },
      },
      options,
    ),
    domOverride(
      [CodeNode],
      {
        $createDOM: (node, $next) => {
          const dom = $next();
          if ($hasLineNumbers(node, mode)) {
            dom.setAttribute(CODE_LINE_NUMBERS_ATTR, 'true');
          }
          return dom;
        },
        // With onlyWordWrapped, turning word wrap on or off adds or removes
        // the wrapper of every line break. Those LineBreakNodes aren't
        // dirty, so the whole block is recreated. CodeNode.updateDOM itself
        // never recreates.
        $updateDOM: (node, _prevNode, dom, $next) =>
          dom.hasAttribute(CODE_LINE_NUMBERS_ATTR) !==
            $hasLineNumbers(node, mode) || $next(),
      },
      options,
    ),
  ];
}

/**
 * The overrides for both modes. A spread at module scope would count as a
 * side effect and keep the extension in bundles that don't use it, so the
 * array is built here.
 *
 * @__NO_SIDE_EFFECTS__
 */
function allLineNumberOverrides() {
  return [...lineNumberOverrides('all'), ...lineNumberOverrides('wordWrapped')];
}

/**
 * @experimental
 *
 * Marks where each logical line of a code block starts, so a theme can
 * number the lines with a CSS counter instead of the `data-gutter`
 * attribute: line 1 on the code element, and each later line on the
 * wrapper of the line break before it. The numbers stay in step with the
 * lines when a line wraps, and no text is added to the DOM, so copy, find
 * and IME are unaffected.
 *
 * While enabled:
 * - the DOM of every `CodeNode` gets `data-lexical-code-line-numbers`, where
 *   a theme resets the counter and draws line 1 in `::before`.
 * - the `<br>` of each `LineBreakNode` that is a child of a `CodeNode` is
 *   wrapped in `<span data-lexical-code-line-break>`, whose `::after` draws
 *   the number of the line that starts after it. That includes empty lines,
 *   which a pseudo element on the `<br>` itself can't style.
 *
 * The wrapper is the keyed DOM of the `LineBreakNode` and the inner `<br>`
 * is exposed through `$getDOMSlot`, so a DOM selection inside the wrapper
 * resolves to a point just before or just after the `LineBreakNode`. The
 * default `exportDOM` of a `LineBreakNode` builds its element with the same
 * `$createDOM` overrides, so the override skips the wrapper while
 * `RenderContextExport` is set. HTML export and the clipboard get the same
 * HTML as without the extension, including what other `$createDOM`
 * overrides do to the `<br>`.
 *
 * When `disabled`, the overrides are left out of the render pipeline and
 * code blocks render exactly as they do without the extension. Toggling it
 * renders the existing code blocks again, without recreating the editor.
 *
 * With `onlyWordWrapped`, only code blocks with word wrap on
 * ({@link CodeNode.setWordWrap}) get this DOM, and the other blocks render
 * as they do without the extension. Turning word wrap on or off for a block
 * then recreates that block's DOM.
 *
 * The `data-gutter` attribute written by the highlighter extensions is not
 * touched, so a theme that draws it in the code element's `::before` has
 * to restyle that pseudo element under `[data-lexical-code-line-numbers]`,
 * where it draws line 1's number instead. See the `@lexical/code-core`
 * README for a CSS recipe.
 */
export const CodeLineNumbersExtension = defineExtension({
  build: (editor, config) => namedSignals(config),
  config: safeCast<CodeLineNumbersConfig>({
    disabled: false,
    onlyWordWrapped: false,
  }),
  dependencies: [
    CodeExtension,
    configExtension(DOMRenderExtension, {
      overrides: allLineNumberOverrides(),
    }),
  ],
  name: '@lexical/code-line-numbers',
  register: (editor, _config, state) => {
    const {disabled, onlyWordWrapped} = state.getOutput();
    return effect(() => {
      const mode = disabled.value
        ? 'off'
        : onlyWordWrapped.value
          ? 'wordWrapped'
          : 'all';
      // A mode change re-renders the editor synchronously. Don't let the
      // signals that render reads become dependencies of this effect.
      untracked(() =>
        $setRenderContextValue(CodeLineNumbersModeState, mode, editor),
      );
    });
  },
});
