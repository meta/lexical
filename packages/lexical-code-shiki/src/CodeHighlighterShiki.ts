/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $isCodeHighlightNode,
  $isCodeNode,
  $plainifyCodeContent,
  CodeExtension,
  CodeHighlightNode,
  CodeIndentExtension,
  CodeNode,
  DEFAULT_CODE_LANGUAGE,
  registerCodeIndentation,
} from '@lexical/code-core';
import {effect, namedSignals} from '@lexical/extension';
import {
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  $isTabNode,
  $isTextNode,
  $onUpdate,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  type NodeKey,
  safeCast,
  TextNode,
} from 'lexical';

import {
  $getHighlightNodes,
  isCodeLanguageLoaded,
  isCodeThemeLoaded,
  loadCodeLanguage,
  loadCodeTheme,
} from './FacadeShiki';

export interface Tokenizer {
  /**
   * Language to fall back to when a {@link CodeNode} doesn't carry one.
   * Set to `null` to opt out of the implicit fallback — code blocks
   * without a language stay untouched (no `data-language` attribute, no
   * syntax highlighting) so a markdown round-trip can preserve ``` with
   * no info string.
   */
  defaultLanguage: string | null;
  defaultTheme: string;
  $tokenize: (
    this: Tokenizer,
    codeNode: CodeNode,
    language?: string,
  ) => LexicalNode[];
}

const DEFAULT_CODE_THEME = 'one-light';

export const ShikiTokenizer: Tokenizer = {
  $tokenize(
    this: Tokenizer,
    codeNode: CodeNode,
    language?: string,
  ): LexicalNode[] {
    const lang = language || this.defaultLanguage;
    return lang === null
      ? $plainifyCodeContent(codeNode.getTextContent())
      : $getHighlightNodes(codeNode, lang);
  },
  defaultLanguage: DEFAULT_CODE_LANGUAGE,
  defaultTheme: DEFAULT_CODE_THEME,
};

function $textNodeTransform(
  editor: LexicalEditor,
  tokenizer: Tokenizer,
  transformState: TransformState,
  node: TextNode,
): void {
  // Since CodeNode has flat children structure we only need to check
  // if node's parent is a code node and run highlighting if so
  const parentNode = node.getParent();
  if ($isCodeNode(parentNode)) {
    $codeNodeTransform(editor, tokenizer, transformState, parentNode);
  } else if ($isCodeHighlightNode(node)) {
    // When code block converted into paragraph or other element
    // code highlight nodes converted back to normal text
    node.replace($createTextNode(node.__text));
  }
}

function updateCodeGutter(node: CodeNode, editor: LexicalEditor): void {
  const codeElement = editor.getElementByKey(node.getKey());
  if (codeElement === null) {
    return;
  }
  const children = node.getChildren();
  const childrenLength = children.length;
  // @ts-ignore: internal field
  if (childrenLength === codeElement.__cachedChildrenLength) {
    // Avoid updating the attribute if the children length hasn't changed.
    return;
  }
  // @ts-ignore:: internal field
  codeElement.__cachedChildrenLength = childrenLength;
  let gutter = '1';
  let count = 1;
  for (let i = 0; i < childrenLength; i++) {
    if ($isLineBreakNode(children[i])) {
      gutter += '\n' + ++count;
    }
  }
  codeElement.setAttribute('data-gutter', gutter);
}

interface TransformState {
  didTransform: boolean;
  // Using extra cache (`nodesCurrentlyHighlighting`) since both CodeNode and CodeHighlightNode
  // transforms might be called at the same time (e.g. new CodeHighlight node inserted) and
  // in both cases we'll rerun whole reformatting over CodeNode, which is redundant.
  // Especially when pasting code into CodeBlock.
  nodesCurrentlyHighlighting: Set<NodeKey>;
}

