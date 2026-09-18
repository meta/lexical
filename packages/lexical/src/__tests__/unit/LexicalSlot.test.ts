/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {GetStaticNodeOwnConfig} from '../../LexicalNode';

import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {domOverride, DOMRenderExtension} from '@lexical/html';
import {
  $create,
  $createLineBreakNode,
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getChildCaret,
  $getDOMSlot,
  $getNearestRootOrShadowRoot,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getSelectionSlotFrame,
  $getSlot,
  $getSlotFrame,
  $getSlotHost,
  $getSlotNames,
  $getSlotNameWithinHost,
  $isElementNode,
  $isLineBreakNode,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isSlotHost,
  $isTextNode,
  $removeSlot,
  $selectAll,
  $setSelection,
  $setSlot,
  configExtension,
  defineExtension,
  ElementNode,
  getDOMSelection,
  mountSlotContainer,
  type ParagraphNode,
  type SlotName,
  type TextNode,
  unmountSlotContainer,
} from 'lexical';
import {afterEach, assert, describe, expect, expectTypeOf, test} from 'vitest';

import {$internalCreateRangeSelection} from '../../LexicalSelection';
import {$getSlotContainer} from '../../LexicalUtils';
import {
  $assertNodeType,
  $createTestDecoratorNode,
  $createTestInlineElementNode,
  $createTestShadowRootNode,
  $isTestShadowRootNode,
  $isTestUpdateDOMTrueHostNode,
  TestDecoratorNode,
  TestInlineElementNode,
  TestShadowRootNode,
  TestUpdateDOMTrueHostNode,
} from '../utils';

// A slot value may be any non-inline block — the slot link itself is the
// virtual shadow root (see $setSlot). These suites use the multi-block value
// shape: a shadow-root container holding one paragraph per text, wrapped by
// $slotContainer so the slot-mechanism assertions stay focused on the slot,
// not the nesting. The bare-block (single-line) value shape has its own
// suite below ('block slot values').
function $slotContainer(...texts: string[]): TestShadowRootNode {
  const container = $createTestShadowRootNode();
  for (const text of texts) {
    container.append($createParagraphNode().append($createTextNode(text)));
  }
  return container;
}

// Host with a canonical slot declaration: 'title' renders ahead of 'body'
// even though code-unit order would flip them.
class DeclaredHostNode extends ElementNode {
  $config() {
    return this.config('declared_slot_host', {
      extends: ElementNode,
      slots: ['title', 'body'],
    });
  }
  createDOM() {
    return document.createElement('div');
  }
  updateDOM() {
    return false;
  }
}

// Subclass redeclaration: the nearest declaration in the prototype chain wins,
// so this host flips the inherited ['title', 'body'] order.
class ReorderedHostNode extends DeclaredHostNode {
  $config() {
    return this.config('reordered_slot_host', {
      extends: DeclaredHostNode,
      slots: ['body', 'title'],
    });
  }
}

// Invalid declarations. The rank is computed lazily — only when a $setSlot
// leaves the host's map with 2+ entries does the canonical order become
// observable — so registering these classes (and a first set) must not throw.
class DupDeclaredHostNode extends ElementNode {
  $config() {
    return this.config('dup_declared_slot_host', {
      extends: ElementNode,
      slots: ['x', 'x'],
    });
  }
  createDOM() {
    return document.createElement('div');
  }
  updateDOM() {
    return false;
  }
}

class ReservedDeclaredHostNode extends ElementNode {
  $config() {
    return this.config('reserved_declared_slot_host', {
      extends: ElementNode,
      slots: ['__proto__'],
    });
  }
  createDOM() {
    return document.createElement('div');
  }
  updateDOM() {
    return false;
  }
}

class WrappedSlotHostNode extends ElementNode {
  $config() {
    return this.config('wrapped_slot_host', {
      extends: ElementNode,
      slots: ['title'],
    });
  }
  createDOM() {
    const host = document.createElement('div');
    const content = document.createElement('span');
    content.dataset.content = 'true';
    host.appendChild(content);
    return host;
  }
  updateDOM() {
    return false;
  }
  getDOMSlot(dom: HTMLElement) {
    return super
      .getDOMSlot(dom)
      .withElement(dom.querySelector<HTMLElement>('[data-content]') ?? dom);
  }
}

const mountedRoots: HTMLElement[] = [];
afterEach(() => {
  while (mountedRoots.length > 0) {
    const node = mountedRoots.pop();
    if (node && node.parentNode) {
      node.parentNode.removeChild(node);
    }
  }
});

function createSlotEditor(): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(
    defineExtension({
      // start from an empty root, matching a bare unit-test editor; the
      // default extension state seeds an empty paragraph otherwise
      $initialEditorState: () => {
        $getRoot().clear();
      },
      name: '[slot-core]',
      nodes: [
        TestShadowRootNode,
        TestDecoratorNode,
        TestInlineElementNode,
        DeclaredHostNode,
        ReorderedHostNode,
        DupDeclaredHostNode,
        ReservedDeclaredHostNode,
        WrappedSlotHostNode,
      ],
    }),
  );
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  mountedRoots.push(root);
  editor.setRootElement(root);
  return editor;
}

