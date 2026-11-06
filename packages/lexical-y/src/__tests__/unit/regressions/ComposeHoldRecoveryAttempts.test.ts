/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The recovery of a write that fails part way while a hold is on undoes each
// failed attempt inside the write's transaction and tries again: the
// binding's maps are put back exactly as they were before the write (a full
// serialization of each, compared), the attempts stop at a hard cap, and
// however many attempts run, peers get one Yjs update and the binding's
// observable effects (its warnings, the hold's release) happen once.

import type {State} from '../../../internal/State';

import {createID, type Item} from '@y/y';
import {
  $create,
  $createParagraphNode,
  $getDocument,
  $getRoot,
  $setCompositionKey,
  $setSelection,
  ElementNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

import {MAX_RECOVERY_ATTEMPTS, YBinding} from '../../../internal/Binding';
import {Writer} from '../../../internal/Write';
import {freshReader, NODES, type Peer, setup} from '../../utils/harness';

class AttemptBox extends ElementNode {
  $config() {
    return this.config('attempt_box', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isInline() {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM() {
    return false;
  }
}

const text = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join('|'),
  );

const idOf = (it: Item | null | undefined) =>
  it == null ? null : `${it.id.client}:${it.id.clock}`;

/** Every map of `state` a write touches, serialized in full. */
function serialize(state: State): string {
  const value = (v: unknown): unknown => {
    if (v instanceof Map) {
      return [...v].map(([k, x]) => [value(k), value(x)]);
    }
    if (v instanceof Set) {
      return [...v].map(value);
    }
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if ('_item' in o && '_start' in o) {
        return `node ${idOf(o._item as Item | null)}`;
      }
      if ('id' in o && 'content' in o && 'parent' in o) {
        return `item ${idOf(o as unknown as Item)}`;
      }
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map(k => [
            k,
            k === 'cs' ? `cs ${(o.cs as {key: string}).key}` : value(o[k]),
          ]),
      );
    }
    return v;
  };
  return JSON.stringify({
    csByKey: value(state.csByKey),
    holders: value(state.holders),
    ids: {
      holdersOf: value(state.ids.holdersOf),
      repeatedIds: value(state.ids.repeatedIds),
      storedIdOf: value(state.ids.storedIdOf),
      touchedIds: value(state.ids.touchedIds),
    },
    inlineRunStart: value(state.inlineRunStart),
    refresh: value(state.refresh),
    segments: value(state.segments),
    unitByEnd: value(state.unitByEnd),
    unitByKey: value(state.unitByKey),
    yByKey: value(state.yByKey),
  });
}

const stateOf = (p: Peer) => (p.binding as unknown as {state: State}).state;

async function start(gc: boolean) {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append($create(TextNode).setTextContent('x')),
        $createParagraphNode().append(
          $create(TextNode).setTextContent('left'),
          $create(AttemptBox).append($create(TextNode).setTextContent('abc')),
        ),
        $createParagraphNode().append(
          $create(TextNode).setTextContent('separator'),
        ),
      ),
    {gc, ids: [1, 2, 3], nodes: [...NODES, AttemptBox]},
  );
  onTestFinished(() => t.peers.forEach(p => p.stop()));
  const {a, b} = t;
  const $box = () =>
    $getRoot()
      .getAllTextNodes()
      .find(n => n.getParent() instanceof AttemptBox)!
      .getParentOrThrow() as AttemptBox;
  a.update(() => {
    const n = $box().getFirstChildOrThrow() as TextNode;
    n.select(1, 1);
    $setCompositionKey(n.getKey());
  });
  await t.sync();
  b.update(() => {
    ($box().getFirstChildOrThrow() as TextNode).spliceText(1, 0, 'R');
    $setSelection(null);
  });
  await t.sync();
  // The container moved into the first line (no character typed): with the
  // preflight bypassed, the guard stops the write once it would delete it.
  const $move = () => {
    ($getRoot().getFirstChildOrThrow() as ElementNode).append($box());
    $setSelection(null);
  };
  const endangers = Writer.prototype.$endangersHeld;
  Writer.prototype.$endangersHeld = function (this: Writer) {
    const decided = endangers.call(this);
    return this.tr.doc === a.doc ? false : decided;
  };
  onTestFinished(() => {
    Writer.prototype.$endangersHeld = endangers;
  });
  return {$box, $move, endangers, t};
}

