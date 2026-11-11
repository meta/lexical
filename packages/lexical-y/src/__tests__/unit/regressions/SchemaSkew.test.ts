/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Version skew: clients of two app versions edit one room (during a
// rollout). Each case is named after its finding.
//
// S7-3: a client whose class lacks a field a newer version of the class
// declares (a "v1" class next to the "v2" one) keeps that field when it
// writes the node: it writes and deletes only the stored names it owns (see
// ownsNodeAttr and the rest in Schema.ts). Each case runs one edit made by a
// v1 client and the same edit made by a v2 client, and requires the same
// document, as a v2 reader reads it; three clients (the v1 one, the v2 one
// that wrote the content, a fresh reader) converge each time.
//
// S7-11: content of a type a client does not register opens the room read
// only for it, whatever kind stores it: a line, a group, text, a node, or an
// inline element stored as a format (a link class it lacks).
//
// S7-21: stored content a client's class throws on (an updateFromJSON that
// rejects a value only a newer version writes) is unreadable for it, as
// content of a type it does not register is: it opens the room read only,
// warns (`'unreadable'`), keeps showing the rest of the document, and throws
// nothing, into the provider or from initialize().

import {$createLinkNode, LinkNode} from '@lexical/link';
import {$createListItemNode, ListItemNode, ListNode} from '@lexical/list';
import {$createHeadingNode, HeadingNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSlot,
  $getState,
  $isElementNode,
  $isTextNode,
  $setCompositionKey,
  $setSlot,
  $setState,
  arraySetValue,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  createState,
  DecoratorNode,
  ElementNode,
  type Klass,
  type LexicalNode,
  type LexicalUpdateJSON,
  nodeSchema,
  ParagraphNode,
  type SerializedElementNode,
  stringValue,
  TextNode,
  withField,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  editYState,
  readYState,
  seedYState,
  YHeadlessError,
} from '../../../headless';
import {Reader} from '../../../internal/Read';
import {
  ownedFields,
  ownsFormat,
  ownsMarkerAttr,
  ownsMember,
  ownsNodeAttr,
} from '../../../internal/Schema';
import {
  UNKNOWN_NODE_TYPES_WARNING,
  type YUnknownNodeTypesData,
} from '../../../internal/Warnings';
import {Writer} from '../../../internal/Write';
import {
  $block,
  $createBoxNode,
  $locateIn,
  $p,
  $selectIn,
  flush,
  freshReader,
  NODES,
  Peer,
  setup,
  shape,
} from '../../utils/harness';

// ---------------------------------------------------------------------------
// v1 and v2 of app node types: v2 adds a field to each.

const cardV1Schema = nodeSchema<CardV1>()({
  label: withField(stringValue(), {field: '__label'}),
});
class CardV1 extends ElementNode {
  __label: string = '';
  $config() {
    return this.config('test_skew_card', {
      extends: ElementNode,
      json: cardV1Schema,
    });
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}
const cardV2Schema = nodeSchema<CardV2>()({
  label: withField(stringValue(), {field: '__label'}),
  tone: withField(stringValue(), {field: '__tone'}),
});
class CardV2 extends ElementNode {
  __label: string = '';
  __tone: string = '';
  $config() {
    return this.config('test_skew_card', {
      extends: ElementNode,
      json: cardV2Schema,
    });
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}

const imageV1Schema = nodeSchema<ImageV1>()({
  src: withField(stringValue(), {field: '__src'}),
});
class ImageV1 extends DecoratorNode<null> {
  __src: string = '';
  $config() {
    return this.config('test_skew_image', {
      extends: DecoratorNode,
      json: imageV1Schema,
    });
  }
  isInline(): boolean {
    return false;
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
const imageV2Schema = nodeSchema<ImageV2>()({
  alt: withField(stringValue(), {field: '__alt'}),
  src: withField(stringValue(), {field: '__src'}),
});
class ImageV2 extends DecoratorNode<null> {
  __src: string = '';
  __alt: string = '';
  $config() {
    return this.config('test_skew_image', {
      extends: DecoratorNode,
      json: imageV2Schema,
    });
  }
  isInline(): boolean {
    return false;
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

const chipV1Schema = nodeSchema<ChipV1>()({
  name: withField(stringValue(), {field: '__name'}),
});
class ChipV1 extends DecoratorNode<null> {
  __name: string = '';
  $config() {
    return this.config('test_skew_chip', {
      extends: DecoratorNode,
      json: chipV1Schema,
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
const chipV2Schema = nodeSchema<ChipV2>()({
  color: withField(stringValue(), {field: '__color'}),
  name: withField(stringValue(), {field: '__name'}),
});
class ChipV2 extends DecoratorNode<null> {
  __name: string = '';
  __color: string = '';
  $config() {
    return this.config('test_skew_chip', {
      extends: DecoratorNode,
      json: chipV2Schema,
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

class NoteV1 extends ParagraphNode {
  $config() {
    return this.config('test_skew_note', {extends: ParagraphNode});
  }
}
const noteV2Schema = nodeSchema<NoteV2>()({
  tone: withField(stringValue(), {field: '__tone'}),
});
class NoteV2 extends ParagraphNode {
  __tone: string = '';
  $config() {
    return this.config('test_skew_note', {
      extends: ParagraphNode,
      json: noteV2Schema,
    });
  }
}

class ListV1 extends ListNode {
  $config() {
    return this.config('test_skew_list', {extends: ListNode});
  }
}
const listV2Schema = nodeSchema<ListV2>()({
  tone: withField(stringValue(), {field: '__tone'}),
});
class ListV2 extends ListNode {
  __tone: string = '';
  $config() {
    return this.config('test_skew_list', {
      extends: ListNode,
      json: listV2Schema,
    });
  }
}

class LinkV1 extends LinkNode {
  $config() {
    return this.config('test_skew_link', {extends: LinkNode});
  }
}
const linkV2Schema = nodeSchema<LinkV2>()({
  tone: withField(stringValue(), {field: '__tone'}),
});
class LinkV2 extends LinkNode {
  __tone: string = '';
  $config() {
    return this.config('test_skew_link', {
      extends: LinkNode,
      json: linkV2Schema,
    });
  }
}

class TagV1 extends TextNode {
  $config() {
    return this.config('test_skew_tag', {extends: TextNode});
  }
}
const tagV2Schema = nodeSchema<TagV2>()({
  tag: withField(stringValue(), {field: '__tag'}),
});
class TagV2 extends TextNode {
  __tag: string = '';
  $config() {
    return this.config('test_skew_tag', {
      extends: TextNode,
      json: tagV2Schema,
    });
  }
}

// A class that writes its JSON by hand (no `$config` schema).
type SerializedLegacy = SerializedElementNode & {label?: string; tone?: string};
class LegacyV1 extends ElementNode {
  __label = '';
  static getType(): string {
    return 'test_skew_legacy';
  }
  static clone(node: LegacyV1): LegacyV1 {
    const copy = new LegacyV1(node.__key);
    copy.__label = node.__label;
    return copy;
  }
  static importJSON(json: SerializedLegacy): LegacyV1 {
    return new LegacyV1().updateFromJSON(json);
  }
  updateFromJSON(json: LexicalUpdateJSON<SerializedLegacy>): this {
    const self = super.updateFromJSON(json);
    self.__label = json.label ?? '';
    return self;
  }
  exportJSON(): SerializedLegacy {
    return {...super.exportJSON(), label: this.__label};
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}
class LegacyV2 extends ElementNode {
  __label = '';
  __tone = '';
  static getType(): string {
    return 'test_skew_legacy';
  }
  static clone(node: LegacyV2): LegacyV2 {
    const copy = new LegacyV2(node.__key);
    copy.__label = node.__label;
    copy.__tone = node.__tone;
    return copy;
  }
  static importJSON(json: SerializedLegacy): LegacyV2 {
    return new LegacyV2().updateFromJSON(json);
  }
  updateFromJSON(json: LexicalUpdateJSON<SerializedLegacy>): this {
    const self = super.updateFromJSON(json);
    self.__label = json.label ?? '';
    self.__tone = json.tone ?? '';
    return self;
  }
  exportJSON(): SerializedLegacy {
    return {...super.exportJSON(), label: this.__label, tone: this.__tone};
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}

// A group whose items v2 gives a field too (the wrapper item of a nested
// group stores it with the outer level).
class GroupItemV1 extends ListItemNode {
  $config() {
    return this.config('test_skew_group_item', {
      children: ['inline', GroupV1],
      extends: ListItemNode,
    });
  }
}
const groupItemV2Schema = nodeSchema<GroupItemV2>()({
  badge: withField(stringValue(), {field: '__badge'}),
});
class GroupItemV2 extends ListItemNode {
  __badge: string = '';
  $config() {
    return this.config('test_skew_group_item', {
      children: ['inline', GroupV2],
      extends: ListItemNode,
      json: groupItemV2Schema,
    });
  }
}
class GroupV1 extends ListNode {
  $config() {
    return this.config('test_skew_group', {
      children: [GroupItemV1],
      extends: ListNode,
    });
  }
}
const groupV2Schema = nodeSchema<GroupV2>()({
  tone: withField(stringValue(), {field: '__tone'}),
});
class GroupV2 extends ListNode {
  __tone: string = '';
  $config() {
    return this.config('test_skew_group', {
      children: [GroupItemV2],
      extends: ListNode,
      json: groupV2Schema,
    });
  }
}

// Both versions: a flat NodeState whose value has no schema (a plain parse
// function), stored as a field of nodes stored as their own Y.Node.
const memoState = createState('test_skew_memo', {
  parse: (v: unknown) => (typeof v === 'string' ? v : ''),
});
class MemoBox extends ElementNode {
  $config() {
    return this.config('test_skew_memo_box', {
      extends: ElementNode,
      stateConfigs: [{flat: true, stateConfig: memoState}],
    });
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}
class MemoImage extends DecoratorNode<null> {
  $config() {
    return this.config('test_skew_memo_image', {
      extends: DecoratorNode,
      stateConfigs: [{flat: true, stateConfig: memoState}],
    });
  }
  isInline(): boolean {
    return false;
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

const V1: Klass<LexicalNode>[] = [
  ...NODES,
  CardV1,
  ImageV1,
  ChipV1,
  NoteV1,
  ListV1,
  LinkV1,
  TagV1,
  LegacyV1,
  GroupV1,
  GroupItemV1,
  MemoBox,
  MemoImage,
];
const V2: Klass<LexicalNode>[] = [
  ...NODES,
  CardV2,
  ImageV2,
  ChipV2,
  NoteV2,
  ListV2,
  LinkV2,
  TagV2,
  LegacyV2,
  GroupV2,
  GroupItemV2,
  MemoBox,
  MemoImage,
];

// A NodeState only the v2 app uses, and a set-valued one (stored one entry
// per member on text and nodes stored as their own Y.Node).
const moodState = createState('test_skew_mood', {parse: stringValue()});
const tagsState = createState('test_skew_tags', {
  parse: arraySetValue(stringValue()),
});

// ---------------------------------------------------------------------------
// Rooms

type Net = {
  peers: Peer[];
  delivery: 'causal';
  queue: [Peer, Uint8Array][];
  pumping: boolean;
};
const newNet = (): Net => ({
  delivery: 'causal',
  peers: [],
  pumping: false,
  queue: [],
});

type Room = {author: Peer; editor: Peer};

/**
 * A room whose content a v2 client (`author`) writes with `$init`, joined by
 * a client with `editorNodes` (`editor`).
 */
async function room(
  editorNodes: Klass<LexicalNode>[],
  $init: () => void,
): Promise<Room> {
  const net = newNet();
  const author = new Peer(2, net as never, V2);
  const editor = new Peer(1, net as never, editorNodes);
  author.update(() => {
    $getRoot().clear();
    $init();
  });
  author.binding.initialize();
  await flush();
  return {author, editor};
}

/**
 * The editor of a new room makes `$edit` (with the v1 nodes or the v2 nodes):
 * the clients converge, each version with a fresh reader of its own, and the
 * room is returned with a fresh v2 reader's document.
 */
async function edited(
  editorNodes: Klass<LexicalNode>[],
  $init: () => void,
  $edit: (r: Room) => void,
): Promise<Room & {stored: unknown}> {
  const r = await room(editorNodes, $init);
  expect(r.editor.binding.status).toBe('active');
  r.editor.update(() => $edit(r));
  await flush();
  for (const peer of [r.author, r.editor]) {
    expect(peer.errors).toEqual([]);
    expect(peer.warnings).toEqual([]);
    expect(peer.binding.status).toBe('active');
  }
  const freshNew = await freshReader(r.author);
  const freshOld = await freshReader(r.author, editorNodes);
  expect(shape(freshNew)).toEqual(shape(r.author));
  expect(shape(freshOld)).toEqual(shape(r.editor));
  expect(freshNew.warnings).toEqual([]);
  expect(freshOld.warnings).toEqual([]);
  return {...r, stored: shape(freshNew)};
}

/**
 * `$edit` made by a v1 client stores what the same edit made by a v2 client
 * stores. Returns the v1 client's room.
 */
async function expectSameAsV2(
  $init: () => void,
  $edit: (r: Room) => void,
): Promise<Room & {stored: unknown}> {
  const byV1 = await edited(V1, $init, $edit);
  const byV2 = await edited(V2, $init, $edit);
  expect(byV1.stored).toEqual(byV2.stored);
  return byV1;
}

const docJSON = (peer: Peer): string => JSON.stringify(peer.json());

/** The marker of the first line of `type` in the root of `doc`. */
function markerOf(doc: Y.Doc, type: string): Y.Node {
  for (let it = doc.get('lexical-y')._start; it !== null; it = it.right) {
    const content = it.content;
    if (
      !it.deleted &&
      content instanceof Y.ContentType &&
      content.type.name === '\u00b6' &&
      content.type.getAttr('t') === type
    ) {
      return content.type as Y.Node;
    }
  }
  throw new Error(`no ${type} marker`);
}

// ---------------------------------------------------------------------------
// Content

const $card = () => {
  const card = $create(CardV2).append($p('in the card'));
  card.__label = 'Card';
  card.__tone = 'warm';
  return card;
};
const $image = () => {
  const image = $create(ImageV2);
  image.__src = 'a.png';
  image.__alt = 'A cat';
  return image;
};
const $chip = () => {
  const chip = $create(ChipV2);
  chip.__name = 'Ada';
  chip.__color = 'teal';
  return chip;
};
const $note = (text = 'a note') => {
  const note = $create(NoteV2).append($createTextNode(text));
  note.__tone = 'warm';
  return note;
};
const $list = (...items: string[]) => {
  const list = $create(ListV2);
  list.__listType = 'bullet';
  list.__tag = 'ul';
  list.__tone = 'warm';
  for (const text of items) {
    list.append($createListItemNode().append($createTextNode(text)));
  }
  return list;
};
const $link = () => {
  const link = $create(LinkV2);
  link.__url = 'https://a.dev';
  link.__tone = 'warm';
  return link.append($createTextNode('link text'));
};
const $tag = () => {
  const tag = $create(TagV2).setTextContent('tagged words');
  tag.__tag = 'x1';
  return tag;
};

// ---------------------------------------------------------------------------

describe('S7-3: an older client keeps the fields a newer class added', () => {
  test('a block container: its format, and a field the old class knows', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($card(), $p('after')),
      () => {
        const card = $block([0]) as CardV1;
        card.setFormat('center');
        card.getWritable().__label = 'Renamed';
      },
    );
    expect(docJSON(r.author)).toContain('"tone":"warm"');
    expect(docJSON(r.author)).toContain('"label":"Renamed"');
  });

  test('a block decorator: a field the old class knows', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($image(), $p('after')),
      () => {
        ($block([0]) as unknown as ImageV1).getWritable().__src = 'b.png';
      },
    );
    expect(docJSON(r.author)).toContain('"alt":"A cat"');
    expect(docJSON(r.author)).toContain('"src":"b.png"');
  });

  test('an inline decorator: a field the old class knows', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($p('hi ').append($chip())),
      () => {
        const chip = $block([0]).getChildAtIndex(1) as unknown as ChipV1;
        chip.getWritable().__name = 'Grace';
      },
    );
    expect(docJSON(r.author)).toContain('"color":"teal"');
    expect(docJSON(r.author)).toContain('"name":"Grace"');
  });

  test('a line: its format (as before)', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($note(), $p('after')),
      () => $block([0]).setFormat('center'),
    );
    expect(docJSON(r.author)).toContain('"tone":"warm"');
  });

  test('a line whose type changes takes no field of the old type', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($note(), $p('after')),
      () => {
        const note = $block([0]);
        const heading = $create(HeadingNode);
        heading.append(...note.getChildren());
        note.replace(heading);
      },
    );
    expect(docJSON(r.author)).not.toContain('"tone"');
  });

  test('a group: its key fields', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($list('one', 'two')),
      () => ($block([0]) as ListNode).setStart(3),
    );
    expect(docJSON(r.author)).toContain('"tone":"warm"');
    expect(docJSON(r.author)).toContain('"start":3');
  });

  test('a group: an item added before its first item', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($list('one')),
      () =>
        ($block([0]).getFirstChildOrThrow() as ListItemNode).insertBefore(
          $createListItemNode().append($createTextNode('zero')),
        ),
    );
    expect(docJSON(r.author)).toContain('"tone":"warm"');
  });

  test('a group: an item added after its last item', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($list('one')),
      () =>
        $block([0]).append(
          $createListItemNode().append($createTextNode('two')),
        ),
    );
    expect(docJSON(r.author)).toContain('"tone":"warm"');
  });

  test('a group holding a nested group: the outer key fields', async () => {
    const r = await expectSameAsV2(
      () => {
        const outer = $list('one');
        const inner = $list('nested');
        inner.__tone = 'cool';
        outer.append($createListItemNode().append(inner));
        $getRoot().append(outer);
      },
      () => ($block([0]) as ListNode).setStart(5),
    );
    expect(docJSON(r.author)).toContain('"tone":"warm"');
    expect(docJSON(r.author)).toContain('"tone":"cool"');
  });

  test('an inline element stored as a format: its URL', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($p('see ').append($link())),
      () =>
        ($block([0]).getChildAtIndex(1) as LinkNode).setURL('https://b.dev'),
    );
    expect(docJSON(r.author)).toContain('"tone":"warm"');
    expect(docJSON(r.author)).toContain('https://b.dev');
  });

  test('an inline element stored as a format: typing inside it', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($p('see ').append($link())),
      () => $selectIn([0], 7).insertText('Q'),
    );
    expect(r.author.read(() => $block([0]).getChildrenSize())).toBe(2);
    expect(docJSON(r.author)).toContain('"tone":"warm"');
  });

  test('a text subclass: bold over part of it', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($p('before ').append($tag())),
      () => $selectIn([0], 7, 13).formatText('bold'),
    );
    expect(docJSON(r.author)).toContain('"tag":"x1"');
  });

  test('a text subclass: typing inside it', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($p('before ').append($tag())),
      () => $selectIn([0], 10).insertText('Q'),
    );
    const tags = r.author.read(() =>
      $block([0])
        .getChildren()
        .filter($isTextNode)
        .map(t => `${t.getTextContent()}:${(t as TagV2).__tag ?? '-'}`),
    );
    expect(tags).toEqual(['before :-', 'tagQged words:x1']);
  });

  test('NodeState the old app does not know, on a node, a line and text', async () => {
    const r = await expectSameAsV2(
      () => {
        const card = $card();
        $setState(card, moodState, 'calm');
        const text = $createTextNode('plain words');
        $setState(text, moodState, 'happy');
        const line = $createParagraphNode().append(text);
        $setState(line, moodState, 'sad');
        $getRoot().append(card, line);
      },
      () => {
        ($block([0]) as CardV1).setFormat('right');
        $block([1]).setFormat('center');
        $selectIn([1], 0, 5).formatText('italic');
      },
    );
    for (const mood of ['calm', 'happy', 'sad']) {
      expect(docJSON(r.author)).toContain(`"test_skew_mood":"${mood}"`);
    }
  });

  test('a set-valued NodeState the old app does not know', async () => {
    const r = await expectSameAsV2(
      () => {
        const text = $createTextNode('tagged text');
        $setState(text, tagsState, ['x', 'y']);
        const image = $image();
        $setState(image, tagsState, ['z']);
        $getRoot().append($createParagraphNode().append(text), image);
      },
      () => {
        $selectIn([0], 0, 6).formatText('bold');
        ($block([1]) as unknown as ImageV1).getWritable().__src = 'b.png';
      },
    );
    const sets = r.author.read(() => [
      ...$block([0])
        .getChildren()
        .map(t => $getState(t, tagsState)),
      $getState($getRoot().getChildAtIndex(1)!, tagsState),
    ]);
    expect(sets).toEqual([['x', 'y'], ['x', 'y'], ['z']]);
  });

  test("a named slot the old client's class does not use", async () => {
    const r = await expectSameAsV2(
      () => {
        const card = $card();
        $setSlot(card, 'caption', $p('a caption'));
        $getRoot().append(card);
      },
      () => ($block([0]) as CardV1).setFormat('center'),
    );
    expect(
      r.author.read(() => $getSlot($block([0]), 'caption')?.getTextContent()),
    ).toBe('a caption');
  });

  test('a root attribute the old client does not know', async () => {
    const r = await room(V1, () => $getRoot().append($card()));
    const root = r.author.doc.get('lexical-y');
    r.author.doc.transact(() => root.setAttr('zz:future', 'kept'));
    await flush();
    r.editor.update(() => $block([0]).setFormat('center'));
    await flush();
    expect(root.getAttr('zz:future')).toBe('kept');
    expect(r.editor.doc.get('lexical-y').getAttr('zz:future')).toBe('kept');
  });

  describe('a field the client knows and clears is deleted', () => {
    test.each([
      [
        'a decorator',
        () => $getRoot().append($image(), $p('after')),
        () => {
          ($block([0]) as unknown as ImageV1).getWritable().__src = 'b.png';
        },
        () => {
          ($block([0]) as unknown as ImageV2).getWritable().__alt = '';
        },
        '"alt":"A cat"',
      ],
      [
        'a group',
        () => $getRoot().append($list('one', 'two')),
        () => ($block([0]) as ListNode).setStart(3),
        () => {
          ($block([0]) as ListV2).getWritable().__tone = '';
        },
        '"tone":"warm"',
      ],
      [
        'an inline element stored as a format',
        () => $getRoot().append($p('see ').append($link())),
        () =>
          ($block([0]).getChildAtIndex(1) as LinkNode).setURL('https://b.dev'),
        () => {
          ($block([0]).getChildAtIndex(1) as LinkV2).getWritable().__tone = '';
        },
        '"tone":"warm"',
      ],
      [
        'a text subclass',
        () => $getRoot().append($p('before ').append($tag())),
        () => $selectIn([0], 7, 13).formatText('bold'),
        () => {
          ($block([0]).getChildAtIndex(1) as TagV2).getWritable().__tag = '';
        },
        '"tag":"x1"',
      ],
    ] as const)('%s', async (_name, $init, $editV1, $clear, value) => {
      // After a v1 client's edit kept it.
      const r = await room(V1, $init);
      r.editor.update($editV1);
      await flush();
      expect(docJSON(r.author)).toContain(value);
      r.author.update($clear);
      await flush();
      const fresh = await freshReader(r.author);
      expect(docJSON(r.author)).not.toContain(value);
      expect(shape(fresh)).toEqual(shape(r.author));
      expect(shape(await freshReader(r.author, V1))).toEqual(shape(r.editor));
    });
  });

  test("a group's field left on a line that is no item is deleted, as before", async () => {
    // Concurrent edits can leave one (a list item made a heading while a
    // peer changes the list's type): no group's, so every client owns it.
    const r = await room(V2, () =>
      $getRoot().append($create(HeadingNode).append($createTextNode('title'))),
    );
    const marker = markerOf(r.author.doc, 'heading');
    r.author.doc.transact(() => marker.setAttr('g:listType', 'bullet'));
    await flush();
    r.editor.update(() => $block([0]).setFormat('center'));
    await flush();
    expect(marker.getAttr('g:listType')).toBeUndefined();
    expect(marker.getAttr('p:format')).toBe('center');
  });

  test('a class that writes its JSON by hand owns every field of its type', async () => {
    // Which fields such a class writes cannot be known, so an older version
    // of it deletes the ones a newer version added (documented in y.md).
    const r = await room(V1, () => {
      const node = $create(LegacyV2).append($p('legacy'));
      node.__label = 'L';
      node.__tone = 'warm';
      $getRoot().append(node);
    });
    expect(docJSON(r.author)).toContain('"tone":"warm"');
    r.editor.update(() => {
      ($block([0]) as LegacyV1).getWritable().__label = 'M';
    });
    await flush();
    expect(docJSON(r.author)).toContain('"label":"M"');
    expect(docJSON(r.author)).not.toContain('"tone":"warm"');
  });

  test('a block an older client moves keeps the fields it does not know', async () => {
    // A move writes the block anew (see "Moves" in y.md's limits), with
    // what it stored before the write: here into a container.
    const r = await room(V1, () => $getRoot().append($note(), $p('after')));
    r.editor.update(() => {
      const note = $getRoot().getFirstChildOrThrow();
      const box = $createBoxNode('t');
      note.insertBefore(box);
      box.append(note);
    });
    await flush();
    expect(docJSON(r.author)).toContain('"tone":"warm"');
  });
});