describe('named-slots: core foundation', () => {
  test('an empty wrapped child area gets a managed line break', () => {
    using editor = createSlotEditor();
    let hostKey = '';

    editor.update(
      () => {
        const host = $create(WrappedSlotHostNode).append(
          $createTextNode('Body'),
        );
        $getRoot().append(host);
        $setSlot(host, 'title', $slotContainer('Title'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        $assertNodeType($getNodeByKey(hostKey), $isElementNode).clear();
      },
      {discrete: true},
    );

    const hostDom = editor.getElementByKey(hostKey)!;
    const content = hostDom.querySelector('[data-content]')!;
    expect(
      content.querySelector('[data-lexical-managed-linebreak="true"]'),
    ).not.toBe(null);
  });

  test('a slotted node is reachable, parentless, and attached', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let slotKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $slotContainer();
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        hostKey = host.getKey();
        slotKey = slot.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      const slot = $assertNodeType(
        $getNodeByKey(slotKey),
        $isTestShadowRootNode,
      );

      // down-pointer: host -> slot by name
      expect($getSlot(host, 'title')!.is(slot)).toBe(true);
      expect($getSlotNames(host)).toEqual(['title']);

      // up-pointer is the slot host, not the parent
      expect($getSlotHost(slot)!.is(host)).toBe(true);
      expect(slot.getParent()).toBe(null);

      // mutual exclusivity invariant
      expect(slot.__parent).toBe(null);
      expect(slot.__slotHost).toBe(host.getKey());

      // GC safety proxy: GC gates on isAttached, which now follows __slotHost
      expect(slot.isAttached()).toBe(true);
    });
  });

  test('getTopLevelElement stops at the slot boundary', () => {
    using editor = createSlotEditor();
    let slotKey = '';
    let paraKey = '';
    let textKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $createTestShadowRootNode();
        const para = $createParagraphNode();
        const text = $createTextNode('Title');
        para.append(text);
        slot.append(para);
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        slotKey = slot.getKey();
        paraKey = para.getKey();
        textKey = text.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const slot = $assertNodeType(
        $getNodeByKey(slotKey),
        $isTestShadowRootNode,
      );
      const para = $assertNodeType($getNodeByKey(paraKey), $isParagraphNode);
      const text = $assertNodeType($getNodeByKey(textKey), $isTextNode);

      // The slot value is its own isolated shadow root: a node inside it
      // resolves up to the slot's top-level child (the paragraph), and the
      // walk stops at the slot value rather than crossing to the host.
      expect(text.getTopLevelElement()!.is(para)).toBe(true);
      expect(text.getTopLevelElementOrThrow().is(para)).toBe(true);
      expect(slot.getTopLevelElement()!.is(slot)).toBe(true);
    });
  });

  test('slot map survives a host mutation (clone)', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let slotKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $slotContainer();
        $getRoot().append(host);
        $setSlot(host, 'body', slot);
        hostKey = host.getKey();
        slotKey = slot.getKey();
      },
      {discrete: true},
    );

    // mutate the host so it is cloned via getWritable -> afterCloneFrom
    editor.update(
      () => {
        $assertNodeType($getNodeByKey(hostKey), $isParagraphNode).setStyle(
          'color: red',
        );
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      expect(host.getStyle()).toBe('color: red');
      expect($getSlot(host, 'body')!.getKey()).toBe(slotKey);
      expect(
        $assertNodeType(
          $getNodeByKey(slotKey),
          $isTestShadowRootNode,
        ).isAttached(),
      ).toBe(true);
    });
  });

  test('setSlot detaches a node that already has a parent', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const parented = $createTestShadowRootNode();
        $getRoot().append(host).append(parented);
        expect(parented.getParent()).toBe($getRoot());

        $setSlot(host, 'title', parented);

        // setSlot detaches it from the child list, then slots it; a slotted
        // node and a child are mutually exclusive, so its parent is now null.
        expect(parented.getParent()).toBe(null);
        expect($getRoot().getChildrenSize()).toBe(1);
        expect($getSlot(host, 'title')!.getKey()).toBe(parented.getKey());
      },
      {discrete: true},
    );
  });

  test('$setSlot moves a node already slotted elsewhere (move semantics)', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const hostA = $createParagraphNode();
        const hostB = $createParagraphNode();
        const slot = $createTestShadowRootNode();
        $getRoot().append(hostA).append(hostB);
        $setSlot(hostA, 'title', slot);
        // Mirrors append/insertBefore: re-slotting detaches from the old
        // host instead of throwing.
        $setSlot(hostB, 'title', slot);
        expect($getSlotNames(hostA)).toEqual([]);
        expect($getSlot(hostB, 'title')!.is(slot)).toBe(true);
        expect($getSlotHost(slot)!.is(hostB)).toBe(true);
        // Same-host rename is a move too: the old name's entry is dropped.
        $setSlot(hostB, 'subtitle', slot);
        expect($getSlotNames(hostB)).toEqual(['subtitle']);
        expect($getSlot(hostB, 'subtitle')!.is(slot)).toBe(true);
        expect($getSlotHost(slot)!.is(hostB)).toBe(true);
      },
      {discrete: true},
    );
  });

  // A node hosting itself, or an ancestor, would make __slotHost point back
  // into the host's own up-chain, so isAttached/GC loop forever. The value-type
  // guard runs first, so the cycle is only reachable for nodes that are valid
  // slot values too (shadow roots / non-inline decorators) — use shadow roots.
  test('setSlot rejects hosting itself or an ancestor (cycle guard)', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const outer = $createTestShadowRootNode();
        const inner = $createTestShadowRootNode();
        $getRoot().append(outer);
        outer.append(inner);

        // self-host
        expect(() => $setSlot(outer, 'x', outer)).toThrow(/cycle/);
        // ancestor-host via children: inner would slot its own parent
        expect(() => $setSlot(inner, 'x', outer)).toThrow(/cycle/);
      },
      {discrete: true},
    );
  });

  // The ancestor may be reachable only through a slot up-link, not the
  // __parent chain isParentOf walks: a hosts b in a slot, so b.__parent is
  // null and b's only up-link is __slotHost -> a. Slotting a back into b must
  // still be rejected, or the two __slotHost links close a cycle.
  test('setSlot rejects an ancestor reachable through a slot up-link', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const a = $createTestShadowRootNode();
        const b = $createTestShadowRootNode();
        $getRoot().append(a);
        $setSlot(a, 'x', b);

        expect(() => $setSlot(b, 'y', a)).toThrow(/cycle/);
      },
      {discrete: true},
    );
  });

  test('moving a slotted node into a child list throws (reverse guard)', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const sibling = $createParagraphNode();
        $getRoot().append(host).append(sibling);

        const slot = $createTestShadowRootNode();
        $setSlot(host, 'title', slot);

        // every child-insertion path funnels through removeFromParent first
        expect(() => host.append(slot)).toThrow();
        expect(() => sibling.insertAfter(slot)).toThrow();
        expect(() => sibling.insertBefore(slot)).toThrow();
        expect(() => sibling.replace(slot)).toThrow();
      },
      {discrete: true},
    );
  });

  test('replace() on a slotted node throws (use $setSlot)', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        const slot = $createTestShadowRootNode();
        $setSlot(host, 'title', slot);

        // Without the slot-aware guard this would throw the generic
        // getParentOrThrow invariant; the guard names the actual mistake
        // (including the node and host types) and the fix ($setSlot on
        // the host).
        expect(() => slot.replace($createParagraphNode())).toThrow(
          /\(type paragraph\)[\s\S]*\$setSlot/,
        );
        // Nothing was mutated by the failed replace.
        expect($getSlot(host, 'title')).not.toBe(null);
        expect($getSlot(host, 'title')!.is(slot)).toBe(true);
      },
      {discrete: true},
    );
  });

  test('remove() on a slotted node throws (use $removeSlot)', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        const slot = $createTestShadowRootNode();
        $setSlot(host, 'title', slot);

        expect(() => slot.remove()).toThrow();
      },
      {discrete: true},
    );
  });

  test('setSlot rejects reserved names (__proto__, constructor, prototype)', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);

        for (const reserved of ['__proto__', 'constructor', 'prototype']) {
          const slot = $createTestShadowRootNode();
          expect(() => $setSlot(host, reserved, slot)).toThrow();
        }
      },
      {discrete: true},
    );
  });

  test('setSlot enforces non-inline element or decorator values', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);

        // a bare text node is neither an element nor a decorator
        expect(() => $setSlot(host, 'title', $createTextNode('x'))).toThrow(
          /not a valid slot value/,
        );
        // an element, but an inline one
        expect(() =>
          $setSlot(host, 'title', $createTestInlineElementNode()),
        ).toThrow(/not a valid slot value/);
        // TestDecoratorNode defaults to inline
        expect(() =>
          $setSlot(host, 'title', $createTestDecoratorNode()),
        ).toThrow(/not a valid slot value/);
        // a plain block element is accepted: the slot link itself is the
        // virtual shadow root, so the value need not be one (a ParagraphNode
        // can serve as a single-line field)
        const line = $createParagraphNode();
        expect(() => $setSlot(host, 'line', line)).not.toThrow();
        expect($getSlot(host, 'line')!.is(line)).toBe(true);
        $removeSlot(host, 'line');

        // a shadow-root element is accepted
        const shadow = $createTestShadowRootNode();
        expect(() => $setSlot(host, 'title', shadow)).not.toThrow();
        expect($getSlot(host, 'title')!.is(shadow)).toBe(true);

        // a non-inline (block) decorator is accepted
        const blockDecorator = $createTestDecoratorNode().setIsInline(false);
        expect(() => $setSlot(host, 'body', blockDecorator)).not.toThrow();
        expect($getSlot(host, 'body')!.is(blockDecorator)).toBe(true);
      },
      {discrete: true},
    );
  });

  test('overwriting a slot name orphans the previous occupant (no leak)', () => {
    using editor = createSlotEditor();
    let oldSlotKey = '';
    let newSlotKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const oldSlot = $createTestShadowRootNode();
        const newSlot = $createTestShadowRootNode();
        $getRoot().append(host);
        $setSlot(host, 'title', oldSlot);
        oldSlotKey = oldSlot.getKey();
        newSlotKey = newSlot.getKey();
        // overwrite the same slot name with a different node
        $setSlot(host, 'title', newSlot);
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );
      // the name now resolves to the new occupant
      expect($getSlot(host, 'title')!.getKey()).toBe(newSlotKey);
      // the replaced node is detached and garbage-collected, not leaked
      expect($getNodeByKey(oldSlotKey)).toBe(null);
      expect($getNodeByKey(newSlotKey)!.isAttached()).toBe(true);
    });
  });

  test('slots round-trip through serialize -> parse, alongside a normal child', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer('Heading');
        const normalChild = $createParagraphNode();
        normalChild.append($createTextNode('Body text'));
        $getRoot().append(host);
        host.append(normalChild);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    const stringified = JSON.stringify(editor.getEditorState().toJSON());
    const parsedState = editor.parseEditorState(stringified);

    parsedState.read(() => {
      const host = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );

      // normal child survived in the linked-list channel
      expect(host.getChildren()).toHaveLength(1);
      expect(host.getTextContent()).toContain('Body text');

      // slot survived in its own keyed channel, with nested content
      const title = $getSlot(host, 'title')!;
      expect(title).not.toBe(null);
      expect(title.getTextContent()).toBe('Heading');
      expect($getSlotHost(title)!.is(host)).toBe(true);
      expect(title.getParent()).toBe(null);
      expect(title.isAttached()).toBe(true);
    });
  });

  // A nested host: the outer slot value is a shadow root that itself contains
  // another host with its own slot. Both levels of the slot channel must
  // survive a JSON round-trip ($slots is recursive — every host serializes
  // its own slots regardless of nesting depth). Mirrors a realistic shape
  // (e.g. a Panel whose body contains a Card).
  test('a nested host (slot value contains another host with its own slot) round-trips', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const outerHost = $createParagraphNode();
        $getRoot().append(outerHost);
        // outer slot value: a shadow root whose child is itself a host
        const container = $createTestShadowRootNode();
        const innerHost = $createParagraphNode();
        innerHost.append($createTextNode('inner body'));
        container.append(innerHost);
        $setSlot(innerHost, 'inner', $slotContainer('InnerSlot'));
        $setSlot(outerHost, 'outer', container);
      },
      {discrete: true},
    );

    const stringified = JSON.stringify(editor.getEditorState().toJSON());
    const parsedState = editor.parseEditorState(stringified);

    parsedState.read(() => {
      const outerHost = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );
      const outerSlot = $getSlot(outerHost, 'outer');
      assert(outerSlot != null && $isElementNode(outerSlot));
      expect($getSlotHost(outerSlot)!.is(outerHost)).toBe(true);

      // the inner host lives in the outer slot value's children channel
      const innerHost = outerSlot.getFirstChild();
      assert(innerHost != null && $isElementNode(innerHost));
      expect(innerHost.getChildren()[0]?.getTextContent()).toBe('inner body');

      // the inner host's own slot survived the round-trip, still linked
      const innerSlot = $getSlot(innerHost, 'inner');
      assert(innerSlot != null);
      expect(innerSlot.getTextContent()).toBe('InnerSlot');
      expect($getSlotHost(innerSlot)!.is(innerHost)).toBe(true);
      expect(innerSlot.getParent()).toBe(null);
      expect(innerSlot.isAttached()).toBe(true);
    });
  });

  // The property undo/redo relies on: a captured editor state survives a
  // later slot move unmutated, so restoring it reverts the move. Exercises
  // copy-on-write versioning — if the move had mutated a slot map shared with
  // the prior version, the restored state would be corrupted.
  test('restoring a prior editor state reverts a slot move (undo-style)', () => {
    using editor = createSlotEditor();
    let slotKey = '';

    editor.update(
      () => {
        const hostA = $createParagraphNode();
        const hostB = $createParagraphNode();
        $getRoot().append(hostA).append(hostB);
        const slot = $slotContainer('Moved');
        $setSlot(hostA, 'title', slot);
        slotKey = slot.getKey();
      },
      {discrete: true},
    );

    // snapshot the pre-move state (what an undo would restore)
    const beforeMove = editor.getEditorState();

    editor.update(
      () => {
        const hostA = $getRoot().getFirstChild();
        const hostB = $getRoot().getLastChild();
        assert($isElementNode(hostA) && $isElementNode(hostB));
        $setSlot(hostB, 'title', $getSlot(hostA, 'title')!);
      },
      {discrete: true},
    );

    // the move happened
    editor.read(() => {
      const hostB = $getRoot().getLastChild();
      assert($isElementNode(hostB));
      expect($getSlot(hostB, 'title')!.getKey()).toBe(slotKey);
    });

    // restoring the snapshot reverts the move: slot back on host A, off host B
    editor.setEditorState(beforeMove);
    editor.read(() => {
      const hostA = $getRoot().getFirstChild();
      const hostB = $getRoot().getLastChild();
      assert($isElementNode(hostA) && $isElementNode(hostB));
      expect($getSlotNames(hostB)).toEqual([]);
      expect($getSlot(hostA, 'title')!.getKey()).toBe(slotKey);
      expect($getSlotHost($getNodeByKey(slotKey)!)!.is(hostA)).toBe(true);
    });
  });

  test('export throws when a slot key resolves to no node', () => {
    // Headless (no root element): the commit skips DOM reconciliation, so
    // the deliberately-unresolvable slot key survives to export, where the
    // export invariant catches it. A mounted editor would reject the same
    // bad state earlier, when the reconciler walks the slot to render it.
    using headless = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().clear();
        },
        name: '[slot-poc-headless]',
      }),
    );

    headless.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        const writableHost = host.getWritable();
        if (writableHost.__slots === null) {
          writableHost.__slots = new Map();
        }
        writableHost.__slots.set('ghost', 'nonexistent-key');
      },
      {discrete: true},
    );

    expect(() => headless.getEditorState().toJSON()).toThrow();
  });

  test('getTextContent reads slots-first, ahead of children', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer('Title');
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().append(host);
        host.append(body);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );
      // slot content precedes the linked-list child content
      expect(host.getTextContent()).toBe('TitleBody');
    });
  });

  test('detaching a host garbage-collects its slot node', () => {
    using editor = createSlotEditor();
    let slotKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $slotContainer();
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        slotKey = slot.getKey();
      },
      {discrete: true},
    );

    // slot node is in the map while the host is attached
    editor.read(() => {
      expect($getNodeByKey(slotKey)).not.toBe(null);
    });

    editor.update(
      () => {
        $getRoot().getFirstChild()!.remove();
      },
      {discrete: true},
    );

    // after the host is detached, its slot node must not leak
    editor.read(() => {
      expect($getNodeByKey(slotKey)).toBe(null);
    });
  });

  test('a slot value moved to another host survives the old host being removed in the same commit', () => {
    using editor = createSlotEditor();
    let slotKey = '';

    editor.update(
      () => {
        const hostA = $createParagraphNode();
        const hostB = $createParagraphNode();
        $getRoot().append(hostA).append(hostB);
        const slot = $slotContainer('Moved');
        $setSlot(hostA, 'title', slot);
        slotKey = slot.getKey();
      },
      {discrete: true},
    );

    // Move the value A -> B and remove the now-empty host A in the same
    // commit: GC processes the detached A in the very commit its slot's
    // __slotHost flipped to B. A's map no longer holds the value, so GC must
    // not reap it — it is live under B.
    editor.update(
      () => {
        const hostA = $getRoot().getFirstChild();
        const hostB = $getRoot().getLastChild();
        assert($isElementNode(hostA) && $isElementNode(hostB));
        const slot = $getSlot(hostA, 'title');
        assert(slot !== null);
        $setSlot(hostB, 'title', slot);
        hostA.remove();
      },
      {discrete: true},
    );

    editor.read(() => {
      // value survives on host B (now the only root child)
      expect($getNodeByKey(slotKey)).not.toBe(null);
      const hostB = $getRoot().getFirstChild();
      assert($isElementNode(hostB));
      expect($getSlot(hostB, 'title')!.getKey()).toBe(slotKey);
      expect($getNodeByKey(slotKey)!.isAttached()).toBe(true);
    });

    // removing the new host now collects the value (no longer reachable)
    editor.update(
      () => {
        $getRoot().getFirstChild()!.remove();
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getNodeByKey(slotKey)).toBe(null);
    });
  });

  test('detaching a decorator host garbage-collects its slot node', () => {
    using editor = createSlotEditor();
    let slotKey = '';
    let textKey = '';

    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        const slot = $createTestShadowRootNode();
        const para = $createParagraphNode();
        const text = $createTextNode('Slotted');
        para.append(text);
        slot.append(para);
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        slotKey = slot.getKey();
        textKey = text.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($getNodeByKey(slotKey)).not.toBe(null);
      expect($getNodeByKey(textKey)).not.toBe(null);
    });

    editor.update(
      () => {
        $getRoot().getFirstChild()!.remove();
      },
      {discrete: true},
    );

    // a decorator host is a leaf, so without the slot-aware leaf walk its
    // slot subtree would orphan in the node map
    editor.read(() => {
      expect($getNodeByKey(slotKey)).toBe(null);
      expect($getNodeByKey(textKey)).toBe(null);
    });
  });

  test('getTextContentSize counts slots-first, like getTextContent', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer('Title');
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().append(host);
        host.append(body);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );
      // 'Title' (5) + 'Body' (4); matches getTextContent length
      expect(host.getTextContentSize()).toBe(host.getTextContent().length);
      expect(host.getTextContentSize()).toBe(9);
    });
  });

  test('getAllTextNodes includes slot text, slots-first', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer('Title');
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().append(host);
        host.append(body);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );
      expect(host.getAllTextNodes().map(n => n.getTextContent())).toEqual([
        'Title',
        'Body',
      ]);
    });
  });

  test('a host with slots but no children is not empty', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer('Title');
        $getRoot().append(host);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );
      // no linked-list children, but the slot holds content
      expect(host.getChildrenSize()).toBe(0);
      expect(host.isEmpty()).toBe(false);
    });
  });

  test('a slot subtree renders into a keyed container inside the host DOM, slots-first', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let titleTextKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $createTestShadowRootNode();
        const titlePara = $createParagraphNode();
        const titleText = $createTextNode('Title');
        titlePara.append(titleText);
        title.append(titlePara);
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().append(host);
        host.append(body);
        $setSlot(host, 'title', title);
        hostKey = host.getKey();
        titleTextKey = titleText.getKey();
      },
      {discrete: true},
    );

    const hostDom = editor.getElementByKey(hostKey)!;
    const slotContainer = hostDom.querySelector('[data-lexical-slot="title"]');
    expect(slotContainer).not.toBe(null);
    // the slot subtree rendered inside its container
    expect(slotContainer!.textContent).toBe('Title');
    // slots-first: the slot container precedes the linked-list child DOM
    expect(hostDom.firstChild).toBe(slotContainer);
    // the slot's text node DOM is reachable by key (it reconciles normally)
    expect(editor.getElementByKey(titleTextKey)).not.toBe(null);
  });

  test('a decorator host renders its slot into an editable hidden placeholder', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let slotKey = '';
    let titleTextKey = '';

    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        const title = $createTestShadowRootNode();
        const titlePara = $createParagraphNode();
        const titleText = $createTextNode('Title');
        titlePara.append(titleText);
        title.append(titlePara);
        $getRoot().append(host);
        $setSlot(host, 'title', title);
        hostKey = host.getKey();
        slotKey = title.getKey();
        titleTextKey = titleText.getKey();
      },
      {discrete: true},
    );

    const hostDom = editor.getElementByKey(hostKey)!;
    // the decorator dom itself stays non-editable
    expect(hostDom.contentEditable).toBe('false');
    // the slot renders synchronously into a hidden placeholder parked in the
    // host DOM; it becomes visible only when explicitly attached somewhere
    // (mountSlotContainer / useLexicalSlotRef)
    const slotContainer = editor.getElementByKey(slotKey)!.parentElement!;
    expect(slotContainer.getAttribute('data-lexical-slot')).toBe('title');
    expect(hostDom.contains(slotContainer)).toBe(true);
    expect(slotContainer.style.display).toBe('none');
    // a decorator-host slot opts its container into editing so the otherwise
    // non-editable decorator chrome still hosts an editable region
    expect(slotContainer.contentEditable).toBe('true');
    expect(slotContainer.textContent).toBe('Title');
    expect(editor.getElementByKey(titleTextKey)).not.toBe(null);
  });

  test('editing a decorator-host slot re-reconciles it in place', () => {
    using editor = createSlotEditor();
    let slotKey = '';
    let textKey = '';

    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        const title = $createTestShadowRootNode();
        const para = $createParagraphNode();
        const text = $createTextNode('Before');
        para.append(text);
        title.append(para);
        $getRoot().append(host);
        $setSlot(host, 'title', title);
        slotKey = title.getKey();
        textKey = text.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $assertNodeType($getNodeByKey(textKey), $isTextNode).setTextContent(
          'After',
        );
      },
      {discrete: true},
    );

    const slotContainer = editor.getElementByKey(slotKey)!.parentElement!;
    expect(slotContainer.getAttribute('data-lexical-slot')).toBe('title');
    expect(slotContainer.textContent).toBe('After');
  });

  test('$getSlotContainer resolves a host slot container by key, null when empty', () => {
    using editor = createSlotEditor();
    let decoratorKey = '';
    let elementKey = '';

    editor.update(
      () => {
        const root = $getRoot();
        const decorator = $createTestDecoratorNode().setIsInline(false);
        $setSlot(decorator, 'title', $slotContainer('Deco'));
        root.append(decorator);
        const element = $createParagraphNode();
        $setSlot(element, 'title', $slotContainer('Elem'));
        element.append($createTextNode('body'));
        root.append(element);
        decoratorKey = decorator.getKey();
        elementKey = element.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const decorator = $getNodeByKey(decoratorKey)!;
      const element = $getNodeByKey(elementKey)!;
      const decoratorContainer = $getSlotContainer(decorator, 'title')!;
      const elementContainer = $getSlotContainer(element, 'title')!;
      expect(decoratorContainer.getAttribute('data-lexical-slot')).toBe(
        'title',
      );
      expect(elementContainer.getAttribute('data-lexical-slot')).toBe('title');
      expect(decoratorContainer.textContent).toBe('Deco');
      expect(elementContainer.textContent).toBe('Elem');
      // both host kinds park their containers in the host DOM as hidden
      // placeholders until something mounts them
      const decoratorDom = editor.getElementByKey(decoratorKey)!;
      const elementDom = editor.getElementByKey(elementKey)!;
      expect(decoratorDom.contains(decoratorContainer)).toBe(true);
      expect(elementDom.contains(elementContainer)).toBe(true);
      expect(decoratorContainer.style.display).toBe('none');
      expect(elementContainer.style.display).toBe('none');
      // an empty slot name resolves to null
      expect($getSlotContainer(decorator, 'missing')).toBe(null);
    });
  });

  // The reconciler renders slot subtrees synchronously into hidden
  // placeholder containers; visibility is the host's explicit decision via
  // mountSlotContainer (the named-slot analog of getDOMSlot's control over
  // where children render).
  test('an element host renders its slot as a hidden slots-first placeholder', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        host.append($createParagraphNode().append($createTextNode('Body')));
        $getRoot().append(host);
        $setSlot(host, 'title', $slotContainer('Title'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );
    const hostDom = editor.getElementByKey(hostKey)!;
    const container = hostDom.querySelector<HTMLElement>(
      '[data-lexical-slot="title"]',
    )!;
    expect(container).not.toBe(null);
    expect(container.style.display).toBe('none');
    // parked ahead of the linked-list children so the leading DOMSlot
    // boundary can skip it
    expect(hostDom.firstElementChild).toBe(container);
  });

  test('mountSlotContainer reveals and re-parents; unmount parks it back hidden', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        $setSlot(host, 'title', $slotContainer('Title'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );
    const target = document.createElement('div');
    document.body.appendChild(target);
    try {
      // missing slot name -> null, no throw
      expect(mountSlotContainer(editor, hostKey, 'missing', target)).toBe(null);
      const container = mountSlotContainer(editor, hostKey, 'title', target)!;
      expect(container.parentElement).toBe(target);
      expect(container.style.display).toBe('');
      // idempotent: same container, no move
      expect(mountSlotContainer(editor, hostKey, 'title', target)).toBe(
        container,
      );
      expect(container.parentElement).toBe(target);
      unmountSlotContainer(editor, hostKey, container);
      expect(container.style.display).toBe('none');
      expect(container.parentElement).toBe(editor.getElementByKey(hostKey));
    } finally {
      target.remove();
    }
  });

  test('mounting in place (target is the host DOM) only reveals the placeholder', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        host.append($createParagraphNode().append($createTextNode('Body')));
        $getRoot().append(host);
        $setSlot(host, 'title', $slotContainer('Title'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );
    const hostDom = editor.getElementByKey(hostKey)!;
    const container = mountSlotContainer(editor, hostKey, 'title', hostDom)!;
    expect(container.parentElement).toBe(hostDom);
    expect(container.style.display).toBe('');
    // still slots-first ahead of the body child
    expect(hostDom.firstElementChild).toBe(container);
  });

  test('$getSlotTargetElement attaches and reveals synchronously in the commit', () => {
    // An in-lexical host (no chrome framework): a render-config override
    // returning the host DOM reveals the container in its default
    // slots-first position within the same commit that renders it.
    class InPlaceHostNode extends ElementNode {
      $config() {
        return this.config('inplace_slot_host', {extends: ElementNode});
      }
      createDOM(): HTMLElement {
        return document.createElement('div');
      }
      updateDOM(): boolean {
        return false;
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().clear();
        },
        dependencies: [
          configExtension(DOMRenderExtension, {
            overrides: [
              domOverride([InPlaceHostNode], {
                $getSlotTargetElement: (_node, _slotName, hostDom) => hostDom,
              }),
            ],
          }),
        ],
        name: '[inplace-slot-host]',
        nodes: [InPlaceHostNode, TestShadowRootNode],
      }),
    );
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    editor.setRootElement(root);
    let hostKey = '';
    try {
      editor.update(
        () => {
          const host = $create(InPlaceHostNode);
          host.append($createParagraphNode().append($createTextNode('Body')));
          $getRoot().append(host);
          $setSlot(host, 'title', $slotContainer('Title'));
          hostKey = host.getKey();
        },
        {discrete: true},
      );
      const hostDom = editor.getElementByKey(hostKey)!;
      const container = hostDom.querySelector<HTMLElement>(
        '[data-lexical-slot="title"]',
      )!;
      // revealed synchronously, still slots-first, no imperative mount needed
      expect(container.style.display).toBe('');
      expect(hostDom.firstElementChild).toBe(container);
      // a later slot-channel reconcile keeps it revealed in place
      editor.update(
        () => {
          const host = $assertNodeType($getNodeByKey(hostKey), $isElementNode);
          $setSlot(host, 'caption', $slotContainer('Caption'));
        },
        {discrete: true},
      );
      expect(container.style.display).toBe('');
      const caption = hostDom.querySelector<HTMLElement>(
        '[data-lexical-slot="caption"]',
      )!;
      expect(caption.style.display).toBe('');
      // 'caption' sorts before 'title' in canonical (code-unit) order, so the
      // late add must reorder its in-place container ahead of title's — the
      // reorder pass acts on in-place-revealed containers (parentElement is
      // the host DOM) and must not strand or re-hide the existing title.
      const order = Array.from(
        hostDom.querySelectorAll<HTMLElement>('[data-lexical-slot]'),
      ).map(el => el.getAttribute('data-lexical-slot'));
      expect(order).toEqual(['caption', 'title']);
      expect(hostDom.firstElementChild).toBe(caption);
    } finally {
      editor.setRootElement(null);
      root.remove();
    }
  });

  test('a slot reconcile does not yank a mounted container back into the host', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        $setSlot(host, 'title', $slotContainer('Title'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );
    const target = document.createElement('div');
    document.body.appendChild(target);
    try {
      const container = mountSlotContainer(editor, hostKey, 'title', target)!;
      // adding a second slot runs $reconcileSlotChildren's ordering pass; the
      // mounted container is owned by the mount and must stay in the target
      editor.update(
        () => {
          const host = $assertNodeType($getNodeByKey(hostKey), $isElementNode);
          $setSlot(host, 'caption', $slotContainer('Caption'));
        },
        {discrete: true},
      );
      expect(container.parentElement).toBe(target);
      expect(container.style.display).toBe('');
      const hostDom = editor.getElementByKey(hostKey)!;
      const captionContainer = hostDom.querySelector<HTMLElement>(
        '[data-lexical-slot="caption"]',
      )!;
      expect(captionContainer.style.display).toBe('none');
    } finally {
      target.remove();
    }
  });

  test('reconciler text cache folds slot text in slots-first (RootNode.__cachedText)', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer('Title');
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().append(host);
        host.append(body);
        $setSlot(host, 'title', title);
      },
      {discrete: true},
    );

    editor.read(() => {
      const root = $getRoot();
      const host = $assertNodeType(root.getFirstChild(), $isParagraphNode);
      expect(host.getTextContent()).toBe('TitleBody');
      // the reconciler-built cache (RootNode.__cachedText) now matches
      // the slot-aware element walk
      expect(root.getTextContent()).toBe('TitleBody');
    });
  });

  test('a host with only a slot renders the slot and caches its text', () => {
    using editor = createSlotEditor();
    let hostKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer('Title');
        $getRoot().append(host);
        $setSlot(host, 'title', title);
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    const hostDom = editor.getElementByKey(hostKey)!;
    expect(
      hostDom.querySelector('[data-lexical-slot="title"]')!.textContent,
    ).toBe('Title');

    editor.read(() => {
      const root = $getRoot();
      expect(
        $assertNodeType(
          root.getFirstChild(),
          $isParagraphNode,
        ).getTextContent(),
      ).toBe('Title');
      // the childless host still contributes its slot text to the cache
      expect(root.getTextContent()).toBe('Title');
    });
  });

  test('a slots-only empty host gets no terminating line break', () => {
    using editor = createSlotEditor();
    let slotHostKey = '';
    let emptyHostKey = '';

    editor.update(
      () => {
        const slotHost = $createParagraphNode();
        $setSlot(slotHost, 'title', $slotContainer('Title'));
        const emptyHost = $createParagraphNode();
        $getRoot().append(slotHost);
        $getRoot().append(emptyHost);
        slotHostKey = slotHost.getKey();
        emptyHostKey = emptyHost.getKey();
      },
      {discrete: true},
    );

    const directBr = (dom: HTMLElement) =>
      Array.from(dom.children).find(c => c.tagName === 'BR');
    // The slot already gives the host content; the empty-element <br> would
    // be a stray caret target in the host's own child area, sitting after
    // the slot container. A childless host with slots is not empty, so it
    // must not get the 'empty' terminating line break.
    expect(directBr(editor.getElementByKey(slotHostKey)!)).toBeUndefined();
    // A truly empty host (no slots, no children) still gets the br — the
    // gate is scoped to slots-only hosts.
    expect(directBr(editor.getElementByKey(emptyHostKey)!)).not.toBe(undefined);

    editor.update(
      () => {
        $removeSlot(
          $assertNodeType($getNodeByKey(slotHostKey), $isElementNode),
          'title',
        );
      },
      {discrete: true},
    );
    expect(directBr(editor.getElementByKey(slotHostKey)!)).not.toBe(undefined);

    editor.update(
      () => {
        $setSlot(
          $assertNodeType($getNodeByKey(slotHostKey), $isElementNode),
          'title',
          $slotContainer('New title'),
        );
      },
      {discrete: true},
    );
    expect(directBr(editor.getElementByKey(slotHostKey)!)).toBeUndefined();
  });

  test('descendant navigation stays children-only (slots stay out of selection)', () => {
    using editor = createSlotEditor();
    let bodyTextKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer('Title');
        const body = $createParagraphNode();
        const bodyText = $createTextNode('Body');
        body.append(bodyText);
        $getRoot().append(host);
        host.append(body);
        $setSlot(host, 'title', title);
        bodyTextKey = bodyText.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );
      // slot 'Title' precedes 'Body' in content reads, but navigation must
      // land on the linked-list child, not the slot
      expect(host.getFirstDescendant()!.getKey()).toBe(bodyTextKey);
      expect(host.getLastDescendant()!.getKey()).toBe(bodyTextKey);
    });
  });

  test('editing slot content re-reconciles the slot in place (DOM + cache)', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let titleTextKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $createTestShadowRootNode();
        const titlePara = $createParagraphNode();
        const titleText = $createTextNode('Title');
        titlePara.append(titleText);
        title.append(titlePara);
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().append(host);
        host.append(body);
        $setSlot(host, 'title', title);
        hostKey = host.getKey();
        titleTextKey = titleText.getKey();
      },
      {discrete: true},
    );

    // mutate text inside the slot subtree; the dirty must cross __slotHost
    // to dirty the host so its slot reconciles
    editor.update(
      () => {
        $assertNodeType(
          $getNodeByKey(titleTextKey),
          $isTextNode,
        ).setTextContent('Header');
      },
      {discrete: true},
    );

    const hostDom = editor.getElementByKey(hostKey)!;
    expect(
      hostDom.querySelector('[data-lexical-slot="title"]')!.textContent,
    ).toBe('Header');

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      expect(host.getTextContent()).toBe('HeaderBody');
      expect($getRoot().getTextContent()).toBe('HeaderBody');
    });
  });

  test('replacing a slot (same name, new node) swaps the rendered subtree', () => {
    using editor = createSlotEditor();
    let hostKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const oldTitle = $slotContainer('Old');
        $getRoot().append(host);
        $setSlot(host, 'title', oldTitle);
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
        const newTitle = $slotContainer('New');
        $setSlot(host, 'title', newTitle);
      },
      {discrete: true},
    );

    const hostDom = editor.getElementByKey(hostKey)!;
    // the existing container is reused, now holding the new subtree
    expect(
      hostDom.querySelector('[data-lexical-slot="title"]')!.textContent,
    ).toBe('New');

    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('New');
    });
  });

  test('a late-added slot renders in canonical position, not insertion order', () => {
    using editor = createSlotEditor();
    let hostKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        $setSlot(host, 'b', $slotContainer('B'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
        // 'a' arrives after 'b' was already mounted: canonical (code-unit)
        // order puts it first, so the reconciler must place its container
        // ahead of the existing one.
        $setSlot(host, 'a', $slotContainer('A'));
      },
      {discrete: true},
    );

    let modelOrder: string[] = [];
    editor.read(() => {
      modelOrder = $getSlotNames(
        $assertNodeType($getNodeByKey(hostKey), $isParagraphNode),
      );
    });
    expect(modelOrder).toEqual(['a', 'b']);

    const hostDom = editor.getElementByKey(hostKey)!;
    const domOrder = Array.from(hostDom.children)
      .filter(child => child.hasAttribute('data-lexical-slot'))
      .map(child => child.getAttribute('data-lexical-slot'));
    expect(domOrder).toEqual(modelOrder);

    // Remove + re-add returns to the same canonical position (order is
    // derived, never insertion history), in the model and in the DOM.
    editor.update(
      () => {
        const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
        $removeSlot(host, 'a');
        $setSlot(host, 'a', $slotContainer('A2'));
      },
      {discrete: true},
    );
    editor.read(() => {
      modelOrder = $getSlotNames(
        $assertNodeType($getNodeByKey(hostKey), $isParagraphNode),
      );
    });
    expect(modelOrder).toEqual(['a', 'b']);
    const domOrderAfter = Array.from(editor.getElementByKey(hostKey)!.children)
      .filter(child => child.hasAttribute('data-lexical-slot'))
      .map(child => child.getAttribute('data-lexical-slot'));
    expect(domOrderAfter).toEqual(['a', 'b']);
  });

  test('suffix fast path keeps slot text when a slot and a suffix child are edited together', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let titleTextKey = '';
    const childTextKeys: string[] = [];

    // host with a 'title' slot and 5 linked-list children, enough to clear
    // MIN_FAST_PATH_CHILDREN (4) so the suffix-incremental fast path engages
    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $createTestShadowRootNode();
        const titlePara = $createParagraphNode();
        const titleText = $createTextNode('Title');
        titlePara.append(titleText);
        title.append(titlePara);
        $getRoot().append(host);
        for (let i = 0; i < 5; i++) {
          const child = $createParagraphNode();
          const childText = $createTextNode(`c${i}`);
          child.append(childText);
          host.append(child);
          childTextKeys.push(childText.getKey());
        }
        $setSlot(host, 'title', title);
        hostKey = host.getKey();
        titleTextKey = titleText.getKey();
      },
      {discrete: true},
    );

    // single update: edit the slot text AND the last (suffix) child together
    editor.update(
      () => {
        $assertNodeType(
          $getNodeByKey(titleTextKey),
          $isTextNode,
        ).setTextContent('Header');
        $assertNodeType(
          $getNodeByKey(childTextKeys[4]),
          $isTextNode,
        ).setTextContent('c4!');
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      // element walk is the slot-aware ground truth; the reconciler cache
      // (RootNode.__cachedText, read by root.getTextContent) must match it
      expect($getRoot().getTextContent()).toBe(host.getTextContent());
      // and the slot text must be the freshly edited value, slots-first
      expect(host.getTextContent().startsWith('Header')).toBe(true);
      expect(host.getTextContent()).toContain('c4!');
    });
  });

  test('suffix fast path keeps slot text when only a suffix child is edited', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    const childTextKeys: string[] = [];

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer('Title');
        $getRoot().append(host);
        for (let i = 0; i < 5; i++) {
          const child = $createParagraphNode();
          const childText = $createTextNode(`c${i}`);
          child.append(childText);
          host.append(child);
          childTextKeys.push(childText.getKey());
        }
        $setSlot(host, 'title', title);
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    // edit only a suffix child; the slot is untouched this cycle
    editor.update(
      () => {
        $assertNodeType(
          $getNodeByKey(childTextKeys[4]),
          $isTextNode,
        ).setTextContent('c4!');
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      expect($getRoot().getTextContent()).toBe(host.getTextContent());
      expect(host.getTextContent().startsWith('Title')).toBe(true);
    });
  });

  test('removing a slot drops its container and its text from the cache', () => {
    using editor = createSlotEditor();
    let hostKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer('Title');
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().append(host);
        host.append(body);
        $setSlot(host, 'title', title);
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        // Through the API: __slots is copy-on-write and shared across
        // versions, so a direct map mutation would corrupt the committed
        // previous version instead of diffing against it.
        $removeSlot(
          $assertNodeType($getNodeByKey(hostKey), $isParagraphNode),
          'title',
        );
      },
      {discrete: true},
    );

    const hostDom = editor.getElementByKey(hostKey)!;
    expect(hostDom.querySelector('[data-lexical-slot="title"]')).toBe(null);

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      expect(host.getTextContent()).toBe('Body');
      expect($getRoot().getTextContent()).toBe('Body');
    });
  });

  test('removing the host last child keeps its slot containers in the DOM', () => {
    using editor = createSlotEditor();
    let childKey = '';
    let hostKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        const child = $createTextNode('A');
        host.append(child);
        $setSlot(host, 'title', $slotContainer('TT'));
        $getRoot().append(host);
        childKey = child.getKey();
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $assertNodeType($getNodeByKey(childKey), $isTextNode).remove();
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      expect($getSlotNames(host)).toEqual(['title']);
      expect(host.getTextContent()).toBe('TT');
    });

    // The empty-children fast path clears the host DOM with
    // `textContent = ''`; with a slot present it must take the keyed slow
    // path so the prepended slot container survives.
    const hostDom = editor.getElementByKey(hostKey)!;
    const slotDom = hostDom.querySelector('[data-lexical-slot="title"]');
    expect(slotDom).not.toBe(null);
    expect(slotDom!.textContent).toBe('TT');
  });

  test('a document-wide RangeSelection carries slot text', () => {
    using editor = createSlotEditor();
    editor.update(
      () => {
        const before = $createParagraphNode().append($createTextNode('BEFORE'));
        const host = $createParagraphNode();
        const slot = $slotContainer('SLOTTEXT');
        const after = $createParagraphNode().append($createTextNode('AFTER'));
        $getRoot().append(before, host, after);
        $setSlot(host, 'title', slot);
      },
      {discrete: true},
    );
    let text = '';
    editor.update(
      () => {
        const root = $getRoot();
        const sel = $createRangeSelection();
        sel.anchor.set(root.getKey(), 0, 'element');
        sel.focus.set(root.getKey(), root.getChildrenSize(), 'element');
        $setSelection(sel);
        text = sel.getTextContent();
      },
      {discrete: true},
    );
    expect(text).toContain('SLOTTEXT');
  });

  // Slots are tightly bound to their host node, so replace() must not move
  // them onto the replacement — the replaced host keeps its slot map, and when
  // it stays detached the slot subtree is garbage-collected with it at commit
  // (via the dual-channel slot GC).
  test('replace(includeChildren) does not transfer slots; they GC with the replaced host', () => {
    using editor = createSlotEditor();
    let newHostKey = '';
    let oldHostKey = '';
    let slotKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $slotContainer('SLOTTEXT');
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        oldHostKey = host.getKey();
        slotKey = slot.getKey();
        const newHost = $createParagraphNode();
        host.replace(newHost, true);
        newHostKey = newHost.getKey();
        // The slot stays on the replaced host, not the replacement.
        expect($getSlot(newHost, 'title')).toBe(null);
        expect($getSlotNames(newHost)).toEqual([]);
        expect($getSlot(host, 'title')!.is(slot)).toBe(true);
        expect(host.isAttached()).toBe(false);
      },
      {discrete: true},
    );
    editor.read(() => {
      // The detached host and its slot subtree were garbage-collected.
      expect($getNodeByKey(oldHostKey)).toBe(null);
      expect($getNodeByKey(slotKey)).toBe(null);
      expect($getNodeByKey(newHostKey)!.isAttached()).toBe(true);
    });
  });

  test('replace on a decorator host does not transfer slots; they GC with it', () => {
    using editor = createSlotEditor();
    let oldHostKey = '';
    let slotKey = '';
    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        const slot = $slotContainer('SLOTTEXT');
        $getRoot().append(host);
        $setSlot(host, 'media', slot);
        oldHostKey = host.getKey();
        slotKey = slot.getKey();
        const newHost = $createTestDecoratorNode().setIsInline(false);
        host.replace(newHost);
        expect($getSlot(newHost, 'media')).toBe(null);
        expect($getSlot(host, 'media')!.is(slot)).toBe(true);
        expect(host.isAttached()).toBe(false);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getNodeByKey(oldHostKey)).toBe(null);
      expect($getNodeByKey(slotKey)).toBe(null);
    });
  });

  // Regression for facebook/lexical#8936: $wrapNodeInElement is
  // `node.replace(wrapper); wrapper.append(node)`. Because replace leaves the
  // slot map on the node, the wrapped host keeps its slots when it is
  // reattached in the same update.
  test('a replaced host reattached in the same update keeps its slots (wrap pattern)', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let slotKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $slotContainer('SLOTTEXT');
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        hostKey = host.getKey();
        slotKey = slot.getKey();
        // the $wrapNodeInElement pattern from @lexical/utils
        const wrapper = $createTestShadowRootNode();
        host.replace(wrapper);
        wrapper.append(host);
        expect($getSlot(host, 'title')!.is(slot)).toBe(true);
        expect($getSlotNames(wrapper)).toEqual([]);
      },
      {discrete: true},
    );
    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      expect(host.isAttached()).toBe(true);
      const slot = $getSlot(host, 'title');
      expect(slot).not.toBe(null);
      expect(slot!.getKey()).toBe(slotKey);
      expect(slot!.getTextContent()).toBe('SLOTTEXT');
      expect($getSlotHost(slot!)!.is(host)).toBe(true);
    });
  });

  // Slots are a separate channel, so $destroyNode's child recursion doesn't
  // reach them. Removing a host must still clear its slot subtree from the
  // editor's DOM map (getElementByKey); otherwise those entries leak across
  // create/remove cycles. Fails before $destroyNode gained a slot branch.
  test('removing an element host clears its slot subtree from the DOM map', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let slotKey = '';
    let innerKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $slotContainer('SLOTTEXT');
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        hostKey = host.getKey();
        slotKey = slot.getKey();
        innerKey = slot.getFirstChildOrThrow().getKey();
      },
      {discrete: true},
    );
    expect(editor.getElementByKey(slotKey)).not.toBe(null);

    editor.update(
      () => {
        $getNodeByKey(hostKey)!.remove();
      },
      {discrete: true},
    );
    expect(editor.getElementByKey(slotKey)).toBe(null);
    expect(editor.getElementByKey(innerKey)).toBe(null);
  });

  test('removing a decorator host clears its slot subtree from the DOM map', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let slotKey = '';
    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        const slot = $slotContainer('SLOTTEXT');
        $getRoot().append(host);
        $setSlot(host, 'media', slot);
        hostKey = host.getKey();
        slotKey = slot.getKey();
      },
      {discrete: true},
    );
    expect(editor.getElementByKey(slotKey)).not.toBe(null);

    editor.update(
      () => {
        $getNodeByKey(hostKey)!.remove();
      },
      {discrete: true},
    );
    expect(editor.getElementByKey(slotKey)).toBe(null);
  });

  test('setSlot rejects a non-host at the type level', () => {
    // A TextNode is neither an element nor a decorator, so it does not satisfy
    // SlotHostNode. This call is never executed; it pins the compile-time
    // rejection that replaced the former runtime host-validity invariant.
    const $rejectNonHost = (text: TextNode, slot: TestShadowRootNode): void => {
      // @ts-expect-error - text is not a valid slot host
      $setSlot(text, 'title', slot);
    };
    expect($rejectNonHost).toBeInstanceOf(Function);
  });

  test('NodeSelection.insertNodes leaves a slotted node intact', () => {
    using editor = createSlotEditor();
    let slotKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $slotContainer('SLOTTEXT');
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        slotKey = slot.getKey();
      },
      {discrete: true},
    );
    let caught: unknown = null;
    editor.update(
      () => {
        const ns = $createNodeSelection();
        ns.add(slotKey);
        $setSelection(ns);
        try {
          ns.insertNodes([$createParagraphNode()]);
        } catch (e) {
          caught = e;
        }
      },
      {discrete: true},
    );
    expect(caught).toBe(null);
    let survived = false;
    editor.read(() => {
      const host = $getRoot().getFirstChild();
      assert($isParagraphNode(host));
      const slot = $getSlot(host, 'title');
      survived = slot !== null && slot.getTextContent() === 'SLOTTEXT';
    });
    expect(survived).toBe(true);
  });

  test('NodeSelection.deleteNodes leaves a slotted node intact', () => {
    using editor = createSlotEditor();
    let slotKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $slotContainer('SLOTTEXT');
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        slotKey = slot.getKey();
      },
      {discrete: true},
    );
    let caught: unknown = null;
    editor.update(
      () => {
        const ns = $createNodeSelection();
        ns.add(slotKey);
        $setSelection(ns);
        try {
          ns.deleteNodes();
        } catch (e) {
          caught = e;
        }
      },
      {discrete: true},
    );
    expect(caught).toBe(null);
    let survived = false;
    editor.read(() => {
      const host = $getRoot().getFirstChild();
      assert($isParagraphNode(host));
      const slot = $getSlot(host, 'title');
      survived = slot !== null && slot.getTextContent() === 'SLOTTEXT';
    });
    expect(survived).toBe(true);
  });

  test('removeText inside a slot stays scoped and does not walk past the slot boundary', () => {
    using editor = createSlotEditor();
    let textKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $createTestShadowRootNode();
        const para = $createParagraphNode();
        const text = $createTextNode('SLOTTEXT');
        para.append(text);
        slot.append(para);
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        textKey = text.getKey();
      },
      {discrete: true},
    );
    let caught: unknown = null;
    editor.update(
      () => {
        const text = $assertNodeType($getNodeByKey(textKey), $isTextNode);
        const sel = $createRangeSelection();
        sel.anchor.set(textKey, 0, 'text');
        sel.focus.set(textKey, 4, 'text');
        $setSelection(sel);
        try {
          sel.removeText();
        } catch (e) {
          caught = e;
        }
        void text;
      },
      {discrete: true},
    );
    expect(caught).toBe(null);
    let remaining = '';
    editor.read(() => {
      const host = $getRoot().getFirstChild();
      assert($isParagraphNode(host));
      remaining = $getSlot(host, 'title')!.getTextContent();
    });
    expect(remaining).toBe('TEXT');
  });

  // #8904: a slot-bearing decorator host at the selection boundary is
  // deleted by backspace like any other block decorator — as a whole unit,
  // slots included. (Merging an ElementNode host away is still refused, see
  // the next test: a merge keeps children but silently drops slots.)
  test('backspace after a slot-bearing decorator host removes it (#8904)', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let textKey = '';
    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        $setSlot(host, 'quote', $slotContainer('QUOTE'));
        const text = $createTextNode('after');
        $getRoot().append(host, $createParagraphNode().append(text));
        hostKey = host.getKey();
        textKey = text.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const sel = $createRangeSelection();
        sel.anchor.set(textKey, 0, 'text');
        sel.focus.set(textKey, 0, 'text');
        $setSelection(sel);
        sel.deleteCharacter(true);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getNodeByKey(hostKey)).toBe(null);
      expect($getRoot().getChildrenSize()).toBe(1);
      expect($getRoot().getTextContent()).toBe('after');
    });
  });

  test('backspace in an empty paragraph after a slot-bearing decorator host selects it (#8904)', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let paragraphKey = '';
    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        $setSlot(host, 'quote', $slotContainer('QUOTE'));
        const paragraph = $createParagraphNode();
        $getRoot().append(host, paragraph);
        hostKey = host.getKey();
        paragraphKey = paragraph.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const sel = $createRangeSelection();
        sel.anchor.set(paragraphKey, 0, 'element');
        sel.focus.set(paragraphKey, 0, 'element');
        $setSelection(sel);
        sel.deleteCharacter(true);
      },
      {discrete: true},
    );
    editor.read(() => {
      // The empty paragraph is dropped and the host is node-selected, same
      // as any other block decorator; the next backspace deletes it.
      expect($getNodeByKey(paragraphKey)).toBe(null);
      const host = $getNodeByKey(hostKey);
      expect(host).not.toBe(null);
      const sel = $getSelection();
      assert($isNodeSelection(sel));
      expect(sel.getNodes().map(node => node.getKey())).toEqual([hostKey]);
    });
  });

  test('backspace at the start of a host child does not merge the slot-bearing host away', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let childKey = '';
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('AAA')),
        );
        const host = $createParagraphNode();
        $setSlot(host, 'title', $slotContainer('TITLE'));
        const child = $createTextNode('BBB');
        host.append(child);
        $getRoot().append(host);
        hostKey = host.getKey();
        childKey = child.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const sel = $createRangeSelection();
        sel.anchor.set(childKey, 0, 'text');
        sel.focus.set(childKey, 0, 'text');
        $setSelection(sel);
        sel.deleteCharacter(true);
      },
      {discrete: true},
    );
    editor.read(() => {
      // The host, its slot, and its child all survive: a slot-bearing host
      // is never merged away, since the merge would discard its slots.
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      expect($getRoot().getChildrenSize()).toBe(2);
      expect($getSlotNames(host)).toEqual(['title']);
      expect($getSlot(host, 'title')!.getTextContent()).toBe('TITLE');
      expect(host.getTextContent()).toBe('TITLEBBB');
      // The caret stays where it was rather than jumping into the prior block.
      const sel = $getSelection();
      assert($isRangeSelection(sel));
      expect(sel.anchor.key).toBe(childKey);
      expect(sel.anchor.offset).toBe(0);
    });
  });

  test('a slot added after initial render renders slots-first in the DOM', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        host.append($createParagraphNode().append($createTextNode('BODY')));
        $getRoot().append(host);
        hostKey = host.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
        $setSlot(host, 'title', $slotContainer('TITLE'));
      },
      {discrete: true},
    );
    const hostDom = editor.getElementByKey(hostKey)!;
    const order = Array.from(hostDom.children).map(child =>
      child.getAttribute('data-lexical-slot'),
    );
    // The slot container sits ahead of the body child, matching the
    // create-path order, rather than being appended after it.
    expect(order).toEqual(['title', null]);
  });

  test('getParentCaret stops at a slot value in every mode', () => {
    using editor = createSlotEditor();
    let slotKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        $setSlot(host, 'title', $slotContainer('TITLE'));
        slotKey = $getSlot(host, 'title')!.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const slot = $assertNodeType(
        $getNodeByKey(slotKey),
        $isTestShadowRootNode,
      );
      // A ChildCaret's parent-at-caret is the origin itself, so walking up
      // from inside the slot hands $filterByMode the slot value. Its
      // __parent is null (the up-link is __slotHost), so the only correct
      // answer is to stop here — in 'root' mode too, where a normal shadow
      // root would otherwise be walked through.
      const childCaret = $getChildCaret(slot, 'next');
      expect(childCaret.getParentCaret('root')).toBe(null);
      expect(childCaret.getParentCaret('shadowRoot')).toBe(null);
    });
  });

  test('child DOM index skips prepended slots in a coexistence host', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let childAKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        const childA = $createParagraphNode().append($createTextNode('A'));
        const childB = $createParagraphNode().append($createTextNode('B'));
        $getRoot().append(host);
        host.append(childA, childB);
        $setSlot(host, 'title', $slotContainer('Title'));
        hostKey = host.getKey();
        childAKey = childA.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      const hostDom = editor.getElementByKey(hostKey)!;
      const childADom = editor.getElementByKey(childAKey)!;
      // DOM is slots-first: [slotContainer, childA, childB].
      expect(
        (hostDom.firstChild as Element).getAttribute('data-lexical-slot'),
      ).toBe('title');
      expect(hostDom.childNodes[1]).toBe(childADom);

      const domSlot = $getDOMSlot(host, hostDom, editor);
      // The leading boundary steps over the slot container: the first
      // managed child is childA, and the offset counts the one slot.
      expect(domSlot.getFirstChild()).toBe(childADom);
      expect(domSlot.getFirstChildOffset()).toBe(1);
      // A DOM selection at host element-offset 2 sits between childA and
      // childB; it must map to lexical child index 1, not 2.
      const [resolvedEl, idx] = domSlot.resolveChildIndex(
        host,
        hostDom,
        hostDom,
        2,
      );
      expect(resolvedEl.getKey()).toBe(hostKey);
      expect(idx).toBe(1);
    });
  });

  test('a childless slot host reports no managed first child', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        $setSlot(host, 'title', $slotContainer('Title'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      const hostDom = editor.getElementByKey(hostKey)!;
      const domSlot = $getDOMSlot(host, hostDom, editor);
      // The slot container is not a managed child, so a host with only a
      // slot still has no first child.
      expect(domSlot.getFirstChild()).toBe(null);
    });
  });
});

