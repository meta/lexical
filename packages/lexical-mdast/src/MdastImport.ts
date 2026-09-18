/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  CompiledMdast,
  MdastImportContext,
  MdastNode,
  MdastParent,
} from './types';
import type {ElementNode, LexicalNode} from 'lexical';
import type {Root} from 'mdast';

import {
  $withImportContext,
  contextValue,
  createImportState,
} from '@lexical/html';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  tokenizeRawText,
} from 'lexical';
import {fromMarkdown} from 'mdast-util-from-markdown';

import {$append, $isBlockLevelNode, $prepend} from './handlers';

/**
 * Import context state that is true for the whole of a Markdown/mdast
 * import: inside every {@link MdastImportHandler} and inside any DOM-rule
 * session it opens (raw HTML routed through the DOM import rules inherits
 * the surrounding import context), so a DOM rule can distinguish a Markdown
 * import from an HTML paste of the same markup (read it with `ctx.get`, or
 * `$getImportContextValue` from an mdast handler).
 * @experimental
 */
export const ImportContextMarkdown = createImportState(
  'isMarkdownImport',
  Boolean,
);

/**
 * Splits `value` into a run of `TextNode`s via {@link tokenizeRawText}:
 * `\n` becomes a `LineBreakNode` and `\t` a `TabNode` (matching how typed
 * content is represented in the editor), with `format` applied to each text
 * segment. Empty segments are dropped so a leading/trailing/standalone
 * separator yields only its node.
 */
function $createTextNodes(value: string, format: number): LexicalNode[] {
  const out: LexicalNode[] = [];
  tokenizeRawText(value, {
    linebreak: () => out.push($createLineBreakNode()),
    tab: () => out.push($createTabNode()),
    text: segment => {
      const textNode = $createTextNode(segment);
      if (format) {
        textNode.setFormat(format);
      }
      out.push(textNode);
    },
  });
  return out;
}

/** A resolved `[identifier]: url "title"` definition. */
export type ResolvedDefinition = {url: string; title?: string | null};

/**
 * Collects the document's definitions (`[id]: url "title"`) so link/image
 * references can be resolved during the import walk. Identifiers on mdast
 * `definition` nodes are already normalized.
 */
