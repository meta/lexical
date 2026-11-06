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
  registerCodeGutter,
  registerCodeIndentation,
} from '@lexical/code-core';
import {effect, namedSignals} from '@lexical/extension';
import {
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $getWritableNodeState,
  $isLineBreakNode,
  $isRangeSelection,
  $isTabNode,
  $isTextNode,
  $onUpdate,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  NODE_STATE_KEY,
  type NodeKey,
  type PointType,
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

/**
 * Give `to` the NodeState of `from`, flat states included, keeping the state
 * that `to` has for the keys `from` does not set (such as state that a node
 * replacement initializes).
 */
function $copyNodeState(from: LexicalNode, to: LexicalNode): void {
  // @internal access, like `__text`: the NodeState of the node
  const json: Record<string, unknown> = from.__state
    ? from.__state.toJSON()
    : {};
  const entries = Object.entries(json);
  if (entries.length === 0) {
    return;
  }
  const state = $getWritableNodeState(to);
  for (const [key, value] of entries) {
    if (key === NODE_STATE_KEY) {
      for (const [nestedKey, nestedValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        state.updateFromUnknown(nestedKey, nestedValue);
      }
    } else {
      state.updateFromUnknown(key, value);
    }
  }
}

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
    // code highlight nodes converted back to normal text, which keeps
    // their NodeState (such as comment ids)
    const text = $createTextNode(node.__text);
    $copyNodeState(node, text);
    node.replace(text);
  }
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

  // dynamic import of languages
  let inFlight = false;
  // Only a language Shiki has a grammar for is highlighted. Without one (no
  // language, or one Shiki does not know, e.g. "After" from the markdown
  // shortcut "```After ") the text is split into plain CodeHighlightNodes,
  // so the indent and line-move handlers can work on it.
  let highlight = false;
  if (language) {
    if (isCodeLanguageLoaded(language)) {
      if (!node.getIsSyntaxHighlightSupported()) {
        node.setIsSyntaxHighlightSupported(true);
      }
      highlight = true;
    } else if (loadCodeLanguage(language, editor, nodeKey)) {
      // The grammar is downloading; highlight once it has loaded.
      inFlight = true;
    } else if (node.getIsSyntaxHighlightSupported()) {
      // The language is not supported, so the download will not occur.
      node.setIsSyntaxHighlightSupported(false);
    }
  } else if (node.getIsSyntaxHighlightSupported()) {
    node.setIsSyntaxHighlightSupported(false);
  }

  // dynamic import of themes
  if (!isCodeThemeLoaded(theme)) {
    loadCodeTheme(theme, editor, nodeKey);
    // Only the highlight path consumes the theme. Plain text needs no theme,
    // so don't defer the split on a theme load that won't be used: otherwise
    // a code block with `defaultLanguage: null`, or with a language Shiki
    // does not know, stays an unsplit TextNode until the theme happens to
    // finish loading.
    if (highlight) {
      inFlight = true;
    }
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
    const highlightNodes =
      lang && !isCodeLanguageLoaded(lang)
        ? $plainifyCodeContent(currentNode.getTextContent())
        : tokenizer.$tokenize(currentNode, lang ?? undefined);
    const diffRange = getDiffRange(currentNode.getChildren(), highlightNodes);
    const {from, to, nodesForReplacement} = diffRange;

    if (from !== to || nodesForReplacement.length) {
      node.splice(from, to - from, nodesForReplacement);
      return true;
    }

    return false;
  });
}

// The text offset of a point in a code block: the text of everything before
// it, plus its offset in its own text node, or null when the point is outside
// the block. An element point (e.g. after a line break) is a child index,
// which goes stale once an earlier line is split into more tokens, so it is
// converted too.
function $getCodeTextOffset(code: CodeNode, point: PointType): number | null {
  const pointNode = point.getNode();
  if (pointNode === code) {
    return code
      .getChildren()
      .slice(0, point.offset)
      .reduce((offset, child) => offset + child.getTextContentSize(), 0);
  }
  if (!code.isParentOf(pointNode)) {
    return null;
  }
  return pointNode
    .getPreviousSiblings()
    .reduce(
      (offset, sibling) => offset + sibling.getTextContentSize(),
      point.offset,
    );
}

// Moves a point to a text offset in a code block. A LineBreakNode consumes
// one unit of the offset but can't host a text point, so when the offset
// lands on one this uses an element point on the code node instead of letting
// the offset go negative.
function $setCodeTextOffset(
  code: CodeNode,
  point: PointType,
  textOffset: number,
): void {
  const children = code.getChildren();
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if ($isTextNode(child)) {
      const textContentSize = child.getTextContentSize();
      if (textContentSize >= textOffset) {
        point.set(child.getKey(), textOffset, 'text');
        return;
      }
      textOffset -= textContentSize;
    } else if ($isLineBreakNode(child)) {
      if (textOffset === 0) {
        point.set(code.getKey(), index, 'element');
        return;
      }
      textOffset -= 1;
    }
  }
  point.set(code.getKey(), children.length, 'element');
}

// Wrapping update function into selection retainer, that tries to keep the
// caret at the same text position as before.
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

  // When the anchor is inside this code node, the selection is restored as a
  // caret at the anchor: MarkStateExtension relies on that collapsed caret to
  // carry comment ids onto the new tokens. A selection elsewhere is left where
  // the user put it, rather than dragged into the code block.
  const textOffset = $getCodeTextOffset(node, selection.anchor);
  if (textOffset === null) {
    // A range from outside into this code node keeps its anchor, and its
    // focus moves back to the same text position.
    const focusOffset = $getCodeTextOffset(node, selection.focus);
    if (updateFn() && focusOffset !== null) {
      $setCodeTextOffset(node, selection.focus, focusOffset);
    }
    return;
  }
  if (!updateFn()) {
    return;
  }
  const {anchor, focus} = selection;
  $setCodeTextOffset(node, anchor, textOffset);
  focus.set(anchor.key, anchor.offset, anchor.type);
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

  registrations.push(registerCodeGutter(editor));

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
