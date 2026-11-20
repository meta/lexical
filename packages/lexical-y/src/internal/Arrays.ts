/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ElementNode, LexicalNode} from 'lexical';

// Content can be as long as a user makes it (a pasted book, one text node
// with 300,000 line feeds), and the number of arguments a call can take is
// bounded (a RangeError past about 100,000 on V8): lists of content are
// never spread into a call's arguments whole.

/** The most arguments a call made here is given at once. */
export const ARGUMENTS_CHUNK = 8192;

/** `array.push(...items)`, for any number of items. */
export function pushAll<T>(array: T[], items: Iterable<T>): void {
  for (const item of items) {
    array.push(item);
  }
}

/** `array.splice(start, deleteCount, ...items)` in place, for any number of items. */
export function spliceAll<T>(
  array: T[],
  start: number,
  deleteCount: number,
  items: readonly T[],
): void {
  if (items.length <= ARGUMENTS_CHUNK) {
    array.splice(start, deleteCount, ...items);
    return;
  }
  const tail = array.splice(start);
  pushAll(array, items);
  for (let i = deleteCount; i < tail.length; i++) {
    array.push(tail[i]);
  }
}

/**
 * `parent.append(...nodes)`, for any number of nodes: in pieces, each through
 * the class's own `append`.
 */
export function $appendAll(
  parent: ElementNode,
  nodes: readonly LexicalNode[],
): void {
  for (let i = 0; i < nodes.length; i += ARGUMENTS_CHUNK) {
    parent.append(...nodes.slice(i, i + ARGUMENTS_CHUNK));
  }
}
