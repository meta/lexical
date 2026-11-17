/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// What every test of leftovers (D134) checks of a replay: no block of the
// report is dropped. Each block is applied, written into the document
// (once), given to the handler, or has nothing to write.

import type {YUnsyncedReport} from '../../headless';
import type {YReplayResult} from '../../offline';
import type {SerializedLexicalNode} from 'lexical';

import {expect} from 'vitest';

/** Every block id stored under `nodes`, at any depth, in document order. */
export function blockIdsIn(nodes: readonly unknown[]): string[] {
  const ids: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node !== 'object' || node === null) {
      return;
    }
    const {$: state, children} = node as {
      $?: {blockId?: unknown};
      children?: unknown;
    };
    if (state !== undefined && typeof state.blockId === 'string') {
      ids.push(state.blockId);
    }
    if (Array.isArray(children)) {
      children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return ids;
}

/** The text of every text node under `node`, joined. */
export function textIn(node: unknown): string {
  if (typeof node !== 'object' || node === null) {
    return '';
  }
  const {children, text} = node as {children?: unknown; text?: unknown};
  return (
    (typeof text === 'string' ? text : '') +
    (Array.isArray(children) ? children.map(textIn).join('') : '')
  );
}

/**
 * Fails when a block of `report` is neither applied, written into the
 * document, given to the handler, nor without anything to write (the
 * document holds it, or it is a deletion of the user's). Returns the ids of
 * the blocks written.
 */
export function expectNothingDropped(
  report: YUnsyncedReport,
  result: YReplayResult,
  only?: readonly string[],
): string[] {
  const written = result.leftovers.flatMap(place => place.blocks);
  // Written once.
  expect(new Set(written).size, 'a block written twice').toBe(written.length);
  expect(result.inserted).toEqual(
    result.leftovers.flatMap(place => place.inserted),
  );
  for (const place of result.leftovers) {
    expect(place.inserted.length, 'a place with nothing written').not.toBe(0);
  }
  const skipped = new Map(result.notApplied.map(skip => [skip.id, skip]));
  for (const block of report.blocks) {
    if (only !== undefined && !only.includes(block.id)) {
      continue;
    }
    const where = [
      result.applied.includes(block.id) ? 'applied' : null,
      written.includes(block.id) ? 'inserted' : null,
      result.handled.includes(block.id) ? 'handled' : null,
    ].filter(place => place !== null);
    if (where.length > 0) {
      expect(where.length, `block ${block.id} is ${where.join(' and ')}`).toBe(
        1,
      );
      continue;
    }
    const reason = skipped.get(block.id)?.reason;
    expect(
      reason === 'in-document' || (block.yours === null && reason != null),
      `block ${block.id} (${block.change}, ${String(
        reason,
      )}) was dropped: neither applied, inserted nor handled`,
    ).toBe(true);
  }
  return written;
}

/** How many times `needle` is in `text` (without overlaps). */
export function count(text: string, needle: string): number {
  return needle === '' ? 0 : text.split(needle).length - 1;
}

export type Json = SerializedLexicalNode;