function $codeNodeTransform(
  editor: LexicalEditor,
  tokenizer: Tokenizer,
  transformState: TransformState,
  node: CodeNode,
) {
  const nodeKey = node.getKey();
  const {nodesCurrentlyHighlighting} = transformState;

  // When new code block inserted it might not have language selected.
  // Tokenizers configured with `defaultLanguage: null` opt out of the
  // implicit fallback — leave the node unset and skip highlighting so
  // markdown round-trips ``` (no info string) without injecting one.
  let language = node.getLanguage();
  if (!language && tokenizer.defaultLanguage !== null) {
    language = tokenizer.defaultLanguage;
    node.setLanguage(language);
  }

  let theme = node.getTheme();
  if (!theme) {
    theme = tokenizer.defaultTheme;
    node.setTheme(theme);
  }

  // dynamic import of themes
  let inFlight = false;
  if (!isCodeThemeLoaded(theme)) {
    loadCodeTheme(theme, editor, nodeKey);
    // Only the highlight path (a resolved language) consumes the theme. With
    // no language the text is plainified, which needs no theme, so don't defer
    // the split on a theme load that won't be used — otherwise a code block
    // with `defaultLanguage: null` stays an unsplit TextNode until the theme
    // happens to finish loading.
    if (language) {
      inFlight = true;
    }
  }

  // dynamic import of languages
  if (language) {
    if (isCodeLanguageLoaded(language)) {
      if (!node.getIsSyntaxHighlightSupported()) {
        node.setIsSyntaxHighlightSupported(true);
      }
    } else {
      const loadingTask = loadCodeLanguage(language, editor, nodeKey);
      // if the language is not supported, the download will not occur
      if (!loadingTask && node.getIsSyntaxHighlightSupported()) {
        node.setIsSyntaxHighlightSupported(false);
      }
      inFlight = true;
    }
  } else if (node.getIsSyntaxHighlightSupported()) {
    node.setIsSyntaxHighlightSupported(false);
  }

  if (inFlight) {
    return;
  }

  if (nodesCurrentlyHighlighting.has(nodeKey)) {
    return;
  }

  nodesCurrentlyHighlighting.add(nodeKey);
  if (!transformState.didTransform) {
    transformState.didTransform = true;
    $onUpdate(() => {
      transformState.didTransform = false;
      nodesCurrentlyHighlighting.clear();
    });
  }

  $updateAndRetainSelection(nodeKey, () => {
    const currentNode = $getNodeByKey(nodeKey);

    if (!$isCodeNode(currentNode) || !currentNode.isAttached()) {
      return false;
    }

    const lang = currentNode.getLanguage() || tokenizer.defaultLanguage;
    const highlightNodes = tokenizer.$tokenize(currentNode, lang ?? undefined);
    const diffRange = getDiffRange(currentNode.getChildren(), highlightNodes);
    const {from, to, nodesForReplacement} = diffRange;

    if (from !== to || nodesForReplacement.length) {
      node.splice(from, to - from, nodesForReplacement);
      return true;
    }

    return false;
  });
}

// Wrapping update function into selection retainer, that tries to keep cursor at the same
// position as before.
function $updateAndRetainSelection(
  nodeKey: NodeKey,
  updateFn: () => boolean,
): void {
  const node = $getNodeByKey(nodeKey);
  if (!$isCodeNode(node) || !node.isAttached()) {
    return;
  }
  const selection = $getSelection();
  // If it's not range selection (or null selection) there's no need to change it,
  // but we can still run highlighting logic
  if (!$isRangeSelection(selection)) {
    updateFn();
    return;
  }

  const anchor = selection.anchor;
  // The selection is restored by walking this code node's children, so it can
  // only be retained when it actually points inside this code node. When the
  // selection lives elsewhere there is nothing to retain and restoring would
  // drag the caret into the code block instead of leaving it where the user
  // put it.
  const anchorNode = anchor.getNode();
  if (anchorNode !== node && !node.isParentOf(anchorNode)) {
    updateFn();
    return;
  }

  const anchorOffset = anchor.offset;
  const isNewLineAnchor =
    anchor.type === 'element' &&
    $isLineBreakNode(node.getChildAtIndex(anchor.offset - 1));
  let textOffset = 0;

  // Calculating previous text offset (all text node prior to anchor + anchor own text offset)
  if (!isNewLineAnchor) {
    textOffset =
      anchorOffset +
      anchorNode.getPreviousSiblings().reduce((offset, _node) => {
        return offset + _node.getTextContentSize();
      }, 0);
  }

  const hasChanges = updateFn();
  if (!hasChanges) {
    return;
  }

  // Non-text anchors only happen for line breaks, otherwise
  // selection will be within text node (code highlight node)
  if (isNewLineAnchor) {
    anchor.getNode().select(anchorOffset, anchorOffset);
    return;
  }

  // If it was non-element anchor then we walk through child nodes
  // and looking for a position of original text offset. A LineBreakNode
  // consumes one unit of the offset but can't host a text point, so when the
  // offset lands on one we use an element point on the code node instead of
  // letting the offset go negative and selecting the next text node at an
  // out-of-range position.
  const children = node.getChildren();
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if ($isTextNode(child)) {
      const textContentSize = child.getTextContentSize();
      if (textContentSize >= textOffset) {
        child.select(textOffset, textOffset);
        return;
      }
      textOffset -= textContentSize;
    } else if ($isLineBreakNode(child)) {
      if (textOffset === 0) {
        node.select(index, index);
        return;
      }
      textOffset -= 1;
    }
  }
  node.select(children.length, children.length);
}

