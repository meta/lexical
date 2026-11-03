/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $defaultIsIdentifiedBlock,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $createListItemNode,
  $createListNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {$createHeadingNode, HeadingNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $create,
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  $setState,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  configExtension,
  createEditor,
  defineExtension,
  type ElementNode,
  type LexicalNode,
  LexicalWarning,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding, YCollabExtension, type YDoc} from '../..';
import {
  $createEquation,
  $p,
  $selectIn,
  EquationNode,
  flush,
  NODES,
  setup,
  WidgetNode,
} from '../utils/harness';
import {writeEditorToYDoc} from '../utils/headless';
import {$body, $component, SLOT_NODES} from '../utils/slots';

function client(doc: YDoc, text: string | null, root?: Y.Node) {
  const warnings: string[] = [];
  const codes: string[] = [];
  const editor = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn: w => {
      warnings.push(w.message);
      codes.push(w instanceof LexicalWarning ? w.code : 'not a LexicalWarning');
    },
  });
  if (text !== null) {
    editor.update(() => $getRoot().clear().append($p(text)), {discrete: true});
  }
  const binding = new YBinding(editor, doc, {
    root,
    schemaVersion: 1,
    selfCheck: true,
  });
  binding.start();
  return {binding, codes, editor, warnings};
}

/** The id main 0823b74 derives for a pristine root seeded with 'Same seed'. */
const PRISTINE_SEED_ID = 4267184775731454;

const text = (editor: ReturnType<typeof createEditor>) =>
  editor.getEditorState().read(() => $getRoot().getTextContent());

