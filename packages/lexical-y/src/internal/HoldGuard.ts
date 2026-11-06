/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Hidden} from './Hidden';
import type {State} from './State';
import type {TextEditLog} from './TextEdits';

import {findIndexSS, Item, Node as YNode} from '@y/y';
import {
  $getNodeByKey,
  $getRoot,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $getSlotNameWithinHost,
  $isElementNode,
  $isLineBreakNode,
  $isRootNode,
  $isTextNode,
  type EditorState,
  type ElementNode,
  INTERNAL_getActiveEditorState,
  type LexicalNode,
  type NodeKey,
} from 'lexical';

import {insertionFree, type Recipient} from './InsertionFree';
import {TYPE_KEY} from './Schema';
import {shownAttrs} from './Seen';
import {Roles} from './State';

/**
 * Before a write runs while a composition's hold holds a collaborator's
 * change (`hidden`): the shared nodes around what the hold keeps back that
 * the update from `prev` to the active editor state would delete or write
 * anew (the inline container composed in, where it removes a text node of
 * it or takes one out). Each shared node that holds a held item, and the node
 * composed in, is compared where storage keeps it (see $frame): its nearest
 * shared ancestor (a slot's value by its host and slot name), and its place
 * there among the elements in both states. A node gone, a new nearest
 * shared ancestor, or another place endangers what the hold keeps (the
 * writer deletes the old shared node, and its items with it); so does a
 * slot that held one of them no longer holding it, and, in the inline
 * container composed in, a text node removed or taken out into a node that
 * was there before. A line re-keyed in place (a change of its type), a new
 * wrapper around a line, text and format edits change none of it: the
 * writer keeps the shared nodes there.
 */
export function $endangeredBy(
  state: State,
  hidden: Hidden,
  prev: EditorState,
): NodeKey[] {
  const out: NodeKey[] = [];
  const owner = hidden.ownerKey;
  const keys = [...heldAncestors(state, hidden), owner];
  const prevMap = prev._nodeMap;
  const nextMap = INTERNAL_getActiveEditorState()!._nodeMap;
  const common = (k: NodeKey) => prevMap.has(k) && nextMap.has(k);
  const prevRoles = new Roles(state);
  const nextRoles = new Roles(state);
  const storedIn = (roles: Roles) => (n: LexicalNode) => {
    const role = roles.$role(n);
    return role === 'root' || role === 'container' || role === 'leaf';
  };
  for (let i = 0; i < keys.length; i++) {
    const was = prev.read(() => $frameOf(keys[i], storedIn(prevRoles), common));
    if (was === null) {
      continue;
    }
    const key = keys[i];
    if (
      key === owner &&
      !state.yByKey.has(owner) &&
      $getNodeByKey(owner) === null
    ) {
      // A line composed in that is gone (removed, or replaced, as a change
      // of its type does): a line has no shared node, and what the hold
      // keeps in it stays where it is (see Cursor#counts); a line that
      // replaces it in place takes it over (see Writer#$writeMarker).
      continue;
    }
    // The line an inline node is in: the writer keeps it where a line
    // splits around it, or a new line takes it (a line re-keyed in place,
    // Enter before it), and writes it anew where it moves into another line
    // that was there before (a line joined into another one included).
    const lineOf = (roles: Roles) => {
      for (let n = $getNodeByKey(key); n !== null; ) {
        const parent: LexicalNode | null = n.getParent();
        if (parent === null || storedIn(roles)(parent)) {
          return null;
        }
        if (roles.$role(parent) === 'line') {
          return parent.getKey();
        }
        n = parent;
      }
      return null;
    };
    const lineWas = prev.read(() => lineOf(prevRoles));
    const lineNow = lineOf(nextRoles);
    if (
      $frameOf(key, storedIn(nextRoles), common) !== was ||
      !$slotsKeep(prev, keys[i]) ||
      (lineWas !== lineNow &&
        (lineWas === null || lineNow === null || prevMap.has(lineNow)))
    ) {
      out.push(key);
    }
  }
  if ((state.csByKey.get(owner) || {kind: null}).kind !== 'i') {
    return out;
  }
  // A text node of the inline container composed in, which stays, removed
  // (its text gone, or merged into another node: written anew from what the
  // editor shows, where a held format change would be undone), or taken
  // out into a node that was there before (a line split, Enter, makes the
  // node its text goes to, and keeps its held items where they are, see
  // Hidden#starts).
  const ownerKeys = ownerTextKeys(prev, owner);
  const textMoved = ownerKeys.some((key, i) => {
    const n = $getNodeByKey(key);
    if (n === null || !n.isAttached()) {
      // An empty text node removed takes no text with it; one merged into
      // the owner's text next to it (normalization joining two text nodes
      // of the owner, what an IME's steps split) stays in the owner.
      const was = prev.read(() => $getNodeByKey(key)!.getTextContent());
      return (
        was !== '' &&
        ![ownerKeys[i - 1], ownerKeys[i + 1]].some((other, side) => {
          if (other === undefined) {
            return false;
          }
          const o = $getNodeByKey(other);
          if (
            !$isTextNode(o) ||
            !o.isAttached() ||
            !o.getParents().some(p => p.getKey() === owner)
          ) {
            return false;
          }
          const otherWas = prev.read(() =>
            $getNodeByKey(other)!.getTextContent(),
          );
          return (
            o.getTextContent() ===
            (side === 0 ? otherWas + was : was + otherWas)
          );
        })
      );
    }
    if (n.getParents().some(p => p.getKey() === owner)) {
      return false;
    }
    const parent = n.getParent();
    return (
      parent !== null &&
      prev.read(() => {
        const p = $getNodeByKey(parent.getKey());
        return p !== null && p.isAttached();
      })
    );
  });
  if (textMoved) {
    out.push(owner);
  }
  return out;
}