describe('S7-3: an older client restructuring a nested group', () => {
  const $tl = (tone: string, ...items: (string | ListNode)[]) => {
    const list = $create(ListV2);
    list.__listType = 'bullet';
    list.__tag = 'ul';
    list.__tone = tone;
    for (const item of items) {
      list.append(
        $createListItemNode().append(
          typeof item === 'string' ? $createTextNode(item) : item,
        ),
      );
    }
    return list;
  };

  test("an outer group removed: each level keeps its own group's fields", async () => {
    // The line's marker stays; its outer levels shift by one.
    const r = await expectSameAsV2(
      () =>
        $getRoot().append($tl('outer', $tl('middle', $tl('inner', 'leaf')))),
      () => {
        const outer = $block([0]);
        const item = outer.getFirstChildOrThrow() as ElementNode;
        const middle = item.getFirstChildOrThrow();
        outer.insertBefore(middle);
        outer.remove();
      },
    );
    expect(docJSON(r.author)).not.toContain('"tone":"outer"');
    expect(docJSON(r.author)).toContain('"tone":"middle"');
    expect(docJSON(r.author)).toContain('"tone":"inner"');
  });

  test.each([
    ['outdent', [0, 1, 0, 0], 0],
    ['indent', [0, 2], 1],
  ] as const)('%s, levels of distinct fields', async (_name, path, indent) => {
    await expectSameAsV2(
      () => $getRoot().append($tl('out', 'a', $tl('in', 'x', 'y'), 'b')),
      () => {
        let node: LexicalNode = $getRoot();
        for (const i of path) {
          node = (node as ElementNode).getChildAtIndex(i)!;
        }
        (node as ListItemNode).setIndent(indent);
      },
    );
  });

  test('a run of new items finds the item their group fields come from in linear time', async () => {
    // Prepended: each finds the first stored item after the run.
    const proto = Writer.prototype as unknown as {
      storedItemAttrs: (...args: unknown[]) => unknown;
    };
    const {storedItemAttrs} = proto;
    const calls: number[] = [];
    try {
      for (const size of [32, 256]) {
        const r = await room(V1, () => $getRoot().append($list('existing')));
        let n = 0;
        proto.storedItemAttrs = function (this: unknown, ...args: unknown[]) {
          n++;
          return storedItemAttrs.apply(this, args);
        };
        r.editor.update(() =>
          $block([0]).splice(
            0,
            0,
            Array.from({length: size}, (_, i) =>
              $createListItemNode().append($createTextNode('new' + i)),
            ),
          ),
        );
        await flush();
        proto.storedItemAttrs = storedItemAttrs;
        expect(r.editor.errors).toEqual([]);
        expect(docJSON(r.author).match(/"tone":"warm"/g)).toHaveLength(1);
        calls.push(n);
      }
    } finally {
      proto.storedItemAttrs = storedItemAttrs;
    }
    expect(calls[1]).toBeLessThan(calls[0] * 8 * 2);
  });

  test.fails(
    'limit: a link an older client replaces with another keeps the fields it does not know',
    async () => {
      // It cannot tell the new link from the old one edited, and keeps what
      // it does not own (see "Older app versions" in y.md's limits).
      await expectSameAsV2(
        () => $getRoot().append($p('see ').append($link())),
        () => {
          const old = $block([0]).getChildAtIndex(1) as LinkNode;
          // Of the client's own class for the type.
          const next = $create(old.constructor as Klass<LinkNode>)
            .setURL('https://b.dev')
            .append(...old.getChildren());
          old.replace(next);
        },
      );
    },
  );
});