// A slot name flows into the reconciler's container lookup. An earlier
// implementation interpolated the name into a CSS selector
// (`:scope > [data-lexical-slot="${name}"]`); a name carrying a quote or a
// bracket broke that selector and threw during reconcile. The lookup now
// matches by string equality, so such a name must reconcile in place.
//
// The signal is DOM-element identity, not onError: in jsdom the selector throw
// is a DOMException, which is not `instanceof Error`, so the reconcile catch in
// $commitPendingUpdates skips onError and silently recovers via a full
// reconcile (see feedback_lexical_test_subclass_jsdom_pitfalls). That full
// recovery rebuilds every DOM node, so the host element is replaced; an
// in-place slot reconcile preserves it. Asserting the host element survives the
// slot replace therefore fails on the throwing path and passes on the fixed one.
describe('named-slots: slot name with selector metacharacters', () => {
  test('reconciling a slot with such a name does not rebuild the host DOM', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().clear();
        },
        name: '[slot-meta]',
        nodes: [TestShadowRootNode],
      }),
    );
    const rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    document.body.appendChild(rootElement);
    editor.setRootElement(rootElement);

    const oddName = 'te"st]';
    let hostKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const body = $createParagraphNode();
        body.append($createTextNode('Body'));
        $getRoot().append(host);
        host.append(body);
        $setSlot(host, oddName, $slotContainer('Title'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );
    const hostDomBefore = editor.getElementByKey(hostKey);

    // replace (same name, new node): hits the container lookup on reconcile
    editor.update(
      () => {
        $setSlot(
          $assertNodeType($getNodeByKey(hostKey), $isParagraphNode),
          oddName,
          $slotContainer('Header'),
        );
      },
      {discrete: true},
    );
    const hostDomAfter = editor.getElementByKey(hostKey);

    // in-place reconcile keeps the host element; a recovery rebuild would not
    expect(hostDomAfter).toBe(hostDomBefore);
    expect(
      hostDomAfter!.firstElementChild!.getAttribute('data-lexical-slot'),
    ).toBe(oddName);
    expect(hostDomAfter!.firstElementChild!.textContent).toBe('Header');

    // remove: hits the stale-container lookup on reconcile
    editor.update(
      () => {
        $removeSlot(
          $assertNodeType($getNodeByKey(hostKey), $isParagraphNode),
          oddName,
        );
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      expect($getSlotNames(host)).toEqual([]);
      expect(host.getTextContent()).toBe('Body');
    });

    editor.setRootElement(null);
    document.body.removeChild(rootElement);
  });
});

