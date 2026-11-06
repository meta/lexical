/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {Peer} from '../utils/harness';

import {buildEditorFromExtensions} from '@lexical/extension';
import {$toggleLink, LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  createEditor,
  defineExtension,
  type ElementNode,
  ParagraphNode,
  type SerializedParagraphNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, LAYOUT_VERSION, YBinding, YCollabExtension} from '../..';
import {
  $block,
  $createBoxNode,
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  NODES,
  setup,
} from '../utils/harness';
import {writeEditorToYDoc} from '../utils/headless';

const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));

/** Content types of one update, decoded. */
function contentKinds(update: Uint8Array): string[] {
  const {structs} = Y.decodeUpdate(update);
  return structs
    .filter(s => s instanceof Y.Item)
    .map(s => (s as Y.Item).content.constructor.name);
}

function captureUpdates(peer: Peer): Uint8Array[] {
  const out: Uint8Array[] = [];
  peer.doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === peer.binding) {
      out.push(u);
    }
  });
  return out;
}

describe('@lexical/y storage', () => {
  test('a container is one sequence: text, markers carrying the line', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $p('one'),
        $createHeadingNode('h2').append($createTextNode('two')),
        $createListNode('number').append($li('three')),
      ),
    );
    const root = t.a.binding.root;
    // A new document records layout 1 (and 2 once it holds a member entry
    // of a set-valued NodeState).
    expect(root.getAttr('lexical-y:1')).toBe(true);
    expect(root.getAttr('lexical-y:2')).toBeUndefined();
    const children = root.toDelta().toJSON().children as {insert: unknown}[];
    expect(
      children.map(c => (typeof c.insert === 'string' ? c.insert : '¶')),
    ).toEqual(['one', '¶', 'two', '¶', 'three', '¶']);
    const markers = root.toArray().filter(c => c instanceof Y.Node) as Y.Node[];
    expect(markers.map(m => m.getAttrs())).toEqual([
      // A marker without a type is a paragraph's.
      {},
      {'p:tag': 'h2', t: 'heading'},
      // listType 'number' is the default: compact JSON omits it.
      {g: 'list', l: 0, t: 'listitem'},
    ]);
    await expectConverged(t.peers);
  });

  test('round-trips every kind of node', async () => {
    const t = await setup(() => {
      $getRoot().append(
        $p('plain'),
        $createQuoteNode().append($createTextNode('quote')),
        $createListNode('bullet').append(
          $li('a'),
          $createListItemNode().append(
            $createListNode('number').append($li('b')),
          ),
          $createListItemNode(true).append($createTextNode('c')),
        ),
        $createTableNode().append(
          $createTableRowNode().append(
            $createTableCellNode().append($p('cell')),
          ),
        ),
        $createBoxNode('t').append($p('boxed')),
        $createParagraphNode().append(
          $createTextNode('bold').toggleFormat('bold'),
          $createTextNode(' tail'),
        ),
      );
      $selectIn([5], 0, 4);
      $toggleLink('https://x');
    });
    await expectConverged(t.peers);
  });

  test('a keystroke writes one small update with one string', async () => {
    const t = await setup(() =>
      $getRoot().append(...Array.from({length: 50}, (_, i) => $p(`line ${i}`))),
    );
    const updates = captureUpdates(t.a);
    t.a.update(() => $selectIn([25], 3).insertText('x'));
    expect(updates.length).toBe(1);
    expect(contentKinds(updates[0])).toEqual(['ContentString']);
    expect(updates[0].length).toBeLessThan(40);
    await expectConverged(t.peers);
  });

  test('Enter is a marker insert, Backspace a marker delete', async () => {
    const t = await setup(() => $getRoot().append($p('Hello world')));
    const updates = captureUpdates(t.a);
    t.a.update(() => $selectIn([0], 5).insertParagraph());
    expect(contentKinds(updates[0]).filter(k => k === 'ContentString')).toEqual(
      [],
    );
    expect(contentKinds(updates[0])).toContain('ContentType');
    t.a.update(() => $selectIn([1], 0).deleteCharacter(true));
    expect(contentKinds(updates[1])).toEqual([]);
    await expectConverged(t.peers, 'paragraph("Hello world")');
  });

  test('heading, list type and indent only change marker attributes', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $p('para'),
        $createListNode('bullet').append($li('a'), $li('b')),
      ),
    );
    const updates = captureUpdates(t.a);
    t.a.update(() =>
      $setBlocksType($selectIn([0], 0), () => $createHeadingNode('h1')),
    );
    t.a.update(() => ($block([1]) as ListNode).setListType('number'));
    t.a.update(() => ($block([1, 1]) as ListItemNode).setIndent(1));
    for (const u of updates) {
      expect(contentKinds(u).every(k => k === 'ContentAny')).toBe(true);
    }
    await expectConverged(t.peers);
  });

  test('a block put in a line is lifted out before it is written', async () => {
    // A quote holds inline content (children: 'inline'): the normalization
    // lifts the list out, so the document holds three lines.
    const t = await setup(() => $getRoot().append($p('x')));
    t.a.update(() =>
      $getRoot().append(
        $createQuoteNode().append(
          $createTextNode('Q'),
          $createListNode('bullet').append($li('in')),
        ),
      ),
    );
    const markers = (
      t.a.binding.root.toArray().filter(c => c instanceof Y.Node) as Y.Node[]
    ).map(m => m.name);
    expect(markers).toEqual(['¶', '¶', '¶']);
    t.offline();
    t.a.update(() => $selectIn([1], 1).insertText('!'));
    t.b.update(() => $selectIn([1], 0).insertText('>'));
    await t.sync();
    await expectConverged(t.peers);
  });

  test('a link subclass that is not schema-complete keeps its fields (stored as a node)', async () => {
    class MentionLinkNode extends LinkNode {
      __entity = '';
      static getType() {
        return 'mention_link';
      }
      static clone(node: MentionLinkNode) {
        const n = new MentionLinkNode(node.__url, {}, node.__key);
        n.__entity = node.__entity;
        return n;
      }
      static importJSON(json: Record<string, unknown>) {
        const n = new MentionLinkNode(json.url as string);
        n.__entity = json.entity as string;
        return n;
      }
      exportJSON() {
        return {
          ...super.exportJSON(),
          entity: this.__entity,
          type: 'mention_link',
        };
      }
    }
    const nodes = [...NODES, MentionLinkNode];
    const t = await setup(
      () => {
        const m = new MentionLinkNode('https://u');
        m.__entity = 'u1';
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('hi '),
            m.append($createTextNode('@u')),
          ),
        );
      },
      {nodes},
    );
    const fresh = await freshReader(t.a, nodes);
    for (const peer of [t.b, fresh]) {
      expect(
        peer.read(() => {
          const p = $getRoot().getFirstChild() as ElementNode;
          return (p.getLastChild() as MentionLinkNode).__entity;
        }),
      ).toBe('u1');
    }
  });

  test('a paragraph subclass with a hand-written exportJSON is a node and keeps its field', async () => {
    class UniqParagraphNode extends ParagraphNode {
      __id = '';
      static getType() {
        return 'uniq_paragraph';
      }
      static clone(node: UniqParagraphNode) {
        const n = new UniqParagraphNode(node.__key);
        n.__id = node.__id;
        return n;
      }
      static importJSON(json: SerializedParagraphNode & {id: string}) {
        const n = new UniqParagraphNode().updateFromJSON(json);
        n.__id = json.id;
        return n;
      }
      exportJSON() {
        return {
          ...super.exportJSON(),
          id: this.__id,
          type: 'uniq_paragraph',
        } as SerializedParagraphNode & {id: string};
      }
    }
    const nodes = [...NODES, UniqParagraphNode];
    const t = await setup(
      () => {
        const p = new UniqParagraphNode();
        p.__id = 'p-7';
        $getRoot().append(p.append($createTextNode('text')));
      },
      {nodes},
    );
    t.offline();
    t.a.update(() => $selectIn([0], 2).insertText('!'));
    t.b.update(() => $selectIn([0], 4).insertText('?'));
    await t.sync();
    await expectConverged(t.peers);
    expect(
      t.b.read(() => ($getRoot().getFirstChild() as UniqParagraphNode).__id),
    ).toBe('p-7');
  });

  test('a document marked with a newer layout version is read only', async () => {
    const doc = createYDoc();
    doc.get('lexical-y').setAttr('lexical-y:' + (LAYOUT_VERSION + 1), true);
    const warnings: string[] = [];
    const editor = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
      onWarn: e => warnings.push(e.message),
    });
    const binding = new YBinding(editor, doc, {
      schemaVersion: 1,
      selfCheck: true,
    });
    binding.start();
    expect(binding.status).toBe('readonly');
    expect(editor.isEditable()).toBe(false);
    expect(warnings.length).toBe(1);
  });

  test('initialization refuses a document with content in another root', async () => {
    const doc = createYDoc();
    doc.get('root-v2').insert(0, 'old layout');
    const warnings: string[] = [];
    const editor = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
      onWarn: e => warnings.push(e.message),
    });
    const binding = new YBinding(editor, doc, {
      schemaVersion: 1,
      selfCheck: true,
    });
    binding.start();
    binding.initialize();
    expect(binding.status).toBe('readonly');
    expect(doc.get('lexical-y').getAttrs()).toEqual({});
  });

  test('nothing is written before initialization', async () => {
    const doc = createYDoc();
    const editor = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    const binding = new YBinding(editor, doc, {
      schemaVersion: 1,
      selfCheck: true,
    });
    binding.start();
    editor.update(() => $getRoot().append($p('local')), {discrete: true});
    expect(doc.get('lexical-y').length).toBe(0);
    binding.initialize();
    expect(binding.status).toBe('active');
    expect(doc.get('lexical-y').length).toBe(6);
  });

  test('headless writer and extension', async () => {
    const source = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    source.update(
      () =>
        $getRoot().append(
          $p('converted'),
          $createQuoteNode().append($createTextNode('q')),
        ),
      {discrete: true},
    );
    const doc = createYDoc();
    writeEditorToYDoc(source, doc);
    const peerDoc = createYDoc();
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(doc));
    const reader = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          configExtension(YCollabExtension, {
            doc: peerDoc,
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: 'reader',
        nodes: NODES,
      }),
    );
    expect(
      reader.getEditorState().read(() => $getRoot().getTextContent()),
    ).toBe('converted\n\nq');
    reader.update(() => $selectIn([0], 9).insertText('!'), {discrete: true});
    expect(peerDoc.get('lexical-y').toDelta().toJSON().children![0]).toEqual({
      insert: 'converted!',
      type: 'insert',
    });
    reader.dispose();
  });
});

