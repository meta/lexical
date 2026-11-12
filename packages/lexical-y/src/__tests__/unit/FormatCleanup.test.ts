/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Yjs cleans up the formats of every type a remote transaction changed that
// has formats, in a transaction of the receiver's own (a write). It deletes
// format items the binding keeps for concurrent edits: text a collaborator
// types into text deleted at the same time keeps the formats it was typed
// with only while those items are there. So the binding writes only to a
// document that never runs it (createYDoc's), and refuses one that does
// (S7-14: a client that applied a stored state to a plain Y.Doc before it
// bound the editor had already deleted a comment's items, and showed an
// agent's insert there without the comment, unlike every other reader).
// While bound, it also opts its containers out, including one this client no
// longer shows (a table it deleted while a peer formatted text in it): Yjs
// never schedules that cleanup for them, and applying the change writes
// nothing.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$addMarkID, $getNodeMarkIDs, MarkStateExtension} from '@lexical/mark';
import {$createTableNodeWithDimensions} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  configExtension,
  createEditor,
  defineExtension,
  type ElementNode,
  type LexicalNode,
  type LexicalWarning,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  createYDoc,
  isYWarning,
  UNSUPPORTED_CONFIG_WARNING,
  YBinding,
  YCollabExtension,
  type YDoc,
} from '../..';
import {
  createYDoc as createHeadlessYDoc,
  editYState,
  type HeadlessYConfig,
  readYState,
  seedYState,
} from '../../headless';
import {$p, $selectIn, flush, setup} from '../utils/harness';

test('a remote format change in a table this client deleted: no format cleanup, nothing written', async () => {
  const {a, b, sync, offline} = await setup(() => {
    const table = $createTableNodeWithDimensions(1, 1, false);
    const cell = (
      table.getFirstChild() as ElementNode
    ).getFirstChild() as ElementNode;
    (cell.getFirstChild() as ElementNode).append(
      $createTextNode('alpha beta gamma'),
    );
    $getRoot().append(table);
  });
  offline();
  b.update(() => {
    ($getRoot().getFirstChild() as ElementNode).remove();
  });
  a.update(() => {
    ($getRoot().getAllTextNodes()[0] as TextNode)
      .select(6, 10)
      .formatText('bold');
  });
  // Whether Yjs would clean up a type B's binding does not map any more.
  const flagged: string[] = [];
  b.doc.on('afterTransaction', (tr: Y.Transaction) => {
    tr.changed.forEach((_subs, type) => {
      if ((type as Y.Node)._hasFormatting) {
        flagged.push(String((type as Y.Node).name));
      }
    });
  });
  const before = (b.doc.store.clients.get(b.doc.clientID) ?? []).length;
  await sync();
  await flush();
  expect(flagged).toEqual([]);
  expect((b.doc.store.clients.get(b.doc.clientID) ?? []).length).toBe(before);
  expect(a.describe()).toBe(b.describe());
});

