/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A binding keeps its own format items from garbage collection while they
// are undoable (D88). These check that it lets them go: when both undo
// stacks become empty (a clear, or an undo that changes nothing), when it is
// disposed or replaced, and that what a collaborator deleted meanwhile is
// collected then. A client A bolds part of "alpha"; B, with no undo, clears
// the formats; they sync.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  createEditor,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding, type YDoc} from '../../..';
import {NODES} from '../../utils/harness';

function bound(doc: YDoc, captureTimeout: number | null = 0) {
  const editor = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn: () => {},
  });
  const binding = new YBinding(editor, doc, {captureTimeout, schemaVersion: 1});
  const stop = binding.start();
  return {binding, doc, editor, stop};
}

/** Bolds "ph" of "alpha", or (`bold` false) clears every format. */
function format(editor: LexicalEditor, bold: boolean) {
  editor.update(
    () => {
      const nodes = $getRoot().getAllTextNodes();
      if (!bold) {
        for (const n of nodes) {
          n.setFormat(0);
        }
        return;
      }
      const at = (i: number): [TextNode, number] => {
        for (const n of nodes) {
          if (i <= n.getTextContentSize()) {
            return [n, i];
          }
          i -= n.getTextContentSize();
        }
        const last = nodes[nodes.length - 1];
        return [last, last.getTextContentSize()];
      };
      const [a, ao] = at(2);
      const [b, bo] = at(4);
      const s = $createRangeSelection();
      s.anchor.set(a.getKey(), ao, 'text');
      s.focus.set(b.getKey(), bo, 'text');
      $setSelection(s);
      s.formatText('bold');
      $setSelection(null);
    },
    {discrete: true},
  );
}

function clients(gc = true) {
  const a = bound(createYDoc(null, {gc}));
  a.doc.clientID = 1;
  a.editor.update(
    () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('alpha')),
      ),
    {discrete: true},
  );
  a.binding.initialize();
  const b = bound(createYDoc(Y.encodeStateAsUpdate(a.doc), {gc}), null);
  b.doc.clientID = 2;
  const sync = () => {
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
  };
  a.binding.undoManager!.clear();
  const dispose = () => {
    a.stop();
    b.stop();
    a.doc.destroy();
    b.doc.destroy();
  };
  return {a, b, dispose, sync};
}

function formats(doc: Y.Doc): Y.Item[] {
  return [...doc.store.clients.values()]
    .flat()
    .filter(
      (s): s is Y.Item =>
        s instanceof Y.Item && s.content instanceof Y.ContentFormat,
    );
}
const deleted = (doc: Y.Doc) => formats(doc).filter(s => s.deleted);
const kept = (doc: Y.Doc) => deleted(doc).filter(s => s.keep);

test('a deleted own format item stays readable while its change can be undone', () => {
  const {a, b, sync, dispose} = clients();
  try {
    format(a.editor, true);
    sync();
    format(b.editor, false);
    sync();
    expect(kept(a.doc).length).toBeGreaterThan(0);
    // A's state carries it while A can undo, as Yjs's UndoManager does for
    // the items a step deletes; a relay that loads that state collects it.
    const stored = Y.encodeStateAsUpdate(a.doc);
    const relay = createYDoc(stored);
    expect(deleted(relay)).toEqual([]);
    relay.destroy();
  } finally {
    dispose();
  }
});

test('a clear of both stacks releases what a collaborator deleted, which a reload collects', () => {
  const {a, b, sync, dispose} = clients();
  try {
    format(a.editor, true);
    sync();
    format(b.editor, false);
    sync();
    a.binding.undoManager!.clear();
    expect(kept(a.doc)).toEqual([]);
    // Released, not collected (as Yjs leaves the items an UndoManager step
    // kept): A's document holds the deleted content until it reloads, and a
    // relay that loads A's state collects it.
    const relay = createYDoc(Y.encodeStateAsUpdate(a.doc));
    expect(deleted(relay)).toEqual([]);
    relay.destroy();
  } finally {
    dispose();
  }
});

test('repeated cycles with a clear keep no format item kept', () => {
  const {a, b, sync, dispose} = clients();
  try {
    for (let i = 0; i < 200; i++) {
      format(a.editor, true);
      sync();
      format(b.editor, false);
      sync();
      a.binding.undoManager!.clear();
    }
    expect(formats(a.doc).filter(s => s.keep)).toEqual([]);
  } finally {
    dispose();
  }
});

test('an undo that changes nothing and empties both stacks releases them', () => {
  const {a, b, sync, dispose} = clients();
  try {
    for (let i = 0; i < 50; i++) {
      format(a.editor, true);
      sync();
      format(b.editor, false);
      sync();
      // B removed the bold, so A's undo changes nothing and drops its step.
      a.binding.undo();
    }
    expect(a.binding.undoManager!.undoStack.length).toBe(0);
    expect(a.binding.undoManager!.redoStack.length).toBe(0);
    expect(kept(a.doc)).toEqual([]);
  } finally {
    dispose();
  }
});

