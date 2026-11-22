/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Node classes outside the plain OSS set: link field edits, subclasses with
// their own JSON schema, classes with a hand-written serialization (stored as
// nodes), values that are objects, and peers that lack a node registration.

import {
  $createAutoLinkNode,
  $createLinkNode,
  $isLinkNode,
  $toggleLink,
  LinkNode,
} from '@lexical/link';
import {
  $createListItemNode,
  ListNode,
  type SerializedListNode,
} from '@lexical/list';
import {$createHeadingNode, HeadingNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $parseSerializedNode,
  DecoratorNode,
  nodeSchema,
  ParagraphNode,
  rawValue,
  type SerializedParagraphNode,
  type SerializedTextNode,
  stringValue,
  TextNode,
  withField,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $createBoxNode,
  $createEquation,
  $p,
  $selectIn,
  BoxNode,
  type Delivery,
  EquationNode,
  expectConverged,
  freshReader,
  NODES,
  Peer,
  setup,
  WidgetNode,
} from '../utils/harness';

const MATRIX: [number[], Delivery][] = [
  [[1, 2, 3], 'causal'],
  [[2, 1, 3], 'causal'],
  [[1, 2, 3], 'sender'],
  [[2, 1, 3], 'sender'],
];

const $link = (): LinkNode =>
  $block([0]).getChildren().find($isLinkNode) as LinkNode;
const $initLink = () =>
  $getRoot().append(
    $createParagraphNode().append(
      $createTextNode('see '),
      $createLinkNode('https://x.dev').append($createTextNode('docs')),
      $createTextNode(' end'),
    ),
  );

describe('@lexical/y link field changes reach the other peers', () => {
  for (const [ids, delivery] of MATRIX) {
    test(`setTarget alone ${ids} ${delivery}`, async () => {
      const t = await setup($initLink, {delivery, ids});
      t.b.update(() => $link().setTarget('_blank'));
      await t.sync();
      expect(t.a.read(() => $link().getTarget())).toBe('_blank');
      await expectConverged(t.peers);
    });
    test(`edit the URL with $toggleLink over the whole link ${ids} ${delivery}`, async () => {
      const t = await setup($initLink, {delivery, ids});
      t.b.update(() => {
        $selectIn([0], 4, 8);
        $toggleLink('https://new.dev');
      });
      await t.sync();
      expect(t.a.read(() => $link().getURL())).toBe('https://new.dev');
      await expectConverged(t.peers);
    });
    // A link's fields merge as a whole (last writer wins): documented.
    test(`setURL ‖ setTarget converge ${ids} ${delivery}`, async () => {
      const t = await setup($initLink, {delivery, ids});
      t.offline();
      t.a.update(() => $link().setURL('https://a.dev'));
      t.b.update(() => $link().setTarget('_blank'));
      await t.sync();
      await expectConverged(t.peers);
    });
  }
});

