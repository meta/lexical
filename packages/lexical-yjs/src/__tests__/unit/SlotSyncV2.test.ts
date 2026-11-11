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
  type BindingV2,
  createBindingV2__EXPERIMENTAL,
  type Provider,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
} from '@lexical/yjs';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $isTextNode,
  $removeSlot,
  $setSlot,
  DecoratorNode,
  defineExtension,
  ElementNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {
  $createTestShadowRootNode,
  TestShadowRootNode,
} from 'lexical/src/__tests__/utils';
import {afterEach, assert, describe, expect, test} from 'vitest';
import {
  applyUpdate,
  Doc,
  emptySnapshot,
  encodeStateAsUpdate,
  Map as YMap,
  snapshot as createSnapshot,
  XmlElement,
  XmlText,
} from 'yjs';

import {$createOrUpdateNodeFromYElement, $updateYFragment} from '../../SyncV2';
import {SLOTS_ATTR_KEY} from '../../Utils';

// collab-v2 named-slot coverage: serialize a lexical tree with a named slot into
// the V2 representation (the slot lands in the host's dedicated `__slots` Y.Map,
// separate from the linked-list children), restore it into a fresh editor
// (round-trip), and exercise the remote-change reconcile
// ($createOrUpdateNodeFromYElement) and the local update path
// (syncLexicalUpdateToYjsV2). The remote tests call the reconcile entry
// directly; driving it through the observer dispatch ($syncEventV2's YMap
// reroute) is tracked separately.
// A minimal non-inline decorator, used to exercise the decorator-as-slot path
// ($setSlot allows ElementNode or DecoratorNode, non-inline). isInline is
// hard-coded false so the slot guard holds on restore without depending on a
// property round-tripping.
class BlockDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('block_decorator_slot', {extends: DecoratorNode});
  }
  isInline(): boolean {
    return false;
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  decorate(): null {
    return null;
  }
}

