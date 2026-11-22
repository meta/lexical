/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  createBinding,
  createBindingV2__EXPERIMENTAL,
  type Provider,
  syncLexicalUpdateToYjs,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexical,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setCompositionKey,
  createEditor,
  type ElementNode,
  type LexicalEditor,
  type NodeKey,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';
import * as Y from 'yjs';

// The v1 and v2 bindings tag every remote change COLLABORATION_TAG. A remote
// change next to a text node being composed (IME) must normalize exactly as
// it always has: text with the same format merges into the composed node in
// the same update (only @lexical/y opts out, with DEFER_COMPOSITION_MERGE_TAG).
// The traces below were recorded on the main branch before @lexical/y
// existed; any difference is a behaviour change for existing collaboration
// users. A hold keyed on COLLABORATION_TAG fails the one-way v1 cases.

const RELAY = {relay: true};

type Peer = {
  doc: Y.Doc;
  editor: LexicalEditor;
  pending: Uint8Array[];
};

const provider = {
  awareness: {
    getLocalState: () => null,
    getStates: () => new Map(),
    off() {},
    on() {},
    setLocalState() {},
    setLocalStateField() {},
  },
  connect() {},
  disconnect() {},
  off() {},
  on() {},
} as unknown as Provider;

function createPeer(version: 1 | 2, clientID: number): Peer {
  const doc = new Y.Doc({gc: false});
  doc.clientID = clientID;
  const editor = createEditor({
    namespace: 'peer' + clientID,
    onError: e => {
      throw e;
    },
  });
  const docMap = new Map([['main', doc]]);
  if (version === 1) {
    const binding = createBinding(editor, provider, 'main', doc, docMap);
    binding.root.getSharedType().observeDeep((events, transaction) => {
      if (transaction.origin !== binding) {
        syncYjsChangesToLexical(binding, provider, events, false);
      }
    });
    editor.registerUpdateListener(p =>
      syncLexicalUpdateToYjs(
        binding,
        provider,
        p.prevEditorState,
        p.editorState,
        p.dirtyElements,
        p.dirtyLeaves,
        p.normalizedNodes,
        p.tags,
      ),
    );
  } else {
    const binding = createBindingV2__EXPERIMENTAL(editor, 'main', doc, docMap);
    binding.root.observeDeep((events, transaction) => {
      if (transaction.origin !== binding) {
        syncYjsChangesToLexicalV2__EXPERIMENTAL(
          binding,
          provider,
          events,
          transaction,
          false,
        );
      }
    });
    editor.registerUpdateListener(p =>
      syncLexicalUpdateToYjsV2__EXPERIMENTAL(
        binding,
        provider,
        p.prevEditorState,
        p.editorState,
        p.dirtyElements,
        p.dirtyLeaves,
        p.normalizedNodes,
        p.tags,
      ),
    );
  }
  return {doc, editor, pending: []};
}

/** Relays updates between the peers; `live` decides delivery at once. */
function connect(peers: Peer[], live: () => boolean): void {
  for (const peer of peers) {
    peer.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === RELAY) {
        return;
      }
      for (const other of peers) {
        if (other !== peer) {
          other.pending.push(update);
          if (live()) {
            deliver(other);
          }
        }
      }
    });
  }
}

function deliver(peer: Peer): void {
  const updates = peer.pending;
  peer.pending = [];
  if (updates.length > 0) {
    Y.applyUpdate(peer.doc, Y.mergeUpdates(updates), RELAY);
    peer.editor.read(() => {});
  }
}

const update = (peer: Peer, fn: () => void) =>
  peer.editor.update(fn, {discrete: true});

/** Lines as text runs; `*` marks the node holding the composition key. */
function dump(peer: Peer, composedKey: NodeKey): string {
  return peer.editor.read(() =>
    $getRoot()
      .getChildren()
      .map(line =>
        $isElementNode(line)
          ? line
              .getChildren()
              .map(
                n =>
                  ($isTextNode(n) && n.hasFormat('bold') ? '**' : '') +
                  n.getTextContent() +
                  (n.getKey() === composedKey ? '*' : ''),
              )
              .join('|')
          : '',
      )
      .join(' / '),
  );
}

