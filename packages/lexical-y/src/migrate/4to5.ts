/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @lexical/y/migrate/4to5: the frozen step from layout 4 to layout 5 (a
// quote that holds paragraphs, QuoteNode's per-instance flat `shadowRoot`
// state, at a block position stored as a container of blocks). EXPERIMENTAL. FROZEN: a change to what it writes
// bumps `revision` and adds golden fixtures; the existing ones are never
// regenerated. It takes no parameters: for fixed input bytes it writes
// fixed output bytes. It imports `@y/y` and frozen sources only.
//
// A whole-root step (step contract 2): moving a quote's paragraphs out of
// its line and into a sequence of its own writes new items (a Yjs item
// cannot change its parent), which a per-container step (contract 1) may
// not do. For each line whose marker holds `t` = 'quote' and `s:shadowRoot`
// = true (group keys or not; see ./4to5/frozen/restructure), in every
// container and named slot of the root (every other line stays a line, as
// layout 5 stores it):
// - the line becomes a `b:quote` node with `c` = 'b' in the line's place,
//   with the marker's attributes but `t` (the node's name carries the
//   type) and group keys, the shadow root flag stored where a node stores it
//   (`p:shadowRoot`, a flat NodeState is a field of a node);
// - each block of its inline content stored as a line class's node that
//   does not hold blocks becomes a line of the new node: its text and
//   inline nodes, then a marker with the node's attributes (its type as
//   `t`, left out for a paragraph; not `c`);
// - every other block node is copied whole into it as a `b:` node: a
//   decorator, a table, a list stored as a node, and a quote that holds
//   paragraphs stored as a node (`c` = 'b'; a quote in a quote), whose
//   lines keep their markers;
// - each run of inline content no block holds becomes a line;
// - covered formats are written in the canonical layout 4 form per new
//   container, reproducing what each unit read; other format items keep
//   their place;
// - the old line's items are deleted.
// A line of this kind inside a node (a quote in a quote's quote, a quote in
// a table cell) is rewritten in place first, so a copy holds its result.
// Where the root stores a block id anywhere (`s:blockId`), the step first
// computes the id every block shows, by the readers' rule in document order
// (shownIds: a block shows its stored id unless a block before it shows it,
// else the id derived from its own item, else that id followed by `_d`s; in
// a named slot its stored id or the derived one, outside that order), and
// every block it writes anew that shows an id stores it: the quote where it
// is a block of the root, every line it makes, and in what it copies every
// line, every node that holds no blocks, every line written inside a line,
// and content no marker ends in a node that holds blocks and is not a group
// (which gets a marker storing the id). Which blocks show an id follows
// BlockIdExtension's default `$isIdentifiedBlock`. Every other container is
// untouched; a root without such a line gets only its layout record and
// epoch.
//
// Equality: readBefore reads the root as layout 4 stored it, with each such
// line read as the container layout 5 stores and every block the step writes
// anew with the id it showed; readAfter reads the result. Both give one
// string per block: its kind, attributes (block ids included) and content
// (text in runs of equal covered values, a node with what it holds), then a
// structural read written apart from describe and the writer (see
// segments): every block's type, attributes and stored id (where no block
// before it stores the same one and it has no derived id's shape), its text
// with the formats and NodeState the layout 4 reader reads on it (not
// through what describe and the writer share), and every paragraph a reader
// shows, empty ones included. Its only rule shared with the step is how a
// layout 4 quote's marker reads, so a wrong rule shared by the writer and
// describe (a lost line, type, attribute, stored id, format or NodeState, a
// lost break) still differs there. Where the root stores a block id, it
// ends with the id every block shows, computed apart from shownIds and the
// writer (see idsShown), so a changed id, derived or stored, differs too.

import type {YLayoutRootMigration} from '../internal/Runner';

import {type Node as YNode, type Transaction} from '@y/y';

import {
  describe,
  isShadowLine,
  restructure,
  segments,
  shownIds,
  storesBlockIds,
} from './4to5/frozen/restructure';

/** The root's structural read (see segments). */
function segmentsOf(root: YNode): string {
  const out: string[] = [];
  segments(root, out, root);
  return 'segments|' + out.join(',');
}

function readBefore(root: YNode): string[] {
  const out: string[] = [];
  describe(root, out, {
    copying: false,
    root,
    shown: storesBlockIds(root) ? shownIds(root) : null,
  });
  out.push(segmentsOf(root));
  return out;
}

function readAfter(root: YNode): string[] {
  const out: string[] = [];
  describe(root, out, null);
  out.push(segmentsOf(root));
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
      // A node's field on a marker: a node that held blocks read as a line.
      const marker = (it.content as {type?: unknown}).type;
      if (
        marker instanceof Object &&
        (marker as YNode).name === '\u00b6' &&
        (marker as YNode).getAttr('p:shadowRoot') !== undefined
      ) {
        problems.push(
          `a line in ${where} carries a container's shadow root (${it.id.client}.${it.id.clock})`,
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
    const shown = storesBlockIds(root) ? shownIds(root) : null;
    return {written: restructure(tr, root, root, shown)};
  },
  readAfter,
  readBefore,
  revision: 1,
  to: 5,
  v: 2,
};

export default step4to5;
