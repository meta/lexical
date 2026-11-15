/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

function getAriaLevel(element: Element): number | null {
  if (element.localName !== 'li') {
    return null;
  }
  const level = Number(element.getAttribute('aria-level'));
  return Number.isInteger(level) && level > 0 ? level : null;
}

/**
 * Google Docs writes a nested list as one flat list whose items carry their
 * depth in `aria-level` (`<li aria-level="2">`). This moves each run of
 * deeper items into a list of the same tag right after the item before it,
 * the list-inside-a-list shape the importers read as nesting, so an import
 * keeps the levels. A list whose items carry no `aria-level`, or all the
 * same one, is left as it is.
 *
 * @param list - The `<ul>` or `<ol>` to nest, in place.
 */
export function nestListItemsByAriaLevel(list: Element): void {
  const children = Array.from(list.children);
  let minLevel = Infinity;
  let maxLevel = -Infinity;
  for (const child of children) {
    const level = getAriaLevel(child);
    if (level !== null) {
      minLevel = Math.min(minLevel, level);
      maxLevel = Math.max(maxLevel, level);
    }
  }
  if (maxLevel <= minLevel) {
    return;
  }
  const stack: {level: number; list: Element}[] = [{level: minLevel, list}];
  for (const child of children) {
    const level = getAriaLevel(child);
    let top = stack[stack.length - 1];
    if (level !== null) {
      while (level < top.level && stack.length > 1) {
        stack.pop();
        top = stack[stack.length - 1];
      }
      if (level > top.level) {
        const nested = list.ownerDocument.createElement(list.localName);
        top.list.appendChild(nested);
        top = {level, list: nested};
        stack.push(top);
      }
    }
    top.list.appendChild(child);
  }
}