export function collectDefinitions(
  tree: Root,
): Map<string, ResolvedDefinition> {
  const definitions = new Map<string, ResolvedDefinition>();
  const visit = (node: MdastNode): void => {
    if (node.type === 'definition') {
      // CommonMark: the FIRST definition of an identifier wins.
      if (!definitions.has(node.identifier)) {
        definitions.set(node.identifier, {title: node.title, url: node.url});
      }
    }
    if ('children' in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(tree);
  return definitions;
}

const NO_DEFINITIONS: ReadonlyMap<string, ResolvedDefinition> = new Map();

/**
 * Builds the recursive importer for a compiled set of transformers. The
 * returned function converts a single mdast node into Lexical nodes, threading
 * the accumulated text-format bitmask through inline marks.
 *
 * Exported so the streaming shortcut engine can reuse the exact same mdast ->
 * Lexical mapping when materializing an inline construct it detected.
 */
export function createNodeImporter(
  compiled: CompiledMdast,
  source = '',
  definitions: ReadonlyMap<string, ResolvedDefinition> = NO_DEFINITIONS,
) {
  const {importHandlers} = compiled;
  // The context only depends on the accumulated format bitmask, which takes a
  // handful of distinct values per document — cache instead of allocating one
  // (plus three closures) per visited node.
  const contextByFormat = new Map<number, MdastImportContext>();

  function getContext(format: number): MdastImportContext {
    let context = contextByFormat.get(format);
    if (context === undefined) {
      context = {
        createText: (value, fmt) =>
          $createTextNodes(value, fmt == null ? format : fmt),
        format,
        getDefinition: identifier => definitions.get(identifier),
        importChildren: (parent, extra) =>
          $importChildren(parent, format | (extra || 0)),
        importNode: (node, extra) => $importNode(node, format | (extra || 0)),
        source,
      };
      contextByFormat.set(format, context);
    }
    return context;
  }

  function $importNode(node: MdastNode, format: number): LexicalNode[] {
    const handler = importHandlers.get(node.type);
    if (handler) {
      const result = handler(node, getContext(format));
      if (result == null) {
        return [];
      }
      return Array.isArray(result) ? result : [result];
    }
    // Fallback: unwrap unknown containers, render unknown literals as text, and
    // drop anything else so no content silently corrupts the tree.
    if ('children' in node) {
      return $importChildren(node, format);
    }
    if ('value' in node && typeof node.value === 'string') {
      return $createTextNodes(node.value, format);
    }
    return [];
  }

  function $importChildren(parent: MdastParent, format: number): LexicalNode[] {
    const out: LexicalNode[] = [];
    for (const child of parent.children) {
      out.push(...$importNode(child, format));
    }
    return out;
  }

  // The walk runs under an import context (the same ContextRecord
  // mechanism the DOM import rules use, chained to the editor's
  // DOMImportExtension contextDefaults when present) so handlers can read
  // ambient state with $getImportContextValue and layer state for their
  // subtree with $withImportContext around ctx.importChildren — and any
  // DOM-rule session a handler opens (raw HTML) inherits it. Entering an
  // already-active markdown context is a no-op, so only the outermost
  // entry pays for the scope.
  const $inMarkdownContext = <T>(f: () => T): T =>
    $withImportContext([contextValue(ImportContextMarkdown, true)])(f);

  return {
    $importChildren: (parent: MdastParent, format: number) =>
      $inMarkdownContext(() => $importChildren(parent, format)),
    $importNode: (node: MdastNode, format: number) =>
      $inMarkdownContext(() => $importNode(node, format)),
  };
}

/**
 * Creates the import entry points for a compiled registry. The `Markdown`
 * variants parse a source string (recovering literal syntax like the list
 * bullet or link style from it); the `Mdast` variants walk a pre-parsed
 * tree, where no source string exists so syntax-preservation is skipped.
 * `$generateNodesFrom*` return an array of detached block-level Lexical
 * nodes without touching the document or the selection; `$import*` replace
 * the contents of the root (or a supplied element) with that result.
 */
export function createMdastImport(compiled: CompiledMdast): {
  $generateNodesFromMarkdown: (markdown: string) => LexicalNode[];
  $generateNodesFromMdast: (tree: Root) => LexicalNode[];
  $importMarkdown: (markdown: string, node?: ElementNode) => void;
  $importMdast: (tree: Root, node?: ElementNode) => void;
} {
  const $generateNodes = (tree: Root, source: string): LexicalNode[] => {
    const {$importNode} = createNodeImporter(
      compiled,
      source,
      collectDefinitions(tree),
    );

    // Top-level mdast children should produce block-level Lexical nodes. Any
    // stray inline content (e.g. from a fallback) is wrapped in a paragraph
    // so the result only ever contains valid block children.
    const blocks: LexicalNode[] = [];
    let pendingParagraph: ElementNode | null = null;
    const flushPending = () => {
      if (pendingParagraph) {
        blocks.push(pendingParagraph);
        pendingParagraph = null;
      }
    };
    for (const child of tree.children) {
      for (const lexicalNode of $importNode(child, 0)) {
        if ($isBlockLevelNode(lexicalNode)) {
          flushPending();
          blocks.push(lexicalNode);
        } else {
          if (!pendingParagraph) {
            pendingParagraph = $createParagraphNode();
          }
          $append(pendingParagraph, [lexicalNode]);
        }
      }
    }
    flushPending();
    return blocks;
  };

  const $generateNodesFromMarkdown = (markdown: string): LexicalNode[] =>
    $generateNodes(
      fromMarkdown(markdown, {
        extensions: compiled.micromarkExtensions,
        mdastExtensions: compiled.mdastExtensions,
      }),
      markdown,
    );

  const $generateNodesFromMdast = (tree: Root): LexicalNode[] =>
    $generateNodes(tree, '');

  const $replaceWithBlocks = (
    blocks: LexicalNode[],
    node?: ElementNode,
  ): void => {
    const root = node || $getRoot();
    root.clear();
    $prepend(root, blocks.length > 0 ? blocks : [$createParagraphNode()]);

    if ($getSelection() !== null) {
      root.selectStart();
    }
  };

  return {
    $generateNodesFromMarkdown,
    $generateNodesFromMdast,
    $importMarkdown: (markdown, node) =>
      $replaceWithBlocks($generateNodesFromMarkdown(markdown), node),
    $importMdast: (tree, node) =>
      $replaceWithBlocks($generateNodesFromMdast(tree), node),
  };
}
