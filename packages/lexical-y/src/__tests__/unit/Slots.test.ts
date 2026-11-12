/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Named slots ($setSlot): a block that holds content in a named slot (Meta
// Artifacts' callouts, details and components; the playground's card,
// pull quote and review) keeps it in the shared document. A node stored as
// its own Y.Node stores each slot as an attribute `slot:<name>` holding the
// slot's node, a `b:<type>` node with its content in the usual layout. A
// slot on a node that has no Y.Node of its own (a line, a format, a group,
// the root) is not stored: the binding warns and opens read only.

import {
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  configExtension,
  defineExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createLinkNode} from '@lexical/link';
import {
  $createListNode,
  $isListItemNode,
  type ListItemNode,
} from '@lexical/list';
import {$addMarkID, $getNodeMarkIDs, MarkStateExtension} from '@lexical/mark';
import {$createHeadingNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $removeSlot,
  $setSelection,
  $setSlot,
  ElementNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  LexicalWarning,
  nodeSchema,
  stringValue,
  withField,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {
  createYDoc,
  describeStorage,
  UNKNOWN_NODE_TYPES_WARNING,
  UNSUPPORTED_SLOTS_WARNING,
  YBinding,
  type YBindingStatus,
  YCollabExtension,
} from '../..';
import {
  $p,
  expectConverged,
  freshReader,
  type Peer,
  setup,
  WidgetNode,
} from '../utils/harness';
import {
  $all,
  $body,
  $caretAt,
  $component,
  $findText,
  $li,
  CardNode,
  ChipNode,
  type ComponentNode,
  PullQuoteNode,
  SLOT_NODES,
  SlotBodyNode,
} from '../utils/slots';

const tagSchema = nodeSchema<TagNode>()({
  name: withField(stringValue(), {field: '__name'}),
});

/** An inline element that merges (a format by shape) and declares a slot. */
class TagNode extends ElementNode {
  __name: string = '';
  $config() {
    return this.config('test_tag', {
      children: 'inline',
      extends: ElementNode,
      inline: true,
      json: tagSchema,
      mergeAdjacent: {by: ['name']},
      slots: ['tip'],
    });
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
}

/** The first top-level node of `type`. */
function $top<T extends LexicalNode>(type: string): T {
  const node = $getRoot()
    .getChildren()
    .find(n => n.getType() === type);
  if (node === undefined) {
    throw new Error(`no ${type}`);
  }
  return node as T;
}

/** Each top-level host's slots as `name=text`, in order. */
function slots(peer: Peer): string[] {
  return peer.read(() =>
    $getRoot()
      .getChildren()
      .filter(n => $getSlotNames(n).length > 0)
      .map(
        n =>
          n.getType() +
          '{' +
          $getSlotNames(n)
            .map(name => `${name}=${$getSlot(n, name)!.getTextContent()}`)
            .join('|') +
          '}',
      ),
  );
}

/** The stored node of the first top-level `b:<type>` child of the root. */
function storedTop(doc: Y.Doc, type: string): Y.Node {
  const root = doc.get('lexical-y');
  for (let it = root._start; it !== null; it = it.right) {
    if (
      !it.deleted &&
      it.content instanceof Y.ContentType &&
      it.content.type.name === 'b:' + type
    ) {
      return it.content.type as Y.Node;
    }
  }
  throw new Error(`no stored ${type}`);
}

const opts = {nodes: SLOT_NODES};

function $initial() {
  $getRoot().append(
    $p('Intro'),
    $component({
      body: $body(
        $p('Body one'),
        $createListNode('bullet').append($li('Item one'), $li('Item two')),
      ),
      caption: $p('Figure 1'),
    }),
    $p('Outro'),
  );
}

describe('named slots', () => {
  test('a block keeps its slots: seeded, read fresh, and on every peer', async () => {
    const t = await setup(() => {
      $initial();
      const quote = $create(PullQuoteNode);
      $setSlot(quote, 'quote', $body($p('Quoted')));
      $setSlot(quote, 'attribution', $p('Someone'));
      $getRoot().append(quote);
      const card = $create(CardNode).append($p('Card body'));
      $setSlot(card, 'title', $p('Card title'));
      $getRoot().append(card);
    }, opts);
    expect(slots(t.b)).toEqual([
      'test_component{body=Body one\n\nItem one\n\nItem two|caption=Figure 1}',
      'test_pullquote{quote=Quoted|attribution=Someone}',
      'test_card{title=Card title}',
    ]);
    await expectConverged([t.a, t.b]);
    expect(t.a.warnings).toEqual([]);
    expect(t.b.warnings).toEqual([]);
  });

  test('wire format: a slot is a `slot:<name>` attribute holding a `b:<type>` node', async () => {
    const t = await setup($initial, opts);
    const host = storedTop(t.a.doc, 'test_component');
    expect(host.getAttr('c')).toBe(undefined);
    const body = host.getAttr('slot:body') as Y.Node;
    expect(body).toBeInstanceOf(Y.Node);
    expect(body.name).toBe('b:test_slot_body');
    expect(body.getAttr('c')).toBe('b');
    // The usual layout: text, then a marker per line.
    const first = body._start!;
    expect((first.content as Y.ContentString).str).toBe('Body one');
    expect((first.right!.content as Y.ContentType).type.name).toBe('\u00b6');
    // A one-line slot (a paragraph) holds inline content.
    const caption = host.getAttr('slot:caption') as Y.Node;
    expect(caption.name).toBe('b:paragraph');
    expect(caption.getAttr('c')).toBe('i');
    expect(caption.toString()).toContain('Figure 1');
    expect(
      Object.keys(host.getAttrs()).filter(k => k.startsWith('slot:')),
    ).toEqual(['slot:body', 'slot:caption']);
  });

  test('a block with slots that a peer inserts arrives with them', async () => {
    const t = await setup(() => $getRoot().append($p('x')), opts);
    t.a.update(() => {
      $getRoot().append(
        $component({body: $body($p('typed by A')), caption: $p('cap')}),
      );
    });
    await t.sync();
    expect(slots(t.b)).toEqual(['test_component{body=typed by A|caption=cap}']);
    await expectConverged([t.a, t.b]);
  });

  test('typing in a slot merges per character', async () => {
    const t = await setup($initial, {...opts, ids: [1, 2, 3]});
    t.offline();
    t.a.update(() => $caretAt('one').insertText('A'));
    t.b.update(() => $caretAt('Body', true).insertText('B'));
    t.c.update(() => $caretAt('Figure', true).insertText('C'));
    await t.sync();
    expect(slots(t.a)).toEqual([
      'test_component{body=BodyB Aone\n\nItem one\n\nItem two|caption=FigureC 1}',
    ]);
    await expectConverged(t.peers);
  });

  test('structural edits inside a slot: split, join, headings, lists', async () => {
    const t = await setup($initial, opts);
    t.offline();
    t.a.update(() => $caretAt('one').insertParagraph());
    t.b.update(() => {
      const [item] = $findText('Item two');
      const li = item.getParent() as ListItemNode;
      li.setIndent(1);
      $caretAt('Item one', true).insertText('!');
    });
    await t.sync();
    await expectConverged([t.a, t.b]);
    t.offline();
    t.a.update(() => {
      const [text] = $findText('Body');
      const line = text.getParent()!;
      line.replace($createHeadingNode('h2'), true);
    });
    t.b.update(() => {
      // Join the list's first item into the line before it.
      const sel = $caretAt('Item one');
      sel.deleteCharacter(true);
    });
    await t.sync();
    await expectConverged([t.a, t.b]);
    const body = t.a.read(() =>
      ($getSlot($top('test_component'), 'body') as ElementNode)
        .getChildren()
        .map(n => n.getType()),
    );
    expect(body[0]).toBe('heading');
  });

  test('adding, replacing and removing slots', async () => {
    const t = await setup($initial, opts);
    t.a.update(() => {
      const host = $top<ComponentNode>('test_component');
      $setSlot(host, 'aside', $body($p('New aside')));
    });
    await t.sync();
    expect(slots(t.b)).toEqual([
      'test_component{aside=New aside|body=Body one\n\nItem one\n\nItem two|caption=Figure 1}',
    ]);
    await expectConverged([t.a, t.b]);
    t.b.update(() => {
      const host = $top<ComponentNode>('test_component');
      $setSlot(host, 'caption', $p('Figure 2'));
      $removeSlot(host, 'aside');
    });
    await t.sync();
    expect(slots(t.a)).toEqual([
      'test_component{body=Body one\n\nItem one\n\nItem two|caption=Figure 2}',
    ]);
    await expectConverged([t.a, t.b]);
    const host = storedTop(t.a.doc, 'test_component');
    expect(
      Object.keys(host.getAttrs()).filter(k => k.startsWith('slot:')),
    ).toEqual(['slot:body', 'slot:caption']);
  });

  test('two peers setting the same slot at once keep one value', async () => {
    const t = await setup($initial, opts);
    t.offline();
    t.a.update(() =>
      $setSlot($top<ComponentNode>('test_component'), 'aside', $p('from A')),
    );
    t.b.update(() =>
      $setSlot($top<ComponentNode>('test_component'), 'aside', $p('from B')),
    );
    await t.sync();
    await expectConverged([t.a, t.b]);
    const aside = slots(t.a)[0].match(/aside=([^|]*)/)![1];
    expect(['from A', 'from B']).toContain(aside);
  });

  test('a slot removed while a peer types in it: the removal wins', async () => {
    const t = await setup($initial, opts);
    t.offline();
    t.a.update(() =>
      $removeSlot($top<ComponentNode>('test_component'), 'body'),
    );
    t.b.update(() => $caretAt('Body', true).insertText(' typed'));
    await t.sync();
    expect(slots(t.a)).toEqual(['test_component{caption=Figure 1}']);
    await expectConverged([t.a, t.b]);
  });

  test('a host removed while a peer types in its slot', async () => {
    const t = await setup($initial, opts);
    t.offline();
    t.a.update(() => $top('test_component').remove());
    t.b.update(() => $caretAt('Figure', true).insertText(' typed'));
    await t.sync();
    expect(slots(t.a)).toEqual([]);
    await expectConverged([t.a, t.b]);
  });

  test('a slot value that has slots itself, and a decorator in a slot', async () => {
    const t = await setup(() => {
      const inner = $component({note: $p('Inner note')});
      const widget = $create(WidgetNode);
      widget.getWritable().__label = 'w1';
      $getRoot().append(
        $component({body: $body($p('Outer'), inner), figure: widget}),
      );
    }, opts);
    await expectConverged([t.a, t.b]);
    t.b.update(() => {
      $caretAt('Inner', true).insertText('most');
      const outer = $top<ComponentNode>('test_component');
      const widget = $getSlot(outer, 'figure') as WidgetNode;
      widget.getWritable().__label = 'w2';
    });
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(
      t.a.read(() => {
        const outer = $top<ComponentNode>('test_component');
        const inner = ($getSlot(outer, 'body') as ElementNode).getLastChild()!;
        return [
          $getSlot(inner, 'note')!.getTextContent(),
          ($getSlot(outer, 'figure') as WidgetNode).__label,
        ];
      }),
    ).toEqual(['Innermost note', 'w2']);
  });

  test('an element host keeps its slot next to its children', async () => {
    const t = await setup(() => {
      const card = $create(CardNode).append($p('Card body'));
      $setSlot(card, 'title', $p('Title'));
      $getRoot().append(card);
    }, opts);
    t.offline();
    t.a.update(() => $caretAt('Title', true).insertText(' A'));
    t.b.update(() => {
      $caretAt('Card', true).insertText(' B');
      $top<CardNode>('test_card').append($p('Second'));
    });
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(
      t.a.read(() => {
        const card = $top<CardNode>('test_card');
        return [
          $getSlot(card, 'title')!.getTextContent(),
          card.getTextContent(),
        ];
      }),
    ).toEqual(['Title A', 'Title ACard B body\n\nSecond']);
  });

  test('an inline host keeps its slot inside its line', async () => {
    const t = await setup(() => {
      const chip = $create(ChipNode);
      $setSlot(chip, 'label', $p('chip text'));
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('before '),
          chip,
          $createTextNode(' after'),
        ),
      );
    }, opts);
    t.offline();
    t.a.update(() => $caretAt('chip', true).insertText('!'));
    t.b.update(() => $caretAt('before').insertText('so '));
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(t.b.read(() => $getRoot().getTextContent())).toBe(
      'so before chip! text after',
    );
  });

  test('an inline element that merges and declares slots is a node of its own', async () => {
    const nodes = [...SLOT_NODES, TagNode];
    const t = await setup(
      () => {
        const tag = $create(TagNode).append($createTextNode('tagged'));
        tag.getWritable().__name = 'n1';
        $setSlot(tag, 'tip', $p('the tip'));
        $getRoot().append(
          $createParagraphNode().append($createTextNode('see '), tag),
        );
      },
      {nodes},
    );
    expect(describeStorage(t.a.editor).test_tag).toBe('nested');
    t.a.update(() => $caretAt('tip', true).insertText(' typed'));
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(
      t.b.read(() => {
        const tag = $findText('tagged')[0].getParent()!;
        return $getSlot(tag, 'tip')!.getTextContent();
      }),
    ).toBe('the tip typed');
  });

  test('moving a block into a slot, and a host to another place', async () => {
    const t = await setup($initial, opts);
    t.a.update(() => {
      const intro = $findText('Intro')[0].getParent()!;
      $setSlot($top<ComponentNode>('test_component'), 'lead', intro);
    });
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(slots(t.b)[0]).toContain('lead=Intro');
    t.b.update(() => {
      const host = $top('test_component');
      $getRoot().append(host);
    });
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(t.a.read(() => $getRoot().getLastChild()!.getType())).toBe(
      'test_component',
    );
    expect(slots(t.a)[0]).toContain('lead=Intro');
  });

  test('undo: typing in a slot, adding and removing slots, a host', async () => {
    const t = await setup($initial, opts);
    const before = JSON.stringify(t.a.json());
    t.a.update(() => $caretAt('Figure', true).insertText(' typed'));
    t.a.update(() =>
      $setSlot($top<ComponentNode>('test_component'), 'aside', $body($p('A'))),
    );
    t.a.update(() => {
      // The caret is in the caption.
      $setSelection(null);
      $removeSlot($top<ComponentNode>('test_component'), 'caption');
    });
    t.a.update(() =>
      $getRoot().append($component({body: $body($p('Second host'))})),
    );
    await t.sync();
    await expectConverged([t.a, t.b]);
    t.a.undo();
    await t.sync();
    expect(slots(t.b)).toEqual([
      'test_component{aside=A|body=Body one\n\nItem one\n\nItem two}',
    ]);
    t.a.undo();
    await t.sync();
    expect(slots(t.b)).toEqual([
      'test_component{aside=A|body=Body one\n\nItem one\n\nItem two|caption=Figure typed 1}',
    ]);
    t.a.undo();
    t.a.undo();
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(JSON.stringify(t.b.json())).toBe(before);
    t.a.binding.redo();
    t.a.binding.redo();
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(slots(t.b)).toEqual([
      'test_component{aside=A|body=Body one\n\nItem one\n\nItem two|caption=Figure typed 1}',
    ]);
  });

  test('undo keeps a slot a peer typed in', async () => {
    const t = await setup(() => $getRoot().append($p('x')), opts);
    t.a.update(() => $getRoot().append($component({body: $body($p('Mine'))})));
    await t.sync();
    t.b.update(() => $caretAt('Mine', true).insertText(' and theirs'));
    await t.sync();
    t.a.undo();
    await t.sync();
    await expectConverged([t.a, t.b]);
    // The peer's text is kept, with the slot and block that hold it.
    expect(t.a.read(() => $getRoot().getTextContent())).toContain('theirs');
  });

  test('a host or slot value replaced in place (`t`) keeps the slots', async () => {
    const t = await setup($initial, opts);
    // As a writer that replaces a stored node in place records it.
    t.a.doc.transact(() => {
      const host = storedTop(t.a.doc, 'test_component');
      (host.getAttr('slot:caption') as Y.Node).setAttr('t', 'heading');
      host.setAttr('t', 'test_pullquote');
    }, 'foreign');
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(
      t.b.read(() => {
        const host = $getRoot().getChildAtIndex(1)!;
        return [host.getType(), $getSlot(host, 'caption')!.getType()];
      }),
    ).toEqual(['test_pullquote', 'heading']);
    expect(slots(t.b)).toEqual([
      'test_pullquote{body=Body one\n\nItem one\n\nItem two|caption=Figure 1}',
    ]);
  });

  test('a slot that is not a block node opens read only and keeps it', async () => {
    const t = await setup($initial, opts);
    t.a.doc.transact(() => {
      const host = storedTop(t.a.doc, 'test_component');
      host.setAttr('slot:odd', 'not a node');
      const inline = new Y.Node('b:test_equation');
      host.setAttr('slot:inline', inline);
    }, 'foreign');
    await t.sync();
    for (const peer of [t.a, t.b]) {
      expect(peer.binding.status).toBe('readonly');
      expect(peer.warnings.join(' ')).toContain('slot:odd');
      expect(peer.warnings.join(' ')).toContain('test_equation');
    }
    const host = storedTop(t.a.doc, 'test_component');
    expect(host.getAttr('slot:odd')).toBe('not a node');
  });

  test('a slot value of a type a peer does not register opens it read only', async () => {
    const t = await setup($initial, opts);
    const doc = createYDoc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(t.a.doc));
    const codes: string[] = [];
    const editor = createEditorWith(
      SLOT_NODES.filter(k => k !== SlotBodyNode),
      codes,
    );
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    binding.start();
    binding.initialize();
    expect(binding.status).toBe('readonly');
    expect(codes).toEqual([UNKNOWN_NODE_TYPES_WARNING]);
  });
});

