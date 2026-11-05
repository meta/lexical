/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// An app edit made while a remote change is read (written by
// $writeReadEdits, out of the undo history, D111) carries this client's
// schema version, as any local edit does (D08). It is written with the
// follow-up origin, and the schema record was written only for the binding's
// own origin, so a schema 2 client could store such an edit while schema 1
// readers stayed active. The recovery of such a write that fails part way
// records it too.

import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $hasUpdateTag,
  $setSelection,
  type BaseSelection,
  COLLABORATION_TAG,
  type LexicalEditor,
  type RangeSelection,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../../..';
import {Writer} from '../../../internal/Write';
import {createBoundEditor, flush, NODES, setup} from '../../utils/harness';
import {textOf} from '../../utils/splitFixtures';

const armed = new WeakSet<LexicalEditor>();
const done = new WeakSet<LexicalEditor>();

/** Edits the document's last text when a remote change is read (once armed). */
class EditingText extends TextNode {
  $config() {
    return this.config('read_edit_schema_text', {extends: TextNode});
  }
  selectionTransform(_prev: BaseSelection | null, _next: RangeSelection) {
    const editor = $getEditor();
    if (
      !armed.has(editor) ||
      done.has(editor) ||
      !$hasUpdateTag(COLLABORATION_TAG)
    ) {
      return;
    }
    done.add(editor);
    const tail = $getRoot().getAllTextNodes().at(-1)!;
    tail.setTextContent(tail.getTextContent() + '!');
  }
}

const NODES_WITH_EDITOR = [...NODES, EditingText];

/**
 * A schema 2 binding of A's editor reads a change from B; the app's code
 * edits as it is read. Returns what A wrote for that read (its own updates)
 * and A's binding.
 */
async function readEdit(gc: boolean, failFirstWrite: boolean) {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append(
          $create(EditingText).setTextContent('selected'),
        ),
        $createParagraphNode().append($createTextNode('remote')),
        $createParagraphNode().append($createTextNode('tail')),
      ),
    {gc, ids: [101, 202], nodes: NODES_WITH_EDITOR, withBlockIds: false},
  );
  const {a, b} = t;
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  a.editor.setRootElement(host);
  host.focus();
  a.update(() => $getRoot().getAllTextNodes()[0].select(1, 1));
  await t.sync();
  t.offline();
  // The same app editor, rebound with its newly deployed schema.
  a.binding.dispose();
  const upgraded = new YBinding(a.editor, a.doc, {
    captureTimeout: 0,
    schemaVersion: 2,
    selfCheck: true,
  });
  upgraded.start();
  expect(upgraded.status).toBe('active');
  expect(a.doc.get('lexical-y').getAttrs()['lexical-y-schema:2']).toBe(
    undefined,
  );
  const parts: Uint8Array[] = [];
  const collect = (u: Uint8Array) => parts.push(u);
  b.doc.on('update', collect);
  b.update(() => {
    $getRoot().getAllTextNodes()[1].setTextContent('remote changed');
    $setSelection(null);
  });
  b.doc.off('update', collect);
  armed.add(a.editor);
  // A's state before the read, with B's change it reads: what A writes for
  // the read is applied over it.
  const before = Y.mergeUpdates([
    Y.encodeStateAsUpdate(a.doc),
    ...parts,
  ] as Uint8Array<ArrayBuffer>[]);
  const authored: Uint8Array[] = [];
  const onAuthored = (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote-provider') {
      authored.push(u);
    }
  };
  a.doc.on('update', onAuthored);
  const proto = Writer.prototype as unknown as {$run: () => void};
  const run = proto.$run;
  if (failFirstWrite) {
    // The read-time edit's write writes, then throws: the binding recovers
    // with a rewrite (which does not throw).
    let failed = false;
    proto.$run = function (this: Writer) {
      run.call(this);
      if (!failed && done.has(a.editor)) {
        failed = true;
        throw new Error('simulated writer failure');
      }
    };
  }
  try {
    Y.applyUpdate(
      a.doc,
      Y.mergeUpdates(parts as Uint8Array<ArrayBuffer>[]),
      'remote-provider',
    );
    await flush();
    await flush();
  } finally {
    proto.$run = run;
    a.doc.off('update', onAuthored);
  }
  const dispose = () => {
    upgraded.dispose();
    a.editor.setRootElement(null);
    host.remove();
    t.peers.forEach(p => p.stop());
  };
  return {a, authored, before, dispose, upgraded};
}

describe.each([false, true])(
  'a read-time app edit records the schema, gc %s',
  gc => {
    for (const failFirstWrite of [false, true]) {
      test(`${failFirstWrite ? 'through the recovery of a failed write: ' : ''}its update records lexical-y-schema:2, a schema 1 reader goes read only, and the undo history stays empty`, async () => {
        const {a, authored, before, dispose, upgraded} = await readEdit(
          gc,
          failFirstWrite,
        );
        let older: ReturnType<typeof createBoundEditor> | undefined;
        let oldDoc: ReturnType<typeof createYDoc> | undefined;
        try {
          expect(done.has(a.editor)).toBe(true);
          expect(textOf(a.doc.get('lexical-y'))).toContain('tail!');
          // The failing case went through the recovery's rewrite.
          expect(a.warnings.some(w => w.includes('could not be written'))).toBe(
            failFirstWrite,
          );
          // What A wrote for the read carries its schema version.
          expect(authored.length).toBeGreaterThan(0);
          const probe = createYDoc(before, {gc});
          expect(
            probe.get('lexical-y').getAttrs()['lexical-y-schema:2'],
          ).toBeUndefined();
          for (const u of authored) {
            Y.applyUpdate(probe, u);
          }
          expect(probe.get('lexical-y').getAttrs()['lexical-y-schema:2']).toBe(
            true,
          );
          probe.destroy();
          // Out of the undo history (D111).
          expect(upgraded.undoManager!.undoStack).toHaveLength(0);
          // A schema 1 reader of the result opens it read only.
          oldDoc = createYDoc(Y.encodeStateAsUpdate(a.doc), {gc});
          older = createBoundEditor(oldDoc, {
            namespace: 'schema-1-reader',
            nodes: NODES_WITH_EDITOR,
            onError: e => {
              throw e;
            },
            onWarn: () => {},
            schemaVersion: 1,
            selfCheck: true,
            withBlockIds: false,
          });
          older.start();
          expect(older.binding.status).toBe('readonly');
        } finally {
          older?.binding.dispose();
          oldDoc?.destroy();
          dispose();
        }
      });
    }
  },
);
