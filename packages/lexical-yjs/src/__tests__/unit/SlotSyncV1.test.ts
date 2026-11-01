/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  type Binding,
  createBinding,
  createUndoManager,
  type Provider,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
} from '@lexical/yjs';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $isDecoratorNode,
  $isElementNode,
  $isTextNode,
  $removeSlot,
  $setSlot,
  defineExtension,
  ElementNode,
  type LexicalEditor,
} from 'lexical';
import {
  $createTestDecoratorNode,
  $createTestShadowRootNode,
  TestDecoratorNode,
  TestShadowRootNode,
} from 'lexical/src/__tests__/utils';
import {afterEach, assert, describe, expect, test, vi} from 'vitest';
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  Map as YMap,
  type Text as YText,
  type Transaction as YTransaction,
  UndoManager,
  XmlText,
  type YEvent,
} from 'yjs';

import {CollabDecoratorNode} from '../../CollabDecoratorNode';
import {CollabElementNode} from '../../CollabElementNode';
import {SLOTS_ATTR_KEY} from '../../Utils';

// V1 (stable, CollabElementNode): serialize a lexical tree with a named slot
// into the V1 yjs representation (the slot lands in a dedicated `__slots`
// attribute Y.Map on the host's `_xmlText`, separate from the linked-list
// children embedded in the same `_xmlText`), restore it into a fresh editor,
// and drive the observer (remote-change) path for a slot add / delete / in-slot
// text edit through the real syncYjsChangesToLexical entry point.
describe('named-slots collab-v1: lexical <-> yjs', () => {
  const editors: LexicalEditorWithDispose[] = [];
  afterEach(() => {
    for (const editor of editors) {
      editor.dispose();
    }
    editors.length = 0;
  });

  function buildBinding() {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-sync-v1]',
        nodes: [TestShadowRootNode, TestDecoratorNode],
      }),
    );
    editors.push(editor);
    const doc = new Doc();
    const docMap = new Map<string, Doc>([['slot-sync-v1', doc]]);
    const binding = createBinding(
      editor,
      null as unknown as Provider,
      'slot-sync-v1',
      doc,
      docMap,
    );
    return {binding, doc, editor};
  }

  // A second editor + binding over a *separate* doc seeded from the source
  // doc's update. V1 caches the local CollabNode on the shared yjs type
  // (`sharedType._collabNode`), so a real second client must own a distinct Doc
  // synced via update messages (as the existing collab tests do) rather than
  // share the in-process Doc, otherwise the restore reuses the serializer's
  // collab nodes and double-applies their children.
  function buildRestoreBinding(doc: Doc) {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-sync-v1]',
        nodes: [TestShadowRootNode],
      }),
    );
    editors.push(editor);
    const docMap = new Map<string, Doc>([['slot-sync-v1', doc]]);
    const binding = createBinding(
      editor,
      null as unknown as Provider,
      'slot-sync-v1',
      doc,
      docMap,
    );
    return {binding, editor};
  }

  function serialize(editor: LexicalEditor, binding: Binding) {
    editor.read(() => {
      binding.doc.transact(() => {
        binding.root.syncChildrenFromLexical(
          binding,
          $getRoot(),
          null,
          null,
          null,
        );
      });
    });
  }

  // Restore the whole shared root into a fresh editor: build the root collab
  // children from the embedded delta, then materialize lexical nodes (and
  // slots) via syncChildrenFromYjs. Mirrors the V1 observer's root YTextEvent
  // handling (applyChildrenYjsDelta + syncChildrenFromYjs).
  function restore(editor: LexicalEditor, binding: Binding) {
    editor.update(
      () => {
        $getRoot().clear();
        binding.root.applyChildrenYjsDelta(
          binding,
          binding.root._xmlText.toDelta(),
        );
        binding.root.syncChildrenFromYjs(binding);
      },
      {discrete: true},
    );
  }

  test('a host with a "title" slot serializes the slot into a `__slots` Y.Map', () => {
    const {binding, editor} = buildBinding();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        host.append(body);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostCollab = binding.root._children[0];
    assert('_xmlText' in hostCollab);
    const hostXmlText = hostCollab._xmlText as XmlText;

    // the slot lives in the dedicated `__slots` attribute channel, not children.
    const slotsY = hostXmlText.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys())).toEqual(['title']);

    // the slot's shared type is the title paragraph's `_xmlText`. In V1 a text
    // child is embedded as a CollabTextNode YMap marker followed by its text,
    // so the raw `toString()` carries the `[object Object]` embed marker before
    // the text itself.
    const titleY = slotsY.get('title');
    assert(titleY instanceof XmlText);
    expect(titleY.toString()).toContain('Title');
  });

  test('a host with no slots sets no `__slots` attribute', () => {
    const {binding, editor} = buildBinding();

    editor.update(
      () => {
        const host = $createParagraphNode();
        host.append($createTextNode('plain'));
        $getRoot().clear().append(host);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostCollab = binding.root._children[0];
    assert('_xmlText' in hostCollab);
    const hostXmlText = hostCollab._xmlText as XmlText;
    expect(hostXmlText.getAttribute(SLOTS_ATTR_KEY)).toBeUndefined();
  });

  // Serialize a host with a 'title' slot + 'Body' child into doc, then restore
  // it into a second client (separate doc2). Returns the restored binding /
  // editor plus the host collab node and its slots Y.Map on doc2.
  function setupRestoredSlotTree() {
    const {binding, doc, editor} = buildBinding();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        host.append(body);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const doc2 = new Doc();
    applyUpdate(doc2, encodeStateAsUpdate(doc));

    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc2);
    restore(editor2, binding2);

    const hostCollab = binding2.root._children[0];
    assert(hostCollab instanceof CollabElementNode);
    const slotsY = hostCollab._xmlText.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);

    return {binding2, doc2, editor2, hostCollab, slotsY};
  }

  test('round-trip: a serialized slot restores into a fresh editor', () => {
    const {editor2} = setupRestoredSlotTree();

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      // the linked-list child survives the round-trip
      expect(hostR.getTextContent()).toContain('Body');

      const titleR = $getSlot(hostR, 'title');
      assert(titleR != null);
      assert($isElementNode(titleR));
      expect(titleR.getTextContent()).toBe('Title');
      // the restored slot is shadow-rooted: no parent in the children tree
      expect(titleR.getParent()).toBe(null);
    });
  });

  // Drive the real V1 observer entry point: observeDeep on the shared root
  // captures the YEvent[] produced by `mutate`, then `syncYjsChangesToLexical`
  // runs them through $syncEvent (the same path useYjsCollaboration registers).
  // The cursor-sync fn is a no-op because this test has no provider/awareness.
  function applyRemoteChange(binding: Binding, mutate: () => void) {
    const sharedRoot = binding.root.getSharedType();
    const handler = (events: YEvent<YText>[]) => {
      syncYjsChangesToLexical(
        binding,
        null as unknown as Provider,
        events,
        false,
        () => undefined,
      );
    };
    sharedRoot.observeDeep(handler);
    try {
      mutate();
    } finally {
      sharedRoot.unobserveDeep(handler);
    }
  }

  // syncYjsChangesToLexical commits its editor.update non-discretely, so the
  // new committed state lands on a microtask. Drain before reading.
  async function flush() {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // observer (c): a remote slot delete arrives as a YMapEvent on the host's
  // slots Y.Map. The new $syncEvent slots branch re-routes it to the host's
  // syncSlotsFromYjs diff, which drops the lexical slot whose name is gone.
  test('observer: a remote slot delete removes the slot from the host', async () => {
    const {binding2, doc2, editor2, slotsY} = setupRestoredSlotTree();

    applyRemoteChange(binding2, () => {
      doc2.transact(() => {
        slotsY.delete('title');
      });
    });
    await flush();

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      expect($getSlotNames(hostR)).toEqual([]);
      expect($getSlot(hostR, 'title')).toBe(null);
      // the linked-list child is untouched by the slot removal
      expect(hostR.getTextContent()).toContain('Body');
    });
  });

  // observer (a): a remote slot add arrives as a YMapEvent on the slots Y.Map;
  // the slots branch re-reconciles the host, keeping 'title' and adding the new
  // slot. V1 has no per-slot serialize path yet to fill a freshly-added slot's
  // text, so this fabricates an empty shadow-root slot type (text-fill of a new
  // slot is out of scope; in-slot text edits are covered by observer (b)).
  test('observer: a remote slot add reconciles into the host', async () => {
    const {binding2, doc2, editor2, slotsY} = setupRestoredSlotTree();

    applyRemoteChange(binding2, () => {
      doc2.transact(() => {
        const sub = new XmlText();
        sub.setAttribute('__type', 'test_shadow_root');
        slotsY.set('subtitle', sub);
      });
    });
    await flush();

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      expect($getSlotNames(hostR).sort()).toEqual(['subtitle', 'title']);
      expect($getSlot(hostR, 'title')?.getTextContent()).toBe('Title');
      const subR = $getSlot(hostR, 'subtitle');
      assert(subR != null);
      assert($isElementNode(subR));
      expect(subR.getParent()).toBe(null);
    });
  });

  // observer (b): a text edit inside a slot arrives as a YTextEvent whose target
  // is the slot's own XmlText (its cached _collabNode is the slot's
  // CollabElementNode), so the existing CollabElementNode + YTextEvent branch
  // re-parses the slot's children in place — no slots-branch involvement.
  test('observer: editing text inside a slot updates the slot in place', async () => {
    const {binding2, doc2, editor2, slotsY} = setupRestoredSlotTree();
    const titleY = slotsY.get('title');
    assert(titleY instanceof XmlText);
    // the slot is a shadow root; its only child is the paragraph that holds the
    // text, embedded as its own XmlText. The text lives one level down, so the
    // edit targets the paragraph's XmlText, not the slot container's.
    const paraY = titleY.toDelta()[0].insert;
    assert(paraY instanceof XmlText);

    applyRemoteChange(binding2, () => {
      doc2.transact(() => {
        // append '!!' after the existing 'Title' text run (offset 0 is the
        // CollabTextNode embed marker, so the text ends at paraY.length).
        paraY.insert(paraY.length, '!!');
      });
    });
    await flush();

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      const titleR = $getSlot(hostR, 'title');
      assert(titleR != null);
      assert($isElementNode(titleR));
      expect(titleR.getTextContent()).toBe('Title!!');
      expect(titleR.getParent()).toBe(null);
    });
  });

  // observer (f): a remote slot REPLACE under the same name. The slots Y.Map
  // keeps 'title' but repoints it at a different shared type. The old add-loop
  // did `if ($getSlot(host, name) !== null) continue`, so a same-name replace
  // was silently dropped on the remote client — the lexical slot kept the stale
  // value and the departing collab dangled in collabNodeMap. The fix compares
  // the existing slot collab's shared type against the incoming one; a mismatch
  // destroys the departing collab and re-slots the new value.
  test('observer: a remote slot replace under the same name swaps the slot', async () => {
    const {binding2, doc2, editor2, slotsY} = setupRestoredSlotTree();

    let oldKey = '';
    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      const title = $getSlot(hostR, 'title');
      assert(title != null);
      oldKey = title.__key;
    });
    expect(binding2.collabNodeMap.has(oldKey)).toBe(true);

    const oldTitleY = slotsY.get('title');
    applyRemoteChange(binding2, () => {
      doc2.transact(() => {
        const next = new XmlText();
        next.setAttribute('__type', 'test_shadow_root');
        slotsY.set('title', next);
      });
    });
    await flush();

    // the Y.Map entry is a different shared type now
    expect(slotsY.get('title')).not.toBe(oldTitleY);

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      // still exactly one slot under 'title', but a fresh node, not the original
      expect($getSlotNames(hostR)).toEqual(['title']);
      const titleR = $getSlot(hostR, 'title');
      assert(titleR != null);
      assert($isElementNode(titleR));
      expect(titleR.__key).not.toBe(oldKey);
      expect(titleR.getParent()).toBe(null);
    });

    // the departing slot's collab node no longer dangles in the map
    expect(binding2.collabNodeMap.has(oldKey)).toBe(false);
  });

  // Build a host with a 'title' slot + 'Body' child in a single editor and run
  // the initial full serialization (creation path seeds the slots Y.Map). The
  // returned hostCollab + its slots Y.Map are the local serializer's own collab
  // tree (not a restore), so subsequent local edits diff against it.
  function setupLocalSlotTree() {
    const {binding, editor} = buildBinding();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        host.append(body);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostCollab = binding.root._children[0];
    assert(hostCollab instanceof CollabElementNode);
    return {binding, editor, hostCollab};
  }

  // Drive the real local (lexical -> yjs) update path: register the same update
  // listener useYjsCollaboration registers, run a discrete edit, then let
  // syncLexicalUpdateToYjs diff the dirty tree into yjs. The provider is unused
  // (no awareness in this test).
  function applyLocalUpdate(
    binding: Binding,
    editor: LexicalEditor,
    mutate: () => void,
  ) {
    // syncLexicalUpdateToYjs ends with a selection sync that reads
    // provider.awareness; a local state of null short-circuits it.
    const provider = {
      awareness: {getLocalState: () => null},
    } as unknown as Provider;
    const removeListener = editor.registerUpdateListener(
      ({
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      }) => {
        syncLexicalUpdateToYjs(
          binding,
          provider,
          prevEditorState,
          editorState,
          dirtyElements,
          dirtyLeaves,
          normalizedNodes,
          tags,
        );
      },
    );
    try {
      editor.update(mutate, {discrete: true});
    } finally {
      removeListener();
    }
  }

  // local (a): a slot added to an already-serialized host. The host child is
  // matched (same key) in the children diff, so _syncChildFromLexical recurses
  // into syncSlotsFromLexical, which creates the new slot's shared type and
  // sets it on the host's slots Y.Map.
  test('local: a slot added to an existing host serializes into the slots Y.Map', () => {
    const {binding, editor, hostCollab} = setupLocalSlotTree();

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const subtitle = $createTestShadowRootNode();
      subtitle.append($createParagraphNode().append($createTextNode('Sub')));
      $setSlot(host, 'subtitle', subtitle);
    });

    const slotsY = hostCollab._xmlText.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys()).sort()).toEqual(['subtitle', 'title']);
    const subY = slotsY.get('subtitle');
    assert(subY instanceof XmlText);
    expect(subY.toString()).toContain('Sub');
  });

  // local (b): a text edit inside a slot. The slot node key is unchanged, so
  // syncSlotsFromLexical recurses content-sync in place — the slot's existing
  // XmlText object is reused (identity preserved) and its text is updated, not
  // recreated.
  test('local: editing text inside a slot updates the slot shared type in place', () => {
    const {binding, editor, hostCollab} = setupLocalSlotTree();
    const slotsY = hostCollab._xmlText.getAttribute(
      SLOTS_ATTR_KEY,
    ) as YMap<unknown>;
    const titleYBefore = slotsY.get('title');

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const title = $getSlot(host, 'title');
      assert($isElementNode(title));
      const para = title.getFirstChild();
      assert($isElementNode(para));
      const text = para.getFirstChild();
      assert($isTextNode(text));
      text.setTextContent('Title!!');
    });

    const titleYAfter = slotsY.get('title');
    // same shared type object: edited in place, not recreated
    expect(titleYAfter).toBe(titleYBefore);
    assert(titleYAfter instanceof XmlText);
    expect(titleYAfter.toString()).toContain('Title!!');
  });

  // local (c): a slot removed from the host. syncSlotsFromLexical's delete loop
  // drops the name gone from lexical out of the slots Y.Map.
  test('local: removing a slot deletes it from the slots Y.Map', () => {
    const {binding, editor, hostCollab} = setupLocalSlotTree();

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      $removeSlot(host, 'title');
    });

    const slotsY = hostCollab._xmlText.getAttribute(SLOTS_ATTR_KEY) as unknown;
    if (slotsY instanceof YMap) {
      expect(Array.from(slotsY.keys())).toEqual([]);
    }
  });

  // local (e): removing a slot must also destroy its collab node, mirroring the
  // children-removal path (splice -> destroy). Otherwise the slot's
  // CollabElementNode dangles in binding.collabNodeMap after the slot is gone.
  test('local: removing a slot clears its collab node from the map', () => {
    const {binding, editor, hostCollab} = setupLocalSlotTree();

    let slotKey = '';
    editor.read(() => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const title = $getSlot(host, 'title');
      assert(title != null);
      slotKey = title.__key;
    });
    expect(binding.collabNodeMap.has(slotKey)).toBe(true);

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      $removeSlot(host, 'title');
    });

    const slotsY = hostCollab._xmlText.getAttribute(SLOTS_ATTR_KEY) as unknown;
    if (slotsY instanceof YMap) {
      expect(Array.from(slotsY.keys())).toEqual([]);
    }
    expect(binding.collabNodeMap.has(slotKey)).toBe(false);
  });

  // local (f): replacing a slot with a new value under the same name keeps the
  // name in lexical, so the removal loop never runs. The create branch must
  // still destroy the departing value's collab node before overwriting its
  // Y.Map entry, or the old node dangles in binding.collabNodeMap.
  test('local: replacing a slot under the same name clears the old collab node', () => {
    const {binding, editor, hostCollab} = setupLocalSlotTree();

    let oldKey = '';
    editor.read(() => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const title = $getSlot(host, 'title');
      assert(title != null);
      oldKey = title.__key;
    });
    expect(binding.collabNodeMap.has(oldKey)).toBe(true);

    let newKey = '';
    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const next = $createTestShadowRootNode();
      next.append($createParagraphNode().append($createTextNode('NewTitle')));
      $setSlot(host, 'title', next);
      newKey = next.__key;
    });

    expect(binding.collabNodeMap.has(oldKey)).toBe(false);
    expect(binding.collabNodeMap.has(newKey)).toBe(true);
    const slotsY = hostCollab._xmlText.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys())).toEqual(['title']);
    const titleY = slotsY.get('title');
    assert(titleY instanceof XmlText);
    expect(titleY.toString()).toContain('NewTitle');
  });

  // local (g): removing the whole host must also destroy its slot collab node.
  // The host leaves via the children splice -> destroy path, not
  // syncSlotsFromLexical, so destroy() itself has to reach the slot — otherwise
  // the slot's CollabElementNode dangles in binding.collabNodeMap after the host
  // is gone.
  test('local: removing the host clears its slot collab node from the map', () => {
    const {binding, editor} = setupLocalSlotTree();

    let slotKey = '';
    let hostKey = '';
    editor.read(() => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      hostKey = host.__key;
      const title = $getSlot(host, 'title');
      assert(title != null);
      slotKey = title.__key;
    });
    expect(binding.collabNodeMap.has(slotKey)).toBe(true);
    expect(binding.collabNodeMap.has(hostKey)).toBe(true);

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      host.remove();
    });

    expect(binding.collabNodeMap.has(hostKey)).toBe(false);
    expect(binding.collabNodeMap.has(slotKey)).toBe(false);
  });

  // observer (d): a remote slot delete must likewise destroy the slot's collab
  // node so it doesn't dangle in binding.collabNodeMap on the remote client.
  test('observer: a remote slot delete clears its collab node from the map', async () => {
    const {binding2, doc2, editor2, slotsY} = setupRestoredSlotTree();

    let slotKey = '';
    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      const title = $getSlot(hostR, 'title');
      assert(title != null);
      slotKey = title.__key;
    });
    expect(binding2.collabNodeMap.has(slotKey)).toBe(true);

    applyRemoteChange(binding2, () => {
      doc2.transact(() => {
        slotsY.delete('title');
      });
    });
    await flush();

    expect(binding2.collabNodeMap.has(slotKey)).toBe(false);
  });

  // local (d): the diff (not whole-recreate) evidence. An unrelated child edit
  // re-syncs the host, but the untouched 'title' slot keeps the same XmlText
  // object identity — syncSlotsFromLexical recursed it in place rather than
  // recreating and re-setting it.
  test('local: an unrelated host edit leaves an untouched slot identical', () => {
    const {binding, editor, hostCollab} = setupLocalSlotTree();
    const slotsY = hostCollab._xmlText.getAttribute(
      SLOTS_ATTR_KEY,
    ) as YMap<unknown>;
    const titleYBefore = slotsY.get('title');

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const body = host.getFirstChild();
      assert($isElementNode(body));
      const text = body.getFirstChild();
      assert($isTextNode(text));
      text.setTextContent('Body changed');
    });

    const titleYAfter = slotsY.get('title');
    expect(titleYAfter).toBe(titleYBefore);
    assert(titleYAfter instanceof XmlText);
    expect(titleYAfter.toString()).toContain('Title');
  });

  // local (b): a decorator-valued slot. A non-inline DecoratorNode is a valid
  // slot value; when it carries a nested slot of its own its `_xmlElem` is
  // tracked, so an unrelated host edit must leave that shared type identical
  // (diffed in place, not recreated with a new yjs id). Mirrors the element/text
  // slot case above for the decorator-value path.
  test('local: an unrelated host edit leaves an untouched decorator slot identical', () => {
    const {binding, editor} = buildBinding();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        const cover = $createTestDecoratorNode().setIsInline(false);
        const caption = $createTestShadowRootNode();
        caption.append($createParagraphNode().append($createTextNode('Cap')));
        $setSlot(cover, 'caption', caption);
        $getRoot().clear().append(host);
        host.append(body);
        $setSlot(host, 'cover', cover);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostCollab = binding.root._children[0];
    assert(hostCollab instanceof CollabElementNode);
    const slotsY = hostCollab._xmlText.getAttribute(
      SLOTS_ATTR_KEY,
    ) as YMap<unknown>;
    const coverYBefore = slotsY.get('cover');
    assert(coverYBefore != null);

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const body = host.getFirstChild();
      assert($isElementNode(body));
      const text = body.getFirstChild();
      assert($isTextNode(text));
      text.setTextContent('Body changed');
    });

    const coverYAfter = slotsY.get('cover');
    expect(coverYAfter).toBe(coverYBefore);
  });

  // observer (g): slot names and values are peer-controlled, so entries that
  // would trip $setSlot / shared-type invariants (reserved name, primitive
  // value, missing `__type`, a value that can only materialize a text node,
  // the same shared type aliased under two names) must be skipped as silent
  // no-ops instead of crashing the observer update — while a valid entry in
  // the same transaction still lands.
  test('observer: hostile remote slot entries are skipped without corrupting valid slots', async () => {
    const {binding2, doc2, editor2, slotsY} = setupRestoredSlotTree();

    // yjs logs (and swallows) the re-integration error for the aliased shared
    // type; keep the test output clean.
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const textVal = new YMap();
    try {
      applyRemoteChange(binding2, () => {
        doc2.transact(() => {
          // reserved name carrying an otherwise valid value
          const reserved = new XmlText();
          reserved.setAttribute('__type', 'test_shadow_root');
          slotsY.set('__proto__', reserved);
          // primitive value
          slotsY.set('answer', 42);
          // shared type missing the `__type` attribute
          slotsY.set('untyped', new XmlText());
          // a Y.Map value can only materialize a text node, never a slot value
          textVal.set('__type', 'text');
          slotsY.set('textval', textVal);
          // the same shared type aliased under a second name
          slotsY.set('alias', slotsY.get('title'));
          // a valid entry alongside the hostile ones still lands
          const extra = new XmlText();
          extra.setAttribute('__type', 'test_shadow_root');
          slotsY.set('extra', extra);
        });
      });
      await flush();
    } finally {
      errorSpy.mockRestore();
    }

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      // first name wins for the alias; every other hostile entry is dropped
      expect($getSlotNames(hostR).sort()).toEqual(['extra', 'title']);
      expect($getSlot(hostR, 'title')?.getTextContent()).toBe('Title');
      // the linked-list child is untouched
      expect(hostR.getTextContent()).toContain('Body');
    });
    // the rejected text value's collab node does not linger in the map
    for (const collab of binding2.collabNodeMap.values()) {
      expect(collab.getSharedType()).not.toBe(textVal);
    }
  });

  // local (h): the root is an element host too, so $setSlot($getRoot(), ...)
  // must flow through the root branch of syncLexicalUpdateToYjs (which has no
  // matched-child recursion to reach syncSlotsFromLexical for it) and restore
  // on a peer through the ordinary root children/slots reconcile.
  test('local: a slot set on the root syncs to yjs and restores on a peer', () => {
    const {binding, doc, editor} = buildBinding();

    editor.update(
      () => {
        const para = $createParagraphNode();
        para.append($createTextNode('Body'));
        $getRoot().clear().append(para);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    applyLocalUpdate(binding, editor, () => {
      const banner = $createTestShadowRootNode();
      banner.append($createParagraphNode().append($createTextNode('Banner')));
      $setSlot($getRoot(), 'banner', banner);
    });

    // the slot lands on the shared root's own `__slots` attribute channel
    const slotsY = binding.root._xmlText.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys())).toEqual(['banner']);

    const doc2 = new Doc();
    applyUpdate(doc2, encodeStateAsUpdate(doc));
    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc2);
    restore(editor2, binding2);

    editor2.read(() => {
      const bannerR = $getSlot($getRoot(), 'banner');
      assert(bannerR != null);
      assert($isElementNode(bannerR));
      expect(bannerR.getTextContent()).toBe('Banner');
      expect(bannerR.getParent()).toBe(null);
    });
  });

  // observer (h): a remote host deletion transitively deletes the slots Y.Map
  // and the slot value's shared type, so the destroy path can no longer read
  // the `__slots` attribute to find the slot's collab node — the
  // transaction-level deleted-structs sweep must drop it from
  // binding.collabNodeMap instead of leaking it forever.
  test('observer: a remote host deletion clears the slot value from the collab node map', async () => {
    const {binding2, doc2, editor2} = setupRestoredSlotTree();

    let hostKey = '';
    let slotKey = '';
    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      hostKey = hostR.__key;
      const title = $getSlot(hostR, 'title');
      assert(title != null);
      slotKey = title.__key;
    });
    expect(binding2.collabNodeMap.has(hostKey)).toBe(true);
    expect(binding2.collabNodeMap.has(slotKey)).toBe(true);

    applyRemoteChange(binding2, () => {
      doc2.transact(() => {
        // delete the host's embed from the shared root
        binding2.root._xmlText.delete(0, 1);
      });
    });
    await flush();

    expect(binding2.collabNodeMap.has(hostKey)).toBe(false);
    expect(binding2.collabNodeMap.has(slotKey)).toBe(false);
  });

  // $setSlot move semantics over V1 collab: a value moved between hosts runs
  // the slot diff's remove-and-destroy on the losing host and the add on the
  // gaining host in the same incremental sync. Driven through the real local
  // update path (syncLexicalUpdateToYjs), then relayed: a peer must converge —
  // value under the new host, gone from the old, not duplicated.
  test('moving a slot value between hosts converges on a peer', () => {
    const {binding, doc, editor} = buildBinding();

    editor.update(
      () => {
        const root = $getRoot().clear();
        const hostA = $createParagraphNode().append($createTextNode('A'));
        const hostB = $createParagraphNode().append($createTextNode('B'));
        root.append(hostA).append(hostB);
        const title = $createTestShadowRootNode();
        title.append(
          $createParagraphNode().append($createTextNode('MovedTitle')),
        );
        $setSlot(hostA, 'title', title);
      },
      {discrete: true},
    );
    serialize(editor, binding); // establish the initial collab tree + doc

    applyLocalUpdate(binding, editor, () => {
      const hostA = $getRoot().getFirstChild();
      const hostB = $getRoot().getLastChild();
      assert($isElementNode(hostA) && $isElementNode(hostB));
      const title = $getSlot(hostA, 'title');
      assert(title != null);
      $setSlot(hostB, 'title', title); // real incremental move A -> B
    });

    // the post-move local doc is well-formed: A's slots Y.Map drops 'title',
    // B's holds it exactly once
    const hostACollab = binding.root._children[0];
    const hostBCollab = binding.root._children[1];
    assert(hostACollab instanceof CollabElementNode);
    assert(hostBCollab instanceof CollabElementNode);
    const slotsAY = hostACollab._xmlText.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown;
    if (slotsAY instanceof YMap) {
      expect(Array.from(slotsAY.keys())).toEqual([]);
    }
    const slotsBY = hostBCollab._xmlText.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown;
    assert(slotsBY instanceof YMap);
    expect(Array.from(slotsBY.keys())).toEqual(['title']);

    const doc2 = new Doc();
    applyUpdate(doc2, encodeStateAsUpdate(doc));
    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc2);
    restore(editor2, binding2);

    editor2.read(() => {
      const hostA = $getRoot().getFirstChild();
      const hostB = $getRoot().getLastChild();
      assert($isElementNode(hostA) && $isElementNode(hostB));
      expect($getSlotNames(hostA)).toEqual([]);
      const titleR = $getSlot(hostB, 'title');
      assert(titleR != null && $isElementNode(titleR));
      expect(titleR.getTextContent()).toBe('MovedTitle');
      expect(titleR.getParent()).toBe(null);
    });
  });
});

