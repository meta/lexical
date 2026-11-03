/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A relay whose stored state holds a skipped range still migrates (found
// by the migration project's protocol lane as MG-proto-1). Yjs 14 (rc.29)
// integrates an item whose own client's earlier clocks are missing when its
// origins are known, recording a skip; a provider that sends a local update
// before its sync step 2 (y-websocket's order) gives a relay exactly that
// order. The runner splits the skipped range out (the gap, everything after
// it and everything that depends on it) with the pending material, and
// migrates the rest; the state it returns holds no skip.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {migrateYState} from '../../../migrate';
import {createBoundEditor, NODES} from '../../utils/harness';
import {SEED, STAMP, stamp} from '../../utils/migrateSteps';
import {rightOriginSplit, textOf, unitDump} from '../../utils/splitFixtures';

const flush = () => new Promise(r => setTimeout(r, 0));

describe.each([false, true])('gc %s', gc => {
  test('a skipped range in the stored state is split out, and the rest migrates', async () => {
    const doc = createYDoc(null, {gc});
    doc.clientID = 11;
    const b = createBoundEditor(doc, {
      namespace: 't',
      nodes: NODES,
      onError: e => {
        throw e;
      },
      onWarn: () => {},
      selfCheck: true,
      withBlockIds: false,
    });
    b.start();
    b.editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('one')),
            $createParagraphNode().append($createTextNode('two')),
          );
      },
      {discrete: true},
    );
    b.binding.initialize();
    await flush();
    const relay = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
    // A second client edits two paragraphs in two updates.
    const c = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
    c.clientID = 22;
    const cb = createBoundEditor(c, {
      namespace: 't',
      nodes: NODES,
      onError: e => {
        throw e;
      },
      onWarn: () => {},
      selfCheck: true,
      withBlockIds: false,
    });
    cb.start();
    cb.binding.initialize();
    await flush();
    const sent: Uint8Array[] = [];
    c.on('update', (u: Uint8Array) => sent.push(u));
    const append = (i: number, s: string) =>
      cb.editor.update(
        () => {
          const t = (
            $getRoot().getChildAtIndex(i) as ElementNode
          ).getFirstChild() as TextNode;
          t.setTextContent(t.getTextContent() + s);
        },
        {discrete: true},
      );
    append(0, ' X'); // u0: clock 0.. of client 22
    append(1, ' Y'); // u1: later clocks, origins in paragraph 2 only
    await flush();
    expect(sent.length).toBe(2);
    // The relay gets u1 first (u0 rides the sync step 2 still queued).
    Y.applyUpdate(relay, sent[1]);
    const skipped = !relay.store.skips.isEmpty();
    const pending = relay.store.pendingStructs !== null;
    // Barrier: u0 is drained into the quarantine, never applied. Migrate.
    let code: string | null = null;
    let result: ReturnType<typeof migrateYState> | null = null;
    try {
      result = migrateYState(Y.encodeStateAsUpdate(relay), [STAMP], {
        gc,
        to: SEED + 1,
      });
    } catch (e) {
      code = (e as {code?: string}).code ?? String(e);
    }
    expect(result!.receipt.changed).toBe(true);
    expect(result!.pending).not.toBeNull();
    const out = createYDoc(result!.state, {gc});
    expect(out.store.skips.isEmpty()).toBe(true);
    expect(out.store.pendingStructs).toBeNull();
    // The split material and the queued update complete it.
    Y.applyUpdate(out, result!.pending!);
    Y.applyUpdate(out, sent[0]);
    expect(out.store.skips.isEmpty()).toBe(true);
    expect(out.store.pendingStructs).toBeNull();
    // Control: once u0 is applied (a plain relay), the same migration runs.
    Y.applyUpdate(relay, sent[0]);
    // Preservation: the reconstruction (migrated state, split material and
    // the queued update) holds what the plain merge holds, unit by unit
    // (text, formats, attributes, ids, deletions), the second writer's
    // ' Y' included.
    expect(unitDump(out)).toEqual(unitDump(relay));
    expect(textOf(out.get('lexical-y'))).toContain(' Y');
    let after: string | null = null;
    try {
      migrateYState(Y.encodeStateAsUpdate(relay), [STAMP], {gc, to: SEED + 1});
    } catch (e) {
      after = (e as {code?: string}).code ?? String(e);
    }
    expect({after, code, pending, skipped}).toEqual({
      after: null,
      code: null,
      pending: false,
      skipped: true,
    });
  });

  test('the right-origin split: state, split material and the missing prefix hold what the plain merge holds', () => {
    const {stored, missing, docs} = rightOriginSplit(gc);
    const result = migrateYState(stored, [stamp(2)], {gc, to: 3});
    const out = createYDoc(result.state, {gc});
    expect(out.store.skips.isEmpty()).toBe(true);
    expect(out.store.pendingStructs).toBeNull();
    expect(out.store.pendingDs).toBeNull();
    // G and everything of its client, and client 222's suffix, are cut.
    expect(textOf(out.get('lexical-y'))).toBe('base');
    expect(out.store.clients.has(222)).toBe(false);
    expect(out.store.clients.has(333)).toBe(false);
    Y.applyUpdate(out, result.pending!);
    Y.applyUpdate(out, missing);
    const control = createYDoc(stored, {gc});
    Y.applyUpdate(control, missing);
    expect(unitDump(out)).toEqual(unitDump(control));
    expect(textOf(out.get('lexical-y'))).toBe(textOf(control.get('lexical-y')));
    expect(textOf(out.get('side'))).toBe('S');
    expect(textOf(out.get('unseen'))).toBe('missing');
    expect(out.store.skips.isEmpty()).toBe(true);
    [out, control, ...docs].forEach(d => d.destroy());
  });
});
