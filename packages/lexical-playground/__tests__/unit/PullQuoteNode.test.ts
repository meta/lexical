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
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
import {
  $create,
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $isParagraphNode,
  $isRangeSelection,
  $setSelection,
  $setSlot,
  defineExtension,
  type SerializedElementNode,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {
  $createSlotContainerNode,
  $isSlotContainerNode,
  SlotContainerNode,
} from '../../src/nodes/SlotContainerNode';
import {PullQuoteExtension} from '../../src/plugins/PullQuoteExtension';
import {
  $createPullQuoteNode,
  $isPullQuoteNode,
  PullQuoteNode,
} from '../../src/plugins/PullQuoteExtension/PullQuoteNode';

// PullQuoteExtension brings its own DOM import pipeline (CoreImportExtension +
// its import rule), so this single extension drives both the slot-mechanics and
// the HTML round-trip tests — using it alone verifies the extension is a
// self-contained importer.
const PullQuoteTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [PullQuoteExtension],
  name: '[test-pullquote]',
  nodes: [PullQuoteNode, SlotContainerNode],
});

describe('PullQuoteNode atomic decorator host', () => {
  it('holds a multi-block quote container and a bare-paragraph attribution', () => {
    using editor = buildEditorFromExtensions(PullQuoteTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createPullQuoteNode());
      },
      {discrete: true},
    );

    editor.read(() => {
      const pullquote = $getRoot().getFirstChild();
      assert(
        $isPullQuoteNode(pullquote),
        'Top-level node must be a PullQuoteNode',
      );
      expect($getSlotNames(pullquote)).toEqual(['quote', 'attribution']);

      // The quote is legitimately multi-block, so it keeps the shadow-root
      // SlotContainerNode wrapper.
      const quote = $getSlot(pullquote, 'quote');
      assert(
        $isSlotContainerNode(quote),
        'quote slot must be a SlotContainerNode',
      );
      expect(quote.isShadowRoot()).toBe(true);

      // The attribution is a single-line field: its value is a bare
      // ParagraphNode — the slot link itself is the virtual shadow root,
      // so no container wrapper is needed.
      const attribution = $getSlot(pullquote, 'attribution');
      assert(
        $isParagraphNode(attribution),
        'attribution slot value must be a bare ParagraphNode',
      );
      const text = attribution.getFirstChild();
      assert(text !== null, 'attribution paragraph must hold the seed text');
      expect(text.getTopLevelElement()).toBe(attribution);
    });
  });

  // Pins the shallower serialized shape: `$slots.attribution` IS the
  // paragraph (no intermediary container level), while `$slots.quote` keeps
  // its multi-block container.
  it('serializes the attribution slot as a bare paragraph (no container level)', () => {
    using editor = buildEditorFromExtensions(PullQuoteTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createPullQuoteNode());
      },
      {discrete: true},
    );

    const json = editor.getEditorState().toJSON();
    const pullquoteJson = json.root.children[0];
    expect(pullquoteJson.type).toBe('pullquote');
    const attribution = pullquoteJson.$slots?.attribution as
      | SerializedElementNode
      | undefined;
    assert(
      attribution !== undefined,
      'PullQuote JSON must carry the attribution slot',
    );
    expect(attribution.type).toBe('paragraph');
    expect(attribution.children.map(child => child.type)).toEqual(['text']);
    expect(pullquoteJson.$slots?.quote.type).toBe('slot-container');
  });

  it('canonicalizes slots set in reverse to the declared order', () => {
    using editor = buildEditorFromExtensions(PullQuoteTestExtension);

    editor.update(
      () => {
        const pullquote = $create(PullQuoteNode);
        $getRoot().clear().append(pullquote);
        // Reverse of the declaration: attribution first, then quote.
        $setSlot(
          pullquote,
          'attribution',
          $createSlotContainerNode().append(
            $createParagraphNode().append($createTextNode('Author')),
          ),
        );
        $setSlot(
          pullquote,
          'quote',
          $createSlotContainerNode().append(
            $createParagraphNode().append($createTextNode('Quote')),
          ),
        );
      },
      {discrete: true},
    );

    editor.read(() => {
      const pullquote = $getRoot().getFirstChild();
      assert($isPullQuoteNode(pullquote), 'host must be a PullQuoteNode');
      // The declaration (quote, attribution) wins over both the call order
      // and code-unit order ('attribution' < 'quote').
      expect($getSlotNames(pullquote)).toEqual(['quote', 'attribution']);
      expect($getSlot(pullquote, 'quote')?.getTextContent()).toBe('Quote');
      expect($getSlot(pullquote, 'attribution')?.getTextContent()).toBe(
        'Author',
      );
    });
  });

  it('links both slot values to the host without making them children', () => {
    using editor = buildEditorFromExtensions(PullQuoteTestExtension);

    editor.update(
      () => {
        $getRoot().clear().append($createPullQuoteNode());
      },
      {discrete: true},
    );

    editor.read(() => {
      const pullquote = $getRoot().getFirstChild();
      assert($isPullQuoteNode(pullquote), 'host must be a PullQuoteNode');
      for (const name of $getSlotNames(pullquote)) {
        const value = $getSlot(pullquote, name);
        assert(value !== null, `slot ${name} must have a value`);
        // Slot invariant: parent === null and slotHost === pullquote, so
        // the value never appears in the host's child list. The host is a
        // DecoratorNode (no children channel), so this is enforced
        // structurally too.
        expect(value.getParent()).toBe(null);
        expect($getSlotHost(value)).toBe(pullquote);
      }
    });
  });

  it('round-trips both slots through clipboard copy -> paste', () => {
    using editor = buildEditorFromExtensions(PullQuoteTestExtension);

    let exported: ReturnType<typeof $generateJSONFromSelectedNodes>;
    editor.update(
      () => {
        const pullquote = $createPullQuoteNode();
        $getRoot().clear().append(pullquote);
        const selection = $createNodeSelection();
        selection.add(pullquote.getKey());
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
      const pullquote = $getRoot().getFirstChild();
      assert(
        $isPullQuoteNode(pullquote),
        'Pasted top-level node must be a PullQuoteNode',
      );
      expect($getSlotNames(pullquote)).toEqual(['quote', 'attribution']);
      const quote = $getSlot(pullquote, 'quote');
      assert($isSlotContainerNode(quote), 'quote slot preserved');
      const attribution = $getSlot(pullquote, 'attribution');
      assert(
        $isParagraphNode(attribution),
        'attribution slot preserved as a bare paragraph',
      );
      // Default seed text rides through JSON round-trip intact.
      expect(quote.getTextContent()).toContain('discover the limits');
      expect(attribution.getTextContent()).toBe('Arthur C. Clarke');
    });
  });

  it('round-trips through HTML export -> DOMImportExtension', () => {
    using editor = buildEditorFromExtensions(PullQuoteTestExtension);

    editor.update(
      () => {
        const pullquote = $createPullQuoteNode();
        $getRoot().clear().append(pullquote);
        // Mutate both slots away from the default seed so the round-trip
        // assertion actually validates the import path (if the import
        // silently fell back to the seed, these assertions would fail).
        const quote = $getSlot(pullquote, 'quote');
        assert($isSlotContainerNode(quote), 'quote seed exists');
        quote
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('CUSTOM QUOTE')),
          );
        // The attribution value is the line itself: replace its inline
        // content directly.
        const attribution = $getSlot(pullquote, 'attribution');
        assert($isParagraphNode(attribution), 'attribution seed exists');
        attribution.clear().append($createTextNode('CUSTOM AUTHOR'));
      },
      {discrete: true},
    );
    const html = editor.read(() => $generateHtmlFromNodes(editor, null));

    expect(html).toContain('lexical-pullquote-node');
    expect(html).toContain('data-lexical-slot="quote"');
    expect(html).toContain('data-lexical-slot="attribution"');

    editor.update(
      () => {
        $getRoot().clear().select();
        const dom = new DOMParser().parseFromString(html, 'text/html');
        $getRoot().append(...$generateNodesFromDOMViaExtension(dom));
      },
      {discrete: true},
    );

    editor.read(() => {
      const pullquote = $getRoot().getFirstChild();
      assert(
        $isPullQuoteNode(pullquote),
        'Imported top-level node must be a PullQuoteNode',
      );
      const quote = $getSlot(pullquote, 'quote');
      assert($isSlotContainerNode(quote), 'quote slot rebuilt');
      const attribution = $getSlot(pullquote, 'attribution');
      assert(
        $isParagraphNode(attribution),
        'attribution slot rebuilt as a bare paragraph',
      );
      expect(quote.getTextContent()).toBe('CUSTOM QUOTE');
      expect(attribution.getTextContent()).toBe('CUSTOM AUTHOR');
    });
  });

  // Missing-slot HTML must NOT inherit the default seed text from
  // `$createPullQuoteNode`. The import rule clears both slots before walking
  // the HTML, so a fragment that only carries `quote` arrives with an empty
  // attribution slot, not "Arthur C. Clarke" silently fabricated.
  it('does not leak default seed into missing slots on import', () => {
    using editor = buildEditorFromExtensions(PullQuoteTestExtension);

    const onlyQuoteHtml =
      '<div class="lexical-pullquote-node">' +
      '<div data-lexical-slot="quote"><p>Only the quote</p></div>' +
      '</div>';

    editor.update(
      () => {
        $getRoot().clear().select();
        const dom = new DOMParser().parseFromString(onlyQuoteHtml, 'text/html');
        $getRoot().append(...$generateNodesFromDOMViaExtension(dom));
      },
      {discrete: true},
    );

    editor.read(() => {
      const pullquote = $getRoot().getFirstChild();
      assert($isPullQuoteNode(pullquote), 'host imported');
      const quote = $getSlot(pullquote, 'quote');
      assert($isSlotContainerNode(quote), 'quote slot rebuilt');
      expect(quote.getTextContent()).toBe('Only the quote');
      const attribution = $getSlot(pullquote, 'attribution');
      assert(
        $isParagraphNode(attribution) && attribution.isEmpty(),
        'attribution slot rebuilt',
      );
    });
  });

  // The host is a DecoratorNode with no children channel, so direct children
  // that aren't slot wrappers cannot ride along as body content — they land
  // in the quote slot (created on demand) instead of being dropped into a
  // dead zero-slot block.
  it('imports non-slot children into the quote slot instead of dropping them', () => {
    using editor = buildEditorFromExtensions(PullQuoteTestExtension);

    const bareChildHtml =
      '<div class="lexical-pullquote-node"><p>hello</p></div>';

    editor.update(
      () => {
        $getRoot().clear().select();
        const dom = new DOMParser().parseFromString(bareChildHtml, 'text/html');
        $getRoot().append(...$generateNodesFromDOMViaExtension(dom));
      },
      {discrete: true},
    );

    editor.read(() => {
      const pullquote = $getRoot().getFirstChild();
      assert($isPullQuoteNode(pullquote), 'host imported');
      const quote = $getSlot(pullquote, 'quote');
      assert($isSlotContainerNode(quote), 'quote slot created on demand');
      expect(quote.getTextContent()).toBe('hello');
      const attribution = $getSlot(pullquote, 'attribution');
      // No attribution in the HTML, so none is fabricated.
      assert(
        $isParagraphNode(attribution) && attribution.isEmpty(),
        'attribution should be empty',
      );
    });
  });

  // Non-slot children that follow a quote wrapper append into the same quote
  // slot after the wrapper's own content.
  it('appends trailing non-slot children after the imported quote content', () => {
    using editor = buildEditorFromExtensions(PullQuoteTestExtension);

    const mixedHtml =
      '<div class="lexical-pullquote-node">' +
      '<div data-lexical-slot="quote"><p>Quoted</p></div>' +
      '<p>loose</p>' +
      '</div>';

    editor.update(
      () => {
        $getRoot().clear().select();
        const dom = new DOMParser().parseFromString(mixedHtml, 'text/html');
        $getRoot().append(...$generateNodesFromDOMViaExtension(dom));
      },
      {discrete: true},
    );

    editor.read(() => {
      const pullquote = $getRoot().getFirstChild();
      assert($isPullQuoteNode(pullquote), 'host imported');
      const quote = $getSlot(pullquote, 'quote');
      assert($isSlotContainerNode(quote), 'quote slot rebuilt');
      expect(quote.getChildren().map(child => child.getTextContent())).toEqual([
        'Quoted',
        'loose',
      ]);
    });
  });

  // Regression test for #9095: pasting a PullQuote (a block-level
  // DecoratorNode) with the caret at the end of a paragraph used to leave a
  // stray empty paragraph after it, because the insertNodes cleanup only
  // handled an ElementNode as the last inserted block.
  it('pastes at the end of a paragraph without leaving an empty paragraph', () => {
    using editor = buildEditorFromExtensions(PullQuoteTestExtension);

    editor.update(
      () => {
        const text = $createTextNode('hello');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(5, 5);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.insertNodes([$createPullQuoteNode()]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      assert($isParagraphNode(children[0]), 'paragraph keeps its place');
      expect(children[0].getTextContent()).toBe('hello');
      assert($isPullQuoteNode(children[1]), 'pullquote is the last child');
    });
  });
});