// V1 with a DECORATOR host. A non-inline decorator can host named slots even
// though it has no linked-list children channel: its CollabDecoratorNode stores
// the slots Y.Map on its `_xmlElem` (XmlElement) rather than an element host's
// `_xmlText`. These mirror the element-host cases above through the same real
// entry points (serialize, restore, observer, local update), exercising the
// decorator-specific create-seed / restore / re-route / destroy paths.
describe('named-slots collab-v1: decorator host <-> yjs', () => {
  const editors: LexicalEditorWithDispose[] = [];
  afterEach(() => {
    for (const editor of editors) {
      editor.dispose();
    }
    editors.length = 0;
  });

  function buildBinding() {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-sync-v1]',
        nodes: [TestShadowRootNode, TestDecoratorNode],
      }),
    );
    editors.push(editor);
    const doc = new Doc();
    const docMap = new Map<string, Doc>([['slot-sync-v1', doc]]);
    const binding = createBinding(
      editor,
      null as unknown as Provider,
      'slot-sync-v1',
      doc,
      docMap,
    );
    return {binding, doc, editor};
  }

  function buildRestoreBinding(doc: Doc) {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-sync-v1]',
        nodes: [TestShadowRootNode, TestDecoratorNode],
      }),
    );
    editors.push(editor);
    const docMap = new Map<string, Doc>([['slot-sync-v1', doc]]);
    const binding = createBinding(
      editor,
      null as unknown as Provider,
      'slot-sync-v1',
      doc,
      docMap,
    );
    return {binding, editor};
  }

  function serialize(editor: LexicalEditor, binding: Binding) {
    editor.read(() => {
      binding.doc.transact(() => {
        binding.root.syncChildrenFromLexical(
          binding,
          $getRoot(),
          null,
          null,
          null,
        );
      });
    });
  }

  function restore(editor: LexicalEditor, binding: Binding) {
    editor.update(
      () => {
        $getRoot().clear();
        binding.root.applyChildrenYjsDelta(
          binding,
          binding.root._xmlText.toDelta(),
        );
        binding.root.syncChildrenFromYjs(binding);
      },
      {discrete: true},
    );
  }

  function applyRemoteChange(binding: Binding, mutate: () => void) {
    const sharedRoot = binding.root.getSharedType();
    const handler = (events: YEvent<YText>[]) => {
      syncYjsChangesToLexical(
        binding,
        null as unknown as Provider,
        events,
        false,
        () => undefined,
      );
    };
    sharedRoot.observeDeep(handler);
    try {
      mutate();
    } finally {
      sharedRoot.unobserveDeep(handler);
    }
  }

  async function flush() {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  function applyLocalUpdate(
    binding: Binding,
    editor: LexicalEditor,
    mutate: () => void,
  ) {
    const provider = {
      awareness: {getLocalState: () => null},
    } as unknown as Provider;
    const removeListener = editor.registerUpdateListener(
      ({
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      }) => {
        syncLexicalUpdateToYjs(
          binding,
          provider,
          prevEditorState,
          editorState,
          dirtyElements,
          dirtyLeaves,
          normalizedNodes,
          tags,
        );
      },
    );
    try {
      editor.update(mutate, {discrete: true});
    } finally {
      removeListener();
    }
  }

  test('a decorator host with a "title" slot seeds the slots Y.Map on `_xmlElem`', () => {
    const {binding, editor} = buildBinding();

    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostCollab = binding.root._children[0];
    assert(hostCollab instanceof CollabDecoratorNode);
    // a decorator host stores its slots on `_xmlElem`, not a `_xmlText` channel.
    const slotsY = hostCollab._xmlElem.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys())).toEqual(['title']);

    const titleY = slotsY.get('title');
    assert(titleY instanceof XmlText);
    expect(titleY.toString()).toContain('Title');
  });

  test('a decorator host with no slots sets no `__slots` attribute', () => {
    const {binding, editor} = buildBinding();

    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        $getRoot().clear().append(host);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostCollab = binding.root._children[0];
    assert(hostCollab instanceof CollabDecoratorNode);
    expect(hostCollab._xmlElem.getAttribute(SLOTS_ATTR_KEY)).toBeUndefined();
  });

  function setupRestoredSlotTree() {
    const {binding, doc, editor} = buildBinding();

    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const doc2 = new Doc();
    applyUpdate(doc2, encodeStateAsUpdate(doc));

    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc2);
    restore(editor2, binding2);

    const hostCollab = binding2.root._children[0];
    assert(hostCollab instanceof CollabDecoratorNode);
    const slotsY = hostCollab._xmlElem.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);

    return {binding2, doc2, editor2, hostCollab, slotsY};
  }

  test('round-trip: a serialized decorator-host slot restores into a fresh editor', () => {
    const {editor2} = setupRestoredSlotTree();

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isDecoratorNode(hostR));
      const titleR = $getSlot(hostR, 'title');
      assert(titleR != null);
      assert($isElementNode(titleR));
      expect(titleR.getTextContent()).toBe('Title');
      // the restored slot is shadow-rooted: no parent in the children tree
      expect(titleR.getParent()).toBe(null);
    });
  });

  test('observer: a remote slot delete removes the slot from the decorator host', async () => {
    const {binding2, doc2, editor2, slotsY} = setupRestoredSlotTree();

    let slotKey = '';
    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isDecoratorNode(hostR));
      const title = $getSlot(hostR, 'title');
      assert(title != null);
      slotKey = title.__key;
    });
    expect(binding2.collabNodeMap.has(slotKey)).toBe(true);

    applyRemoteChange(binding2, () => {
      doc2.transact(() => {
        slotsY.delete('title');
      });
    });
    await flush();

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isDecoratorNode(hostR));
      expect($getSlotNames(hostR)).toEqual([]);
      expect($getSlot(hostR, 'title')).toBe(null);
    });
    // the slot's collab node must not dangle in the map after removal
    expect(binding2.collabNodeMap.has(slotKey)).toBe(false);
  });

  test('observer: editing text inside a decorator-host slot updates it in place', async () => {
    const {binding2, doc2, editor2, slotsY} = setupRestoredSlotTree();
    const titleY = slotsY.get('title');
    assert(titleY instanceof XmlText);
    const paraY = titleY.toDelta()[0].insert;
    assert(paraY instanceof XmlText);

    applyRemoteChange(binding2, () => {
      doc2.transact(() => {
        paraY.insert(paraY.length, '!!');
      });
    });
    await flush();

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isDecoratorNode(hostR));
      const titleR = $getSlot(hostR, 'title');
      assert(titleR != null);
      assert($isElementNode(titleR));
      expect(titleR.getTextContent()).toBe('Title!!');
      expect(titleR.getParent()).toBe(null);
    });
  });

  test('observer: a remote slot replace under the same name swaps the decorator-host slot', async () => {
    const {binding2, doc2, editor2, slotsY} = setupRestoredSlotTree();

    let oldKey = '';
    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isDecoratorNode(hostR));
      const title = $getSlot(hostR, 'title');
      assert(title != null);
      oldKey = title.__key;
    });
    expect(binding2.collabNodeMap.has(oldKey)).toBe(true);

    const oldTitleY = slotsY.get('title');
    applyRemoteChange(binding2, () => {
      doc2.transact(() => {
        const next = new XmlText();
        next.setAttribute('__type', 'test_shadow_root');
        slotsY.set('title', next);
      });
    });
    await flush();

    expect(slotsY.get('title')).not.toBe(oldTitleY);

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isDecoratorNode(hostR));
      expect($getSlotNames(hostR)).toEqual(['title']);
      const titleR = $getSlot(hostR, 'title');
      assert(titleR != null);
      assert($isElementNode(titleR));
      expect(titleR.__key).not.toBe(oldKey);
      expect(titleR.getParent()).toBe(null);
    });

    expect(binding2.collabNodeMap.has(oldKey)).toBe(false);
  });

  function setupLocalSlotTree() {
    const {binding, editor} = buildBinding();

    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostCollab = binding.root._children[0];
    assert(hostCollab instanceof CollabDecoratorNode);
    return {binding, editor, hostCollab};
  }

  test('local: a slot added to an existing decorator host serializes into the slots Y.Map', () => {
    const {binding, editor, hostCollab} = setupLocalSlotTree();

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isDecoratorNode(host));
      const subtitle = $createTestShadowRootNode();
      subtitle.append($createParagraphNode().append($createTextNode('Sub')));
      $setSlot(host, 'subtitle', subtitle);
    });

    const slotsY = hostCollab._xmlElem.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys()).sort()).toEqual(['subtitle', 'title']);
    const subY = slotsY.get('subtitle');
    assert(subY instanceof XmlText);
    expect(subY.toString()).toContain('Sub');
  });

  test('local: editing text inside a decorator-host slot updates the shared type in place', () => {
    const {binding, editor, hostCollab} = setupLocalSlotTree();
    const slotsY = hostCollab._xmlElem.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown as YMap<unknown>;
    const titleYBefore = slotsY.get('title');

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isDecoratorNode(host));
      const title = $getSlot(host, 'title');
      assert($isElementNode(title));
      const para = title.getFirstChild();
      assert($isElementNode(para));
      const text = para.getFirstChild();
      assert($isTextNode(text));
      text.setTextContent('Title!!');
    });

    const titleYAfter = slotsY.get('title');
    // same shared type object: edited in place, not recreated
    expect(titleYAfter).toBe(titleYBefore);
    assert(titleYAfter instanceof XmlText);
    expect(titleYAfter.toString()).toContain('Title!!');
  });

  test('local: removing the decorator host clears its slot collab node from the map', () => {
    const {binding, editor} = setupLocalSlotTree();

    let slotKey = '';
    let hostKey = '';
    editor.read(() => {
      const host = $getRoot().getFirstChild();
      assert($isDecoratorNode(host));
      hostKey = host.__key;
      const title = $getSlot(host, 'title');
      assert(title != null);
      slotKey = title.__key;
    });
    expect(binding.collabNodeMap.has(slotKey)).toBe(true);
    expect(binding.collabNodeMap.has(hostKey)).toBe(true);

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isDecoratorNode(host));
      host.remove();
    });

    expect(binding.collabNodeMap.has(hostKey)).toBe(false);
    expect(binding.collabNodeMap.has(slotKey)).toBe(false);
  });
});

