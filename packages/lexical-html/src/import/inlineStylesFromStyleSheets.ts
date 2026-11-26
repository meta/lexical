/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {DOMPreprocessFn} from './types';

import {objectKlassEquals} from '@lexical/utils';
import {isDOMDocumentNode, isHTMLElement} from 'lexical';

/**
 * Inlines CSS rules from `<style>` tags onto matching elements as inline
 * styles.
 *
 * Used by apps like Excel that generate HTML where styles live in
 * class-based `<style>` rules (e.g. `.xl65 { background: #FFFF00; color:
 * blue; }`) rather than inline styles. Since Lexical's import converters
 * read inline styles, we resolve stylesheet rules into inline styles
 * before conversion.
 *
 * Mutates the DOM in-place. Original inline styles always take
 * precedence over stylesheet rules (matching CSS specificity behavior).
 *
 * No-op for {@link ParentNode}s that are not {@link Document}s — only a
 * full document carries `styleSheets` we can iterate.
 */
export const $inlineStylesFromStyleSheets: DOMPreprocessFn = (
  dom,
  _ctx,
  $next,
) => {
  $inlineStylesFromStyleSheetsDOM(dom);
  $next();
};

export function $inlineStylesFromStyleSheetsDOM(
  dom: Document | ParentNode,
): void {
  if (!isDOMDocumentNode(dom)) {
    return;
  }
  const doc = dom;
  if (doc.querySelector('style') === null) {
    return;
  }

  const originalInlineStyles = new Map<HTMLElement, Set<string>>();

  function getOriginalInlineProps(el: HTMLElement): Set<string> {
    let props = originalInlineStyles.get(el);
    if (props === undefined) {
      props = new Set<string>();
      for (let i = 0; i < el.style.length; i++) {
        props.add(el.style[i]);
      }
      originalInlineStyles.set(el, props);
    }
    return props;
  }

  try {
    for (const sheet of Array.from(doc.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!objectKlassEquals(rule, CSSStyleRule)) {
          continue;
        }
        let elements: NodeListOf<Element>;
        try {
          elements = doc.querySelectorAll(rule.selectorText);
        } catch {
          continue;
        }
        for (const el of Array.from(elements)) {
          if (!isHTMLElement(el)) {
            continue;
          }
          const originalProps = getOriginalInlineProps(el);
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            if (!originalProps.has(prop)) {
              el.style.setProperty(
                prop,
                rule.style.getPropertyValue(prop),
                rule.style.getPropertyPriority(prop),
              );
            }
          }
        }
      }
    }
  } catch {
    // styleSheets API not supported in this environment
  }
}