// A native selectionchange can land the DOM caret directly on a slotted
// DecoratorNode's keyed DOM (e.g. clicking a Figure whose `media` slot holds a
// block decorator). $internalResolveSelectionPoint's leaf branch anchors such a
// point in the leaf's parent via getParentOrThrow(), but a slot value is
// parentless (__parent === null, reached via __slotHost), so it threw
// "Expected node N to have a parent." A slotted decorator must resolve like a
// normal decorator: the point anchors adjacent to the host in the host's
// parent, then the both-decorator guard drops it to null (a decorator caret is
// not a RangeSelection — the consumer promotes it to a NodeSelection).
describe('named-slots: selection resolution onto a slotted decorator', () => {
  function resolveCaretOnDecorator(
    editor: LexicalEditorWithDispose,
    decoratorKey: string,
  ) {
    const decoratorDom = editor.getElementByKey(decoratorKey);
    expect(decoratorDom).not.toBe(null);
    const domSelection = getDOMSelection(editor._window ?? window);
    const range = document.createRange();
    range.setStart(decoratorDom!, 0);
    range.collapse(true);
    domSelection!.removeAllRanges();
    domSelection!.addRange(range);

    let result: ReturnType<typeof $internalCreateRangeSelection> | undefined;
    editor.update(
      () => {
        result = $internalCreateRangeSelection(
          $getSelection(),
          domSelection,
          editor,
          {type: 'selectionchange'} as Event,
        );
      },
      {discrete: true},
    );
    return result;
  }

  test('a slotted block decorator resolves like a normal block decorator (no throw, null RangeSelection)', () => {
    using editor = createSlotEditor();
    let slottedKey = '';
    let childKey = '';

    editor.update(
      () => {
        // host whose `media` slot holds a block decorator (Figure shape)
        const host = $createParagraphNode();
        const slotted = $createTestDecoratorNode().setIsInline(false);
        $setSlot(host, 'media', slotted);
        // baseline: a normal block decorator as an ordinary child
        const sibling = $createParagraphNode();
        const child = $createTestDecoratorNode().setIsInline(false);
        sibling.append(child);
        $getRoot().append(host).append(sibling);
        slottedKey = slotted.getKey();
        childKey = child.getKey();
      },
      {discrete: true},
    );

    // Before the fix the slotted path threw "Expected node N to have a
    // parent." Both paths now resolve identically: a decorator caret is not
    // captured as a RangeSelection (returns null).
    expect(resolveCaretOnDecorator(editor, childKey)).toBe(null);
    expect(resolveCaretOnDecorator(editor, slottedKey)).toBe(null);
  });
});