/** What to do with a write while a hold holds a collaborator's change. */
export type HeldDecision = {
  /** Refused before it changes anything. */
  refuse: boolean;
  /**
   * The update re-types the text of the line composed in, which the hold
   * shows as a block its shared counterpart no longer is (see
   * $reshapesRestyledLine): that line is not written, and is read again as
   * stored, where its transforms run again; the rest of the update is
   * written (see Writer#skippedLine).
   */
  quiet: boolean;
  /**
   * The shared nodes holding what the hold keeps that it may delete or
   * write anew: those an admitted update moves or removes (see
   * $heldDecision).
   */
  allow: ReadonlySet<NodeKey>;
  /**
   * Whether it inserts characters: a write that would delete a shared node
   * holding what the hold keeps, beyond `allow`, then goes on, reported
   * (see withProtected); one that inserts none is stopped and refused.
   */
  inserts: boolean;
};

/**
 * Whether a write from `prev` to the active editor state, while `hidden`
 * holds a collaborator's change, is refused: only where it would delete or
 * write anew a shared node around what the hold keeps (see $endangeredBy)
 * and inserts no characters (see $insertsCharacters). Refusing reads the
 * document again, which undoes the whole update, so an update that inserts
 * a character (typing, a composition's text, text merged or moved into
 * another node) is written as made, the shared nodes it moves or removes
 * allowed, as main writes it: the collaborator's held change in them goes
 * with them.
 */
export function $heldDecision(
  state: State,
  hidden: Hidden,
  prev: EditorState,
  remoteUnread: boolean | ReadonlySet<YNode>,
  log: TextEditLog | null = null,
): HeldDecision {
  const endangered = $endangeredBy(state, hidden, prev);
  // Of those, the containers the update removes or moves (not one that only
  // lost a text node): what its record says it merged elsewhere from them
  // is moved text (see $insertsCharacters).
  const nextMap = INTERNAL_getActiveEditorState()!._nodeMap;
  const moving = endangered.filter(
    key =>
      !nextMap.has(key) ||
      placeOf(prev._nodeMap, key) !== placeOf(nextMap, key),
  );
  // The shared node a text node's characters are stored in: the nearest
  // container around it.
  const storedIn = (key: NodeKey): YNode | null =>
    prev.read(() => {
      for (let n = $getNodeByKey(key); n !== null; n = n.getParent()) {
        const cs = state.csByKey.get(n.getKey());
        if (cs !== undefined) {
          return cs.y;
        }
      }
      return null;
    });
  const inserts = $insertsCharacters(prev, remoteUnread, moving, log, storedIn);
  // The line composed in, re-typed by a transform, is left out of the write
  // (its text is unchanged, so what endangers what the hold keeps there is
  // not written, see Writer#skippedLine). The rest of the update is written:
  // an edit elsewhere in it, typing included, is never refused for the
  // re-typing. A re-tokenization merges text of several nodes into one,
  // which $insertsCharacters takes for moved text: there the update inserts
  // characters where the document's text gains any (another line typed in,
  // a paragraph appended), as it does on main, so a write that fails part way
  // is recovered as one that inserts (see YBinding#$runWriter).
  const quiet = $reshapesRestyledLine(state, hidden, prev);
  const insertsChars = inserts && (!quiet || $gainsText(prev, remoteUnread));
  return {
    allow: insertsChars && !quiet ? new Set(endangered) : new Set(),
    inserts: insertsChars,
    quiet,
    refuse: endangered.length > 0 && !insertsChars && !quiet,
  };
}

