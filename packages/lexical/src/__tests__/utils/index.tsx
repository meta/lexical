/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {CodeHighlightNode, CodeNode} from '@lexical/code';
import {HashtagNode} from '@lexical/hashtag';
import {createHeadlessEditor} from '@lexical/headless';
import {AutoLinkNode, LinkNode} from '@lexical/link';
import {ListItemNode, ListNode} from '@lexical/list';
import {MarkNode} from '@lexical/mark';
import {OverflowNode} from '@lexical/overflow';
import {
  type InitialConfigType,
  LexicalComposer,
} from '@lexical/react/LexicalComposer';
import {
  createLexicalComposerContext,
  LexicalComposerContext,
} from '@lexical/react/LexicalComposerContext';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {TableCellNode, TableNode, TableRowNode} from '@lexical/table';
import prettier from '@prettier/sync';
import {
  $create,
  $isRangeSelection,
  createEditor,
  type CreateEditorArgs,
  DecoratorNode,
  type DOMConversion,
  type DOMConversionOutput,
  type EditorState,
  type EditorThemeClasses,
  ElementNode,
  type HTMLConfig,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  type LexicalNodeReplacement,
  type LexicalUpdateJSON,
  type RangeSelection,
  resetRandomKey,
  type SerializedElementNode,
  type SerializedLexicalNode,
  type SerializedTextNode,
  type Spread,
  TextNode,
} from 'lexical';
import * as React from 'react';
import {act, createRef, type JSX} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, assert, beforeEach, expect} from 'vitest';

const prettierConfig = prettier.resolveConfig(__filename);

type TestEnv = {
  readonly container: HTMLDivElement;
  readonly editor: LexicalEditor;
  readonly outerHTML: string;
  readonly innerHTML: string;
};

export function initializeUnitTest(
  runTests: (testEnv: TestEnv) => void,
  editorConfig: CreateEditorArgs = {namespace: 'test', theme: {}},
  plugins?: React.ReactNode,
) {
  const testEnv = {
    _container: null as HTMLDivElement | null,
    _editor: null as LexicalEditor | null,
    get container() {
      if (!this._container) {
        throw new Error('testEnv.container not initialized.');
      }
      return this._container;
    },
    set container(container) {
      this._container = container;
    },
    get editor() {
      if (!this._editor) {
        throw new Error('testEnv.editor not initialized.');
      }
      return this._editor;
    },
    set editor(editor) {
      this._editor = editor;
    },
    get innerHTML() {
      return (this.container.firstChild as HTMLElement).innerHTML;
    },
    get outerHTML() {
      return this.container.innerHTML;
    },
    reset() {
      this._container = null;
      this._editor = null;
    },
  };

  beforeEach(async () => {
    resetRandomKey();

    testEnv.container = document.createElement('div');
    document.body.appendChild(testEnv.container);
    const ref = createRef<HTMLDivElement>();

    const useLexicalEditor = (
      rootElementRef: React.RefObject<null | HTMLDivElement>,
    ) => {
      const lexicalEditor = React.useMemo(() => {
        const lexical = createTestEditor(editorConfig);
        return lexical;
      }, []);

      React.useEffect(() => {
        const rootElement = rootElementRef.current;
        lexicalEditor.setRootElement(rootElement);
      }, [rootElementRef, lexicalEditor]);
      return lexicalEditor;
    };

    const Editor = () => {
      testEnv.editor = useLexicalEditor(ref);
      const context = createLexicalComposerContext(
        null,
        editorConfig?.theme ?? {},
      );
      return (
        <LexicalComposerContext.Provider value={[testEnv.editor, context]}>
          <div ref={ref} contentEditable={true} />
          {plugins}
        </LexicalComposerContext.Provider>
      );
    };

    act(() => {
      createRoot(testEnv.container).render(<Editor />);
    });
  });

  afterEach(() => {
    document.body.removeChild(testEnv.container);
    testEnv.reset();
  });

  runTests(testEnv);
}

export function initializeClipboard() {
  Object.defineProperty(window, 'DragEvent', {
    value: class DragEvent {},
  });
  Object.defineProperty(window, 'ClipboardEvent', {
    value: class ClipboardEvent {},
  });
}