describe('a document that loads a stored state before the binding (S7-14)', () => {
  const config: HeadlessYConfig = {
    extensions: [MarkStateExtension],
    schemaVersion: 1,
  };

  function $show(node: LexicalNode = $getRoot()): string {
    const ids = $getNodeMarkIDs(node);
    const tag = ids.length > 0 ? `[${ids.join(',')}]` : '';
    if ($isTextNode(node)) {
      const format = node.getFormat();
      return (
        JSON.stringify(node.getTextContent()) +
        (format !== 0 ? `{${format}}` : '') +
        tag
      );
    }
    const children = $isElementNode(node)
      ? node.getChildren().map(child => $show(child))
      : [];
    return node.getKey() === 'root'
      ? children.join(' / ')
      : `${node.getType()}(${children.join(' ')})${tag}`;
  }

  /**
   * "t1z t2z" with comment c3 on "t1z". A collaborator deletes the text
   * while an agent, from the same state, turns "t1z" into "t1015z": the room
   * stores the delete (`stored`), and the agent's insert arrives after it.
   */
  function race(): {
    stored: Uint8Array<ArrayBuffer>;
    insert: Uint8Array<ArrayBuffer>;
  } {
    const seeded = seedYState(config, () => {
      $getRoot().append($p('t1z t2z'));
      $addMarkID('c3', $selectIn([0], 0, 3));
    });
    const deleted = editYState(
      seeded,
      config,
      () => {
        $selectIn([0], 0, 7).removeText();
      },
      {writer: null},
    );
    const typed = editYState(
      seeded,
      config,
      () => {
        $getRoot().getAllTextNodes()[0].setTextContent('t1015z');
      },
      {writer: null},
    );
    return {
      insert: typed.update! as Uint8Array<ArrayBuffer>,
      stored: deleted.state as Uint8Array<ArrayBuffer>,
    };
  }

  function client(doc: YDoc) {
    const warnings: unknown[] = [];
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MarkStateExtension,
          configExtension(YCollabExtension, {
            doc,
            schemaVersion: 1,
            selfCheck: true,
            synced: true,
          }),
        ],
        name: '@lexical/y/test/stored-state',
        onWarn: warning => {
          warnings.push(warning);
        },
      }),
    );
    const {binding} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    const show = () => editor.read(() => $show());
    return {binding, editor, show, warnings};
  }

  const refusals = (warnings: unknown[]) =>
    warnings
      .filter(isYWarning)
      .map(warning => [warning.code, warning.data] as const);

  test('a document from createYDoc(state) shows what a fresh reader shows, the comment on the insert included', async () => {
    const {stored, insert} = race();
    const fresh = readYState(Y.mergeUpdates([stored, insert]), config, $show);
    expect(fresh).toBe('paragraph("015"[c3])');
    const doc = createYDoc(stored);
    const c = client(doc);
    expect(c.show()).toBe('paragraph()');
    Y.applyUpdate(doc, insert);
    await flush();
    expect(c.show()).toBe(fresh);
    expect(c.binding.status).toBe('active');
    expect(c.warnings).toEqual([]);
    c.editor.dispose();
  });

  test('a plain Y.Doc that applied the state has deleted the comment there: the binding refuses it, read only, with a typed warning', async () => {
    const {stored, insert} = race();
    const plain = new Y.Doc();
    Y.applyUpdate(plain, stored);
    // Yjs's cleanup deleted the comment's format items at the deleted text
    // (a write of this document's): the insert reads without the comment
    // for anyone who merges what it sends.
    expect(
      readYState(
        Y.mergeUpdates([Y.encodeStateAsUpdate(plain), insert]),
        config,
        $show,
      ),
    ).toBe('paragraph("015")');
    // Past the type, as a caller without TypeScript.
    const c = client(plain as unknown as YDoc);
    expect(c.binding.status).toBe('readonly');
    expect(c.editor.isEditable()).toBe(false);
    expect(refusals(c.warnings)).toEqual([
      [UNSUPPORTED_CONFIG_WARNING, {reason: 'cleanup-formatting'}],
    ]);
    expect((c.warnings[0] as LexicalWarning).message).toBe(
      'the document cleans up formats: create it with createYDoc() instead of new Y.Doc(). Nothing is written until then',
    );
    // It still shows the document, and writes nothing.
    Y.applyUpdate(plain, insert);
    await flush();
    expect(c.show()).toBe('paragraph("015")');
    const before = Y.encodeStateVector(plain);
    c.editor.update(() => $getRoot().append($p('mine')), {discrete: true});
    await flush();
    expect(Y.encodeStateVector(plain)).toEqual(before);
    c.editor.dispose();
  });

  test('an empty plain Y.Doc is not initialized', async () => {
    const plain = new Y.Doc();
    const c = client(plain as unknown as YDoc);
    await flush();
    expect(c.binding.status).toBe('readonly');
    expect(refusals(c.warnings)).toEqual([
      [UNSUPPORTED_CONFIG_WARNING, {reason: 'cleanup-formatting'}],
    ]);
    expect(plain.get('lexical-y').length).toBe(0);
    expect(Y.encodeStateVector(plain)).toEqual(
      Y.encodeStateVector(new Y.Doc()),
    );
    c.editor.dispose();
  });

  // Randomized: formats and comments over two paragraphs; from that state, a
  // collaborator deletes a range (and maybe moves the first paragraph after
  // the second) while an agent types into the text. The room stores the
  // delete and the move; a client binds `createYDoc(stored)`, and the
  // agent's insert arrives. Set STORED_STATE_FUZZ_SEEDS to run more seeds.
  const SEEDS = Number(process.env.STORED_STATE_FUZZ_SEEDS || 30);
  test.each(Array.from({length: SEEDS}, (_, k) => k + 1))(
    'a client that binds createYDoc(stored) shows what a fresh reader shows, seed %i',
    async seed => {
      let x = seed * 7919;
      const random = (n: number) => {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        return (x >>> 8) % n;
      };
      const texts = ['t1z t2z t3z', 't4z t5z t6z'];
      const range = (p: number): [number, number] => {
        const a = random(texts[p].length);
        return [a, a + 1 + random(texts[p].length - a)];
      };
      const seeded = seedYState(config, () => {
        $getRoot().append($p(texts[0]), $p(texts[1]));
        for (let k = 0; k < 4; k++) {
          const p = random(2);
          const [a, b] = range(p);
          const selection = $selectIn([p], a, b);
          if (random(2) === 0) {
            $addMarkID(`c${k}`, selection);
          } else {
            selection.formatText(random(2) === 0 ? 'bold' : 'italic');
          }
        }
      });
      const edit = ($edit: () => void) =>
        editYState(seeded, config, $edit, {writer: null}).update!;
      const p = random(2);
      const [a, b] = range(p);
      const updates = [edit(() => void $selectIn([p], a, b).removeText())];
      if (random(2) === 0) {
        updates.push(
          edit(() => {
            const [first, second] = $getRoot().getChildren();
            second.insertAfter(first);
          }),
        );
      }
      const q = random(2);
      const at = random(texts[q].length + 1);
      const insert = edit(() => {
        $selectIn([q], at).insertText('t9z');
      });
      const stored = Y.mergeUpdates([
        seeded,
        ...updates,
      ] as Uint8Array<ArrayBuffer>[]);
      const fresh = readYState(
        Y.mergeUpdates([stored, insert] as Uint8Array<ArrayBuffer>[]),
        config,
        $show,
      );
      const doc = createYDoc(stored);
      const c = client(doc);
      Y.applyUpdate(doc, insert);
      await flush();
      expect(c.show()).toBe(fresh);
      expect(c.warnings).toEqual([]);
      c.editor.dispose();
    },
  );

  test('the binding takes only a document createYDoc made, as a type too', () => {
    const editor = createEditor({});
    expect(() =>
      // @ts-expect-error - a plain Y.Doc may have run Yjs's format cleanup
      new YBinding(editor, new Y.Doc(), {schemaVersion: 1}).dispose(),
    ).not.toThrow();
    expect(() =>
      buildEditorFromExtensions(
        // @ts-expect-error - a plain Y.Doc may have run Yjs's format cleanup
        configExtension(YCollabExtension, {doc: new Y.Doc(), schemaVersion: 1}),
      ).dispose(),
    ).not.toThrow();
    // @ts-expect-error - a Y.Doc is not a YDoc without createYDoc
    const forged: YDoc = new Y.Doc();
    expect(forged.cleanupFormatting).toBe(true);
    // One function, from either entry, with `new Y.Doc(options)`'s options.
    expect(createHeadlessYDoc).toBe(createYDoc);
    const doc = createYDoc(null, {gc: false});
    expect(doc.gc).toBe(false);
    expect(doc.cleanupFormatting).toBe(false);
    const plain: Y.Doc = doc;
    expect(plain).toBe(doc);
  });
});