describe('@lexical/y initialization', () => {
  test('undo right after initialization does not undo it', async () => {
    const t = await setup(() => $getRoot().append($p('initial content')));
    expect(t.a.binding.undoManager!.canUndo()).toBe(false);
    t.a.binding.undo();
    expect(t.a.describe()).toBe('paragraph("initial content")');
    expect(t.a.binding.root.getAttr('lexical-y:1')).toBe(true);
    t.a.update(() => $selectIn([0], 7).insertText('!'));
    t.a.undo();
    t.a.undo();
    await t.sync();
    expect(t.b.describe()).toBe('paragraph("initial content")');
    expect(t.b.binding.root.getAttr('lexical-y:1')).toBe(true);
  });

  test('two clients initializing with the same content write one copy', () => {
    const d1 = createYDoc();
    const d2 = createYDoc();
    const a = client(d1, 'Same seed');
    const b = client(d2, 'Same seed');
    a.binding.initialize();
    b.binding.initialize();
    // Exchange the concurrent initializations.
    const u1 = Y.encodeStateAsUpdate(d1);
    const u2 = Y.encodeStateAsUpdate(d2);
    Y.applyUpdate(d1, u2);
    Y.applyUpdate(d2, u1);
    expect(text(a.editor)).toBe('Same seed');
    expect(text(b.editor)).toBe('Same seed');
    expect(Y.encodeStateAsUpdate(d1)).toEqual(Y.encodeStateAsUpdate(d2));
    // The clients keep their own ids for later edits.
    expect(d1.clientID).not.toBe(d2.clientID);
  });

  // #9515: every root gets one copy, not only a pristine top-level one.
  type Room =
    | 'a root inside another shared type'
    | 'a root that held text, deleted since'
    | 'a root that held an attribute, deleted since'
    | 'a root inside another shared type that held text, deleted since';
  const ROOMS: Room[] = [
    'a root inside another shared type',
    'a root that held text, deleted since',
    'a root that held an attribute, deleted since',
    'a root inside another shared type that held text, deleted since',
  ];
  /** The room as clients load it, and where its root is. */
  function room(where: Room) {
    const base = createYDoc(null, {gc: false});
    const nested = where.startsWith('a root inside');
    let root: Y.Node = base.get('lexical-y');
    if (nested) {
      root = new Y.Node('editor-root');
      base.get('app').setAttr('editor', root);
    }
    if (where.includes('held text')) {
      root.insert(0, 'gone');
      root.delete(0, 4);
    } else if (where.includes('held an attribute')) {
      root.setAttr('used', true);
      root.deleteAttr('used');
    }
    const rootOf = (d: Y.Doc): Y.Node | undefined =>
      nested ? (d.get('app').getAttr('editor') as Y.Node) : undefined;
    return {base, rootOf};
  }
  for (const where of ROOMS) {
    test(`two clients initializing ${where} with the same content write one copy`, () => {
      const {base, rootOf} = room(where);
      const docs = [
        createYDoc(null, {gc: false}),
        createYDoc(null, {gc: false}),
      ];
      for (const d of docs) {
        Y.applyUpdate(d, Y.encodeStateAsUpdate(base));
      }
      const [a, b] = docs.map(d => client(d, 'Untitled', rootOf(d)));
      a.binding.initialize();
      b.binding.initialize();
      expect(text(a.editor)).toBe('Untitled');
      const u1 = Y.encodeStateAsUpdate(docs[0]);
      const u2 = Y.encodeStateAsUpdate(docs[1]);
      Y.applyUpdate(docs[0], u2);
      Y.applyUpdate(docs[1], u1);
      expect(text(a.editor)).toBe('Untitled');
      expect(text(b.editor)).toBe('Untitled');
      expect(Y.encodeStateAsUpdate(docs[0])).toEqual(
        Y.encodeStateAsUpdate(docs[1]),
      );
      expect(a.warnings).toEqual([]);
      expect(b.warnings).toEqual([]);
      // A fresh reader shows one copy too.
      const d = createYDoc();
      Y.applyUpdate(d, u1);
      Y.applyUpdate(d, u2);
      const reader = client(d, null, rootOf(d));
      reader.binding.initialize();
      expect(text(reader.editor)).toBe('Untitled');
      // The clients keep their own ids for later edits.
      expect(docs[0].clientID).not.toBe(docs[1].clientID);
    });

    test(`two clients initializing ${where} after seeing different changes: one payload per id, both converge`, () => {
      const {base, rootOf} = room(where);
      const docs = [
        createYDoc(null, {gc: false}),
        createYDoc(null, {gc: false}),
      ];
      for (const d of docs) {
        Y.applyUpdate(d, Y.encodeStateAsUpdate(base));
      }
      // The second client has seen a change elsewhere in the document: its
      // write may name other items, so it must not share the first's id.
      const other = createYDoc(null, {gc: false});
      Y.applyUpdate(other, Y.encodeStateAsUpdate(base));
      other.get('comments').setAttr('c1', 'hello');
      Y.applyUpdate(
        docs[1],
        Y.encodeStateAsUpdate(other, Y.encodeStateVector(base)),
      );
      const [a, b] = docs.map(d => client(d, 'Untitled', rootOf(d)));
      a.binding.initialize();
      b.binding.initialize();
      const seeded = (d: Y.Doc) =>
        new Set(
          [...d.store.clients.keys()].filter(
            id => !base.store.clients.has(id) && !other.store.clients.has(id),
          ),
        );
      const [s1, s2] = docs.map(seeded);
      expect(s1.size).toBe(1);
      expect(s2.size).toBe(1);
      expect([...s1][0]).not.toBe([...s2][0]);
      const u1 = Y.encodeStateAsUpdate(docs[0]);
      const u2 = Y.encodeStateAsUpdate(docs[1]);
      Y.applyUpdate(docs[0], u2);
      Y.applyUpdate(docs[1], u1);
      expect(text(a.editor)).toBe(text(b.editor));
      expect(text(a.editor)).toBe('Untitled\n\nUntitled');
    });
  }

  for (const gc of [false, true]) {
    test(`initializing a nested root whose entry was deleted does not throw (gc ${gc})`, () => {
      const doc = createYDoc(null, {gc});
      const root = new Y.Node('editor-root');
      doc.get('app').setAttr('editor', root);
      doc.get('app').deleteAttr('editor');
      const c = client(doc, 'Untitled', root);
      expect(() => c.binding.initialize()).not.toThrow();
      c.binding.dispose();
    });
  }

  test('a pristine root is still written under the same id (older clients share it)', () => {
    const doc = createYDoc();
    const c = client(doc, 'Same seed');
    c.binding.initialize();
    const ids = [...doc.store.clients.keys()].filter(id => id !== doc.clientID);
    expect(ids).toEqual([PRISTINE_SEED_ID]);
  });

  for (const content of [null, 'Same seed']) {
    test(`two clients initializing two different roots with equal content keep both (${content ?? 'empty'})`, () => {
      const d1 = createYDoc(null, {gc: false});
      const d2 = createYDoc(null, {gc: false});
      const a = client(d1, content, d1.get('a'));
      const b = client(d2, content, d2.get('b'));
      a.binding.initialize();
      b.binding.initialize();
      const u1 = Y.encodeStateAsUpdate(d1);
      const u2 = Y.encodeStateAsUpdate(d2);
      Y.applyUpdate(d1, u2);
      Y.applyUpdate(d2, u1);
      const roots = (d: Y.Doc) =>
        JSON.stringify({a: d.get('a').toJSON(), b: d.get('b').toJSON()});
      expect(roots(d1)).toBe(roots(d2));
      for (const name of ['a', 'b']) {
        const d = createYDoc();
        Y.applyUpdate(d, Y.encodeStateAsUpdate(d1));
        const reader = client(d, null, d.get(name));
        reader.binding.initialize();
        expect(reader.binding.status).toBe('active');
        expect(text(reader.editor)).toBe(content ?? '');
      }
    });
  }

  // The initial content's client id is a hash of the items written, and
  // what is written depends on the client's block id configuration (a
  // nested list's id is stored where nested lists are not identified
  // blocks): two clients whose writes differ get different ids, whatever
  // the configuration, so one id never holds two payloads.
  type BlockIdConfig = 'none' | 'default' | 'nested lists';
  function seeder(doc: YDoc, config: BlockIdConfig) {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [
          ...(config === 'none'
            ? []
            : [
                configExtension(BlockIdExtension, {
                  $isIdentifiedBlock:
                    config === 'default'
                      ? $defaultIsIdentifiedBlock
                      : (node: LexicalNode) =>
                          $defaultIsIdentifiedBlock(node) || $isListNode(node),
                }),
              ]),
          configExtension(YCollabExtension, {
            doc,
            schemaVersion: 1,
            selfCheck: false,
          }),
        ],
        name: '@lexical/y/test/seeder',
        nodes: [ListNode, ListItemNode, HeadingNode],
        onError: e => {
          throw e;
        },
      }),
    );
    const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
      .output.binding;
    return {binding, doc, editor};
  }
  /** Per item id: where it is, and its content while not deleted. */
  function structs(doc: Y.Doc): Map<string, [string, string | null]> {
    const id = (i: Y.ID | null) =>
      i === null ? null : `${i.client}:${i.clock}`;
    const out = new Map<string, [string, string | null]>();
    for (const list of doc.store.clients.values()) {
      for (const item of list) {
        if (!(item instanceof Y.Item)) {
          continue;
        }
        const parent = item.parent as Y.Node;
        out.set(id(item.id)!, [
          JSON.stringify([
            item.length,
            parent._item === null ? 'root' : id(parent._item.id),
            item.parentSub,
            id(item.origin),
            id(item.rightOrigin),
          ]),
          // A deleted item's content can be collected (gc).
          item.deleted
            ? null
            : JSON.stringify(
                item.content instanceof Y.ContentType
                  ? (item.content.type as Y.Node).name
                  : item.content.getContent(),
              ),
        ]);
      }
    }
    return out;
  }
  const $seedLists = () => {
    const outer = $createListNode('bullet');
    const wrapper = $createListItemNode();
    const inner = $createListNode('number');
    const leaf = $createListItemNode().append($createTextNode('seed'));
    $getRoot().append(outer.append(wrapper.append(inner.append(leaf))));
    for (const [node, blockId] of [
      [outer, 'rootSeed'],
      [wrapper, 'wrapSeed'],
      [inner, 'nestedSeed'],
      [leaf, 'leafSeed'],
    ] as const) {
      $setState(node, blockIdState, blockId);
    }
  };
  for (const [first, second] of [
    ['none', 'default'],
    ['default', 'nested lists'],
    ['none', 'nested lists'],
    ['default', 'default'],
  ] as [BlockIdConfig, BlockIdConfig][]) {
    for (const gc of [false, true]) {
      test(`two clients initializing the same content with block ids ${first} / ${second} (gc ${gc}): one payload per id, both relay orders converge`, async () => {
        const a = seeder(createYDoc(null, {gc}), first);
        const b = seeder(createYDoc(null, {gc}), second);
        for (const c of [a, b]) {
          c.editor.update($seedLists, {discrete: true, skipTransforms: true});
        }
        a.binding.initialize();
        b.binding.initialize();
        const seeds = [a, b].map(c => [...c.doc.store.clients.keys()]);
        if (first === second) {
          // The same items: one copy.
          expect(seeds[1]).toEqual(seeds[0]);
        }
        const updates = [a, b].map(c => Y.encodeStateAsUpdate(c.doc));
        const relays = [updates, [...updates].reverse()].map(order => {
          const d = createYDoc(null, {gc});
          for (const u of order) {
            Y.applyUpdate(d, u);
          }
          return d;
        });
        // Every id holds one payload wherever it is.
        const all = new Map<string, [string, string | null]>();
        for (const d of [a.doc, b.doc, ...relays]) {
          for (const [k, [where, content]] of structs(d)) {
            const seen = all.get(k);
            if (seen === undefined) {
              all.set(k, [where, content]);
              continue;
            }
            expect(where, k).toBe(seen[0]);
            if (seen[1] === null) {
              seen[1] = content;
            } else if (content !== null) {
              expect(content, k).toBe(seen[1]);
            }
          }
        }
        expect(relays[1].get('lexical-y').toJSON()).toEqual(
          relays[0].get('lexical-y').toJSON(),
        );
        // Exchanged: every client and a fresh reader of either relay show
        // the same content.
        Y.applyUpdate(a.doc, updates[1]);
        Y.applyUpdate(b.doc, updates[0]);
        await new Promise(r => setTimeout(r, 0));
        const fresh = relays.map(d => seeder(d, first));
        for (const f of fresh) {
          f.binding.initialize();
        }
        const shown = [a, b, ...fresh].map(c =>
          c.editor.getEditorState().read(() => $getRoot().getTextContent()),
        );
        expect(new Set(shown).size).toBe(1);
        expect(b.doc.get('lexical-y').toJSON()).toEqual(
          a.doc.get('lexical-y').toJSON(),
        );
        expect(a.doc.get('lexical-y').toJSON()).toEqual(
          relays[0].get('lexical-y').toJSON(),
        );
        for (const c of [a, b, ...fresh]) {
          c.editor.dispose();
        }
      });
    }
  }

  test('the initializing client shows what its seed stores, at once', async () => {
    // Written without the normalization: a heading inside a list item's
    // line, which the document stores as the lines the normalization leaves.
    // The seed is read back like any document, so the editor shows that.
    const doc = createYDoc();
    const a = seeder(doc, 'default');
    a.editor.update(
      () => {
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append(
              $createTextNode('before'),
              $createHeadingNode('h2').append($createTextNode('held')),
              $createTextNode('after'),
            ),
          ),
        );
      },
      {discrete: true, skipTransforms: true},
    );
    a.binding.initialize();
    const fresh = seeder(createYDoc(), 'default');
    Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(doc));
    fresh.binding.initialize();
    expect(a.editor.getEditorState().toJSON()).toEqual(
      fresh.editor.getEditorState().toJSON(),
    );
    expect(text(a.editor)).toBe(text(fresh.editor));
    a.editor.dispose();
    fresh.editor.dispose();
  });

  for (const gc of [false, true]) {
    for (const where of [
      'a pristine root',
      'a root that held an item',
      'a root that held an attribute',
      'a root inside another shared type',
    ] as const) {
      test(`initial content written without transforms, into ${where} (gc ${gc}): the author shows what every reader shows`, async () => {
        // Before: off the pristine root, the content was written but not
        // read back, so a line break written inside a text node stayed one
        // text node on the author while readers showed a line break node.
        const doc = createYDoc(null, {gc});
        const root =
          where === 'a root inside another shared type'
            ? new Y.Node('editor-root')
            : doc.get('lexical-y');
        if (where === 'a root that held an item') {
          root.insert(0, 'old');
          root.delete(0, 3);
        } else if (where === 'a root that held an attribute') {
          root.setAttr('used', true);
          root.deleteAttr('used');
        } else if (where === 'a root inside another shared type') {
          doc.get('app').setAttr('editor', root);
        }
        const author = client(doc, null, root);
        author.editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode('one\ntwo')),
              );
          },
          {discrete: true, skipTransforms: true},
        );
        author.binding.initialize();
        await flush();
        const copy = createYDoc(null, {gc});
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
        const fresh = client(
          copy,
          null,
          where === 'a root inside another shared type'
            ? (copy.get('app').getAttr('editor') as Y.Node)
            : undefined,
        );
        fresh.binding.initialize();
        await flush();
        const children = (c: ReturnType<typeof client>) =>
          c.editor.getEditorState().read(() =>
            $assertNodeType($getRoot().getFirstChildOrThrow(), $isElementNode)
              .getChildren()
              .map(n => n.getType()),
          );
        expect(children(author)).toEqual(['text', 'linebreak', 'text']);
        expect(children(fresh)).toEqual(children(author));
        expect(author.warnings).toEqual([]);
        author.binding.dispose();
        fresh.binding.dispose();
      });
    }
  }

  for (const pristine of [true, false]) {
    test(`the initializing client keeps its selection (${pristine ? 'pristine root, the seed read back' : 'a root that held an attribute'})`, async () => {
      // Before: seeding a pristine root read the seed back and dropped the
      // selection.
      const doc = createYDoc();
      if (!pristine) {
        doc.get('lexical-y').setAttr('used', true);
        doc.get('lexical-y').deleteAttr('used');
      }
      const a = client(doc, null);
      a.editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $p('first'),
              $createParagraphNode().append($createTextNode('hello world')),
            );
          $getRoot().getAllTextNodes()[1].select(2, 7);
        },
        {discrete: true},
      );
      a.binding.initialize();
      await flush();
      const selection = a.editor.getEditorState().read(() => {
        const s = $getSelection();
        return $isRangeSelection(s)
          ? [
              s.anchor.getNode().getTextContent(),
              s.anchor.offset,
              s.focus.offset,
            ]
          : null;
      });
      expect(selection).toEqual(['hello world', 2, 7]);
      expect(text(a.editor)).toBe('first\n\nhello world');
      a.binding.dispose();
    });
  }

  // The read-back keeps the whole selection: a caret's typing format and
  // style (bold toggled before initialization: the next character is bold),
  // and a node selection (a selected block decorator) (R10-B S1).
  for (const pristine of [true, false]) {
    for (const kind of ['caret format', 'node'] as const) {
      test(`the initializing client keeps its ${kind === 'node' ? 'node selection' : "caret's typing format and style"} (${pristine ? 'pristine root' : 'a root that held an attribute'})`, async () => {
        const doc = createYDoc();
        if (!pristine) {
          doc.get('lexical-y').setAttr('used', true);
          doc.get('lexical-y').deleteAttr('used');
        }
        const a = client(doc, null);
        a.editor.update(
          () => {
            const widget = $create(WidgetNode);
            $getRoot().clear().append($p('abcdef'), widget, $p('after'));
            if (kind === 'node') {
              const selection = $createNodeSelection();
              selection.add(widget.getKey());
              $setSelection(selection);
            } else {
              const selection = $getRoot().getAllTextNodes()[0].select(3, 3);
              selection.formatText('bold');
              selection.setStyle('color: red');
            }
          },
          {discrete: true},
        );
        a.binding.initialize();
        await flush();
        if (kind === 'node') {
          expect(
            a.editor.getEditorState().read(() =>
              $getSelection()
                ?.getNodes()
                .map(n => n.getType()),
            ),
          ).toEqual(['test_widget']);
        } else {
          a.editor.update(
            () => {
              $getSelection()!.insertText('X');
            },
            {discrete: true},
          );
          expect(
            a.editor.getEditorState().read(() =>
              $getRoot()
                .getAllTextNodes()
                .map(t => [t.getTextContent(), t.getFormat(), t.getStyle()]),
            ),
          ).toEqual([
            ['abc', 0, ''],
            ['X', 1, 'color: red'],
            ['def', 0, ''],
            ['after', 0, ''],
          ]);
        }
        expect(a.warnings).toEqual([]);
        a.binding.dispose();
      });
    }
  }

  // A node selection is put back by what stores its nodes, not by their
  // position: the read shows a line feed as a line break node, which moves
  // the nodes after it along, so a position named another decorator of the
  // same type, which a Delete then removed (R11-B F-05). A node in a named
  // slot is kept too (R11-B F-01).
  for (const pristine of [true, false]) {
    for (const content of ['x\n', 'x\ny', 'xy']) {
      test(`a node selection after ${JSON.stringify(content)} keeps its decorator (${pristine ? 'pristine root' : 'a root that held an attribute'})`, async () => {
        const doc = createYDoc();
        if (!pristine) {
          doc.get('lexical-y').setAttr('used', true);
          doc.get('lexical-y').deleteAttr('used');
        }
        const a = client(doc, null);
        await flush();
        // Built in another editor and set whole (unparsed): the line feed is
        // still text when the binding initializes.
        const source = createEditor({
          nodes: NODES,
          onError: e => {
            throw e;
          },
        });
        source.update(
          () => {
            const eqs = ['left', 'chosen', 'right'].map($createEquation);
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode(content), ...eqs),
              );
            const selection = $createNodeSelection();
            selection.add(eqs[1].getKey());
            $setSelection(selection);
          },
          {discrete: true},
        );
        a.editor.setEditorState(source.getEditorState());
        await flush();
        expect(
          a.editor
            .getEditorState()
            .read(() => $getRoot().getAllTextNodes()[0].getTextContent()),
        ).toBe(content);
        a.binding.initialize();
        await flush();
        const selected = () =>
          a.editor
            .getEditorState()
            .read(() =>
              ($getSelection()?.getNodes() ?? []).map(n =>
                n instanceof EquationNode ? n.__equation : n.getType(),
              ),
            );
        // A line feed at the end selected 'left' here; one in the middle,
        // nothing.
        expect(selected()).toEqual(['chosen']);
        a.editor.update(
          () => {
            const selection = $getSelection();
            if ($isNodeSelection(selection)) {
              selection.deleteNodes();
            }
          },
          {discrete: true},
        );
        expect(
          a.editor.getEditorState().read(() =>
            $getRoot()
              .getChildren()
              .flatMap(p => (p as ElementNode).getChildren())
              .filter(n => n instanceof EquationNode)
              .map(n => (n as EquationNode).__equation),
          ),
        ).toEqual(['left', 'right']);
        expect(a.warnings).toEqual([]);
        a.binding.dispose();
      });
    }
  }

  for (const pristine of [true, false]) {
    test(`a node selection in a named slot is kept (${pristine ? 'pristine root' : 'a root that held an attribute'})`, async () => {
      const doc = createYDoc();
      if (!pristine) {
        doc.get('lexical-y').setAttr('used', true);
        doc.get('lexical-y').deleteAttr('used');
      }
      const editor = createEditor({
        nodes: SLOT_NODES,
        onError: e => {
          throw e;
        },
      });
      editor.update(
        () => {
          const eq = $createEquation('slotted');
          $getRoot()
            .clear()
            .append(
              $p('top'),
              $component({
                body: $body(
                  $createParagraphNode().append($createTextNode('in '), eq),
                ),
              }),
            );
          const selection = $createNodeSelection();
          selection.add(eq.getKey());
          $setSelection(selection);
        },
        {discrete: true},
      );
      const binding = new YBinding(editor, doc, {
        schemaVersion: 1,
        selfCheck: true,
      });
      binding.start();
      binding.initialize();
      await flush();
      // The selection was dropped here (its node is not under the root).
      expect(
        editor
          .getEditorState()
          .read(() =>
            ($getSelection()?.getNodes() ?? []).map(n =>
              n instanceof EquationNode ? n.__equation : n.getType(),
            ),
          ),
      ).toEqual(['slotted']);
      binding.dispose();
    });
  }

  test('two clients initializing with different content converge', () => {
    const d1 = createYDoc();
    const d2 = createYDoc();
    const a = client(d1, 'First');
    const b = client(d2, 'Second');
    a.binding.initialize();
    b.binding.initialize();
    const u1 = Y.encodeStateAsUpdate(d1);
    const u2 = Y.encodeStateAsUpdate(d2);
    Y.applyUpdate(d1, u2);
    Y.applyUpdate(d2, u1);
    expect(text(a.editor)).toBe(text(b.editor));
    expect(['First\n\nSecond', 'Second\n\nFirst']).toContain(text(a.editor));
  });

  test('update handlers never see the content-derived client id of the initial write', () => {
    const doc = createYDoc();
    const real = doc.clientID;
    const seen: number[] = [];
    // A provider that relays from its update handler sees (and would write
    // follow-ups under) whatever id the document has at that moment.
    doc.on('update', () => seen.push(doc.clientID));
    const c = client(doc, 'hello');
    c.binding.initialize();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([real]));
    // The initial items themselves are under the derived id.
    expect([...doc.store.clients.keys()].some(id => id !== real)).toBe(true);
  });

  test('only older layout roots block initialization', () => {
    const appDoc = createYDoc();
    appDoc.get('comments').setAttr('c1', {text: 'hello'});
    const app = client(appDoc, 'x');
    app.binding.initialize();
    expect(app.binding.status).toBe('active');

    const oldDoc = createYDoc();
    oldDoc.get('root-v2').insert(0, [new Y.Node('paragraph')]);
    const old = client(oldDoc, 'x');
    old.binding.initialize();
    expect(old.binding.status).toBe('readonly');
    expect(old.warnings.length).toBe(1);
    expect(old.codes).toEqual(['@lexical/y/unsupported-layout']);
  });

  test('YCollabExtension forwards convert, selfCheck and selfCheckSample', () => {
    const doc = createYDoc();
    doc.get('root-v2').insert(0, [new Y.Node('paragraph')]);
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          configExtension(YCollabExtension, {
            convert: true,
            doc,
            schemaVersion: 1,
            selfCheck: false,
            selfCheckSample: 0.25,
            synced: true,
          }),
        ],
        name: 'app',
        nodes: NODES,
      }),
    );
    const {binding, status} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    // convert: initializes the layout root next to the old one.
    expect(status.value).toBe('active');
    const options = (binding as unknown as {options: Record<string, unknown>})
      .options;
    expect(options.selfCheck).toBe(false);
    expect(options.selfCheckSample).toBe(0.25);
    editor.dispose();
  });

  test('converting in place next to an older layout root', () => {
    const doc = createYDoc();
    doc.get('root-v2').insert(0, [new Y.Node('paragraph')]);
    const source = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    source.update(() => $getRoot().append($p('converted')), {discrete: true});
    writeEditorToYDoc(source, doc);
    const c = client(doc, null);
    expect(c.binding.status).toBe('active');
    expect(text(c.editor)).toBe('converted');
    expect(() => writeEditorToYDoc(source, doc)).toThrow();
  });

  test('the extension: status signal, undo state, conflicts with history', () => {
    const doc = createYDoc();
    const canUndo: boolean[] = [];
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          configExtension(YCollabExtension, {doc, schemaVersion: 1}),
        ],
        name: 'app',
        nodes: NODES,
        register: ed =>
          ed.registerCommand(
            CAN_UNDO_COMMAND,
            value => {
              canUndo.push(value);
              return false;
            },
            COMMAND_PRIORITY_CRITICAL,
          ),
      }),
    );
    const {binding, status} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    expect(status.value).toBe('pending');
    expect(editor.isEditable()).toBe(false);
    binding.initialize();
    expect(status.value).toBe('active');
    expect(editor.isEditable()).toBe(true);
    editor.update(() => $getRoot().append($p('typed')), {discrete: true});
    expect(canUndo[canUndo.length - 1]).toBe(true);
    editor.dispose();
    expect(() =>
      buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            configExtension(YCollabExtension, {
              doc: createYDoc(),
              schemaVersion: 1,
            }),
            HistoryExtension,
          ],
          name: 'conflict',
        }),
      ),
    ).toThrow();
  });
});