export type SerializedTestElementNode = SerializedElementNode;

export class TestElementNode extends ElementNode {
  $config() {
    return this.config('test_block', {extends: ElementNode});
  }

  createDOM() {
    return document.createElement('div');
  }

  updateDOM() {
    return false;
  }
}

export function $createTestElementNode(): TestElementNode {
  return new TestElementNode();
}

export class TestTextNode extends TextNode {
  $config() {
    return this.config('test_text', {extends: TextNode});
  }
}

export type SerializedTestInlineElementNode = SerializedElementNode;

export class TestInlineElementNode extends ElementNode {
  $config() {
    return this.config('test_inline_block', {extends: ElementNode});
  }

  createDOM() {
    return document.createElement('a');
  }

  updateDOM() {
    return false;
  }

  isInline() {
    return true;
  }

  canBeEmpty() {
    return false;
  }
}

export function $createTestInlineElementNode(): TestInlineElementNode {
  return new TestInlineElementNode();
}

export type SerializedTestShadowRootNode = SerializedElementNode;

export class TestShadowRootNode extends ElementNode {
  $config() {
    return this.config('test_shadow_root', {extends: ElementNode});
  }

  createDOM() {
    return document.createElement('div');
  }

  updateDOM() {
    return false;
  }

  isShadowRoot() {
    return true;
  }
}

export function $createTestShadowRootNode(): TestShadowRootNode {
  return new TestShadowRootNode();
}

export function $isTestShadowRootNode(
  node: LexicalNode | null | undefined,
): node is TestShadowRootNode {
  return node instanceof TestShadowRootNode;
}

export type SerializedTestUpdateDOMTrueHostNode = SerializedElementNode;

// Slot host that always reports updateDOM=true, so every host edit triggers
// $createNode(key, null) + $destroyNode(key, null) — the host wrapper DOM is
// recreated. Used to exercise the reuse path for slot subtree DOM across a
// host wrapper recreate.
export class TestUpdateDOMTrueHostNode extends ElementNode {
  __toggle: number = 0;

  $config() {
    return this.config('test_update_dom_true_host', {extends: ElementNode});
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__toggle = prevNode.__toggle;
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div');
    div.setAttribute('data-toggle', String(this.__toggle));
    return div;
  }

  updateDOM(): boolean {
    return true;
  }

  setToggle(toggle: number): this {
    const self = this.getWritable();
    self.__toggle = toggle;
    return self;
  }
}

export function $createTestUpdateDOMTrueHostNode(): TestUpdateDOMTrueHostNode {
  return $create(TestUpdateDOMTrueHostNode);
}

export function $isTestUpdateDOMTrueHostNode(
  node: LexicalNode | null | undefined,
): node is TestUpdateDOMTrueHostNode {
  return node instanceof TestUpdateDOMTrueHostNode;
}

export type SerializedTestSegmentedNode = SerializedTextNode;

export class TestSegmentedNode extends TextNode {
  $config() {
    return this.config('test_segmented', {extends: TextNode});
  }
}

export function $createTestSegmentedNode(text: string = ''): TestSegmentedNode {
  return new TestSegmentedNode(text).setMode('segmented');
}

export type SerializedTestExcludeFromCopyElementNode = SerializedElementNode;

export class TestExcludeFromCopyElementNode extends ElementNode {
  $config() {
    return this.config('test_exclude_from_copy_block', {extends: ElementNode});
  }

  createDOM() {
    return document.createElement('div');
  }

  updateDOM() {
    return false;
  }

  excludeFromCopy() {
    return true;
  }
}

export function $createTestExcludeFromCopyElementNode(): TestExcludeFromCopyElementNode {
  return new TestExcludeFromCopyElementNode();
}

export type SerializedTestDecoratorNode = Spread<
  SerializedLexicalNode,
  {block?: boolean}
>;

export class TestDecoratorNode extends DecoratorNode<JSX.Element> {
  __block: boolean = false;

  $config() {
    return this.config('test_decorator', {extends: DecoratorNode});
  }