describe('the attempts of a recovery inside the write transaction', () => {
  for (const gc of [false, true]) {
    test(`a restore puts every map of the binding back exactly (gc ${gc ? 'on' : 'off'})`, async () => {
      const {$move, t} = await start(gc);
      const {a} = t;
      const state = stateOf(a);
      const before = serialize(state);
      const restore = state.snapshotMaps();
      // A write that changes the maps (it moves the container and adds a
      // line), as an attempt does before it fails.
      a.update(() => {
        $move();
        $getRoot().append(
          $createParagraphNode().append($create(TextNode).setTextContent('n')),
        );
      });
      expect(serialize(state)).not.toBe(before);
      restore();
      expect(serialize(state)).toBe(before);
    });

    test(`the attempts stop at the cap (the last undone too, so a peer's reply is kept), and the editor shows what is stored (gc ${gc ? 'on' : 'off'})`, async () => {
      const {$move, t} = await start(gc);
      const {a} = t;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => errors.mockRestore());
      const run = Writer.prototype.$run;
      let rewrites = 0;
      Writer.prototype.$run = function (this: Writer) {
        if (this.tr.doc === a.doc && this.rewriteAll) {
          rewrites++;
          throw new Error('every recovery fails');
        }
        return run.call(this);
      };
      onTestFinished(() => {
        Writer.prototype.$run = run;
      });
      // A peer replies to every update A publishes, typing Q into the line
      // the container was moved to: no attempt is ever published, so the
      // reply is never in something a recovery deletes.
      let replied = false;
      const reply = (
        _u: Uint8Array,
        _o: unknown,
        _d: unknown,
        tr: {local: boolean},
      ) => {
        if (!tr.local || replied) {
          return;
        }
        replied = true;
        t.b.update(() => {
          const x = $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent().startsWith('x'))!;
          x.spliceText(x.getTextContentSize(), 0, 'Q');
          $setSelection(null);
        });
      };
      a.doc.on('update', reply);
      a.update($move);
      a.doc.off('update', reply);
      Writer.prototype.$run = run;
      // The attempts inside the transaction, then the one outside it.
      expect(rewrites).toBe(MAX_RECOVERY_ATTEMPTS + 1);
      await t.sync();
      a.update(() => $setCompositionKey(null));
      await t.sync();
      const fresh = await freshReader(a);
      onTestFinished(() => fresh.stop());
      const stored = text(fresh);
      for (const p of t.peers) {
        expect(text(p)).toBe(stored);
      }
      expect(stored.split('R')).toHaveLength(2);
      expect(stored.match(/aR?bc/g)).toHaveLength(1);
      expect(replied).toBe(true);
      expect(stored.split('Q')).toHaveLength(2);
    });

    test(`the undo covers every item a failed attempt inserted (gc ${gc ? 'on' : 'off'})`, async () => {
      const {$move, t} = await start(gc);
      const {a} = t;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => errors.mockRestore());
      // The first write runs whole (nothing else writes meanwhile), then
      // fails: every clock it wrote at is its own.
      const run = Writer.prototype.$run;
      let span: [number, number] | null = null;
      Writer.prototype.$run = function (this: Writer) {
        if (span === null && this.tr.doc === a.doc && !this.rewriteAll) {
          const client = a.doc.clientID;
          const from = a.doc.store.getClock(client);
          try {
            run.call(this);
          } catch (_e) {
            // (The guard's stop.)
          }
          span = [from, a.doc.store.getClock(client)];
          throw new Error('the first write fails once it wrote');
        }
        return run.call(this);
      };
      onTestFinished(() => {
        Writer.prototype.$run = run;
      });
      a.update($move);
      Writer.prototype.$run = run;
      expect(span).not.toBeNull();
      const [from, to] = span!;
      expect(to).toBeGreaterThan(from);
      // Each item the first write inserted is deleted again by the undo.
      for (let clock = from; clock < to; clock++) {
        const item = a.doc.store.getItem(
          createID(a.doc.clientID, clock),
        ) as Item;
        expect(item.deleted).toBe(true);
      }
      await t.sync();
      a.update(() => $setCompositionKey(null));
      await t.sync();
      const fresh = await freshReader(a);
      onTestFinished(() => fresh.stop());
      const stored = text(fresh);
      for (const p of t.peers) {
        expect(text(p)).toBe(stored);
      }
      expect(stored.split('R')).toHaveLength(2);
    });

    test(`however many attempts run, one Yjs update, one warning, one release (gc ${gc ? 'on' : 'off'})`, async () => {
      const {$move, t} = await start(gc);
      const {a} = t;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => errors.mockRestore());
      // The first write fails right after it copies the container, and the
      // first two attempts to recover it fail where they start.
      const fill = Writer.prototype.$fillNode;
      let copy = true;
      Writer.prototype.$fillNode = function (
        this: Writer,
        ...args: Parameters<Writer['$fillNode']>
      ) {
        fill.apply(this, args);
        if (copy && this.tr.doc === a.doc && args[1] instanceof AttemptBox) {
          copy = false;
          throw new Error('a fault after a copy');
        }
      };
      const run = Writer.prototype.$run;
      let entries = 2;
      Writer.prototype.$run = function (this: Writer) {
        if (entries > 0 && this.tr.doc === a.doc && this.rewriteAll) {
          entries--;
          throw new Error('a fault where an attempt starts');
        }
        return run.call(this);
      };
      const proto = YBinding.prototype as unknown as {
        $release: (...args: unknown[]) => unknown;
      };
      const release = proto.$release;
      let releases = 0;
      proto.$release = function (this: unknown, ...args: unknown[]) {
        if (this === a.binding) {
          releases++;
        }
        return release.apply(this, args);
      };
      onTestFinished(() => {
        Writer.prototype.$fillNode = fill;
        Writer.prototype.$run = run;
        proto.$release = release;
      });
      let updates = 0;
      const count = (
        _u: Uint8Array,
        _o: unknown,
        _d: unknown,
        tr: {local: boolean},
      ) => {
        if (tr.local) {
          updates++;
        }
      };
      a.doc.on('update', count);
      let listened = 0;
      const unlisten = a.editor.registerUpdateListener(({dirtyLeaves}) => {
        if (dirtyLeaves.size > 0 || listened === 0) {
          listened++;
        }
      });
      a.warnings.length = 0;
      a.update($move);
      a.doc.off('update', count);
      unlisten();
      expect(copy).toBe(false);
      expect(entries).toBe(0);
      expect(updates).toBe(1);
      expect(
        a.warnings.filter(w => /a local change could not be written/.test(w)),
      ).toHaveLength(1);
      expect(
        a.warnings.filter(w => /would delete or leave behind/.test(w)),
      ).toHaveLength(0);
      expect(listened).toBeGreaterThan(0);
      Writer.prototype.$fillNode = fill;
      Writer.prototype.$run = run;
      await t.sync();
      a.update(() => $setCompositionKey(null));
      await t.sync();
      expect(releases).toBe(1);
      const fresh = await freshReader(a);
      onTestFinished(() => fresh.stop());
      const stored = text(fresh);
      for (const p of t.peers) {
        expect(text(p)).toBe(stored);
      }
      expect(stored.split('R')).toHaveLength(2);
      expect(stored.match(/aR?bc/g)).toHaveLength(1);
      expect(stored.split('left')).toHaveLength(2);
    });
  }
});