// A field whose object value has an undefined member (what an editor's
// toJSON() writes for a nested editor) is stored as JSON would write it.
type Blob = {a: number; b?: string};
class BlobNode extends DecoratorNode<null> {
  __blob: Blob | undefined = {a: 0};
  $config() {
    return this.config('test_blob', {
      extends: DecoratorNode,
      json: nodeSchema<BlobNode>()({
        blob: withField(rawValue<Blob>(), {field: '__blob'}),
      }),
    });
  }
  isInline(): boolean {
    return true;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

describe('@lexical/y object values', () => {
  // Two text nodes whose NodeState holds equal arrays, pasted from JSON (a
  // key no config has parsed): Lexical compares it by reference and keeps
  // them apart, the
  // document stores one run, and every reader shows one text node. The
  // author reads the line again and shows one too (R10-A S2).
  test('adjacent text nodes Lexical does not merge, storing the same attributes: the author shows what readers show', async () => {
    const t = await setup(() => $getRoot().append($p('base')));
    t.a.update(() => {
      const text = (s: string) => ({
        $: {test_array_note: ['x', 1]},
        detail: 0,
        format: 0,
        mode: 'normal',
        style: '',
        text: s,
        type: 'text',
        version: 1,
      });
      $getRoot().append(
        $parseSerializedNode({
          children: [text('one'), text('two')],
          direction: null,
          format: '',
          indent: 0,
          textFormat: 0,
          textStyle: '',
          type: 'paragraph',
          version: 1,
        } as unknown as SerializedParagraphNode),
      );
    });
    await t.sync();
    const texts = (p: Peer) =>
      p.read(() =>
        $block([1])
          .getChildren()
          .map(n => n.getTextContent()),
      );
    expect(texts(t.a)).toEqual(['onetwo']);
    expect(texts(t.b)).toEqual(['onetwo']);
    await expectConverged([t.a, t.b]);
  });

  test('an object field with an undefined member round-trips', async () => {
    const nodes = [...NODES, BlobNode];
    const t = await setup(
      () => {
        const n = $create(BlobNode);
        n.__blob = {a: 1, b: undefined};
        $getRoot().append($createParagraphNode().append(n));
      },
      {nodes},
    );
    const fresh = await freshReader(t.a, nodes);
    const get = (p: Peer) =>
      p.read(() => ($block([0]).getFirstChild() as BlobNode).__blob?.a);
    expect(get(t.b)).toBe(1);
    expect(get(fresh)).toBe(1);
  });
});

// A subclass that adds fields through its own schema is schema-complete:
// Lexical's synthesized afterCloneFrom does not make it a node.
const toneSchema = nodeSchema<TonedParagraphNode>()({
  tone: withField(stringValue(), {field: '__tone'}),
});
class TonedParagraphNode extends ParagraphNode {
  __tone: string = '';
  $config() {
    return this.config('test_toned', {
      extends: ParagraphNode,
      json: toneSchema,
    });
  }
}

describe('@lexical/y subclasses with their own schema', () => {
  test('a paragraph subclass with a field is a line, AutoLinkNode nested', async () => {
    const nodes = [...NODES, TonedParagraphNode];
    const t = await setup(
      () => {
        const p = $create(TonedParagraphNode).append($createTextNode('toned'));
        p.getWritable().__tone = 'info';
        $getRoot().append(
          p,
          $createParagraphNode().append(
            $createAutoLinkNode('https://a.dev').append(
              $createTextNode('https://a.dev'),
            ),
          ),
        );
      },
      {nodes},
    );
    const names = t.a.binding.root
      .toArray()
      .filter(c => typeof c !== 'string')
      .map(c => (c as {name: string}).name);
    // AutoLinkNode turns mergeAdjacent off (adjacent autolinks never
    // merge), so it is an inline element node, not a format.
    expect(names).toEqual(['\u00b6', 'i:autolink', '\u00b6']);
    expect(JSON.stringify(t.a.binding.root.toDelta().toJSON())).not.toContain(
      'w:autolink',
    );
    expect(
      t.b.read(() => ($block([0]) as TonedParagraphNode).getLatest().__tone),
    ).toBe('info');
    await expectConverged(t.peers);
  });
});

// Half-migrated subclasses: their own $config, plus a property outside it.
class HalfLinkNode extends LinkNode {
  __extra = '';
  $config() {
    return this.config('test_half_link', {extends: LinkNode});
  }
}
class HalfParagraphNode extends ParagraphNode {
  __pageID = '';
  $config() {
    return this.config('test_half_paragraph', {extends: ParagraphNode});
  }
}

describe('@lexical/y subclasses with a property outside their schema', () => {
  test('are stored as nodes, with a warning naming the property', async () => {
    const nodes = [...NODES, HalfLinkNode, HalfParagraphNode];
    const t = await setup(
      () => {
        $getRoot().append(
          $create(HalfParagraphNode).append($createTextNode('half')),
          $createParagraphNode().append(
            $create(HalfLinkNode).append($createTextNode('link')),
          ),
        );
      },
      {nodes},
    );
    const delta = JSON.stringify(t.a.binding.root.toDelta().toJSON());
    expect(delta).toContain('b:test_half_paragraph');
    expect(delta).toContain('i:test_half_link');
    expect(delta).not.toContain('w:test_half_link');
    // Reported to the editor's onWarn (once in the process, by the
    // binding that derived the class).
    const messages = t.peers.flatMap(p => p.warnings);
    expect(messages.some(m => m.includes('__extra'))).toBe(true);
    expect(messages.some(m => m.includes('__pageID'))).toBe(true);
    await expectConverged(t.peers);
  });
});

// Classes with a hand-written serialization are stored as nodes; a change to
// one of their own fields alone must reach the peers (their updateFromJSON
// does not know the field: readers go through importJSON).
class MentionTextNode extends TextNode {
  __userId = '';
  static getType(): string {
    return 'test_mention_text';
  }
  static clone(node: MentionTextNode): MentionTextNode {
    const n = new MentionTextNode(node.__text, node.__key);
    n.__userId = node.__userId;
    return n;
  }
  static importJSON(
    json: SerializedTextNode & {userId: string},
  ): MentionTextNode {
    const n = new MentionTextNode(json.text).updateFromJSON(json);
    n.__userId = json.userId;
    return n;
  }
  exportJSON(): SerializedTextNode & {userId: string} {
    return {
      ...super.exportJSON(),
      type: 'test_mention_text',
      userId: this.__userId,
    };
  }
  setUserId(u: string): this {
    const w = this.getWritable();
    w.__userId = u;
    return w;
  }
}

class IdParagraphNode extends ParagraphNode {
  __id: string = '';
  static getType(): string {
    return 'test_id_paragraph';
  }
  static clone(node: IdParagraphNode): IdParagraphNode {
    const n = new IdParagraphNode(node.__key);
    n.__id = node.__id;
    return n;
  }
  static importJSON(
    json: SerializedParagraphNode & {id: string},
  ): IdParagraphNode {
    const n = new IdParagraphNode().updateFromJSON(json);
    n.__id = json.id;
    return n;
  }
  exportJSON(): SerializedParagraphNode & {id: string} {
    return {...super.exportJSON(), id: this.__id, type: 'test_id_paragraph'};
  }
  setId(id: string): this {
    const w = this.getWritable();
    w.__id = id;
    return w;
  }
}

class StyledListNode extends ListNode {
  __bullet = '';
  static getType(): string {
    return 'test_styled_list';
  }
  static clone(node: StyledListNode): StyledListNode {
    const n = new StyledListNode(node.__listType, node.__start, node.__key);
    n.__bullet = node.__bullet;
    return n;
  }
  static importJSON(
    json: SerializedListNode & {bullet: string},
  ): StyledListNode {
    const n = new StyledListNode(json.listType, json.start).updateFromJSON(
      json,
    );
    n.__bullet = json.bullet;
    return n;
  }
  exportJSON(): SerializedListNode & {bullet: string} {
    return {
      ...super.exportJSON(),
      bullet: this.__bullet,
      type: 'test_styled_list',
    };
  }
  setBullet(b: string): this {
    const w = this.getWritable();
    w.__bullet = b;
    return w;
  }
}

describe('@lexical/y classes with a hand-written serialization', () => {
  const nodes = [...NODES, MentionTextNode, IdParagraphNode, StyledListNode];

  test('a text subclass field edit syncs', async () => {
    const t = await setup(
      () => {
        const m = new MentionTextNode('@ann');
        m.__userId = 'u1';
        $getRoot().append($p('hi ').append(m.setMode('token')));
      },
      {nodes},
    );
    t.a.update(() =>
      ($block([0]).getLastChild() as MentionTextNode).setUserId('u2'),
    );
    await t.sync();
    const fresh = await freshReader(t.a, nodes);
    for (const p of [t.b, fresh]) {
      expect(
        p.read(() => ($block([0]).getLastChild() as MentionTextNode).__userId),
      ).toBe('u2');
    }
    await expectConverged(t.peers);
  });

  test('a paragraph subclass field edit syncs', async () => {
    const t = await setup(
      () => {
        const p = new IdParagraphNode();
        p.__id = 'p1';
        $getRoot().append(p.append($createTextNode('text')));
      },
      {nodes},
    );
    t.a.update(() => ($block([0]) as IdParagraphNode).setId('p2'));
    await t.sync();
    expect(t.b.read(() => ($block([0]) as IdParagraphNode).__id)).toBe('p2');
    await expectConverged(t.peers);
  });

  test('a list subclass keeps its items unwrapped and syncs its field', async () => {
    const t = await setup(
      () => {
        const l = new StyledListNode('bullet', 1);
        l.__bullet = 'star';
        l.append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append($createTextNode('two')),
        );
        $getRoot().append(l);
      },
      {nodes},
    );
    await expectConverged(
      t.peers,
      'test_styled_list[bullet](listitem("one") listitem("two"))',
    );
    t.a.update(() => ($block([0]) as StyledListNode).setBullet('dash'));
    await t.sync();
    expect(t.b.read(() => ($block([0]) as StyledListNode).__bullet)).toBe(
      'dash',
    );
    await expectConverged(t.peers);
  });
});

// A peer that lacks node registrations (an older app version) fails closed:
// it is read only, so the content it cannot show is never deleted.
describe('@lexical/y unknown node types', () => {
  test('a peer without some registrations is read only and destroys nothing', async () => {
    const t = await setup(() => $getRoot().append($p('start')), {ids: [1, 2]});
    t.a.update(() => {
      $getRoot().append(
        $create(WidgetNode),
        $p('with eq ').append(
          $createEquation('x^2'),
          $createTextNode(' after'),
        ),
        $createBoxNode('t').append($p('in box')),
        $createHeadingNode('h1').append($createTextNode('head')),
        $p('end'),
      );
    });
    await t.sync();
    const before = t.a.describe();
    const reduced = NODES.filter(
      k =>
        k !== WidgetNode &&
        k !== EquationNode &&
        k !== BoxNode &&
        k !== HeadingNode,
    );
    const c = new Peer(3, t.a.net, reduced);
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(t.a.doc), t.a.net);
    c.binding.initialize();
    expect(c.binding.status).toBe('readonly');
    expect(c.editor.isEditable()).toBe(false);
    expect(c.warnings.some(w => w.startsWith('unregistered node types'))).toBe(
      true,
    );
    // Programmatic edits on the read-only peer are not written.
    c.update(() => $selectIn([1], 3).insertText('C1'));
    await t.sync();
    expect(t.a.describe()).toBe(before);
    expect(t.b.describe()).toBe(before);
  });
});

// Documented limit: unwrapping is a removal of the container and a
// reinsertion of its lines, so text a peer types inside it at the same time
// stays with the removed container. Converges.
describe('@lexical/y unwrapping a container', () => {
  for (const [ids, delivery] of MATRIX) {
    test(`unwrap ‖ typing inside converges ${ids} ${delivery}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createBoxNode('t').append($p('inside')),
            $p('end'),
          ),
        {delivery, ids},
      );
      t.offline();
      t.a.update(() => {
        const box = $block([0]);
        for (const c of box.getChildren()) {
          box.insertBefore(c);
        }
        box.remove();
      });
      t.b.update(() => $selectIn([0, 0], 6).insertText('!'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain('paragraph("end")');
    });
  }
});