test('a clear of the redo stack only keeps what the undo stack still needs', () => {
  const {a, b, sync, dispose} = clients();
  try {
    format(a.editor, true);
    sync();
    a.editor.update(
      () => void $getRoot().getAllTextNodes()[0].spliceText(2, 0, 'Z'),
      {discrete: true},
    );
    sync();
    a.binding.undo();
    sync();
    a.binding.undoManager!.clear(false, true);
    format(b.editor, false);
    sync();
    expect(kept(a.doc).length).toBeGreaterThan(0);
  } finally {
    dispose();
  }
});

test('disposing the binding releases what it kept', () => {
  const {a, b, sync, dispose} = clients();
  try {
    format(a.editor, true);
    sync();
    a.stop();
    format(b.editor, false);
    sync();
    // Released before B's delete arrives, so that delete collects them.
    expect(kept(a.doc)).toEqual([]);
    expect(deleted(a.doc)).toEqual([]);
  } finally {
    dispose();
  }
});

test('a new binding on the same document does not inherit the old one keeps', () => {
  const {a, b, sync, dispose} = clients();
  try {
    format(a.editor, true);
    sync();
    a.stop();
    const reopened = bound(a.doc);
    reopened.binding.undoManager!.clear();
    format(b.editor, false);
    sync();
    expect(kept(a.doc)).toEqual([]);
    reopened.stop();
  } finally {
    dispose();
  }
});

test('a reload from a relay shows what the client shows', () => {
  const {a, b, sync, dispose} = clients();
  try {
    format(a.editor, true);
    sync();
    format(b.editor, false);
    sync();
    const relay = createYDoc(Y.encodeStateAsUpdate(a.doc));
    const reload = bound(createYDoc(Y.encodeStateAsUpdate(relay)), null);
    expect(JSON.stringify(reload.editor.getEditorState().toJSON())).toBe(
      JSON.stringify(a.editor.getEditorState().toJSON()),
    );
    reload.stop();
    reload.doc.destroy();
    relay.destroy();
  } finally {
    dispose();
  }
});

for (const gc of [true, false]) {
  for (const how of ['clear', 'dispose'] as const) {
    test(`another binding on the same document can still undo after this one releases (${how}, gc ${gc ? 'on' : 'off'})`, () => {
      const doc = createYDoc(null, {gc});
      doc.clientID = 1;
      const a = bound(doc);
      a.editor.update(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('alpha')),
          ),
        {discrete: true},
      );
      a.binding.initialize();
      a.binding.undoManager!.clear();
      const b = bound(doc);
      const bold = () =>
        b.editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(t => `${t.getTextContent()}:${t.getFormat()}`)
            .join('|'),
        );
      try {
        format(a.editor, true);
        const before = bold();
        // B's step deletes A's format items locally, on the same document.
        format(b.editor, false);
        expect(bold()).not.toBe(before);
        if (how === 'clear') {
          a.binding.undoManager!.clear();
        } else {
          a.stop();
        }
        b.binding.undo();
        expect(bold()).toBe(before);
      } finally {
        b.stop();
        if (how === 'clear') {
          a.stop();
        }
        doc.destroy();
      }
    });
  }
}

for (const how of ['capture filter', 'untracked origin'] as const) {
  test(`writes the undo stacks do not capture keep nothing (${how})`, () => {
    const {a, dispose} = clients();
    try {
      const um = a.binding.undoManager!;
      if (how === 'capture filter') {
        um.captureTransaction = () => false;
      } else {
        um.removeTrackedOrigin(a.binding);
      }
      for (let i = 0; i < 20; i++) {
        format(a.editor, true);
      }
      expect(um.undoStack.length + um.redoStack.length).toBe(0);
      expect(formats(a.doc).filter(s => s.keep)).toEqual([]);
    } finally {
      dispose();
    }
  });
}

for (const gc of [true, false]) {
  test(`an app UndoManager that tracks a provider's updates can still undo after the binding releases (gc ${gc ? 'on' : 'off'})`, () => {
    const {a, b, dispose} = clients(gc);
    const provider = {provider: true};
    const um = new Y.UndoManager(a.doc.get('lexical-y'), {
      captureTimeout: 0,
      trackedOrigins: new Set([provider]),
    });
    const show = () =>
      a.editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(t => `${t.getTextContent()}:${t.getFormat()}`)
          .join('|'),
      );
    try {
      format(a.editor, true);
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      const before = show();
      format(b.editor, false);
      Y.applyUpdate(
        a.doc,
        Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)),
        provider,
      );
      expect(show()).not.toBe(before);
      a.binding.undoManager!.clear();
      um.undo();
      expect(show()).toBe(before);
    } finally {
      um.destroy();
      dispose();
    }
  });
}

