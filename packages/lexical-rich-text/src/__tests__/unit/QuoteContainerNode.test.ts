/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getHtmlContent,
  $getLexicalContent,
  $insertDataTransferForRichText,
} from '@lexical/clipboard';
import {
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
  NodeStructureExtension,
} from '@lexical/extension';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOM,
  DOMImportExtension,
} from '@lexical/html';
import {$insertList, ListExtension} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteContainerNode,
  $createQuoteNode,
  $isQuoteContainerNode,
  $isQuoteNode,
  QuoteContainerExtension,
  QuoteContainerNode,
  QuoteContainerReplacementExtension,
  QuoteContainerRule,
  QuoteNode,
  RichTextExtension,
  ShadowRootQuoteRule,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getEditor,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type AnyLexicalExtensionArgument,
  configExtension,
  defineExtension,
  type ElementNode,
  getDeclaredNodeStructure,
  type LexicalNode,
  type RangeSelection,
  type SerializedEditorState,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';

function createEditor(
  ...dependencies: AnyLexicalExtensionArgument[]
): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(
    defineExtension({dependencies, name: 'quote-container-host'}),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  editor.setRootElement(container);
  onTestFinished(() => {
    editor.setRootElement(null);
    container.remove();
    editor.dispose();
  });
  return editor;
}

/** `type(children…)`, text in quotes: the shape of a node and what it holds. */
function $describe(node: LexicalNode): string {
  return $isElementNode(node)
    ? `${node.getType()}(${node.getChildren().map($describe).join(' ')})`
    : JSON.stringify(node.getTextContent());
}

const describeRoot = (editor: LexicalEditorWithDispose): string =>
  editor.read(() => $getRoot().getChildren().map($describe).join(' / '));

const $p = (text?: string) =>
  text === undefined
    ? $createParagraphNode()
    : $createParagraphNode().append($createTextNode(text));

function $setRoot(...nodes: LexicalNode[]): void {
  $getRoot()
    .clear()
    .append(...nodes);
}

/** The block at `path` (child indexes from the root). */
function $block(path: number[]): ElementNode {
  let node: ElementNode = $getRoot();
  for (const index of path) {
    const child = node.getChildAtIndex(index);
    assert($isElementNode(child), `no element at ${path.join('.')}`);
    node = child;
  }
  return node;
}

/** A collapsed selection at `offset` of the first text of the block at `path`. */
function $selectIn(path: number[], offset: number): RangeSelection {
  const block = $block(path);
  const text = block.getFirstChild();
  const selection = $isTextNode(text)
    ? text.select(offset, offset)
    : block.select(0, 0);
  return selection;
}

function update(editor: LexicalEditorWithDispose, fn: () => void): void {
  editor.update(fn, {discrete: true});
}

/** Imports `html` through the node classes' importDOM. */
function $generate(html: string): LexicalNode[] {
  return $generateNodesFromDOM(
    $getEditor(),
    new DOMParser().parseFromString(html, 'text/html'),
  );
}

/** Imports `html` through the DOMImportExtension pipeline. */
function importHtml(editor: LexicalEditorWithDispose, html: string): void {
  update(editor, () => {
    const dep = getExtensionDependencyFromEditor(editor, DOMImportExtension);
    const dom = new DOMParser().parseFromString(html, 'text/html');
    $setRoot(...dep.output.$generateNodesFromDOM(dom));
  });
}

function dataTransfer(data: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => data[type] || '',
    types: Object.keys(data),
  } as unknown as DataTransfer;
}

