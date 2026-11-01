/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $generateDOMFromRoot,
  $generateHtmlFromNodes,
  $getRenderContextValue,
  domOverride,
  DOMRenderExtension,
  RenderContextRoot,
} from '@lexical/html';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getDOMSlot,
  $getRoot,
  $getState,
  $getStateChange,
  $isElementDOMSlot,
  $isElementNode,
  $setState,
  configExtension,
  createState,
  defineExtension,
  isHTMLElement,
  LineBreakNode,
  setDOMUnmanaged,
  TextNode,
} from 'lexical';
import {expectHtmlToBeEqual, html} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

const idState = createState('id', {
  parse: v => (typeof v === 'string' ? v : null),
});

describe('DOMRenderExtension', () => {
  test('can override DOM create + update', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const root = $getRoot();
          $setState(root, idState, 'root').append(
            $setState($createParagraphNode(), idState, 'paragraph').append(
              $setState($createTextNode('text!'), idState, 'text'),
            ),
          );
        },
        dependencies: [
          configExtension(DOMRenderExtension, {
            overrides: [
              domOverride('*', {
                $createDOM(node, $next) {
                  const result = $next();
                  const id = $getState(node, idState);
                  if (id) {
                    result.setAttribute('id', id);
                  }
                  return result;
                },
                $updateDOM(nextNode, prevNode, dom, $next) {
                  if ($next()) {
                    return true;
                  }
                  const change = $getStateChange(nextNode, prevNode, idState);
                  if (change) {
                    const [id] = change;
                    if (id) {
                      dom.setAttribute('id', id);
                    } else {
                      dom.removeAttribute('id');
                    }
                  }
                  return false;
                },
              }),
            ],
          }),
        ],
        name: 'root',
      }),
    );
    const root = document.createElement('div');
    editor.setRootElement(root);
    expect(
      editor.read(() => {
        expectHtmlToBeEqual(
          root.innerHTML,
          html`
            <p id="paragraph" dir="auto">
              <span id="text" data-lexical-text="true">text!</span>
            </p>
          `,
        );
      }),
    );
    editor.update(
      () =>
        $getRoot()
          .getAllTextNodes()
          .forEach(node => $setState(node, idState, prev => `${prev}-updated`)),
      {discrete: true},
    );
    // Update works too
    expect(
      editor.read(() => {
        expectHtmlToBeEqual(
          root.innerHTML,
          html`
            <p id="paragraph" dir="auto">
              <span id="text-updated" data-lexical-text="true">text!</span>
            </p>
          `,
        );
      }),
    );
    editor.update(
      () =>
        $getRoot()
          .getAllTextNodes()
          .forEach(node => $setState(node, idState, null)),
      {discrete: true},
    );
    expect(
      editor.read(() => {
        expectHtmlToBeEqual(
          root.innerHTML,
          html`
            <p id="paragraph" dir="auto">
              <span data-lexical-text="true">text!</span>
            </p>
          `,
        );
      }),
    );
  });
  test.each([false, true])(
    '$createDOM overrides apply to HTML export (with root: %s)',
    withRoot => {
      using editor = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => {
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('plain'),
                $createLineBreakNode(),
                $createTextNode('bold').setFormat('bold'),
              ),
            );
          },
          dependencies: [
            configExtension(DOMRenderExtension, {
              overrides: [
                domOverride('*', {
                  $createDOM(node, $next) {
                    const dom = $next();
                    dom.setAttribute('data-node-type', node.getType());
                    return dom;
                  },
                }),
              ],
            }),
          ],
          name: 'export-create-dom',
        }),
      );
      const root = document.createElement('div');
      if (withRoot) {
        editor.setRootElement(root);
      }
      editor.read(() => {
        if (withRoot) {
          expect(root.querySelectorAll('[data-node-type]')).toHaveLength(4);
        }
        expectHtmlToBeEqual(
          $generateHtmlFromNodes(editor),
          html`
            <p data-node-type="paragraph">
              <span style="white-space: pre-wrap;" data-node-type="text">
                plain
              </span>
              <br data-node-type="linebreak" />
              <b>
                <strong style="white-space: pre-wrap;" data-node-type="text">
                  bold
                </strong>
              </b>
            </p>
          `,
        );
      });
    },
  );
  test('can override DOM export', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const root = $getRoot();
          $setState(root, idState, 'root').append(
            $setState($createParagraphNode(), idState, 'paragraph').append(
              $setState($createTextNode('text!'), idState, 'text'),
            ),
          );
        },
        dependencies: [
          configExtension(DOMRenderExtension, {
            overrides: [
              domOverride('*', {
                $exportDOM(node, $next) {
                  const result = $next();
                  const id = $getState(node, idState);
                  if (id && isHTMLElement(result.element)) {
                    result.element.setAttribute('id', id);
                  }
                  return result;
                },
              }),
              domOverride([TextNode], {
                $exportDOM(node, $next) {
                  const result = $next();
                  if (
                    $getRenderContextValue(RenderContextRoot) &&
                    isHTMLElement(result.element) &&
                    result.element.style.getPropertyValue('white-space') ===
                      'pre-wrap' &&
                    // we know there aren't tabs or newlines but if there are
                    // leading, trailing, or adjacent spaces then we need the
                    // pre-wrap to preserve the content
                    !/^\s|\s$|\s\s/.test(result.element.textContent)
                  ) {
                    result.element.style.setProperty('white-space', null);
                    if (result.element.style.cssText === '') {
                      result.element.removeAttribute('style');
                    }
                  }
                  return result;
                },
              }),
            ],
          }),
        ],
        name: 'root',
      }),
    );
    expect(
      editor.read(() => {
        expectHtmlToBeEqual(
          $generateDOMFromRoot(document.createElement('div')).innerHTML,
          html`
            <div id="root" role="textbox">
              <p id="paragraph">
                <span id="text">text!</span>
              </p>
            </div>
          `,
        );
      }),
    );
  });
  test('$decorateDOM runs on create and update with correct prevNode', () => {
    type Call = {
      key: string;
      prevKey: null | string;
      id: null | string;
    };
    const calls: Call[] = [];
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $setState($createTextNode('text!'), idState, 'text');
          $getRoot().append(
            $createParagraphNode().append(
              $setState($createTextNode('text!'), idState, 'text'),
            ),
          );
        },
        dependencies: [
          configExtension(DOMRenderExtension, {
            overrides: [
              domOverride([TextNode], {
                $decorateDOM(nextNode, prevNode, dom) {
                  calls.push({
                    id: $getState(nextNode, idState),
                    key: nextNode.getKey(),
                    prevKey: prevNode ? prevNode.getKey() : null,
                  });
                  const id = $getState(nextNode, idState);
                  if (id) {
                    dom.setAttribute('id', id);
                  } else {
                    dom.removeAttribute('id');
                  }
                },
              }),
            ],
          }),
        ],
        name: 'root',
      }),
    );
    const root = document.createElement('div');
    editor.setRootElement(root);
    expect(calls).toHaveLength(1);
    expect(calls[0].prevKey).toBe(null);
    expect(calls[0].id).toBe('text');
    expect(
      editor.read(() => {
        expectHtmlToBeEqual(
          root.innerHTML,
          html`
            <p dir="auto">
              <span id="text" data-lexical-text="true">text!</span>
            </p>
          `,
        );
      }),
    );
    editor.update(
      () =>
        $getRoot()
          .getAllTextNodes()
          .forEach(node => $setState(node, idState, 'updated')),
      {discrete: true},
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].prevKey).toBe(calls[0].key);
    expect(calls[1].id).toBe('updated');
    expect(
      editor.read(() => {
        expectHtmlToBeEqual(
          root.innerHTML,
          html`
            <p dir="auto">
              <span id="updated" data-lexical-text="true">text!</span>
            </p>
          `,
        );
      }),
    );
  });
  test('$decorateDOM overrides all run in order (base, specific, wildcard last)', () => {
    class TextNodeA extends TextNode {
      $config() {
        return this.config('text-a', {extends: TextNode});
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createParagraphNode().append(
              $create(TextNodeA).setTextContent('text a'),
            ),
          );
        },
        dependencies: [
          configExtension(DOMRenderExtension, {
            overrides: [
              domOverride('*', {
                $decorateDOM(_nextNode, _prevNode, dom) {
                  dom.dataset.order = `${dom.dataset.order || ''}wildcard;`;
                },
              }),
              domOverride([TextNodeA], {
                $decorateDOM(_nextNode, _prevNode, dom) {
                  dom.dataset.order = `${dom.dataset.order || ''}text-a;`;
                },
              }),
              domOverride([TextNode], {
                $decorateDOM(_nextNode, _prevNode, dom) {
                  dom.dataset.order = `${dom.dataset.order || ''}text;`;
                },
              }),
            ],
          }),
        ],
        name: 'root',
        nodes: [TextNodeA],
      }),
    );
    const root = document.createElement('div');
    editor.setRootElement(root);
    expect(
      editor.read(() => {
        expectHtmlToBeEqual(
          root.innerHTML,
          html`
            <p dir="auto" data-order="wildcard;">
              <span data-lexical-text="true" data-order="text;text-a;wildcard;">
                text a
              </span>
            </p>
          `,
        );
      }),
    );
  });
  test('$decorateDOM runs after children are reconciled', () => {
    const childCounts: {type: string; count: number}[] = [];
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('a'),
              $createLineBreakNode(),
              $createTextNode('b'),
            ),
          );
        },
        dependencies: [
          configExtension(DOMRenderExtension, {
            overrides: [
              domOverride('*', {
                $decorateDOM(nextNode, _prevNode, dom) {
                  const type = nextNode.getType();
                  if (type === 'paragraph' || type === 'root') {
                    childCounts.push({count: dom.childNodes.length, type});
                  }
                },
              }),
            ],
          }),
        ],
        name: 'root',
      }),
    );
    const root = document.createElement('div');
    editor.setRootElement(root);
    expect(childCounts).toEqual([
      {count: 3, type: 'paragraph'},
      {count: 1, type: 'root'},
    ]);
  });
  test('type merge', () => {
    class TextNodeA extends TextNode {
      $config() {
        return this.config('text-a', {extends: TextNode});
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createParagraphNode().append(
              $create(TextNodeA).setTextContent('text a'),
              $createLineBreakNode(),
              $createTextNode().setTextContent('plain text'),
            ),
          );
        },
        dependencies: [
          configExtension(DOMRenderExtension, {
            overrides: [
              domOverride([TextNode], {
                $exportDOM(node) {
                  const span = document.createElement('span');
                  span.append(node.getTextContent());
                  return {element: span};
                },
              }),
              domOverride([TextNodeA], {
                $exportDOM(node, $next) {
                  // We want to call $next to get any export behavior
                  // that applies to all TextNode, if we return
                  // a new value we will only get export behavior that
                  // applies to predicates, wildcards, and TextNodeA
                  const r = $next();
                  if (isHTMLElement(r.element)) {
                    r.element.dataset.lexicalType = node.getType();
                  }
                  return r;
                },
              }),
              domOverride([TextNode], {
                $exportDOM(node, $next) {
                  const r = $next();
                  if (isHTMLElement(r.element)) {
                    r.element.dataset.didOverride = 'true';
                  }
                  return r;
                },
              }),
            ],
          }),
        ],
        name: 'root',
        nodes: [TextNodeA],
      }),
    );
    expect(
      editor.read(() => {
        expectHtmlToBeEqual(
          $generateDOMFromRoot(document.createElement('div')).innerHTML,
          html`
            <div role="textbox">
              <p>
                <span data-did-override="true" data-lexical-type="text-a">
                  text a
                </span>
                <br />
                <span data-did-override="true">plain text</span>
              </p>
            </div>
          `,
        );
      }),
    );
  });

  test('leaf-node extension can wrap createDOM and expose inner via $getDOMSlot (visible-linebreak)', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('before'),
              $createLineBreakNode(),
              $createTextNode('after'),
            ),
          );
        },
        dependencies: [
          configExtension(DOMRenderExtension, {
            overrides: [
              domOverride([LineBreakNode], {
                $createDOM: (_node, $next) => {
                  const br = $next();
                  const wrapper = document.createElement('span');
                  wrapper.setAttribute('data-visible-linebreak', 'true');
                  const marker = document.createElement('span');
                  marker.textContent = '↵';
                  marker.contentEditable = 'false';
                  marker.setAttribute('aria-hidden', 'true');
                  wrapper.appendChild(marker);
                  wrapper.appendChild(br);
                  return wrapper;
                },
                $getDOMSlot: (_node, dom, $next) => {
                  const br = dom.querySelector('br');
                  return isHTMLElement(br) ? $next().withElement(br) : $next();
                },
              }),
            ],
          }),
        ],
        name: 'visible-linebreak-example',
      }),
    );
    const root = document.createElement('div');
    editor.setRootElement(root);
    editor.read(() => {
      expectHtmlToBeEqual(
        root.innerHTML,
        html`
          <p dir="auto">
            <span data-lexical-text="true">before</span>
            <span data-visible-linebreak="true">
              <span contenteditable="false" aria-hidden="true">↵</span>
              <br />
            </span>
            <span data-lexical-text="true">after</span>
          </p>
        `,
      );
    });
  });

  test('default leaf-node slot returns DOMSlot pointing at keyed DOM', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createParagraphNode().append($createLineBreakNode()),
          );
        },
        dependencies: [],
        name: 'default-leaf-slot',
      }),
    );
    const root = document.createElement('div');
    editor.setRootElement(root);
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert(
        $isElementNode(paragraph),
        'expected paragraph to be an ElementNode',
      );
      const [linebreak] = paragraph.getChildren();
      const dom = editor.getElementByKey(linebreak.getKey())!;
      const slot = linebreak.getDOMSlot(dom);
      expect($isElementDOMSlot(slot)).toBe(false);
      expect(slot.element).toBe(dom);
    });
  });

  test('$getDOMSlot returns ElementDOMSlot for ElementNode through the hook', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('hello')),
          );
        },
        dependencies: [],
        name: 'element-slot-helper',
      }),
    );
    const root = document.createElement('div');
    editor.setRootElement(root);
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(paragraph), 'expected paragraph');
      const dom = editor.getElementByKey(paragraph.getKey())!;
      const slot = $getDOMSlot(paragraph, dom, editor);
      assert($isElementDOMSlot(slot), 'slot must be an ElementDOMSlot');
      expect(slot.element).toBe(dom);
    });
  });

  test('$setTextContent routes text writes through a TextNode $getDOMSlot override', () => {
    // A DOMRenderExtension parks a contentEditable=false prelude as the first
    // child of each TextNode's span and exposes the text-bearing range as
    // starting after it (slot.after). An in-place text edit must consult this
    // editor-level $getDOMSlot override — not dom.firstChild — so it updates
    // the text node sitting after the prelude rather than mangling the prelude
    // or appending a duplicate text node.
    const PRELUDE_ATTR = 'data-test-prelude';
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('hello')),
          );
        },
        dependencies: [
          configExtension(DOMRenderExtension, {
            overrides: [
              domOverride([TextNode], {
                $createDOM: (_node, $next) => {
                  const el = $next();
                  const prelude = document.createElement('span');
                  prelude.setAttribute(PRELUDE_ATTR, 'true');
                  prelude.contentEditable = 'false';
                  prelude.textContent = '§';
                  // Keep the mutation observer from evicting the decoration.
                  setDOMUnmanaged(prelude);
                  el.insertBefore(prelude, el.firstChild);
                  return el;
                },
                $getDOMSlot: (_node, dom, $next) => {
                  const prelude = dom.querySelector(
                    `:scope > [${PRELUDE_ATTR}]`,
                  );
                  return isHTMLElement(prelude)
                    ? $next().withAfter(prelude)
                    : $next();
                },
              }),
            ],
          }),
        ],
        name: 'textnode-slot-reroute',
      }),
    );
    const root = document.createElement('div');
    editor.setRootElement(root);

    let textKey = '';
    editor.read(() => {
      textKey = $getRoot().getAllTextNodes()[0].getKey();
    });
    const span = editor.getElementByKey(textKey) as HTMLElement;
    const textNodesIn = (el: HTMLElement) =>
      Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);

    // Initial render: [prelude, "hello"].
    expect(span.querySelector(`[${PRELUDE_ATTR}]`)).not.toBe(null);
    expect(textNodesIn(span).map(n => n.nodeValue)).toEqual(['hello']);

    // In-place text edit.
    editor.update(
      () => {
        $getRoot().getAllTextNodes()[0].setTextContent('world');
      },
      {discrete: true},
    );

    // The prelude stays the leading child and the single text node after it is
    // updated in place — proving the write went through the slot, not
    // dom.firstChild (which would mangle the prelude or duplicate the text).
    const prelude = span.querySelector(`[${PRELUDE_ATTR}]`);
    expect(prelude).not.toBe(null);
    expect(span.firstChild).toBe(prelude);
    expect(textNodesIn(span).map(n => n.nodeValue)).toEqual(['world']);
  });
});