// Finds minimal diff range between two nodes lists. It returns from/to range boundaries of prevNodes
// that needs to be replaced with `nodes` (subset of nextNodes) to make prevNodes equal to nextNodes.
function getDiffRange(
  prevNodes: LexicalNode[],
  nextNodes: LexicalNode[],
): {
  from: number;
  nodesForReplacement: LexicalNode[];
  to: number;
} {
  let leadingMatch = 0;
  while (leadingMatch < prevNodes.length) {
    if (!isEqual(prevNodes[leadingMatch], nextNodes[leadingMatch])) {
      break;
    }
    leadingMatch++;
  }

  const prevNodesLength = prevNodes.length;
  const nextNodesLength = nextNodes.length;
  const maxTrailingMatch =
    Math.min(prevNodesLength, nextNodesLength) - leadingMatch;

  let trailingMatch = 0;
  while (trailingMatch < maxTrailingMatch) {
    trailingMatch++;
    if (
      !isEqual(
        prevNodes[prevNodesLength - trailingMatch],
        nextNodes[nextNodesLength - trailingMatch],
      )
    ) {
      trailingMatch--;
      break;
    }
  }

  const from = leadingMatch;
  const to = prevNodesLength - trailingMatch;
  const nodesForReplacement = nextNodes.slice(
    leadingMatch,
    nextNodesLength - trailingMatch,
  );
  return {
    from,
    nodesForReplacement,
    to,
  };
}

function isEqual(nodeA: LexicalNode, nodeB: LexicalNode): boolean {
  // Only checking for code highlight nodes, tabs and linebreaks. If it's regular text node
  // returning false so that it's transformed into code highlight node
  return (
    ($isCodeHighlightNode(nodeA) &&
      $isCodeHighlightNode(nodeB) &&
      nodeA.__text === nodeB.__text &&
      nodeA.__highlightType === nodeB.__highlightType &&
      nodeA.__style === nodeB.__style) ||
    ($isTabNode(nodeA) && $isTabNode(nodeB)) ||
    ($isLineBreakNode(nodeA) && $isLineBreakNode(nodeB))
  );
}

/**
 * @internal
 * Register only the Shiki highlighting transforms and the gutter
 * mutation listener. No keyboard / indent handlers — those are the
 * responsibility of
 * {@link "@lexical/code-core".registerCodeIndentation} /
 * {@link "@lexical/code-core".CodeIndentExtension}.
 *
 * Used by {@link CodeShikiExtension}, whose `CodeIndentExtension`
 * dependency handles the indent side. The legacy
 * {@link registerCodeHighlighting} wrapper combines this helper with
 * `registerCodeIndentation` for direct callers that want the original
 * single-call setup.
 *
 * Exported for use by the package's own unit tests; not re-exported
 * from the package entry point.
 */