/**
 * Whether the update from `prev` to the active editor state adds characters
 * to the document's text (its text is not what is left of the text before
 * after deleting some), or a remote change not read yet deletes text, where
 * what the editor showed is not what is stored (see $insertsCharacters).
 */
function $gainsText(
  prev: EditorState,
  remoteUnread: boolean | ReadonlySet<YNode>,
): boolean {
  if (
    remoteUnread === true ||
    (remoteUnread !== false && remoteUnread.size > 0)
  ) {
    return true;
  }
  const before = prev.read(() => $getRoot().getTextContent());
  const after = $getRoot().getTextContent();
  let i = 0;
  for (let j = 0; j < before.length && i < after.length; j++) {
    if (before[j] === after[i]) {
      i++;
    }
  }
  return i < after.length;
}

/**
 * Whether the editor shows line `owner` (as of `prev`) as a block its shared
 * counterpart no longer is: its marker gone (the block joined into the line
 * before it), or a shown node of another class than the stored type's (a
 * code block made a list item, which the hold shows as it was; a node
 * replacement's class extends the class it replaces, so it is the same
 * block). A held change of its other attributes alone (alignment, indent,
 * direction) is not one.
 */
function $showsRestyled(
  state: State,
  prev: EditorState,
  owner: NodeKey,
): boolean {
  const unit = state.unitByKey.get(owner);
  if (unit === undefined || unit.end === null) {
    return false;
  }
  if (unit.end.deleted) {
    return true;
  }
  const attr = shownAttrs(unit.end, null)[TYPE_KEY];
  const info = state.editor._nodes.get(
    typeof attr === 'string' ? attr : 'paragraph',
  );
  return prev.read(() => {
    const node = $getNodeByKey(owner);
    return (
      node !== null && (info === undefined || !(node instanceof info.klass))
    );
  });
}

/**
 * Whether the update from `prev` to the active editor state re-types the
 * text of the line composed in, keeping that text, while the hold shows that
 * line as a block its shared counterpart no longer is (see $showsRestyled: a
 * code block a collaborator made a paragraph, or joined into the line before
 * it): some of its characters are in a node of another type than before (a
 * code highlighter tokenizing the shown code line again at the end of the
 * composition makes the text nodes there code highlight nodes). What such a
 * transform makes follows from what the editor shows, not from what is
 * stored, and written, its nodes (code highlight tokens, which drop formats
 * and join NodeState) would land on text that storage keeps outside that
 * type. That line is not written: it is read again as stored and the hold
 * ends, and Lexical's transforms then run on it again as stored, where they
 * make what the stored block makes (a hashtag again in a heading; nothing
 * of a code highlighter's in a paragraph); the rest of the update is
 * written. An edit that keeps the type of
 * every node holding the line's characters (a format applied to part of a
 * word, which splits its node; a link around a word) is not one, nor is one
 * that changes the line's text (typing, a composition, Enter, or the end of
 * a composition that inserts its text in the same update, as Firefox's input
 * and WebKit's insertFromComposition do: written as before).
 */
