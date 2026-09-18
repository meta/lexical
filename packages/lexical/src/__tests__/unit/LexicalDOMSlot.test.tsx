/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  buildEditorFromExtensions,
  defineExtension,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  $applyNodeReplacement,
  $createTextNode,
  $getRoot,
  $isElementNode,
  ElementNode,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {ElementDOMSlot} from '../../LexicalDOMSlot';
import {
  $assertNodeType,
  $createTestDecoratorNode,
  TestDecoratorNode,
} from '../utils';

describe('ElementDOMSlot class', () => {
  function makeElement(): HTMLElement {
    return document.createElement('div');
  }
  // getFirstChild / getFirstChildOffset consult the active editor (to skip the
  // block cursor), so they must run inside an editor context. `setCursor`, when
  // provided, installs a block cursor element for that read.
  function inEditor<T>(
    fn: () => T,
    setCursor?: (editor: LexicalEditor) => void,
  ): T {
    let result: T | undefined;
    using editor = buildEditorFromExtensions(
      defineExtension({name: '[ElementDOMSlot]'}),
    );
    editor.update(
      () => {
        if (setCursor) {
          setCursor(editor);
        }
        result = fn();
      },
      {discrete: true},
    );
    return result as T;
  }
  function setBlockCursor(editor: LexicalEditor, cursor: HTMLElement): void {
    (
      editor as unknown as {_blockCursorElement: HTMLElement | null}
    )._blockCursorElement = cursor;
  }

  test('constructor defaults before/after to null', () => {
    const el = makeElement();
    const slot = new ElementDOMSlot(el);
    expect(slot.element).toBe(el);
    expect(slot.before).toBe(null);
    expect(slot.after).toBe(null);
  });

  test('constructor accepts before and after', () => {
    const el = makeElement();
    const beforeNode = document.createElement('span');
    const afterNode = document.createElement('span');
    el.appendChild(afterNode);
    el.appendChild(beforeNode);
    const slot = new ElementDOMSlot(el, beforeNode, afterNode);
    expect(slot.before).toBe(beforeNode);
    expect(slot.after).toBe(afterNode);
  });

  test('withBefore returns a new slot, preserves after and element', () => {
    const el = makeElement();
    const a = document.createElement('span');
    const b = document.createElement('span');
    el.appendChild(a);
    const original = new ElementDOMSlot(el, null, a);
    const updated = original.withBefore(b);
    expect(updated).not.toBe(original);
    expect(updated.element).toBe(el);
    expect(updated.before).toBe(b);
    expect(updated.after).toBe(a);
    // Original unchanged
    expect(original.before).toBe(null);
  });

  test('withAfter returns a new slot, preserves before and element', () => {
    const el = makeElement();
    const a = document.createElement('span');
    const b = document.createElement('span');
    const original = new ElementDOMSlot(el, a, null);
    const updated = original.withAfter(b);
    expect(updated).not.toBe(original);
    expect(updated.before).toBe(a);
    expect(updated.after).toBe(b);
    expect(original.after).toBe(null);
  });

  test('withElement preserves before / after on the new element', () => {
    const el1 = makeElement();
    const el2 = makeElement();
    const beforeNode = document.createElement('span');
    const afterNode = document.createElement('span');
    const original = new ElementDOMSlot(el1, beforeNode, afterNode);
    const updated = original.withElement(el2);
    expect(updated.element).toBe(el2);
    expect(updated.before).toBe(beforeNode);
    expect(updated.after).toBe(afterNode);
  });

  test('withElement returns same instance when element is unchanged', () => {
    const el = makeElement();
    const original = new ElementDOMSlot(el);
    const updated = original.withElement(el);
    expect(updated).toBe(original);
  });

  test('setManagedLineBreak ignores slot containers before the managed range', () => {
    const el = makeElement();
    const slotContainer = document.createElement('div');
    slotContainer.setAttribute('data-lexical-slot', 'title');
    const after = document.createElement('span');
    el.append(slotContainer, after);
    const slot = new ElementDOMSlot(el, null, after);

    inEditor(() => slot.setManagedLineBreak('empty'));

    expect(slot.getManagedLineBreak()).not.toBe(null);
  });

  test('insertChild appends when before is null', () => {
    const el = makeElement();
    const slot = new ElementDOMSlot(el);
    const child = document.createElement('span');
    slot.insertChild(child);
    expect(el.firstChild).toBe(child);
    expect(el.lastChild).toBe(child);
  });

  test('insertChild inserts before the slot.before node', () => {
    const el = makeElement();
    const trailing = document.createElement('button');
    el.appendChild(trailing);
    const slot = new ElementDOMSlot(el, trailing);
    const child = document.createElement('span');
    slot.insertChild(child);
    expect(el.firstChild).toBe(child);
    expect(el.lastChild).toBe(trailing);
  });

  test('getFirstChild returns null for empty element', () => {
    const el = makeElement();
    const slot = new ElementDOMSlot(el);
    expect(inEditor(() => slot.getFirstChild())).toBe(null);
  });

  test('getFirstChild skips past slot.after sibling', () => {
    const el = makeElement();
    const leading = document.createElement('button');
    const lexicalChild = document.createElement('span');
    el.appendChild(leading);
    el.appendChild(lexicalChild);
    const slot = new ElementDOMSlot(el, null, leading);
    expect(inEditor(() => slot.getFirstChild())).toBe(lexicalChild);
  });

  test('getFirstChild returns null when only slot.before is present', () => {
    const el = makeElement();
    const trailing = document.createElement('button');
    el.appendChild(trailing);
    const slot = new ElementDOMSlot(el, trailing);
    expect(inEditor(() => slot.getFirstChild())).toBe(null);
  });

  test('getFirstChildOffset is 0 with no after', () => {
    const el = makeElement();
    const slot = new ElementDOMSlot(el);
    expect(inEditor(() => slot.getFirstChildOffset())).toBe(0);
  });

  test('getFirstChildOffset counts DOM siblings up to and including after', () => {
    const el = makeElement();
    const a = document.createElement('span');
    const b = document.createElement('span');
    const c = document.createElement('span');
    el.appendChild(a);
    el.appendChild(b);
    el.appendChild(c);
    expect(
      inEditor(() => new ElementDOMSlot(el, null, a).getFirstChildOffset()),
    ).toBe(1);
    expect(
      inEditor(() => new ElementDOMSlot(el, null, b).getFirstChildOffset()),
    ).toBe(2);
    expect(
      inEditor(() => new ElementDOMSlot(el, null, c).getFirstChildOffset()),
    ).toBe(3);
  });

  // Edge cases for block-cursor handling (#8561). The block cursor is the
  // editor's single transient caret element; when it sits at the head of an
  // element's managed children, getFirstChild / getFirstChildOffset must skip
  // / account for it. getFirstChildOffset must also stop at the trailing
  // boundary (slot.before / managed line break) when there are no children.
  test('getFirstChild skips a head block cursor (no slot.after)', () => {
    const el = makeElement();
    const cursor = document.createElement('div');
    const child = document.createElement('span');
    el.appendChild(cursor);
    el.appendChild(child);
    const slot = new ElementDOMSlot(el);
    expect(
      inEditor(
        () => slot.getFirstChild(),
        editor => setBlockCursor(editor, cursor),
      ),
    ).toBe(child);
  });

  test('getFirstChild skips a head block cursor after slot.after', () => {
    const el = makeElement();
    const leading = document.createElement('button');
    const cursor = document.createElement('div');
    const child = document.createElement('span');
    el.append(leading, cursor, child);
    const slot = new ElementDOMSlot(el, null, leading);
    expect(
      inEditor(
        () => slot.getFirstChild(),
        editor => setBlockCursor(editor, cursor),
      ),
    ).toBe(child);
  });

  test('getFirstChild ignores a non-head block cursor', () => {
    const el = makeElement();
    const child = document.createElement('span');
    const cursor = document.createElement('div');
    el.append(child, cursor);
    const slot = new ElementDOMSlot(el);
    expect(
      inEditor(
        () => slot.getFirstChild(),
        editor => setBlockCursor(editor, cursor),
      ),
    ).toBe(child);
  });

  test('getFirstChildOffset counts a head block cursor (no slot.after)', () => {
    const el = makeElement();
    const cursor = document.createElement('div');
    const child = document.createElement('span');
    el.append(cursor, child);
    const slot = new ElementDOMSlot(el);
    expect(
      inEditor(
        () => slot.getFirstChildOffset(),
        editor => setBlockCursor(editor, cursor),
      ),
    ).toBe(1);
  });

  test('getFirstChildOffset counts slot.after and a head block cursor', () => {
    const el = makeElement();
    const leading = document.createElement('button');
    const cursor = document.createElement('div');
    const child = document.createElement('span');
    el.append(leading, cursor, child);
    const slot = new ElementDOMSlot(el, null, leading);
    expect(
      inEditor(
        () => slot.getFirstChildOffset(),
        editor => setBlockCursor(editor, cursor),
      ),
    ).toBe(2);
  });

  test('getFirstChildOffset stops at slot.before when there are no children', () => {
    const el = makeElement();
    const leading = document.createElement('button');
    const trailing = document.createElement('button');
    el.append(leading, trailing);
    // Managed children would begin after `leading` (offset 1); `trailing` is
    // the trailing boundary, so the walk must stop there rather than count it.
    const slot = new ElementDOMSlot(el, trailing, leading);
    expect(inEditor(() => slot.getFirstChildOffset())).toBe(1);
  });

  test('getFirstChildOffset is 0 for an empty element with only slot.before', () => {
    const el = makeElement();
    const trailing = document.createElement('button');
    el.appendChild(trailing);
    const slot = new ElementDOMSlot(el, trailing);
    expect(inEditor(() => slot.getFirstChildOffset())).toBe(0);
  });
});