type Scenario = {
  name: string;
  /** The shared start: paragraphs of [text, bold?] runs. */
  start: [string, boolean][][];
  /** Index of the run (in the first paragraph) A composes in. */
  composed: number;
  /** B's change. */
  $change: () => void;
  /** Whether B's change reaches A while A composes (else after it ends). */
  live: boolean;
};

const $line = (i: number) => $getRoot().getChildAtIndex(i) as ElementNode;

const SCENARIOS: Scenario[] = [
  {
    $change: () =>
      ($line(0).getFirstChild() as TextNode).insertBefore(
        $createTextNode('b1'),
      ),
    composed: 0,
    live: true,
    name: 'B inserts plain text before the composed node',
    start: [[['k', false]]],
  },
  {
    $change: () =>
      ($line(0).getLastChild() as TextNode).insertAfter($createTextNode('b2')),
    composed: 0,
    live: true,
    name: 'B inserts plain text after the composed node',
    start: [[['k', false]]],
  },
  {
    $change: () => ($line(0).getChildAtIndex(1) as TextNode).remove(),
    composed: 2,
    live: true,
    name: 'B removes the bold node before the composed node',
    start: [
      [
        ['ab', false],
        ['X', true],
        ['k', false],
      ],
    ],
  },
  {
    $change: () => ($line(0).getChildAtIndex(1) as TextNode).setFormat(0),
    composed: 2,
    live: true,
    name: 'B unbolds the node before the composed node',
    start: [
      [
        ['ab', false],
        ['X', true],
        ['k', false],
      ],
    ],
  },
  {
    $change: () => {
      const next = $line(1);
      $line(0).append(...next.getChildren());
      next.remove();
    },
    composed: 0,
    live: true,
    name: 'B joins the next line into the composing line',
    start: [[['k', false]], [['n1', false]]],
  },
  {
    $change: () => ($line(0).getChildAtIndex(1) as TextNode).remove(),
    composed: 2,
    live: false,
    name: 'B removes the bold node offline; delivered after a composition step',
    start: [
      [
        ['ab', false],
        ['X', true],
        ['k', false],
      ],
    ],
  },
];

function run(
  version: 1 | 2,
  ids: [number, number],
  scenario: Scenario,
): string[] {
  let live = true;
  const a = createPeer(version, ids[0]);
  const b = createPeer(version, ids[1]);
  connect([a, b], () => live);
  update(a, () => {
    $getRoot()
      .clear()
      .append(
        ...scenario.start.map(runs =>
          $createParagraphNode().append(
            ...runs.map(([text, bold]) => {
              const node = $createTextNode(text);
              return bold ? node.toggleFormat('bold') : node;
            }),
          ),
        ),
      );
  });
  let composedKey: NodeKey = '';
  const trace: string[] = [];
  const record = (label: string) =>
    trace.push(`${label}: A=${dump(a, composedKey)} B=${dump(b, composedKey)}`);
  update(a, () => {
    const node = $line(0).getChildAtIndex(scenario.composed) as TextNode;
    composedKey = node.getKey();
    node.select(1, 1);
    $setCompositionKey(composedKey);
  });
  // The composition's own updates are not sent while it is active (the
  // composing peer's binding still sees them).
  live = scenario.live;
  update(b, scenario.$change);
  record('change');
  const step = () =>
    update(a, () => {
      const node = $getNodeByKey(composedKey);
      if ($isTextNode(node) && node.isAttached()) {
        node.setTextContent(node.getTextContent().replace('k', 'kか'));
        node.select(2, 2);
      }
    });
  step();
  record('step');
  if (!scenario.live) {
    deliver(a);
    record('delivered');
    step();
    record('step 2');
  }
  update(a, () => $setCompositionKey(null));
  record('end');
  live = true;
  deliver(a);
  deliver(b);
  record('synced');
  return trace;
}