describe('QuoteContainerNode', () => {
  test('declares block children, is a shadow root and a quote', () => {
    const editor = createEditor(QuoteContainerExtension);
    expect(QuoteContainerNode.getType()).toBe('quote-container');
    const declared = getDeclaredNodeStructure(QuoteContainerNode);
    expect(declared.children).toBe('block');
    expect(declared.declaredBy.children).toBe(QuoteContainerNode);
    // QuoteNode's own declaration is unchanged.
    expect(getDeclaredNodeStructure(QuoteNode).children).toBe('inline');
    update(editor, () => {
      const quote = $createQuoteContainerNode();
      expect($isQuoteContainerNode(quote)).toBe(true);
      expect($isQuoteNode(quote)).toBe(true);
      expect(quote.isShadowRoot()).toBe(true);
      expect(quote.isInline()).toBe(false);
      // It cannot be turned back into a quote of inline content.
      expect(quote.setIsShadowRoot(false).isShadowRoot()).toBe(true);
      // Registering it changes nothing about QuoteNode.
      const legacy = $createQuoteNode();
      expect($isQuoteContainerNode(legacy)).toBe(false);
      expect(legacy.isShadowRoot()).toBe(false);
      expect(legacy.getType()).toBe('quote');
    });
  });

  test('serializes as quote-container and round-trips', () => {
    const editor = createEditor(QuoteContainerExtension);
    update(editor, () => {
      $setRoot(
        $createQuoteContainerNode()
          .setFormat('center')
          .setDirection('rtl')
          .append(
            $p('one'),
            $createHeadingNode('h2').append($createTextNode('two')),
            $createQuoteContainerNode().append($p('three')),
          ),
      );
    });
    const json = editor.getEditorState().toJSON();
    const quote = json.root.children[0];
    expect(quote).toMatchObject({
      direction: 'rtl',
      format: 'center',
      type: 'quote-container',
      version: 1,
    });
    expect(quote).not.toHaveProperty('shadowRoot');
    const before = describeRoot(editor);
    expect(before).toBe(
      'quote-container(paragraph("one") heading("two") quote-container(paragraph("three")))',
    );
    editor.setEditorState(editor.parseEditorState(JSON.stringify(json)));
    expect(describeRoot(editor)).toBe(before);
    expect(editor.getEditorState().toJSON()).toEqual(json);
  });

  test('renders and exports a <blockquote> with the quote theme class, alignment and direction', () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [QuoteContainerExtension],
        name: 'themed',
        theme: {quote: 'my-quote'},
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    editor.setRootElement(container);
    onTestFinished(() => {
      editor.setRootElement(null);
      container.remove();
      editor.dispose();
    });
    update(editor, () => {
      $setRoot(
        $createQuoteContainerNode()
          .setFormat('right')
          .setDirection('rtl')
          .append($p('a'), $p('b')),
        // The same properties on a QuoteNode, to compare.
        $createQuoteNode()
          .setFormat('right')
          .setDirection('rtl')
          .append($createTextNode('a')),
      );
    });
    const [containerDOM, quoteDOM] = Array.from(container.children);
    expect(containerDOM.tagName).toBe('BLOCKQUOTE');
    expect(containerDOM.className).toBe('my-quote');
    expect(containerDOM.className).toBe(quoteDOM.className);
    expect(containerDOM.getAttribute('dir')).toBe(quoteDOM.getAttribute('dir'));
    expect(containerDOM.getAttribute('style')).toBe(
      quoteDOM.getAttribute('style'),
    );
    expect(Array.from(containerDOM.children).map(c => c.tagName)).toEqual([
      'P',
      'P',
    ]);
    const html = editor.read(() => $generateHtmlFromNodes(editor));
    const exported = new DOMParser().parseFromString(html, 'text/html').body;
    const [exportedContainer, exportedQuote] = Array.from(exported.children);
    assert(exportedContainer instanceof HTMLElement);
    assert(exportedQuote instanceof HTMLElement);
    expect(exportedContainer.tagName).toBe('BLOCKQUOTE');
    expect(exportedContainer.className).toBe('my-quote');
    expect(exportedContainer.dir).toBe('rtl');
    expect(exportedContainer.style.textAlign).toBe('right');
    expect(exportedContainer.dir).toBe(exportedQuote.dir);
    expect(exportedContainer.style.textAlign).toBe(
      exportedQuote.style.textAlign,
    );
    expect(
      Array.from(exportedContainer.children).map(c => [
        c.tagName,
        c.textContent,
      ]),
    ).toEqual([
      ['P', 'a'],
      ['P', 'b'],
    ]);
  });
});

