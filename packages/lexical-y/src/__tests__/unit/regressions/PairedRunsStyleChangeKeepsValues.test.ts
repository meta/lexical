/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

/* eslint-disable @typescript-eslint/no-explicit-any */

// Reproductions (written for the plain-fold window's
// merge), kept as behaviour: read by identity syntax, before the writer's
// layout 3 record arrives, a client shows and keeps the paired values.
//   MUST 1: a style change keeps the paired bold, and the paired set;
//   MUST 2: changing one of two StateConfigs whose keys share a U+001F
//           prefix leaves the other's paired value;
//   MUST 5: an explicit singleton whose member name holds delimiters is
//           written;
//   MUST 4: a style change during a composition keeps the paired value;
//   MUST 6: a paste explicitly carrying the paired value keeps it.
// Each: R's first paired write records layout 3 (bold on "q"); its second
// changes "ax" only over "a"; L gets only the second (no record), changes
// something, and then everything is delivered.

import * as Y from '@y/y';
import {
  $createTextNode,
  $getRoot,
  $getState,
  $getWritableNodeState,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  $setState,
  arraySetValue,
  createState,
  type ElementNode,
  type LexicalEditor,
  type StateConfig,
  stringValue,
  type TextNode,
} from 'lexical';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {
  $p,
  $selectIn,
  flush,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';
import {
  setFormatIdentityWrites,
  setFormatIdentityWritesDefault,
} from '../../utils/noSwitch';

beforeEach(() => {
  setFormatIdentityWritesDefault(false);
});
afterEach(() => setFormatIdentityWritesDefault(false));

const tags = createState('tags', {parse: arraySetValue(stringValue())});
const numericParse = (v: unknown) =>
  Array.isArray(v) ? Object.freeze([...v]) : Object.freeze([]);
const numericState = createState('numeric\u001fstate', {parse: numericParse});
const numericOther = createState('numeric\u001fother', {parse: numericParse});

function register(states: readonly StateConfig<string, unknown>[]) {
  return (editor: LexicalEditor) => {
    const {sharedConfigMap} = (editor as any)._nodes.get(
      'text',
    )!.sharedNodeState;
    for (const state of states) {
      if (!sharedConfigMap.has(state.key)) {
        sharedConfigMap.set(state.key, state);
      }
    }
  };
}

/** The text node holding `token` (the whole text where it is one node). */
function $text(token: string): TextNode {
  const nodes = $getRoot().getAllTextNodes();
  const n =
    nodes.find(x => x.getTextContent() === token) ??
    nodes.find(x => x.getTextContent().includes(token));
  if (!n || !$isTextNode(n)) {
    throw new Error(`no ${token}`);
  }
  return n;
}

const read = <T>(peer: Peer, fn: () => T): T => peer.editor.read(fn);

/**
 * The window: "ax" seeded with `$seed` (written before paired writing), R's
 * two paired writes, L (a) given only the second, then `$change` on L,
 * then everything delivered. Returns L and a fresh reader of L's document.
 */
async function windowRun(
  gc: boolean,
  states: readonly StateConfig<string, unknown>[],
  $seed: (ax: TextNode) => void,
  $second: () => void,
  $change: () => void,
): Promise<{a: Peer; fresh: Peer}> {
  const t = await setup(() => $getRoot().append($p('ax'), $p('q')), {
    delivery: 'sender',
    gc,
    ids: [1, 2],
    prepare: register(states),
  });
  const [a, b] = t.peers;
  a.update(() => $seed($text('ax')));
  await t.sync();
  for (const p of t.peers) {
    setFormatIdentityWrites(p.doc, true);
  }
  b.update(() => {
    $selectIn([1], 0, 1).formatText('bold');
    $setSelection(null);
  });
  b.update($second);
  const list = a.pending.get(b) ?? [];
  a.pending.delete(b);
  Y.applyUpdate(a.doc, list[list.length - 1], a.net);
  await flush();
  a.update($change);
  await flush();
  await t.sync();
  expect(a.doc.get('lexical-y').getAttr('lexical-y:3')).toBe(true);
  return {a, fresh: await freshReader(a)};
}

/** Split "ax" so that "a" and "x" are their own nodes (B's change of "a"). */
function $splitA(): TextNode {
  const ax = $text('ax');
  return ax.splitText(1)[0];
}

/** L's style-only change of every text node of the first line. */
function $styleAll() {
  for (const n of (
    $getRoot().getFirstChildOrThrow() as ElementNode
  ).getAllTextNodes()) {
    n.setStyle('color: red');
  }
}

for (const gc of [false, true]) {
  const g = `gc ${gc ? 'on' : 'off'}`;

  test(`a style change keeps the paired bold on text the editor showed unbolded (${g})`, async () => {
    const {a, fresh} = await windowRun(
      gc,
      [],
      ax => {
        ax.toggleFormat('bold');
      },
      () => {
        // R unbolds only "a".
        $splitA().toggleFormat('bold');
      },
      $styleAll,
    );
    for (const p of [a, fresh]) {
      expect(read(p, () => $text('x').hasFormat('bold'))).toBe(true);
      expect(read(p, () => $text('a').hasFormat('bold'))).toBe(false);
    }
  });

  test(`a style change keeps the paired set on text whose plain set left a member out (${g})`, async () => {
    const {a, fresh} = await windowRun(
      gc,
      [tags as StateConfig<string, unknown>],
      ax => {
        $setState(ax, tags, ['a', 'b']);
      },
      () => {
        // R removes "a" from the set only over "a".
        $setState($splitA(), tags, ['b']);
      },
      $styleAll,
    );
    for (const p of [a, fresh]) {
      expect(read(p, () => $getState($text('x'), tags))).toEqual(['a', 'b']);
      expect(read(p, () => $getState($text('a'), tags))).toEqual(['b']);
    }
  });

  test(`changing one of two StateConfigs under one U+001F prefix leaves the other's paired value (${g})`, async () => {
    const {a, fresh} = await windowRun(
      gc,
      [
        numericState as StateConfig<string, unknown>,
        numericOther as StateConfig<string, unknown>,
      ],
      ax => {
        $setState(ax, numericState, [2]);
        $setState(ax, numericOther, [2]);
      },
      () => {
        // R changes only `state`, only over "a".
        $setState($splitA(), numericState, [1]);
      },
      () => {
        // L changes only `other`, only on "x".
        $setState($text('x'), numericOther, [1]);
      },
    );
    for (const p of [a, fresh]) {
      expect(read(p, () => $getState($text('x'), numericState))).toEqual([2]);
      expect(read(p, () => $getState($text('x'), numericOther))).toEqual([1]);
    }
  });

  test(`an explicit singleton whose member spells the plain entries' signature is written (${g})`, async () => {
    const name = 'a\u0000[1]\u0001s:tags\u001fb';
    const {a, fresh} = await windowRun(
      gc,
      [tags as StateConfig<string, unknown>],
      ax => {
        $setState(ax, tags, ['a', 'b']);
      },
      () => {
        $setState($splitA(), tags, ['b']);
      },
      () => {
        const x = $text('x');
        $getWritableNodeState(x);
        $setState(x, tags, [name]);
        x.setStyle('color: red');
      },
    );
    for (const p of [a, fresh]) {
      expect(read(p, () => $getState($text('x'), tags))).toEqual([name]);
    }
  });
}

/**
 * The numeric fixture: "ax" seeded [2]; R records layout 3 (bold on "q"),
 * then unsets the state on "a" (paired); L gets only the latter. A plain
 * fold would show x the end read as a value, [1]; read by syntax, L's x
 * shows the paired [2]. Returns L, R's undelivered updates for L, and the
 * setup.
 */
async function numericWindow(gc: boolean) {
  const t = await setup(() => $getRoot().append($p('ax'), $p('q')), {
    delivery: 'sender',
    gc,
    ids: [1, 2],
    prepare: register([numericState as StateConfig<string, unknown>]),
  });
  const [a, b] = t.peers;
  a.update(() => {
    $setState($text('ax'), numericState, [2]);
  });
  await t.sync();
  for (const p of t.peers) {
    setFormatIdentityWrites(p.doc, true);
  }
  b.update(() => {
    $selectIn([1], 0, 1).formatText('bold');
    $setSelection(null);
  });
  b.update(() => {
    $setState($splitA(), numericState, []);
  });
  const list = a.pending.get(b) ?? [];
  a.pending.delete(b);
  Y.applyUpdate(a.doc, list[list.length - 1], a.net);
  await flush();
  // Read by syntax (no plain-fold window): L shows the paired value at
  // once, before R's record reaches it.
  expect(read(a, () => $getState($text('x'), numericState))).toEqual([2]);
  return {a, earlier: list.slice(0, -1), t};
}

for (const gc of [false, true]) {
  const g = `gc ${gc ? 'on' : 'off'}`;

  test(`a style change while the record's re-read waits for a composition keeps the paired value (${g})`, async () => {
    const {a, earlier, t} = await numericWindow(gc);
    // L composes in x; then the record arrives (its re-read waits).
    a.update(() => {
      const x = $text('x');
      x.select(1, 1);
      $setCompositionKey(x.getKey());
    });
    await flush();
    for (const u of earlier) {
      Y.applyUpdate(a.doc, u, a.net);
    }
    await flush();
    a.update(() => {
      $text('x').setStyle('color: red');
    });
    await flush();
    a.update(() => {
      $setCompositionKey(null);
    });
    await flush();
    await t.sync();
    const fresh = await freshReader(a);
    for (const p of [a, fresh]) {
      expect(read(p, () => $getState($text('x'), numericState))).toEqual([2]);
    }
  });

  test(`a paste explicitly carrying the paired value after x keeps it (${g})`, async () => {
    const {a, t} = await numericWindow(gc);
    // L pastes "X" carrying [2] right after x.
    a.update(() => {
      const X = $createTextNode('X');
      $setState(X, numericState, [2]);
      $text('x').insertAfter(X);
    });
    await flush();
    await t.sync();
    const fresh = await freshReader(a);
    for (const p of [a, fresh]) {
      expect(read(p, () => $getState($text('X'), numericState))).toEqual([2]);
    }
  });
}