// F2: Yjs has no moves, so a block that moves is deleted and written again
// (see "Moves" in y.md's limits). The new copy takes what its node stored
// before the write, with what a client with older classes does not know: a
// line's marker (its fields, and its group's as the group stores them), a
// node of its own (and what it holds), an inline node. Most cases run the
// move made by a v1 client and the same move made by a v2 client, and
// require the same document.
describe('F2: an older client that moves a block keeps the fields it does not know', () => {
  const $toned = (tone: string, ...items: (string | ListNode)[]) => {
    const list = $create(ListV2);
    list.__listType = 'bullet';
    list.__tag = 'ul';
    list.__tone = tone;
    for (const item of items) {
      list.append(
        $createListItemNode().append(
          typeof item === 'string' ? $createTextNode(item) : item,
        ),
      );
    }
    return list;
  };
  const BLOCKS: [string, () => LexicalNode, string][] = [
    ['a line', () => $note(), '"tone":"warm"'],
    ['a group', () => $list('one', 'two'), '"tone":"warm"'],
    ['a block node', () => $card(), '"tone":"warm"'],
    ['a block decorator', () => $image(), '"alt":"A cat"'],
    [
      'a block node holding a line and a group',
      () => $card().append($note('inner note'), $toned('cool', 'inner item')),
      '"tone":"cool"',
    ],
    [
      'a nested group',
      () => $toned('out', 'a', $toned('in', 'x', 'y'), 'b'),
      '"tone":"in"',
    ],
    [
      'a line holding an inline decorator',
      () => $p('hi ').append($chip()),
      '"color":"teal"',
    ],
  ];
  const MOVES: [
    string,
    (r: Room) => void,
    ($make: () => LexicalNode) => void,
  ][] = [
    [
      'down past a paragraph',
      () => $block([1]).insertAfter($block([0])),
      $make => $getRoot().append($make(), $p('after')),
    ],
    [
      'up past a paragraph',
      () => $block([0]).insertBefore($block([1])),
      $make => $getRoot().append($p('before'), $make()),
    ],
    [
      'into a new container',
      () => {
        const block = $block([0]);
        const box = $createBoxNode('t');
        block.insertBefore(box);
        box.append(block);
      },
      $make => $getRoot().append($make(), $p('after')),
    ],
  ];
  for (const [what, $make, kept] of BLOCKS) {
    for (const [how, $move, $init] of MOVES) {
      test(`${what} moved ${how}`, async () => {
        const r = await expectSameAsV2(() => $init($make), $move);
        expect(docJSON(r.author)).toContain(kept);
      });
    }
  }

  test.each([
    ['at its start', 0],
    ['in its middle', 2],
    ['at its end', 6],
  ] as const)('a line split %s', async (_where, at) => {
    const r = await expectSameAsV2(
      () => $getRoot().append($note('a note'), $p('after')),
      () => $selectIn([0], at).insertParagraph(),
    );
    expect(docJSON(r.author)).toContain('"tone":"warm"');
  });

  test('a block node with a named slot', async () => {
    const r = await expectSameAsV2(
      () => {
        const card = $card();
        $setSlot(card, 'caption', $note('a caption'));
        $getRoot().append(card, $p('after'));
      },
      () => $block([1]).insertAfter($block([0])),
    );
    expect(
      r.author.read(() => $getSlot($block([1]), 'caption')?.getTextContent()),
    ).toBe('a caption');
    expect(docJSON(r.author).match(/"tone":"warm"/g)).toHaveLength(2);
  });

  test('an item moved within its group', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($list('one', 'two', 'three')),
      () =>
        ($block([0]).getLastChildOrThrow() as ListItemNode).insertBefore(
          $block([0]).getFirstChildOrThrow(),
        ),
    );
    expect(docJSON(r.author).match(/"tone":"warm"/g)).toHaveLength(1);
  });

  test("an item moved into another group takes that group's fields", async () => {
    const r = await expectSameAsV2(
      () =>
        $getRoot().append(
          $toned('warm', 'a1', 'a2'),
          $p('between'),
          $toned('cool', 'b1'),
        ),
      () =>
        ($block([2]).getFirstChildOrThrow() as ListItemNode).insertAfter(
          $block([0]).getFirstChildOrThrow(),
        ),
    );
    expect(
      r.author.read(() =>
        $getRoot()
          .getChildren()
          .map(c => `${(c as ListV2).__tone ?? '-'}:${c.getTextContent()}`),
      ),
    ).toEqual(['warm:a2', '-:between', 'cool:b1\n\na1']);
  });

  test('every item of two groups swapped: each group keeps its fields', async () => {
    const r = await expectSameAsV2(
      () =>
        $getRoot().append(
          $toned('warm', 'a1', 'a2'),
          $p('between'),
          $toned('cool', 'b1', 'b2'),
        ),
      () => {
        const [a, b] = [$block([0]), $block([2])];
        const items = a.getChildren();
        a.splice(0, a.getChildrenSize(), b.getChildren());
        b.append(...items);
      },
    );
    expect(
      r.author.read(() =>
        $getRoot()
          .getChildren()
          .map(c => `${(c as ListV2).__tone ?? '-'}:${c.getTextContent()}`),
      ),
    ).toEqual(['warm:b1\n\nb2', '-:between', 'cool:a1\n\na2']);
  });

  test('groups a client shows as one, moved: each item keeps its own group', async () => {
    // Once the paragraph between two lists that differ only in a field the
    // v1 client does not own is removed, it shows them as one list (a v2
    // client would merge them; none is online here). Moved whole, each item
    // keeps its own list's fields.
    const r = await room(V1, () =>
      $getRoot().append(
        $toned('warm', 'a1', 'a2'),
        $p('between'),
        $toned('cool', 'b1'),
        $p('after'),
      ),
    );
    r.author.online = false;
    const tones = () => {
      const out: string[] = [];
      let text = '';
      const root = r.editor.doc.get('lexical-y');
      for (let it = root._start; it !== null; it = it.right) {
        const content = it.content;
        if (it.deleted) {
          continue;
        }
        if (content instanceof Y.ContentString) {
          text += content.str;
        } else if (content instanceof Y.ContentType) {
          out.push(`${text}:${content.type.getAttr('g:tone') ?? '-'}`);
          text = '';
        }
      }
      return out;
    };
    r.editor.update(() => $block([1]).remove());
    await flush();
    expect(r.editor.read(() => $getRoot().getChildrenSize())).toBe(2);
    expect(tones()).toEqual(['a1:warm', 'a2:warm', 'b1:cool', 'after:-']);
    r.editor.update(() => $block([1]).insertAfter($block([0])));
    await flush();
    expect(r.editor.errors).toEqual([]);
    expect(r.editor.warnings).toEqual([]);
    expect(tones()).toEqual(['after:-', 'a1:warm', 'a2:warm', 'b1:cool']);
  });

  test.each([
    ['before its first item', 0],
    ['after its last item', 2],
  ] as const)('a group moved with an item added %s', async (_where, at) => {
    const r = await expectSameAsV2(
      () => $getRoot().append($list('a', 'b'), $p('gap')),
      () => {
        const list = $block([0]);
        list.splice(at, 0, [
          $createListItemNode().append($createTextNode('z')),
        ]);
        $block([1]).insertAfter(list);
      },
    );
    expect(docJSON(r.author).match(/"tone":"warm"/g)).toHaveLength(1);
  });

  const $group = (tone: string, ...items: GroupItemV2[]) => {
    const group = $create(GroupV2);
    group.__listType = 'bullet';
    group.__tag = 'ul';
    group.__tone = tone;
    return group.append(...items);
  };
  const $item = (text: string) =>
    $create(GroupItemV2).append($createTextNode(text));
  // A nested group (`in`) in an item of `out` that has a badge.
  const $badged = () => {
    const wrapper = $create(GroupItemV2).append($group('in', $item('x')));
    wrapper.__badge = 'red';
    return $group('out', wrapper, $item('m'));
  };

  test('a nested group whose item moves keeps the fields of that item', async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($badged()),
      () => $block([0, 1]).insertAfter($block([0, 0])),
    );
    expect(docJSON(r.author)).toContain('"badge":"red"');
  });

  test("a nested group moved into a new item takes none of the old item's fields", async () => {
    const r = await expectSameAsV2(
      () => $getRoot().append($badged()),
      () => {
        const wrapper = $block([0, 0]);
        const item = $create(wrapper.constructor as typeof GroupItemV1);
        $block([0]).append(item.append($block([0, 0, 0])));
        wrapper.remove();
      },
    );
    expect(docJSON(r.author)).not.toContain('"badge":"red"');
    expect(docJSON(r.author)).toContain('"tone":"in"');
  });

  // The item holding `in` moves into `dest`, before or after its item.
  const $intoOtherGroup = (first: boolean) => () => {
    const [wrapper, d] = [$block([0, 0]), $block([2, 0])];
    if (first) {
      d.insertBefore(wrapper);
    } else {
      d.insertAfter(wrapper);
    }
  };
  const $withDest = () =>
    $getRoot().append($badged(), $p('gap'), $group('dest', $item('d')));
  test.each([
    ['first', true],
    ['last', false],
  ] as const)(
    'a nested group whose item moves into another group, %s, keeps the fields of that item',
    async (_where, first) => {
      const r = await edited(V1, $withDest, $intoOtherGroup(first));
      expect(
        r.author.read(
          () => ($block([2, first ? 0 : 1]) as GroupItemV2).__badge,
        ),
      ).toBe('red');
    },
  );

  // Its outer level does not take the fields of the group it moves into from
  // the items of that group (see "Older app versions" in y.md's limits): a
  // reader takes them from the group's first item.
  test.fails(
    'limit: a nested group whose item moves into another group takes the fields of that group',
    async () => {
      await expectSameAsV2($withDest, $intoOtherGroup(true));
    },
  );

  // The container written first gives the block new storage, and then the
  // root writes the container anew, with the block in it.
  test.each([
    ['a line', () => $note()],
    [
      'a block node with a named slot',
      () => {
        const card = $card();
        $setSlot(card, 'caption', $note('a caption'));
        return card;
      },
    ],
    ['a line holding an inline decorator', () => $p('hi ').append($chip())],
  ])('%s moved into a container that moves too', async (_what, $make) => {
    const r = await expectSameAsV2(
      () =>
        $getRoot().append(
          $make(),
          $createBoxNode('t').append($p('in the box')),
          $p('after'),
        ),
      () => {
        const [block, box, after] = [$block([0]), $block([1]), $block([2])];
        block.getWritable();
        box.append(block);
        after.insertAfter(box);
      },
    );
    expect(docJSON(r.author)).toMatch(/"(tone|color)":"(warm|teal)"/);
  });

  // A diff of the container can give the moved line the marker of a line
  // there that changes; the marker then stores the moved line's fields, and
  // none of the other line's.
  for (const tone of ['mine', '']) {
    for (const boxMoves of [false, true]) {
      test(`a line moved next to a line that changes keeps its own fields (${tone || 'none'}), where its container ${boxMoves ? 'moves too' : 'stays'}`, async () => {
        const $tonedNote = (text: string, t: string) => {
          const note = $note(text);
          note.__tone = t;
          return note;
        };
        const r = await expectSameAsV2(
          () =>
            $getRoot().append(
              $tonedNote('moved', tone),
              $createBoxNode('t').append(
                $tonedNote('kept ', 'theirs').append($chip()),
              ),
              $p('after'),
            ),
          () => {
            const [moved, box, after] = [$block([0]), $block([1]), $block([2])];
            moved.getWritable();
            $block([1, 0])
              .getChildAtIndex(1)!
              .replace($createTextNode('changed'));
            box.append(moved);
            if (boxMoves) {
              after.insertAfter(box);
            }
          },
        );
        expect(
          r.author.read(() =>
            $block([boxMoves ? 1 : 0])
              .getChildren()
              .map(note => (note as NoteV2).__tone),
          ),
        ).toEqual(['theirs', tone]);
      });
    }
  }

  test('a line holding lines, moved before it is normalized, keeps its fields in each part', async () => {
    // Without transforms, a line can hold a line: it is stored as parts, each
    // with the marker of the line that holds them.
    const tones = (peer: Peer) => {
      const out: unknown[] = [];
      const visit = (y: Y.Node) => {
        for (let it = y._start; it !== null; it = it.right) {
          const content = it.content;
          if (!it.deleted && content instanceof Y.ContentType) {
            const node = content.type as Y.Node;
            if (node.getAttr('t') === 'test_skew_note') {
              out.push(node.getAttr('p:tone'));
            }
            visit(node);
          }
        }
      };
      visit(peer.doc.get('lexical-y'));
      return out;
    };
    const run = async (nodes: Klass<LexicalNode>[]) => {
      const r = await room(nodes, () =>
        $getRoot().append(
          $note('head'),
          $createHeadingNode('h2').append($createTextNode('held')),
          $createBoxNode('t').append($p('in the box')),
        ),
      );
      const $moveIntoBox = () => $block([1]).append($block([0]));
      const stop = r.editor.editor.registerUpdateListener(() => {
        stop();
        r.editor.editor.update($moveIntoBox, {
          discrete: true,
          skipTransforms: true,
        });
      });
      r.editor.editor.update(
        () => $block([0]).append($block([1]), $createTextNode('tail')),
        {discrete: true, skipTransforms: true},
      );
      await flush();
      for (const peer of [r.author, r.editor]) {
        expect(peer.errors).toEqual([]);
        expect(peer.binding.status).toBe('active');
      }
      return r;
    };
    const byV1 = await run(V1);
    const byV2 = await run(V2);
    expect(tones(byV2.editor)).toEqual(['warm', 'warm']);
    expect(tones(byV1.editor)).toEqual(tones(byV2.editor));
    expect(shape(await freshReader(byV1.author))).toEqual(
      shape(await freshReader(byV2.author)),
    );
  });

  // The text of a moved line is written anew from what the client shows:
  // the formats of its characters that the client does not own (a text
  // class's field, a member of a link's value) are lost (see "Older app
  // versions" in y.md's limits). The move converges all the same.
  const TEXT: [string, () => LexicalNode, string][] = [
    ['a text class', () => $p('before ').append($tag()), '"tag":"x1"'],
    ['a link', () => $p('see ').append($link()), '"tone":"warm"'],
  ];
  const $movedText = ($make: () => LexicalNode) =>
    edited(
      V1,
      () => $getRoot().append($make(), $p('after')),
      () => $block([1]).insertAfter($block([0])),
    );
  test.each(TEXT)('a line holding %s moved', async (_what, $make) => {
    await $movedText($make);
  });
  test.fails.each(TEXT)(
    'limit: a moved line keeps the fields of %s in it',
    async (_what, $make, kept) => {
      const r = await $movedText($make);
      expect(docJSON(r.author)).toContain(kept);
    },
  );
});

