/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Formats} from './Cursor';
import type {Unit} from './State';
import type {NodeKey} from 'lexical';

import {type Item} from '@y/y';

import {keepShown, unkeepShown} from './Keeps';

/*
 * Remote changes held back while the local editor composes.
 *
 * While the local editor is composing (IME) in a line or inline container,
 * a remote change to it is applied to Yjs but not to its Lexical nodes:
 * rewriting them would move or end the browser's composition. Everything
 * Yjs keeps can be held back: the items a change inserts (text, inline
 * nodes, formats and comments, a line marker that splits the line), by id,
 * its deletions of items already held, and the attributes it sets on the
 * line's marker. Every reader and writer of the line skips what is held (the
 * line is the editor's view of Yjs minus these items, see `hides`). A change
 * that removes something the editor shows (a deletion, a join) is read at
 * once and whole, held items still skipped: Yjs does not keep what it
 * removed, so the editor cannot go on showing it. Format items are the
 * exception, in documents read as paired runs (layout 3): a format item a
 * change deletes in the line is kept (see `keeps`), so the line goes on
 * showing it until the hold ends (a change that retokenizes the line, or an
 * identity write, deletes the line's format items and writes others). A kept
 * item a local edit leaves in another line (Enter before it) stays kept: the
 * local edit wrote that line as the editor showed it, and it is read again
 * when the hold ends, as every kept item's line is.
 *
 * The hold lasts while the composition goes on in that line and every held
 * item is still in it: it ends when the composition ends (or is cancelled,
 * or cut short by a blur), when the composition moves to another line, or
 * when a local edit takes held content out of the line (Enter, Backspace
 * across lines, a paste). Every held change is then read where its content
 * is (see YBinding#$release). Items can be split or merged by Yjs, so this
 * works on id ranges, not items.
 *
 * Invariants:
 * - I1: only the display of the line being composed (and of the lines a
 *   local split of it made while composing, see `starts`) differs from the
 *   stored document, and a remote change never replaces the composed node
 *   or its DOM text node. That display leaves held items out, shows kept
 *   ones, and folds as if a held end paired nothing (Reader#held),
 *   from the line's shown start.
 * - I2: every other line reads as a fresh read of the stored document. What
 *   the composed line hands on to the lines after it is folded from its
 *   stored items: held insertions in, kept deletions out (Shown.isStoredIn).
 *   Fold notes carry the lane they were folded in (Shown.FoldLane).
 * - I3: when the hold ends, the line reads what is stored.
 * - I4: the composer's own writes in the line are made, and self-checked,
 *   against its display, without bringing kept items back or dropping held
 *   insertions.
 */
export class Hidden {
  /** Sorted, merged [start, end) clock ranges per client. */
  private readonly ranges = new Map<number, [number, number][]>();
  /**
   * Local split units whose shown start excludes a held format inherited
   * across the split. Their stored starts remain known separately, and
   * release reads these units even if the stored-format cache is unchanged.
   */
  readonly starts = new Map<
    Unit,
    {shown: Formats | null; stored: Formats | null}
  >();
  /**
   * The attributes of the line being composed that held changes set (only
   * those this client owns, see ownsMarkerAttr and Reader#$ownedChanges):
   * `was` holds the values they had before (undefined: not set), which the
   * editor goes on showing, and `now` the values the changes set. `ends` are
   * the markers that store them: the line's, and those of the lines a local
   * split of it made while composing, which keep them too (see
   * Writer#$writeMarker).
   */
  marker: {
    ends: Set<Item>;
    was: Map<string, unknown>;
    now: Map<string, unknown>;
  } | null = null;
  /**
   * @param ownerKey the line or inline container composed in (a line that
   * replaces it, as a change of its type does, takes it over, see
   * Writer#$writeMarker)
   */
  constructor(public ownerKey: NodeKey) {}

  /**
   * The text node the composition runs in, as the binding last saw it after
   * a commit (see YBinding's update listener); null until then.
   */
  composedKey: NodeKey | null = null;
  /**
   * Lexical moved the composition to another node in a way the binding did
   * not foresee (see YBinding#foreseeNextUpdate and YBinding#noteComposed),
   * or foresaw: the hold ends at once (see YBinding#$holds), so that the
   * editor shows what is stored.
   */
  missed = false;

  /**
   * Format items a held change deleted, which the editor still shows (see
   * `keeps`), with whether the hold set their Item.keep (so that the
   * deleting transaction's garbage collection left their key and value
   * readable; cleared when the hold ends, see `releaseKeeps`).
   */
  private readonly kept = new Map<Item, boolean>();

