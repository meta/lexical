/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {PropertiesHyphenFallback} from 'csstype';

import {
  CoreImportExtension,
  defineImportRule,
  DOMImportExtension,
  domOverride,
  DOMRenderExtension,
  sel,
} from '@lexical/html';
import {$forEachSelectedTextNode} from '@lexical/selection';
import {
  $caretRangeFromSelection,
  $getPreviousSelection,
  $getSelection,
  $getState,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  $setState,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  createState,
  defineExtension,
  getStyleObjectFromCSS,
  isHTMLElement,
  type LexicalNode,
  setDOMStyleObject,
  TextNode,
  type ValueOrUpdater,
} from 'lexical';

/**
 * Creates an object containing all the styles and their values provided in the CSS string.
 * @param css - The CSS string of styles and their values.
 * @returns The styleObject containing all the styles and their values.
 */
export function getStyleObjectFromRawCSS(css: string): StyleObject {
  const styleObject = getStyleObjectFromCSS(css);
  for (const _ in styleObject) {
    return styleObject as StyleObject;
  }
  return NO_STYLE;
}

export type Prettify<T> = {[K in keyof T]: T[K]} & {};

export type StyleObject = Prettify<{
  [K in keyof PropertiesHyphenFallback]?:
    | undefined
    // This is simplified to not deal with arrays or numbers.
    // This is an example after all!
    | Extract<PropertiesHyphenFallback[K], string>;
}>;

export type StyleTuple = Exclude<
  {
    [K in keyof StyleObject]: [K, null | Exclude<StyleObject[K], undefined>];
  }[keyof StyleObject],
  undefined
>;

export const NO_STYLE: StyleObject = Object.freeze({});

function parse(v: unknown): StyleObject {
  return typeof v === 'string' ? getStyleObjectFromRawCSS(v) : NO_STYLE;
}

function unparse(style: StyleObject): string {
  const styles: string[] = [];
  for (const [k, v] of Object.entries(style)) {
    if (k && v) {
      styles.push(`${k}: ${v};`);
    }
  }
  return styles.sort().join(' ');
}

function isEqualValue(
  a: StyleObject[keyof StyleObject],
  b: StyleObject[keyof StyleObject],
): boolean {
  return a === b || (!a && !b);
}

function isEqual(a: StyleObject, b: StyleObject): boolean {
  if (a === b) {
    return true;
  }
  for (const k in a) {
    if (
      !(
        k in b &&
        isEqualValue(a[k as keyof StyleObject], b[k as keyof StyleObject])
      )
    ) {
      return false;
    }
  }
  for (const k in b) {
    if (!(k in a)) {
      return false;
    }
  }
  return true;
}

export const styleState = createState('style', {
  isEqual,
  parse,
  unparse,
});

export function $getStyleProperty<Prop extends keyof StyleObject>(
  node: LexicalNode,
  prop: Prop,
): undefined | StyleObject[Prop] {
  return $getStyleObject(node)[prop];
}

// eslint-disable-next-line @lexical/rules-of-lexical
export function getStyleObjectDirect(node: LexicalNode): StyleObject {
  return $getState(node, styleState, 'direct');
}

export function $getStyleObject(node: LexicalNode): StyleObject {
  return $getState(node, styleState);
}

export function $setStyleObject<T extends LexicalNode>(
  node: T,
  valueOrUpdater: ValueOrUpdater<StyleObject>,
): T {
  return $setState(node, styleState, valueOrUpdater);
}

export function $removeStyleProperty<
  T extends LexicalNode,
  Prop extends keyof StyleObject,
>(node: T, prop: Prop): T {
  return $setStyleObject(node, prevStyle => {
    if (prop in prevStyle) {
      const {[prop]: _ignore, ...nextStyle} = prevStyle;
      return nextStyle;
    }
    return prevStyle;
  });
}

export function $setStyleProperty<
  T extends LexicalNode,
  Prop extends keyof StyleObject,
>(node: T, prop: Prop, value: ValueOrUpdater<StyleObject[Prop]>): T {
  return $setStyleObject(node, prevStyle => {
    const prevValue = prevStyle[prop];
    const nextValue = typeof value === 'function' ? value(prevValue) : value;
    return prevValue === nextValue
      ? prevStyle
      : {...prevStyle, [prop]: nextValue};
  });
}

