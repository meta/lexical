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
 * its work (see seenBy): the writes and the selections it takes in between
 * are its editor's, which shows none of the changes it has not read, its
 * own writes excepted. Another binding of the document sees it as its own
 * editor shows it, and only items under a binding's root are seen through
 * its view.
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
  /** Whether each type is under the root (see viewOf). */
  readonly under: Map<YNode, boolean>;
}

/** The view of the binding whose work is running (see seenBy). */
let seer: (() => Unread | null) | null = null;

/** The document under `root` as it was before any change. */
export function emptyView(root: YNode): Unread {
  return {changes: [], removed: createIdSet(), root, under: new Map()};
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

/**
 * Run `fn`, a binding's work, on the document as that binding's editor shows
 * it: `view()` is the changes it has not read yet, if any (it can change
 * while `fn` runs). Work of another binding nested in `fn` runs on that
 * binding's view.
 */
export function seenBy<T>(view: () => Unread | null, fn: () => T): T {
  const prev = seer;
  seer = view;
  try {
    return fn();
  } finally {
    seer = prev;
  }
}

/**
 * The view the running work sees the items of `type` in, if any (see Seen,
 * which answers what the running work sees through it).
 */
export function viewOf(type: YNode): Unread | null {
  const view = seer === null ? null : seer();
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
  return under ? view : null;
}