function $reshapesRestyledLine(
  state: State,
  hidden: Hidden,
  prev: EditorState,
): boolean {
  const owner = hidden.ownerKey;
  if (!$showsRestyled(state, prev, owner)) {
    return false;
  }
  // Not where the update also moves the line or a container around it (a
  // slot swapped, a container moved before another): its structural write
  // is decided as before, refused for the hold where it endangers what the
  // hold keeps.
  const nextMap = INTERNAL_getActiveEditorState()!._nodeMap;
  if (
    placeOf(prev._nodeMap, owner) !== placeOf(nextMap, owner) ||
    reordered(prev._nodeMap, nextMap, owner)
  ) {
    return false;
  }
  const shape = (node: LexicalNode | null) =>
    $isElementNode(node)
      ? {
          keys: node.getChildrenKeys().join(','),
          text: node.getTextContent(),
        }
      : null;
  const was = prev.read(() => shape($getNodeByKey(owner)));
  const now = shape($getNodeByKey(owner));
  if (
    was === null ||
    now === null ||
    was.text !== now.text ||
    was.keys === now.keys
  ) {
    return false;
  }
  const types = (node: LexicalNode | null) =>
    $isElementNode(node) ? leafTypeRuns(node) : '';
  return (
    prev.read(() => types($getNodeByKey(owner))) !== types($getNodeByKey(owner))
  );
}

/**
 * The type of the node each character of `element`'s text is in, as runs of
 * one type (`type:size`, in order): equal for two versions of a line with the
 * same text exactly when every character is in a node of the same type.
 */
function leafTypeRuns(element: ElementNode): string {
  const runs: string[] = [];
  let type = '';
  let size = 0;
  const visit = (node: LexicalNode) => {
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        visit(child);
      }
      return;
    }
    const nodeSize = node.getTextContentSize();
    if (nodeSize === 0) {
      // Holds no character (an inline decorator node without text).
      return;
    }
    const nodeType = node.getType();
    if (nodeType !== type) {
      if (size > 0) {
        runs.push(`${type}:${size}`);
      }
      type = nodeType;
      size = 0;
    }
    size += nodeSize;
  };
  visit(element);
  if (size > 0) {
    runs.push(`${type}:${size}`);
  }
  return runs.join(',');
}

/**
 * Whether the update from `prev` to the active editor state inserts a
 * character (see insertionFree), from the text of their text nodes. Where
 * a remote change not read yet (deferred, or unread) deletes text, what the
 * editor showed is not what is stored, so an update that changes text is
 * taken to insert one.
 */