/**
 * A starts composing in a node it creates while offline (after a bold run), B
 * concurrently removes the bold run, so the composed node becomes adjacent to
 * plain text on A only when B's change arrives. `twoWay`: both peers sync
 * while A composes; otherwise only B's change reaches A until it ends.
 */
function runConcurrent(
  version: 1 | 2,
  ids: [number, number],
  twoWay: boolean,
): string[] {
  let live = true;
  const a = createPeer(version, ids[0]);
  const b = createPeer(version, ids[1]);
  connect([a, b], () => live);
  update(a, () => {
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append(
          $createTextNode('ab'),
          $createTextNode('X').toggleFormat('bold'),
        ),
      );
  });
  live = false;
  let composedKey: NodeKey = '';
  const trace: string[] = [];
  const record = (label: string) =>
    trace.push(`${label}: A=${dump(a, composedKey)} B=${dump(b, composedKey)}`);
  update(a, () => {
    const node = $createTextNode('k');
    $line(0).append(node);
    composedKey = node.getKey();
    node.select(1, 1);
    $setCompositionKey(composedKey);
  });
  update(b, () => ($line(0).getChildAtIndex(1) as TextNode).remove());
  record('offline');
  deliver(a);
  if (twoWay) {
    deliver(b);
    deliver(a);
  }
  record('delivered');
  update(a, () => {
    const node = $getNodeByKey(composedKey);
    if ($isTextNode(node) && node.isAttached()) {
      node.setTextContent(node.getTextContent().replace('k', 'kか'));
      node.select(2, 2);
    }
  });
  record('step');
  update(a, () => $setCompositionKey(null));
  record('end');
  live = true;
  deliver(b);
  deliver(a);
  record('synced');
  return trace;
}