describe('QuoteContainerNode normalization', () => {
  test('inline children are wrapped in paragraphs, a run in one', () => {
    const editor = createEditor(QuoteContainerExtension);
    update(editor, () => {
      $setRoot(
        $createQuoteContainerNode().append(
          $createTextNode('a'),
          $createTextNode('b').toggleFormat('bold'),
          $p('c'),
          $createTextNode('d'),
        ),
      );
    });
    expect(describeRoot(editor)).toBe(
      'quote-container(paragraph("a" "b") paragraph("c") paragraph("d"))',
    );
  });

  test('an empty container gets an empty paragraph', () => {
    const editor = createEditor(QuoteContainerExtension);
    update(editor, () => {
      $setRoot($p('x'), $createQuoteContainerNode());
    });
    expect(describeRoot(editor)).toBe(
      'paragraph("x") / quote-container(paragraph())',
    );
    // So does one whose last block is removed.
    update(editor, () => {
      $block([1, 0]).remove();
    });
    expect(describeRoot(editor)).toBe(
      'paragraph("x") / quote-container(paragraph())',
    );
  });
});

describe('QuoteContainerNode with NodeStructureExtension', () => {
  test('inline children are wrapped, an empty container gets a paragraph, and blocks stay', () => {
    const editor = createEditor(
      QuoteContainerExtension,
      ListExtension,
      NodeStructureExtension,
    );
    update(editor, () => {
      $setRoot(
        $createQuoteContainerNode().append(
          $createTextNode('a'),
          $createHeadingNode('h2').append($createTextNode('b')),
          $createQuoteContainerNode(),
        ),
      );
    });
    expect(describeRoot(editor)).toBe(
      'quote-container(paragraph("a") heading("b") quote-container(paragraph()))',
    );
    // A QuoteNode in the same editor holds inline content: a block in it
    // is lifted out. The container is the one that keeps blocks.
    update(editor, () => {
      $setRoot(
        $createQuoteNode().append(
          $createTextNode('a'),
          $createHeadingNode('h2').append($createTextNode('b')),
        ),
      );
    });
    expect(describeRoot(editor)).toBe('quote("a") / heading("b")');
  });
});