export function diffStyleObjects(
  prevStyles: StyleObject,
  nextStyles: StyleObject,
): StyleObject {
  let styleDiff: undefined | Record<string, string | undefined>;
  if (prevStyles === NO_STYLE) {
    return nextStyles;
  }
  if (prevStyles !== nextStyles) {
    for (const k_ in nextStyles) {
      const k = k_ as keyof StyleObject;
      const nextV = nextStyles[k];
      const prevV = prevStyles[k];
      if (!isEqualValue(nextV, prevV)) {
        styleDiff = styleDiff || {};
        styleDiff[k] = nextV;
      }
    }
    for (const k in prevStyles) {
      if (!(k in nextStyles)) {
        styleDiff = styleDiff || {};
        styleDiff[k] = undefined;
      }
    }
  }
  return styleDiff || NO_STYLE;
}

export function mergeStyleObjects(
  prevStyles: StyleObject,
  nextStyles: StyleObject,
): StyleObject {
  return prevStyles === NO_STYLE || prevStyles === nextStyles
    ? nextStyles
    : {...prevStyles, ...nextStyles};
}

export function styleObjectToArray(styleObject: StyleObject): StyleTuple[] {
  const entries: StyleTuple[] = [];
  for (const k_ in styleObject) {
    const k = k_ as keyof StyleObject;
    entries.push([k, styleObject[k] ?? null] as StyleTuple);
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries;
}

export const PATCH_TEXT_STYLE_COMMAND = createCommand<
  StyleObject | ((prevStyles: StyleObject) => StyleObject)
>('PATCH_TEXT_STYLE_COMMAND');

function $nodeHasStyle(node: LexicalNode): boolean {
  return !isEqual(NO_STYLE, $getStyleObject(node));
}

export function $selectionHasStyle(): boolean {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    const caretRange = $caretRangeFromSelection(selection);
    for (const slice of caretRange.getTextSlices()) {
      if (slice && $nodeHasStyle(slice.caret.origin)) {
        return true;
      }
    }
    for (const caret of caretRange.iterNodeCarets('root')) {
      if ($isTextNode(caret.origin) && $nodeHasStyle(caret.origin)) {
        return true;
      }
    }
  }
  return false;
}

export function $patchSelectedTextStyle(
  styleObjectOrCallback:
    | StyleObject
    | ((prevStyles: StyleObject) => StyleObject),
): boolean {
  let selection = $getSelection();
  if (!selection) {
    const prevSelection = $getPreviousSelection();
    if (!prevSelection) {
      return false;
    }
    selection = prevSelection.clone();
    $setSelection(selection);
  }
  const styleCallback =
    typeof styleObjectOrCallback === 'function'
      ? styleObjectOrCallback
      : (prevStyles: StyleObject) =>
          mergeStyleObjects(prevStyles, styleObjectOrCallback);
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    const node = selection.focus.getNode();
    if ($isTextNode(node)) {
      $setStyleObject(node, styleCallback);
    }
  } else {
    $forEachSelectedTextNode(node => $setStyleObject(node, styleCallback));
  }
  return true;
}

const PREV_STYLE_STATE = Symbol.for('styleState');
interface HTMLElementWithManagedStyle extends HTMLElement {
  // Store the last reconciled style object directly on the DOM
  // so we don't have to track the previous DOM
  // which can happen even when nodeMutation is 'updated'
  [PREV_STYLE_STATE]?: StyleObject;
}

interface LexicalNodeWithUnknownStyle extends LexicalNode {
  // This property exists on all TextNode and ElementNode
  // and likely also some DecoratorNode by convention.
  // We use it as a heuristic to see if the style has likely
  // been overwritten to see if we should apply a diff
  // or all styles.
  __style?: unknown;
}

function styleStringChanged(
  node: LexicalNodeWithUnknownStyle,
  prevNode: LexicalNodeWithUnknownStyle,
): boolean {
  return typeof node.__style === 'string' && prevNode.__style !== node.__style;
}

function getPreviousStyleObject(
  node: LexicalNode,
  prevNode: null | LexicalNode,
  dom: HTMLElementWithManagedStyle,
): StyleObject {
  const prevStyleObject = dom[PREV_STYLE_STATE];
  return prevStyleObject && prevNode && !styleStringChanged(node, prevNode)
    ? prevStyleObject
    : NO_STYLE;
}

const IGNORE_STYLES: Set<keyof StyleObject> = new Set([
  'font-weight',
  'text-decoration',
  'font-style',
  'vertical-align',
]);

export type StyleMapping = (input: StyleObject) => StyleObject;

/**
 * Extract the styles to import — i.e. every CSS property other than the
 * ones already handled by the core inline-format rule
 * ({@link IGNORE_STYLES}).
 */
function extractExtraStyles(el: HTMLElement): StyleObject | null {
  let extra: undefined | Record<string, string>;
  for (const k of el.style) {
    if (IGNORE_STYLES.has(k as keyof StyleObject)) {
      continue;
    }
    extra = extra || {};
    extra[k] = el.style.getPropertyValue(k);
  }
  return extra ? (extra as StyleObject) : null;
}