// Where a node is stored as its own Y.Node, a client writes a flat NodeState
// as a field, so it owns it, with a schema for its value or not.
describe('S7-3, F2: a flat NodeState with no schema', () => {
  const NODES_WITH_MEMO: [string, () => LexicalNode][] = [
    ['a block node', () => $create(MemoBox).append($p('in the box'))],
    ['a block decorator', () => $create(MemoImage)],
  ];
  for (const [what, $make] of NODES_WITH_MEMO) {
    for (const moved of [false, true]) {
      test(`on ${what}, reset${moved ? ' as it moves' : ''}, stays reset`, async () => {
        const r = await edited(
          V2,
          () => {
            const node = $make();
            $setState(node, memoState, 'old');
            $getRoot().append(node, $p('after'));
          },
          ({editor}) => {
            expect(editor.read(() => $getState($block([0]), memoState))).toBe(
              'old',
            );
            const node = $block([0]);
            $setState(node, memoState, '');
            if (moved) {
              $block([1]).insertAfter(node);
            }
          },
        );
        expect(
          r.author.read(() => $getState($block([moved ? 1 : 0]), memoState)),
        ).toBe('');
      });
    }
  }
});

describe('S7-3: which stored names a client owns', () => {
  test('a node or marker attribute', () => {
    const fields = new Set(['src']);
    expect(ownsNodeAttr('p:src', fields)).toBe(true);
    expect(ownsNodeAttr('p:alt', fields)).toBe(false);
    expect(ownsNodeAttr('s:anything', fields)).toBe(true);
    expect(ownsNodeAttr('t', fields)).toBe(false);
    const group = new Set(['listType']);
    for (const key of ['t', 'g', 'l', 'o', 'g:$', 'g:listType', 's:x']) {
      expect(ownsMarkerAttr(key, fields, group)).toBe(true);
    }
    for (const key of ['g:tone', 'p:alt', 'zz']) {
      expect(ownsMarkerAttr(key, fields, group)).toBe(false);
    }
  });

  test('a text format and a member of a value', () => {
    const fields = new Set(['style']);
    const wrapper = (type: string) =>
      type === 'link' ? new Set(['url']) : null;
    for (const key of ['t', 'k', 'f:bold', 'p:style', 's:x', 'w:link']) {
      expect(ownsFormat(key, fields, wrapper)).toBe(true);
    }
    for (const key of ['f:sparkle', 'p:tag', 'w:fancy', 'zz']) {
      expect(ownsFormat(key, fields, wrapper)).toBe(false);
    }
    const url = new Set(['url']);
    for (const member of ['url', '#', '@', '$', 's:x']) {
      expect(ownsMember(member, url)).toBe(true);
    }
    expect(ownsMember('tone', url)).toBe(false);
  });

  test("a client's fields at a location: its class's, or every field where the type changes", () => {
    const old = new Peer(7, newNet() as never, V1);
    const fields = ownedFields(
      old.editor,
      'test_skew_card',
      'test_skew_card',
      false,
    );
    expect(fields.has('label')).toBe(true);
    expect(fields.has('format')).toBe(true);
    expect(fields.has('tone')).toBe(false);
    expect(
      ownedFields(old.editor, 'test_skew_card', 'paragraph', false).has('tone'),
    ).toBe(true);
    expect(
      ownedFields(old.editor, 'not_registered', 'not_registered', false).has(
        'format',
      ),
    ).toBe(false);
    expect(
      ownedFields(old.editor, 'test_skew_legacy', 'test_skew_legacy', true).has(
        'anything',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------

class UnknownNote extends ParagraphNode {
  $config() {
    return this.config('test_unknown_note', {extends: ParagraphNode});
  }
}
class UnknownList extends ListNode {
  $config() {
    return this.config('test_unknown_list', {extends: ListNode});
  }
}
class UnknownLink extends LinkNode {
  $config() {
    return this.config('test_unknown_link', {extends: LinkNode});
  }
}
class UnknownTag extends TextNode {
  $config() {
    return this.config('test_unknown_tag', {extends: TextNode});
  }
}
class UnknownPanel extends ElementNode {
  $config() {
    return this.config('test_unknown_panel', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}
class UnknownChip extends DecoratorNode<null> {
  $config() {
    return this.config('test_unknown_chip', {extends: DecoratorNode});
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

describe('S7-11: content of a type a client does not register opens the room read only', () => {
  const withoutLink = NODES.filter(k => k !== LinkNode);
  test.each([
    [
      'a line',
      [UnknownNote],
      NODES,
      () =>
        $getRoot().append(
          $create(UnknownNote).append($createTextNode('note')),
          $p('after'),
        ),
      'test_unknown_note',
    ],
    [
      'a group',
      [UnknownList],
      NODES,
      () => {
        const list = $create(UnknownList);
        list.__listType = 'bullet';
        list.__tag = 'ul';
        $getRoot().append(
          list.append($createListItemNode().append($createTextNode('item'))),
          $p('after'),
        );
      },
      'test_unknown_list',
    ],
    [
      'an inline element stored as a format',
      [UnknownLink],
      NODES,
      () => {
        const link = $create(UnknownLink);
        link.__url = 'https://a.dev';
        $getRoot().append(
          $p('see ').append(link.append($createTextNode('here'))),
          $p('after'),
        );
      },
      'test_unknown_link',
    ],
    [
      'a link, by an editor without LinkNode',
      [],
      withoutLink,
      () =>
        $getRoot().append(
          $p('see ').append(
            $createLinkNode('https://a.dev').append($createTextNode('here')),
          ),
          $p('after'),
        ),
      'link',
    ],
    [
      'a text subclass',
      [UnknownTag],
      NODES,
      () =>
        $getRoot().append(
          $p('plain ').append($create(UnknownTag).setTextContent('tag')),
          $p('after'),
        ),
      'test_unknown_tag',
    ],
    [
      'a block node',
      [UnknownPanel],
      NODES,
      () =>
        $getRoot().append(
          $create(UnknownPanel).append($p('in it')),
          $p('after'),
        ),
      'test_unknown_panel',
    ],
    [
      'an inline node',
      [UnknownChip],
      NODES,
      () =>
        $getRoot().append($p('hi ').append($create(UnknownChip)), $p('after')),
      'test_unknown_chip',
    ],
    [
      'a named slot',
      [UnknownPanel],
      NODES,
      () => {
        const card = $createBoxNode('t').append($p('body'));
        $setSlot(card, 'aside', $create(UnknownPanel).append($p('in a slot')));
        $getRoot().append(card, $p('after'));
      },
      'test_unknown_panel',
    ],
  ] as const)('%s', async (_name, extra, oldNodes, $init, type) => {
    const net = newNet();
    const author = new Peer(2, net as never, [...NODES, ...extra]);
    const old = new Peer(1, net as never, [...oldNodes]);
    author.update(() => {
      $getRoot().clear();
      $init();
    });
    author.binding.initialize();
    await flush();
    expect(old.binding.status).toBe('readonly');
    expect(old.warnings).toEqual([
      `unregistered node types: ${type}. This editor is read only: register the same node classes (or extensions) as the clients that wrote them`,
    ]);
    const before = docJSON(author);
    const vector = Y.encodeStateVector(old.doc);
    // An edit of the old client is not written.
    old.update(() => {
      const last = $getRoot().getLastChildOrThrow();
      if ($isElementNode(last)) {
        last.append($createTextNode(' more'));
      }
    });
    await flush();
    expect(Y.encodeStateVector(old.doc)).toEqual(vector);
    expect(docJSON(author)).toBe(before);
  });

  test('the warning is typed', async () => {
    const net = newNet();
    const author = new Peer(2, net as never, [...NODES, UnknownLink]);
    const warnings: unknown[] = [];
    const old = new Peer(1, net as never, NODES, editor => {
      editor._onWarn = error => {
        warnings.push(error);
      };
    });
    author.update(() => {
      $getRoot().clear();
      const link = $create(UnknownLink);
      link.__url = 'https://a.dev';
      $getRoot().append($p('see ').append(link.append($createTextNode('x'))));
    });
    author.binding.initialize();
    await flush();
    expect(old.binding.status).toBe('readonly');
    expect(warnings).toMatchObject([
      {
        code: UNKNOWN_NODE_TYPES_WARNING,
        data: {reason: 'unregistered', types: ['test_unknown_link']},
      },
    ]);
  });
});

// ---------------------------------------------------------------------------

type SerializedMode = SerializedElementNode & {mode?: string};
/** v1 of a class with a field `mode` whose updateFromJSON rejects a value v2 writes. */
function modeClasses(type: string, base: typeof ElementNode) {
  class ModeV2 extends base {
    __mode = 'a';
    static getType(): string {
      return type;
    }
    static clone(node: ModeV2): ModeV2 {
      const copy = new ModeV2(node.__key);
      copy.__mode = node.__mode;
      return copy;
    }
    static importJSON(json: SerializedMode): ModeV2 {
      return new ModeV2().updateFromJSON(json);
    }
    updateFromJSON(json: LexicalUpdateJSON<SerializedMode>): this {
      const self = super.updateFromJSON(json);
      self.__mode = json.mode ?? 'a';
      return self;
    }
    exportJSON(): SerializedMode {
      return {...super.exportJSON(), mode: this.__mode, type};
    }
    createDOM(): HTMLElement {
      throw new Error('headless');
    }
    updateDOM(): boolean {
      return false;
    }
  }
  class ModeV1 extends ModeV2 {
    static getType(): string {
      return type;
    }
    static clone(node: ModeV1): ModeV1 {
      const copy = new ModeV1(node.__key);
      copy.__mode = node.__mode;
      return copy;
    }
    static importJSON(json: SerializedMode): ModeV1 {
      return new ModeV1().updateFromJSON(json);
    }
    updateFromJSON(json: LexicalUpdateJSON<SerializedMode>): this {
      if (json.mode !== undefined && json.mode !== 'a' && json.mode !== 'b') {
        throw new Error('unknown mode ' + json.mode);
      }
      return super.updateFromJSON(json);
    }
  }
  return {ModeV1, ModeV2};
}

const modeLine = modeClasses(
  'test_mode_line',
  ParagraphNode as unknown as typeof ElementNode,
);
const modeBox = modeClasses('test_mode_box', ElementNode);

describe('S7-21: stored content an older class throws on opens the room read only', () => {
  const shapes = [
    [
      'a line',
      modeLine,
      'test_mode_line',
      () => $create(modeLine.ModeV2).append($createTextNode('mode line')),
    ],
    [
      'a node of its own',
      modeBox,
      'test_mode_box',
      () => $create(modeBox.ModeV2).append($p('in the box')),
    ],
  ] as const;

  test.each(shapes)(
    '%s: a value a newer client sets',
    async (_name, {ModeV1, ModeV2}, type, $node) => {
      const net = newNet();
      const author = new Peer(2, net as never, [...NODES, ModeV2]);
      const old = new Peer(1, net as never, [...NODES, ModeV1]);
      author.update(() => {
        $getRoot().clear().append($p('first'), $node(), $p('last'));
      });
      author.binding.initialize();
      await flush();
      const shown = old.describe();
      expect(old.binding.status).toBe('active');
      author.update(() => {
        (
          $block([1]) as unknown as {getWritable(): {__mode: string}}
        ).getWritable().__mode = 'v2only';
      });
      await flush();
      expectUnreadable(old, type, shown);
      await expectWritesNothing(old, author);
    },
  );

  test.each(shapes)(
    '%s: opening a room that holds it',
    async (_name, {ModeV1, ModeV2}, type, $node) => {
      const net = newNet();
      const author = new Peer(2, net as never, [...NODES, ModeV2]);
      author.update(() => {
        const node = $node();
        (node as unknown as {__mode: string}).__mode = 'v2only';
        $getRoot().clear().append($p('first'), node, $p('last'));
      });
      author.binding.initialize();
      await flush();
      const old = new Peer(1, newNet() as never, [...NODES, ModeV1]);
      Y.applyUpdate(old.doc, Y.encodeStateAsUpdate(author.doc));
      old.binding.initialize();
      await flush();
      expectUnreadable(old, type, null);
      expect(old.describe()).toContain('"first"');
      expect(old.describe()).toContain('"last"');
    },
  );
});

describe('S7-21: a read that throws on every attempt fails closed', () => {
  // Not a class: the reader itself (a bug) throws, on a read and on the
  // fresh read of the document that follows.
  const failingReads = () => {
    const proto = Reader.prototype as unknown as {
      $apply: (...args: unknown[]) => void;
      $readFull: (...args: unknown[]) => void;
    };
    const {$apply, $readFull} = proto;
    proto.$apply = proto.$readFull = () => {
      throw new Error('simulated reader failure');
    };
    return () => {
      proto.$apply = $apply;
      proto.$readFull = $readFull;
    };
  };
  const warned = (peer: Peer) =>
    peer.warnings.filter(w => !w.includes('stored as a nested'));

  test('a remote change: the editor keeps what it showed', async () => {
    const net = newNet();
    const a = new Peer(2, net as never);
    const b = new Peer(1, net as never);
    a.update(() => $getRoot().clear().append($p('hello')));
    a.binding.initialize();
    await flush();
    const restore = failingReads();
    try {
      a.update(() => $block([0]).append($createTextNode(' there')));
      await flush();
    } finally {
      restore();
    }
    expect(b.errors).toEqual([]);
    expect(b.binding.status).toBe('readonly');
    expect(warned(b)).toEqual([
      'the document cannot be read: simulated reader failure. This editor is read only until it is built again: data.error holds what the read threw; fix that, then reload the editor',
    ]);
    expect(b.describe()).toBe('paragraph("hello")');
    // It reads nothing more.
    a.update(() => $block([0]).append($createTextNode('!')));
    await flush();
    expect(b.describe()).toBe('paragraph("hello")');
    expect(b.errors).toEqual([]);
  });

  test('opening the room: nothing is thrown, and nothing is shown', async () => {
    const a = new Peer(2, newNet() as never);
    a.update(() => $getRoot().clear().append($p('hello')));
    a.binding.initialize();
    await flush();
    const b = new Peer(1, newNet() as never);
    const restore = failingReads();
    try {
      expect(() => {
        Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
        b.binding.initialize();
      }).not.toThrow();
    } finally {
      restore();
    }
    await flush();
    expect(b.errors).toEqual([]);
    expect(b.binding.status).toBe('readonly');
    expect(warned(b)).toEqual([
      'the document cannot be read: simulated reader failure. This editor is read only until it is built again: data.error holds what the read threw; fix that, then reload the editor',
    ]);
    expect(b.describe()).toBe('');
  });

  test.each([
    ['nothing, as opening the room failed', false],
    ['what it read before', true],
  ])(
    'N3: a local update goes back to what the editor showed (%s), reading nothing',
    async (_name, opened) => {
      const net = newNet();
      const a = new Peer(2, net as never);
      const b = new Peer(1, (opened ? net : newNet()) as never);
      a.update(() => $getRoot().clear().append($p('hello')));
      a.binding.initialize();
      await flush();
      const proto = Reader.prototype as unknown as {
        $apply: (...args: unknown[]) => void;
        $readFull: (...args: unknown[]) => void;
      };
      const {$apply, $readFull} = proto;
      let reads = 0;
      proto.$apply = proto.$readFull = () => {
        reads++;
        throw new Error('simulated reader failure');
      };
      const uncaught: unknown[] = [];
      const onUncaught = (error: unknown) => uncaught.push(error);
      process.on('uncaughtException', onUncaught);
      try {
        if (opened) {
          a.update(() => $block([0]).append($createTextNode(' there')));
        } else {
          Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
          b.binding.initialize();
        }
        await flush();
        expect(b.binding.status).toBe('readonly');
        const shown = b.describe();
        expect(shown).toBe(opened ? 'paragraph("hello")' : '');
        reads = 0;
        const vector = Y.encodeStateVector(b.doc);
        b.update(() => $getRoot().append($p('local edit')));
        await flush();
        expect(uncaught).toEqual([]);
        expect(b.errors).toEqual([]);
        expect(b.describe()).toBe(shown);
        expect(reads).toBe(0);
        expect(Y.encodeStateVector(b.doc)).toEqual(vector);
        expect(
          b.warnings.filter(w => w.includes('not written while read only')),
        ).toEqual([
          "a local change is not written while read only: an earlier warning says why the binding is read only. Edit only while binding.status is 'active'",
        ]);
      } finally {
        process.off('uncaughtException', onUncaught);
        proto.$apply = $apply;
        proto.$readFull = $readFull;
      }
    },
  );
});

type SerializedRequired = SerializedElementNode & {mode: string};
/**
 * A class whose `mode` its JSON always holds (its importJSON requires it),
 * and older versions of it that reject a value a newer one writes, each in
 * its own way.
 */
class RequiredV2 extends ElementNode {
  __mode = 'a';
  static getType(): string {
    return 'test_required';
  }
  static clone(node: RequiredV2): RequiredV2 {
    const copy = new RequiredV2(node.__key);
    copy.__mode = node.__mode;
    return copy;
  }
  static importJSON(json: SerializedRequired): RequiredV2 {
    return new RequiredV2().updateFromJSON(json);
  }
  updateFromJSON(json: LexicalUpdateJSON<SerializedRequired>): this {
    const self = super.updateFromJSON(json);
    self.__mode = json.mode;
    return self;
  }
  exportJSON(): SerializedRequired {
    return {...super.exportJSON(), mode: this.__mode, type: 'test_required'};
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}
function requiredV1(
  reject: (node: RequiredV2, json: SerializedRequired) => void,
): typeof RequiredV2 {
  return class RequiredV1 extends RequiredV2 {
    static getType(): string {
      return 'test_required';
    }
    static clone(node: RequiredV1): RequiredV1 {
      const copy = new RequiredV1(node.__key);
      copy.__mode = node.__mode;
      return copy;
    }
    static importJSON(json: SerializedRequired): RequiredV1 {
      return new RequiredV1().updateFromJSON(json);
    }
    updateFromJSON(json: LexicalUpdateJSON<SerializedRequired>): this {
      if (json.mode === 'a' || json.mode === 'b') {
        return super.updateFromJSON(json);
      }
      reject(this, json as SerializedRequired);
      throw new Error('unknown mode ' + json.mode);
    }
  };
}

describe('S7-21: what an older class does before it throws', () => {
  const $content = (mode: string) => () => {
    const box = $create(RequiredV2).append($p('inside'));
    box.__mode = mode;
    $getRoot().clear().append($p('FIRST'), box, $p('LAST'));
  };
  const opened = async (v1: typeof RequiredV2, mode: string) => {
    const a = new Peer(2, newNet() as never, [...NODES, RequiredV2]);
    a.update($content(mode));
    a.binding.initialize();
    await flush();
    const b = new Peer(1, newNet() as never, [...NODES, v1]);
    expect(() => {
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      b.binding.initialize();
    }).not.toThrow();
    await flush();
    return b;
  };

  test('a fallback node does not go through the importJSON that rejected it', async () => {
    const b = await opened(
      requiredV1(() => {}),
      'c',
    );
    expectUnreadable(b, 'test_required', null);
    expect(b.describe()).toContain('"FIRST"');
    expect(b.describe()).toContain('"LAST"');
  });

  test('what it throws need not be printable', async () => {
    const v1 = class extends requiredV1(() => {}) {
      static getType(): string {
        return 'test_required';
      }
      updateFromJSON(json: LexicalUpdateJSON<SerializedRequired>): this {
        if (json.mode !== 'a' && json.mode !== 'b') {
          throw Object.create(null);
        }
        return super.updateFromJSON(json);
      }
    };
    const b = await opened(v1, 'c');
    expect(b.errors).toEqual([]);
    expect(b.binding.status).toBe('readonly');
  });

  test.each([
    [
      'what it changed is undone',
      (node: RequiredV2) => {
        node.setFormat('right');
      },
    ],
    [
      'a change it made that Lexical cannot commit is undone',
      (node: RequiredV2) => {
        node.getWritable().__mode = 'c';
      },
    ],
  ])('a node it updates: %s', async (_name, reject) => {
    const v1 = class extends requiredV1(reject) {
      static getType(): string {
        return 'test_required';
      }
      getTextContent(): string {
        if (this.getLatest().__mode === 'c') {
          throw new Error('cannot show mode c');
        }
        return super.getTextContent();
      }
    };
    const net = newNet();
    const a = new Peer(2, net as never, [...NODES, RequiredV2]);
    const b = new Peer(1, net as never, [...NODES, v1]);
    a.update($content('a'));
    a.binding.initialize();
    await flush();
    const shown = b.describe();
    a.update(() => {
      ($block([1]) as RequiredV2).getWritable().__mode = 'c';
    });
    await flush();
    expectUnreadable(b, 'test_required', shown);
    expect(b.read(() => $block([1]).getFormatType())).toBe('');
  });

  test('a reader that throws null fails closed too', async () => {
    const a = new Peer(2, newNet() as never);
    a.update(() => $getRoot().clear().append($p('hello')));
    a.binding.initialize();
    await flush();
    const b = new Peer(1, newNet() as never);
    const proto = Reader.prototype as unknown as {
      $readFull: (...args: unknown[]) => void;
    };
    const {$readFull} = proto;
    proto.$readFull = () => {
      // eslint-disable-next-line no-throw-literal
      throw null;
    };
    try {
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      b.binding.initialize();
    } finally {
      proto.$readFull = $readFull;
    }
    await flush();
    expect(b.binding.status).toBe('readonly');
    const vector = Y.encodeStateVector(b.doc);
    b.update(() => $getRoot().append($p('typed while read only')));
    await flush();
    expect(Y.encodeStateVector(b.doc)).toEqual(vector);
  });
});

describe('N7: a room the binding cannot write is never editable', () => {
  const $content = (mode: string) => () => {
    const box = $create(RequiredV2).append($p('inside'));
    box.__mode = mode;
    $getRoot().clear().append($p('first'), box, $p('last'));
  };

  test.each([
    ['content its class throws on', [...NODES, requiredV1(() => {})], 'c'],
    ['a node type it does not register', NODES, 'a'],
    ['content it reads (control)', [...NODES, RequiredV2], 'a'],
  ])(
    'N7: opening a room holding %s makes the editor editable only once the read validated',
    async (name, nodes, mode) => {
      const a = new Peer(2, newNet() as never, [...NODES, RequiredV2]);
      a.update($content(mode));
      a.binding.initialize();
      await flush();
      const editable: boolean[] = [];
      const b = new Peer(1, newNet() as never, nodes, editor =>
        editor.registerEditableListener(value => {
          editable.push(value);
        }),
      );
      editable.length = 0;
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      b.binding.initialize();
      await flush();
      expect(b.errors).toEqual([]);
      expect(b.describe()).toContain('"first"');
      if (name.endsWith('(control)')) {
        expect(b.binding.status).toBe('active');
        expect(editable).toEqual([true]);
      } else {
        expect(b.binding.status).toBe('readonly');
        expect(editable).toEqual([]);
      }
    },
  );

  test('N7: a change to the layout record leaves it read only, with no local update shown and no warning again', async () => {
    const net = newNet();
    const a = new Peer(2, net as never, [...NODES, RequiredV2]);
    const b = new Peer(1, net as never, [...NODES, requiredV1(() => {})]);
    a.update($content('c'));
    a.binding.initialize();
    await flush();
    const shown = b.describe();
    expectUnreadable(b, 'test_required', shown);
    // Code that edits the editor as soon as it is editable.
    const editable: boolean[] = [];
    const stop = b.editor.registerEditableListener(value => {
      editable.push(value);
      if (value) {
        b.update(() => $getRoot().append($p('leak')));
      }
    });
    const written = () =>
      Y.decodeStateVector(Y.encodeStateVector(b.doc)).get(b.doc.clientID);
    const before = written();
    // A peer records a layout version this binding reads: the document is
    // read again.
    a.doc.transact(() => a.binding.root.setAttr('lexical-y:1', true));
    await flush();
    stop();
    expect(editable).toEqual([]);
    expectUnreadable(b, 'test_required', shown);
    expect(written()).toBe(before);
  });
});

describe('R2-2: an edit an editable listener makes when the room opens is written', () => {
  test('R2-2: an edit made when the editor becomes editable is stored, and the editor shows the document', async () => {
    const a = new Peer(2, newNet() as never);
    a.update(() => $getRoot().clear().append($p('hello')));
    a.binding.initialize();
    await flush();
    const editable: boolean[] = [];
    const b = new Peer(1, newNet() as never, NODES, editor =>
      editor.registerEditableListener(value => {
        editable.push(value);
        if (value && editable.filter(Boolean).length === 1) {
          editor.update(() => $getRoot().append($p('app edit')), {
            discrete: true,
          });
        }
      }),
    );
    editable.length = 0;
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    b.binding.initialize();
    await flush();
    expect(b.errors).toEqual([]);
    expect(b.warnings).toEqual([]);
    expect(b.binding.status).toBe('active');
    expect(editable).toEqual([true]);
    expect(b.describe()).toBe('paragraph("hello") / paragraph("app edit")');
    const fresh = new Peer(3, newNet() as never);
    Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(b.doc));
    fresh.binding.initialize();
    await flush();
    expect(fresh.describe()).toBe(b.describe());
  });
});

describe('R3-3: an editable listener that queues an edit and throws', () => {
  test('R3-3: opening a room, the edit is written and the error is rethrown apart', async () => {
    const a = new Peer(2, newNet() as never);
    a.update(() => $getRoot().clear().append($p('hello')));
    a.binding.initialize();
    await flush();
    let armed = false;
    const b = new Peer(1, newNet() as never, NODES, editor =>
      editor.registerEditableListener(value => {
        if (value && armed) {
          armed = false;
          editor.update(() => $getRoot().append($p('true reply')), {
            discrete: true,
          });
          throw new Error('editable listener error');
        }
      }),
    );
    armed = true;
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      b.binding.initialize();
      await flush();
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(armed).toBe(false);
    const fresh = new Peer(3, newNet() as never);
    Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(b.doc));
    fresh.binding.initialize();
    await flush();
    expect({shown: b.describe(), status: b.binding.status}).toEqual({
      shown: 'paragraph("hello") / paragraph("true reply")',
      status: 'active',
    });
    expect(fresh.describe()).toBe(b.describe());
    expect(b.errors).toEqual([]);
    expect(uncaught.map(String)).toEqual(['Error: editable listener error']);
  });
});

describe('R4-2: an update listener that throws on the commit after an editable listener queued an edit', () => {
  test('R4-2: opening a room: the edit runs once, and nothing escapes', async () => {
    const a = new Peer(2, newNet() as never);
    a.update(() => $getRoot().clear().append($p('hello')));
    a.binding.initialize();
    await flush();
    let runs = 0;
    let armed = false;
    const b = new Peer(1, newNet() as never, NODES, editor => {
      editor.registerEditableListener(value => {
        if (value && !armed && runs === 0) {
          armed = true;
          editor.update(
            () => {
              runs++;
              $getRoot().append($p('reply'));
            },
            {discrete: true},
          );
        }
      });
      editor.registerUpdateListener(() => {
        if (armed) {
          armed = false;
          throw new Error('update listener error');
        }
      });
    });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      expect(() => {
        Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
        b.binding.initialize();
      }).not.toThrow();
      await flush();
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(runs).toBe(1);
    expect(b.errors).toEqual([]);
    // The listener's error fails the read's commit (the binding fails
    // closed and warns with it) or is rethrown as an uncaught error.
    expect(
      uncaught.length +
        b.warnings.filter(w => w.includes('update listener error')).length,
    ).toBe(1);
    const fresh = new Peer(3, newNet() as never);
    Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(b.doc));
    fresh.binding.initialize();
    await flush();
    if (b.binding.status === 'active') {
      expect(b.describe()).toBe(fresh.describe());
    } else {
      expect(b.describe()).not.toContain('reply');
    }
  });

  test.each([
    ['a remote change applied on its own', false],
    ['a remote change applied inside an editor update', true],
  ])(
    'R4-2: failing closed, %s: the edit runs once and is refused, and nothing escapes',
    async (_name, nested) => {
      const a = new Peer(2, newNet() as never);
      const b = new Peer(1, newNet() as never);
      const sync = () =>
        Y.applyUpdate(
          b.doc,
          Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
        );
      a.update(() => $getRoot().clear().append($p('hello')));
      a.binding.initialize();
      await flush();
      sync();
      b.binding.initialize();
      await flush();
      let runs = 0;
      let armed = false;
      const stopEditable = b.editor.registerEditableListener(value => {
        if (!value && runs === 0) {
          armed = true;
          b.editor.update(
            () => {
              runs++;
              $getRoot().append($p('freeze reply'));
            },
            {discrete: true},
          );
        }
      });
      // Throws on the first commit with no tags after the editor stopped
      // being editable.
      const stopUpdate = b.editor.registerUpdateListener(({tags}) => {
        if (armed && tags.size === 0) {
          armed = false;
          throw new Error('update listener error');
        }
      });
      const proto = Reader.prototype as unknown as {
        $apply: (...args: unknown[]) => void;
        $readFull: (...args: unknown[]) => void;
      };
      const {$apply, $readFull} = proto;
      proto.$apply = proto.$readFull = () => {
        throw new Error('simulated reader failure');
      };
      const uncaught: unknown[] = [];
      const onUncaught = (error: unknown) => uncaught.push(error);
      process.on('uncaughtException', onUncaught);
      const escaped: unknown[] = [];
      try {
        a.update(() => $block([0]).append($createTextNode(' there')));
        await flush();
        try {
          if (nested) {
            b.editor.update(sync, {discrete: true});
          } else {
            sync();
          }
        } catch (error) {
          escaped.push(error);
        }
        await flush();
      } finally {
        process.off('uncaughtException', onUncaught);
        proto.$apply = $apply;
        proto.$readFull = $readFull;
        stopEditable();
        stopUpdate();
      }
      // Never out of Y.applyUpdate. Applied inside the app's update, the
      // edit commits with it, and the error of the app's listener on that
      // commit is the app's update's.
      expect(nested ? [] : escaped).toEqual([]);
      expect([...escaped, ...uncaught].map(String)).toEqual([
        'Error: update listener error',
      ]);
      expect(runs).toBe(1);
      expect(b.binding.status).toBe('readonly');
      expect(b.describe()).toBe('paragraph("hello")');
      expect(b.warnings).toEqual([
        'the document cannot be read: simulated reader failure. This editor is read only until it is built again: data.error holds what the read threw; fix that, then reload the editor',
        "a local change is not written while read only: an earlier warning says why the binding is read only. Edit only while binding.status is 'active'",
      ]);
    },
  );
});

describe('R5: the order and the fate of an edit an editable listener makes when the room opens', () => {
  const opened = async (
    reply: () => void,
  ): Promise<{b: Peer; open: () => void; runs: () => number}> => {
    const a = new Peer(2, newNet() as never);
    a.update(() => $getRoot().clear().append($p('hello')));
    a.binding.initialize();
    await flush();
    let runs = 0;
    const b = new Peer(1, newNet() as never, NODES, editor =>
      editor.registerEditableListener(value => {
        if (value && runs === 0) {
          editor.update(
            () => {
              runs++;
              reply();
            },
            {discrete: true},
          );
        }
      }),
    );
    // Opened by the provider's sync: the binding reads the document it
    // brings.
    const open = () => Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    return {b, open, runs: () => runs};
  };

  test('R6-1: an update queued in reply to the read before the editor became editable commits before the edit', async () => {
    const a = new Peer(2, newNet() as never);
    a.update(() => $getRoot().clear().append($p('hello')));
    a.binding.initialize();
    await flush();
    let older = false;
    let newer = false;
    const b = new Peer(1, newNet() as never, NODES, editor => {
      editor.registerUpdateListener(({tags}) => {
        if (!older && tags.has(COLLABORATION_TAG)) {
          older = true;
          editor.update(() => $getRoot().append($p('older')), {
            discrete: true,
          });
        }
      });
      editor.registerEditableListener(value => {
        if (value && !newer) {
          newer = true;
          editor.update(() => $getRoot().append($p('newer')), {
            discrete: true,
          });
        }
      });
    });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    await flush();
    expect(b.errors).toEqual([]);
    expect(b.binding.status).toBe('active');
    expect(b.describe()).toBe(
      'paragraph("hello") / paragraph("older") / paragraph("newer")',
    );
    const fresh = new Peer(3, newNet() as never);
    Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(b.doc));
    fresh.binding.initialize();
    await flush();
    expect(fresh.describe()).toBe(b.describe());
  });

  test('R5-1: a command an editable listener dispatches is written', async () => {
    const a = new Peer(2, newNet() as never);
    a.update(() => $getRoot().clear().append($p('hello')));
    a.binding.initialize();
    await flush();
    const APPEND = createCommand<string>('test_append');
    let runs = 0;
    const b = new Peer(1, newNet() as never, NODES, editor => {
      editor.registerCommand(
        APPEND,
        text => {
          runs++;
          $getRoot().append($p(text));
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      );
      editor.registerEditableListener(value => {
        if (value && runs === 0) {
          editor.dispatchCommand(APPEND, 'reply');
        }
      });
    });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    await flush();
    expect(runs).toBe(1);
    expect(b.errors).toEqual([]);
    expect(b.binding.status).toBe('active');
    expect(b.describe()).toBe('paragraph("hello") / paragraph("reply")');
    const fresh = new Peer(3, newNet() as never);
    Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(b.doc));
    fresh.binding.initialize();
    await flush();
    expect(fresh.describe()).toBe(b.describe());
  });

  test('R5-2: an update the app makes right after opening commits after the edit', async () => {
    const {b, open} = await opened(() => {
      $getRoot().clear().append($p('first'));
    });
    open();
    b.editor.update(() => $getRoot().append($p('second')), {discrete: true});
    await flush();
    expect(b.binding.status).toBe('active');
    expect(b.describe()).toBe('paragraph("first") / paragraph("second")');
    const fresh = new Peer(3, newNet() as never);
    Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(b.doc));
    fresh.binding.initialize();
    await flush();
    expect(fresh.describe()).toBe(b.describe());
  });

  test('R5-3: the binding disposed right after opening: the edit still runs on the editor, and the document has nothing of it', async () => {
    const {b, open, runs} = await opened(() => {
      $getRoot().append($p('reply'));
    });
    open();
    const stored = JSON.stringify(b.doc.get('lexical-y').toJSON());
    b.binding.dispose();
    await flush();
    expect(runs()).toBe(1);
    expect(b.describe()).toBe('paragraph("hello") / paragraph("reply")');
    expect(JSON.stringify(b.doc.get('lexical-y').toJSON())).toBe(stored);
  });
});

describe('R2-3: an edit an editable listener makes when the binding fails closed', () => {
  test.each([
    ['a remote change applied on its own', false],
    ['a remote change applied inside an editor update', true],
  ])(
    'R2-3: %s: the editor goes back to what it showed, and the edit is refused',
    async (_name, nested) => {
      const a = new Peer(2, newNet() as never);
      const b = new Peer(1, newNet() as never);
      const sync = () =>
        Y.applyUpdate(
          b.doc,
          Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
        );
      a.update(() => $getRoot().clear().append($p('hello')));
      a.binding.initialize();
      await flush();
      sync();
      b.binding.initialize();
      await flush();
      const shown = b.describe();
      expect(shown).toBe('paragraph("hello")');
      const stop = b.editor.registerEditableListener(value => {
        if (!value) {
          b.editor.update(() => $getRoot().append($p('freeze callback edit')), {
            discrete: true,
          });
        }
      });
      const written = () =>
        Y.decodeStateVector(Y.encodeStateVector(b.doc)).get(b.doc.clientID);
      const before = written();
      // Every read throws, and so does the fresh read after it: b fails
      // closed.
      const proto = Reader.prototype as unknown as {
        $apply: (...args: unknown[]) => void;
        $readFull: (...args: unknown[]) => void;
      };
      const {$apply, $readFull} = proto;
      proto.$apply = proto.$readFull = () => {
        throw new Error('simulated reader failure');
      };
      try {
        a.update(() => $block([0]).append($createTextNode(' there')));
        await flush();
        if (nested) {
          b.editor.update(sync, {discrete: true});
        } else {
          sync();
        }
        await flush();
      } finally {
        proto.$apply = $apply;
        proto.$readFull = $readFull;
        stop();
      }
      expect(b.errors).toEqual([]);
      expect(b.binding.status).toBe('readonly');
      expect(b.describe()).toBe(shown);
      expect(written()).toBe(before);
      expect(b.warnings).toEqual([
        'the document cannot be read: simulated reader failure. This editor is read only until it is built again: data.error holds what the read threw; fix that, then reload the editor',
        "a local change is not written while read only: an earlier warning says why the binding is read only. Edit only while binding.status is 'active'",
      ]);
    },
  );
});

describe('S7-21 (MF-2): every read goes through the one fail-closed path', () => {
  /** Make `method` of the reader throw `error` once. */
  const throwOnce = (
    method: string,
    error: unknown,
    when: (reader: unknown) => boolean = () => true,
  ) => {
    const proto = Reader.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const original = proto[method];
    proto[method] = function (this: unknown, ...args: unknown[]) {
      if (!when(this)) {
        return original.apply(this, args);
      }
      proto[method] = original;
      throw error;
    };
    return () => {
      proto[method] = original;
    };
  };

  test('releasing what a composition held back', async () => {
    const t = await setup(() => $getRoot().append($p('alpha beta gamma')));
    let key = '';
    t.a.update(() => {
      const [node, offset] = $locateIn($block([0]), 16);
      node.select(offset, offset);
      $setCompositionKey(node.getKey());
      key = node.getKey();
    });
    t.a.update(() => {
      const node = $getNodeByKey(key) as TextNode;
      node.setTextContent('alpha beta gammaか');
      node.select(17, 17);
    });
    await t.sync();
    // Typed into the composed line: held back on the composing client.
    t.b.update(() => {
      const [node] = $locateIn($block([0]), 0);
      (node as TextNode).spliceText(0, 0, 'XY');
    });
    await t.sync();
    // The release reads what was held where it is (see YBinding#$release),
    // on the composing client.
    const state = (t.a.binding as unknown as {state: unknown}).state;
    const restore = throwOnce(
      '$apply',
      new Error('simulated reader failure'),
      reader => (reader as {state: unknown}).state === state,
    );
    try {
      expect(() =>
        t.a.update(() => {
          const node = $getNodeByKey(key) as TextNode;
          node.setTextContent('alpha beta gamma漢');
          node.select(17, 17);
          $setCompositionKey(null);
        }),
      ).not.toThrow();
      await flush();
      await t.sync();
    } finally {
      restore();
    }
    expect(t.a.errors).toEqual([]);
    expect(t.a.warnings).toEqual([
      'a remote change could not be read: simulated reader failure',
    ]);
    expect(t.a.binding.status).toBe('active');
    expect(t.a.describe()).toBe(t.b.describe());
    expect(t.a.describe()).toContain('XY');
  });

  test.each([
    ['once: read again', 1],
    ['on every read: kept as shown, read only', Infinity],
  ])(
    'a re-read of what a follow-up changed that throws %s',
    async (_name, times) => {
      const net = newNet();
      const a = new Peer(2, net as never);
      const b = new Peer(1, net as never);
      a.update(() => $getRoot().clear().append($p('hello')));
      a.binding.initialize();
      await flush();
      const shown = b.describe();
      // As a follow-up the binding does not write leaves it (see
      // rereadRefused): the root's container is read again, as the
      // binding's own work.
      const binding = b.binding as unknown as {
        _root: unknown;
        guard: (fn: () => void) => void;
        refused: Set<unknown>;
        rereadRefused: () => void;
        state: {containers: Map<unknown, unknown>};
      };
      binding.refused.add(binding.state.containers.get(binding._root));
      const proto = Reader.prototype as unknown as {
        $readFull: (...args: unknown[]) => void;
      };
      const {$readFull} = proto;
      let left = times;
      proto.$readFull = function (this: unknown, ...args: unknown[]) {
        if (left-- > 0) {
          throw new Error('simulated reader failure');
        }
        return $readFull.apply(this, args);
      };
      try {
        expect(() =>
          binding.guard(() => binding.rereadRefused()),
        ).not.toThrow();
        await flush();
      } finally {
        proto.$readFull = $readFull;
      }
      expect(b.errors).toEqual([]);
      expect(b.describe()).toBe(shown);
      if (times === 1) {
        expect(b.warnings).toEqual([
          'a change could not be read again: simulated reader failure',
        ]);
        expect(b.binding.status).toBe('active');
      } else {
        expect(b.warnings).toEqual([
          'the document cannot be read: simulated reader failure. This editor is read only until it is built again: data.error holds what the read threw; fix that, then reload the editor',
        ]);
        expect(b.binding.status).toBe('readonly');
      }
    },
  );

  test('a thrown value whose text cannot be read', async () => {
    // Neither String() nor Object.prototype.toString can read it.
    const unprintable = Object.create(null, {
      [Symbol.toStringTag]: {
        get() {
          throw new Error('no tag');
        },
      },
    });
    const a = new Peer(2, newNet() as never);
    a.update(() => $getRoot().clear().append($p('hello')));
    a.binding.initialize();
    await flush();
    const b = new Peer(1, newNet() as never);
    const restore = throwOnce('$readFull', unprintable);
    try {
      expect(() => {
        Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
        b.binding.initialize();
      }).not.toThrow();
    } finally {
      restore();
    }
    await flush();
    expect(b.binding.status).toBe('readonly');
    expect(b.warnings).toEqual([
      'the document cannot be read: a value that cannot be shown as text. This editor is read only until it is built again: data.error holds what the read threw; fix that, then reload the editor',
    ]);
  });
});

/**
 * `peer` opened the room read only for stored content of `type` its class
 * throws on, warned once, threw nothing, and shows `shown` (when given).
 */
function expectUnreadable(peer: Peer, type: string, shown: string | null) {
  expect(peer.errors).toEqual([]);
  expect(peer.binding.status).toBe('readonly');
  expect(
    peer.warnings.filter(w => !w.includes('stored as a nested node')),
  ).toEqual([
    `stored content the editor's classes cannot read: ${type}. Their classes threw on the stored values (data.error), so this editor is read only: make them accept what another version of your app wrote, and bump schemaVersion when a class changes what it stores`,
  ]);
  if (shown !== null) {
    expect(peer.describe()).toBe(shown);
  }
}

/** An edit of read-only `peer` changes nothing `other` shows or stores. */
async function expectWritesNothing(peer: Peer, other: Peer) {
  const vector = Y.encodeStateVector(peer.doc);
  const before = docJSON(other);
  peer.update(() => $getRoot().append($p('typed while read only')));
  await flush();
  expect(Y.encodeStateVector(peer.doc)).toEqual(vector);
  expect(docJSON(other)).toBe(before);
}

// ---------------------------------------------------------------------------

// The same rules for a server agent whose config has the older classes: the
// headless helpers write through the same binding.
describe('S7-3, S7-11, S7-21: a server agent with older classes', () => {
  const quiet = () => {};
  const refusal = (edit: () => void) => {
    try {
      edit();
    } catch (error) {
      return error;
    }
    throw new Error('the edit was not refused');
  };

  test('S7-3: its edit keeps the fields its classes do not declare', () => {
    const seeded = seedYState(
      {nodes: V2, onWarn: quiet, schemaVersion: 1},
      () => $getRoot().append($card(), $p('after')),
    );
    const {state} = editYState(
      seeded,
      {nodes: V1, onWarn: quiet, schemaVersion: 1},
      () => $block([0]).setFormat('center'),
      {writer: null},
    );
    expect(
      readYState(state, {nodes: V2, onWarn: quiet, schemaVersion: 1}, () => {
        const card = $block([0]) as CardV2;
        return [card.getFormatType(), card.__tone];
      }),
    ).toEqual(['center', 'warm']);
  });

  test('S7-11: it refuses a document with a link type it does not register', () => {
    const seeded = seedYState(
      {nodes: [...NODES, UnknownLink], onWarn: quiet, schemaVersion: 1},
      () => {
        const link = $create(UnknownLink);
        link.__url = 'https://a.dev';
        $getRoot().append($p('see ').append(link.append($createTextNode('x'))));
      },
    );
    const error = refusal(() =>
      editYState(
        seeded,
        {nodes: NODES, onWarn: quiet, schemaVersion: 1},
        () => {
          const box = $createBoxNode('t');
          $block([0]).insertBefore(box);
          box.append($block([1]));
        },
        {writer: null},
      ),
    );
    expect(error).toBeInstanceOf(YHeadlessError);
    expect(error).toMatchObject({
      code: 'read-only',
      warnings: [
        {
          code: UNKNOWN_NODE_TYPES_WARNING,
          data: {reason: 'unregistered', types: ['test_unknown_link']},
        },
      ],
    });
  });

  test('S7-21: it refuses a document its classes throw on', () => {
    const seeded = seedYState(
      {nodes: [...NODES, modeBox.ModeV2], onWarn: quiet, schemaVersion: 1},
      () => {
        const box = $create(modeBox.ModeV2).append($p('in the box'));
        box.__mode = 'v2only';
        $getRoot().append(box);
      },
    );
    const error = refusal(() =>
      editYState(
        seeded,
        {nodes: [...NODES, modeBox.ModeV1], onWarn: quiet, schemaVersion: 1},
        () => $getRoot().append($p('more')),
        {writer: null},
      ),
    );
    expect(error).toBeInstanceOf(YHeadlessError);
    expect(error).toMatchObject({code: 'read-only'});
    expect((error as YHeadlessError).warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: UNKNOWN_NODE_TYPES_WARNING,
          data: expect.objectContaining({
            reason: 'unreadable',
            types: ['test_mode_box'],
          }),
        }),
      ]),
    );
  });
});

// N2: a local update made before a remote change the binding has not read
// yet is written on the document its editor shows (see Unread). The group
// fields a client does not own, which a new item takes from the item next to
// it, are read in that document too, so the run where the update waits for
// the change ends as the run where it is written before the change arrives.
describe('N2: a write before an unread remote change reads the document its editor shows', () => {
  // The editor's update `$local`, made while the remote change waits to be
  // read (`waiting`), or written before it arrives.
  const edit = (r: Room, waiting: boolean, $local: () => void) => {
    if (waiting) {
      // Not committed yet when the remote change arrives in this task: it is
      // committed and written first, and the change is read after it.
      r.editor.editor.update($local);
    } else {
      r.editor.update($local);
    }
  };
  // Delivers what the two clients sent while offline, until they converge.
  const deliver = async (r: Room) => {
    r.author.online = true;
    r.editor.online = true;
    for (let i = 0; i < 3; i++) {
      for (const [to, from] of [
        [r.editor, r.author],
        [r.author, r.editor],
      ] as const) {
        const list = to.pending.get(from) || [];
        to.pending.delete(from);
        if (list.length > 0) {
          Y.applyUpdate(
            to.doc,
            Y.mergeUpdates(list as Uint8Array<ArrayBuffer>[]),
            to.net,
          );
        }
      }
      await flush();
    }
    expect([...r.editor.errors, ...r.author.errors]).toEqual([]);
  };
  const run = async (
    nodes: Klass<LexicalNode>[],
    waiting: boolean,
    $init: () => void,
    $remote: () => void,
    $local: () => void,
  ): Promise<string> => {
    const r = await room(nodes, $init);
    r.author.online = false;
    r.editor.online = false;
    r.author.update($remote);
    edit(r, waiting, $local);
    await deliver(r);
    return docJSON(await freshReader(r.author));
  };
  const $retoneList = () => {
    ($getRoot().getFirstChildOrThrow() as ListV2).getWritable().__tone = 'cool';
  };
  const $item = () => $createListItemNode().append($createTextNode('z'));
  // The stored type is read there too: where a remote change retypes a node,
  // this client owns the fields of the type its editor shows (see
  // ownedFields), so its write deletes no field it does not own.
  test('a card a remote change retypes, centered meanwhile', async () => {
    const stored: Record<string, unknown>[] = [];
    for (const waiting of [false, true]) {
      const r = await room(V1, () => $getRoot().append($card(), $p('para')));
      let card: Y.Node | null = null;
      for (let it = r.author.doc.get('lexical-y')._start; it; it = it.right) {
        const content = it.content;
        if (
          content instanceof Y.ContentType &&
          String((content.type as Y.Node).name).slice(2) === 'test_skew_card'
        ) {
          card = content.type as Y.Node;
        }
      }
      r.author.online = false;
      r.editor.online = false;
      // To a type both clients register, whose class declares the tone.
      r.author.doc.transact(() => card!.setAttr('t', 'test_box'));
      edit(r, waiting, () => $block([0]).setFormat('center'));
      await deliver(r);
      stored.push(card!.getAttrs());
    }
    expect(stored[0]).toMatchObject({'p:tone': 'warm', t: 'test_box'});
    expect(stored[1]).toEqual(stored[0]);
  });
  test.each([
    [
      'appended to it',
      () => ($getRoot().getFirstChildOrThrow() as ListNode).append($item()),
    ],
    [
      'added before its first item',
      () =>
        ($getRoot().getFirstChildOrThrow() as ListNode)
          .getFirstChildOrThrow()
          .insertBefore($item()),
    ],
  ])('an item %s, in a list a remote change retones', async (_what, $local) => {
    const $init = () => $getRoot().append($list('x', 'y'), $p('para'));
    for (const nodes of [V1, V2]) {
      const concurrent = await run(nodes, false, $init, $retoneList, $local);
      const waiting = await run(nodes, true, $init, $retoneList, $local);
      expect(waiting).toBe(concurrent);
    }
  });
  // A moved block keeps the fields it stored before the write (see
  // attrsBefore), as the document the write sees has them.
  type Toned = NoteV2 | CardV2 | ListV2;
  test.each([
    ['a note', () => $note()],
    ['a card', () => $card()],
    ['a list', () => $list('x', 'y')],
  ])('%s that a remote change retones, moved down', async (_what, $make) => {
    const $init = () => $getRoot().append($make(), $p('para'));
    const $retone = () => {
      const node = $getRoot().getFirstChildOrThrow() as Toned;
      node.getWritable().__tone = 'cool';
    };
    const $move = () =>
      $getRoot()
        .getLastChildOrThrow()
        .insertAfter($getRoot().getFirstChildOrThrow());
    for (const nodes of [V1, V2]) {
      const concurrent = await run(nodes, false, $init, $retone, $move);
      const waiting = await run(nodes, true, $init, $retone, $move);
      expect(waiting).toBe(concurrent);
    }
  });
});

// N1: a client that splits a line whose marker stores a field no class of
// it declares cannot tell whether the newer class copies that field to the
// new line, so the field stays on both lines: one keeps the old marker, and
// the marker the write makes for the other takes what the old one stored
// (see $markerBefore). The empty line Enter makes at the end of a line has
// what the editor shows. A client that composes as it splits stores the
// same (see the composition regression tests).
describe('N1: a split by a client that does not own a field of the line', () => {
  const markers = (p: Peer): Y.Node[] => {
    const out: Y.Node[] = [];
    const root = p.doc.get('lexical-y');
    for (let it = root._start; it !== null; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentType) {
        out.push(it.content.type as Y.Node);
      }
    }
    return out;
  };
  test.each([
    ['at its start', 0, 2],
    ['inside it', 3, 2],
    ['at its end', 6, 1],
  ])('Enter %s stores the field on %i line(s)', async (_where, at, copies) => {
    for (const nodes of [V1, V2]) {
      const r = await room(nodes, () =>
        $getRoot().append($p('pre'), $p('a line'), $p('post')),
      );
      r.author.doc.transact(() => {
        markers(r.author)[1].setAttr('p:future', 'x');
      });
      await flush();
      r.editor.update(() => $selectIn([1], at).insertParagraph());
      await flush();
      expect(r.editor.errors).toEqual([]);
      expect(
        markers(r.author).filter(m => m.getAttr('p:future') === 'x'),
      ).toHaveLength(copies);
      expect(shape(await freshReader(r.author))).toEqual(shape(r.author));
    }
  });
});

// The data of the warning stays an interface an app can extend.
export interface AppUnknownNodeTypesData extends YUnknownNodeTypesData {
  readonly requestId: string;
}