export function $insertsCharacters(
  prev: EditorState,
  remoteUnread: boolean | ReadonlySet<YNode>,
  moving: readonly NodeKey[] = [],
  log: TextEditLog | null = null,
  storedIn: (key: NodeKey) => YNode | null = () => null,
): boolean {
  const texts = (map: Map<NodeKey, LexicalNode>) => {
    const out = new Map<NodeKey, string>();
    for (const [key, node] of map) {
      if ($isTextNode(node)) {
        out.set(key, node.__text);
      }
    }
    return out;
  };
  const prevMap = prev._nodeMap;
  const nextMap = INTERNAL_getActiveEditorState()!._nodeMap;
  const order = () => {
    const out: NodeKey[] = [];
    const walk = (node: LexicalNode) => {
      if ($isTextNode(node)) {
        out.push(node.getKey());
      }
      if ($isElementNode(node)) {
        for (const child of node.getChildren()) {
          walk(child);
        }
      }
      for (const name of $getSlotNames(node)) {
        const value = $getSlot(node as ElementNode, name);
        if (value !== null) {
          walk(value);
        }
      }
    };
    walk($getRoot());
    return out;
  };
  // A kept node the update's record says it split: its new parts are its
  // own text, read as one with it (in document order), not made text.
  const nextTexts = texts(nextMap);
  // A node the update made with exactly the text a removed node had then
  // (a text node re-keyed, its text replayed from the record): read as that
  // node, kept.
  const rename = new Map<NodeKey, NodeKey>();
  {
    const now = new Map<NodeKey, string>();
    const textNow = (k: NodeKey): string | undefined => {
      const t = now.get(k);
      if (t !== undefined) {
        return t;
      }
      const n = prevMap.get(k);
      return $isTextNode(n) ? n.__text : undefined;
    };
    const taken = new Set<NodeKey>();
    for (const e of log ?? []) {
      if (e[0] === 'merge') {
        now.set(e[1], e[3] ? e[5] + e[4] : e[4] + e[5]);
        now.set(e[2], '');
      } else if (e[0] === 'splice') {
        const [, k, at, del, ins, before] = e;
        now.set(k, before.slice(0, at) + ins + before.slice(at + del));
      } else if (e[0] === 'set') {
        const [, k, before, after] = e;
        if (
          !prevMap.has(k) &&
          before === '' &&
          after !== '' &&
          !rename.has(k)
        ) {
          for (const [r, node] of prevMap) {
            if (
              $isTextNode(node) &&
              !nextMap.has(r) &&
              !taken.has(r) &&
              textNow(r) === after
            ) {
              rename.set(k, r);
              taken.add(r);
              break;
            }
          }
        }
        now.set(k, after);
      }
    }
  }
  // (One merged away since is that node's text merged there, see seq.)
  const keptAs = new Set<NodeKey>();
  for (const [m, r] of rename) {
    if (nextTexts.has(m)) {
      nextTexts.set(r, nextTexts.get(m)!);
      nextTexts.delete(m);
      keptAs.add(r);
    }
  }
  const renamed = (k: NodeKey) => rename.get(k) ?? k;
  const inNext = (k: NodeKey) => nextMap.has(k) || keptAs.has(k);
  const parts = new Set<NodeKey>();
  if (log !== null) {
    for (const e of log) {
      if (e[0] !== 'split' || !nextMap.has(e[1]) || !prevMap.has(e[1])) {
        continue;
      }
      const made = e[2].filter(
        k => k !== e[1] && !prevMap.has(k) && nextTexts.has(k),
      );
      if (made.length === 0 || !e[2].includes(e[1])) {
        continue;
      }
      const all = order().filter(k => k === e[1] || made.includes(k));
      nextTexts.set(e[1], all.map(k => nextTexts.get(k)!).join(''));
      for (const k of made) {
        nextTexts.delete(k);
        parts.add(k);
      }
    }
  }
  // A node the update made and then merged into a kept node (a text re-keyed,
  // then moved and merged): read as the made node it was, next to that kept
  // node, with the text it brought (as recorded), so that the run its text
  // came from can be given to it.
  const transient = new Map<NodeKey, {at: NodeKey; before: boolean}>();
  // (A part a split made is its node's own text, merged back or not.)
  const splitOff = new Set<NodeKey>();
  for (const e of log ?? []) {
    if (e[0] === 'split') {
      for (const k of e[2]) {
        if (k !== e[1]) {
          splitOff.add(k);
        }
      }
    }
  }
  // Latest first (a later merge is outside an earlier one), and each merge
  // its own made node (one node merged twice brought its text twice). Only a
  // node made whole (its text set once, from nothing): one typed into
  // (spliced, or set again) holds typed text, read as the kept node's.
  const records = log ?? [];
  const typedInto = new Set<NodeKey>();
  for (const e of records) {
    if (e[0] === 'splice' || (e[0] === 'set' && e[2] !== '')) {
      typedInto.add(e[1]);
    }
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const e = records[i];
    if (
      e[0] !== 'merge' ||
      splitOff.has(e[2]) ||
      typedInto.has(e[2]) ||
      rename.has(e[2]) ||
      prevMap.has(e[2]) ||
      nextMap.has(e[2]) ||
      !nextTexts.has(renamed(e[1])) ||
      e[5] === ''
    ) {
      continue;
    }
    const kept = nextTexts.get(renamed(e[1]))!;
    if (e[3] ? !kept.startsWith(e[5]) : !kept.endsWith(e[5])) {
      continue;
    }
    nextTexts.set(
      renamed(e[1]),
      e[3] ? kept.slice(e[5].length) : kept.slice(0, kept.length - e[5].length),
    );
    const occurrence = `${e[2]}~${i}`;
    nextTexts.set(occurrence, e[5]);
    transient.set(occurrence, {at: renamed(e[1]), before: e[3]});
  }
  const verdict = insertionFree(
    texts(prevMap),
    nextTexts,
    () => prev.read(order),
    () =>
      order()
        .filter(k => !parts.has(k))
        .map(renamed)
        .flatMap(k => {
          const out: NodeKey[] = [];
          for (const [t, {at, before}] of transient) {
            if (at === k && before) {
              out.push(t);
            }
          }
          out.push(k);
          for (const [t, {at, before}] of transient) {
            if (at === k && !before) {
              out.push(t);
            }
          }
          return out;
        }),
    () => {
      // Kept text nodes whose chain of parents changed: moved elsewhere.
      const out = new Set<NodeKey>();
      for (const [key, node] of prevMap) {
        if (
          $isTextNode(node) &&
          nextMap.has(key) &&
          placeOf(prevMap, key) !== placeOf(nextMap, key)
        ) {
          out.add(key);
        }
      }
      return out;
    },
    () => {
      // The text nodes of the containers the update moves or removes (see
      // $heldDecision), each a run of its own; and any removed text node the
      // update's record says it merged into a kept node, which its text went
      // to (without a record, none).
      const out = new Map<NodeKey, Recipient | null>();
      const theirs = prev.read(() => {
        const keys = new Set<NodeKey>();
        for (const key of moving) {
          const node = $getNodeByKey(key);
          if ($isElementNode(node)) {
            for (const text of node.getAllTextNodes()) {
              keys.add(text.getKey());
            }
          }
        }
        return keys;
      });
      for (const key of theirs) {
        out.set(key, null);
      }
      // The merges the record tells, replayed on the keys: the old text
      // nodes each kept node's text now comes from, in order (a chain of
      // merges included).
      const seq = new Map<NodeKey, NodeKey[]>();
      const seqOf = (k: NodeKey) => {
        let list = seq.get(k);
        if (list === undefined) {
          list = [k];
          seq.set(k, list);
        }
        return list;
      };
      for (const e of log ?? []) {
        if (e[0] === 'merge') {
          const into = renamed(e[1]);
          const from = renamed(e[2]);
          const keptSeq = seqOf(into);
          const merged = seqOf(from);
          seq.set(
            into,
            e[3] ? [...merged, ...keptSeq] : [...keptSeq, ...merged],
          );
          seq.set(from, []);
        }
      }
      for (const [k, list] of seq) {
        if (!inNext(k) || list.length < 2) {
          continue;
        }
        const at = list.indexOf(k);
        list.forEach((d, i) => {
          if (d !== k && prevMap.has(d) && !inNext(d)) {
            out.set(d, {
              key: k,
              rank: i,
              side: at >= 0 && i < at ? 'before' : 'after',
            });
          }
        });
      }
      return out;
    },
    () => {
      // The text nodes the update made, by the subtree it made that holds
      // them (its top node new, under one that was there before), in
      // document order.
      const groups = new Map<NodeKey, NodeKey[]>();
      const walk = (node: LexicalNode, top: NodeKey | null) => {
        const key = node.getKey();
        const at = prevMap.has(key) ? null : (top ?? key);
        if ($isTextNode(node) && at !== null) {
          const group = groups.get(at);
          if (group === undefined) {
            groups.set(at, [key]);
          } else {
            group.push(key);
          }
        }
        if ($isElementNode(node)) {
          for (const child of node.getChildren()) {
            walk(child, at);
          }
        }
        for (const name of $getSlotNames(node)) {
          const value = $getSlot(node as ElementNode, name);
          if (value !== null) {
            walk(value, at);
          }
        }
      };
      walk($getRoot(), null);
      return [...groups.values()];
    },
  );
  // A remote change not read yet that deletes text: the text the editor
  // showed may not be what is stored (a character A sets again may be gone
  // there, an identical replacement included), so the update counts as
  // inserting.
  if (!verdict.free || remoteUnread === true) {
    return true;
  }
  if (remoteUnread === false || remoteUnread.size === 0) {
    return false;
  }
  // The text the update's characters come from: its changed, removed and
  // re-set text nodes (an identical replacement included).
  const sources = new Set<NodeKey>();
  for (const [key, text] of prevMap) {
    if (
      $isTextNode(text) &&
      (!nextMap.has(key) ||
        (nextMap.get(key) as typeof text).__text !== text.__text)
    ) {
      sources.add(key);
    }
  }
  // A key the log names, back to the old text node it came from: a part a
  // split made is its node's text.
  const origin = new Map<NodeKey, NodeKey>();
  for (const e of log ?? []) {
    if (e[0] === 'split') {
      for (const k of e[2]) {
        if (k !== e[1]) {
          if (origin.has(k) && origin.get(k) !== e[1]) {
            // One key made by two splits (a node reused): where its text
            // came from is ambiguous, so the update counts as inserting.
            return true;
          }
          origin.set(k, e[1]);
        }
      }
    }
  }
  const source = (key: NodeKey) => {
    const seen = new Set<NodeKey>();
    let k = key;
    while (origin.has(k) && !seen.has(k)) {
      seen.add(k);
      k = origin.get(k)!;
    }
    return k;
  };
  for (const e of log ?? []) {
    if (e[0] === 'splice' || e[0] === 'set') {
      const k = source(e[1]);
      if (!prevMap.has(k)) {
        // A text node the update made, whose text the record does not tie to
        // an old one: where it came from is not known, so it counts as
        // inserting while a remote change not read yet deletes text.
        return true;
      }
      sources.add(k);
    }
  }
  if (log === null && sources.size === 0) {
    return false;
  }
  for (const key of log === null ? prevMap.keys() : sources) {
    if (!$isTextNode(prevMap.get(key))) {
      continue;
    }
    const y = storedIn(key);
    if (y === null || remoteUnread.has(y)) {
      return true;
    }
  }
  return false;
}