  static importDOM() {
    return {
      'test-decorator': (domNode: HTMLElement) => {
        return {
          conversion: () => ({node: $createTestDecoratorNode()}),
        };
      },
    };
  }

  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedTestDecoratorNode>,
  ): this {
    return super
      .updateFromJSON(serializedNode)
      .setIsInline(!serializedNode.block);
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__block = prevNode.__block;
  }

  isInline(): boolean {
    return !this.getLatest().__block;
  }

  setIsInline(inline: boolean): this {
    const self = this.getWritable();
    self.__block = !inline;
    return self;
  }

  exportJSON(): SerializedTestDecoratorNode {
    const json: SerializedTestDecoratorNode = super.exportJSON();
    if (this.__block) {
      json.block = this.__block;
    }
    return json;
  }

  exportDOM() {
    return {
      element: document.createElement('test-decorator'),
    };
  }

  getTextContent() {
    return 'Hello world';
  }

  createDOM() {
    return document.createElement(this.__block ? 'div' : 'span');
  }

  updateDOM(prevNode: this) {
    return this.__block !== prevNode.__block;
  }

  decorate() {
    return <Decorator text={'Hello world'} />;
  }
}

function Decorator({text}: {text: string}): JSX.Element {
  return <span>{text}</span>;
}

export function $createTestDecoratorNode(): TestDecoratorNode {
  return new TestDecoratorNode();
}

const DEFAULT_NODES: NonNullable<InitialConfigType['nodes']> = [
  HeadingNode,
  ListNode,
  ListItemNode,
  QuoteNode,
  CodeNode,
  TableNode,
  TableCellNode,
  TableRowNode,
  HashtagNode,
  CodeHighlightNode,
  AutoLinkNode,
  LinkNode,
  OverflowNode,
  TestElementNode,
  TestSegmentedNode,
  TestExcludeFromCopyElementNode,
  TestDecoratorNode,
  TestInlineElementNode,
  TestShadowRootNode,
  TestTextNode,
  MarkNode,
];

export function TestComposer({
  config = {
    nodes: [],
    theme: {},
  },
  children,
}: {
  config?: Omit<InitialConfigType, 'onError' | 'namespace'>;
  children: React.ComponentProps<typeof LexicalComposer>['children'];
}) {
  const customNodes = config.nodes;
  return (
    <LexicalComposer
      initialConfig={{
        onError: e => {
          throw e;
        },
        ...config,
        namespace: '',
        nodes: DEFAULT_NODES.concat(customNodes || []),
      }}>
      {children}
    </LexicalComposer>
  );
}

export function createTestEditor(
  config: {
    namespace?: string;
    editorState?: EditorState;
    theme?: EditorThemeClasses;
    parentEditor?: LexicalEditor;
    nodes?: readonly (Klass<LexicalNode> | LexicalNodeReplacement)[];
    onError?: (error: Error) => void;
    onWarn?: (error: Error) => void;
    disableEvents?: boolean;
    readOnly?: boolean;
    html?: HTMLConfig;
  } = {},
): LexicalEditor {
  const customNodes = config.nodes || [];
  const editor = createEditor({
    namespace: config.namespace,
    onError: e => {
      throw e;
    },
    ...config,
    nodes: DEFAULT_NODES.concat(customNodes),
  });
  return editor;
}

export function createTestHeadlessEditor(
  editorState?: EditorState,
): LexicalEditor {
  return createHeadlessEditor({
    editorState,
    onError: error => {
      throw error;
    },
  });
}

export function $assertRangeSelection(selection: unknown): RangeSelection {
  if (!$isRangeSelection(selection)) {
    throw new Error(`Expected RangeSelection, got ${selection}`);
  }
  return selection;
}

/**
 * Assert that a node matches the given type guard, returning it narrowed to
 * the guard's type. Useful for safely narrowing the result of traversal
 * methods such as getFirstChild() or getChildAtIndex() without an unchecked
 * type cast.
 */