describe('@lexical/y undo', () => {
  test('undo of a split after a peer typed in the second half', async () => {
    const t = await setup(() => $getRoot().append($p('Hello world')));
    t.a.update(() => $selectIn([0], 5).insertParagraph());
    await t.sync();
    t.b.update(() => $selectIn([1], 6).insertText('!'));
    await t.sync();
    t.a.undo();
    await t.sync();
    await expectConverged(t.peers, 'paragraph("Hello world!")');
  });

  test('undo of a heading toggle after a peer typed', async () => {
    const t = await setup(() => $getRoot().append($p('Title')));
    t.a.update(() =>
      $setBlocksType($selectIn([0], 0), () => $createHeadingNode('h1')),
    );
    await t.sync();
    t.b.update(() => $selectIn([0], 5).insertText('!'));
    await t.sync();
    t.a.undo();
    await t.sync();
    await expectConverged(t.peers, 'paragraph("Title!")');
  });

  test('undo of a list indent after a peer typed', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createListNode('bullet').append($li('one'), $li('two')),
      ),
    );
    t.a.update(() => ($block([0, 1]) as ListItemNode).setIndent(1));
    await t.sync();
    t.b.update(() => $selectIn([0, 1, 0, 0], 3).insertText('!'));
    await t.sync();
    t.a.undo();
    await t.sync();
    await expectConverged(
      t.peers,
      'list[bullet](listitem("one") listitem("two!"))',
    );
  });

  test('undo and redo of typing', async () => {
    const t = await setup(() => $getRoot().append($p('abc')));
    t.a.update(() => $selectIn([0], 3).insertText('def'));
    t.a.undo();
    await t.sync();
    await expectConverged(t.peers, 'paragraph("abc")');
    t.a.binding.redo();
    await t.sync();
    await expectConverged(t.peers, 'paragraph("abcdef")');
  });

  test('undo of inserting a box keeps it when a peer typed inside', async () => {
    const t = await setup(() => $getRoot().append($p('before')));
    t.a.update(() => $getRoot().append($createBoxNode('b').append($p('box'))));
    await t.sync();
    t.b.update(() => $selectIn([1, 0], 3).insertText('!'));
    await t.sync();
    t.a.undo();
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read(() => $getRoot().getTextContent()).includes('!')).toBe(
      true,
    );
  });
});