export function registerHighlightingOnly(
  editor: LexicalEditor,
  tokenizer: Tokenizer,
): () => void {
  const registrations = [];

  // Only register the mutation listener if not in headless mode
  if (editor._headless !== true) {
    registrations.push(
      editor.registerMutationListener(
        CodeNode,
        mutations => {
          editor.read('latest', () => {
            for (const [key, type] of mutations) {
              if (type !== 'destroyed') {
                const node = $getNodeByKey(key);
                if (node !== null) {
                  updateCodeGutter(node as CodeNode, editor);
                }
              }
            }
          });
        },
        {skipInitialization: false},
      ),
    );
  }

  const transformState: TransformState = {
    didTransform: false,
    nodesCurrentlyHighlighting: new Set(),
  };
  registrations.push(
    editor.registerNodeTransform(
      CodeNode,
      $codeNodeTransform.bind(null, editor, tokenizer, transformState),
    ),
    editor.registerNodeTransform(
      TextNode,
      $textNodeTransform.bind(null, editor, tokenizer, transformState),
    ),
    editor.registerNodeTransform(
      CodeHighlightNode,
      $textNodeTransform.bind(null, editor, tokenizer, transformState),
    ),
  );

  return mergeRegister(...registrations);
}

/**
 * Register the Shiki tokenizer-driven highlighting on the editor along
 * with the indent / Tab / arrow-key keyboard handlers. This function
 * is provided for legacy code that has not upgraded to using
 * {@link CodeShikiExtension}.
 */
export function registerCodeHighlighting(
  editor: LexicalEditor,
  tokenizer: Tokenizer = ShikiTokenizer,
): () => void {
  if (!editor.hasNodes([CodeNode, CodeHighlightNode])) {
    throw new Error(
      'CodeHighlightPlugin: CodeNode or CodeHighlightNode not registered on editor',
    );
  }
  return mergeRegister(
    registerHighlightingOnly(editor, tokenizer),
    registerCodeIndentation(editor),
  );
}

export interface CodeShikiConfig {
  /**
   * When true, the Shiki code highlighter is not registered on the editor.
   * This signal can be flipped at runtime to enable or disable the
   * highlighter, for example to switch between the Prism and Shiki
   * highlighters without rebuilding the editor.
   */
  disabled: boolean;
  tokenizer: Tokenizer;
}

/**
 * Add code highlighting support for code blocks with Shiki.
 *
 * {@link CodeExtension} is a dependency, so the required `CodeNode` and
 * `CodeHighlightNode` nodes are registered automatically.
 * {@link CodeIndentExtension} is also a dependency, so Tab / Shift+Tab
 * and the related keyboard handlers are activated automatically. Set
 * `tabSize` on `CodeIndentExtension` to enable space-indent outdent.
 */
export const CodeShikiExtension = defineExtension({
  build: (editor, config) => namedSignals(config),
  config: safeCast<CodeShikiConfig>({
    disabled: false,
    tokenizer: ShikiTokenizer,
  }),
  dependencies: [CodeExtension, CodeIndentExtension],
  name: '@lexical/code-shiki',
  register: (editor, config, state) => {
    const stores = state.getOutput();
    return effect(() => {
      if (stores.disabled.value) {
        return;
      }
      return registerHighlightingOnly(editor, stores.tokenizer.value);
    });
  },
});

/**
 * @deprecated Use {@link CodeShikiExtension} instead. This type is a
 * flat alias for {@link Tokenizer} kept for backward compatibility with
 * {@link CodeHighlighterShikiExtension}.
 */
export type CodeHighlighterShikiConfig = Tokenizer;

/**
 * @deprecated Use {@link CodeShikiExtension} instead.
 *
 * This is a thin backward-compatibility shim that preserves the original
 * flat {@link Tokenizer} config API. It depends on
 * {@link CodeShikiExtension} and routes its configured tokenizer to the
 * underlying extension during `init` (before `CodeShikiExtension` builds),
 * so consumers using
 * `configExtension(CodeHighlighterShikiExtension, customTokenizer)`
 * continue to work without modification.
 */
export const CodeHighlighterShikiExtension = defineExtension({
  config: safeCast<CodeHighlighterShikiConfig>(ShikiTokenizer),
  dependencies: [CodeShikiExtension],
  init: (editorConfig, config, state) => {
    // Forward the flat Tokenizer config to CodeShikiExtension's `tokenizer`
    // field before it builds.
    state.getDependency(CodeShikiExtension).config.tokenizer = config;
  },
  name: '@lexical/code-shiki/legacy',
});