export function $assertNodeType<T extends LexicalNode>(
  node: LexicalNode | null | undefined,
  $guard: (value: LexicalNode | null) => value is T,
): T {
  const resolved = node ?? null;
  assert(
    $guard(resolved),
    `Expected node to match type guard ${$guard.name}, got ${node ? node.constructor.name : null}`,
  );
  return resolved;
}

export function invariant(cond?: boolean, message?: string): asserts cond {
  if (cond) {
    return;
  }
  throw new Error(`Invariant: ${message}`);
}

export function tabKeyboardEvent() {
  return new KeyboardEvent('keydown', {key: 'Tab'});
}

export function shiftTabKeyboardEvent() {
  return new KeyboardEvent('keydown', {key: 'Tab', shiftKey: true});
}

export function generatePermutations<T>(
  values: T[],
  maxLength = values.length,
): T[][] {
  if (maxLength > values.length) {
    throw new Error('maxLength over values.length');
  }
  const result: T[][] = [];
  const current: T[] = [];
  const seen = new Set();
  (function permutationsImpl() {
    if (current.length > maxLength) {
      return;
    }
    result.push(current.slice());
    for (let i = 0; i < values.length; i++) {
      const key = values[i];
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      current.push(key);
      permutationsImpl();
      seen.delete(key);
      current.pop();
    }
  })();
  return result;
}

// This tag function is just used to trigger prettier auto-formatting.
// (https://prettier.io/blog/2020/08/24/2.1.0.html#api)
export function html(
  partials: TemplateStringsArray,
  ...params: string[]
): string {
  let output = '';
  for (let i = 0; i < partials.length; i++) {
    output += partials[i];
    if (i < partials.length - 1) {
      output += params[i];
    }
  }
  return output;
}

export function polyfillContentEditable() {
  const div = document.createElement('div');
  div.contentEditable = 'true';
  if (/contenteditable/.test(div.outerHTML)) {
    return;
  }
  Object.defineProperty(HTMLElement.prototype, 'contentEditable', {
    get() {
      return this.getAttribute('contenteditable');
    },

    set(value) {
      this.setAttribute('contenteditable', value);
    },
  });
}

/**
 * The zero-size, out-of-flow `<img>` the reconciler parks outside a leading or
 * trailing block DecoratorNode so browsers keep painting the selection
 * highlight for a range that ends on that boundary (#8922). Interpolate it into
 * an expected-HTML template wherever a block decorator sits on an element's
 * first / last edge.
 */
export const DECORATOR_BOUNDARY_ANCHOR_HTML =
  '<img alt="" style="position: absolute !important; width: 0px !important; ' +
  'height: 0px !important; border: 0px !important; margin: 0px !important; ' +
  'padding: 0px !important;" data-lexical-decorator-boundary="true" />';

export function expectHtmlToBeEqual(actual: string, expected: string): void {
  expect(prettifyHtml(actual)).toBe(prettifyHtml(expected));
}

export function prettifyHtml(s: string): string {
  return prettier.format(s.replace(/\n/g, ''), {
    ...prettierConfig,
    parser: 'html',
  });
}

/**
 * Locate and run the DOM importer for `element` through the editor's registered
 * conversion cache — the same machinery `@lexical/html`'s paste path consults
 * via `getConversionFunction` — and return its {@link DOMConversionOutput}.
 *
 * Prefer this over calling a node's static `importDOM()` directly: it exercises
 * the real registration (priority resolution, dedup, and any `HTMLConfig`
 * import overrides) instead of one class's raw map, and it runs the conversion
 * on `element` in place so logic that inspects the element's DOM ancestors
 * (e.g. a table cell reading its row/table position) sees the real context.
 */
export function $runDOMConversion(
  editor: LexicalEditor,
  element: HTMLElement,
): DOMConversionOutput | null {
  let match: DOMConversion | null = null;
  const conversions = editor._htmlConversions.get(
    element.tagName.toLowerCase(),
  );
  if (conversions !== undefined) {
    for (const conversion of conversions) {
      const candidate = conversion(element);
      if (
        candidate !== null &&
        (match === null || (match.priority || 0) <= (candidate.priority || 0))
      ) {
        match = candidate;
      }
    }
  }
  return match !== null ? match.conversion(element) : null;
}