// $createNode's cross-parent reuse guard checks prevNode.__parent !==
// node.__parent. A slot value has __parent === null in both states, so a
// cross-host slot move would bypass the reuse fast path on a __parent-only
// check and remount the DOM (orphaning portal state, losing decorator-internal
// state). These tests pin that the reuse path also covers slot moves
// (detected via __slotHost) and DOM-detached slot subtrees (host wrapper
// recreated via updateDOM=true).
describe('named-slots: cross-host slot move DOM reuse', () => {
  test('$removeSlot(A) + $setSlot(B, sameNode) in one update reuses the DOM', () => {
    using editor = createSlotEditor();
    let valueKey = '';
    let hostAKey = '';
    let hostBKey = '';

    editor.update(
      () => {
        const hostA = $createParagraphNode();
        const hostB = $createParagraphNode();
        const value = $slotContainer('Hello');
        $getRoot().append(hostA);
        $getRoot().append(hostB);
        $setSlot(hostA, 'media', value);
        hostAKey = hostA.getKey();
        hostBKey = hostB.getKey();
        valueKey = value.getKey();
      },
      {discrete: true},
    );

    const domBefore = editor.getElementByKey(valueKey);
    expect(domBefore).not.toBeNull();

    editor.update(
      () => {
        const hostA = $assertNodeType(
          $getNodeByKey(hostAKey),
          $isParagraphNode,
        );
        const hostB = $assertNodeType(
          $getNodeByKey(hostBKey),
          $isParagraphNode,
        );
        const value = $assertNodeType(
          $getNodeByKey(valueKey),
          $isTestShadowRootNode,
        );
        $removeSlot(hostA, 'media');
        $setSlot(hostB, 'media', value);
      },
      {discrete: true},
    );

    const domAfter = editor.getElementByKey(valueKey);
    expect(domAfter).not.toBeNull();
    // domAfter === domBefore — DOM reused, just re-parented. Without the
    // slot-host case in the reuse guard, the DOM would be remounted.
    expect(domAfter).toBe(domBefore);
  });

  test('host updateDOM=true preserves slot subtree DOM', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().clear();
        },
        name: '[h-1b]',
        nodes: [TestShadowRootNode, TestUpdateDOMTrueHostNode],
      }),
    );
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    mountedRoots.push(root);
    editor.setRootElement(root);

    let hostKey = '';
    let valueKey = '';
    editor.update(
      () => {
        const host = $create(TestUpdateDOMTrueHostNode);
        const value = $slotContainer('Hello');
        $getRoot().append(host);
        $setSlot(host, 'media', value);
        hostKey = host.getKey();
        valueKey = value.getKey();
      },
      {discrete: true},
    );

    const domBefore = editor.getElementByKey(valueKey);
    expect(domBefore).not.toBeNull();

    editor.update(
      () => {
        const host = $assertNodeType(
          $getNodeByKey(hostKey),
          $isTestUpdateDOMTrueHostNode,
        );
        host.setToggle(host.__toggle + 1);
      },
      {discrete: true},
    );

    const domAfter = editor.getElementByKey(valueKey);
    expect(domAfter).not.toBeNull();
    // Host wrapper DOM recreated (updateDOM=true) but slot subtree DOM
    // reused, so domAfter === domBefore (decorator portal state survives).
    // Without the DOM-detached case in the reuse guard, the slot subtree
    // would be remounted.
    expect(domAfter).toBe(domBefore);
  });
});

