/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {caretFromPoint} from '@lexical/clipboard';
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {registerRichText} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  findAllLexicalElementsDeep,
  getActiveElement,
  getActiveElementDeep,
  getComposedEventTarget,
  getComposedStaticRange,
  getDOMSelection,
  getDOMSelectionPoints,
  getDOMShadowRoots,
  isDOMShadowRoot,
  type LexicalEditor,
  SELECTION_CHANGE_COMMAND,
  setDOMUnmanaged,
} from 'lexical';
import {
  assert,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
} from 'vitest';
import {userEvent} from 'vitest/browser';

// These tests exercise the DOM shadow root support that relies on platform
// selection APIs (Selection.getComposedRanges / Selection.direction /
// ShadowRoot.activeElement / Selection.modify). jsdom implements none of these
// realistically, so the behavior can only be asserted in a real browser. See
// the `browser` project in vitest.config.mts.

// `getComposedRanges` etc. only exist in Chromium/WebKit/Firefox builds new
// enough to support them. When the host browser predates the API the helpers
// degrade to the light-DOM reads, so we skip the shadow-specific assertions
// rather than fail on an old engine.
const SUPPORTS_COMPOSED_RANGES =
  typeof Selection !== 'undefined' &&
  typeof Selection.prototype.getComposedRanges === 'function';

// Firefox routes compositionend through a deferred onInput, and Safari /
// WebKit route it through a deferred keydown; both paths need additional
// synthetic events to commit the composed character, which is impractical
// to model in a single-shot test. The IME smoke test below stays on the
// Chromium path that calls $onCompositionEndImpl synchronously.
const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const IS_CHROMIUM_LIKE =
  /Chrome\//.test(userAgent) && !/Firefox/.test(userAgent);

interface ShadowEditor {
  editor: LexicalEditor;
  host: HTMLElement;
  shadow: ShadowRoot;
  contentEditable: HTMLElement;
}

function $prepopulate(text: string): void {
  const root = $getRoot();
  root.clear();
  root.append($createParagraphNode().append($createTextNode(text)));
}

function setUpShadowEditor(text = 'Hello world'): ShadowEditor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({mode: 'open'});
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  shadow.appendChild(contentEditable);

  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => $prepopulate(text),
      name: 'shadow-root-selection',
      onError: error => {
        throw error;
      },
    }),
  );
  editor.setRootElement(contentEditable);

  onTestFinished(() => {
    editor.setRootElement(null);
    document.body.removeChild(host);
  });
  return {contentEditable, editor, host, shadow};
}

function getInnerTextNode(contentEditable: HTMLElement): Text {
  const span = contentEditable.querySelector('[data-lexical-text="true"]');
  return span!.firstChild as Text;
}

function selectInnerText(
  contentEditable: HTMLElement,
  start: number,
  end: number,
): {domSelection: Selection; textNode: Text} {
  const textNode = getInnerTextNode(contentEditable);
  const domSelection = getDOMSelection(window)!;
  // setBaseAndExtent rather than addRange: WebKit does not reliably register a
  // Range added with addRange when it points inside a shadow tree.
  domSelection.setBaseAndExtent(textNode, start, textNode, end);
  return {domSelection, textNode};
}

