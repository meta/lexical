/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {CodeHighlightNode, CodeNode} from '@lexical/code';
import {
  BlockIdExtension,
  buildEditorFromExtensions,
  configExtension,
  defineExtension,
  getExtensionDependencyFromEditor,
  registerNodeStructure,
} from '@lexical/extension';
import {AutoLinkNode, LinkNode} from '@lexical/link';
import {
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {MarkNode} from '@lexical/mark';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {TableCellNode, TableNode, TableRowNode} from '@lexical/table';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  $setSelection,
  createEditor,
  DecoratorNode,
  ElementNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  nodeSchema,
  type SerializedEditorState,
  stringValue,
  type TextNode,
  withField,
} from 'lexical';
import {expect} from 'vitest';

import {createYDoc, YBinding, YCollabExtension, type YDoc} from '../..';

// An undeclared block container with a schema field ('node').
const boxSchema = nodeSchema<BoxNode>()({
  tone: withField(stringValue(), {field: '__tone'}),
});
export class BoxNode extends ElementNode {
  __tone: string = '';
  $config() {
    return this.config('test_box', {extends: ElementNode, json: boxSchema});
  }
  getTone(): string {
    return this.getLatest().__tone;
  }
  setTone(tone: string): this {
    const self = this.getWritable();
    self.__tone = tone;
    return self;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}
export const $createBoxNode = (tone = '') => $create(BoxNode).setTone(tone);

// Collapsible-like: container > title (inline content) + content (shadow).
export class ColContainerNode extends ElementNode {
  $config() {
    return this.config('test_col', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}
export class ColTitleNode extends ElementNode {
  $config() {
    return this.config('test_col_title', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}
export class ColContentNode extends ElementNode {
  $config() {
    return this.config('test_col_content', {extends: ElementNode});
  }
  isShadowRoot(): boolean {
    return true;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}

const widgetSchema = nodeSchema<WidgetNode>()({
  label: withField(stringValue(), {field: '__label'}),
});
export class WidgetNode extends DecoratorNode<null> {
  __label: string = '';
  $config() {
    return this.config('test_widget', {
      extends: DecoratorNode,
      json: widgetSchema,
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
export class EquationNode extends DecoratorNode<null> {
  __equation: string = '';
  $config() {
    return this.config('test_equation', {
      extends: DecoratorNode,
      json: nodeSchema<EquationNode>()({
        equation: withField(stringValue(), {field: '__equation'}),
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
export const $createEquation = (equation: string) => {
  const n = $create(EquationNode);
  n.getWritable().__equation = equation;
  return n;
};

export const NODES: Klass<LexicalNode>[] = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  AutoLinkNode,
  TableNode,
  TableRowNode,
  TableCellNode,
  CodeNode,
  CodeHighlightNode,
  MarkNode,
  BoxNode,
  ColContainerNode,
  ColTitleNode,
  ColContentNode,
  WidgetNode,
  EquationNode,
];

export type Delivery = 'causal' | 'sender';

type Network = {
  peers: Peer[];
  delivery: Delivery;
  queue: [Peer, Uint8Array][];
  pumping: boolean;
};

function pump(net: Network) {
  if (net.pumping) {
    return;
  }
  net.pumping = true;
  try {
    for (let next = net.queue.shift(); next; next = net.queue.shift()) {
      Y.applyUpdate(next[0].doc, next[1], net);
    }
  } finally {
    net.pumping = false;
  }
}

export class Peer {
  readonly doc: YDoc;
  readonly editor: LexicalEditor;
  readonly binding: YBinding;
  online = true;
  pending = new Map<Peer, Uint8Array[]>();
  errors: unknown[] = [];
  warnings: string[] = [];
  stop: () => void;

  constructor(
    clientID: number,
    readonly net: Network,
    readonly nodes: Klass<LexicalNode>[] = NODES,
    /** Runs on the editor before the binding starts. */
    readonly prepare?: (editor: LexicalEditor) => void,
    readonly withBlockIds: boolean = WITH_BLOCK_IDS,
    /** Yjs garbage collection (products use Yjs's default, on). */
    readonly gc: boolean = WITH_GC,
  ) {
    this.doc = createYDoc(null, {gc});
    this.doc.clientID = clientID;
    const bound = createBoundEditor(this.doc, {
      namespace: 'test',
      nodes,
      onError: e => {
        this.errors.push(e);
        throw e;
      },
      onWarn: e => {
        this.warnings.push(String(e && (e as Error).message));
      },
      // The binding's warnings go to the editor's onWarn (above). The tests
      // turn the self-check on (it is off by default), so that a mismatch
      // fails them (expectConverged); benchmarks measure without it.
      selfCheck: process.env.LEXICAL_Y_BENCH !== '1',
      withBlockIds,
    });
    this.editor = bound.editor;
    this.binding = bound.binding;
    if (prepare) {
      prepare(this.editor);
    }
    this.stop = bound.start();
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this.net) {
        return;
      }
      for (const peer of this.net.peers) {
        if (peer === this) {
          continue;
        }
        if (this.online && peer.online && this.net.delivery === 'causal') {
          this.net.queue.push([peer, update]);
        } else {
          const list = peer.pending.get(this) || [];
          list.push(update);
          peer.pending.set(this, list);
        }
      }
      pump(this.net);
    });
    net.peers.push(this);
  }

  update(fn: () => void, tag?: string) {
    this.binding.undoManager?.stopCapturing();
    this.editor.update(fn, {discrete: true, tag});
  }

  read<T>(fn: () => T): T {
    return this.editor.getEditorState().read(fn);
  }

  describe(): string {
    return this.read(() =>
      $getRoot().getChildren().map(describeNode).join(' / '),
    );
  }

  json(): SerializedEditorState {
    return this.editor.getEditorState().toJSON();
  }

  undo() {
    this.binding.undoManager!.stopCapturing();
    this.binding.undo();
  }
}

export function describeNode(node: LexicalNode): string {
  if ($isTextNode(node)) {
    const format = node.getFormat();
    return (
      JSON.stringify(node.getTextContent()) + (format ? `{${format}}` : '')
    );
  }
  if ($isLineBreakNode(node)) {
    return 'br';
  }
  if (node instanceof EquationNode) {
    return `eq[${node.__equation}]`;
  }
  if (!$isElementNode(node)) {
    return node.getType();
  }
  let label = node.getType();
  if (node instanceof HeadingNode) {
    label += `[${node.getTag()}]`;
  } else if ($isListNode(node)) {
    label += `[${node.getListType()}${node.getStart() !== 1 ? ',' + node.getStart() : ''}]`;
  } else if (node instanceof LinkNode) {
    label += `<${node.getURL()}>`;
  } else if (node instanceof MarkNode) {
    label += `<${node.getIDs().join(',')}>`;
  } else if (node instanceof BoxNode && node.getTone() !== '') {
    label += `[${node.getTone()}]`;
  }
  if ($isListItemNode(node) && node.getChecked() !== undefined) {
    label += node.getChecked() ? '[x]' : '[ ]';
  }
  return `${label}(${node.getChildren().map(describeNode).join(' ')})`;
}

export async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

export type Setup = {
  a: Peer;
  b: Peer;
  c: Peer;
  peers: Peer[];
  offline: () => void;
  sync: () => Promise<void>;
};

export async function setup(
  init: () => void,
  options: {
    ids?: number[];
    delivery?: Delivery;
    nodes?: Klass<LexicalNode>[];
    prepare?: (editor: LexicalEditor) => void;
    withBlockIds?: boolean;
    gc?: boolean;
  } = {},
): Promise<Setup> {
  const net: Network = {
    delivery: 'causal',
    peers: [],
    pumping: false,
    queue: [],
  };
  const ids = options.ids ?? [1, 2];
  const peers = ids.map(
    id =>
      new Peer(
        id,
        net,
        options.nodes,
        options.prepare,
        options.withBlockIds,
        options.gc,
      ),
  );
  const [a] = peers;
  a.update(() => {
    $getRoot().clear();
    init();
  });
  a.binding.initialize();
  await flush();
  for (const peer of peers) {
    expect(peer.binding.status).toBe('active');
    peer.binding.undoManager?.clear();
  }
  net.delivery = options.delivery ?? 'causal';
  const deliverMerged = () => {
    for (const sender of peers) {
      for (const receiver of peers) {
        const list = receiver.pending.get(sender);
        if (list !== undefined && list.length > 0) {
          receiver.pending.delete(sender);
          net.queue.push([
            receiver,
            Y.mergeUpdates(list as Uint8Array<ArrayBuffer>[]),
          ]);
        }
      }
    }
    pump(net);
  };
  const sync = async () => {
    for (const peer of peers) {
      peer.online = true;
    }
    if (net.delivery === 'causal') {
      deliverMerged();
    } else {
      for (const sender of [...peers].reverse()) {
        for (const receiver of peers) {
          const list = receiver.pending.get(sender) || [];
          receiver.pending.delete(sender);
          for (const update of list) {
            net.queue.push([receiver, update]);
            pump(net);
          }
        }
      }
    }
    await flush();
    for (let round = 0; round < 3; round++) {
      deliverMerged();
      await flush();
    }
  };
  return {
    a,
    b: peers[1],
    c: peers[2],
    offline() {
      for (const peer of peers) {
        peer.online = false;
      }
    },
    peers,
    sync,
  };
}

export async function freshReader(
  from: Peer,
  nodes?: Klass<LexicalNode>[],
): Promise<Peer> {
  const net: Network = {
    delivery: 'causal',
    peers: [],
    pumping: false,
    queue: [],
  };
  const peer = new Peer(
    99,
    net,
    nodes || from.nodes,
    from.prepare,
    from.withBlockIds,
  );
  Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(from.doc), 'load');
  peer.binding.initialize();
  await flush();
  return peer;
}

/** The tree without derived list numbering (each client recomputes it). */
export function shape(peer: Peer): unknown {
  return JSON.parse(JSON.stringify(peer.json()));
}

export async function expectConverged(peers: Peer[], expected?: string) {
  const first = peers[0];
  for (const peer of peers) {
    expect(peer.errors).toEqual([]);
    expect(peer.warnings.filter(w => w.includes('self-check'))).toEqual([]);
    expect(peer.describe()).toBe(first.describe());
    expect(shape(peer)).toEqual(shape(first));
  }
  const fresh = await freshReader(first);
  expect(fresh.describe()).toBe(first.describe());
  expect(shape(fresh)).toEqual(shape(first));
  if (expected !== undefined) {
    expect(first.describe()).toBe(expected);
  }
}

export function $block(path: number[]): ElementNode {
  let node: LexicalNode = $getRoot();
  for (const i of path) {
    node = (node as ElementNode).getChildAtIndex(i)!;
  }
  return node as ElementNode;
}

export function $locateIn(
  block: ElementNode,
  offset: number,
): [TextNode, number] {
  const texts = block.getAllTextNodes();
  let acc = 0;
  for (let i = 0; i < texts.length; i++) {
    const size = texts[i].getTextContentSize();
    if (
      offset < acc + size ||
      (offset === acc + size && i === texts.length - 1)
    ) {
      return [texts[i], offset - acc];
    }
    acc += size;
  }
  throw new Error(`offset ${offset} out of range`);
}

export function $selectIn(path: number[], start: number, end: number = start) {
  const block = $block(path);
  const [startNode, startOffset] = $locateIn(block, start);
  const [endNode, endOffset] = $locateIn(block, end);
  const selection = $createRangeSelection();
  selection.anchor.set(startNode.getKey(), startOffset, 'text');
  selection.focus.set(endNode.getKey(), endOffset, 'text');
  $setSelection(selection);
  return selection;
}

export const $p = (text: string) =>
  $createParagraphNode().append($createTextNode(text));

/**
 * What Lexical's own normalization (NodeStructureExtension, applied to the
 * whole document in a fresh editor) still changes in `json`, or null when it
 * changes nothing: a check of the binding's normalization that does not use
 * the binding's own rules.
 */
export function mainNormalizes(peer: Peer): string | null {
  const json = peer.json();
  const editor = createEditor({
    namespace: 'oracle',
    nodes: [...peer.editor._nodes.values()].map(({klass}) => klass),
    onError: e => {
      throw e;
    },
  });
  editor.setEditorState(editor.parseEditorState(json));
  const before = JSON.stringify(editor.getEditorState().toJSON());
  const dispose = registerNodeStructure(editor);
  editor.update(() => {}, {discrete: true});
  const after = JSON.stringify(editor.getEditorState().toJSON());
  dispose();
  return before === after ? null : after;
}

/**
 * Whether the tests build their editors with BlockIdExtension
 * (`LEXICAL_Y_BLOCK_ID=1`): the editor is then built from extensions,
 * YCollabExtension and BlockIdExtension, as an app that uses both does.
 */
export const WITH_BLOCK_IDS = process.env.LEXICAL_Y_BLOCK_ID === '1';
/**
 * Peers' Yjs garbage collection: off unless a test asks for it, or
 * `LEXICAL_Y_GC=1` runs every harness test with it on (as products run).
 */
export const WITH_GC = process.env.LEXICAL_Y_GC === '1';

/**
 * An editor bound to `doc`: `createEditor` and a `YBinding` (started by
 * `start`), or with {@link WITH_BLOCK_IDS} an editor built from
 * YCollabExtension and BlockIdExtension (started when built; `start` returns
 * its disposal).
 */
export function createBoundEditor(
  doc: YDoc,
  config: {
    namespace: string;
    nodes: readonly Klass<LexicalNode>[];
    onError: (e: Error) => void;
    onWarn: (e: Error) => void;
    selfCheck: boolean;
    withBlockIds?: boolean;
    /** The binding's schemaVersion (default 1). */
    schemaVersion?: number;
  },
): {editor: LexicalEditor; binding: YBinding; start: () => () => void} {
  if (!(config.withBlockIds ?? WITH_BLOCK_IDS)) {
    const editor = createEditor({
      namespace: config.namespace,
      nodes: [...config.nodes],
      onError: config.onError,
      onWarn: config.onWarn,
    });
    const binding = new YBinding(editor, doc, {
      schemaVersion: config.schemaVersion ?? 1,
      selfCheck: config.selfCheck,
    });
    return {binding, editor, start: () => binding.start()};
  }
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: config.schemaVersion ?? 1,
          selfCheck: config.selfCheck,
        }),
        BlockIdExtension,
      ],
      name: '@lexical/y/test/' + config.namespace,
      namespace: config.namespace,
      nodes: () => [...config.nodes],
      onError: config.onError,
      onWarn: config.onWarn,
    }),
  );
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  return {binding, editor, start: () => () => editor.dispose()};
}
