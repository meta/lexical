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
} from '@lexical/clipboard';
import {
  $defaultShouldInsertAfter,
  buildEditorFromExtensions,
} from '@lexical/extension';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
import {
  $createNodeSelection,
  $createTextNode,
  $getNearestRootOrShadowRoot,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $isElementNode,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  $selectAll,
  $setSelection,
  CLICK_COMMAND,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  KEY_TAB_COMMAND,
  type SerializedElementNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, it} from 'vitest';

import {CardExtension} from '../../src/plugins/CardExtension';
import {
  $createCardNode,
  $isCardNode,
  CardNode,
} from '../../src/plugins/CardExtension/CardNode';

// SlotContainerNode is deliberately NOT registered: the Card's single-line
// title slot value is a bare ParagraphNode (the slot link itself is the
// virtual shadow root), so no Card code path may construct a container —
// registering one here would let such a regression pass silently. CardExtension
// brings its own DOM import pipeline (CoreImportExtension + its import rule), so
// this same extension also drives the HTML round-trip tests below — using it
// alone verifies the extension is a self-contained importer.
const CardTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [CardExtension],
  name: '[test-card]',
  nodes: [CardNode],
});

// A Card with the demo "Title" / "Body" text typed in. The model seeds empty
// fields (the hints are CSS placeholders), so content tests populate it here.
function $createCardWithText(): CardNode {
  const card = $createCardNode();
  const title = $getSlot(card, 'title');
  assert($isParagraphNode(title), 'title slot must be a bare paragraph');
  title.append($createTextNode('Title'));
  const body = card.getChildren()[0];
  assert($isParagraphNode(body), 'body must be a paragraph');
  body.append($createTextNode('Body'));
  return card;
}