for (const gc of [true, false]) {
  test(`a release from inside another UndoManager's capture leaves its step restorable (gc ${gc ? 'on' : 'off'})`, () => {
    const {a, b, dispose} = clients(gc);
    const provider = {provider: true};
    const um = new Y.UndoManager(a.doc.get('lexical-y'), {
      captureTimeout: 0,
      trackedOrigins: new Set([provider]),
    });
    // The app clears the binding's history while the other UndoManager
    // records its step, inside the transaction that deleted the items.
    um.on('stack-item-added', () => a.binding.undoManager!.clear());
    const show = () =>
      a.editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(t => `${t.getTextContent()}:${t.getFormat()}`)
          .join('|'),
      );
    try {
      format(a.editor, true);
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      const before = show();
      format(b.editor, false);
      Y.applyUpdate(
        a.doc,
        Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)),
        provider,
      );
      expect(show()).not.toBe(before);
      um.undo();
      expect(show()).toBe(before);
    } finally {
      um.destroy();
      dispose();
    }
  });
}

const flagged = (doc: Y.Doc) => formats(doc).filter(s => s.keep);

test('disposing the binding while an empty-stacks release waits releases everything', () => {
  const {a, dispose} = clients();
  try {
    format(a.editor, true);
    const um = a.binding.undoManager!;
    a.binding.undo();
    // The next captured edit clears the redo stack (a release that waits
    // for the transaction to end), and its capture disposes the binding.
    um.on('stack-item-added', () => {
      if (um.undoStack.length > 0) {
        a.stop();
      }
    });
    a.editor.update(
      () => {
        for (const n of $getRoot().getAllTextNodes()) {
          n.setFormat('italic');
        }
      },
      {discrete: true},
    );
    expect(a.binding.undoManager).toBe(null);
    expect(flagged(a.doc)).toEqual([]);
  } finally {
    dispose();
  }
});

for (const order of ['dispose, then destroy', 'destroy, then dispose']) {
  test(`destroying the document while a release waits releases everything (${order})`, () => {
    const {a, dispose} = clients();
    try {
      format(a.editor, true);
      const um = a.binding.undoManager!;
      a.doc.transact(() => {
        um.clear();
        if (order === 'dispose, then destroy') {
          a.stop();
          a.doc.destroy();
        } else {
          a.doc.destroy();
          a.stop();
        }
      });
      expect(flagged(a.doc)).toEqual([]);
    } finally {
      dispose();
    }
  });
}

test('a binding disposed during its first capture keeps nothing', () => {
  const {a, dispose} = clients();
  try {
    expect(flagged(a.doc)).toEqual([]);
    a.binding.undoManager!.on('stack-item-added', () => a.stop());
    format(a.editor, true);
    expect(a.binding.undoManager).toBe(null);
    expect(flagged(a.doc)).toEqual([]);
  } finally {
    dispose();
  }
});

for (const gc of [true, false]) {
  test(`a binding started again before its old release ran keeps what its new step needs (gc ${gc ? 'on' : 'off'})`, () => {
    const doc = createYDoc(null, {gc});
    doc.clientID = 1;
    const a = bound(doc);
    a.editor.update(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('alpha')),
        ),
      {discrete: true},
    );
    a.binding.initialize();
    a.binding.undoManager!.clear();
    // A collaborator whose UndoManager captures A's bold as it arrives.
    const other = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
    other.clientID = 3;
    const provider = {provider: true};
    const um = new Y.UndoManager(other.get('lexical-y'), {
      captureTimeout: 0,
      trackedOrigins: new Set([provider]),
    });
    let stop = a.stop;
    try {
      format(a.editor, true);
      Y.applyUpdate(
        other,
        Y.encodeStateAsUpdate(doc, Y.encodeStateVector(other)),
        provider,
      );
      // Inside one transaction: dispose (its release waits), start again,
      // and remove the bold, a step of the new lifetime.
      doc.transact(() => {
        a.stop();
        stop = a.binding.start();
        format(a.editor, false);
      }, a.binding);
      expect(a.binding.undoManager!.undoStack.length).toBe(1);
      um.undo();
      Y.applyUpdate(
        doc,
        Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)),
      );
      a.binding.undo();
      expect(
        a.editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(n => `${n.getTextContent()}:${n.getFormat()}`)
            .join('|'),
        ),
      ).toBe('al:0|ph:1|a:0');
    } finally {
      stop();
      um.destroy();
      doc.destroy();
      other.destroy();
    }
  });
}