/**
 * The keys of the shared nodes around what `hidden` holds: deleting one
 * deletes the held items in it.
 */
function heldAncestors(state: State, hidden: Hidden): Set<NodeKey> {
  const keys = new Set<NodeKey>();
  const root = state.root;
  const note = (item: Item) => {
    for (
      let y: YNode | null = item.parent as YNode;
      y !== null && y !== root;
      y = y._item === null ? null : (y._item.parent as YNode)
    ) {
      const key = state.keyByY.get(y);
      if (key !== undefined) {
        keys.add(key);
      }
    }
  };
  hidden.forEachRange((client, start, end) => {
    const structs = state.doc.store.clients.get(client);
    if (structs === undefined) {
      return;
    }
    for (
      let i = findIndexSS(structs, start);
      i < structs.length && structs[i].id.clock < end;
      i++
    ) {
      const it = structs[i];
      if (it instanceof Item && it.parent instanceof YNode) {
        note(it);
      }
    }
  });
  for (const it of hidden.keptItems()) {
    if (it.parent instanceof YNode) {
      note(it);
    }
  }
  return keys;
}

/**
 * Where node `key` is kept, as a string: its nearest shared ancestor (or
 * its slot, by host and name, for a slot's value), and, where `common` is
 * given, how many elements in both states precede it in that ancestor, in
 * document order, other shared nodes counted but not entered. Null where it
 * is not attached.
 */