describe('CardNode named slots', () => {
  it('round-trips the title slot and body children through clipboard copy -> paste', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    let exported: ReturnType<typeof $generateJSONFromSelectedNodes>;
    editor.update(
      () => {
        const card = $createCardWithText();
        $getRoot().clear().append(card);
        const selection = $createNodeSelection();
        selection.add(card.getKey());
        $setSelection(selection);
        exported = $generateJSONFromSelectedNodes(editor, selection);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $getRoot().clear();
        const nodes = $generateNodesFromSerializedNodes(exported.nodes);
        $getRoot().append(...nodes);
      },
      {discrete: true},
    );

    editor.read(() => {
      const card = $getRoot().getFirstChild();
      assert($isCardNode(card), 'Pasted top-level node must be a CardNode');
      // Only `title` is a named slot; the body is regular children that go
      // through the normal child channel.
      expect($getSlotNames(card)).toEqual(['title']);
      expect($getSlot(card, 'title')?.getTextContent()).toBe('Title');
      expect(card.getChildren()[0]?.getTextContent()).toBe('Body');
    });
  });

  it('round-trips the title slot and body children through HTML export -> DOMImportExtension', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createCardWithText());
      },
      {discrete: true},
    );
    const html = editor.read(() => $generateHtmlFromNodes(editor, null));

    // The title slot rides in its own named wrapper; the body is regular
    // ElementNode children, so its paragraph serializes through the normal
    // child path with no slot wrapper.
    expect(html).toContain('data-lexical-slot="title"');
    expect(html).not.toContain('data-lexical-slot="body"');

    editor.update(
      () => {
        $getRoot().clear().select();
        const dom = new DOMParser().parseFromString(html, 'text/html');
        $getRoot().append(...$generateNodesFromDOMViaExtension(dom));
      },
      {discrete: true},
    );

    editor.read(() => {
      const card = $getRoot().getFirstChild();
      assert($isCardNode(card), 'Imported top-level node must be a CardNode');
      expect($getSlotNames(card)).toEqual(['title']);
      expect($getSlot(card, 'title')?.getTextContent()).toBe('Title');
      expect(card.getChildren()[0]?.getTextContent()).toBe('Body');
      // CardNode.exportDOM manually appends body children; if the outer
      // $appendNodesToHTML loop also recurses through `target.getChildren()`
      // (the default when no `$getChildNodes` is supplied), every body
      // paragraph is emitted twice and re-import doubles `Body`.
      expect(card.getChildrenSize()).toBe(1);
    });
  });

  // A whole-host NodeSelection of an element carries its children by
  // default, so the body rides along when the whole card is promoted. The
  // clipboard JSON path already does this; HTML export must too — both
  // formats are written to the clipboard, and external paste targets pick
  // text/html.
  it('keeps the body in HTML export when the Card is in a NodeSelection', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    let html = '';
    editor.update(
      () => {
        const card = $createCardWithText();
        $getRoot().clear().append(card);
        const selection = $createNodeSelection();
        selection.add(card.getKey());
        $setSelection(selection);
        html = $generateHtmlFromNodes(editor, selection);
      },
      {discrete: true},
    );

    expect(html).toContain('Title');
    // Body lives outside the selection (only the Card key was added). Without
    // whole-host child inclusion, the recursion forwards the NodeSelection
    // into each body child, none are selected, and the body text never
    // reaches the HTML.
    expect(html).toContain('Body');
  });

  // A Card div with no title wrapper must not resurrect the seeded "Title"
  // text: the title slot arrives with an empty paragraph, never content the
  // source HTML did not carry.
  it('does not fabricate the seeded title when importing a Card without a title wrapper', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    const noTitleHtml = '<div class="lexical-card-node"><p>Body only</p></div>';

    editor.update(
      () => {
        $getRoot().clear().select();
        const dom = new DOMParser().parseFromString(noTitleHtml, 'text/html');
        $getRoot().append(...$generateNodesFromDOMViaExtension(dom));
      },
      {discrete: true},
    );

    editor.read(() => {
      const card = $getRoot().getFirstChild();
      assert($isCardNode(card), 'Top-level node must be a CardNode');
      expect(card.getChildren()[0]?.getTextContent()).toBe('Body only');
      expect($getSlot(card, 'title')?.getTextContent()).toBe('');
    });
  });

  it('seeds the title slot with a bare paragraph value (no container wrapper)', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createCardWithText());
      },
      {discrete: true},
    );

    editor.read(() => {
      const card = $getRoot().getFirstChild();
      assert($isCardNode(card), 'Top-level node must be a CardNode');
      const slot = $getSlot(card, 'title');
      // The one-block slot's block IS the slotted element: a bare
      // ParagraphNode, no SlotContainerNode in between. The slot link
      // itself acts as the virtual shadow root that scopes selection,
      // editing, and traversal.
      assert(
        $isParagraphNode(slot),
        'Title slot value must be a bare ParagraphNode',
      );
      expect(slot.getParent()).toBe(null);
      expect($getSlotHost(slot)).toBe(card);
      // getTopLevelElement of the slot content stops at the value boundary
      // rather than walking to the editor root.
      const text = slot.getFirstChild();
      assert(text !== null, 'Title paragraph must hold the seeded text');
      expect(text.getTopLevelElement()).toBe(slot);
    });
  });

  // Pins the shallower serialized shape: `$slots.title` IS the paragraph,
  // with its inline content directly under it — no intermediary container
  // level in the JSON.
  it('serializes the title slot as a bare paragraph (no container level)', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createCardWithText());
      },
      {discrete: true},
    );

    const json = editor.getEditorState().toJSON();
    const cardJson = json.root.children[0];
    expect(cardJson.type).toBe('card');
    const title = cardJson.$slots?.title as SerializedElementNode | undefined;
    assert(title !== undefined, 'Card JSON must carry the title slot');
    expect(title.type).toBe('paragraph');
    expect(title.children.map(child => child.type)).toEqual(['text']);
  });

  it('SELECT_ALL inside a slot scopes to the slot value, not the root', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createCardWithText());
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const card = $getRoot().getFirstChild();
        assert($isCardNode(card), 'Top-level node must be a CardNode');
        const slot = $getSlot(card, 'title');
        assert($isParagraphNode(slot), 'title slot must be a bare paragraph');
        // Caret inside the slot, then SELECT_ALL with the current selection
        // (mirrors the rich-text SELECT_ALL handler passing the selection).
        const selection = slot.selectStart();
        const result = $selectAll(selection);
        // Scoped to the value: both ends stay inside the slot paragraph and
        // the selected text is just the title, never the body or root
        // content.
        const anchorNode = result.anchor.getNode();
        const focusNode = result.focus.getNode();
        expect(slot.is(anchorNode) || slot.isParentOf(anchorNode)).toBe(true);
        expect(slot.is(focusNode) || slot.isParentOf(focusNode)).toBe(true);
        expect(result.getTextContent()).toBe('Title');
      },
      {discrete: true},
    );
  });

  // Backspace at the start of the title is a no-op: the slot link is a
  // virtual shadow root, so deleteCharacter stops at the value's leading
  // edge instead of merging the bare paragraph into the host document
  // (the 'named-slots: block slot values' core suite pins the primitive).
  it('Backspace at slot start is a no-op at the virtual shadow boundary', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createCardWithText());
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const card = $getRoot().getFirstChild();
        assert($isCardNode(card), 'Top-level node must be a CardNode');
        const slot = $getSlot(card, 'title');
        assert($isParagraphNode(slot), 'title slot must be a bare paragraph');
        const selection = slot.selectStart();
        selection.deleteCharacter(true);
      },
      {discrete: true},
    );

    editor.read(() => {
      const card = $getRoot().getFirstChild();
      assert($isCardNode(card), 'Card must survive backspace at slot start');
      expect($getSlot(card, 'title')?.getTextContent()).toBe('Title');
      expect(card.getChildren()[0]?.getTextContent()).toBe('Body');
      // Nothing escaped into the root: the card is still the only child.
      expect($getRoot().getChildrenSize()).toBe(1);
    });
  });

  // A Card is a shadow root, so a caret placed between two of them renders a
  // block cursor rather than a text position. Backspace there has to delete
  // the Card it sits against — including its named slots — the same way it
  // deletes an adjacent block DecoratorNode (#8939).
  it.for([
    {isBackward: true, survivor: 'B'},
    {isBackward: false, survivor: 'A'},
  ])(
    'block cursor between two Cards deletes one (isBackward: $isBackward)',
    ({isBackward, survivor}) => {
      using editor = buildEditorFromExtensions(CardTestExtension);

      editor.update(
        () => {
          const a = $createCardNode();
          const b = $createCardNode();
          for (const [card, label] of [
            [a, 'A'],
            [b, 'B'],
          ] as const) {
            const title = $assertNodeType(
              $getSlot(card, 'title'),
              $isParagraphNode,
            );
            title.append($createTextNode(label));
          }
          $getRoot().clear().append(a, b);
          // The block cursor sits between the two Cards.
          $getRoot().select(1, 1);
        },
        {discrete: true},
      );

      editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection), 'Expected a RangeSelection');
          selection.deleteCharacter(isBackward);
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().getChildrenSize()).toBe(1);
        // The other Card must survive: the slot went with the deleted host,
        // and the survivor kept its own.
        const card = $assertNodeType($getRoot().getFirstChild(), $isCardNode);
        expect($getSlot(card, 'title')?.getTextContent()).toBe(survivor);
      });
    },
  );

  // Mid-text deletion inside the bare title value rides core's
  // deleteCharacter: $getNearestRootOrShadowRoot treats the slotted value as
  // its own scope root (the slot link is a virtual shadow root), so the
  // native modify() path works without a wrapper.
  it('mid-text deletion resolves its scope at the bare title value', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createCardWithText());
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const card = $getRoot().getFirstChild();
        assert($isCardNode(card), 'Top-level node must be a CardNode');
        const title = $getSlot(card, 'title');
        assert($isParagraphNode(title), 'title slot must be a bare paragraph');
        // The deletion path resolves its scope through
        // $getNearestRootOrShadowRoot, which must treat the slotted value as
        // its own scope root (virtual shadow root) instead of throwing on the
        // parentless walk. The deletion itself depends on the native
        // selection engine, so the character-level result is pinned by the
        // CardSlot e2e spec rather than jsdom.
        const text = title.getFirstChild();
        assert(text !== null);
        expect($getNearestRootOrShadowRoot(text).is(title)).toBe(true);
        expect($getNearestRootOrShadowRoot(title).is(title)).toBe(true);
        title.selectEnd();
      },
      {discrete: true},
    );

    expect(() =>
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true),
    ).not.toThrow();

    editor.read(() => {
      const card = $getRoot().getFirstChild();
      assert($isCardNode(card), 'Card must survive mid-text backspace');
      // structure intact: nothing merged across or escaped the boundary
      expect(card.getChildren()[0]?.getTextContent()).toBe('Body');
      expect($getRoot().getChildrenSize()).toBe(1);
    });
  });

  // The Tab handler is the first real consumer of $getSlotNameWithinHost —
  // it walks the caret's ancestors to determine whether the caret sits in
  // the title slot or in the body children, and picks the destination
  // accordingly. These two cases pin both directions.
  it('Tab from the title slot moves the caret into the body', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createCardWithText());
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const card = $getRoot().getFirstChild();
        assert($isCardNode(card), 'Top-level node must be a CardNode');
        // The title's caret block IS the slot value: a bare paragraph.
        const titleSlot = $getSlot(card, 'title');
        assert($isParagraphNode(titleSlot), 'title slot must be a paragraph');
        titleSlot.selectEnd();
      },
      {discrete: true},
    );

    editor.dispatchCommand(
      KEY_TAB_COMMAND,
      new KeyboardEvent('keydown', {key: 'Tab'}),
    );

    editor.read(() => {
      const card = $getRoot().getFirstChild();
      assert($isCardNode(card), 'CardNode must survive Tab');
      const bodyFirst = card.getChildren()[0];
      assert($isElementNode(bodyFirst), 'Body must hold a paragraph after Tab');
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Tab must leave a RangeSelection');
      // Caret landed inside the body's first paragraph.
      expect(bodyFirst.isParentOf(selection.anchor.getNode())).toBe(true);
    });
  });

  it('Shift+Tab from the body moves the caret into the title slot', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createCardWithText());
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const card = $getRoot().getFirstChild();
        assert($isCardNode(card), 'Top-level node must be a CardNode');
        const bodyFirst = card.getChildren()[0];
        assert($isElementNode(bodyFirst), 'Body must hold a paragraph');
        bodyFirst.selectStart();
      },
      {discrete: true},
    );

    editor.dispatchCommand(
      KEY_TAB_COMMAND,
      new KeyboardEvent('keydown', {key: 'Tab', shiftKey: true}),
    );

    editor.read(() => {
      const card = $getRoot().getFirstChild();
      assert($isCardNode(card), 'CardNode must survive Shift+Tab');
      const titleSlot = $getSlot(card, 'title');
      assert($isElementNode(titleSlot), 'title slot must be an element');
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Shift+Tab must leave a selection');
      // Caret landed inside the title slot.
      expect(titleSlot.isParentOf(selection.anchor.getNode())).toBe(true);
    });
  });

  // Tab at the end of the title with no element body child must seed an
  // empty body paragraph and move the caret into it — falling through would
  // hand Tab to the rich-text indent default, which indents the title
  // paragraph instead of bridging.
  it('Tab from the title seeds an empty body paragraph when none exists', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    editor.update(
      () => {
        // Strip the seeded body so the Card has no element child.
        const card = $createCardNode().clear();
        $getRoot().clear().append(card);
        // The title's caret block IS the slot value: a bare paragraph.
        const titleSlot = $getSlot(card, 'title');
        assert($isParagraphNode(titleSlot), 'title slot must be a paragraph');
        titleSlot.selectEnd();
      },
      {discrete: true},
    );

    editor.dispatchCommand(
      KEY_TAB_COMMAND,
      new KeyboardEvent('keydown', {key: 'Tab'}),
    );

    editor.read(() => {
      const card = $getRoot().getFirstChild();
      assert($isCardNode(card), 'CardNode must survive Tab');
      const bodyFirst = card.getChildren()[0];
      assert($isElementNode(bodyFirst), 'Tab must seed a body paragraph');
      expect(bodyFirst.getTextContent()).toBe('');
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Tab must leave a RangeSelection');
      // The caret moved into the seeded paragraph — Tab was not swallowed.
      const anchorNode = selection.anchor.getNode();
      expect(bodyFirst.is(anchorNode) || bodyFirst.isParentOf(anchorNode)).toBe(
        true,
      );
      // The title was not indented.
      const titleSlot = $getSlot(card, 'title');
      assert($isParagraphNode(titleSlot), 'title slot must be a paragraph');
      expect(titleSlot.getIndent()).toBe(0);
    });
  });

  // CardExtension deliberately ships no ClickAfterLastBlockExtension
  // override: CardNode.isShadowRoot() is true, so the default predicate
  // already inserts a paragraph below a trailing Card. An override would
  // also clobber the other contributors' predicate terms, because that
  // extension merges config last-wins.
  it('$defaultShouldInsertAfter matches a CardNode without an override', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createCardNode());
      },
      {discrete: true},
    );

    editor.read(() => {
      const card = $getRoot().getFirstChild();
      assert($isCardNode(card), 'Top-level node must be a CardNode');
      expect($defaultShouldInsertAfter(card)).toBe(true);
    });
  });

  // The reconciler mounts each slot inside a `<div data-lexical-slot="...">`
  // scaffold wrapper that carries no `__lexicalKey_*`. The playground CSS gives
  // that wrapper a padding / border / ::before "TITLE" label, so any click on
  // the visible label or the surrounding padding lands on the keyless wrapper.
  // `$getNearestNodeFromDOMNode` then walks past it to the CardNode, and the
  // CLICK_COMMAND promoted the click to a whole-Card NodeSelection — exactly
  // the case `$resolveCardChromeTarget` was supposed to skip.
  it('clicking the title slot wrapper does not promote to a whole-Card NodeSelection', () => {
    using editor = buildEditorFromExtensions(CardTestExtension);
    const container = document.createElement('div');
    document.body.appendChild(container);
    editor.setRootElement(container);

    editor.update(
      () => {
        $getRoot().clear().append($createCardNode());
      },
      {discrete: true},
    );

    const wrapper = container.querySelector('[data-lexical-slot="title"]');
    assert(
      wrapper instanceof HTMLElement,
      'Reconciler must have mounted the title slot scaffold wrapper',
    );

    const event = new MouseEvent('click', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'target', {value: wrapper});
    editor.dispatchCommand(CLICK_COMMAND, event);

    editor.read(() => {
      const selection = $getSelection();
      // Without the slot-wrapper guard, this is a NodeSelection containing
      // the Card key. With the guard, the click falls through and the
      // selection stays whatever the caller set (here, null since the
      // Card was just inserted without a starting selection).
      expect($isNodeSelection(selection)).toBe(false);
    });

    container.remove();
  });
});