/**
 * Build a wildcard import rule that decorates every TextNode produced by
 * a styled element with the element's "extra" styles (those not already
 * handled by the core inline-format rule).
 *
 * This is the {@link DOMImportExtension}-native replacement for the
 * legacy `constructStyleImportMap` workaround that wrapped every TextNode
 * importer in turn.
 *
 * @__NO_SIDE_EFFECTS__
 */
export function createStyleImportRule(
  styleMapping: StyleMapping = input => input,
) {
  return defineImportRule({
    $import: (_ctx, el, $next) => {
      const extra = el.hasAttribute('style') ? extractExtraStyles(el) : null;
      const out = $next();
      if (extra) {
        const mapped = styleMapping(extra);
        for (const child of out) {
          if ($isTextNode(child)) {
            $setStyleObject(child, prev => mergeStyleObjects(prev, mapped));
          }
        }
      }
      return out;
    },
    // Match every styled element — the per-element refinement happens in
    // the body (only TextNodes produced by `$next()` get styled, and we
    // skip ignored properties). The wildcard sits at the lowest priority
    // (registered last in the rules array below) so per-tag rules from
    // CoreImportExtension still drive node creation.
    match: sel.any().attr('style', /\S/),
    name: '@lexical/examples/node-state-style/style',
  });
}

export const StyleStateExtension = defineExtension({
  dependencies: [
    // New-pipeline import: register the style-capturing wildcard rule via
    // DOMImportExtension. Replaces the legacy `html: {import: ...}` field
    // that used `constructStyleImportMap`.
    CoreImportExtension,
    configExtension(DOMImportExtension, {
      rules: [createStyleImportRule()],
    }),
    configExtension(DOMRenderExtension, {
      overrides: [
        // Remove pre-wrap from TextNode export when not needed, and
        // strip any resulting empty `style=""` attributes (which can be
        // left behind by `el.style.removeProperty(...)` in some browsers
        // / JSDOM, or added incidentally by an upstream `el.style.foo = …`
        // followed by another override that clears that property).
        domOverride([TextNode], {
          $exportDOM(_node, $next) {
            const result = $next();
            if (isHTMLElement(result.element)) {
              const textContent = result.element.textContent || '';
              // We know there aren't tabs or newlines, but if there are
              // leading, trailing, or adjacent spaces we need pre-wrap to
              // preserve them.
              const needsPreWrap = /^\s|\s$|\s\s/.test(textContent);
              for (const el of [
                result.element,
                ...result.element.querySelectorAll('*'),
              ]) {
                if (!isHTMLElement(el)) {
                  continue;
                }
                if (!needsPreWrap && el.style.whiteSpace === 'pre-wrap') {
                  el.style.removeProperty('white-space');
                }
                // Strip an empty `style` attribute regardless of how it
                // got there — `removeProperty` above can leave the
                // attribute as `style=""`, and so can any earlier
                // override that cleared its only set property.
                const styleAttr = el.getAttribute('style');
                if (styleAttr !== null && styleAttr.trim() === '') {
                  el.removeAttribute('style');
                }
              }
            }
            return result;
          },
        }),
        domOverride('*', {
          $decorateDOM(nextNode, prevNode, dom) {
            const managedDOM: HTMLElementWithManagedStyle = dom;
            const nextStyleObject = $getStyleObject(nextNode);
            const diffStyleObject = diffStyleObjects(
              getPreviousStyleObject(nextNode, prevNode, dom),
              nextStyleObject,
            );
            managedDOM[PREV_STYLE_STATE] = nextStyleObject;
            if (diffStyleObject !== NO_STYLE) {
              setDOMStyleObject(dom.style, diffStyleObject);
            }
          },
          $exportDOM(node, $next) {
            const output = $next();
            const style = $getStyleObject(node);
            if (output.element && style !== NO_STYLE) {
              if (output.after) {
                return {
                  ...output,
                  after: generatedElement => {
                    const el = output.after
                      ? output.after(generatedElement)
                      : generatedElement;
                    if (isHTMLElement(el)) {
                      setDOMStyleObject(el.style, style);
                    }
                    return el;
                  },
                };
              } else if (isHTMLElement(output.element)) {
                setDOMStyleObject(output.element.style, style);
              }
            }
            return output;
          },
        }),
      ],
    }),
  ],
  name: '@lexical/examples/node-state-style/StyleState',
  register: editor =>
    editor.registerCommand(
      PATCH_TEXT_STYLE_COMMAND,
      $patchSelectedTextStyle,
      COMMAND_PRIORITY_EDITOR,
    ),
});
