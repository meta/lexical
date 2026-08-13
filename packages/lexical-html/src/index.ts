/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {$sliceSelectedTextNodeContent} from '@lexical/selection';
import {
  $assumeActiveEditor,
  $createLineBreakNode,
  $createParagraphNode,
  $getDocument,
  $getEditor,
  $getEditorDOMRenderConfig,
  $getRoot,
  $getSlotFrame,
  $isBlockElementNode,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  ArtificialNode__DO_NOT_USE,
  type BaseSelection,
  type DOMChildConversion,
  type DOMConversion,
  type DOMConversionFn,
  type EditorDOMRenderConfig,
  type ElementFormatType,
  type ElementNode,
  isBlockDomNode,
  isDocumentFragment,
  isDOMDocumentNode,
  isHTMLElement,
  isInlineDomNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';

import {contextValue} from './ContextRecord';
import {$inlineStylesFromStyleSheetsDOM} from './import/inlineStylesFromStyleSheets';
import {
  $getSessionDOMRenderConfig,
  $withRenderContext,
  RenderContextExport,
  RenderContextRoot,
} from './RenderContext';

export {contextUpdater, contextValue} from './ContextRecord';
export {domOverride} from './domOverride';
export {DOMRenderExtension} from './DOMRenderExtension';
export type {
  AnyDOMImportRule,
  AttrMatchOptions,
  CapturesOfSelector,
  ChildSchema,
  CompiledOverlayRules,
  CompiledSelector,
  DOMImportContext,
  DOMImportExtensionOutput,
  DOMImportFn,
  DOMImportRule,
  DOMImportRuleEntry,
  DOMPreprocessContext,
  DOMPreprocessFn,
  ElementSelectorBuilder,
  GenerateNodesFromDOMOptions,
  ImportChildrenOpts,
  ImportContextPairOrUpdater,
  ImportNodeOpts,
  ImportSession,
  ImportStateConfig,
  NodeOfSelector,
  StyleMatchOptions,
} from './import';
export {
  $distributeInlineWrapper,
  $generateNodesFromDOMViaExtension,
  $getImportContextValue,
  $inlineStylesFromStyleSheets,
  $isBlockLevel,
  $propagateTextAlignToBlockChildren,
  $withImportContext,
  BlockSchema,
  CoreImportExtension,
  CoreImportRules,
  createImportState,
  defaultIsInline,
  defaultPreservesWhitespace,
  defineImportRule,
  defineOverlayRules,
  type DOMImportConfig,
  DOMImportExtension,
  HorizontalRuleImportExtension,
  HorizontalRuleImportRules,
  ImportOverlays,
  ImportSource,
  ImportSourceDataTransfer,
  type ImportSourceKind,
  ImportTextFormat,
  ImportTextStyle,
  ImportWhitespaceConfig,
  InlineSchema,
  isElementOfTag,
  type IsInlineForWhitespace,
  type IsPreserveWhitespaceDom,
  NestedBlockSchema,
  parseSelector,
  RootSchema,
  sel,
  type WhitespaceImportConfig,
} from './import';
export {
  $getRenderContextValue,
  $getSessionDOMRenderConfig,
  $setRenderContextValue,
  $updateRenderContextValue,
  $withRenderContext,
  createRenderState,
  RenderContextExport,
  RenderContextRoot,
} from './RenderContext';
export type {
  AnyDOMRenderMatch,
  AnyRenderStateConfig,
  AnyRenderStateConfigPairOrUpdater,
  ContextPairOrUpdater,
  DOMOverrideOptions,
  DOMRenderConfig,
  DOMRenderExtensionOutput,
  DOMRenderMatch,
  DOMRenderMatchConfig,
  NodeMatch,
  RenderContextReader,
} from './types';

const IGNORE_TAGS = new Set(['STYLE', 'SCRIPT']);

/**
 * How you parse your html string to get a document is left up to you. In the browser you can use the native
 * DOMParser API to generate a document (see clipboard.ts), but to use in a headless environment you can use JSDom
 * or an equivalent library and pass in the document here.
 */
export function $generateNodesFromDOM(
  editor: LexicalEditor,
  dom: Document | ParentNode,
): LexicalNode[] {
  $inlineStylesFromStyleSheetsDOM(dom);

  const elements = isDOMDocumentNode(dom)
    ? dom.body.childNodes
    : dom.childNodes;
  const lexicalNodes: LexicalNode[] = [];
  const allArtificialNodes: ArtificialNode__DO_NOT_USE[] = [];
  for (const element of elements) {
    if (!IGNORE_TAGS.has(element.nodeName)) {
      const lexicalNode = $createNodesFromDOM(
        element,
        editor,
        allArtificialNodes,
        false,
      );
      if (lexicalNode !== null) {
        for (const node of lexicalNode) {
          lexicalNodes.push(node);
        }
      }
    }
  }
  $unwrapArtificialNodes(allArtificialNodes);

  return lexicalNodes;
}

/**
 * Generate DOM nodes from the editor state into the given container element,
 * using the editor's {@link EditorDOMRenderConfig}.
 * @experimental
 */
export function $generateDOMFromNodes<T extends HTMLElement | DocumentFragment>(
  container: T,
  selection: null | BaseSelection = null,
  editor: LexicalEditor = $getEditor(),
): T {
  return $withRenderContext(
    [contextValue(RenderContextExport, true)],
    editor,
  )(() => {
    const root = $getRoot();
    const domConfig = $getSessionDOMRenderConfig(editor);

    // A RangeSelection wholly inside a slot subtree never includes its host
    // (slots are shadow-root isolated), so a root-children walk would miss
    // the selected nodes entirely and export an empty payload. Walk the
    // selection's slot frame instead; outside slots this is the root.
    const slotFrame = $isRangeSelection(selection)
      ? $getSlotFrame(selection.anchor.getNode())
      : null;
    const parentElementAppend = container.append.bind(container);
    for (const topLevelNode of ($isElementNode(slotFrame)
      ? slotFrame
      : root
    ).getChildren()) {
      $appendNodesToHTML(
        editor,
        topLevelNode,
        parentElementAppend,
        selection,
        domConfig,
      );
    }
    return container;
  });
}

/**
 * Generate DOM nodes from a root node into the given container element,
 * including the root node itself. Uses the editor's {@link EditorDOMRenderConfig}.
 * @experimental
 */
export function $generateDOMFromRoot<T extends HTMLElement | DocumentFragment>(
  container: T,
  root: LexicalNode = $getRoot(),
): T {
  const editor = $getEditor();
  return $withRenderContext(
    [
      contextValue(RenderContextExport, true),
      contextValue(RenderContextRoot, true),
    ],
    editor,
  )(() => {
    const selection = null;
    const domConfig = $getSessionDOMRenderConfig(editor);
    const parentElementAppend = container.append.bind(container);
    $appendNodesToHTML(editor, root, parentElementAppend, selection, domConfig);
    return container;
  });
}

/**
 * Generate an HTML string from the editor's current state (or `selection`
 * if provided).
 *
 * Must be called inside an active editor scope — i.e. `editor.update(...)`,
 * `editor.read(...)`, or `editor.getEditorState().read(callback, {editor})`.
 * The legacy `editor.getEditorState().read(callback)` call (without the
 * `{editor}` option) does not set an active editor and is not supported;
 * `editor.read(...)` is the drop-in replacement.
 */
export function $generateHtmlFromNodes(
  editor: LexicalEditor,
  selection: BaseSelection | null = null,
): string {
  if (
    typeof document === 'undefined' ||
    (typeof window === 'undefined' && typeof global.window === 'undefined')
  ) {
    invariant(
      false,
      'To use $generateHtmlFromNodes in headless mode please initialize a headless browser implementation such as JSDom or use withDOM from @lexical/headless/dom before calling this function.',
    );
  }
  // BC: $setTextContent now requires an active-editor scope (added in #8519).
  // If the caller is in a legacy `editorState.read(cb)` scope (no active editor),
  // establish one via internal API.
  $assumeActiveEditor(editor);
  return $generateDOMFromNodes(
    $getDocument().createElement('div'),
    selection,
    editor,
  ).innerHTML;
}

function $appendNodesToHTML(
  editor: LexicalEditor,
  currentNode: LexicalNode,
  parentElementAppend: (element: Node) => void,
  selection: BaseSelection | null = null,
  domConfig: EditorDOMRenderConfig = $getEditorDOMRenderConfig(editor),
): boolean {
  let shouldInclude = domConfig.$shouldInclude(currentNode, selection, editor);
  const shouldExclude = domConfig.$shouldExclude(
    currentNode,
    selection,
    editor,
  );
  let target = currentNode;

  if (selection !== null && $isTextNode(currentNode)) {
    target = $sliceSelectedTextNodeContent(selection, currentNode, 'clone');
  }
  const exportProps = domConfig.$exportDOM(target, editor);
  const {element, after, append, $getChildNodes} = exportProps;

  if (!element) {
    return false;
  }

  const fragment = $getDocument().createDocumentFragment();
  const children = $getChildNodes
    ? $getChildNodes()
    : $isElementNode(target)
      ? target.getChildren()
      : [];

  // Mirrors the clipboard JSON path: an element host in a NodeSelection
  // (e.g. a Card promoted whole-host from a chrome click) recurses into its
  // children with a null selection so the whole subtree serializes even when
  // none of the children are in the outer selection themselves — the old
  // shell-only output made cut silently lossy. Only a whole-host
  // NodeSelection promotes: a partial RangeSelection that happens to contain
  // the host must keep slicing/excluding per child, or a drag into the
  // host's interior would over-export unselected content.
  const childSelection =
    shouldInclude && $isNodeSelection(selection) && $isElementNode(currentNode)
      ? null
      : selection;
  const fragmentAppend = fragment.append.bind(fragment);
  for (const childNode of children) {
    const shouldIncludeChild = $appendNodesToHTML(
      editor,
      childNode,
      fragmentAppend,
      childSelection,
      domConfig,
    );

    if (
      !shouldInclude &&
      shouldIncludeChild &&
      domConfig.$extractWithChild(
        currentNode,
        childNode,
        selection,
        'html',
        editor,
      )
    ) {
      shouldInclude = true;
    }
  }

  if (shouldInclude && !shouldExclude) {
    if (isHTMLElement(element) || isDocumentFragment(element)) {
      if (append) {
        append(fragment);
      } else {
        element.append(fragment);
      }
    }
    if (isDocumentFragment(element)) {
      // Resolve `after` before handing the fragment to the parent: appending a
      // DocumentFragment moves its children out and leaves it empty, so a
      // replacement written into it afterwards would land in a detached,
      // already-drained fragment and never reach the output.
      if (after) {
        const newElement = after.call(target, element);
        if (newElement) {
          element.replaceChildren(newElement);
        }
      }
      parentElementAppend(element);
    } else {
      // An HTMLElement has to be in the tree first so replaceWith() can swap
      // it in place.
      parentElementAppend(element);
      if (after) {
        const newElement = after.call(target, element);
        if (newElement) {
          element.replaceWith(newElement);
        }
      }
    }
  } else {
    parentElementAppend(fragment);
  }

  return shouldInclude;
}

/**
 * Serialize a single node (and its subtree) into `parentElement`, the same way
 * the top-level HTML exporter serializes the nodes it walks. Slots are not part
 * of any node's child list and — like {@link LexicalNode.exportJSON} vs
 * `exportDOM` for NodeState — are intentionally NOT auto-serialized to HTML;
 * a host node opts in by calling this from its own `exportDOM`, e.g. to render
 * each slot value into a `data-lexical-slot` wrapper.
 *
 * @experimental
 */
export function $appendNodeToHTML(
  editor: LexicalEditor,
  node: LexicalNode,
  parentElement: HTMLElement | DocumentFragment,
  selection: BaseSelection | null = null,
): boolean {
  return $appendNodesToHTML(
    editor,
    node,
    parentElement.append.bind(parentElement),
    selection,
    // Resolve through the session so disabledForSession / export-only
    // overrides apply to slot subtrees the same way they apply to the
    // sibling content the outer exporter walks.
    $getSessionDOMRenderConfig(editor),
  );
}

function getConversionFunction(
  domNode: Node,
  editor: LexicalEditor,
): DOMConversionFn | null {
  const {nodeName} = domNode;

  const cachedConversions = editor._htmlConversions.get(nodeName.toLowerCase());

  let currentConversion: DOMConversion | null = null;

  if (cachedConversions !== undefined) {
    for (const cachedConversion of cachedConversions) {
      const domConversion = cachedConversion(domNode);
      if (
        domConversion !== null &&
        (currentConversion === null ||
          // Given equal priority, prefer the last registered importer
          // which is typically an application custom node or HTMLConfig['import']
          (currentConversion.priority || 0) <= (domConversion.priority || 0))
      ) {
        currentConversion = domConversion;
      }
    }
  }

  return currentConversion !== null ? currentConversion.conversion : null;
}

function $createNodesFromDOM(
  node: Node,
  editor: LexicalEditor,
  allArtificialNodes: ArtificialNode__DO_NOT_USE[],
  hasBlockAncestorLexicalNode: boolean,
  forChildMap: Map<string, DOMChildConversion> = new Map(),
  parentLexicalNode?: LexicalNode | null | undefined,
): LexicalNode[] {
  const lexicalNodes: LexicalNode[] = [];

  if (IGNORE_TAGS.has(node.nodeName)) {
    return lexicalNodes;
  }

  let currentLexicalNode = null;
  const transformFunction = getConversionFunction(node, editor);
  const transformOutput = transformFunction
    ? transformFunction(node as HTMLElement)
    : null;
  let postTransform = null;

  if (transformOutput !== null) {
    postTransform = transformOutput.after;
    const transformNodes = transformOutput.node;
    currentLexicalNode = Array.isArray(transformNodes)
      ? transformNodes[transformNodes.length - 1]
      : transformNodes;

    if (currentLexicalNode !== null) {
      for (const [, forChildFunction] of forChildMap) {
        currentLexicalNode = forChildFunction(
          currentLexicalNode,
          parentLexicalNode,
        );

        if (!currentLexicalNode) {
          break;
        }
      }

      if (currentLexicalNode) {
        lexicalNodes.push(
          ...(Array.isArray(transformNodes)
            ? transformNodes
            : [currentLexicalNode]),
        );
      }
    }

    if (transformOutput.forChild != null) {
      forChildMap.set(node.nodeName, transformOutput.forChild);
    }
  }

  // If the DOM node doesn't have a transformer, we don't know what
  // to do with it but we still need to process any childNodes.
  const children = node.childNodes;
  let childLexicalNodes = [];

  const hasBlockAncestorLexicalNodeForChildren =
    currentLexicalNode != null && $isRootOrShadowRoot(currentLexicalNode)
      ? false
      : (currentLexicalNode != null &&
          $isBlockElementNode(currentLexicalNode)) ||
        hasBlockAncestorLexicalNode;

  for (let i = 0; i < children.length; i++) {
    childLexicalNodes.push(
      ...$createNodesFromDOM(
        children[i],
        editor,
        allArtificialNodes,
        hasBlockAncestorLexicalNodeForChildren,
        new Map(forChildMap),
        currentLexicalNode,
      ),
    );
  }

  if (postTransform != null) {
    childLexicalNodes = postTransform(childLexicalNodes);
  }

  if (isBlockDomNode(node)) {
    if (!hasBlockAncestorLexicalNodeForChildren) {
      childLexicalNodes = wrapContinuousInlines(
        node,
        childLexicalNodes,
        $createParagraphNode,
      );
    } else {
      childLexicalNodes = wrapContinuousInlines(node, childLexicalNodes, () => {
        const artificialNode = new ArtificialNode__DO_NOT_USE();
        allArtificialNodes.push(artificialNode);
        return artificialNode;
      });
    }
  }

  if (currentLexicalNode == null) {
    if (childLexicalNodes.length > 0) {
      // If it hasn't been converted to a LexicalNode, we hoist its children
      // up to the same level as it.
      for (const childNode of childLexicalNodes) {
        lexicalNodes.push(childNode);
      }
    } else {
      if (isBlockDomNode(node) && isDomNodeBetweenTwoInlineNodes(node)) {
        // Empty block dom node that hasnt been converted, we replace it with a linebreak if its between inline nodes
        lexicalNodes.push($createLineBreakNode());
      }
    }
  } else {
    if ($isElementNode(currentLexicalNode)) {
      // If the current node is a ElementNode after conversion,
      // we can append all the children to it.
      currentLexicalNode.append(...childLexicalNodes);
    }
  }

  return lexicalNodes;
}

function wrapContinuousInlines(
  domNode: Node,
  nodes: LexicalNode[],
  createWrapperFn: () => ElementNode,
): LexicalNode[] {
  const textAlign = (domNode as HTMLElement).style
    .textAlign as ElementFormatType;
  const out: LexicalNode[] = [];
  let continuousInlines: LexicalNode[] = [];
  // wrap contiguous inline child nodes in para
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if ($isBlockElementNode(node)) {
      if (textAlign && !node.getFormat()) {
        node.setFormat(textAlign);
      }
      out.push(node);
    } else {
      continuousInlines.push(node);
      if (
        i === nodes.length - 1 ||
        (i < nodes.length - 1 && $isBlockElementNode(nodes[i + 1]))
      ) {
        const wrapper = createWrapperFn();
        wrapper.setFormat(textAlign);
        wrapper.append(...continuousInlines);
        out.push(wrapper);
        continuousInlines = [];
      }
    }
  }
  return out;
}

function $unwrapArtificialNodes(
  allArtificialNodes: ArtificialNode__DO_NOT_USE[],
) {
  // Replace artificial node with its children, inserting a linebreak
  // between adjacent artificial nodes
  for (const node of allArtificialNodes) {
    if (
      node.getParent() &&
      node.getNextSibling() instanceof ArtificialNode__DO_NOT_USE
    ) {
      node.insertAfter($createLineBreakNode());
    }
  }
  for (const node of allArtificialNodes) {
    const parent = node.getParent();
    if (parent) {
      parent.splice(node.getIndexWithinParent(), 1, node.getChildren());
    }
  }
}

function isDomNodeBetweenTwoInlineNodes(node: Node): boolean {
  if (node.nextSibling == null || node.previousSibling == null) {
    return false;
  }
  return (
    isInlineDomNode(node.nextSibling) && isInlineDomNode(node.previousSibling)
  );
}