describe('named-slots: editable islands', () => {
  // The container element is the slot value's DOM parent (the
  // `[data-lexical-slot]` placeholder); read its resolved contentEditable.
  const slotEditable = (
    editor: LexicalEditorWithDispose,
    key: string,
  ): string => editor.getElementByKey(key)!.parentElement!.contentEditable;
  // setEditable re-renders islands through a normal (non-discrete) update, so
  // its commit lands on a microtask — drain it before asserting.
  const flush = (): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, 0));

  test('a decorator-host island follows setEditable, re-rendering on toggle', async () => {
    using editor = createSlotEditor();
    let slotKey = '';
    editor.update(
      () => {
        const host = $createTestDecoratorNode().setIsInline(false);
        $getRoot().append(host);
        $setSlot(host, 'title', $slotContainer('Title'));
        slotKey = $getSlot(host, 'title')!.getKey();
      },
      {discrete: true},
    );
    expect(slotEditable(editor, slotKey)).toBe('true');
    // Islands always follow the editor: the reconcile that setEditable
    // schedules re-applies the container's contentEditable.
    editor.setEditable(false);
    await flush();
    expect(slotEditable(editor, slotKey)).toBe('false');
    editor.setEditable(true);
    await flush();
    expect(slotEditable(editor, slotKey)).toBe('true');
  });
});

describe('named-slots: slot-name type hints', () => {
  test('a host class declared slots are preserved as a literal union', () => {
    // DeclaredHostNode declares slots: ['title', 'body']. The `const` type
    // parameter on LexicalNode.config keeps that as a tuple, so the names are
    // recoverable as a literal union — what drives $getSlot / $setSlot /
    // $removeSlot autocomplete via SlotName — rather than widening to `string`.
    type Declared =
      GetStaticNodeOwnConfig<DeclaredHostNode> extends {
        slots: infer S extends readonly string[];
      }
        ? S[number]
        : never;
    expectTypeOf<Declared>().toEqualTypeOf<'title' | 'body'>();
    // SlotName unions those with `string`, so every name is still accepted (a
    // host takes undeclared slot names at runtime); the declared ones surface as
    // suggestions.
    expectTypeOf<SlotName<DeclaredHostNode>>().toExtend<string>();
    const declared: SlotName<DeclaredHostNode> = 'title';
    const undeclared: SlotName<DeclaredHostNode> = 'anything';
    expect([declared, undeclared]).toEqual(['title', 'anything']);
  });
});

describe('$getSelectionSlotFrame', () => {
  test('returns null for a null selection', () => {
    using editor = createSlotEditor();
    editor.read(() => {
      expect($getSelectionSlotFrame(null)).toBe(null);
    });
  });

  test('returns null for a selection outside any slot', () => {
    using editor = createSlotEditor();
    editor.update(
      () => {
        const text = $createTextNode('plain');
        $getRoot().append($createParagraphNode().append(text));
        text.select(0, 'plain'.length);
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($getSelectionSlotFrame($getSelection())).toBe(null);
    });
  });

  test('returns the slot frame for a RangeSelection inside a slot', () => {
    using editor = createSlotEditor();
    let containerKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        const container = $slotContainer('inside');
        $getRoot().append(host);
        $setSlot(host, 'title', container);
        containerKey = container.getKey();
        $assertNodeType(
          container.getFirstChildOrThrow(),
          $isParagraphNode,
        ).selectStart();
      },
      {discrete: true},
    );

    editor.read(() => {
      const frame = $getSelectionSlotFrame($getSelection());
      expect(frame && frame.getKey()).toBe(containerKey);
    });
  });

  test('returns the slot frame for a NodeSelection inside a slot', () => {
    // A NodeSelection is not a RangeSelection, so the frame has to come from
    // the nodes it reports rather than from an anchor point. The same path
    // carries every other BaseSelection implementation (TableSelection, and
    // anything an app defines).
    using editor = createSlotEditor();
    let containerKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        const container = $slotContainer('inside');
        $getRoot().append(host);
        $setSlot(host, 'title', container);
        containerKey = container.getKey();
        const nodeSelection = $createNodeSelection();
        nodeSelection.add(container.getFirstChildOrThrow().getKey());
        $setSelection(nodeSelection);
      },
      {discrete: true},
    );

    editor.read(() => {
      const frame = $getSelectionSlotFrame($getSelection());
      expect(frame && frame.getKey()).toBe(containerKey);
    });
  });

  test('returns null for an empty NodeSelection', () => {
    using editor = createSlotEditor();
    editor.update(
      () => {
        $getRoot().append($createParagraphNode());
        $setSelection($createNodeSelection());
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($getSelectionSlotFrame($getSelection())).toBe(null);
    });
  });
});

describe('$getSlotNameWithinHost', () => {
  test('returns the slot name for a node sitting in a named slot', () => {
    using editor = createSlotEditor();
    let titleKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer();
        $getRoot().append(host);
        $setSlot(host, 'title', title);
        titleKey = title.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const title = $assertNodeType(
        $getNodeByKey(titleKey),
        $isTestShadowRootNode,
      );
      expect($getSlotNameWithinHost(title)).toBe('title');
    });
  });

  test('disambiguates between multiple slots on the same host', () => {
    using editor = createSlotEditor();
    let titleKey = '';
    let bodyKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const title = $slotContainer();
        const body = $slotContainer();
        $getRoot().append(host);
        $setSlot(host, 'title', title);
        $setSlot(host, 'body', body);
        titleKey = title.getKey();
        bodyKey = body.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const title = $assertNodeType(
        $getNodeByKey(titleKey),
        $isTestShadowRootNode,
      );
      const body = $assertNodeType(
        $getNodeByKey(bodyKey),
        $isTestShadowRootNode,
      );
      expect($getSlotNameWithinHost(title)).toBe('title');
      expect($getSlotNameWithinHost(body)).toBe('body');
    });
  });

  test('returns null for a regular child (not a slot value)', () => {
    using editor = createSlotEditor();
    let childKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const child = $createTextNode('plain');
        host.append(child);
        $getRoot().append(host);
        childKey = child.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const child = $assertNodeType($getNodeByKey(childKey), $isTextNode);
      expect($getSlotNameWithinHost(child)).toBe(null);
    });
  });

  test('returns null for the host itself', () => {
    using editor = createSlotEditor();
    let hostKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        $setSlot(host, 'title', $slotContainer());
        $getRoot().append(host);
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      expect($getSlotNameWithinHost(host)).toBe(null);
    });
  });

  test('returns the immediate slot name when slots are nested', () => {
    using editor = createSlotEditor();
    let innerSlotKey = '';

    editor.update(
      () => {
        const outerHost = $createParagraphNode();
        const innerHost = $slotContainer();
        const innerSlot = $slotContainer();
        $getRoot().append(outerHost);
        $setSlot(outerHost, 'outer', innerHost);
        $setSlot(innerHost, 'inner', innerSlot);
        innerSlotKey = innerSlot.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const innerSlot = $assertNodeType(
        $getNodeByKey(innerSlotKey),
        $isTestShadowRootNode,
      );
      // The lookup uses the immediate host's slot map, not the outer host's.
      expect($getSlotNameWithinHost(innerSlot)).toBe('inner');
    });
  });
});

// Regression tests for the slot-aware $selectAll path.
describe('$selectAll boundary cases', () => {
  // $selectAll on a selection whose anchor sits on a slot value's own
  // element point. The slot value's getTopLevelElement stops at itself
  // (slot boundary), and its __parent is null (it's reached through
  // __slotHost), so getParentOrThrow would throw if $selectAll didn't
  // handle the slot-value case.
  test('$selectAll does not throw when anchor is the slot value root', () => {
    using editor = createSlotEditor();
    let slotKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $slotContainer('Title');
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        slotKey = slot.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        // Place an element-type point directly on the slot container.
        const selection = $createRangeSelection();
        selection.anchor.set(slotKey, 0, 'element');
        selection.focus.set(slotKey, 0, 'element');
        $setSelection(selection);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(() => $selectAll(selection)).not.toThrow();
      },
      {discrete: true},
    );
  });

  // Manual-test surfaced: deleting the last top-level node leaves the caret
  // at the root's element-level, and the next $selectAll threw because
  // `RootNode.getTopLevelElementOrThrow` always throws by design. The
  // `$isRootNode` guard skips the slot-aware branch and falls through to a
  // regular "select all root children" path.
  test('$selectAll does not throw when anchor is the root element', () => {
    using editor = createSlotEditor();
    editor.update(
      () => {
        const selection = $getRoot().select(0, 0);
        expect(() => $selectAll(selection)).not.toThrow();
      },
      {discrete: true},
    );
  });

  // setEditorState does not latch `_slotsUsed`. An editor that
  // receives a parsed state containing slots from another editor keeps
  // _slotsUsed = false, so the selection clamps silently skip.
  test('setEditorState latches _slotsUsed when the state contains slots', () => {
    using editorA = createSlotEditor();
    using editorB = createSlotEditor();

    editorA.update(
      () => {
        const host = $createParagraphNode();
        $setSlot(host, 'title', $slotContainer('Hello'));
        $getRoot().append(host);
      },
      {discrete: true},
    );
    expect(editorA._slotsUsed).toBe(true);

    const stateA = editorA.getEditorState();
    editorB.setEditorState(stateA);

    // Hypothesis: editorB._slotsUsed stays false even though the state
    // it just received contains a slot host. If true, the selection
    // clamps silently skip on editorB.
    expect(editorB._slotsUsed).toBe(true);
  });

  // `_slotsUsed` is intentionally a one-way latch — once any editor pass
  // touches a slot, the per-frame clamp keeps walking for the rest of the
  // editor's lifetime. A future refactor that adds a "reset when slots
  // empty" would silently turn off the clamp; pin the latch shape with a
  // direct assertion so that drift surfaces as a failing test.
  test('_slotsUsed stays true after the last slot is removed', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $createParagraphNode();
        $setSlot(host, 'title', $slotContainer('Hello'));
        $getRoot().append(host);
      },
      {discrete: true},
    );
    expect(editor._slotsUsed).toBe(true);

    editor.update(
      () => {
        const host = $getRoot().getFirstChild();
        if (host !== null && $isSlotHost(host)) {
          $removeSlot(host, 'title');
        }
      },
      {discrete: true},
    );
    expect(editor._slotsUsed).toBe(true);
  });
});