function $frameOf(
  key: NodeKey,
  stored: (n: LexicalNode) => boolean,
  common: (k: NodeKey) => boolean,
): string | null {
  const node = $getNodeByKey(key);
  if (node === null || !node.isAttached()) {
    return null;
  }
  if (node.getParent() === null && !$isRootNode(node)) {
    const host = $getSlotHost(node);
    return host === null
      ? null
      : `slot ${JSON.stringify($getSlotNameWithinHost(node))} of ${host.getKey()}`;
  }
  let anchor: LexicalNode | null = node.getParent();
  while (anchor !== null && !stored(anchor)) {
    anchor = anchor.getParent();
  }
  if (anchor === null) {
    return null;
  }
  let before = 0;
  let found = false;
  const walk = (el: LexicalNode) => {
    for (const child of $isElementNode(el) ? el.getChildren() : []) {
      if (found) {
        return;
      }
      if (child.getKey() === key) {
        found = true;
        return;
      }
      if ($isTextNode(child) || $isLineBreakNode(child)) {
        continue;
      }
      if (common(child.getKey())) {
        before++;
      }
      if (!stored(child)) {
        walk(child);
      }
    }
  };
  walk(anchor);
  return `${anchor.getKey()}@${before}`;
}

/**
 * Whether every slot that held node `key`, or a node above it, in `prev`
 * holds that same node now.
 */