const RECORDED_ON_MAIN: Record<string, string[]> = {
  'v1, client ids 1,2: B inserts plain text after the composed node': [
    'change: A=kb2* B=kb2',
    'step: A=kかb2* B=kかb2',
    'end: A=kかb2* B=kかb2',
    'synced: A=kかb2* B=kかb2',
  ],
  'v1, client ids 1,2: B inserts plain text before the composed node': [
    'change: A=b1k B=b1k',
    'step: A=b1k B=b1k',
    'end: A=b1k B=b1k',
    'synced: A=b1k B=b1k',
  ],
  'v1, client ids 1,2: B joins the next line into the composing line': [
    'change: A=kn1* B=kn1',
    'step: A=kかn1* B=kかn1',
    'end: A=kかn1* B=kかn1',
    'synced: A=kかn1* B=kかn1',
  ],
  'v1, client ids 1,2: B removes a bold run next to a node A composes, concurrently (one-way delivery)':
    [
      'offline: A=ab|**X|k* B=ab',
      'delivered: A=abk B=ab',
      'step: A=abk B=ab',
      'end: A=abk B=ab',
      'synced: A=abk B=abk',
    ],
  'v1, client ids 1,2: B removes a bold run next to a node A composes, concurrently (two-way delivery)':
    [
      'offline: A=ab|**X|k* B=ab',
      'delivered: A=abk B=abk',
      'step: A=abk B=abk',
      'end: A=abk B=abk',
      'synced: A=abk B=abk',
    ],
  'v1, client ids 1,2: B removes the bold node before the composed node': [
    'change: A=abk B=abk',
    'step: A=abk B=abk',
    'end: A=abk B=abk',
    'synced: A=abk B=abk',
  ],
  'v1, client ids 1,2: B removes the bold node offline; delivered after a composition step':
    [
      'change: A=ab|**X|k* B=abk',
      'step: A=ab|**X|kか* B=abk',
      'delivered: A=abkか B=abk',
      'step 2: A=abkか B=abk',
      'end: A=abkか B=abk',
      'synced: A=abkか B=abkか',
    ],
  'v1, client ids 1,2: B unbolds the node before the composed node': [
    'change: A=abXk B=abXk',
    'step: A=abXk B=abXk',
    'end: A=abXk B=abXk',
    'synced: A=abXk B=abXk',
  ],
  'v1, client ids 2,1: B inserts plain text after the composed node': [
    'change: A=kb2* B=kb2',
    'step: A=kかb2* B=kかb2',
    'end: A=kかb2* B=kかb2',
    'synced: A=kかb2* B=kかb2',
  ],
  'v1, client ids 2,1: B inserts plain text before the composed node': [
    'change: A=b1k B=b1k',
    'step: A=b1k B=b1k',
    'end: A=b1k B=b1k',
    'synced: A=b1k B=b1k',
  ],
  'v1, client ids 2,1: B joins the next line into the composing line': [
    'change: A=kn1* B=kn1',
    'step: A=kかn1* B=kかn1',
    'end: A=kかn1* B=kかn1',
    'synced: A=kかn1* B=kかn1',
  ],
  'v1, client ids 2,1: B removes a bold run next to a node A composes, concurrently (one-way delivery)':
    [
      'offline: A=ab|**X|k* B=ab',
      'delivered: A=abk B=ab',
      'step: A=abk B=ab',
      'end: A=abk B=ab',
      'synced: A=abk B=abk',
    ],
  'v1, client ids 2,1: B removes a bold run next to a node A composes, concurrently (two-way delivery)':
    [
      'offline: A=ab|**X|k* B=ab',
      'delivered: A=abk B=abk',
      'step: A=abk B=abk',
      'end: A=abk B=abk',
      'synced: A=abk B=abk',
    ],
  'v1, client ids 2,1: B removes the bold node before the composed node': [
    'change: A=abk B=abk',
    'step: A=abk B=abk',
    'end: A=abk B=abk',
    'synced: A=abk B=abk',
  ],
  'v1, client ids 2,1: B removes the bold node offline; delivered after a composition step':
    [
      'change: A=ab|**X|k* B=abk',
      'step: A=ab|**X|kか* B=abk',
      'delivered: A=abkか B=abk',
      'step 2: A=abkか B=abk',
      'end: A=abkか B=abk',
      'synced: A=abkか B=abkか',
    ],
  'v1, client ids 2,1: B unbolds the node before the composed node': [
    'change: A=abXk B=abXk',
    'step: A=abXk B=abXk',
    'end: A=abXk B=abXk',
    'synced: A=abXk B=abXk',
  ],
  'v2, client ids 1,2: B inserts plain text after the composed node': [
    'change: A=kb2* B=kb2',
    'step: A=kかb2* B=kかb2',
    'end: A=kかb2* B=kかb2',
    'synced: A=kかb2* B=kかb2',
  ],
  'v2, client ids 1,2: B inserts plain text before the composed node': [
    'change: A=b1k* B=b1k',
    'step: A=b1kか* B=b1kか',
    'end: A=b1kか* B=b1kか',
    'synced: A=b1kか* B=b1kか',
  ],
  'v2, client ids 1,2: B joins the next line into the composing line': [
    'change: A=kn1* B=kn1',
    'step: A=kかn1* B=kかn1',
    'end: A=kかn1* B=kかn1',
    'synced: A=kかn1* B=kかn1',
  ],
  'v2, client ids 1,2: B removes a bold run next to a node A composes, concurrently (one-way delivery)':
    [
      'offline: A=ab|**X|k* B=ab',
      'delivered: A=abk B=ab',
      'step: A=abk B=ab',
      'end: A=abk B=ab',
      'synced: A=abk B=abk',
    ],
  'v2, client ids 1,2: B removes a bold run next to a node A composes, concurrently (two-way delivery)':
    [
      'offline: A=ab|**X|k* B=ab',
      'delivered: A=abk B=abk',
      'step: A=abk B=abk',
      'end: A=abk B=abk',
      'synced: A=abk B=abk',
    ],
  'v2, client ids 1,2: B removes the bold node before the composed node': [
    'change: A=abk B=abk',
    'step: A=abk B=abk',
    'end: A=abk B=abk',
    'synced: A=abk B=abk',
  ],
  'v2, client ids 1,2: B removes the bold node offline; delivered after a composition step':
    [
      'change: A=ab|**X|k* B=abk',
      'step: A=ab|**X|kか* B=abk',
      'delivered: A=abkか B=abk',
      'step 2: A=abkか B=abk',
      'end: A=abkか B=abk',
      'synced: A=abkか B=abkか',
    ],
  'v2, client ids 1,2: B unbolds the node before the composed node': [
    'change: A=abXk B=abXk',
    'step: A=abXk B=abXk',
    'end: A=abXk B=abXk',
    'synced: A=abXk B=abXk',
  ],
  'v2, client ids 2,1: B inserts plain text after the composed node': [
    'change: A=kb2* B=kb2',
    'step: A=kかb2* B=kかb2',
    'end: A=kかb2* B=kかb2',
    'synced: A=kかb2* B=kかb2',
  ],
  'v2, client ids 2,1: B inserts plain text before the composed node': [
    'change: A=b1k* B=b1k',
    'step: A=b1kか* B=b1kか',
    'end: A=b1kか* B=b1kか',
    'synced: A=b1kか* B=b1kか',
  ],
  'v2, client ids 2,1: B joins the next line into the composing line': [
    'change: A=kn1* B=kn1',
    'step: A=kかn1* B=kかn1',
    'end: A=kかn1* B=kかn1',
    'synced: A=kかn1* B=kかn1',
  ],
  'v2, client ids 2,1: B removes a bold run next to a node A composes, concurrently (one-way delivery)':
    [
      'offline: A=ab|**X|k* B=ab',
      'delivered: A=abk B=ab',
      'step: A=abk B=ab',
      'end: A=abk B=ab',
      'synced: A=abk B=abk',
    ],
  'v2, client ids 2,1: B removes a bold run next to a node A composes, concurrently (two-way delivery)':
    [
      'offline: A=ab|**X|k* B=ab',
      'delivered: A=abk B=abk',
      'step: A=abk B=abk',
      'end: A=abk B=abk',
      'synced: A=abk B=abk',
    ],
  'v2, client ids 2,1: B removes the bold node before the composed node': [
    'change: A=abk B=abk',
    'step: A=abk B=abk',
    'end: A=abk B=abk',
    'synced: A=abk B=abk',
  ],
  'v2, client ids 2,1: B removes the bold node offline; delivered after a composition step':
    [
      'change: A=ab|**X|k* B=abk',
      'step: A=ab|**X|kか* B=abk',
      'delivered: A=abkか B=abk',
      'step 2: A=abkか B=abk',
      'end: A=abkか B=abk',
      'synced: A=abkか B=abkか',
    ],
  'v2, client ids 2,1: B unbolds the node before the composed node': [
    'change: A=abXk B=abXk',
    'step: A=abXk B=abXk',
    'end: A=abXk B=abXk',
    'synced: A=abXk B=abXk',
  ],
};

describe('v1/v2 bindings: a remote change next to an IME composition', () => {
  for (const version of [1, 2] as const) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ] as [number, number][]) {
      for (const twoWay of [false, true]) {
        const name = `v${version}, client ids ${ids.join(',')}: B removes a bold run next to a node A composes, concurrently (${twoWay ? 'two-way' : 'one-way'} delivery)`;
        test(name, () => {
          const trace = runConcurrent(version, ids, twoWay);
          expect(trace).toEqual(RECORDED_ON_MAIN[name]);
        });
      }
      for (const scenario of SCENARIOS) {
        const name = `v${version}, client ids ${ids.join(',')}: ${scenario.name}`;
        test(name, () => {
          const trace = run(version, ids, scenario);
          expect(trace).toEqual(RECORDED_ON_MAIN[name]);
        });
      }
    }
  }
});