describe('editing in a QuoteContainerNode', () => {
  const $init = () =>
    $setRoot(
      $p('title'),
      $createQuoteContainerNode().append($p('Lorem ipsum'), $p('dolor')),
      $p('end'),
    );

  test('Enter splits the paragraph the caret is in', () => {
    const editor = createEditor(QuoteContainerExtension);
    update(editor, $init);
    update(editor, () => {
      $selectIn([1, 0], 5).insertParagraph();
    });
    expect(describeRoot(editor)).toBe(
      'paragraph("title") / quote-container(paragraph("Lorem") paragraph(" ipsum") paragraph("dolor")) / paragraph("end")',
    );
  });

  test('Backspace at the start of a later paragraph joins it to the one before', () => {
    const editor = createEditor(QuoteContainerExtension);
    update(editor, $init);
    update(editor, () => {
      $selectIn([1, 1], 0).deleteCharacter(true);
    });
    expect(describeRoot(editor)).toBe(
      'paragraph("title") / quote-container(paragraph("Lorem ipsumdolor")) / paragraph("end")',
    );
  });

  test('Backspace at the start of the first block dissolves the container and lifts its blocks out', () => {
    const editor = createEditor(QuoteContainerExtension);
    update(editor, $init);
    update(editor, () => {
      $selectIn([1, 0], 0).deleteCharacter(true);
    });
    expect(describeRoot(editor)).toBe(
      'paragraph("title") / paragraph("Lorem ipsum") / paragraph("dolor") / paragraph("end")',
    );
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.anchor.getNode().getTextContent()).toBe('Lorem ipsum');
      expect(selection.anchor.offset).toBe(0);
    });
  });

  test('collapseAtStart() is what a shadow root QuoteNode does', () => {
    const editor = createEditor(QuoteContainerExtension);
    const collapse = ($quote: () => QuoteNode) => {
      update(editor, () => {
        $setRoot(
          $p('title'),
          $quote().append(
            $p('a'),
            $createHeadingNode('h2').append($createTextNode('b')),
          ),
        );
        const quote = $block([1]);
        assert($isQuoteNode(quote));
        expect(quote.collapseAtStart()).toBe(true);
      });
      return describeRoot(editor);
    };
    const expected = 'paragraph("title") / paragraph("a") / heading("b")';
    expect(collapse(() => $createQuoteContainerNode())).toBe(expected);
    expect(collapse(() => $createQuoteNode({shadowRoot: true}))).toBe(expected);
  });

  test('deleting all its text leaves an empty paragraph, and Backspace then dissolves it', () => {
    const editor = createEditor(QuoteContainerExtension);
    update(editor, () => {
      $setRoot($p('title'), $createQuoteContainerNode().append($p('a')));
      const text = $block([1, 0]).getFirstChild();
      assert($isTextNode(text));
      text.select(0, 1).removeText();
    });
    expect(describeRoot(editor)).toBe(
      'paragraph("title") / quote-container(paragraph())',
    );
    update(editor, () => {
      $selectIn([1, 0], 0).deleteCharacter(true);
    });
    expect(describeRoot(editor)).toBe('paragraph("title") / paragraph()');
  });

  test('insertNewAfter() puts a paragraph after the container, with its alignment and direction', () => {
    const editor = createEditor(QuoteContainerExtension);
    update(editor, () => {
      $setRoot(
        $createQuoteContainerNode()
          .setFormat('center')
          .setDirection('rtl')
          .append($p('a')),
      );
      const quote = $block([0]);
      assert($isQuoteContainerNode(quote));
      const paragraph = quote.insertNewAfter($selectIn([0, 0], 1));
      expect(paragraph.getFormatType()).toBe('center');
      expect(paragraph.getDirection()).toBe('rtl');
    });
    expect(describeRoot(editor)).toBe(
      'quote-container(paragraph("a")) / paragraph()',
    );
  });

  test('a block keeps its top-level element inside the container', () => {
    const editor = createEditor(QuoteContainerExtension);
    update(editor, $init);
    editor.read(() => {
      const paragraph = $block([1, 0]);
      expect(paragraph.getTopLevelElementOrThrow().is(paragraph)).toBe(true);
    });
  });
});

describe('HTML import into a QuoteContainerNode', () => {
  const HTML =
    '<blockquote dir="rtl" style="text-align: center"><p>a</p><h2>b</h2><ul><li>c</li></ul>tail <b>bold</b><blockquote><p>inner</p></blockquote></blockquote>';
  const EXPECTED =
    'quote-container(paragraph("a") heading("b") list(listitem("c")) paragraph("tail " "bold") quote-container(paragraph("inner")))';

  test('QuoteContainerRule builds a container from <blockquote>', () => {
    const editor = createEditor(
      QuoteContainerExtension,
      ListExtension,
      configExtension(DOMImportExtension, {rules: [QuoteContainerRule]}),
    );
    importHtml(editor, HTML);
    expect(describeRoot(editor)).toBe(EXPECTED);
    editor.read(() => {
      const quote = $block([0]);
      expect(quote.getFormatType()).toBe('center');
      expect(quote.getDirection()).toBe('rtl');
    });
  });

  test('without the rule, <blockquote> still imports as a QuoteNode', () => {
    const editor = createEditor(QuoteContainerExtension);
    importHtml(editor, '<blockquote>a</blockquote>');
    expect(describeRoot(editor)).toBe('quote("a")');
  });

  test('ShadowRootQuoteRule still builds a shadow root QuoteNode where the container is registered', () => {
    const editor = createEditor(
      QuoteContainerExtension,
      configExtension(DOMImportExtension, {rules: [ShadowRootQuoteRule]}),
    );
    importHtml(editor, '<blockquote><p>a</p><p>b</p></blockquote>');
    expect(describeRoot(editor)).toBe('quote(paragraph("a") paragraph("b"))');
    editor.read(() => {
      const quote = $block([0]);
      assert($isQuoteNode(quote));
      expect($isQuoteContainerNode(quote)).toBe(false);
      expect(quote.isShadowRoot()).toBe(true);
    });
  });

  test('exported HTML imports back to the same document', () => {
    const editor = createEditor(
      QuoteContainerExtension,
      ListExtension,
      configExtension(DOMImportExtension, {rules: [QuoteContainerRule]}),
    );
    importHtml(editor, HTML);
    const html = editor.read(() => $generateHtmlFromNodes(editor));
    update(editor, () => $setRoot($p('other')));
    importHtml(editor, html);
    expect(describeRoot(editor)).toBe(EXPECTED);
  });
});