describe('ElementDOMSlot integration: leading decoration (slot.after)', () => {
  let container: HTMLElement;
  let editor: LexicalEditorWithDispose;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    editor = buildEditorFromExtensions(
      defineExtension({
        name: '[leading-decor]',
        nodes: [LeadingDecorElementNode],
      }),
    );
    editor.setRootElement(container);
  });

  afterEach(() => {
    editor.dispose();
    document.body.removeChild(container);
    // @ts-ignore
    container = null;
  });

  class LeadingDecorElementNode extends ElementNode {
    $config() {
      return this.config('leading-decor', {extends: ElementNode});
    }
    createDOM() {
      const el = document.createElement('div');
      el.setAttribute('data-block', 'true');
      const marker = document.createElement('span');
      marker.setAttribute('data-marker', 'true');
      marker.contentEditable = 'false';
      marker.textContent = '§';
      el.appendChild(marker);
      return el;
    }
    updateDOM() {
      return false;
    }
    getDOMSlot(dom: HTMLElement): ElementDOMSlot {
      const marker = dom.querySelector('[data-marker]') as HTMLElement;
      return super.getDOMSlot(dom).withAfter(marker);
    }
  }
  function $createLeadingDecorNode(): LeadingDecorElementNode {
    return $applyNodeReplacement(new LeadingDecorElementNode());
  }

  test('decoration sits in DOM before lexical children', () => {
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createLeadingDecorNode().append($createTextNode('hello')));
      },
      {discrete: true},
    );
    const block = container.querySelector('[data-block]')!;
    const marker = block.querySelector('[data-marker]')!;
    const text = block.querySelector('[data-lexical-text="true"]')!;
    expect(block.firstChild).toBe(marker);
    expect(marker.nextSibling).toBe(text);
    expect(text.textContent).toBe('hello');
  });

  test('appending children keeps the leading decoration first', () => {
    let block: LeadingDecorElementNode;
    editor.update(
      () => {
        block = $createLeadingDecorNode().append(
          $createTextNode('a').setMode('token'),
        );
        $getRoot().clear().append(block);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        block.append($createTextNode('b').setMode('token'));
      },
      {discrete: true},
    );
    const blockDom = container.querySelector('[data-block]')!;
    expect(blockDom.children[0].getAttribute('data-marker')).toBe('true');
    const texts = blockDom.querySelectorAll('[data-lexical-text="true"]');
    expect(Array.from(texts).map(n => n.textContent)).toEqual(['a', 'b']);
  });

  test('clearing children removes lexical content but keeps decoration', () => {
    let block: LeadingDecorElementNode;
    editor.update(
      () => {
        block = $createLeadingDecorNode().append($createTextNode('x'));
        $getRoot().clear().append(block);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        block.clear();
      },
      {discrete: true},
    );
    const blockDom = container.querySelector('[data-block]')!;
    const marker = blockDom.querySelector('[data-marker]');
    expect(marker).not.toBe(null);
    // Empty element gets a managed line break sibling after the marker
    expect(blockDom.querySelector('[data-lexical-text="true"]')).toBe(null);
  });

  test('resolveChildIndex maps DOM offset to lexical index using firstChildOffset', () => {
    // With a leading marker, `slot.getFirstChildOffset()` is 1. A DOM
    // selection landing on `setStart(blockDom, N)` must resolve to lexical
    // child index `N - 1` so `$validatePoint` doesn't reject the point as
    // out-of-range. Without the subtraction in `resolveChildIndex`, an
    // IME-like Range pointing at the second lexical text (DOM offset 2)
    // would resolve to lexical index 2 and crash on validation.
    let block: LeadingDecorElementNode;
    editor.update(
      () => {
        block = $createLeadingDecorNode().append(
          $createTextNode('a').setMode('token'),
          $createTextNode('b').setMode('token'),
        );
        $getRoot().clear().append(block);
      },
      {discrete: true},
    );
    editor.read(() => {
      const blockDom = container.querySelector('[data-block]') as HTMLElement;
      const slot = block.getDOMSlot(blockDom);
      // 2 lexical children + 1 marker prelude → firstChildOffset == 1.
      expect(slot.getFirstChildOffset()).toBe(1);
      // DOM offset 1 (just after marker, before first text) → lexical 0.
      expect(slot.resolveChildIndex(block, blockDom, blockDom, 1)).toEqual([
        block,
        0,
      ]);
      // DOM offset 2 (between the two texts) → lexical 1.
      expect(slot.resolveChildIndex(block, blockDom, blockDom, 2)).toEqual([
        block,
        1,
      ]);
      // DOM offset 3 (after last text) → lexical 2 (= getChildrenSize()).
      expect(slot.resolveChildIndex(block, blockDom, blockDom, 3)).toEqual([
        block,
        2,
      ]);
      // Out-of-range clamp: DOM offset 0 (before marker) clamps up to 0.
      expect(slot.resolveChildIndex(block, blockDom, blockDom, 0)).toEqual([
        block,
        0,
      ]);
      // Out-of-range clamp: DOM offset 99 clamps to children size.
      expect(slot.resolveChildIndex(block, blockDom, blockDom, 99)).toEqual([
        block,
        2,
      ]);
    });
  });

  test('resolveChildIndex skips a block cursor interleaved between children', () => {
    let block: LeadingDecorElementNode;
    editor.update(
      () => {
        block = $createLeadingDecorNode().append(
          $createTextNode('a').setMode('token'),
          $createTextNode('b').setMode('token'),
        );
        $getRoot().clear().append(block);
      },
      {discrete: true},
    );
    editor.read(() => {
      const blockDom = container.querySelector('[data-block]') as HTMLElement;
      const slot = block.getDOMSlot(blockDom);
      // Park a block cursor between the two children: [marker, a, cursor, b].
      const cursor = document.createElement('div');
      cursor.setAttribute('data-lexical-cursor', 'true');
      const bDom = blockDom.querySelectorAll('[data-lexical-text="true"]')[1];
      blockDom.insertBefore(cursor, bDom);
      (
        editor as unknown as {_blockCursorElement: HTMLElement}
      )._blockCursorElement = cursor;
      // The interleaved cursor is not leading, so firstChildOffset stays 1.
      expect(slot.getFirstChildOffset()).toBe(1);
      // DOM offset 2 = after `a`, before the cursor → lexical 1.
      expect(slot.resolveChildIndex(block, blockDom, blockDom, 2)).toEqual([
        block,
        1,
      ]);
      // DOM offset 3 = after the cursor, before `b` → lexical 1 (the cursor's
      // DOM slot must not count as a child).
      expect(slot.resolveChildIndex(block, blockDom, blockDom, 3)).toEqual([
        block,
        1,
      ]);
      // DOM offset 4 = after `b` → lexical 2.
      expect(slot.resolveChildIndex(block, blockDom, blockDom, 4)).toEqual([
        block,
        2,
      ]);
    });
  });
});

