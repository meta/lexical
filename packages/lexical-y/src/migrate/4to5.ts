/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @lexical/y/migrate/4to5: the frozen step from layout 4 to layout 5 (a
// shadow-root instance of a line class at a block position stored as a
// container of blocks). EXPERIMENTAL. FROZEN: a change to what it writes
// bumps `revision` and adds golden fixtures; the existing ones are never
// regenerated. It takes no parameters: for fixed input bytes it writes
// fixed output bytes. It imports `@y/y` and frozen sources only.
//
// A whole-root step (step contract 2): moving a quote's paragraphs out of
// its line and into a sequence of its own writes new items (a Yjs item
// cannot change its parent), which a per-container step (contract 1) may
// not do. For each line whose marker holds `s:shadowRoot` = true and no
// `g` (see ./4to5/frozen/restructure), in every container of the root:
// - the line becomes a `b:<type>` node with `c` = 'b' and the marker's
//   attributes (its fields, NodeState and block id; not `t`, which the
//   node's name carries), in the line's place;
// - each block of its inline content stored as a line class's node
//   becomes a line of the new node: its text and inline nodes, then a
//   marker with the node's attributes (its type as `t`, left out for a
//   paragraph; not `c`);
// - every other block node is copied whole into it as a `b:` node;
// - each run of inline content no block holds becomes a line, its marker
//   holding no attributes;
// - covered formats are written in the canonical layout 4 form per new
//   container, reproducing what each unit read; other format items keep
//   their place;
// - the old line's items are deleted.
// Where the root stores a block id anywhere (`s:blockId`), a line the step
// makes stores the id a reader derived for it, so every block keeps its id:
// a run's from its first unit, a node that stored none from its item (`y`,
// client, `_`, clock, in base 36). Every other container is untouched; a
// root without such a line gets only its layout record and epoch.
//
// Equality: readBefore reads the root as layout 4 stored it, with each such
// line read as the container layout 5 stores; readAfter reads the result.
// Both give one string per block: its kind, attributes and content (each
// unit with its covered values, a node with what it holds).

import type {YLayoutRootMigration} from '../internal/Runner';

import {type Node as YNode, type Transaction} from '@y/y';

import {
  describe,
  isShadowLine,
  restructure,
  storesBlockIds,
} from './4to5/frozen/restructure';

function readBefore(root: YNode): string[] {
  const out: string[] = [];
  describe(root, out, {ids: storesBlockIds(root), root});
  return out;
}

function readAfter(root: YNode): string[] {
  const out: string[] = [];
  describe(root, out, null);
  return out;
}

/** Layout 5's invariant: no line under the root is such a quote. */
function checkAfter(root: YNode): string[] {
  const problems: string[] = [];
  const visit = (node: YNode, where: string) => {
    for (let it = node._start; it !== null; it = it.right) {
      if (it.deleted || !it.countable) {
        continue;
      }
      if (isShadowLine(it)) {
        problems.push(
          `a line in ${where} holds blocks (${it.id.client}.${it.id.clock})`,
        );
      }
      const type = (it.content as {type?: unknown}).type;
      if (type instanceof Object && (type as YNode).name !== null) {
        visit(type as YNode, `${where}/${(type as YNode).name}`);
      }
    }
    const attrs = node.getAttrs() as Record<string, unknown>;
    for (const key of Object.keys(attrs).sort()) {
      const value = attrs[key];
      if (key.startsWith('slot:') && value instanceof Object) {
        visit(value as YNode, `${where}/${key}`);
      }
    }
  };
  visit(root, 'root');
  return problems;
}

const step4to5: YLayoutRootMigration = {
  checkAfter,
  from: 4,
  id: 'lexical-y/layout/4to5',
  migrateRoot(tr: Transaction, root: YNode): {written: number} {
    return {written: restructure(tr, root, root, storesBlockIds(root))};
  },
  readAfter,
  readBefore,
  revision: 1,
  to: 5,
  v: 2,
};

export default step4to5;