describe('named-slots: audit hardening (insertNodes, cycles, idempotent setSlot)', () => {
  test('insertNodes with the caret on an empty slot value inserts into the slot', () => {
    using editor = createSlotEditor();
    editor.update(
      () => {
        const host = $createParagraphNode();
        const slotValue = $createTestShadowRootNode(); // no children
        $getRoot().append(host);
        $setSlot(host, 'title', slotValue);
        slotValue
          .select()
          .insertNodes([
            $createParagraphNode().append($createTextNode('pasted')),
          ]);
      },
      {discrete: true},
    );
    editor.read(() => {
      const host = $getRoot().getFirstChild();
      assert(host !== null && $isParagraphNode(host));
      const slotValue = $getSlot(host, 'title');
      assert(slotValue !== null);
      // The pasted block landed inside the slot subtree, not in the host's
      // child list and not at the top level.
      expect(slotValue.getTextContent()).toBe('pasted');
      expect(host.getChildrenSize()).toBe(0);
      expect($getRoot().getChildrenSize()).toBe(1);
    });
  });

  test('closing a cycle through the children channel throws instead of hanging', () => {
    using editor = createSlotEditor();
    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        const title = $slotContainer('Title');
        $setSlot(host, 'title', title);
        // direct: the slot value may not adopt its own host as a child
        expect(() => title.append(host)).toThrow(/cycle/);
        // deep: nor may any node inside the slot subtree
        const inner = title.getFirstChild();
        assert(inner !== null && $isParagraphNode(inner));
        expect(() => inner.append(host)).toThrow(/cycle/);
        const innerText = inner.getFirstChild();
        assert(innerText !== null);
        expect(() => innerText.insertBefore(host)).toThrow(/cycle/);
        expect(() => innerText.insertAfter(host)).toThrow(/cycle/);
        expect(() => innerText.replace(host)).toThrow(/cycle/);
        // the guard mutated nothing: the slot wiring is intact
        expect($getSlot(host, 'title')!.is(title)).toBe(true);
        expect($getSlotHost(title)!.is(host)).toBe(true);
        expect(host.getParent()).not.toBe(null);
      },
      {discrete: true},
    );
  });

  test('re-setting the same node into the same slot is a no-op', () => {
    using editor = createSlotEditor();
    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        const title = $slotContainer('Title');
        $setSlot(host, 'title', title);
        expect(() => $setSlot(host, 'title', title)).not.toThrow();
        expect($getSlot(host, 'title')!.is(title)).toBe(true);
        expect($getSlotNames(host)).toEqual(['title']);
        expect($getSlotNameWithinHost(title)).toBe('title');
      },
      {discrete: true},
    );
  });
});

// Canonical slot order: a class's $config `slots` declaration is the ordering
// vocabulary. The order is derived at every $setSlot (never stored): declared
// names first in declaration order, undeclared names after in code-unit order.
describe('named-slots: canonical slot order', () => {
  test('declared slots set in reverse call order come back in declared order', () => {
    using editor = createSlotEditor();
    let hostKey = '';

    editor.update(
      () => {
        const host = $create(DeclaredHostNode);
        $getRoot().append(host);
        // reverse of the declaration: body first, then title
        $setSlot(host, 'body', $slotContainer('Body'));
        $setSlot(host, 'title', $slotContainer('Title'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $getNodeByKey(hostKey);
      assert(host instanceof DeclaredHostNode);
      // declaration order, not call order and not code-unit order
      // ('body' < 'title')
      expect($getSlotNames(host)).toEqual(['title', 'body']);
    });
  });

  test('mixed declared and undeclared names sort declared-first, then code-unit', () => {
    using editor = createSlotEditor();
    let hostKey = '';

    editor.update(
      () => {
        const host = $create(DeclaredHostNode);
        $getRoot().append(host);
        $setSlot(host, 'zeta', $slotContainer('Z'));
        $setSlot(host, 'body', $slotContainer('B'));
        $setSlot(host, 'alpha', $slotContainer('A'));
        $setSlot(host, 'title', $slotContainer('T'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $getNodeByKey(hostKey);
      assert(host instanceof DeclaredHostNode);
      // declared names lead in declaration order; the undeclared rest trail
      // in code-unit order
      expect($getSlotNames(host)).toEqual(['title', 'body', 'alpha', 'zeta']);
    });
  });

  test('an undeclared host orders slot names in code-unit order', () => {
    using editor = createSlotEditor();
    let hostKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        $setSlot(host, 'b', $slotContainer('1'));
        $setSlot(host, 'A', $slotContainer('2'));
        $setSlot(host, 'a', $slotContainer('3'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      // code-unit comparison ('A' (0x41) < 'a' (0x61) < 'b' (0x62)), not
      // locale-aware collation and not insertion order
      expect($getSlotNames(host)).toEqual(['A', 'a', 'b']);
    });
  });

  test('a subclass redeclaration overrides the inherited order', () => {
    using editor = createSlotEditor();
    let hostKey = '';

    editor.update(
      () => {
        const host = $create(ReorderedHostNode);
        $getRoot().append(host);
        // set in the parent's declared order; the subclass declaration wins
        $setSlot(host, 'title', $slotContainer('Title'));
        $setSlot(host, 'body', $slotContainer('Body'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    editor.read(() => {
      const host = $getNodeByKey(hostKey);
      assert(host instanceof ReorderedHostNode);
      expect($getSlotNames(host)).toEqual(['body', 'title']);
    });
  });

  test('a late-added declared slot renders in its declared position in the DOM', () => {
    using editor = createSlotEditor();
    let hostKey = '';

    editor.update(
      () => {
        const host = $create(DeclaredHostNode);
        $getRoot().append(host);
        $setSlot(host, 'body', $slotContainer('Body'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const host = $getNodeByKey(hostKey);
        assert(host instanceof DeclaredHostNode);
        // 'title' arrives after 'body' was already mounted: the declaration
        // puts it first, so the reconciler must place its container ahead of
        // the existing one.
        $setSlot(host, 'title', $slotContainer('Title'));
      },
      {discrete: true},
    );

    let modelOrder: string[] = [];
    editor.read(() => {
      const host = $getNodeByKey(hostKey);
      assert(host instanceof DeclaredHostNode);
      modelOrder = $getSlotNames(host);
    });
    expect(modelOrder).toEqual(['title', 'body']);

    const hostDom = editor.getElementByKey(hostKey)!;
    const domOrder = Array.from(hostDom.children)
      .filter(child => child.hasAttribute('data-lexical-slot'))
      .map(child => child.getAttribute('data-lexical-slot'));
    expect(domOrder).toEqual(modelOrder);
  });

  test('exportJSON emits slots keys in canonical order', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $create(DeclaredHostNode);
        $getRoot().append(host);
        // scrambled call order, including an undeclared name
        $setSlot(host, 'body', $slotContainer('Body'));
        $setSlot(host, 'alpha', $slotContainer('Alpha'));
        $setSlot(host, 'title', $slotContainer('Title'));
      },
      {discrete: true},
    );

    const hostJSON = editor.getEditorState().toJSON().root.children[0];
    expect(hostJSON.$slots).toBeDefined();
    expect(Object.keys(hostJSON.$slots!)).toEqual(['title', 'body', 'alpha']);
  });

  test('a duplicate name in a declaration throws when the rank is first computed', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $create(DupDeclaredHostNode);
        $getRoot().append(host);
        // The rank is computed lazily: a single-entry map needs no ordering,
        // so the first set does not validate the declaration.
        expect(() => $setSlot(host, 'a', $slotContainer('A'))).not.toThrow();
        // The second set leaves the map with 2+ entries, computing the rank,
        // which rejects the ambiguous duplicate declaration.
        expect(() => $setSlot(host, 'b', $slotContainer('B'))).toThrow(
          /more than once/,
        );
      },
      {discrete: true},
    );
  });

  test('a reserved name in a declaration throws when the rank is first computed', () => {
    using editor = createSlotEditor();

    editor.update(
      () => {
        const host = $create(ReservedDeclaredHostNode);
        $getRoot().append(host);
        expect(() => $setSlot(host, 'a', $slotContainer('A'))).not.toThrow();
        expect(() => $setSlot(host, 'b', $slotContainer('B'))).toThrow(
          /reserved slot name/,
        );
      },
      {discrete: true},
    );
  });
});

describe('named-slots: copy-on-write slot map', () => {
  test('a host version cloned without slot changes shares the slot map', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        $setSlot(host, 'title', $slotContainer('Title'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );
    const mapBefore = editor
      .getEditorState()
      .read(
        () => $assertNodeType($getNodeByKey(hostKey), $isParagraphNode).__slots,
      );
    expect(mapBefore).not.toBe(null);
    editor.update(
      () => {
        // Touch the host without touching its slots: getWritable clones the
        // node version, and the map must ride along by reference instead of
        // being copied per version.
        $assertNodeType($getNodeByKey(hostKey), $isParagraphNode).setStyle(
          'color: red',
        );
      },
      {discrete: true},
    );
    const mapAfter = editor
      .getEditorState()
      .read(
        () => $assertNodeType($getNodeByKey(hostKey), $isParagraphNode).__slots,
      );
    expect(mapAfter).toBe(mapBefore);
  });

  test('a slot mutation clones the map once per version and leaves prior versions intact', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        $setSlot(host, 'a', $slotContainer('A'));
        hostKey = host.getKey();
      },
      {discrete: true},
    );
    const stateA = editor.getEditorState();
    const mapA = stateA.read(
      () => $assertNodeType($getNodeByKey(hostKey), $isParagraphNode).__slots,
    );
    let mapAfterFirstWrite: ReadonlyMap<string, string> | null = null;
    let mapAfterSecondWrite: ReadonlyMap<string, string> | null = null;
    editor.update(
      () => {
        const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
        $setSlot(host, 'b', $slotContainer('B'));
        mapAfterFirstWrite = host.getLatest().__slots;
        $setSlot(host, 'c', $slotContainer('C'));
        mapAfterSecondWrite = host.getLatest().__slots;
      },
      {discrete: true},
    );
    // The version's first write cloned the shared map; the second write
    // reused the version-owned clone.
    expect(mapAfterFirstWrite).not.toBe(mapA);
    expect(mapAfterSecondWrite).toBe(mapAfterFirstWrite);
    // The previously committed state still reads its own single-entry map.
    expect(
      stateA.read(() =>
        $getSlotNames(
          $assertNodeType($getNodeByKey(hostKey), $isParagraphNode),
        ),
      ),
    ).toEqual(['a']);
    expect(
      stateA.read(
        () => $assertNodeType($getNodeByKey(hostKey), $isParagraphNode).__slots,
      ),
    ).toBe(mapA);
    expect(mapA!.size).toBe(1);
  });
});

// A slot value need not be a shadow root: the slot link itself is a virtual
// invisible shadow root between the host and the value, so a plain block
// (here a bare ParagraphNode used as a single-line field) is a valid slot
// child. These tests pin the editing behavior of such block-shaped values:
// the scope holds exactly one block, and interactions mirror an <input> —
// Enter is a no-op, multi-block paste flattens to inline content with line
// breaks stripped, and the boundary still clamps selection.
describe('named-slots: block slot values (virtual shadow root)', () => {
  function $createLineSlotHost(): {host: ParagraphNode; line: ParagraphNode} {
    const host = $createParagraphNode();
    host.append($createTextNode('body'));
    $getRoot().append(host);
    const line = $createParagraphNode();
    line.append($createTextNode('Title'));
    $setSlot(host, 'title', line);
    return {host, line};
  }

  test('typing and inline insertNodes land inside the value', () => {
    using editor = createSlotEditor();
    let lineKey = '';
    editor.update(
      () => {
        const {line} = $createLineSlotHost();
        lineKey = line.getKey();
        const text = line.getFirstChild();
        assert(text !== null && $isTextNode(text));

        const selection = text.select(5, 5);
        selection.insertText('!');
        selection.insertNodes([$createTextNode('?')]);
      },
      {discrete: true},
    );
    editor.read(() => {
      const line = $getNodeByKey(lineKey);
      assert(line !== null && $isParagraphNode(line));
      expect(line.getTextContent()).toBe('Title!?');
      expect($getRoot().getChildrenSize()).toBe(1);
    });
  });

  test('Enter inside the value is a no-op (single-block scope)', () => {
    using editor = createSlotEditor();
    let lineKey = '';
    let hostKey = '';
    editor.update(
      () => {
        const {host, line} = $createLineSlotHost();
        lineKey = line.getKey();
        hostKey = host.getKey();
        const text = line.getFirstChild();
        assert(text !== null && $isTextNode(text));
        expect(text.select(2, 2).insertParagraph()).toBe(null);
      },
      {discrete: true},
    );
    editor.read(() => {
      const line = $getNodeByKey(lineKey);
      assert(line !== null && $isParagraphNode(line));
      // still one line, still slotted, host intact
      expect(line.getTextContent()).toBe('Title');
      expect($getSlotHost(line)!.getKey()).toBe(hostKey);
      expect($getRoot().getChildrenSize()).toBe(1);
    });
  });

  test('multi-block paste flattens to inline content like an <input>', () => {
    using editor = createSlotEditor();
    let lineKey = '';
    editor.update(
      () => {
        const {line} = $createLineSlotHost();
        lineKey = line.getKey();
        const text = line.getFirstChild();
        assert(text !== null && $isTextNode(text));
        text.select(5, 5).insertNodes([
          $createParagraphNode().append(
            $createTextNode('A'),
            $createLineBreakNode(),
            $createTextNode('B'),
          ),
          $createParagraphNode().append($createTextNode('C')),
          // block-only content has no single-line form and is dropped
          $createTestDecoratorNode().setIsInline(false),
        ]);
      },
      {discrete: true},
    );
    editor.read(() => {
      const line = $getNodeByKey(lineKey);
      assert(line !== null && $isParagraphNode(line));
      // line breaks stripped, blocks flattened, decorator dropped
      expect(line.getTextContent()).toBe('TitleABC');
      // nothing escaped to the document level
      expect($getRoot().getChildrenSize()).toBe(1);
      // slot text folds slots-first into the host with no separator
      expect($getRoot().getTextContent()).toBe('TitleABCbody');
    });
  });

  test('paste into an EMPTY block value inserts without seeding a paragraph', () => {
    using editor = createSlotEditor();
    let lineKey = '';
    editor.update(
      () => {
        const host = $createParagraphNode();
        $getRoot().append(host);
        const line = $createParagraphNode(); // empty single-line value
        $setSlot(host, 'title', line);
        lineKey = line.getKey();
        line
          .select()
          .insertNodes([
            $createParagraphNode().append($createTextNode('pasted')),
          ]);
      },
      {discrete: true},
    );
    editor.read(() => {
      const line = $getNodeByKey(lineKey);
      assert(line !== null && $isParagraphNode(line));
      expect(line.getTextContent()).toBe('pasted');
      // flattened into the value itself: no nested paragraph was created
      const first = line.getFirstChild();
      assert(first !== null);
      expect($isTextNode(first)).toBe(true);
    });
  });

  test('repeated linebreaks into a bare block value stay in insertion order (#8897)', () => {
    using editor = createSlotEditor();
    let lineKey = '';
    editor.update(
      () => {
        const {line} = $createLineSlotHost();
        lineKey = line.getKey();
        const text = line.getFirstChild();
        assert(text !== null && $isTextNode(text));
        text.select(5, 5).insertLineBreak();
      },
      {discrete: true},
    );
    // A LineBreakNode with no next sibling resolves selectEnd() to an
    // element-mode anchor directly on the slot value, the same shape
    // insertNodes' slot-value redirect branch handles for Cmd+A.
    editor.update(
      () => {
        for (let i = 0; i < 3; i++) {
          const line = $getNodeByKey(lineKey);
          assert(line !== null && $isParagraphNode(line));
          const last = line.getLastChild();
          assert(last !== null);
          last.selectEnd().insertLineBreak();
        }
      },
      {discrete: true},
    );
    editor.read(() => {
      const line = $getNodeByKey(lineKey);
      assert(line !== null && $isParagraphNode(line));
      const children = line.getChildren();
      expect(children[0]!.getTextContent()).toBe('Title');
      expect(children.filter(c => $isLineBreakNode(c)).length).toBe(4);
    });
  });

  test('insertNodes at the end of a bare block value inserts at the end, not the start', () => {
    using editor = createSlotEditor();
    let lineKey = '';
    editor.update(
      () => {
        const {line} = $createLineSlotHost();
        lineKey = line.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const line = $getNodeByKey(lineKey);
        assert(line !== null && $isParagraphNode(line));
        // Element-mode anchor on the slot value itself, offset at the end.
        line
          .select(line.getChildrenSize(), line.getChildrenSize())
          .insertNodes([$createTextNode('!')]);
      },
      {discrete: true},
    );
    editor.read(() => {
      const line = $getNodeByKey(lineKey);
      assert(line !== null && $isParagraphNode(line));
      expect(line.getTextContent()).toBe('Title!');
    });
  });

  test('backspace deletes trailing linebreaks in a bare block value one at a time (#8898)', () => {
    using editor = createSlotEditor();
    let lineKey = '';
    editor.update(
      () => {
        const {line} = $createLineSlotHost();
        lineKey = line.getKey();
        const text = line.getFirstChild();
        assert(text !== null && $isTextNode(text));
        text.select(5, 5).insertLineBreak();
        line.getLastChild()!.selectEnd().insertLineBreak();
      },
      {discrete: true},
    );
    editor.read(() => {
      const line = $getNodeByKey(lineKey);
      assert(line !== null && $isParagraphNode(line));
      expect(line.getChildren().filter(c => $isLineBreakNode(c)).length).toBe(
        2,
      );
    });
    // Same element-mode anchor shape as the insertLineBreak tests above:
    // deleteCharacter's sibling-caret exploration must delete the
    // LineBreakNode it finds instead of falling through to the slot-edge
    // boundary check with nothing deleted.
    editor.update(
      () => {
        const line = $getNodeByKey(lineKey);
        assert(line !== null && $isParagraphNode(line));
        line.getLastChild()!.selectEnd().deleteCharacter(true);
      },
      {discrete: true},
    );
    editor.read(() => {
      const line = $getNodeByKey(lineKey);
      assert(line !== null && $isParagraphNode(line));
      expect(line.getChildren().filter(c => $isLineBreakNode(c)).length).toBe(
        1,
      );
    });
    editor.update(
      () => {
        const line = $getNodeByKey(lineKey);
        assert(line !== null && $isParagraphNode(line));
        line.getLastChild()!.selectEnd().deleteCharacter(true);
      },
      {discrete: true},
    );
    editor.read(() => {
      const line = $getNodeByKey(lineKey);
      assert(line !== null && $isParagraphNode(line));
      expect(line.getTextContent()).toBe('Title');
      expect(line.getChildren().filter(c => $isLineBreakNode(c)).length).toBe(
        0,
      );
    });
  });

  test('the boundary still scopes selection and select-all', () => {
    using editor = createSlotEditor();
    let lineKey = '';
    editor.update(
      () => {
        const {line} = $createLineSlotHost();
        lineKey = line.getKey();
        const text = line.getFirstChild();
        assert(text !== null && $isTextNode(text));
        // getTopLevelElement stops at the slotted value
        expect(text.getTopLevelElement()!.is(line)).toBe(true);
        // $selectAll scopes to the value's contents
        const selection = text.select(2, 2);
        const scoped = $selectAll(selection);
        // normalization may descend the element points into the text; the
        // scope is what matters: exactly the value's content, nothing outside
        expect(scoped.getTextContent()).toBe('Title');
        expect($getSlotFrame(scoped.anchor.getNode())!.is(line)).toBe(true);
        expect($getSlotFrame(scoped.focus.getNode())!.is(line)).toBe(true);
      },
      {discrete: true},
    );
    editor.read(() => {
      const line = $getNodeByKey(lineKey);
      assert(line !== null);
      // and the frame helper reports the value as its own frame
      expect($getSlotFrame(line)!.is(line)).toBe(true);
    });
  });

  test('$getNearestRootOrShadowRoot stops at the slot value', () => {
    using editor = createSlotEditor();
    editor.update(
      () => {
        const {line} = $createLineSlotHost();
        const text = line.getFirstChild();
        assert(text !== null);
        // The slotted value is the scope root for its own subtree — and for
        // itself — instead of the parentless walk throwing. A container
        // (shadow-root) value resolves the same way for its interior.
        expect($getNearestRootOrShadowRoot(text).is(line)).toBe(true);
        expect($getNearestRootOrShadowRoot(line).is(line)).toBe(true);

        const host2 = $createParagraphNode();
        $getRoot().append(host2);
        const container = $slotContainer('inside');
        $setSlot(host2, 'media', container);
        const innerParagraph = container.getFirstChild();
        assert(innerParagraph !== null && $isParagraphNode(innerParagraph));
        expect($getNearestRootOrShadowRoot(innerParagraph).is(container)).toBe(
          true,
        );
        expect($getNearestRootOrShadowRoot(container).is(container)).toBe(true);
      },
      {discrete: true},
    );
  });

  test('backspace at the start of the value stays inside the boundary', () => {
    using editor = createSlotEditor();
    let lineKey = '';
    editor.update(
      () => {
        const {line} = $createLineSlotHost();
        lineKey = line.getKey();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const line = $getNodeByKey(lineKey);
        assert(line !== null && $isParagraphNode(line));
        const text = line.getFirstChild();
        assert(text !== null && $isTextNode(text));
        text.select(0, 0).deleteCharacter(true);
      },
      {discrete: true},
    );
    editor.read(() => {
      const line = $getNodeByKey(lineKey);
      assert(line !== null && $isParagraphNode(line));
      // nothing merged or escaped: value and host intact
      expect(line.getTextContent()).toBe('Title');
      expect($getRoot().getTextContent()).toBe('Titlebody');
      expect($getRoot().getChildrenSize()).toBe(1);
    });
  });
});

describe('named-slots: hydrate-time normalize (#8712)', () => {
  // Regression for facebook/lexical#8712: parsed inputs (URL doc payloads,
  // imported JSON, paste round-trips) can carry slot frames whose
  // children violate `getTopLevelElement`'s invariant
  // (`Children of root nodes must be elements or decorators`). Any
  // subsequent block-ancestor walk throws — SELECT_ALL, Enter, indent,
  // etc. The hydrate-time follow-up dirty-marks slot hosts so the
  // existing dirty-node transform cycle picks them up and `ElementNode`'s
  // `$transform` runs `$normalizeShadowRootChildren`, wrapping any
  // raw text the parsed state carried as a direct shadow-root slot child.
  test('a slot value with a raw TextNode child gets a paragraph wrap on setEditorState', () => {
    using editor = createSlotEditor();

    // Hand-craft an invalid state: a host whose 'title' slot value is a
    // TestShadowRootNode whose direct child is a TextNode. The in-editor
    // mutation paths can no longer produce this shape, but external
    // sources (raw URL doc state, hand-written JSON) might.
    const invalidJSON = {
      editorState: {
        root: {
          children: [
            {
              $slots: {
                title: {
                  children: [
                    {
                      detail: 0,
                      format: 0,
                      mode: 'normal',
                      style: '',
                      text: 'raw',
                      type: 'text',
                      version: 1,
                    },
                  ],
                  direction: null,
                  format: '',
                  indent: 0,
                  type: TestShadowRootNode.getType(),
                  version: 1,
                },
              },
              children: [],
              direction: null,
              format: '',
              indent: 0,
              textFormat: 0,
              textStyle: '',
              type: 'paragraph',
              version: 1,
            },
          ],
          direction: null,
          format: '',
          indent: 0,
          type: 'root',
          version: 1,
        },
      },
    };

    const parsedState = editor.parseEditorState(
      JSON.stringify(invalidJSON.editorState),
    );
    editor.setEditorState(parsedState);

    editor.read(() => {
      const host = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );
      const slot = $assertNodeType(
        $getSlot(host, 'title'),
        $isTestShadowRootNode,
      );
      const children = slot.getChildren();
      // Post-fix: the raw text is wrapped in a paragraph (the slot's only
      // child is now a paragraph that holds the original text). Pre-fix
      // the slot held the TextNode directly and any block-ancestor walk
      // on the text would have thrown.
      expect(children).toHaveLength(1);
      const firstChild = $assertNodeType(children[0], $isParagraphNode);
      expect(firstChild.getTextContent()).toBe('raw');
    });
  });
});

