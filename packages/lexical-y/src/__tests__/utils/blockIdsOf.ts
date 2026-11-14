/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/** Every block's type and id (`$.blockId`, as shown), in document order. */
export function blockIdsOf(read: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown, at: string) => {
    if (node === null || typeof node !== 'object') {
      return;
    }
    const n = node as {
      type?: string;
      $?: {blockId?: string};
      children?: unknown[];
      root?: unknown;
    };
    if (n.root !== undefined) {
      walk(n.root, '');
      return;
    }
    if (Array.isArray(n.children)) {
      out.push(`${at} ${n.type} ${n.$?.blockId ?? '-'}`);
      n.children.forEach((c, i) => walk(c, `${at}/${i}`));
    } else if (n.type !== undefined && n.type !== 'text') {
      out.push(`${at} ${n.type} ${n.$?.blockId ?? '-'}`);
    }
  };
  walk((read as {json?: unknown}).json ?? read, '');
  return out;
}
