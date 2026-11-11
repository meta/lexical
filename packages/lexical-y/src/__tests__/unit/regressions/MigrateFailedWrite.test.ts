/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A local write that throws part way (an app's NodeState serializer of a
// node it writes) is recovered by a rewrite. As on main, that rewrite can
// insert again what the failed attempt had already inserted (#9775): the
// cells pinning that are expected failures. What the recovery must keep
// doing, and does: never lose committed content, and never delete an app's
// own write made inside the failing write.

import {
  $createHorizontalRuleNode,
  buildEditorFromExtensions,
} from '@lexical/extension';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setState,
  createState,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

import {createYDoc, YBinding} from '../../..';
import {Writer} from '../../../internal/Write';
import {catalogAppExtension} from '../../catalog/bind';
import {rawDoc, SEED} from '../../utils/migrateSteps';
import {
  $body,
  $component,
  CardNode,
  ChipNode,
  ComponentNode,
  SlotBodyNode,
} from '../../utils/slots';
import {textOf} from '../../utils/splitFixtures';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const count = (text: string, s: string) => text.split(s).length - 1;

describe.each([false, true])('a write that fails part way, gc %s', gc => {
  /**
   * A bound editor on `abc`, with a NodeState field whose serializer
   * throws `fails` times while the binding writes (and runs `during` first).
   */
  function setup(options: {
    schemaVersion?: number;
    fails?: number;
    during?: () => void;
  }) {
    const doc = createYDoc(rawDoc(SEED), {gc});
    const root = doc.get('lexical-y');
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [catalogAppExtension({blockIds: 'absent'})],
        name: 'failed-write',
        nodes: [CardNode, ChipNode, ComponentNode, SlotBodyNode],
        onError: () => {},
        onWarn: () => {},
      }),
    );
    const binding = new YBinding(editor, doc, {
      schemaVersion: options.schemaVersion ?? 1,
    });
    binding.start();
    binding.initialize();
    let writing = false;
    const original = Writer.prototype.$run;
    const spy = vi.spyOn(Writer.prototype, '$run').mockImplementation(function (
      this: Writer,
    ) {
      const before = writing;
      writing = true;
      try {
        return original.call(this);
      } finally {
        writing = before;
      }
    });
    let fails = options.fails ?? 1;
    const field = createState('failed-write-field', {
      parse: v => (typeof v === 'string' ? v : ''),
      unparse: v => {
        if (fails > 0 && writing) {
          fails--;
          if (options.during !== undefined) {
            options.during();
          }
          throw new Error('app serialization failed');
        }
        return v;
      },
    });
    const edit = (fn: () => void) => {
      try {
        editor.update(fn, {discrete: true});
      } finally {
        spy.mockRestore();
      }
    };
    const rootTypes = () => {
      const types: string[] = [];
      for (let it = root._start; it !== null; it = it.right) {
        if (!it.deleted && it.content instanceof Y.ContentType) {
          types.push((it.content.type as Y.Node).name);
        }
      }
      return types;
    };
    const fresh = () => {
      const copy = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
      const text = textOf(copy.get('lexical-y'));
      copy.destroy();
      return text;
    };
    const dispose = () => {
      binding.dispose();
      editor.dispose();
      doc.destroy();
    };
    return {
      binding,
      dispose,
      doc,
      edit,
      editor,
      failed: () => fails === 0,
      field,
      fresh,
      root,
      rootTypes,
    };
  }

  // #9775: the serializer runs after its node's content (or the content
  // before it) was inserted; the recovery inserts that content again.
  const SHAPES: [string, (t: ReturnType<typeof setup>) => void, string][] = [
    [
      // A top-level line's marker fields, after its text.
      'a line marker',
      t => {
        const p = $createParagraphNode().append($createTextNode('mine'));
        $setState(p, t.field, 'value');
        $getRoot().append(p);
      },
      'mine',
    ],
    [
      // A block node's fields, after the new line before it.
      'a block node',
      t => {
        const hr: LexicalNode = $createHorizontalRuleNode();
        $setState(hr, t.field, 'value');
        $getRoot().append(
          $createParagraphNode().append($createTextNode('mine')),
          hr,
        );
      },
      'mine',
    ],
    [
      // An inline decorator's fields, after its line's text.
      'an inline decorator',
      t => {
        const chip = $create(ChipNode);
        $setState(chip, t.field, 'value');
        $getRoot().append(
          $createParagraphNode().append($createTextNode('TAIL'), chip),
        );
      },
      'TAIL',
    ],
    [
      // A child of a new container, after the container was inserted.
      'a child of a new container',
      t => {
        const p = $createParagraphNode().append($createTextNode('CHILD'));
        $setState(p, t.field, 'value');
        $getRoot().append(
          $createParagraphNode().append($createTextNode('mine')),
          $create(CardNode).append(p),
        );
      },
      'mine',
    ],
    [
      // A table cell's fields, after the table was inserted.
      'a table cell',
      t => {
        const cell = $createTableCellNode().append(
          $createParagraphNode().append($createTextNode('CELL')),
        );
        $setState(cell, t.field, 'value');
        $getRoot().append(
          $createParagraphNode().append($createTextNode('mine')),
          $createTableNode().append($createTableRowNode().append(cell)),
        );
      },
      'mine',
    ],
    [
      // A named slot's value, after its host was inserted.
      'a named slot',
      t => {
        const body = $body(
          $createParagraphNode().append($createTextNode('SLOT')),
        );
        $setState(body, t.field, 'value');
        $getRoot().append(
          $createParagraphNode().append($createTextNode('mine')),
          $component({body}),
        );
      },
      'mine',
    ],
  ];
  for (const [shape, write, once] of SHAPES) {
    test.fails(
      `#9775: ${shape}'s serializer throws part way: the recovery stores '${once}' once`,
      async () => {
        const t = setup({});
        t.edit(() => write(t));
        await flush();
        expect(t.failed()).toBe(true);
        expect(count(textOf(t.root), once)).toBe(1);
        expect(count(t.fresh(), once)).toBe(1);
        t.dispose();
      },
    );
  }

  // A text node's fields are serialized before its line is inserted: a
  // throw there leaves nothing for the recovery to write again.
  test("a text node's serializer throws, after a new line earlier in the container: nothing twice", async () => {
    const t = setup({});
    t.edit(() => {
      const r = $getRoot();
      r.getFirstChildOrThrow().insertBefore(
        $createParagraphNode().append($createTextNode('PREFIX')),
      );
      const text = $createTextNode('TAIL');
      $setState(text, t.field, 'value');
      r.append($createParagraphNode().append(text));
    });
    await flush();
    expect(t.failed()).toBe(true);
    expect(count(textOf(t.root), 'PREFIX')).toBe(1);
    expect(count(textOf(t.root), 'TAIL')).toBe(1);
    expect(count(t.fresh(), 'PREFIX')).toBe(1);
    t.dispose();
  });

  // #9775 under D08: a client's first write at its schema version, a peer's
  // newer schema arriving during it.
  test.fails(
    "#9775: D08 at a client's first write at its version, a block serializer throws part way: the recovery stores the text once",
    async () => {
      const t = setup({schemaVersion: 2});
      t.root.setAttr('lexical-y-schema:1', true);
      const peer = createYDoc(Y.encodeStateAsUpdate(t.doc), {gc});
      peer.get('lexical-y').setAttr('lexical-y-schema:3', true);
      const bump = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(t.doc));
      t.edit(() => {
        const hr: LexicalNode = $createHorizontalRuleNode();
        $setState(hr, t.field, 'value');
        $getRoot().append(
          $createParagraphNode().append($createTextNode('mine')),
          hr,
        );
        Y.applyUpdate(t.doc, bump, 'remote');
      });
      await flush();
      expect(t.root.getAttr('lexical-y-schema:2')).toBe(true);
      expect(textOf(t.root)).toBe('abcmine');
      peer.destroy();
      t.dispose();
    },
  );

  // An app's own write made inside the failing write (from the serializer,
  // or earlier in the app's transaction) is never deleted.
  for (const mode of [
    'nested-same',
    'nested-other',
    'earlier-same',
    'nested-same-refused',
  ] as const) {
    test(`an app's own write (${mode}) around a failing block serializer is kept`, async () => {
      let t: ReturnType<typeof setup> | null = null;
      const insertKeep = (target: Y.Node) =>
        t!.doc.transact(
          () => target.insert(target.length, 'KEEP'),
          'nested-app-write',
        );
      t = setup({
        during: () => {
          if (mode.startsWith('nested')) {
            insertKeep(mode === 'nested-other' ? t!.doc.get('other') : t!.root);
          }
          if (mode.endsWith('refused')) {
            t!.root.setAttr('lexical-y-schema:2', true);
          }
        },
      });
      const s = t;
      const write = () =>
        s.edit(() => {
          const hr: LexicalNode = $createHorizontalRuleNode();
          $setState(hr, s.field, 'value');
          $getRoot().append(
            $createParagraphNode().append($createTextNode('mine')),
            hr,
          );
        });
      if (mode.startsWith('earlier')) {
        s.doc.transact(() => {
          insertKeep(s.root);
          write();
        }, 'app-outer');
      } else {
        write();
      }
      await flush();
      expect(s.failed()).toBe(true);
      const name = mode === 'nested-other' ? 'other' : 'lexical-y';
      expect(textOf(s.doc.get(name))).toContain('KEEP');
      const copy = createYDoc(Y.encodeStateAsUpdate(s.doc), {gc});
      expect(textOf(copy.get(name))).toContain('KEEP');
      copy.destroy();
      expect(textOf(s.root).startsWith('abc')).toBe(true);
      s.dispose();
    });
  }

  // A move or a replacement whose block serializer throws, with the
  // recovery succeeding, throwing too or refused: no committed content the
  // edit kept is lost.
  for (const mode of [
    'move-recover',
    'move-fail-twice',
    'replace-refused',
  ] as const) {
    test(`a ${mode.startsWith('move') ? 'move' : 'replacement'} whose block serializer throws (${mode}): no committed content lost`, async () => {
      let root: Y.Node | null = null;
      const t = setup({
        during: () => {
          if (mode === 'replace-refused') {
            root!.setAttr('lexical-y-schema:2', true);
          }
        },
        fails: mode === 'move-fail-twice' ? 2 : 1,
      });
      root = t.root;
      t.editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('BBB')),
          );
        },
        {discrete: true},
      );
      t.edit(() => {
        const lexRoot = $getRoot();
        if (mode === 'replace-refused') {
          lexRoot
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('replacement')),
            );
        } else {
          lexRoot.append(lexRoot.getFirstChildOrThrow());
        }
        const hr: LexicalNode = $createHorizontalRuleNode();
        $setState(hr, t.field, 'value');
        lexRoot.append(
          $createParagraphNode().append($createTextNode('mine')),
          hr,
        );
      });
      await flush();
      expect(t.failed()).toBe(true);
      const text = textOf(t.root);
      if (mode === 'replace-refused') {
        expect(text).toContain('replacement');
      } else {
        expect(count(text, 'abc')).toBeGreaterThanOrEqual(1);
        expect(count(text, 'BBB')).toBeGreaterThanOrEqual(1);
      }
      expect(t.fresh()).toBe(text);
      t.dispose();
    });
  }
});