// Variant of BlockDecoratorNode with a settable own attribute (__caption).
// Used to probe whether V2 sync writes a decorator slot value's own-attribute
// change to yjs when no nested children/slots are dirty (the dirtyLeaves vs
// dirtyElements routing question).
class BlockDecoratorAttrNode extends DecoratorNode<null> {
  __caption: string = '';
  $config() {
    return this.config('block_decorator_attr_slot', {extends: DecoratorNode});
  }
  afterCloneFrom(prev: this): void {
    super.afterCloneFrom(prev);
    this.__caption = prev.__caption;
  }
  isInline(): boolean {
    return false;
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  decorate(): null {
    return null;
  }
  setCaption(caption: string): this {
    const self = this.getWritable();
    self.__caption = caption;
    return self;
  }
  getCaption(): string {
    return this.getLatest().__caption;
  }
}

// Host with a canonical slot declaration ('title' ahead of 'caption' even
// though code-unit order would flip them). Declaring slots opts the host into
// eager slots Y.Map creation in V2 ($updateSlotsYType) so each name's first
// set merges per-entry instead of racing on attribute-level LWW.
class DeclaredV2HostNode extends ElementNode {
  $config() {
    return this.config('declared_v2_host', {
      extends: ElementNode,
      slots: ['title', 'caption'],
    });
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
}

describe('named-slots collab-v2: lexical <-> yjs', () => {
  const editors: LexicalEditorWithDispose[] = [];
  afterEach(() => {
    for (const editor of editors) {
      editor.dispose();
    }
    editors.length = 0;
  });

  function buildBinding(nodes: readonly Klass<LexicalNode>[] = []) {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-sync-v2]',
        nodes,
      }),
    );
    editors.push(editor);
    const doc = new Doc();
    const docMap = new Map<string, Doc>([['slot-sync-v2', doc]]);
    const binding = createBindingV2__EXPERIMENTAL(
      editor,
      'slot-sync-v2',
      doc,
      docMap,
    );
    return {binding, doc, editor};
  }

  // A second editor + binding over the *same* doc, with a fresh mapping. Used
  // to restore a serialized tree into a clean editor (yjs -> lexical).
  function buildRestoreBinding(
    doc: Doc,
    nodes: readonly Klass<LexicalNode>[] = [],
  ) {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-sync-v2]',
        nodes,
      }),
    );
    editors.push(editor);
    const docMap = new Map<string, Doc>([['slot-sync-v2', doc]]);
    const binding = createBindingV2__EXPERIMENTAL(
      editor,
      'slot-sync-v2',
      doc,
      docMap,
    );
    return {binding, editor};
  }

  function serialize(editor: LexicalEditor, binding: BindingV2) {
    editor.read(() => {
      binding.doc.transact(() => {
        $updateYFragment(
          binding.doc,
          binding.root,
          $getRoot(),
          binding,
          new Set(['root']),
        );
      });
    });
  }

  test('a host with a "title" slot serializes the slot into a `__slots` Y.Map', () => {
    const {binding, editor} = buildBinding([TestShadowRootNode]);

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

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    // body child still lives in the linked-list children channel
    const childY = hostY.toArray()[0];
    assert(childY instanceof XmlElement);

    // the slot lives in the dedicated `__slots` attribute channel, not children.
    // `getAttribute` is typed as returning a string, so widen to unknown before
    // the runtime `instanceof` narrows it back to the Y.Map we actually stored.
    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys())).toEqual(['title']);

    // the slot value is a shadow root; its text lives in the inner paragraph.
    const titleY = slotsY.get('title');
    assert(titleY instanceof XmlElement);
    expect(titleY.nodeName).toBe('test_shadow_root');
    const titleParaY = titleY.toArray()[0];
    assert(titleParaY instanceof XmlElement);
    expect(titleParaY.nodeName).toBe('paragraph');
    const titleText = titleParaY.toArray()[0];
    assert(titleText instanceof XmlText);
    expect(titleText.toString()).toBe('Title');
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

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    expect(hostY.getAttribute(SLOTS_ATTR_KEY)).toBeUndefined();
  });

  test('round-trip: a serialized slot restores into a fresh editor', () => {
    const {binding, doc, editor} = buildBinding([TestShadowRootNode]);

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

    // restore from the shared doc into a fresh editor with an empty mapping,
    // mirroring syncYjsStateToLexicalV2's initial-restore entry point.
    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc, [
      TestShadowRootNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(binding2.root, binding2, null, true);
      },
      {discrete: true},
    );

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

  test('round-trip: a non-inline decorator slot restores into a fresh editor', () => {
    const {binding, doc, editor} = buildBinding([BlockDecoratorNode]);

    editor.update(
      () => {
        const host = $createParagraphNode();
        host.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        $setSlot(host, 'cover', $create(BlockDecoratorNode));
      },
      {discrete: true},
    );

    serialize(editor, binding);

    // the decorator slot lands in the `__slots` channel as an XmlElement named
    // after its node type, alongside (not inside) the linked-list children
    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    const coverY = slotsY.get('cover');
    assert(coverY instanceof XmlElement);
    expect(coverY.nodeName).toBe('block_decorator_slot');

    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc, [
      BlockDecoratorNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(binding2.root, binding2, null, true);
      },
      {discrete: true},
    );

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      expect(hostR.getTextContent()).toContain('Body');

      const coverR = $getSlot(hostR, 'cover');
      assert(coverR instanceof BlockDecoratorNode);
      // the decorator survives $setSlot's guard on restore (non-inline) and is
      // shadow-rooted: no parent in the children tree
      expect(coverR.isInline()).toBe(false);
      expect(coverR.getParent()).toBe(null);
    });
  });

  // observer-path probe: a text edit inside a slot arrives (per the yjs event
  // probe) as a YTextEvent whose parent is the slot XmlElement, so $syncEventV2
  // routes it to $createOrUpdateNodeFromYElement(slotXmlElement). This asserts
  // that re-running that function over an already-mapped slot node (which lives
  // outside the children tree, __parent === null) updates its text in place
  // without re-running $setSlot.
  test('observer: editing text inside a slot updates the slot node in place', () => {
    const {binding, doc, editor} = buildBinding([TestShadowRootNode]);

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        host.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc, [
      TestShadowRootNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(binding2.root, binding2, null, true);
      },
      {discrete: true},
    );

    // edit the slot's text directly in yjs (simulating a remote change). The
    // slot is a shadow root, so the text lives in the inner paragraph's XmlText.
    const hostY = binding2.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    const titleY = slotsY.get('title');
    assert(titleY instanceof XmlElement);
    const titleParaY = titleY.toArray()[0];
    assert(titleParaY instanceof XmlElement);
    const titleTextY = titleParaY.toArray()[0];
    assert(titleTextY instanceof XmlText);
    doc.transact(() => {
      titleTextY.insert(5, '!!');
    });

    // replay the (b) routing: target=XmlText -> parent=the paragraph XmlElement
    // inside the slot's shadow root (where the edited text actually lives)
    editor2.update(
      () => {
        $createOrUpdateNodeFromYElement(titleParaY, binding2, new Set(), true);
      },
      {discrete: true},
    );

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

  // observer (a): a remote slot add arrives (per the yjs event probe) as a
  // YMapEvent on the host's slots Y.Map, which option 1A re-routes to a host
  // re-reconcile. The diff loop keeps the existing 'title' slot (same key ->
  // skip) and adds the new 'subtitle' slot, with no $setSlot invariant trip.
  test('observer: a remote slot add reconciles into the host', () => {
    const {binding, doc, editor} = buildBinding([TestShadowRootNode]);

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        host.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc, [
      TestShadowRootNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(binding2.root, binding2, null, true);
      },
      {discrete: true},
    );

    const hostY = binding2.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    // the slot value is a shadow root wrapping a paragraph — the multi-block
    // value shape this suite uses throughout.
    doc.transact(() => {
      const sub = new XmlElement('test_shadow_root');
      const subPara = new XmlElement('paragraph');
      const subText = new XmlText();
      subPara.insert(0, [subText]);
      subText.insert(0, 'Subtitle');
      sub.insert(0, [subPara]);
      slotsY.set('subtitle', sub);
    });

    // option 1A routing: re-reconcile the host slots channel
    editor2.update(
      () => {
        $createOrUpdateNodeFromYElement(
          hostY,
          binding2,
          new Set([SLOTS_ATTR_KEY]),
          false,
        );
      },
      {discrete: true},
    );

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      expect($getSlotNames(hostR).sort()).toEqual(['subtitle', 'title']);
      expect($getSlot(hostR, 'title')?.getTextContent()).toBe('Title');
      expect($getSlot(hostR, 'subtitle')?.getTextContent()).toBe('Subtitle');
    });
  });

  // observer (c): a remote slot delete arrives as a YMapEvent too; the diff
  // loop drops the lexical slot whose name is gone from the slots Y.Map.
  test('observer: a remote slot delete removes the slot from the host', () => {
    const {binding, doc, editor} = buildBinding([TestShadowRootNode]);

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        host.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc, [
      TestShadowRootNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(binding2.root, binding2, null, true);
      },
      {discrete: true},
    );

    const hostY = binding2.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    doc.transact(() => {
      slotsY.delete('title');
    });

    editor2.update(
      () => {
        $createOrUpdateNodeFromYElement(
          hostY,
          binding2,
          new Set([SLOTS_ATTR_KEY]),
          false,
        );
      },
      {discrete: true},
    );

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      expect($getSlotNames(hostR)).toEqual([]);
      expect($getSlot(hostR, 'title')).toBe(null);
      // the linked-list child is untouched by the slot removal
      expect(hostR.getTextContent()).toContain('Body');
    });
  });

  // Build a host with a 'title' slot + 'Body' child and run the initial full
  // serialization (createTypeFromElementNode seeds the slots Y.Map). Returns the
  // serializer's own binding/editor plus the host XmlElement so subsequent local
  // edits diff against it in place.
  function setupLocalSlotTree() {
    const {binding, editor} = buildBinding([TestShadowRootNode]);

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

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    return {binding, editor, hostY};
  }

  // Drive the real local (lexical -> yjs) update path: register the same update
  // listener useYjsCollaboration registers for V2 and let
  // syncLexicalUpdateToYjsV2__EXPERIMENTAL diff the dirty tree into yjs. The
  // provider is unused beyond the selection sync, which short-circuits on a null
  // local awareness state.
  function applyLocalUpdate(
    binding: BindingV2,
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
        syncLexicalUpdateToYjsV2__EXPERIMENTAL(
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

  // local (a): a slot added to an already-serialized host. The host update
  // reaches $updateSlotsYType, which creates the new slot's shared type and sets
  // it on the slots Y.Map.
  test('local: a slot added to an existing host serializes into the slots Y.Map', () => {
    const {binding, editor, hostY} = setupLocalSlotTree();

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const subtitle = $createTestShadowRootNode();
      subtitle.append($createParagraphNode().append($createTextNode('Sub')));
      $setSlot(host, 'subtitle', subtitle);
    });

    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys()).sort()).toEqual(['subtitle', 'title']);
    const subY = slotsY.get('subtitle');
    assert(subY instanceof XmlElement);
    const subParaY = subY.toArray()[0];
    assert(subParaY instanceof XmlElement);
    const subText = subParaY.toArray()[0];
    assert(subText instanceof XmlText);
    expect(subText.toString()).toBe('Sub');
  });

  // local (b): a text edit inside a slot. The slot node identity is preserved,
  // so $updateSlotsYType recurses $updateYFragment into the slot's XmlElement in
  // place — the existing XmlElement object is reused (identity preserved) and
  // its text updated, not recreated.
  test('local: editing text inside a slot updates the slot shared type in place', () => {
    const {binding, editor, hostY} = setupLocalSlotTree();
    const slotsY = hostY.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown as YMap<unknown>;
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
    assert(titleYAfter instanceof XmlElement);
    const titleParaY = titleYAfter.toArray()[0];
    assert(titleParaY instanceof XmlElement);
    const titleText = titleParaY.toArray()[0];
    assert(titleText instanceof XmlText);
    expect(titleText.toString()).toBe('Title!!');
  });

  // local (c): a slot removed from the host. $updateSlotsYType's delete loop
  // drops the name gone from lexical out of the slots Y.Map.
  test('local: removing a slot deletes it from the slots Y.Map', () => {
    const {binding, editor, hostY} = setupLocalSlotTree();

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      $removeSlot(host, 'title');
    });

    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    if (slotsY instanceof YMap) {
      expect(Array.from(slotsY.keys())).toEqual([]);
    }
  });

  // local (c2): removing a slot also clears the departing shared type from the
  // binding mapping, mirroring the children path (which calls
  // binding.mapping.delete on a removed fragment). Without it the stale slot
  // type lingers in the mapping for the doc's lifetime.
  test('local: removing a slot clears the departing shared type from the mapping', () => {
    const {binding, editor, hostY} = setupLocalSlotTree();
    const slotsY = hostY.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown as YMap<XmlElement>;
    const oldType = slotsY.get('title');
    assert(oldType != null);
    expect(binding.mapping.has(oldType)).toBe(true);

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      $removeSlot(host, 'title');
    });

    expect(binding.mapping.has(oldType)).toBe(false);
  });

  // local (c3): replacing a slot under the same name clears the departing shared
  // type from the mapping before the new value is created (the same-name set
  // would otherwise overwrite the Y.Map entry while the old type lingers).
  test('local: replacing a slot under the same name clears the old shared type from the mapping', () => {
    const {binding, editor, hostY} = setupLocalSlotTree();
    const slotsY = hostY.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown as YMap<XmlElement>;
    const oldType = slotsY.get('title');
    assert(oldType != null);

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      $removeSlot(host, 'title');
      const next = $createTestShadowRootNode();
      next.append($createParagraphNode().append($createTextNode('New')));
      $setSlot(host, 'title', next);
    });

    expect(binding.mapping.has(oldType)).toBe(false);
    const newType = slotsY.get('title');
    assert(newType != null);
    expect(newType).not.toBe(oldType);
    expect(binding.mapping.has(newType)).toBe(true);
  });

  // local (d): the diff (not whole-recreate) evidence. An unrelated child edit
  // re-syncs the host, but the untouched 'title' slot keeps the same XmlElement
  // object identity — $updateSlotsYType left it in place (it was not dirty)
  // rather than recreating and re-setting it.
  test('local: an unrelated host edit leaves an untouched slot identical', () => {
    const {binding, editor, hostY} = setupLocalSlotTree();
    const slotsY = hostY.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown as YMap<unknown>;
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
    assert(titleYAfter instanceof XmlElement);
    const titleParaY = titleYAfter.toArray()[0];
    assert(titleParaY instanceof XmlElement);
    const titleText = titleParaY.toArray()[0];
    assert(titleText instanceof XmlText);
    expect(titleText.toString()).toBe('Title');
  });

  // local (f): a decorator-valued slot. A non-inline DecoratorNode is a valid
  // slot value; when it carries its own nested slot it is mapped, so an
  // unrelated host edit must leave its XmlElement identity intact (diffed in
  // place, not recreated). Mirrors local (d) but with a decorator slot value, to
  // cover $updateSlotsYType's same-identity branch for the decorator case.
  test('local: an unrelated host edit leaves an untouched decorator slot identical', () => {
    const {binding, editor} = buildBinding([
      BlockDecoratorNode,
      TestShadowRootNode,
    ]);

    editor.update(
      () => {
        const host = $createParagraphNode();
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        // a decorator slot value that itself hosts a nested slot, so it gets
        // mapped (an unmapped plain decorator can't hit the same-identity path)
        const cover = $create(BlockDecoratorNode);
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

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown as YMap<unknown>;
    const coverYBefore = slotsY.get('cover');
    assert(coverYBefore instanceof XmlElement);

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
    // same shared type object: the decorator slot was diffed in place, not
    // recreated with a new yjs id on every host update
    expect(coverYAfter).toBe(coverYBefore);
  });

  // local (g): a plain decorator-valued slot (no nested slots of its own).
  // createTypeFromElementNode only maps a slot-hosting decorator, so a plain
  // decorator slot must still be identity-tracked to survive an unrelated host
  // edit in place rather than being recreated with a new yjs id.
  test('local: an unrelated host edit leaves an untouched plain decorator slot identical', () => {
    const {binding, editor} = buildBinding([BlockDecoratorNode]);

    editor.update(
      () => {
        const host = $createParagraphNode();
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        host.append(body);
        $setSlot(host, 'cover', $create(BlockDecoratorNode));
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown as YMap<unknown>;
    const coverYBefore = slotsY.get('cover');
    assert(coverYBefore instanceof XmlElement);

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

  // local (e): $setSlot enforces block-only slot values (a non-inline
  // ElementNode or DecoratorNode), so a bare TextNode is rejected. This is why
  // the slots channel only ever (de)serializes XmlElement — a raw-text slot can
  // never exist to need an XmlText carrier.
  test('setSlot rejects a bare text node as a slot value', () => {
    const {editor} = buildBinding();

    expect(() =>
      editor.update(
        () => {
          const host = $createParagraphNode();
          host.append($createTextNode('Body'));
          $getRoot().clear().append(host);
          $setSlot(host, 'caption', $createTextNode('Cap'));
        },
        {discrete: true},
      ),
    ).toThrow(/not a valid slot value/);
  });

  // DECORATOR host: a non-inline decorator hosts named slots even though it has
  // no linked-list children channel. In V2 it serializes to an XmlElement named
  // after its node type, carrying the `__slots` Y.Map attribute, and is mapped
  // (only because it has slots) so its in-place slot updates can find it. These
  // mirror the element-host cases through the same V2 entry points
  // (createTypeFromElementNode non-element branch, the generic slot reconcile,
  // and the widened fast-match recursion for a mapped dirty decorator host).
  test('decorator host: a "title" slot serializes into a `__slots` Y.Map', () => {
    const {binding, editor} = buildBinding([
      BlockDecoratorNode,
      TestShadowRootNode,
    ]);

    editor.update(
      () => {
        const host = $create(BlockDecoratorNode);
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    expect(hostY.nodeName).toBe('block_decorator_slot');
    // a decorator host has no children channel
    expect(hostY.toArray()).toEqual([]);

    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys())).toEqual(['title']);
    const titleY = slotsY.get('title');
    assert(titleY instanceof XmlElement);
    expect(titleY.nodeName).toBe('test_shadow_root');
    const titleParaY = titleY.toArray()[0];
    assert(titleParaY instanceof XmlElement);
    const titleText = titleParaY.toArray()[0];
    assert(titleText instanceof XmlText);
    expect(titleText.toString()).toBe('Title');
  });

  test('decorator host: a host with no slots stays unmapped with no `__slots` attribute', () => {
    const {binding, editor} = buildBinding([BlockDecoratorNode]);

    editor.update(
      () => {
        $getRoot().clear().append($create(BlockDecoratorNode));
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    expect(hostY.getAttribute(SLOTS_ATTR_KEY)).toBeUndefined();
  });

  test('decorator host round-trip: a serialized slot restores into a fresh editor', () => {
    const {binding, doc, editor} = buildBinding([
      BlockDecoratorNode,
      TestShadowRootNode,
    ]);

    editor.update(
      () => {
        const host = $create(BlockDecoratorNode);
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc, [
      BlockDecoratorNode,
      TestShadowRootNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(binding2.root, binding2, null, true);
      },
      {discrete: true},
    );

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert(hostR instanceof BlockDecoratorNode);
      const titleR = $getSlot(hostR, 'title');
      assert(titleR != null);
      assert($isElementNode(titleR));
      expect(titleR.getTextContent()).toBe('Title');
      expect(titleR.getParent()).toBe(null);
    });
  });

  test('decorator host observer: editing text inside a slot updates it in place', () => {
    const {binding, doc, editor} = buildBinding([
      BlockDecoratorNode,
      TestShadowRootNode,
    ]);

    editor.update(
      () => {
        const host = $create(BlockDecoratorNode);
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc, [
      BlockDecoratorNode,
      TestShadowRootNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(binding2.root, binding2, null, true);
      },
      {discrete: true},
    );

    const hostY = binding2.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    const titleY = slotsY.get('title');
    assert(titleY instanceof XmlElement);
    const titleParaY = titleY.toArray()[0];
    assert(titleParaY instanceof XmlElement);
    const titleTextY = titleParaY.toArray()[0];
    assert(titleTextY instanceof XmlText);
    doc.transact(() => {
      titleTextY.insert(5, '!!');
    });

    editor2.update(
      () => {
        $createOrUpdateNodeFromYElement(titleParaY, binding2, new Set(), true);
      },
      {discrete: true},
    );

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert(hostR instanceof BlockDecoratorNode);
      const titleR = $getSlot(hostR, 'title');
      assert(titleR != null);
      assert($isElementNode(titleR));
      expect(titleR.getTextContent()).toBe('Title!!');
      expect(titleR.getParent()).toBe(null);
    });
  });

  test('decorator host observer: a remote slot delete removes the slot', () => {
    const {binding, doc, editor} = buildBinding([
      BlockDecoratorNode,
      TestShadowRootNode,
    ]);

    editor.update(
      () => {
        const host = $create(BlockDecoratorNode);
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc, [
      BlockDecoratorNode,
      TestShadowRootNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(binding2.root, binding2, null, true);
      },
      {discrete: true},
    );

    const hostY = binding2.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    doc.transact(() => {
      slotsY.delete('title');
    });

    editor2.update(
      () => {
        $createOrUpdateNodeFromYElement(
          hostY,
          binding2,
          new Set([SLOTS_ATTR_KEY]),
          false,
        );
      },
      {discrete: true},
    );

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert(hostR instanceof BlockDecoratorNode);
      expect($getSlotNames(hostR)).toEqual([]);
      expect($getSlot(hostR, 'title')).toBe(null);
    });
  });

  test('decorator host local: a slot added to an existing host serializes into the slots Y.Map', () => {
    const {binding, editor} = buildBinding([
      BlockDecoratorNode,
      TestShadowRootNode,
    ]);

    editor.update(
      () => {
        const host = $create(BlockDecoratorNode);
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert(host instanceof BlockDecoratorNode);
      const subtitle = $createTestShadowRootNode();
      subtitle.append($createParagraphNode().append($createTextNode('Sub')));
      $setSlot(host, 'subtitle', subtitle);
    });

    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys()).sort()).toEqual(['subtitle', 'title']);
    const subY = slotsY.get('subtitle');
    assert(subY instanceof XmlElement);
    const subParaY = subY.toArray()[0];
    assert(subParaY instanceof XmlElement);
    const subText = subParaY.toArray()[0];
    assert(subText instanceof XmlText);
    expect(subText.toString()).toBe('Sub');
  });

  test('decorator host local: editing text inside a slot updates the shared type in place', () => {
    const {binding, editor} = buildBinding([
      BlockDecoratorNode,
      TestShadowRootNode,
    ]);

    editor.update(
      () => {
        const host = $create(BlockDecoratorNode);
        const title = $createTestShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().clear().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown as YMap<unknown>;
    const titleYBefore = slotsY.get('title');

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert(host instanceof BlockDecoratorNode);
      const title = $getSlot(host, 'title');
      assert($isElementNode(title));
      const para = title.getFirstChild();
      assert($isElementNode(para));
      const text = para.getFirstChild();
      assert($isTextNode(text));
      text.setTextContent('Title!!');
    });

    const titleYAfter = slotsY.get('title');
    // same shared type object: edited in place via the widened fast-match
    // recursion (mapped dirty decorator host -> $updateSlotsYType), not recreated
    expect(titleYAfter).toBe(titleYBefore);
    assert(titleYAfter instanceof XmlElement);
    const titleParaY = titleYAfter.toArray()[0];
    assert(titleParaY instanceof XmlElement);
    const titleText = titleParaY.toArray()[0];
    assert(titleText instanceof XmlText);
    expect(titleText.toString()).toBe('Title!!');
  });

  // A DecoratorNode slot value's own dirty mark lives in `dirtyLeaves` (only
  // ElementNodes go to `dirtyElements`), and `$updateSlotsYType`'s
  // same-identity recursion gates on the dirty set passed in from the V2
  // sync entry. Without unioning `dirtyLeaves` into that set, a decorator
  // slot value's own-attribute change would be skipped — the attribute would
  // never reach the yjs XmlElement. This test pins that propagation.
  test('decorator slot value own-attribute change propagates to yjs', () => {
    const {binding, editor} = buildBinding([BlockDecoratorAttrNode]);

    editor.update(
      () => {
        const host = $createParagraphNode();
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        host.append(body);
        const cover = $create(BlockDecoratorAttrNode);
        cover.setCaption('before');
        $setSlot(host, 'cover', cover);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown as YMap<unknown>;
    const coverYBefore = slotsY.get('cover');
    assert(coverYBefore instanceof XmlElement);
    expect(coverYBefore.getAttribute('__caption')).toBe('before');

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const cover = $getSlot(host, 'cover');
      assert(cover instanceof BlockDecoratorAttrNode);
      cover.setCaption('after');
    });

    // If hypothesis holds, the attribute is still 'before' (V2 sync skipped
    // the recursion because the decorator key was in dirtyLeaves, not
    // dirtyElements). If V2 sync handles this correctly, it's 'after'.
    expect(coverYBefore.getAttribute('__caption')).toBe('after');
  });

  // R3 audit reproduce: V2 slot removal only deletes the top-level slot
  // shared type from binding.mapping; the slot's nested children
  // (inner XmlElements / XmlTexts) stay registered. Over time
  // binding.mapping accumulates entries from removed subtrees — memory
  // leak. The hypothesis: capture the inner children types before
  // removal, remove the slot, and assert they are no longer in
  // binding.mapping.
  test('V2: removing a slot also cleans up its nested mapping entries', () => {
    const {binding, editor, hostY} = setupLocalSlotTree();
    const slotsY = hostY.getAttribute(
      SLOTS_ATTR_KEY,
    ) as unknown as YMap<XmlElement>;
    const slotType = slotsY.get('title');
    assert(slotType != null);

    // Capture inner descendants of the slot's XmlElement before removal.
    const innerTypes: (XmlElement | XmlText)[] = [];
    const collect = (xe: XmlElement) => {
      for (const child of xe.toArray()) {
        if (
          child instanceof XmlElement ||
          (child as object) instanceof XmlText
        ) {
          innerTypes.push(child as XmlElement | XmlText);
          if (child instanceof XmlElement) {
            collect(child);
          }
        }
      }
    };
    collect(slotType);
    expect(innerTypes.length).toBeGreaterThan(0);
    for (const inner of innerTypes) {
      expect(binding.mapping.has(inner)).toBe(true);
    }

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      $removeSlot(host, 'title');
    });

    // Top-level removed (the existing test pins this).
    expect(binding.mapping.has(slotType)).toBe(false);
    // Hypothesis: the inner descendants are also gone.
    for (const inner of innerTypes) {
      expect(binding.mapping.has(inner)).toBe(false);
    }
  });

  // local (h): a FIRST slot set on an already-synced host. The host is a new
  // version object after $setSlot, so the mapped-identity fast path fails and
  // the equality fallback must report the slots channel unequal — otherwise
  // the dirty scan repoints the mapping without recursing and
  // $updateSlotsYType never writes the slot to yjs.
  test('local: a first slot set on an already-synced host is written to yjs and reaches a peer', () => {
    const {binding, doc, editor} = buildBinding([TestShadowRootNode]);

    editor.update(
      () => {
        const host = $createParagraphNode();
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().clear().append(host);
        host.append(body);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    expect(hostY.getAttribute(SLOTS_ATTR_KEY)).toBeUndefined();

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const title = $createTestShadowRootNode();
      title.append($createParagraphNode().append($createTextNode('Title')));
      $setSlot(host, 'title', title);
    });

    // written to yjs in the same flush as the local update
    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys())).toEqual(['title']);

    // a peer doc seeded from the originator's update restores the slot
    const doc2 = new Doc();
    applyUpdate(doc2, encodeStateAsUpdate(doc));
    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc2, [
      TestShadowRootNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(binding2.root, binding2, null, true);
      },
      {discrete: true},
    );

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      expect(hostR.getTextContent()).toContain('Body');
      const titleR = $getSlot(hostR, 'title');
      assert(titleR != null);
      assert($isElementNode(titleR));
      expect(titleR.getTextContent()).toBe('Title');
      expect(titleR.getParent()).toBe(null);
    });
  });

  // local (i): removing the last slot keeps the (empty) Y.Map attribute
  // (mirrors V1), so a subsequent add reuses it instead of re-running the
  // first-set creation race — and that add still syncs.
  test('local: removing the last slot keeps the empty slots attribute and a later add syncs', () => {
    const {binding, editor, hostY} = setupLocalSlotTree();
    const slotsYBefore = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsYBefore instanceof YMap);

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      $removeSlot(host, 'title');
    });

    // the (now empty) Y.Map attribute survives the removal of the last slot
    const slotsYAfter = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsYAfter instanceof YMap);
    expect(slotsYAfter).toBe(slotsYBefore);
    expect(Array.from(slotsYAfter.keys())).toEqual([]);

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const subtitle = $createTestShadowRootNode();
      subtitle.append($createParagraphNode().append($createTextNode('Sub')));
      $setSlot(host, 'subtitle', subtitle);
    });

    expect(Array.from(slotsYAfter.keys())).toEqual(['subtitle']);
    const subY = slotsYAfter.get('subtitle');
    assert(subY instanceof XmlElement);
    const subParaY = subY.toArray()[0];
    assert(subParaY instanceof XmlElement);
    const subText = subParaY.toArray()[0];
    assert(subText instanceof XmlText);
    expect(subText.toString()).toBe('Sub');
  });

  // snapshot: slot membership is read through the snapshot like the sibling
  // children logic (the Y.Map's entries live in its own item chain, so the
  // live entries() iterator would render current membership into a historical
  // view). A slot added after the snapshot must not appear.
  test('snapshot: slot membership reflects the snapshot, not the live doc', () => {
    const {binding, doc, editor} = buildBinding([TestShadowRootNode]);
    // historical snapshot reads require GC to be off (see renderSnapshot)
    doc.gc = false;

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

    const snap = createSnapshot(doc);

    applyLocalUpdate(binding, editor, () => {
      const host = $getRoot().getFirstChild();
      assert($isElementNode(host));
      const subtitle = $createTestShadowRootNode();
      subtitle.append($createParagraphNode().append($createTextNode('Sub')));
      $setSlot(host, 'subtitle', subtitle);
    });

    // the live doc carries both slots
    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(Array.from(slotsY.keys()).sort()).toEqual(['subtitle', 'title']);

    // a historical render against the older snapshot sees only 'title'
    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc, [
      TestShadowRootNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(
          binding2.root,
          binding2,
          null,
          true,
          snap,
          emptySnapshot,
        );
      },
      {discrete: true},
    );

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert($isElementNode(hostR));
      expect($getSlotNames(hostR)).toEqual(['title']);
      expect($getSlot(hostR, 'title')?.getTextContent()).toBe('Title');
    });
  });

  // A class that declares its slots opts into eager slots Y.Map creation:
  // even with zero occupied slots the host carries an (empty) `__slots` Y.Map
  // after sync, so each name's later first set is an entry-level op that
  // merges per-key under concurrency instead of racing on attribute LWW.
  // Covers the CREATION path ($createTypeFromElementNode -> $createSlotsYType)
  // specifically — the update path ($updateSlotsYType) has its own gate, and
  // missing either one re-opens the first-set race for hosts that sync before
  // their first slot is set.
  test('a declared host serializes an eager empty slots map', () => {
    const {binding, editor} = buildBinding([DeclaredV2HostNode]);

    editor.update(
      () => {
        const host = $create(DeclaredV2HostNode);
        $getRoot().clear().append(host);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    expect(slotsY.size).toBe(0);
  });

  // Order is derived, never stored: the slots Y.Map carries no order
  // metadata, and the restore path funnels every entry through $setSlot,
  // which re-canonicalizes — so a map whose entries were inserted in reverse
  // declared order still restores to the declared order.
  test('restore applies canonical order regardless of Y.Map insertion order', () => {
    const {binding, doc, editor} = buildBinding([
      DeclaredV2HostNode,
      TestShadowRootNode,
    ]);

    editor.update(
      () => {
        const host = $create(DeclaredV2HostNode);
        const caption = $createTestShadowRootNode();
        caption.append(
          $createParagraphNode().append($createTextNode('Caption')),
        );
        $getRoot().clear().append(host);
        $setSlot(host, 'caption', caption);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const hostY = binding.root.toArray()[0];
    assert(hostY instanceof XmlElement);
    const slotsY = hostY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsY instanceof YMap);
    // hand-add 'title' after 'caption' so the Y.Map receives its entries in
    // REVERSE declared order. The value is a registered shadow-root type
    // wrapping a paragraph + text, the shape setSlot accepts on restore.
    doc.transact(() => {
      const title = new XmlElement('test_shadow_root');
      const titlePara = new XmlElement('paragraph');
      const titleText = new XmlText();
      titlePara.insert(0, [titleText]);
      titleText.insert(0, 'Title');
      title.insert(0, [titlePara]);
      (slotsY as YMap<XmlElement>).set('title', title);
    });
    expect(Array.from(slotsY.keys())).toEqual(['caption', 'title']);

    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc, [
      DeclaredV2HostNode,
      TestShadowRootNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(binding2.root, binding2, null, true);
      },
      {discrete: true},
    );

    editor2.read(() => {
      const hostR = $getRoot().getFirstChild();
      assert(hostR instanceof DeclaredV2HostNode);
      // declared order, not the Y.Map's insertion order
      expect($getSlotNames(hostR)).toEqual(['title', 'caption']);
      expect($getSlot(hostR, 'title')?.getTextContent()).toBe('Title');
      expect($getSlot(hostR, 'caption')?.getTextContent()).toBe('Caption');
    });
  });

  // $setSlot has move semantics, so a value can move between hosts in one
  // update. Over collab the incremental diff runs the *removal* side on the
  // losing host (which destroys the moved value's collab node) and the *add*
  // side on the gaining host in the same serialize pass — exercise that path
  // and confirm a peer restoring from the post-move doc converges: the value
  // ends up under the new host, gone from the old, never duplicated or lost.
  test('moving a slot value between hosts converges on a peer', () => {
    const {binding, doc, editor} = buildBinding([TestShadowRootNode]);

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
    serialize(editor, binding); // initial diff: A gains the slot

    editor.update(
      () => {
        const hostA = $getRoot().getFirstChild();
        const hostB = $getRoot().getLastChild();
        assert($isElementNode(hostA) && $isElementNode(hostB));
        const title = $getSlot(hostA, 'title');
        assert(title !== null);
        $setSlot(hostB, 'title', title); // move A -> B
      },
      {discrete: true},
    );
    serialize(editor, binding); // incremental diff: A removes (+destroy), B adds

    // local convergence first
    editor.read(() => {
      const hostA = $getRoot().getFirstChild();
      const hostB = $getRoot().getLastChild();
      assert($isElementNode(hostA) && $isElementNode(hostB));
      expect($getSlotNames(hostA)).toEqual([]);
      expect($getSlot(hostB, 'title')?.getTextContent()).toBe('MovedTitle');
    });

    // the post-move Y doc is well-formed: A's slots Y.Map is empty/absent and
    // B's holds the value exactly once
    const hostAY = binding.root.toArray()[0];
    const hostBY = binding.root.toArray()[1];
    assert(hostAY instanceof XmlElement && hostBY instanceof XmlElement);
    const slotsAY = hostAY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    if (slotsAY instanceof YMap) {
      expect(Array.from(slotsAY.keys())).toEqual([]);
    }
    const slotsBY = hostBY.getAttribute(SLOTS_ATTR_KEY) as unknown;
    assert(slotsBY instanceof YMap);
    expect(Array.from(slotsBY.keys())).toEqual(['title']);

    // a peer restoring from the post-move doc converges
    const {binding: binding2, editor: editor2} = buildRestoreBinding(doc, [
      TestShadowRootNode,
    ]);
    editor2.update(
      () => {
        $getRoot().clear();
        $createOrUpdateNodeFromYElement(binding2.root, binding2, null, true);
      },
      {discrete: true},
    );

    editor2.read(() => {
      const hostA = $getRoot().getFirstChild();
      const hostB = $getRoot().getLastChild();
      assert($isElementNode(hostA) && $isElementNode(hostB));
      expect($getSlotNames(hostA)).toEqual([]);
      const titleR = $getSlot(hostB, 'title');
      assert(titleR !== null && $isElementNode(titleR));
      expect(titleR.getTextContent()).toBe('MovedTitle');
      expect(titleR.getParent()).toBe(null);
    });
  });
});
