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
import {SEED, STAMP} from '../../utils/migrateSteps';

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
    expect(Y.encodeStateVector(out).length).toBeGreaterThan(0);
    // Control: once u0 is applied (a plain relay), the same migration runs.
    Y.applyUpdate(relay, sent[0]);
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
});