describe('ElementDOMSlot integration: trailing decoration (slot.before)', () => {
  let container: HTMLElement;
  let editor: LexicalEditorWithDispose;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    editor = buildEditorFromExtensions(
      defineExtension({
        name: '[trailing-decor]',
        nodes: [TrailingDecorElementNode],
      }),
    );
    editor.setRootElement(container);
  });

  afterEach(() => {
    editor.dispose();
    document.body.removeChild(container);
    // @ts-ignore
    container = null;
  });

  class TrailingDecorElementNode extends ElementNode {
    $config() {
      return this.config('trailing-decor', {extends: ElementNode});
    }
    createDOM() {
      const el = document.createElement('div');
      el.setAttribute('data-block', 'true');
      const marker = document.createElement('span');
      marker.setAttribute('data-marker', 'true');
      marker.contentEditable = 'false';
      marker.textContent = '⋮';
      el.appendChild(marker);
      return el;
    }
    updateDOM() {
      return false;
    }
    getDOMSlot(dom: HTMLElement): ElementDOMSlot {
      const marker = dom.querySelector('[data-marker]') as HTMLElement;
      return super.getDOMSlot(dom).withBefore(marker);
    }
  }
  function $createTrailingDecorNode(): TrailingDecorElementNode {
    return $applyNodeReplacement(new TrailingDecorElementNode());
  }

  test('decoration sits in DOM after lexical children', () => {
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createTrailingDecorNode().append($createTextNode('hello')));
      },
      {discrete: true},
    );
    const block = container.querySelector('[data-block]')!;
    const marker = block.querySelector('[data-marker]')!;
    const text = block.querySelector('[data-lexical-text="true"]')!;
    expect(text.nextSibling).toBe(marker);
    expect(block.lastChild).toBe(marker);
  });

  test('appending children keeps the trailing decoration last', () => {
    let block: TrailingDecorElementNode;
    editor.update(
      () => {
        block = $createTrailingDecorNode().append(
          $createTextNode('a').setMode('token'),
        );
        $getRoot().clear().append(block);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        block.append($createTextNode('b').setMode('token'));
      },
      {discrete: true},
    );
    const blockDom = container.querySelector('[data-block]')!;
    // Last DOM child stays the marker, lexical children come before it
    expect(
      blockDom.children[blockDom.children.length - 1].getAttribute(
        'data-marker',
      ),
    ).toBe('true');
    const texts = blockDom.querySelectorAll('[data-lexical-text="true"]');
    expect(Array.from(texts).map(n => n.textContent)).toEqual(['a', 'b']);
  });

  test('moving an existing child to the end preserves the trailing decoration', () => {
    let block: TrailingDecorElementNode;
    let firstChild: TextNode;
    editor.update(
      () => {
        firstChild = $createTextNode('first').setMode('token');
        block = $createTrailingDecorNode().append(
          firstChild,
          $createTextNode('second').setMode('token'),
        );
        $getRoot().clear().append(block);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        // Move firstChild to the end of the block
        block.append(firstChild);
      },
      {discrete: true},
    );
    const blockDom = container.querySelector('[data-block]')!;
    const texts = Array.from(
      blockDom.querySelectorAll('[data-lexical-text="true"]'),
    );
    expect(texts.map(n => n.textContent)).toEqual(['second', 'first']);
    expect(blockDom.lastChild!.nodeType).toBe(Node.ELEMENT_NODE);
    expect(
      (blockDom.lastChild as HTMLElement).getAttribute('data-marker'),
    ).toBe('true');
  });

  test('clearing children removes lexical content but keeps decoration', () => {
    let block: TrailingDecorElementNode;
    editor.update(
      () => {
        block = $createTrailingDecorNode().append($createTextNode('x'));
        $getRoot().clear().append(block);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        block.clear();
      },
      {discrete: true},
    );
    const blockDom = container.querySelector('[data-block]')!;
    const marker = blockDom.querySelector('[data-marker]');
    expect(marker).not.toBe(null);
    expect(blockDom.querySelector('[data-lexical-text="true"]')).toBe(null);
  });
});