  /**
   * Show deleted format item `item` until the hold ends: every reader and
   * writer of the line sees it live (see Shown.isGoneIn and isShownIn). It is
   * kept from the deleting transaction's garbage collection, which runs
   * after the change is read (Item.keep; a format item never merges with
   * its neighbours, so the flag changes nothing else).
   */
  keep(item: Item): void {
    if (this.kept.has(item)) {
      return;
    }
    this.kept.set(item, keepShown(item));
  }

  /**
   * Stop showing `item`, a deleted format item the hold showed (see keep),
   * which the local write deleted again: the editor no longer shows its
   * format there, so the hold's readers and writers must not either (a held
   * change deleted a node-type run around composed text, which the
   * composer's own write then removed as well).
   */
  drop(item: Item): void {
    const set = this.kept.get(item);
    if (set === undefined) {
      return;
    }
    if (set) {
      unkeepShown(item);
    }
    this.kept.delete(item);
  }

  /** Whether `item` is a deleted format item the hold shows (see keep). */
  keeps(item: Item): boolean {
    return this.kept.size > 0 && item.deleted && this.kept.has(item);
  }

  /** Whether the hold shows a deleted format item (see keep). */
  keepsAny(): boolean {
    return this.kept.size > 0;
  }

  /** The deleted format items the hold shows (see keep). */
  keptItems(): Iterable<Item> {
    return this.kept.keys();
  }

  /** Clear the Item.keep flags the hold set (see keep). */
  releaseKeeps(): void {
    for (const [item, set] of this.kept) {
      if (set) {
        unkeepShown(item);
      }
    }
  }

  /** Each hidden [start, end) clock range of `client`. */
  forEachRange(fn: (client: number, start: number, end: number) => void) {
    this.ranges.forEach((list, client) => {
      for (const [start, end] of list) {
        fn(client, start, end);
      }
    });
  }

  add(client: number, clock: number, len: number): void {
    let list = this.ranges.get(client);
    if (list === undefined) {
      list = [];
      this.ranges.set(client, list);
    }
    list.push([clock, clock + len]);
    list.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const r of list) {
      const last = merged[merged.length - 1];
      if (last !== undefined && r[0] <= last[1]) {
        last[1] = Math.max(last[1], r[1]);
      } else {
        merged.push([r[0], r[1]]);
      }
    }
    this.ranges.set(client, merged);
  }

  /** Whether all of `item` is held back. */
  /** Whether any part of `item` is held (see hides). */
  overlaps(item: Item): boolean {
    const list = this.ranges.get(item.id.client);
    if (list === undefined) {
      return false;
    }
    const start = item.id.clock;
    const end = start + item.length;
    for (const [rs, re] of list) {
      if (re > start) {
        return rs < end;
      }
    }
    return false;
  }

  hides(item: Item): boolean {
    const list = this.ranges.get(item.id.client);
    if (list === undefined) {
      return false;
    }
    const start = item.id.clock;
    for (const [rs, re] of list) {
      if (re > start) {
        return rs <= start && re >= start + item.length;
      }
    }
    return false;
  }

  /**
   * The runs of `item` (offsets within it), alternating hidden and shown:
   * `[length, hidden]` pairs that add up to the item's length.
   */
  runs(item: Item): [number, boolean][] {
    const list = this.ranges.get(item.id.client);
    const start = item.id.clock;
    const end = start + item.length;
    if (list === undefined) {
      return [[item.length, false]];
    }
    const out: [number, boolean][] = [];
    let pos = start;
    for (const [rs, re] of list) {
      if (re <= pos) {
        continue;
      }
      if (rs >= end) {
        break;
      }
      if (rs > pos) {
        out.push([rs - pos, false]);
      }
      const e = Math.min(re, end);
      out.push([e - Math.max(rs, pos), true]);
      pos = e;
    }
    if (pos < end) {
      out.push([end - pos, false]);
    }
    return out;
  }

  /** The length of `item` the editor shows. */
  shownLength(item: Item): number {
    let n = 0;
    for (const [len, hidden] of this.runs(item)) {
      if (!hidden) {
        n += len;
      }
    }
    return n;
  }

  /** The shown offset (within the item) of the item's unit at `offset`. */
  shownBefore(item: Item, offset: number): number {
    let n = 0;
    let pos = 0;
    for (const [len, hidden] of this.runs(item)) {
      if (pos >= offset) {
        break;
      }
      if (!hidden) {
        n += Math.min(len, offset - pos);
      }
      pos += len;
    }
    return n;
  }

  /** The unit offset (within the item) of the `shown`-th shown unit. */
  unitAt(item: Item, shown: number): number {
    let pos = 0;
    for (const [len, hidden] of this.runs(item)) {
      if (!hidden) {
        if (shown < len) {
          return pos + shown;
        }
        shown -= len;
      }
      pos += len;
    }
    return pos;
  }
}