describe('QuoteNode replaced by QuoteContainerNode', () => {
  test('$createQuoteNode() makes a container', () => {
    const editor = createEditor(QuoteContainerReplacementExtension);
    update(editor, () => {
      const quote = $createQuoteNode();
      expect($isQuoteContainerNode(quote)).toBe(true);
      expect(quote.getType()).toBe('quote-container');
      expect($isQuoteContainerNode($createQuoteNode({shadowRoot: true}))).toBe(
        true,
      );
      // Code written for QuoteNode appends inline content.
      $setRoot(quote.append($createTextNode('hi')));
    });
    expect(describeRoot(editor)).toBe('quote-container(paragraph("hi"))');
  });

  test('the replacement can be written in the nodes of an editor', () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RichTextExtension],
        name: 'by-hand',
        nodes: () => [
          QuoteContainerNode,
          {
            replace: QuoteNode,
            with: () => $createQuoteContainerNode(),
            withKlass: QuoteContainerNode,
          },
        ],
      }),
    );
    onTestFinished(() => editor.dispose());
    update(editor, () => {
      expect($isQuoteContainerNode($createQuoteNode())).toBe(true);
    });
  });

  const state = (...children: unknown[]): string =>
    JSON.stringify({
      root: {children, type: 'root', version: 1},
    });
  const text = (value: string) => ({text: value, type: 'text', version: 1});
  const paragraph = (...children: unknown[]) => ({
    children,
    type: 'paragraph',
    version: 1,
  });

  test('JSON of a quote with inline children loads with them in a paragraph', () => {
    const editor = createEditor(QuoteContainerReplacementExtension);
    editor.setEditorState(
      editor.parseEditorState(
        state({
          children: [text('a'), {type: 'linebreak', version: 1}, text('b')],
          direction: 'rtl',
          format: 'center',
          type: 'quote',
          version: 1,
        }),
      ),
    );
    expect(describeRoot(editor)).toBe(
      'quote-container(paragraph("a" "\\n" "b"))',
    );
    const json = editor.getEditorState().toJSON();
    expect(json.root.children[0]).toMatchObject({
      direction: 'rtl',
      format: 'center',
      type: 'quote-container',
    });
  });

  test('JSON of a shadow root quote loads with its blocks, and the flag is dropped', () => {
    const editor = createEditor(QuoteContainerReplacementExtension);
    editor.setEditorState(
      editor.parseEditorState(
        state({
          children: [paragraph(text('a')), paragraph(text('b'))],
          shadowRoot: true,
          type: 'quote',
          version: 1,
        }),
      ),
    );
    expect(describeRoot(editor)).toBe(
      'quote-container(paragraph("a") paragraph("b"))',
    );
    const quote = editor.getEditorState().toJSON().root.children[0];
    expect(quote.type).toBe('quote-container');
    expect(quote).not.toHaveProperty('shadowRoot');
    expect(quote).not.toHaveProperty('$');
  });

  test('JSON of an empty quote loads as a container with an empty paragraph', () => {
    const editor = createEditor(QuoteContainerReplacementExtension);
    editor.setEditorState(
      editor.parseEditorState(
        state(paragraph(text('x')), {children: [], type: 'quote', version: 1}),
      ),
    );
    expect(describeRoot(editor)).toBe(
      'paragraph("x") / quote-container(paragraph())',
    );
  });

  test('JSON of a quote-container loads too', () => {
    const editor = createEditor(QuoteContainerReplacementExtension);
    editor.setEditorState(
      editor.parseEditorState(
        state({
          children: [paragraph(text('a'))],
          type: 'quote-container',
          version: 1,
        }),
      ),
    );
    expect(describeRoot(editor)).toBe('quote-container(paragraph("a"))');
  });

  test('without the replacement, quote-container JSON loads as a container', () => {
    const editor = createEditor(QuoteContainerExtension);
    editor.setEditorState(
      editor.parseEditorState(
        state({
          children: [paragraph(text('a'))],
          type: 'quote-container',
          version: 1,
        }),
      ),
    );
    expect(describeRoot(editor)).toBe('quote-container(paragraph("a"))');
  });

  test('without the replacement, the same JSON still loads as QuoteNodes', () => {
    const editor = createEditor(QuoteContainerExtension);
    const json = state(
      {children: [text('a')], type: 'quote', version: 1},
      {
        children: [paragraph(text('b'))],
        shadowRoot: true,
        type: 'quote',
        version: 1,
      },
    );
    editor.setEditorState(editor.parseEditorState(json));
    expect(describeRoot(editor)).toBe('quote("a") / quote(paragraph("b"))');
    const exported: SerializedEditorState = editor.getEditorState().toJSON();
    expect(exported.root.children.map(child => child.type)).toEqual([
      'quote',
      'quote',
    ]);
    expect(exported.root.children[0]).not.toHaveProperty('shadowRoot');
    expect(exported.root.children[1]).toMatchObject({shadowRoot: true});
  });

  test('<blockquote> imports as a container through the import rules', () => {
    const editor = createEditor(
      QuoteContainerReplacementExtension,
      ListExtension,
    );
    importHtml(
      editor,
      '<blockquote><p>a</p><ul><li>b</li></ul>tail</blockquote>',
    );
    expect(describeRoot(editor)).toBe(
      'quote-container(paragraph("a") list(listitem("b")) paragraph("tail"))',
    );
  });

  test('<blockquote> imports as a container through importDOM', () => {
    const editor = createEditor(
      QuoteContainerReplacementExtension,
      ListExtension,
    );
    update(editor, () => {
      $getRoot().clear().select();
      $insertNodes(
        $generate('<blockquote><p>a</p><ul><li>b</li></ul>tail</blockquote>'),
      );
    });
    expect(describeRoot(editor)).toBe(
      'quote-container(paragraph("a") list(listitem("b")) paragraph("tail"))',
    );
  });

  test('pasted HTML and pasted Lexical JSON of a quote make containers', () => {
    const editor = createEditor(QuoteContainerReplacementExtension);
    update(editor, () => {
      $setRoot($p('start'));
      const selection = $block([0]).selectEnd();
      $insertDataTransferForRichText(
        dataTransfer({'text/html': '<blockquote>pasted</blockquote>'}),
        selection,
        editor,
      );
    });
    expect(describeRoot(editor)).toBe(
      'paragraph("start") / quote-container(paragraph("pasted"))',
    );
    update(editor, () => {
      const selection = $block([0]).selectEnd();
      $insertDataTransferForRichText(
        dataTransfer({
          'application/x-lexical-editor': JSON.stringify({
            namespace: editor._config.namespace,
            nodes: [
              {
                children: [{text: 'json', type: 'text', version: 1}],
                type: 'quote',
                version: 1,
              },
            ],
          }),
        }),
        selection,
        editor,
      );
    });
    expect(describeRoot(editor)).toBe(
      'paragraph("start") / quote-container(paragraph("json")) / quote-container(paragraph("pasted"))',
    );
  });
});

