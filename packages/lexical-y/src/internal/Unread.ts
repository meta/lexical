/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  createIdSet,
  type IdSet,
  type Item,
  type Node as YNode,
  type Transaction,
} from '@y/y';

/*
 * A remote change the editor does not show yet, while the binding writes a
 * local update made before it.
 *
 * A provider can apply a remote change in the same task as a local update
 * made before any commit (see YBinding#commitsAtOnce): Yjs integrates the
 * change first, and the binding commits the local update, and writes it,
 * before it reads the change (see YBinding#commitPending). The local update
 * was made on the document as it was before the change, so it is written on
 * that document: the items the change inserted are not there, and the items
 * it deleted still are (a delete of one by this write deletes nothing more).
 * An attribute is set or deleted where it was before the change, so that
 * Yjs settles it with the change's value as it settles concurrent values.
 * Yjs then merges the write with the change as it merges any concurrent
 * changes, and the change is read after the write. Why: written on the
 * changed document, the update's offsets point at other text (a delete
 * before them shifts them), and what it rewrites (a line's text or formats,
 * a marker's attributes) brings back what the change deleted and removes
 * what it inserted.
 *
 * A binding sees the document this way from the moment Yjs starts applying
 * a change until the binding has read it (see YBinding#noteChange), in all
 * its work (the view it passes, see View): the writes and the selections it takes in between
 * are its editor's, which shows none of the changes it has not read, its
 * own writes excepted. Another binding of the document sees it as its own
 * editor shows it, and only items under a binding's root are seen through
 * its view.
 *
 * The helpers that read or write the document as a binding's editor shows it
 * (see Shown and Seen) take that view as a parameter (View), and a fold the view and
 * the hold it reads in (Ident.FoldIn): the binding hands its own to its
 * readers, writers and walks (`YBinding#seer`, read at each step, see
 * Reader#liveView), the Reader the hold of the line being composed
 * (Reader#held). There is no running work's view: a second binding of the
 * same document passes its own.
 */

/**
 * The document under a root as it was before the changes a binding has not
 * read yet.
 */
export interface Unread {
  /** The changes, in the order Yjs applied them (see noteChange). */
  readonly changes: Transaction[];
  /** The binding's root. */
  readonly root: YNode;
  /** What the changes deleted that the writes since deleted too. */
  readonly removed: IdSet;
  /** Whether each type is under the root (see scopedView). */
  readonly under: Map<YNode, boolean>;
  /**
   * Whether a deleted item is one the editor still shows: a format item a
   * held change deleted in the line being composed (see Hidden#keeps).
   */
  readonly keeps: ((item: Item) => boolean) | null;
  /**
   * A write deleted `item` again, a deleted item the editor showed (see
   * keeps): the editor no longer shows it (see Hidden#drop).
   */
  readonly dropKept: ((item: Item) => void) | null;
  /**
   * For a hold's view, which stays until the hold ends (see
   * YBinding#heldView): whether it keeps nothing now, so that it reads and
   * writes exactly as no view does (see scopedView). Null otherwise.
   */
  readonly lapsed: (() => boolean) | null;
}

/**
 * What one binding's work sees of the shared document, passed to the
 * helpers that read or write it (see Shown and Seen): today the changes the binding
 * has not read yet and the hold's kept items, as Unread. Null: Yjs as it
 * is.
 */
export type View = Unread;

/**
 * The part of `view` that applies to the items of `type`, as the helpers
 * that read or write them use it (see Shown and Seen): `view` itself where `type` is
 * under its root, else null (Yjs as it is: another binding's root, or
 * none); none either for a hold's view that keeps nothing (see lapsed).
 */
export function scopedView(view: View | null, type: YNode): View | null {
  if (view === null) {
    return null;
  }
  let under = view.under.get(type);
  if (under === undefined) {
    under = false;
    for (let t: YNode | null = type; t !== null; t = t.parent) {
      if (t === view.root) {
        under = true;
        break;
      }
    }
    view.under.set(type, under);
  }
  return under && (view.lapsed === null || !view.lapsed()) ? view : null;
}

/** The document under `root` as it was before any change. */
export function emptyView(
  root: YNode,
  keeps: ((item: Item) => boolean) | null = null,
  dropKept: ((item: Item) => void) | null = null,
  lapsed: (() => boolean) | null = null,
): Unread {
  return {
    changes: [],
    dropKept,
    keeps,
    lapsed,
    removed: createIdSet(),
    root,
    under: new Map(),
  };
}

/** Whether one of the changes of `view` inserted `item`. */
export function inserted(view: Unread, item: Item): boolean {
  for (const change of view.changes) {
    if (change.insertSet.hasId(item.id)) {
      return true;
    }
  }
  return false;
}

/** Whether one of the changes of `view` deleted `item`. */
export function deleted(view: Unread, item: Item): boolean {
  for (const change of view.changes) {
    if (change.deleteSet.hasId(item.id)) {
      return true;
    }
  }
  return false;
}