// Regression coverage for facebook/lexical#8561. A node whose `getDOMSlot`
// wraps its content (keyed DOM !== slot.element) crashed when the selection
// layer parked the block cursor: the cursor was inserted into the keyed
// wrapper, but the reference child it must sit before lives in `slot.element`,
// so the insert threw "node is not a child" and the edit never displayed.
//
// These tests drive the real editor pipeline (focused editor + collapsed
// element selection before a block decorator) so the internal block-cursor
// plumbing runs as it would in the app, and assert on observable DOM only.
describe('ElementDOMSlot block cursor handling', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
    // @ts-ignore
    container = null;
  });

  // An ElementNode whose content lives in an inner element exposed via
  // `getDOMSlot().withElement(...)`, so the keyed DOM is a wrapper.
  class InnerWrapElementNode extends ElementNode {
    $config() {
      return this.config('inner-wrap', {extends: ElementNode});
    }
    createDOM(): HTMLElement {
      const el = document.createElement('div');
      el.setAttribute('data-wrap', 'true');
      const inner = document.createElement('div');
      inner.setAttribute('data-inner', 'true');
      el.appendChild(inner);
      return el;
    }
    updateDOM(): false {
      return false;
    }
    getDOMSlot(dom: HTMLElement): ElementDOMSlot {
      return super
        .getDOMSlot(dom)
        .withElement(dom.querySelector('[data-inner]') as HTMLElement);
    }
  }
  function $createInnerWrapNode(): InnerWrapElementNode {
    return $applyNodeReplacement(new InnerWrapElementNode());
  }

  function createFocusedEditor() {
    const editor = buildEditorFromExtensions(
      defineExtension({
        name: '[block-cursor]',
        nodes: [InnerWrapElementNode, TestDecoratorNode],
      }),
    );
    editor.setRootElement(container);
    // The block-cursor code path only runs while the editor is focused.
    container.tabIndex = 0;
    container.focus();
    expect(container.contains(document.activeElement)).toBe(true);
    return editor;
  }

  test('renders the block cursor inside the slot content element, not the keyed wrapper', () => {
    using editor = createFocusedEditor();

    // Collapsed element selection at offset 0 of the wrapped node, just before
    // a block decorator that needs the block cursor.
    editor.update(
      () => {
        const wrap = $createInnerWrapNode();
        // setIsInline(false) makes this a block decorator ($needsBlockCursorBeside).
        wrap.append($createTestDecoratorNode().setIsInline(false));
        $getRoot().clear().append(wrap);
        wrap.select(0, 0);
      },
      {discrete: true},
    );

    const inner = container.querySelector('[data-inner]') as HTMLElement;
    const cursor = container.querySelector('[data-lexical-cursor]');
    // The cursor must have been placed (proving the path ran without throwing)
    // and must live in the content element, not the keyed wrapper.
    expect(cursor).not.toBe(null);
    expect(cursor!.parentElement).toBe(inner);
  });

  test('inserting a child at offset 0 while the block cursor is showing displays the child (#8561)', () => {
    using editor = createFocusedEditor();

    editor.update(
      () => {
        const wrap = $createInnerWrapNode();
        wrap.append($createTestDecoratorNode().setIsInline(false));
        $getRoot().clear().append(wrap);
        wrap.select(0, 0);
      },
      {discrete: true},
    );

    // Sanity: the block cursor is showing before we insert.
    expect(container.querySelector('[data-lexical-cursor]')).not.toBe(null);

    // Insert a new child at the head of the wrapped node without touching the
    // selection — the scenario from the issue.
    editor.update(
      () => {
        const wrap = $assertNodeType(
          $getRoot().getFirstChild(),
          $isElementNode,
        );
        wrap.getFirstChildOrThrow().insertBefore($createTextNode('inserted'));
      },
      {discrete: true},
    );

    const inner = container.querySelector('[data-inner]') as HTMLElement;
    const text = inner.querySelector('[data-lexical-text="true"]');
    // The inserted node must display, inside the content element.
    expect(text).not.toBe(null);
    expect(text!.textContent).toBe('inserted');
    expect(text!.parentElement).toBe(inner);
  });
});