describe('QuoteContainerNode and its consumers', () => {
  test('BlockIdExtension identifies the blocks inside, and the container as a root child only', () => {
    const editor = createEditor(QuoteContainerExtension, BlockIdExtension);
    update(editor, () => {
      $setRoot(
        $createQuoteContainerNode().append(
          $p('a'),
          $createQuoteContainerNode().append($p('b')),
        ),
      );
    });
    editor.read(() => {
      const ids = {
        inner: $getBlockId($block([0, 1])),
        innerParagraph: $getBlockId($block([0, 1, 0])),
        outer: $getBlockId($block([0])),
        paragraph: $getBlockId($block([0, 0])),
      };
      expect(ids.outer).toEqual(expect.any(String));
      expect(ids.paragraph).toEqual(expect.any(String));
      expect(ids.innerParagraph).toEqual(expect.any(String));
      // A nested container is a wrapper, as a nested table cell is.
      expect(ids.inner).toBeNull();
      expect(new Set([ids.outer, ids.paragraph, ids.innerParagraph]).size).toBe(
        3,
      );
    });
  });

  test('$insertList makes a list of the paragraphs inside, and leaves the container', () => {
    const editor = createEditor(QuoteContainerExtension, ListExtension);
    update(editor, () => {
      $setRoot(
        $p('title'),
        $createQuoteContainerNode().append($p('a'), $p('b')),
      );
      const selection = $createRangeSelection();
      selection.anchor.set(
        $block([1, 0]).getFirstChildOrThrow().getKey(),
        0,
        'text',
      );
      selection.focus.set(
        $block([1, 1]).getFirstChildOrThrow().getKey(),
        1,
        'text',
      );
      $setSelection(selection);
      $insertList('bullet');
    });
    expect(describeRoot(editor)).toBe(
      'paragraph("title") / quote-container(list(listitem("a") listitem("b")))',
    );
  });

  test('a copied container pastes as a container', () => {
    const editor = createEditor(QuoteContainerExtension);
    let lexical = '';
    let html = '';
    update(editor, () => {
      $setRoot(
        $p('title'),
        $createQuoteContainerNode().append($p('a'), $p('b')),
        $p('end'),
      );
      const selection = $createRangeSelection();
      selection.anchor.set(
        $block([0]).getFirstChildOrThrow().getKey(),
        0,
        'text',
      );
      selection.focus.set(
        $block([2]).getFirstChildOrThrow().getKey(),
        3,
        'text',
      );
      $setSelection(selection);
      lexical = $getLexicalContent(editor, selection) || '';
      html = $getHtmlContent(editor, selection);
    });
    expect(
      JSON.parse(lexical).nodes.map((node: {type: string}) => node.type),
    ).toEqual(['paragraph', 'quote-container', 'paragraph']);
    expect(html).toContain('<blockquote><p');
    update(editor, () => {
      $setRoot($p());
      $insertDataTransferForRichText(
        dataTransfer({'application/x-lexical-editor': lexical}),
        $block([0]).select(),
        editor,
      );
    });
    expect(describeRoot(editor)).toBe(
      'paragraph("title") / quote-container(paragraph("a") paragraph("b")) / paragraph("end")',
    );
  });

  test('a selection inside the container copies its blocks, not the container', () => {
    const editor = createEditor(QuoteContainerExtension);
    update(editor, () => {
      $setRoot($createQuoteContainerNode().append($p('a'), $p('b')));
      const selection = $createRangeSelection();
      selection.anchor.set(
        $block([0, 0]).getFirstChildOrThrow().getKey(),
        0,
        'text',
      );
      selection.focus.set(
        $block([0, 1]).getFirstChildOrThrow().getKey(),
        1,
        'text',
      );
      $setSelection(selection);
      const lexical = $getLexicalContent(editor, selection) || '';
      expect(
        JSON.parse(lexical).nodes.map((node: {type: string}) => node.type),
      ).toEqual(['paragraph', 'paragraph']);
    });
  });
});