describe('@lexical/y cursors', () => {
  test('points round trip through relative positions', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $p('first'),
        $createListNode('bullet').append($li('item')),
        $createTableNode().append(
          $createTableRowNode().append(
            $createTableCellNode().append($p('cell')),
          ),
        ),
      ),
    );
    for (const [path, offset] of [
      [[0], 3],
      [[1, 0], 2],
      [[2, 0, 0, 0], 4],
    ] as [number[], number][]) {
      t.a.update(() => $selectIn(path, offset));
      const cursor = t.a.binding.getCursor()!;
      expect(cursor).not.toBe(null);
      const resolved = t.b.read(() => {
        const r = t.b.binding.$resolveCursor(cursor);
        return r === null
          ? null
          : [r.anchor.getNode().getTextContent(), r.anchor.offset];
      });
      expect(resolved).toEqual([
        t.a.read(() => $block(path).getTextContent()),
        offset,
      ]);
    }
  });

  test('a remote cursor follows its characters across a concurrent split', async () => {
    const t = await setup(() => $getRoot().append($p('Hello world')));
    t.b.update(() => $selectIn([0], 8));
    const cursor = t.b.binding.getCursor()!;
    t.a.update(() => $selectIn([0], 5).insertParagraph());
    await t.sync();
    const resolved = t.b.read(() => {
      const r = t.b.binding.$resolveCursor(cursor)!;
      return [r.anchor.getNode().getTextContent(), r.anchor.offset];
    });
    expect(resolved).toEqual([' world', 3]);
  });
});