function createEditorWith(
  nodes: Klass<LexicalNode>[],
  codes: string[],
): LexicalEditor {
  return buildEditorFromExtensions(
    defineExtension({
      name: 'slots-test',
      nodes,
      onError: (e: Error) => {
        throw e;
      },
      onWarn: (e: Error) => {
        codes.push(e instanceof LexicalWarning ? e.code : e.message);
      },
    }),
  );
}

describe('named slots where the document cannot store them', () => {
  function bound(state: Uint8Array | null) {
    const doc = createYDoc();
    if (state !== null) {
      Y.applyUpdate(doc, state);
    }
    const codes: string[] = [];
    const warnings: LexicalWarning[] = [];
    const editor = buildEditorFromExtensions(
      defineExtension({
        name: 'slots-unsupported',
        nodes: SLOT_NODES,
        onError: (e: Error) => {
          throw e;
        },
        onWarn: (e: Error) => {
          codes.push(e instanceof LexicalWarning ? e.code : e.message);
          if (e instanceof LexicalWarning) {
            warnings.push(e);
          }
        },
      }),
    );
    let status: YBindingStatus = 'pending';
    const binding = new YBinding(editor, doc, {
      onStatus: s => {
        status = s;
      },
      schemaVersion: 1,
    });
    binding.start();
    return {binding, codes, doc, editor, status: () => status, warnings};
  }

  test.each([
    [
      'a line (paragraph)',
      () => $getRoot().getFirstChildOrThrow(),
      'paragraph',
    ],
    [
      'a format (link)',
      () => {
        const link = $createLinkNode('https://x.y');
        $assertNodeType(
          $getRoot().getFirstChildOrThrow(),
          $isElementNode,
        ).append(link);
        link.append($createTextNode('link'));
        return link;
      },
      'link',
    ],
    [
      'a group (list)',
      () => {
        const list = $createListNode('bullet').append($li('item'));
        $getRoot().append(list);
        return list;
      },
      'list',
    ],
    ['the root', () => $getRoot(), 'root'],
  ] as const)(
    'a slot on %s: not written, warned, read only',
    (_what, $host, type) => {
      const seed = bound(null);
      seed.editor.update(() => $getRoot().clear().append($p('Text')), {
        discrete: true,
      });
      seed.binding.initialize();
      expect(seed.binding.status).toBe('active');
      const state = Y.encodeStateAsUpdate(seed.doc);
      const p = bound(state);
      p.binding.initialize();
      expect(p.binding.status).toBe('active');
      const sv = Y.encodeStateVector(p.doc);
      p.editor.update(
        () => {
          const host = $host();
          if ($isListItemNode(host)) {
            throw new Error('unexpected');
          }
          $setSlot(host as ElementNode, 'note', $p('not stored'));
          $findText('Text')[0].setTextContent('Text changed');
        },
        {discrete: true},
      );
      expect(p.binding.status).toBe('readonly');
      expect(p.status()).toBe('readonly');
      expect(p.codes).toEqual([UNSUPPORTED_SLOTS_WARNING]);
      expect(p.warnings[0].data).toEqual({
        reason: type === 'root' ? 'root' : 'stored-host',
        types: [type],
      });
      expect(p.editor.isEditable()).toBe(false);
      // Nothing of the change is written.
      expect(Y.encodeStateAsUpdate(p.doc, sv)).toEqual(
        Y.encodeStateAsUpdate(new Y.Doc()),
      );
    },
  );

  test('initial content with a slot on a line is not written', () => {
    const p = bound(null);
    p.editor.update(
      () => {
        const para = $p('Text');
        $setSlot(para, 'note', $p('not stored'));
        $getRoot().clear().append(para);
      },
      {discrete: true},
    );
    p.binding.initialize();
    expect(p.binding.status).toBe('readonly');
    expect(p.codes).toEqual([UNSUPPORTED_SLOTS_WARNING]);
    expect(p.doc.get('lexical-y').length).toBe(0);
    expect(Object.keys(p.doc.get('lexical-y').getAttrs())).toEqual([]);
  });

  test('a host inside a slot stores its own slots', async () => {
    // A block in a slot body is stored like a block anywhere: a component
    // there is a node of the body, and stores its slots.
    const t = await setup(() => {
      $getRoot().append(
        $component({
          body: $body($component({inner: $p('deep')}), $p('after')),
        }),
      );
    }, opts);
    await expectConverged([t.a, t.b]);
    expect(t.a.binding.status).toBe('active');
  });
});

