/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment jsdom

// An app edit made while a remote change is read records this client's
// schema version in the same update (D08), and stays out of undo history
// (D111), whether the writer stores it or, after a failure before anything
// was written, the recovery does: an active older reader receiving the
// updates turns read only with the first update that shows the edit
// (API review round 7: the recovery's own stamp, isolated).

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
import {describe, expect, test, vi} from 'vitest';

import {createYDoc, YBinding} from '../../../index';
import * as RawWrites from '../../../internal/RawWrites';
import {Writer} from '../../../internal/Write';
import {createBoundEditor, flush, NODES, setup} from '../../utils/harness';
import {textOf} from '../../utils/splitFixtures';

const armed = new WeakSet<LexicalEditor>();
const done = new WeakSet<LexicalEditor>();
class EditingText extends TextNode {
  $config() {
    return this.config('read_edit_schema_recovery_text', {extends: TextNode});
  }
  selectionTransform(_prev: BaseSelection | null, _next: RangeSelection) {
    const editor = $getEditor();
    if (
      !armed.has(editor) ||
      done.has(editor) ||
      !$hasUpdateTag(COLLABORATION_TAG)
    )
      return;
    done.add(editor);
    const tail = $getRoot().getAllTextNodes().at(-1)!;
    tail.setTextContent(tail.getTextContent() + '!');
  }
}
for (const gc of [false, true])
  describe(`a read-time app edit records the schema, gc ${gc}`, () => {
    for (const failBeforeWrite of [false, true])
      test(`the stamp comes with the edit, undo stays empty (failure before the write: ${failBeforeWrite})`, async () => {
        const nodes = [...NODES, EditingText];
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                $create(EditingText).setTextContent('selected'),
              ),
              $createParagraphNode().append($createTextNode('remote')),
              $createParagraphNode().append($createTextNode('tail')),
            ),
          {gc, ids: [101, 202], nodes, withBlockIds: false},
        );
        const {a, b} = t;
        const host = document.createElement('div');
        host.contentEditable = 'true';
        document.body.append(host);
        a.editor.setRootElement(host);
        host.focus();
        let upgraded: YBinding | undefined;
        let older: ReturnType<typeof createBoundEditor> | undefined;
        let oldDoc: ReturnType<typeof createYDoc> | undefined;
        let restoreRun: (() => void) | undefined;
        const marking = vi.spyOn(RawWrites, 'markBindingWrite');
        try {
          a.update(() => $getRoot().getAllTextNodes()[0].select(1, 1));
          await t.sync();
          t.offline();
          a.binding.dispose();
          upgraded = new YBinding(a.editor, a.doc, {
            captureTimeout: 0,
            schemaVersion: 2,
            selfCheck: true,
          });
          upgraded.start();
          expect(upgraded.status).toBe('active');
          expect(
            a.doc.get('lexical-y').getAttrs()['lexical-y-schema:2'],
          ).toBeUndefined();
          const parts: Uint8Array<ArrayBuffer>[] = [];
          const collect = (u: Uint8Array) => parts.push(new Uint8Array(u));
          b.doc.on('update', collect);
          b.update(() => {
            $getRoot().getAllTextNodes()[1].setTextContent('remote changed');
            $setSelection(null);
          });
          b.doc.off('update', collect);
          oldDoc = createYDoc(
            Y.mergeUpdates([Y.encodeStateAsUpdate(a.doc), ...parts]),
            {gc},
          );
          older = createBoundEditor(oldDoc, {
            namespace: 'old-schema-reader',
            nodes,
            onError: e => {
              throw e;
            },
            onWarn: () => {},
            schemaVersion: 1,
            selfCheck: true,
            withBlockIds: false,
          });
          older.start();
          expect(older.binding.status).toBe('active');
          let failed = false;
          let recovered = false;
          if (failBeforeWrite) {
            const run = Writer.prototype.$run;
            const stub = vi
              .spyOn(Writer.prototype, '$run')
              .mockImplementation(function (this: Writer) {
                if (done.has(a.editor) && !failed && !this.rewriteAll) {
                  failed = true;
                  // No content was written, so the first finally cannot stamp.
                  expect(
                    a.doc.get('lexical-y').getAttrs()['lexical-y-schema:2'],
                  ).toBeUndefined();
                  throw new Error('a failure before anything is written');
                }
                if (this.rewriteAll) {
                  recovered = true;
                  // Isolate the recovery finalization, with the schema absent.
                  expect(
                    a.doc.get('lexical-y').getAttrs()['lexical-y-schema:2'],
                  ).toBeUndefined();
                }
                return run.call(this);
              });
            restoreRun = () => stub.mockRestore();
          }
          armed.add(a.editor);
          marking.mockClear();
          const authored: Uint8Array<ArrayBuffer>[] = [];
          const authoredUpdate = (u: Uint8Array, origin: unknown) => {
            if (origin !== 'remote-provider') authored.push(new Uint8Array(u));
          };
          const changed: Y.Transaction[] = [];
          const noteChanged = (tr: Y.Transaction) => {
            if (tr.local && tr.changed.size > 0) changed.push(tr);
          };
          a.doc.on('update', authoredUpdate);
          a.doc.on('afterTransaction', noteChanged);
          Y.applyUpdate(a.doc, Y.mergeUpdates(parts), 'remote-provider');
          await flush();
          await flush();
          a.doc.off('update', authoredUpdate);
          a.doc.off('afterTransaction', noteChanged);
          expect(done.has(a.editor)).toBe(true);
          expect(textOf(a.doc.get('lexical-y'))).toContain('tail!');
          expect(authored.length).toBeGreaterThan(0);
          expect(upgraded.undoManager!.undoStack).toHaveLength(0);
          expect(a.doc.get('lexical-y').getAttrs()['lexical-y-schema:2']).toBe(
            true,
          );
          expect(failed).toBe(failBeforeWrite);
          expect(recovered).toBe(failBeforeWrite);
          expect(
            changed.every(tr => marking.mock.calls.some(([m]) => m === tr)),
          ).toBe(true);
          expect(
            a.warnings.some(w => w.includes('unsupported for direct writes')),
          ).toBe(false);
          // Deliver only the new authored updates to an already active older
          // reader. The first update exposing the edit must expose the stamp.
          let receivedEdit = false;
          for (const u of authored) {
            Y.applyUpdate(oldDoc, u, 'schema-2-read-edit');
            if (textOf(oldDoc.get('lexical-y')).includes('tail!')) {
              receivedEdit = true;
              expect(
                oldDoc.get('lexical-y').getAttrs()['lexical-y-schema:2'],
              ).toBe(true);
              expect(older.binding.status).toBe('readonly');
            }
          }
          expect(receivedEdit).toBe(true);
          expect(older.editor.isEditable()).toBe(false);
        } finally {
          restoreRun?.();
          marking.mockRestore();
          older?.binding.dispose();
          oldDoc?.destroy();
          upgraded?.dispose();
          a.editor.setRootElement(null);
          host.remove();
          t.peers.forEach(p => p.stop());
        }
      });
  });