// Host with a canonical slot declaration ('title' ahead of 'caption' even
// though code-unit order would flip them). Declaring slots also opts the host
// into eager slots Y.Map creation ($seedHostSlots), so each name's first set is
// an entry-level Y.Map op that merges per-key under concurrency instead of
// racing on attribute-level LWW.
class DeclaredCollabHostNode extends ElementNode {
  $config() {
    return this.config('declared_collab_host', {
      extends: ElementNode,
      slots: ['title', 'caption'],
    });
  }
  createDOM() {
    return document.createElement('div');
  }
  updateDOM() {
    return false;
  }
}

// Two real clients over two Docs, relayed through doc update messages
// (doc1 -> doc2), each wired through the same entry points
// useYjsCollaboration registers: the update listener feeds
// syncLexicalUpdateToYjs, observeDeep feeds syncYjsChangesToLexical with the
// origin filter (own-binding transactions skipped, UndoManager origin marks an
// undo replay). This exercises the event shapes only a genuine remote
// transaction produces — in particular a host's FIRST slot set, which
// integrates the slots Y.Map in the same transaction that assigns the `__slots`
// attribute, so the peer sees no YMapEvent at all, only a changed `__slots` key
// on the host's own event.
describe('named-slots collab-v1: two-client relay', () => {
  const editors: LexicalEditorWithDispose[] = [];
  afterEach(() => {
    for (const editor of editors) {
      editor.dispose();
    }
    editors.length = 0;
  });

  // syncLexicalUpdateToYjs ends with a selection sync that reads
  // provider.awareness; a local state of null short-circuits it.
  const provider = {
    awareness: {getLocalState: () => null},
  } as unknown as Provider;

  function buildClient(doc: Doc) {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-sync-v1]',
        nodes: [TestShadowRootNode, TestDecoratorNode, DeclaredCollabHostNode],
      }),
    );
    editors.push(editor);
    const docMap = new Map<string, Doc>([['slot-sync-v1', doc]]);
    const binding = createBinding(
      editor,
      provider,
      'slot-sync-v1',
      doc,
      docMap,
    );
    return {binding, doc, editor};
  }

  function serialize(editor: LexicalEditor, binding: Binding) {
    editor.read(() => {
      binding.doc.transact(() => {
        binding.root.syncChildrenFromLexical(
          binding,
          $getRoot(),
          null,
          null,
          null,
        );
      });
    });
  }

  function restore(editor: LexicalEditor, binding: Binding) {
    editor.update(
      () => {
        $getRoot().clear();
        binding.root.applyChildrenYjsDelta(
          binding,
          binding.root._xmlText.toDelta(),
        );
        binding.root.syncChildrenFromYjs(binding);
      },
      {discrete: true},
    );
  }

  // Mirrors useYjsCollaboration's observer registration: transactions this
  // binding originated are skipped, and an UndoManager origin marks the sync
  // as an undo/redo replay.
  function connectObserver(binding: Binding) {
    const sharedRoot = binding.root.getSharedType();
    const handler = (
      events: YEvent<YText>[],
      transaction: YTransaction,
    ): void => {
      const origin = transaction.origin;
      if (origin !== binding) {
        syncYjsChangesToLexical(
          binding,
          provider,
          events,
          origin instanceof UndoManager,
          () => undefined,
        );
      }
    };
    sharedRoot.observeDeep(handler);
    return () => sharedRoot.unobserveDeep(handler);
  }

  function applyLocalUpdate(
    binding: Binding,
    editor: LexicalEditor,
    mutate: () => void,
  ) {
    const removeListener = editor.registerUpdateListener(
      ({
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      }) => {
        syncLexicalUpdateToYjs(
          binding,
          provider,
          prevEditorState,
          editorState,
          dirtyElements,
          dirtyLeaves,
          normalizedNodes,
          tags,
        );
      },
    );
    try {
      editor.update(mutate, {discrete: true});
    } finally {
      removeListener();
    }
  }

  // syncYjsChangesToLexical commits its editor.update non-discretely, so the
  // new committed state lands on a microtask. Drain before reading.
  async function flush() {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Client 1 owns a slotless host already known to client 2; wires the relay;
  // returns both clients plus an observer disconnect for client 2.
  function setupTwoClients(buildTree: () => void) {
    const {
      binding: binding1,
      doc: doc1,
      editor: editor1,
    } = buildClient(new Doc());

    editor1.update(buildTree, {discrete: true});
    serialize(editor1, binding1);

    const doc2 = new Doc();
    applyUpdate(doc2, encodeStateAsUpdate(doc1));
    const {binding: binding2, editor: editor2} = buildClient(doc2);
    restore(editor2, binding2);

    doc1.on('update', (update: Uint8Array) => applyUpdate(doc2, update));
    const disconnect2 = connectObserver(binding2);

    return {binding1, binding2, disconnect2, doc1, doc2, editor1, editor2};
  }

  test('a first slot set on a synced element host reaches the peer', async () => {
    const {binding2, disconnect2, binding1, editor1, editor2} = setupTwoClients(
      () => {
        const host = $createParagraphNode();
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        host.append(body);
      },
    );

    try {
      applyLocalUpdate(binding1, editor1, () => {
        const host = $getRoot().getFirstChild();
        assert($isElementNode(host));
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $setSlot(host, 'title', title);
      });
      await flush();

      editor2.read(() => {
        const hostR = $getRoot().getFirstChild();
        assert($isElementNode(hostR));
        expect($getSlotNames(hostR)).toEqual(['title']);
        const titleR = $getSlot(hostR, 'title');
        assert(titleR != null);
        assert($isElementNode(titleR));
        expect(titleR.getTextContent()).toBe('Title');
        expect(titleR.getParent()).toBe(null);
        // `__slots` is a reserved channel key: the raw Y.Map must not be
        // restored as a junk node property on the host.
        expect(
          (hostR as unknown as Record<string, unknown>).slots,
        ).toBeUndefined();
      });

      // A follow-up peer-local edit re-diffs the host without tripping the
      // slots channel.
      applyLocalUpdate(binding2, editor2, () => {
        const host = $getRoot().getFirstChild();
        assert($isElementNode(host));
        const body = host.getFirstChild();
        assert($isElementNode(body));
        const text = body.getFirstChild();
        assert($isTextNode(text));
        text.setTextContent('Body changed');
      });

      const hostCollab2 = binding2.root._children[0];
      assert(hostCollab2 instanceof CollabElementNode);
      const slotsY2 = hostCollab2._xmlText.getAttribute(
        SLOTS_ATTR_KEY,
      ) as unknown;
      assert(slotsY2 instanceof YMap);
      expect(Array.from(slotsY2.keys())).toEqual(['title']);
    } finally {
      disconnect2();
    }
  });

  test('a first slot set on a synced decorator host reaches the peer', async () => {
    const {binding2, disconnect2, binding1, editor1, editor2} = setupTwoClients(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        $getRoot().clear().append(host);
      },
    );

    try {
      applyLocalUpdate(binding1, editor1, () => {
        const host = $getRoot().getFirstChild();
        assert($isDecoratorNode(host));
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $setSlot(host, 'title', title);
      });
      await flush();

      editor2.read(() => {
        const hostR = $getRoot().getFirstChild();
        assert($isDecoratorNode(hostR));
        expect($getSlotNames(hostR)).toEqual(['title']);
        expect($getSlot(hostR, 'title')?.getTextContent()).toBe('Title');
        expect(
          (hostR as unknown as Record<string, unknown>).slots,
        ).toBeUndefined();
      });

      // A follow-up peer-local edit beside the host syncs without throwing.
      applyLocalUpdate(binding2, editor2, () => {
        const para = $createParagraphNode();
        para.append($createTextNode('After'));
        $getRoot().append(para);
      });

      const hostCollab2 = binding2.root._children[0];
      assert(hostCollab2 instanceof CollabDecoratorNode);
      const slotsY2 = hostCollab2._xmlElem.getAttribute(
        SLOTS_ATTR_KEY,
      ) as unknown;
      assert(slotsY2 instanceof YMap);
      expect(Array.from(slotsY2.keys())).toEqual(['title']);
    } finally {
      disconnect2();
    }
  });

  // Undoing a first set removes the `__slots` attribute in the same shape the
  // set arrived in (a changed `__slots` key, no YMapEvent), so both clients and
  // both docs must converge back to the slotless host.
  test('undo of a first slot set converges on both clients', async () => {
    const {binding1, binding2, disconnect2, editor1, editor2} = setupTwoClients(
      () => {
        const host = $createParagraphNode();
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        host.append(body);
      },
    );

    // Client 1 observes its own doc too, so the UndoManager-origin
    // transaction replays into its editor.
    const disconnect1 = connectObserver(binding1);
    const undoManager = createUndoManager(
      binding1,
      binding1.root.getSharedType(),
    );
    try {
      applyLocalUpdate(binding1, editor1, () => {
        const host = $getRoot().getFirstChild();
        assert($isElementNode(host));
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $setSlot(host, 'title', title);
      });
      await flush();

      // sanity: the slot reached the peer before the undo
      editor2.read(() => {
        const hostR = $getRoot().getFirstChild();
        assert($isElementNode(hostR));
        expect($getSlotNames(hostR)).toEqual(['title']);
      });

      undoManager.undo();
      await flush();

      for (const editor of [editor1, editor2]) {
        editor.read(() => {
          const hostR = $getRoot().getFirstChild();
          assert($isElementNode(hostR));
          expect($getSlotNames(hostR)).toEqual([]);
          expect($getSlot(hostR, 'title')).toBe(null);
          expect(hostR.getTextContent()).toContain('Body');
        });
      }
      // yjs agrees on both docs: the attribute item itself was undone
      for (const binding of [binding1, binding2]) {
        const hostCollab = binding.root._children[0];
        assert(hostCollab instanceof CollabElementNode);
        expect(
          hostCollab._xmlText.getAttribute(SLOTS_ATTR_KEY),
        ).toBeUndefined();
      }
    } finally {
      disconnect1();
      disconnect2();
    }
  });

  // A class that declares its slots gets the slots Y.Map attached eagerly at
  // host creation ($seedHostSlots), even with zero occupied slots, so each
  // name's later first set is an entry-level op on a map both docs already
  // share.
  test('a declared host syncs its slots map eagerly', () => {
    const {binding, editor} = buildClient(new Doc());

    let hostKey = '';
    editor.update(
      () => {
        const host = $create(DeclaredCollabHostNode);
        $getRoot().clear().append(host);
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostCollab = binding.collabNodeMap.get(hostKey);
    assert(hostCollab instanceof CollabElementNode);
    const slotsY = hostCollab
      .getSharedType()
      .getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(slotsY.size).toBe(0);
  });

  // OFFLINE two-client variant: like setupTwoClients but with no live
  // doc1 -> doc2 relay, so both clients edit divergent docs and the deltas
  // are exchanged manually afterwards (both ways). Observers are connected on
  // BOTH bindings so each side replays the other's delta into its editor.
  function setupOfflineTwoClients(buildTree: () => void) {
    const {
      binding: binding1,
      doc: doc1,
      editor: editor1,
    } = buildClient(new Doc());

    editor1.update(buildTree, {discrete: true});
    serialize(editor1, binding1);

    const doc2 = new Doc();
    applyUpdate(doc2, encodeStateAsUpdate(doc1));
    const {binding: binding2, editor: editor2} = buildClient(doc2);
    restore(editor2, binding2);

    const disconnect1 = connectObserver(binding1);
    const disconnect2 = connectObserver(binding2);
    const disconnect = () => {
      disconnect1();
      disconnect2();
    };

    return {binding1, binding2, disconnect, doc1, doc2, editor1, editor2};
  }

  // Exchange the missing deltas both ways (state-vector diffs computed before
  // either side applies anything, as a real provider reconnect would).
  function exchangeUpdates(doc1: Doc, doc2: Doc) {
    const update1to2 = encodeStateAsUpdate(doc1, encodeStateVector(doc2));
    const update2to1 = encodeStateAsUpdate(doc2, encodeStateVector(doc1));
    applyUpdate(doc2, update1to2);
    applyUpdate(doc1, update2to1);
  }

  // Both first sets are entry-level ops on the eagerly-created (empty) slots
  // Y.Map from setup, so the offline merge keeps both entries instead of
  // racing on attribute LWW — and the canonical order makes both clients
  // agree on declaration order no matter who set what first.
  test('concurrent first slot sets on a declared host both survive and converge in canonical order', async () => {
    const {binding1, binding2, disconnect, doc1, doc2, editor1, editor2} =
      setupOfflineTwoClients(() => {
        const host = $create(DeclaredCollabHostNode);
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        host.append(body);
      });

    try {
      applyLocalUpdate(binding1, editor1, () => {
        const host = $getRoot().getFirstChild();
        assert(host instanceof DeclaredCollabHostNode);
        const caption = $createTestShadowRootNode();
        caption.append(
          $createParagraphNode().append($createTextNode('Caption')),
        );
        $setSlot(host, 'caption', caption);
      });
      applyLocalUpdate(binding2, editor2, () => {
        const host = $getRoot().getFirstChild();
        assert(host instanceof DeclaredCollabHostNode);
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $setSlot(host, 'title', title);
      });

      exchangeUpdates(doc1, doc2);
      await flush();

      for (const editor of [editor1, editor2]) {
        editor.read(() => {
          const host = $getRoot().getFirstChild();
          assert(host instanceof DeclaredCollabHostNode);
          // canonical (declared) order on both clients, regardless of which
          // client set which slot first
          expect($getSlotNames(host)).toEqual(['title', 'caption']);
          // both concurrent first sets survived the merge, content intact
          expect($getSlot(host, 'title')?.getTextContent()).toBe('Title');
          expect($getSlot(host, 'caption')?.getTextContent()).toBe('Caption');
        });
      }
    } finally {
      disconnect();
    }
  });

  test('concurrent declared and undeclared adds converge in canonical order', async () => {
    const {binding1, binding2, disconnect, doc1, doc2, editor1, editor2} =
      setupOfflineTwoClients(() => {
        const host = $create(DeclaredCollabHostNode);
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      });

    try {
      applyLocalUpdate(binding1, editor1, () => {
        const host = $getRoot().getFirstChild();
        assert(host instanceof DeclaredCollabHostNode);
        const caption = $createTestShadowRootNode();
        caption.append(
          $createParagraphNode().append($createTextNode('Caption')),
        );
        $setSlot(host, 'caption', caption);
      });
      applyLocalUpdate(binding2, editor2, () => {
        const host = $getRoot().getFirstChild();
        assert(host instanceof DeclaredCollabHostNode);
        const zzz = $createTestShadowRootNode();
        zzz.append($createParagraphNode().append($createTextNode('Zzz')));
        $setSlot(host, 'zzz', zzz);
      });

      exchangeUpdates(doc1, doc2);
      await flush();

      for (const editor of [editor1, editor2]) {
        editor.read(() => {
          const host = $getRoot().getFirstChild();
          assert(host instanceof DeclaredCollabHostNode);
          // declared names in declaration order, then the undeclared add
          expect($getSlotNames(host)).toEqual(['title', 'caption', 'zzz']);
          expect($getSlot(host, 'title')?.getTextContent()).toBe('Title');
          expect($getSlot(host, 'caption')?.getTextContent()).toBe('Caption');
          expect($getSlot(host, 'zzz')?.getTextContent()).toBe('Zzz');
        });
      }
    } finally {
      disconnect();
    }
  });

  // Concurrent move: two offline peers move the SAME slot value to DIFFERENT
  // hosts, then merge. Yjs has no move-aware CRDT for the cross-host slot
  // channel, so this is not guaranteed to resolve to a single destination —
  // but the two clients MUST still converge to the *same* state, with every
  // surviving slot well-linked to its host (no dangling up-link), the
  // original host emptied, and no hang. This pins the convergence /
  // no-corruption guarantee for the genuinely-ambiguous case.
  test('concurrent move of one slot value to different hosts converges without corruption', async () => {
    const {binding1, binding2, disconnect, doc1, doc2, editor1, editor2} =
      setupOfflineTwoClients(() => {
        const hostA = $createParagraphNode().append($createTextNode('A'));
        const hostB = $createParagraphNode().append($createTextNode('B'));
        const hostC = $createParagraphNode().append($createTextNode('C'));
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Moved')));
        $getRoot().clear().append(hostA).append(hostB).append(hostC);
        $setSlot(hostA, 'title', title);
      });

    try {
      // client 1 moves title A -> B
      applyLocalUpdate(binding1, editor1, () => {
        const children = $getRoot().getChildren();
        const hostA = children[0];
        const hostB = children[1];
        assert($isElementNode(hostA) && $isElementNode(hostB));
        const title = $getSlot(hostA, 'title');
        assert(title != null);
        $setSlot(hostB, 'title', title);
      });
      // client 2 concurrently moves title A -> C
      applyLocalUpdate(binding2, editor2, () => {
        const children = $getRoot().getChildren();
        const hostA = children[0];
        const hostC = children[2];
        assert($isElementNode(hostA) && $isElementNode(hostC));
        const title = $getSlot(hostA, 'title');
        assert(title != null);
        $setSlot(hostC, 'title', title);
      });

      exchangeUpdates(doc1, doc2);
      await flush();

      const snapshot = (editor: LexicalEditor) =>
        editor.read(() =>
          $getRoot()
            .getChildren()
            .map(host => {
              assert($isElementNode(host));
              const names = $getSlotNames(host);
              for (const name of names) {
                const value = $getSlot(host, name);
                assert(value != null);
                // no dangling up-link: every surviving slot points back here
                expect($getSlotHost(value)!.is(host)).toBe(true);
                // content survived the merge
                expect(value.getTextContent()).toBe('Moved');
              }
              return names;
            }),
        );

      const layout1 = snapshot(editor1);
      const layout2 = snapshot(editor2);
      // the two clients converge to identical slot layout (the core guarantee)
      expect(layout1).toEqual(layout2);
      // the original host is emptied on both clients
      expect(layout1[0]).toEqual([]);
    } finally {
      disconnect();
    }
  });

  // Concurrent edits *inside* the same slot value's subtree: two offline peers
  // each append a block to the same slot container, then merge. Editing within
  // a slot value syncs incrementally (the value's collab node persists — it is
  // not re-serialized like a move), so both concurrent inserts must survive the
  // merge and converge, exactly as they would for any non-slot subtree.
  test('concurrent edits inside one slot value merge and converge', async () => {
    const {binding1, binding2, disconnect, doc1, doc2, editor1, editor2} =
      setupOfflineTwoClients(() => {
        const host = $createParagraphNode();
        const body = $createTestShadowRootNode();
        body.append($createParagraphNode().append($createTextNode('Start')));
        $getRoot().clear().append(host);
        $setSlot(host, 'body', body);
      });

    try {
      applyLocalUpdate(binding1, editor1, () => {
        const host = $getRoot().getFirstChild();
        assert($isElementNode(host));
        const body = $getSlot(host, 'body');
        assert($isElementNode(body));
        body.append($createParagraphNode().append($createTextNode('One')));
      });
      applyLocalUpdate(binding2, editor2, () => {
        const host = $getRoot().getFirstChild();
        assert($isElementNode(host));
        const body = $getSlot(host, 'body');
        assert($isElementNode(body));
        body.append($createParagraphNode().append($createTextNode('Two')));
      });

      exchangeUpdates(doc1, doc2);
      await flush();

      const bodyText = (editor: LexicalEditor) =>
        editor.read(() => {
          const host = $getRoot().getFirstChild();
          assert($isElementNode(host));
          const body = $getSlot(host, 'body');
          assert($isElementNode(body));
          // the slot stays linked to its host through the concurrent merge
          expect($getSlotHost(body)!.is(host)).toBe(true);
          return body
            .getChildren()
            .map(child => child.getTextContent())
            .sort();
        });

      const text1 = bodyText(editor1);
      const text2 = bodyText(editor2);
      // both clients converge on the same merged content
      expect(text1).toEqual(text2);
      // and both concurrent inserts survived alongside the original
      expect(text1).toEqual(['One', 'Start', 'Two']);
    } finally {
      disconnect();
    }
  });
});