describe('named slots with BlockIdExtension and MarkStateExtension', () => {
  type E = {
    doc: Y.Doc;
    editor: LexicalEditor;
    binding: YBinding;
    warnings: string[];
  };
  function peer(name: string, clientID: number): E {
    const doc = createYDoc(null, {gc: false});
    doc.clientID = clientID;
    const warnings: string[] = [];
    let n = 0;
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          configExtension(YCollabExtension, {
            doc,
            schemaVersion: 1,
            selfCheck: true,
          }),
          configExtension(BlockIdExtension, {
            generateId: () => `${name}${++n}`,
          }),
          MarkStateExtension,
        ],
        name: 'slots-ids-' + name,
        nodes: SLOT_NODES,
        onError: (e: Error) => {
          throw e;
        },
        onWarn: (e: Error) => {
          warnings.push(e.message);
        },
      }),
    );
    const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
      .output.binding;
    return {binding, doc, editor, warnings};
  }
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  async function exchange(peers: E[]) {
    for (let round = 0; round < 4; round++) {
      for (const a of peers) {
        for (const b of peers) {
          if (a !== b) {
            Y.applyUpdate(
              b.doc,
              Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
              'net',
            );
            await tick();
          }
        }
      }
    }
  }
  const json = (p: E) => JSON.stringify(p.editor.getEditorState().toJSON());
  /** Block ids of the blocks in the component's slots, by text. */
  const idsInSlots = (p: E) =>
    p.editor.getEditorState().read(() => {
      const out: string[] = [];
      for (const n of $all()) {
        if ($isElementNode(n) && !n.isInline() && n.getTextContent() !== '') {
          const id = $getBlockId(n);
          if (id !== undefined && n.getType() !== 'test_slot_body') {
            out.push(`${n.getTextContent()}:${id}`);
          }
        }
      }
      return out.sort();
    });

  test('ids and marks inside slots are stored and converge', async () => {
    const a = peer('a', 1);
    const b = peer('b', 2);
    a.editor.update(
      () => {
        $getRoot().clear();
        $initial();
      },
      {discrete: true},
    );
    a.binding.initialize();
    await tick();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'net');
    b.binding.initialize();
    await exchange([a, b]);
    expect(b.binding.status).toBe('active');
    const ids = idsInSlots(a);
    // The slot's lines and the one-line caption have ids.
    expect(ids.some(s => s.startsWith('Body one:'))).toBe(true);
    expect(ids.some(s => s.startsWith('Figure 1:'))).toBe(true);
    expect(idsInSlots(b)).toEqual(ids);
    // A block a peer adds in a slot gets one id, everywhere.
    b.editor.update(
      () => {
        const sel = $caretAt('Body one', true);
        sel.insertParagraph();
        sel.insertText('New line');
      },
      {discrete: true},
    );
    // A mark over text in the slot.
    a.editor.update(
      () => {
        const [text, at] = $findText('Figure');
        const sel = $createRangeSelection();
        sel.anchor.set(text.getKey(), at, 'text');
        sel.focus.set(text.getKey(), at + 6, 'text');
        $addMarkID('c1', sel);
      },
      {discrete: true},
    );
    await exchange([a, b]);
    expect(json(a)).toBe(json(b));
    expect(idsInSlots(b)).toEqual(idsInSlots(a));
    expect(idsInSlots(a).filter(s => s.startsWith('New line:'))).toHaveLength(
      1,
    );
    expect(
      b.editor
        .getEditorState()
        .read(() => $getNodeMarkIDs($findText('Figure')[0])),
    ).toEqual(['c1']);
    // A fresh reader agrees.
    const c = peer('c', 3);
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a.doc), 'net');
    c.binding.initialize();
    await tick();
    expect(json(c)).toBe(json(a));
    for (const p of [a, b, c]) {
      expect(p.warnings.filter(w => w.includes('self-check'))).toEqual([]);
    }
  });
});

describe('named slots read by a fresh reader', () => {
  test('a fresh reader of a document with slots in slots', async () => {
    const t = await setup(() => {
      $getRoot().append(
        $component({
          body: $body(
            $component({inner: $body($p('deeper'))}),
            $createListNode('number').append($li('one')),
          ),
        }),
      );
    }, opts);
    const fresh = await freshReader(t.a);
    expect(JSON.stringify(fresh.json())).toBe(JSON.stringify(t.a.json()));
  });
});