describe('named-slots: typing-path paragraph wrap (#8712)', () => {
  // Regression for facebook/lexical#8712: the in-the-middle branch of
  // $transferStartingElementPointToTextPoint used to wrap the new text in
  // a paragraph only when the parent was a RootNode. A block-cursor caret
  // before a non-paragraph child of a shadow-root slot frame dropped a
  // raw TextNode as a direct shadow-root child, breaking the slot-frame
  // invariant (`Children of root nodes must be elements or decorators`).
  // The widening to $isRootOrShadowRoot in the in-the-middle branch wraps
  // the new text the same way the last-offset branch already did.
  test('element-mode caret before a decorator wraps the inserted text in a paragraph', () => {
    using editor = createSlotEditor();
    let slotKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $createTestShadowRootNode();
        slot.append($createTestDecoratorNode().setIsInline(false));
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        slotKey = slot.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const slot = $getNodeByKey(slotKey);
        assert(slot !== null && $isElementNode(slot));
        // Element-mode caret at offset 0 — the placement node is the
        // existing decorator (non-paragraph), the in-the-middle branch
        // of $transferStartingElementPointToTextPoint.
        slot.select(0, 0).insertText('typed');
      },
      {discrete: true},
    );

    editor.read(() => {
      const slot = $getNodeByKey(slotKey);
      assert(slot !== null && $isElementNode(slot));
      const children = slot.getChildren();
      // Post-fix: a paragraph is inserted before the decorator, holding
      // the typed text. Pre-fix the typed text would have been a raw
      // TextNode that the slot frame is not allowed to host directly.
      const firstChild = $assertNodeType(children[0], $isParagraphNode);
      expect(firstChild.getTextContent()).toBe('typed');
    });
  });
});

describe('named-slots: insertNodes redirect termination (#8712)', () => {
  // Regression for facebook/lexical#8712: when the slot value's first child
  // is a non-element (typically a block decorator like HorizontalRuleNode),
  // `firstChild.selectStart()` resolves back to the slot value's own
  // element-mode caret (no sibling, parent = the slot value root), which
  // matches the entry condition and the branch re-enters itself forever
  // (browser tab freeze). Seeding a paragraph before the non-element first
  // child terminates the recursion.
  test('seeds a paragraph when the slot value starts with a decorator', () => {
    using editor = createSlotEditor();
    let hostKey = '';
    let slotKey = '';

    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $createTestShadowRootNode();
        slot.append($createTestDecoratorNode().setIsInline(false));
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
        hostKey = host.getKey();
        slotKey = slot.getKey();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const slot = $getNodeByKey(slotKey);
        assert(slot !== null && $isElementNode(slot));
        // Element-mode caret at the slot value's offset 0 — the entry
        // condition for the insertNodes slot-host redirect branch.
        // The actual insert: pre-fix this never returned, the editor.update
        // would never commit. Post-fix the redirect lands in the seeded
        // paragraph and the text gets inserted there.
        slot.select(0, 0).insertNodes([$createTextNode('inserted')]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const slot = $getNodeByKey(slotKey);
      assert(slot !== null && $isElementNode(slot));
      const children = slot.getChildren();
      // Slot now holds the seeded paragraph + original decorator. The
      // exact ordering and host of the inserted text depends on the
      // recursion's continuation (text node lands inside the seeded
      // paragraph since `insertNodes` of an inline run picks a paragraph
      // parent via $wrapInlineNodes); the regression we are pinning is
      // that the call returns at all.
      expect(children.length).toBeGreaterThanOrEqual(2);
      // The slot value's text content holds the inserted text.
      expect(slot.getTextContent()).toContain('inserted');
      // Host is intact.
      const host = $assertNodeType($getNodeByKey(hostKey), $isParagraphNode);
      expect($getSlot(host, 'title')!.is(slot)).toBe(true);
    });
  });
});