function $slotsKeep(prev: EditorState, key: NodeKey): boolean {
  const slots = prev.read(() => {
    const out: [NodeKey, string, NodeKey][] = [];
    for (let n = $getNodeByKey(key); n !== null && !$isRootNode(n); ) {
      const parent: LexicalNode | null = n.getParent();
      if (parent !== null) {
        n = parent;
        continue;
      }
      const host = $getSlotHost(n);
      const name = $getSlotNameWithinHost(n);
      if (host === null || name === null) {
        break;
      }
      out.push([host.getKey(), name, n.getKey()]);
      n = host;
    }
    return out;
  });
  return slots.every(([hostKey, name, valueKey]) => {
    const host = $getNodeByKey(hostKey);
    if (host === null || !host.isAttached()) {
      return false;
    }
    const value = $getSlot(host as ElementNode, name);
    return value !== null && value.getKey() === valueKey;
  });
}

/**
 * The text nodes and line breaks node `key` held in `prev`, in document
 * order.
 */
export function ownerTextKeys(prev: EditorState, key: NodeKey): NodeKey[] {
  return prev.read(() => {
    const out: NodeKey[] = [];
    const walk = (el: ElementNode) => {
      for (const child of el.getChildren()) {
        if ($isLineBreakNode(child) || $isTextNode(child)) {
          out.push(child.getKey());
        } else if ($isElementNode(child)) {
          walk(child);
        }
      }
    };
    const owner = $getNodeByKey(key);
    if ($isElementNode(owner)) {
      walk(owner);
    }
    return out;
  });
}

/**
 * Whether node `key`, or a node around it, changed its place among its
 * siblings from `prevMap` to `nextMap` (placeOf compares only the parents):
 * among the siblings it has in both, under the same parent, its index
 * differs (a container moved before another). A sibling inserted or removed
 * around it does not move it.
 */
function reordered(
  prevMap: Map<NodeKey, LexicalNode>,
  nextMap: Map<NodeKey, LexicalNode>,
  key: NodeKey,
): boolean {
  // The keys of `parent`'s children in `map` that are its children in
  // `other` too.
  const kept = (
    map: Map<NodeKey, LexicalNode>,
    other: Map<NodeKey, LexicalNode>,
    parent: NodeKey,
  ): NodeKey[] => {
    const out: NodeKey[] = [];
    const node = map.get(parent) as {__first?: NodeKey | null} | undefined;
    const first = node === undefined ? null : node.__first;
    for (let k = first === undefined ? null : first; k !== null; ) {
      const child = map.get(k);
      if (child === undefined) {
        break;
      }
      const there = other.get(k);
      if (there !== undefined && there.__parent === parent) {
        out.push(k);
      }
      k = child.__next;
    }
    return out;
  };
  for (let n = nextMap.get(key); n !== undefined && n.__parent !== null; ) {
    const parent = n.__parent;
    const was = prevMap.get(n.__key);
    if (was === undefined || was.__parent !== parent) {
      return true;
    }
    if (
      kept(prevMap, nextMap, parent).indexOf(n.__key) !==
      kept(nextMap, prevMap, parent).indexOf(n.__key)
    ) {
      return true;
    }
    n = nextMap.get(parent);
  }
  return false;
}

/**
 * Where node `key` is in `map`, up to the root: each parent, or the host and
 * slot name of a named slot it fills (see insertionFree's `moved`).
 */
function placeOf(map: Map<NodeKey, LexicalNode>, key: NodeKey): string {
  const up: string[] = [];
  for (let n = map.get(key); n !== undefined; ) {
    const parent = n.__parent;
    if (parent !== null) {
      up.push(parent);
      n = map.get(parent);
      continue;
    }
    const hostKey = (n as {__slotHost?: null | NodeKey}).__slotHost ?? null;
    if (hostKey === null) {
      break;
    }
    const host = map.get(hostKey);
    let name = '';
    const slots =
      host === undefined
        ? null
        : ((host as {__slots?: null | Map<string, NodeKey>}).__slots ?? null);
    if (slots) {
      for (const [k, v] of slots) {
        if (v === n.__key) {
          name = k;
        }
      }
    }
    up.push(`${hostKey}/${name}`);
    n = host;
  }
  return up.join(',');
}