describe('DOM shadow root selection (browser)', () => {
  beforeEach(() => {
    const domSelection = getDOMSelection(window);
    if (domSelection) {
      domSelection.removeAllRanges();
    }
  });

  test('getDOMShadowRoots walks out of nested shadow trees', () => {
    const {contentEditable, shadow, host} = setUpShadowEditor();
    expect(getDOMShadowRoots(contentEditable)).toEqual([shadow]);
    // The host itself lives in the light DOM.
    expect(getDOMShadowRoots(host)).toEqual([]);
    expect(getDOMShadowRoots(document.body)).toEqual([]);
    expect(isDOMShadowRoot(shadow)).toBe(true);
    expect(isDOMShadowRoot(document)).toBe(false);
    expect(isDOMShadowRoot(document.createDocumentFragment())).toBe(false);

    // A nested shadow tree resolves innermost-first.
    const innerHost = document.createElement('div');
    contentEditable.appendChild(innerHost);
    const innerShadow = innerHost.attachShadow({mode: 'open'});
    const leaf = document.createElement('span');
    innerShadow.appendChild(leaf);
    expect(getDOMShadowRoots(leaf)).toEqual([innerShadow, shadow]);

    // Three levels deep walks all the way out.
    const middleLeaf = document.createElement('div');
    innerShadow.appendChild(middleLeaf);
    const deepestShadow = middleLeaf.attachShadow({mode: 'open'});
    const deepLeaf = document.createElement('span');
    deepestShadow.appendChild(deepLeaf);
    expect(getDOMShadowRoots(deepLeaf)).toEqual([
      deepestShadow,
      innerShadow,
      shadow,
    ]);
  });

  test('closed shadow roots are opaque from outside', () => {
    // A closed shadow root is unreachable from outside code: host.shadowRoot
    // reads as null, getDOMShadowRoots can't walk into it, and selection
    // can't be resolved through it. This documents the limitation behind
    // the "open shadow roots only" docs entry.
    const host = document.createElement('div');
    document.body.appendChild(host);
    onTestFinished(() => {
      document.body.removeChild(host);
    });
    host.attachShadow({mode: 'closed'});
    expect(host.shadowRoot).toBeNull();
    expect(getDOMShadowRoots(host)).toEqual([]);
  });

  test.skipIf(!SUPPORTS_COMPOSED_RANGES)(
    'getDOMSelectionPoints resolves a retargeted shadow selection',
    () => {
      const {contentEditable, host} = setUpShadowEditor();
      const {domSelection, textNode} = selectInnerText(contentEditable, 1, 4);

      const points = getDOMSelectionPoints(domSelection, contentEditable);
      expect(points.direction).toBe('forward');
      expect(points.anchorNode).toBe(textNode);
      expect(points.anchorOffset).toBe(1);
      expect(points.focusNode).toBe(textNode);
      expect(points.focusOffset).toBe(4);

      // The composed StaticRange is in tree order.
      const staticRange = getComposedStaticRange(domSelection, contentEditable);
      expect(staticRange!.startContainer).toBe(textNode);
      expect(staticRange!.startOffset).toBe(1);
      expect(staticRange!.endOffset).toBe(4);

      // host is unused beyond proving the selection is inside its shadow tree.
      expect(host.shadowRoot!.contains(textNode)).toBe(true);
    },
  );

  test.skipIf(!SUPPORTS_COMPOSED_RANGES)(
    'getDOMSelectionPoints honors backward selections',
    () => {
      const {contentEditable} = setUpShadowEditor();
      const textNode = getInnerTextNode(contentEditable);
      const domSelection = getDOMSelection(window)!;
      domSelection.removeAllRanges();
      // setBaseAndExtent with base after extent makes a backward selection.
      domSelection.setBaseAndExtent(textNode, 5, textNode, 2);

      const points = getDOMSelectionPoints(domSelection, contentEditable);
      // anchor is the base (5), focus is the extent (2).
      expect(points.direction).toBe('backward');
      expect(points.anchorOffset).toBe(5);
      expect(points.focusOffset).toBe(2);
    },
  );

  test('falls back to the Selection itself in the light DOM', () => {
    const light = document.createElement('div');
    light.contentEditable = 'true';
    document.body.appendChild(light);
    onTestFinished(() => {
      document.body.removeChild(light);
    });
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => $prepopulate('Hello world'),
        name: 'light',
        onError: error => {
          throw error;
        },
      }),
    );
    editor.setRootElement(light);
    onTestFinished(() => editor.setRootElement(null));

    const {domSelection} = selectInnerText(light, 0, 5);
    expect(getComposedStaticRange(domSelection, light)).toBeNull();
    // No shadow root to resolve through, so the Selection is returned as-is.
    expect(getDOMSelectionPoints(domSelection, light)).toBe(domSelection);
  });

  test('getActiveElement / getActiveElementDeep see through the shadow host', () => {
    const {contentEditable, host} = setUpShadowEditor();
    contentEditable.focus();

    // document.activeElement is retargeted to the host...
    expect(document.activeElement).toBe(host);
    // ...but the shadow-aware helpers resolve the real focused element.
    expect(getActiveElement(contentEditable)).toBe(contentEditable);
    expect(getActiveElementDeep(document)).toBe(contentEditable);
  });

  test.skipIf(!SUPPORTS_COMPOSED_RANGES)(
    'the reconciler writes selection onto the shadow inner nodes',
    () => {
      const {contentEditable, editor, shadow} = setUpShadowEditor();
      contentEditable.focus();
      editor.update(
        () => {
          $getRoot().getAllTextNodes()[0].select(0, 5);
        },
        {discrete: true},
      );

      const textNode = getInnerTextNode(contentEditable);
      const domSelection = getDOMSelection(window)!;
      const points = getDOMSelectionPoints(domSelection, contentEditable);
      expect(points.anchorNode).toBe(textNode);
      expect(points.anchorOffset).toBe(0);
      expect(points.focusNode).toBe(textNode);
      expect(points.focusOffset).toBe(5);
      // Focus landed inside the shadow tree.
      expect(shadow.activeElement).toBe(contentEditable);
    },
  );

  test.skipIf(!SUPPORTS_COMPOSED_RANGES)(
    'reading the DOM selection resolves shadow nodes into the model',
    () => {
      const {contentEditable, editor} = setUpShadowEditor();
      contentEditable.focus();
      selectInnerText(contentEditable, 2, 7);

      // This is the same DOM->model read that the document 'selectionchange'
      // handler performs internally ($internalCreateSelection); passing the event
      // option drives it deterministically without depending on the asynchronous
      // native selectionchange dispatch.
      editor.update(() => {}, {
        discrete: true,
        event: new Event('selectionchange'),
      });

      editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.anchor.offset).toBe(2);
        expect(selection.focus.offset).toBe(7);
        expect(selection.getTextContent()).toBe('llo w');
      });
    },
  );

  test.skipIf(!SUPPORTS_COMPOSED_RANGES)(
    'RangeSelection.modify uses native modify() inside a shadow root',
    () => {
      const {contentEditable, editor} = setUpShadowEditor();
      contentEditable.focus();

      // Character granularity is deterministic across browsers.
      editor.update(
        () => {
          $getRoot()
            .getAllTextNodes()[0]
            .select(0, 0)
            .modify('extend', false, 'character');
        },
        {discrete: true},
      );
      editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.getTextContent()).toBe('H');
      });

      // Word granularity should at least cover the first word.
      editor.update(
        () => {
          $getRoot()
            .getAllTextNodes()[0]
            .select(0, 0)
            .modify('extend', false, 'word');
        },
        {discrete: true},
      );
      editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.getTextContent().startsWith('Hello')).toBe(true);
        expect(selection.isCollapsed()).toBe(false);
      });
    },
  );

  // IME composition through a shadow root: the $onCompositionEndImpl path
  // reads selection through getDOMSelectionPoints to find the textnode under
  // the caret. Without the shadow-aware read, a composed CJK character would
  // land on the retargeted shadow host rather than the textnode and be
  // silently dropped.
  test.skipIf(!SUPPORTS_COMPOSED_RANGES || !IS_CHROMIUM_LIKE)(
    'composition end commits the composed character inside a shadow root',
    () => {
      const {contentEditable, editor} = setUpShadowEditor('Hi');
      contentEditable.focus();

      const textNode = getInnerTextNode(contentEditable);
      // Place the caret at the end of "Hi" inside the shadow tree.
      getDOMSelection(window)!.setBaseAndExtent(textNode, 2, textNode, 2);
      editor.update(() => {}, {
        discrete: true,
        event: new Event('selectionchange'),
      });

      contentEditable.dispatchEvent(
        new CompositionEvent('compositionstart', {
          bubbles: true,
          composed: true,
          data: '',
        }),
      );
      expect(editor.isComposing()).toBe(true);

      // Simulate the IME writing the composed character into the DOM textnode.
      textNode.nodeValue = 'Hi가';
      getDOMSelection(window)!.setBaseAndExtent(textNode, 3, textNode, 3);

      contentEditable.dispatchEvent(
        new CompositionEvent('compositionend', {
          bubbles: true,
          composed: true,
          data: '가',
        }),
      );

      expect(editor.isComposing()).toBe(false);
      expect(editor.read(() => $getRoot().getTextContent())).toBe('Hi가');
    },
  );

  // Regression test for #2119 and #8125: an editor hosted in a web
  // component's shadow root must accept real keyboard input (key events,
  // beforeinput, mutation handling) — previously characters never appeared
  // because the retargeted DOM selection could not be resolved.
  test.skipIf(!SUPPORTS_COMPOSED_RANGES)(
    'real keyboard input works in a web component shadow root',
    async () => {
      if (customElements.get('test-lexical-host') === undefined) {
        customElements.define(
          'test-lexical-host',
          class extends HTMLElement {
            connectedCallback() {
              const shadow =
                this.shadowRoot ?? this.attachShadow({mode: 'open'});
              const contentEditable = document.createElement('div');
              contentEditable.contentEditable = 'true';
              shadow.appendChild(contentEditable);
            }
          },
        );
      }
      const host = document.createElement('test-lexical-host');
      document.body.appendChild(host);
      const contentEditable = host.shadowRoot!.firstElementChild as HTMLElement;
      const editor = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $prepopulate('Hi'),
          name: 'web-component',
          onError: error => {
            throw error;
          },
        }),
      );
      // Command handlers for backspace/delete/etc.; insertion of plain typed
      // text is otherwise handled by the mutation observer path.
      const removeRichText = registerRichText(editor);
      editor.setRootElement(contentEditable);
      onTestFinished(() => {
        removeRichText();
        editor.setRootElement(null);
        document.body.removeChild(host);
      });

      // Place the caret at the end of "Hi" with the native selection, and sync
      // it into the editor the same way the selectionchange handler would.
      contentEditable.focus();
      const textNode = getInnerTextNode(contentEditable);
      getDOMSelection(window)!.setBaseAndExtent(textNode, 2, textNode, 2);
      editor.update(() => {}, {
        discrete: true,
        event: new Event('selectionchange'),
      });

      await userEvent.keyboard('abc');

      expect(editor.read(() => $getRoot().getTextContent())).toBe('Hiabc');

      // Backspace exercises the deletion path through the same selection
      // resolution machinery.
      await userEvent.keyboard('{Backspace}');
      expect(editor.read(() => $getRoot().getTextContent())).toBe('Hiab');
    },
  );

  // An editor whose root element lives in a (same-origin) iframe document is a
  // separate, but related, case: its selection is not retargeted (so no
  // composed ranges are needed), but the focus helpers must resolve through the
  // iframe's document rather than the top-level one. getActiveElement uses
  // Node.getRootNode for exactly this reason.
  test('resolves focus and selection for an editor inside an iframe', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const iframeDoc = iframe.contentDocument!;
    const contentEditable = iframeDoc.createElement('div');
    contentEditable.contentEditable = 'true';
    iframeDoc.body.appendChild(contentEditable);
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => $prepopulate('Hello world'),
        name: 'iframe',
        onError: error => {
          throw error;
        },
      }),
    );
    editor.setRootElement(contentEditable);
    onTestFinished(() => {
      editor.setRootElement(null);
      document.body.removeChild(iframe);
    });

    // An iframe document is not a shadow root, so no composed ranges are used.
    expect(getDOMShadowRoots(contentEditable)).toEqual([]);

    contentEditable.focus();
    // getActiveElement resolves through Node.getRootNode to the iframe's own
    // document, so it reads the iframe document's activeElement rather than the
    // top-level document.activeElement (which is the <iframe> element or
    // <body>, never the inner editor). We compare against iframeDoc rather than
    // asserting focus actually landed, since cross-frame focus does not
    // propagate in a headless browser.
    expect(getActiveElement(contentEditable)).toBe(iframeDoc.activeElement);
    expect(getActiveElement(contentEditable)).not.toBe(document.activeElement);

    // Selection is read from the editor's window (the iframe's) and is not
    // retargeted, so the boundary points resolve into the model directly.
    const textNode = contentEditable.querySelector(
      '[data-lexical-text="true"]',
    )!.firstChild as Text;
    iframe
      .contentWindow!.getSelection()!
      .setBaseAndExtent(textNode, 0, textNode, 5);
    editor.update(() => {}, {
      discrete: true,
      event: new Event('selectionchange'),
    });
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.getTextContent()).toBe('Hello');
    });
  });

  test.skipIf(!SUPPORTS_COMPOSED_RANGES)(
    'resolves selection for a shadow-mounted editor inside an iframe',
    () => {
      // iframe + shadow combined: the editor's contentEditable lives in a
      // shadow tree inside an iframe document, so the helpers must walk both
      // boundaries — Node.getRootNode through the shadow root + the
      // iframe's own document for active element / selection reads.
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      const iframeDoc = iframe.contentDocument!;
      const host = iframeDoc.createElement('div');
      iframeDoc.body.appendChild(host);
      const shadow = host.attachShadow({mode: 'open'});
      const contentEditable = iframeDoc.createElement('div');
      contentEditable.contentEditable = 'true';
      shadow.appendChild(contentEditable);

      const editor = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $prepopulate('Hello world'),
          name: 'iframe-shadow',
          onError: error => {
            throw error;
          },
        }),
      );
      editor.setRootElement(contentEditable);
      onTestFinished(() => {
        editor.setRootElement(null);
        document.body.removeChild(iframe);
      });

      // getDOMShadowRoots walks the shadow boundary inside the iframe.
      expect(getDOMShadowRoots(contentEditable)).toEqual([shadow]);
      // getActiveElement resolves through both boundaries: shadow root +
      // iframe document.
      contentEditable.focus();
      expect(getActiveElement(contentEditable)).toBe(shadow.activeElement);

      // Composed selection read from the iframe's window resolves the
      // shadow-internal textnode rather than the retargeted host.
      const textNode = contentEditable.querySelector(
        '[data-lexical-text="true"]',
      )!.firstChild as Text;
      const iframeSelection = iframe.contentWindow!.getSelection()!;
      iframeSelection.setBaseAndExtent(textNode, 0, textNode, 5);
      const points = getDOMSelectionPoints(iframeSelection, contentEditable);
      expect(points.anchorNode).toBe(textNode);
      expect(points.anchorOffset).toBe(0);
      expect(points.focusOffset).toBe(5);
    },
  );

  test.skipIf(!SUPPORTS_COMPOSED_RANGES)(
    'Selection.direction defaults to forward when absent',
    () => {
      // Firefox before 124 ships `Selection.getComposedRanges` without
      // `Selection.direction`; the helpers must treat the missing field as
      // "not backward" so the StaticRange's start/end map onto anchor/focus
      // in tree order rather than getting silently swapped.
      const {contentEditable} = setUpShadowEditor();
      const {domSelection, textNode} = selectInnerText(contentEditable, 1, 4);
      const original = Object.getOwnPropertyDescriptor(
        Selection.prototype,
        'direction',
      );
      Object.defineProperty(Selection.prototype, 'direction', {
        configurable: true,
        get() {
          return undefined;
        },
      });
      onTestFinished(() => {
        if (original) {
          Object.defineProperty(Selection.prototype, 'direction', original);
        } else {
          delete (Selection.prototype as unknown as {direction?: unknown})
            .direction;
        }
      });
      const points = getDOMSelectionPoints(domSelection, contentEditable);
      // direction is undefined; anchor/focus default to the StaticRange's tree
      // order (forward) since the engine can't report the actual direction.
      expect(points.direction).toBeUndefined();
      expect(points.anchorNode).toBe(textNode);
      expect(points.anchorOffset).toBe(1);
      expect(points.focusOffset).toBe(4);
    },
  );

  test.skipIf(!SUPPORTS_COMPOSED_RANGES)(
    'Selection.direction absent + backward selection signals unknown direction',
    () => {
      // If a future engine ships getComposedRanges without Selection.direction
      // (no current shipping configuration matches), the helper can't tell a
      // backward selection from a forward one — anchor/focus default to tree
      // order and the undefined direction is the explicit signal to callers.
      const {contentEditable} = setUpShadowEditor();
      const textNode = getInnerTextNode(contentEditable);
      const domSelection = getDOMSelection(window)!;
      domSelection.removeAllRanges();
      domSelection.setBaseAndExtent(textNode, 5, textNode, 2);
      const original = Object.getOwnPropertyDescriptor(
        Selection.prototype,
        'direction',
      );
      Object.defineProperty(Selection.prototype, 'direction', {
        configurable: true,
        get() {
          return undefined;
        },
      });
      onTestFinished(() => {
        if (original) {
          Object.defineProperty(Selection.prototype, 'direction', original);
        } else {
          delete (Selection.prototype as unknown as {direction?: unknown})
            .direction;
        }
      });
      const points = getDOMSelectionPoints(domSelection, contentEditable);
      expect(points.direction).toBeUndefined();
      expect(points.anchorNode).toBe(textNode);
      expect(points.anchorOffset).toBe(2);
      expect(points.focusOffset).toBe(5);
    },
  );

  describe('getComposedEventTarget', () => {
    test('returns the composed-path target inside a shadow root', () => {
      const {shadow, contentEditable} = setUpShadowEditor();

      const innerSpan = document.createElement('span');
      innerSpan.textContent = 'inner';
      contentEditable.appendChild(innerSpan);

      let observedTarget: EventTarget | null = null;
      const listener = (event: Event) => {
        observedTarget = getComposedEventTarget(event);
      };
      // Listener on window (outside the shadow tree) — composed events bubble
      // up retargeted to the shadow host, so event.target alone would be the
      // host, not the inner span. getComposedEventTarget should recover the inner
      // target via composedPath().
      window.addEventListener('click', listener);
      onTestFinished(() => {
        window.removeEventListener('click', listener);
      });

      innerSpan.dispatchEvent(
        new MouseEvent('click', {bubbles: true, composed: true}),
      );

      expect(observedTarget).toBe(innerSpan);
      expect(observedTarget).not.toBe(shadow.host);
    });

    test('falls back to event.target when composedPath is unavailable', () => {
      const div = document.createElement('div');
      document.body.appendChild(div);
      onTestFinished(() => {
        document.body.removeChild(div);
      });

      const event = new Event('custom');
      Object.defineProperty(event, 'target', {value: div});
      // Force composedPath to be undefined (simulate an older engine).
      Object.defineProperty(event, 'composedPath', {value: undefined});

      expect(getComposedEventTarget(event)).toBe(div);
    });

    test('returns event.target when composedPath returns an empty array', () => {
      const div = document.createElement('div');
      document.body.appendChild(div);
      onTestFinished(() => {
        document.body.removeChild(div);
      });

      const event = new Event('custom');
      Object.defineProperty(event, 'target', {value: div});
      Object.defineProperty(event, 'composedPath', {
        value: () => [],
      });

      expect(getComposedEventTarget(event)).toBe(div);
    });
  });

  describe('window-attached pointerdown listener (shadow root regression)', () => {
    test.skipIf(!SUPPORTS_COMPOSED_RANGES)(
      'rootElement.contains(getComposedEventTarget(event)) is true for clicks inside the shadow editor',
      () => {
        const {contentEditable} = setUpShadowEditor('Hello');
        const root = contentEditable;

        let matched = false;
        const listener = (event: PointerEvent) => {
          const target = getComposedEventTarget(event);
          // Mirrors LexicalTableSelectionHelpers' pointerdown gate.
          matched =
            target !== null && target instanceof Node && root.contains(target);
        };
        window.addEventListener('pointerdown', listener);
        onTestFinished(() =>
          window.removeEventListener('pointerdown', listener),
        );

        const textNode = contentEditable.querySelector('span') as HTMLElement;
        textNode.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            composed: true,
          }),
        );

        expect(matched).toBe(true);
      },
    );
  });

  describe('shadow-aware querySelector helpers', () => {
    test('descends open shadow roots when collecting editors', () => {
      const outer = document.createElement('div');
      document.body.appendChild(outer);
      onTestFinished(() => {
        document.body.removeChild(outer);
      });
      const shadowOuter = outer.attachShadow({mode: 'open'});
      const inner = document.createElement('div');
      shadowOuter.appendChild(inner);
      const shadowInner = inner.attachShadow({mode: 'open'});
      const editorDiv = document.createElement('div');
      editorDiv.setAttribute('data-lexical-editor', 'true');
      shadowInner.appendChild(editorDiv);

      // Mirrors devtools queryLexicalNodes / LexicalUpdates' iterContentEditables.
      const out: Element[] = [];
      function collect(root: Document | ShadowRoot): void {
        for (const el of root.querySelectorAll('[data-lexical-editor]')) {
          out.push(el);
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot !== null) {
            collect(el.shadowRoot);
          }
        }
      }
      collect(document);

      expect(out).toContain(editorDiv);
    });

    test('descends open shadow roots from elementFromPoint', () => {
      const outer = document.createElement('div');
      outer.style.position = 'fixed';
      outer.style.left = '0';
      outer.style.top = '0';
      outer.style.width = '40px';
      outer.style.height = '40px';
      document.body.appendChild(outer);
      onTestFinished(() => {
        document.body.removeChild(outer);
      });
      const shadow = outer.attachShadow({mode: 'open'});
      const inner = document.createElement('div');
      inner.style.width = '40px';
      inner.style.height = '40px';
      shadow.appendChild(inner);

      // Mirrors devtools element-picker's descent loop.
      let hit: Element | null = document.elementFromPoint(10, 10);
      while (hit !== null && hit.shadowRoot !== null) {
        const next = hit.shadowRoot.elementFromPoint(10, 10);
        if (next === null || next === hit) {
          break;
        }
        hit = next;
      }

      expect(hit).toBe(inner);
    });
  });

  describe('scroll listener attached to a shadow root', () => {
    // getDOMShadowRoots walks every enclosing shadow root for a deeply
    // nested node, innermost first. LexicalMenu's reposition path now
    // keys this walk off the editor root (not the floating target), but
    // the walk semantics — listener attachment order, multi-level
    // coverage — still need to hold whenever a caller passes a node
    // sitting inside nested shadow trees.
    test('catches scrolls at every enclosing shadow root for a nested node', async () => {
      const outerHost = document.createElement('div');
      document.body.appendChild(outerHost);
      onTestFinished(() => {
        document.body.removeChild(outerHost);
      });
      const outerShadow = outerHost.attachShadow({mode: 'open'});

      // Outer scroller wraps the inner shadow host.
      const outerScroller = document.createElement('div');
      outerScroller.style.height = '60px';
      outerScroller.style.overflow = 'auto';
      const innerHost = document.createElement('div');
      innerHost.style.height = '400px';
      outerScroller.appendChild(innerHost);
      outerShadow.appendChild(outerScroller);
      const innerShadow = innerHost.attachShadow({mode: 'open'});

      // Inner scroller inside the inner shadow.
      const innerScroller = document.createElement('div');
      innerScroller.style.height = '40px';
      innerScroller.style.overflow = 'auto';
      const innerTall = document.createElement('div');
      innerTall.style.height = '300px';
      const target = document.createElement('span');
      target.textContent = 'target';
      innerTall.appendChild(target);
      innerScroller.appendChild(innerTall);
      innerShadow.appendChild(innerScroller);

      // Walk every enclosing shadow root via getDOMShadowRoots and attach a
      // listener on each. (LexicalMenu's reposition path now walks from the
      // editor root rather than the target, but the same multi-level walk
      // semantics apply whichever node a caller hands in.)
      const enclosing = getDOMShadowRoots(target);
      expect(enclosing).toEqual([innerShadow, outerShadow]);

      let firedFor: ShadowRoot[] = [];
      const handlersByRoot = new Map<ShadowRoot, () => void>();
      for (const root of enclosing) {
        const handler = () => {
          firedFor.push(root);
        };
        handlersByRoot.set(root, handler);
        root.addEventListener('scroll', handler, {
          capture: true,
          passive: true,
        });
      }
      onTestFinished(() => {
        for (const [root, handler] of handlersByRoot) {
          root.removeEventListener('scroll', handler, true);
        }
      });

      // Scrolling the outer scroller fires on the outer shadow only.
      outerScroller.scrollTop = 50;
      await new Promise<void>(resolve =>
        requestAnimationFrame(() => resolve()),
      );
      expect(firedFor).toEqual([outerShadow]);

      // Scrolling the inner scroller fires on the inner shadow only.
      firedFor = [];
      innerScroller.scrollTop = 50;
      await new Promise<void>(resolve =>
        requestAnimationFrame(() => resolve()),
      );
      expect(firedFor).toEqual([innerShadow]);
    });

    // Comment 8 regression: editor + scroll container live in an open
    // shadow root, floating menu portaled to document.body. Keying
    // getDOMShadowRoots off the portaled target (the original bug)
    // returns [] and registers no shadow listener, so internal scrolls
    // never reposition the menu. The fix keys off the editor root.
    test('keys the walk off the editor root when the target is portaled to light DOM', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      onTestFinished(() => host.remove());
      const shadow = host.attachShadow({mode: 'open'});

      const editorScroller = document.createElement('div');
      editorScroller.style.height = '60px';
      editorScroller.style.overflow = 'auto';
      const editorRoot = document.createElement('div');
      editorRoot.style.height = '400px';
      editorScroller.appendChild(editorRoot);
      shadow.appendChild(editorScroller);

      const target = document.createElement('div');
      document.body.appendChild(target);
      onTestFinished(() => target.remove());

      // The original bug: walking from the portaled target sees nothing.
      expect(getDOMShadowRoots(target)).toEqual([]);
      // The fix: walking from the editor root reaches the shadow.
      expect(getDOMShadowRoots(editorRoot)).toEqual([shadow]);

      let shadowScrollFired = false;
      const handler = () => {
        shadowScrollFired = true;
      };
      shadow.addEventListener('scroll', handler, {
        capture: true,
        passive: true,
      });
      onTestFinished(() => shadow.removeEventListener('scroll', handler, true));

      editorScroller.scrollTop = 50;
      await new Promise<void>(resolve =>
        requestAnimationFrame(() => resolve()),
      );
      expect(shadowScrollFired).toBe(true);
    });
  });

  test('findAllLexicalElementsDeep yields elements inside open shadow roots', () => {
    // Regression cover for findEditorRootByKey's silent move→copy degrade:
    // a flat doc.querySelectorAll for [data-lexical-editor="true"] cannot see
    // editors mounted inside a shadow tree, so the helper has to descend.
    const host = document.createElement('div');
    const shadow = host.attachShadow({mode: 'open'});
    const target = document.createElement('div');
    target.setAttribute('data-lexical-editor', 'true');
    shadow.appendChild(target);
    document.body.appendChild(host);
    onTestFinished(() => host.remove());

    const found = Array.from(findAllLexicalElementsDeep(document));
    expect(found).toEqual([target]);
  });

  test('findAllLexicalElementsDeep descends through nested shadow roots', () => {
    const outerHost = document.createElement('div');
    const outerShadow = outerHost.attachShadow({mode: 'open'});
    const innerHost = document.createElement('div');
    const innerShadow = innerHost.attachShadow({mode: 'open'});
    const target = document.createElement('div');
    target.setAttribute('data-lexical-editor', 'true');
    innerShadow.appendChild(target);
    outerShadow.appendChild(innerHost);
    document.body.appendChild(outerHost);
    onTestFinished(() => outerHost.remove());

    const found = Array.from(findAllLexicalElementsDeep(document));
    expect(found).toEqual([target]);
  });

  describe('getActiveElementDeep through nested shadow roots', () => {
    test('descends to the focused element while the shallow read stops at the host', () => {
      // Two-level shadow nesting with a focused <input> at the bottom. This is
      // the shape `$updateDOMSelection`'s gate needs to identify so a foreign
      // input inside a decorator's nested shadow root isn't mis-attributed to
      // the outer editor under a collaboration update.
      const outerHost = document.createElement('div');
      document.body.appendChild(outerHost);
      const outerShadow = outerHost.attachShadow({mode: 'open'});
      const innerHost = document.createElement('div');
      outerShadow.appendChild(innerHost);
      const innerShadow = innerHost.attachShadow({mode: 'open'});
      const input = document.createElement('input');
      innerShadow.appendChild(input);
      onTestFinished(() => outerHost.remove());

      input.focus();

      // Shallow retargets to the outermost shadow host.
      expect(getActiveElement(document)).toBe(outerHost);
      // Deep descends through both shadow boundaries to the input itself.
      expect(getActiveElementDeep(document)).toBe(input);
    });
  });

  describe('selectionchange attribution under nesting', () => {
    test('attributes to the inner shadow-mounted editor over its light-DOM parent', async () => {
      // Outer editor in the light DOM; inner editor inside an open shadow root
      // nested in the outer host. Without the shadow-mounted-first ordering in
      // onDocumentSelectionChange, the outer editor's getNearestEditorFromDOMNode
      // walk would reach the inner host first and the outer editor would win
      // attribution — even though the selection actually lives in the inner.
      const outerHost = document.createElement('div');
      outerHost.contentEditable = 'true';
      document.body.appendChild(outerHost);

      const outerEditor = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $prepopulate('Outer light DOM'),
          name: 'shadow-attribution-outer',
          onError: error => {
            throw error;
          },
        }),
      );
      outerEditor.setRootElement(outerHost);

      const innerHost = document.createElement('div');
      outerHost.appendChild(innerHost);
      // Mark the inner host as unmanaged so the outer editor's reconciler
      // leaves the nested subtree alone.
      setDOMUnmanaged(innerHost);
      const innerShadow = innerHost.attachShadow({mode: 'open'});
      const innerContentEditable = document.createElement('div');
      innerContentEditable.contentEditable = 'true';
      innerShadow.appendChild(innerContentEditable);

      const innerEditor = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => $prepopulate('Inner shadow root'),
          name: 'shadow-attribution-inner',
          onError: error => {
            throw error;
          },
        }),
      );
      innerEditor.setRootElement(innerContentEditable);

      onTestFinished(() => {
        innerEditor.setRootElement(null);
        outerEditor.setRootElement(null);
        outerHost.remove();
      });

      // Flush the outer editor's mutation observer after appending innerHost,
      // before changing the native selection. Otherwise its setup update can
      // import WebKit's host-retargeted selection and notify independently of
      // onDocumentSelectionChange, which is what this test is attributing.
      await Promise.resolve();
      await Promise.resolve();

      // Observe only notifications caused by the native selection change.
      let outerHits = 0;
      let innerHits = 0;
      const cleanupOuter = outerEditor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          outerHits += 1;
          return false;
        },
        COMMAND_PRIORITY_LOW,
      );
      const cleanupInner = innerEditor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          innerHits += 1;
          return false;
        },
        COMMAND_PRIORITY_LOW,
      );
      onTestFinished(() => {
        cleanupInner();
        cleanupOuter();
      });

      // Drop the caret inside the inner editor's text node and dispatch a
      // synthetic selectionchange — Selection.setBaseAndExtent across shadow
      // boundaries is the supported platform path here.
      const innerTextNode = getInnerTextNode(innerContentEditable);
      const selection = innerContentEditable.ownerDocument.getSelection();
      assert(selection !== null);
      selection.setBaseAndExtent(innerTextNode, 0, innerTextNode, 0);
      document.dispatchEvent(new Event('selectionchange'));

      // Drain multiple microtask ticks: the deferred selectionchange handler
      // may dispatch SELECTION_CHANGE_COMMAND through another microtask.
      await Promise.resolve();
      await Promise.resolve();

      expect(innerHits).toBeGreaterThan(0);
      expect(outerHits).toBe(0);
      expect(outerEditor.read('latest', $getSelection)).toBe(null);
    });
  });

  describe('caretFromPoint shadow fallback', () => {
    test('resolves a text node and offset inside the shadow tree', () => {
      const {contentEditable} = setUpShadowEditor('Hello world');
      const textNode = getInnerTextNode(contentEditable);
      // Place a collapsed range at offset 5 ("Hello|") to get its coordinates.
      const range = document.createRange();
      range.setStart(textNode, 5);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      // caretFromPoint should resolve back to the same text node near offset 5.
      const result = caretFromPoint(
        rect.left,
        rect.top + rect.height / 2,
        contentEditable,
      );
      expect(result).not.toBeNull();
      expect(result!.node).toBe(textNode);
      expect(result!.offset).toBeGreaterThanOrEqual(4);
      expect(result!.offset).toBeLessThanOrEqual(6);
    });

    test('returns null for coordinates outside the editor', () => {
      const {contentEditable} = setUpShadowEditor('Hello');
      // Coordinates far outside the editor.
      const result = caretFromPoint(-9999, -9999, contentEditable);
      expect(result).toBeNull();
    });

    test('vertical-first comparison picks the correct line on a wrapped span', () => {
      // Single text node forced to wrap via break-all into 2+ lines with
      // unequal widths (7 chars in a narrow container).  Drop at (x =
      // right edge of line 1, y = line 2 midpoint).  Euclidean distance
      // (Math.hypot) picks line 1's right-end caret; vertical-first
      // correctly picks line 2.
      const {contentEditable} = setUpShadowEditor('AAAAAAA');
      contentEditable.style.width = '40px';
      contentEditable.style.wordBreak = 'break-all';
      contentEditable.style.font = '16px monospace';

      const textNode = getInnerTextNode(contentEditable);
      const originalCaretPos = document.caretPositionFromPoint;
      document.caretPositionFromPoint =
        undefined as unknown as typeof document.caretPositionFromPoint;
      onTestFinished(() => {
        document.caretPositionFromPoint = originalCaretPos;
      });

      const rects = (() => {
        const r = document.createRange();
        r.selectNodeContents(textNode);
        return Array.from(r.getClientRects());
      })();
      assert(rects.length >= 2, 'text must wrap into at least 2 lines');
      const firstLineRect = rects[0];
      const secondLineRect = rects[1];
      assert(
        firstLineRect.width > secondLineRect.width,
        'line 1 must be wider than line 2 for the mispick scenario',
      );
      // Drop at right edge of line 1, vertically on line 2.
      const dropX = firstLineRect.right - 2;
      const dropY = secondLineRect.top + secondLineRect.height / 2;

      const result = caretFromPoint(dropX, dropY, contentEditable);
      expect(result).not.toBeNull();
      expect(result!.node).toBe(textNode);
      // The resolved offset must be on the second line.
      const verifyRange = document.createRange();
      verifyRange.setStart(result!.node, result!.offset);
      verifyRange.collapse(true);
      const caretRect = verifyRange.getBoundingClientRect();
      expect(caretRect.top).toBeGreaterThanOrEqual(secondLineRect.top - 1);
    });

    test('falls through to caretRangeFromPoint when element has no text nodes', () => {
      const {contentEditable} = setUpShadowEditor('Hello');
      // Stub caretPositionFromPoint to force the fallback path.
      const originalCaretPos = document.caretPositionFromPoint;
      document.caretPositionFromPoint =
        undefined as unknown as typeof document.caretPositionFromPoint;
      onTestFinished(() => {
        document.caretPositionFromPoint = originalCaretPos;
      });

      // Insert an empty div inside the shadow editor so elementFromPoint
      // hits an element with no text children.
      const emptyDiv = document.createElement('div');
      emptyDiv.style.height = '20px';
      emptyDiv.style.width = '100px';
      contentEditable.prepend(emptyDiv);

      const rect = emptyDiv.getBoundingClientRect();
      const result = caretFromPoint(
        rect.left + 5,
        rect.top + 5,
        contentEditable,
      );
      // findTextOffsetAtPoint returns null (no text in emptyDiv), so
      // caretFromPoint falls through to caretRangeFromPoint.  The
      // important invariant: no silent snap to {emptyDiv, 0}.
      expect(result).not.toBeNull();
      expect(result!.node).not.toBe(emptyDiv);
    });
  });
});
