/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A write refused at write time is not a read-only state. On an active
// binding, a local change refused because its own transaction changed the
// layout or schema record is reported as UNSUPPORTED_EDIT_WARNING
// {reason: 'refused-at-write', record}; the binding may stay active (when
// the record is put back). 'read-only' keeps meaning a change refused
// because the binding is read only.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  createYDoc,
  LAYOUT_VERSION,
  RAW_YJS_WRITE_WARNING,
  UNSUPPORTED_EDIT_WARNING,
  UNSUPPORTED_LAYOUT_WARNING,
  UNSUPPORTED_SCHEMA_WARNING,
  YBinding,
} from '../../..';
import {catalogAppExtension} from '../../catalog/bind';
import {rawDoc, SEED} from '../../utils/migrateSteps';
import {textOf} from '../../utils/splitFixtures';

const CFG = {blockIds: 'absent'} as const;
type Warning = {code?: string; data?: Record<string, unknown>};

function bind(gc: boolean, state: Uint8Array = rawDoc(SEED)) {
  const doc = createYDoc(state, {gc});
  const warnings: Warning[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(CFG)],
      name: 'refused-at-write',
      onError: e => {
        throw e;
      },
      onWarn: w => {
        // The app's record changes are raw writes (development); not what
        // these cells look at.
        if ((w as Warning).code !== RAW_YJS_WRITE_WARNING) {
          warnings.push(w as Warning);
        }
      },
    }),
  );
  const binding = new YBinding(editor, doc, {schemaVersion: 1});
  binding.start();
  binding.initialize();
  const append = () =>
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('forbidden')),
        );
      },
      {discrete: true},
    );
  const dispose = () => {
    binding.dispose();
    editor.dispose();
    doc.destroy();
  };
  return {append, binding, dispose, doc, root: doc.get('lexical-y'), warnings};
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const of = (warnings: Warning[]) =>
  warnings.map(w => [w.code, w.data?.reason, w.data?.record]);

describe.each([false, true])('a write refused at write time, gc %s', gc => {
  test("the record changed around the write and put back: 'refused-at-write' (layout), and the binding stays active", async () => {
    const t = bind(gc);
    expect(t.binding.status).toBe('active');
    t.doc.transact(() => {
      t.root.setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
      t.append();
      t.root.deleteAttr(`lexical-y:${LAYOUT_VERSION + 1}`);
    }, 'app');
    await flush();
    expect(textOf(t.root)).not.toContain('forbidden');
    expect(t.binding.status).toBe('active');
    expect(of(t.warnings)).toEqual([
      [UNSUPPORTED_EDIT_WARNING, 'refused-at-write', 'layout'],
    ]);
    t.dispose();
  });

  test("a schema record a listener writes at the write's start: 'refused-at-write' (schema), after the schema warning", async () => {
    const t = bind(gc);
    let done = false;
    t.doc.on('beforeTransaction', () => {
      if (!done) {
        done = true;
        t.root.setAttr('lexical-y-schema:9', true);
      }
    });
    t.append();
    await flush();
    expect(textOf(t.root)).not.toContain('forbidden');
    expect(of(t.warnings)).toEqual([
      [UNSUPPORTED_SCHEMA_WARNING, 'newer', undefined],
      [UNSUPPORTED_EDIT_WARNING, 'refused-at-write', 'schema'],
    ]);
    t.dispose();
  });

  test("the record stays changed: the binding's own read-only warning, then 'refused-at-write'", async () => {
    const t = bind(gc);
    t.doc.transact(() => {
      t.root.setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
      t.append();
    }, 'app');
    await flush();
    expect(textOf(t.root)).not.toContain('forbidden');
    expect(t.binding.status).toBe('readonly');
    // The binding's own read-only cause first (it names why), then the
    // refusal, which is not reported as 'read-only'.
    expect(of(t.warnings)).toEqual([
      [UNSUPPORTED_LAYOUT_WARNING, 'newer', undefined],
      [UNSUPPORTED_EDIT_WARNING, 'refused-at-write', 'layout'],
    ]);
    t.dispose();
  });

  test("a nested admission in an afterTransaction listener does not change the refusal's record", async () => {
    const t = bind(gc);
    t.append();
    await flush();
    const before = textOf(t.root);
    t.warnings.length = 0;
    let injected = false;
    let nested = false;
    // The write's own transaction finds a newer layout record (a listener
    // writes it at its start): refused by the layout.
    const inject = (tr: Y.Transaction) => {
      if (!injected && tr.origin === t.binding) {
        injected = true;
        t.root.setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
      }
    };
    // Before the refusal is reported, an app's listener restores the
    // layout, installs a refusing schema record, calls the exposed undo
    // manager (an admission the schema refuses) and restores it.
    const after = (tr: Y.Transaction) => {
      if (nested || !injected || tr.origin !== t.binding) {
        return;
      }
      nested = true;
      t.doc.transact(() => {
        t.root.deleteAttr(`lexical-y:${LAYOUT_VERSION + 1}`);
        t.root.setAttr('lexical-y-schema:9', true);
        expect(t.binding.undoManager!.undo()).toBeNull();
        t.root.deleteAttr('lexical-y-schema:9');
      }, 'nested-app');
    };
    t.doc.on('beforeTransaction', inject);
    t.doc.on('afterTransaction', after);
    try {
      t.append();
    } finally {
      t.doc.off('beforeTransaction', inject);
      t.doc.off('afterTransaction', after);
    }
    await flush();
    expect(injected).toBe(true);
    expect(nested).toBe(true);
    expect(textOf(t.root)).toBe(before);
    expect(t.binding.status).toBe('active');
    expect(
      of(t.warnings).filter(([code]) => code === UNSUPPORTED_EDIT_WARNING),
    ).toEqual([[UNSUPPORTED_EDIT_WARNING, 'refused-at-write', 'layout']]);
    t.dispose();
  });

  test("control: an edit while the binding is read only is still 'read-only'", async () => {
    const d = createYDoc(rawDoc(SEED), {gc});
    d.get('lexical-y').setAttr('lexical-y-schema:9', true);
    const t = bind(gc, Y.encodeStateAsUpdate(d));
    d.destroy();
    expect(t.binding.status).toBe('readonly');
    t.append();
    await flush();
    expect(of(t.warnings)).toEqual([
      [UNSUPPORTED_SCHEMA_WARNING, 'newer', undefined],
      [UNSUPPORTED_EDIT_WARNING, 'read-only', undefined],
    ]);
    t.dispose();
  });
});
