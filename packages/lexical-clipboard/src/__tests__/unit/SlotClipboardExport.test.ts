/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $generateJSONFromSelectedNodes,
  $generateNodesFromSerializedNodes,
  $insertGeneratedNodes,
  type BaseSerializedNode,
} from '@lexical/clipboard';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import {
  $create,
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $isTextNode,
  $setSelection,
  $setSlot,
  defineExtension,
  ElementNode,
  type SerializedElementNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

// A plain shadow-root ElementNode used as a slot value for the positive
// round-trip test. Mirrors the production playground's slot-value shape
// (shadow-root container holding regular block content) without the
// excludeFromCopy override that ExcludedShadowRootNode adds.
class PlainShadowRootNode extends ElementNode {
  $config() {
    return this.config('plain_shadow_root', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
}

function $createPlainShadowRootNode(): PlainShadowRootNode {
  return $create(PlainShadowRootNode);
}

// A shadow-root slot value that also excludes itself from copy — an
// unsupported combination the export guard must reject loudly instead of
// emitting a dangling slot entry that breaks on paste.
class ExcludedShadowRootNode extends ElementNode {
  $config() {
    return this.config('excluded_shadow_root', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
  excludeFromCopy(): boolean {
    return true;
  }
}

function $createExcludedShadowRootNode(): ExcludedShadowRootNode {
  return $create(ExcludedShadowRootNode);
}

// A Card-shaped host: shadow root that opts in to whole-host child export
// when selected via NodeSelection. Used to pin that the opt-in does NOT
// promote partial RangeSelections.
class CardLikeNode extends ElementNode {
  $config() {
    return this.config('card_like', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
}

function $createCardLikeNode(): CardLikeNode {
  return $create(CardLikeNode);
}

describe('slot clipboard export', () => {
  test('throws when a slot value is excluded from copy', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-exclude]',
        nodes: [ExcludedShadowRootNode],
      }),
    );
    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        $setSlot(host, 'title', $createExcludedShadowRootNode());
      },
      {discrete: true},
    );
    editor.read(() => {
      expect(() => $generateJSONFromSelectedNodes(editor, null)).toThrow(
        /did not serialize to exactly the slot value node/,
      );
    });
  });

  test('a host outside the selection does not gate the export on its slot', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-exclude]',
        nodes: [ExcludedShadowRootNode],
      }),
    );
    let beforeKey = '';
    editor.update(
      () => {
        const before = $createTextNode('BEFORE');
        $getRoot().append($createParagraphNode().append(before));
        const host = $createParagraphNode();
        host.append($createTextNode('CHILD'));
        $setSlot(host, 'title', $createExcludedShadowRootNode());
        $getRoot().append(host);
        beforeKey = before.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const before = $getNodeByKey(beforeKey);
        assert(before !== null && $isTextNode(before));
        before.select(0, 6);
      },
      {discrete: true},
    );
    editor.read(() => {
      // The selection covers only "BEFORE"; the slot-bearing host is outside
      // it, so its excluded slot must not be reached and must not throw.
      expect(() =>
        $generateJSONFromSelectedNodes(editor, $getSelection()),
      ).not.toThrow();
    });
  });

  // Positive round-trip: a slot-bearing host (host + named slot whose value is
  // a shadow-root ElementNode holding regular content) serializes through
  // $generateJSONFromSelectedNodes and restores via
  // $generateNodesFromSerializedNodes + $insertGeneratedNodes with the slot
  // name and slot subtree text preserved.
  test('a slot-bearing host round-trips through JSON copy + insert', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-roundtrip]',
        nodes: [PlainShadowRootNode],
      }),
    );
    editor.update(
      () => {
        const host = $createParagraphNode();
        host.append($createTextNode('HostChild'));
        const slot = $createPlainShadowRootNode();
        slot.append($createParagraphNode().append($createTextNode('SlotText')));
        $getRoot().append(host);
        $setSlot(host, 'media', slot);
      },
      {discrete: true},
    );

    // Copy: null selection → whole tree.
    let serialized: {namespace: string; nodes: BaseSerializedNode[]};
    editor.read(() => {
      serialized = $generateJSONFromSelectedNodes(editor, null);
    });
    expect(serialized!.nodes).toHaveLength(1);
    const hostJson = serialized!.nodes[0] as SerializedElementNode & {
      $slots?: Record<string, SerializedElementNode>;
    };
    expect(hostJson.$slots).toBeDefined();
    expect(hostJson.$slots!.media).toBeDefined();

    // Paste into a fresh editor and verify the slot survived.
    using editor2 = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-roundtrip]',
        nodes: [PlainShadowRootNode],
      }),
    );
    editor2.update(
      () => {
        const target = $createParagraphNode();
        $getRoot().append(target);
        target.select();
        const nodes = $generateNodesFromSerializedNodes(serialized!.nodes);
        $insertGeneratedNodes(editor2, nodes, $getSelection()!);
      },
      {discrete: true},
    );

    editor2.read(() => {
      const inserted = $getRoot()
        .getChildren()
        .find(n => $getSlotNames(n).length > 0);
      expect(inserted).toBeDefined();
      expect($getSlotNames(inserted!)).toEqual(['media']);
      const slot = $getSlot(inserted!, 'media');
      expect(slot).not.toBeNull();
      expect(slot!.getTextContent()).toContain('SlotText');
      // The slot up-link must point back to the inserted host (not the
      // original copy-side host whose key may not exist in this editor).
      expect($getSlotHost(slot!)!.is(inserted!)).toBe(true);
    });
  });

  // A RangeSelection wholly inside a slot never contains the host, so the
  // exporters must walk the selection's slot frame instead of only the root —
  // otherwise copy returns an empty payload and cut is silent data loss.
  test('a selection inside a slot exports its content on both channels', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-inner-copy]',
        nodes: [PlainShadowRootNode],
      }),
    );
    let slotTextKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        host.append($createTextNode('HostChild'));
        const slot = $createPlainShadowRootNode();
        const slotText = $createTextNode('SlotText');
        slot.append($createParagraphNode().append(slotText));
        $getRoot().append(host);
        $setSlot(host, 'media', slot);
        slotTextKey = slotText.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const slotText = $getNodeByKey(slotTextKey);
        assert(slotText !== null && $isTextNode(slotText));
        slotText.select(0, 'SlotText'.length);
      },
      {discrete: true},
    );
    editor.read(() => {
      const selection = $getSelection();
      const json = $generateJSONFromSelectedNodes(editor, selection);
      expect(JSON.stringify(json.nodes)).toContain('SlotText');
      // The host (and its unselected child) stays out of an in-slot copy.
      expect(JSON.stringify(json.nodes)).not.toContain('HostChild');
      const html = $generateHtmlFromNodes(editor, selection);
      expect(html).toContain('SlotText');
      expect(html).not.toContain('HostChild');
    });
  });

  // Whole-host child inclusion applies only to NodeSelection; a
  // partial RangeSelection that happens to contain the host must keep
  // slicing per child or a drag into the host over-exports content the user
  // never selected.
  test('a partial range over an element host does not over-export', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-partial-range]',
        nodes: [CardLikeNode, PlainShadowRootNode],
      }),
    );
    let introTextKey = '';
    let bodyTextKey = '';
    editor.update(
      () => {
        const intro = $createTextNode('Intro');
        $getRoot().append($createParagraphNode().append(intro));
        const card = $createCardLikeNode();
        const bodyText = $createTextNode('Body');
        card.append($createParagraphNode().append(bodyText));
        card.append(
          $createParagraphNode().append($createTextNode('UNSELECTED')),
        );
        const title = $createPlainShadowRootNode();
        title.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().append(card);
        $setSlot(card, 'title', title);
        introTextKey = intro.getKey();
        bodyTextKey = bodyText.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const selection = $createRangeSelection();
        selection.anchor.set(introTextKey, 0, 'text');
        selection.focus.set(bodyTextKey, 2, 'text');
        $setSelection(selection);
      },
      {discrete: true},
    );
    editor.read(() => {
      const selection = $getSelection();
      const json = JSON.stringify(
        $generateJSONFromSelectedNodes(editor, selection).nodes,
      );
      expect(json).toContain('Intro');
      expect(json).toContain('"Bo"');
      expect(json).not.toContain('"Body"');
      expect(json).not.toContain('UNSELECTED');
      const html = $generateHtmlFromNodes(editor, selection);
      expect(html).toContain('Bo');
      expect(html).not.toContain('Body');
      expect(html).not.toContain('UNSELECTED');
    });
  });

  // Regression for meta/lexical#8712: the slot-frame redirect that lets
  // a selection inside a slot subtree export through its frame (instead of
  // root, which is shadow-isolated from the slot) only ran for
  // RangeSelection. A NodeSelection on a node nested inside a slot
  // resolved to a null frame, the root-children walk missed the selected
  // node, and the export produced `{nodes: []}` — empty clipboard, cut =
  // silent data loss. Now anchors the frame redirect on the first selected
  // node when the selection is a NodeSelection.
  test('a NodeSelection on a node inside a slot exports the node, not an empty list', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-node-selection]',
        nodes: [PlainShadowRootNode],
      }),
    );
    let innerParaKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $createPlainShadowRootNode();
        const innerPara = $createParagraphNode().append(
          $createTextNode('SlotNodeTarget'),
        );
        slot.append(innerPara);
        $setSlot(host, 'media', slot);
        $getRoot().append(host);
        innerParaKey = innerPara.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const innerPara = $getNodeByKey(innerParaKey);
        assert(innerPara !== null);
        const nodeSelection = $createNodeSelection();
        nodeSelection.add(innerPara.getKey());
        $setSelection(nodeSelection);
      },
      {discrete: true},
    );
    editor.read(() => {
      const selection = $getSelection();
      const json = $generateJSONFromSelectedNodes(editor, selection);
      // Pre-fix: nodes.length === 0 and the cut path silently dropped the
      // selected node. Post-fix: the redirected walk through the slot's
      // frame finds the selected paragraph.
      expect(json.nodes.length).toBeGreaterThan(0);
      expect(JSON.stringify(json.nodes)).toContain('SlotNodeTarget');
    });
  });

  // The 0-children excluded case is covered above; with exactly one child the
  // child used to be spliced up and exported AS the slot value, silently
  // corrupting the payload. The guard must compare the exported type too.
  test('throws when a 1-child excluded slot value would export its child instead', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[slot-exclude-one-child]',
        nodes: [ExcludedShadowRootNode],
      }),
    );
    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        const slot = $createExcludedShadowRootNode();
        slot.append($createParagraphNode().append($createTextNode('inner')));
        $setSlot(host, 'title', slot);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect(() => $generateJSONFromSelectedNodes(editor, null)).toThrow(
        /did not serialize to exactly the slot value node/,
      );
    });
  });
});
