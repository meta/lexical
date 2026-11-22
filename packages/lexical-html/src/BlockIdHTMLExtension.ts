/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getBlockHandle,
  $getBlockId,
  $getExtensionDependency,
  $getExtensionOutput,
  BlockIdExtension,
  blockIdState,
  namedSignals,
} from '@lexical/extension';
import {
  $getNodeByKey,
  $isDecoratorNode,
  $isElementNode,
  $isRootOrShadowRoot,
  $setState,
  configExtension,
  defineExtension,
  isHTMLElement,
  type LexicalNode,
  type NodeKey,
  RootNode,
  safeCast,
} from 'lexical';

// Everything shared with the package root comes through it: the build keeps
// a relative import of an entry point external, while any other module would
// be bundled into this entry as a second copy, with its own
// DOMImportExtension and ImportOverlays.
import {
  createImportState,
  defineImportRule,
  defineOverlayRules,
  DOMImportExtension,
  domOverride,
  type DOMPreprocessFn,
  DOMRenderExtension,
  ImportOverlays,
  sel,
} from './index';

/**
 * The attribute that carries a block id in HTML.
 *
 * @experimental
 */
export const BLOCK_ID_ATTRIBUTE = 'data-block-id';

/**
 * The attribute that carries a block handle (see `$getBlockHandle` in
 * `@lexical/extension`) in HTML exported with `handles: true`. Import
 * never reads it.
 *
 * @experimental
 */
export const BLOCK_HANDLE_ATTRIBUTE = 'data-block-handle';

/**
 * The attribute that carries the block id of a block whose own element its
 * export removes, handing its children to another element: a list item that
 * only wraps a nested list is exported as that nested list, inside the
 * previous item's element. The id goes on the first element the block's
 * element held (the nested list), and import puts it back on the block that
 * ends up holding only what that element produced (the wrapper item), where
 * the import of that element, its parent or its grandparent makes it (the
 * list importer does, in the outer list); otherwise that block gets a new id.
 *
 * @experimental
 */
export const BLOCK_WRAPPER_ID_ATTRIBUTE = 'data-block-wrapper-id';

/** @experimental */
export interface BlockIdHTMLConfig {
  /**
   * Write {@link BLOCK_ID_ATTRIBUTE} on the exported element of every
   * identified block (`$generateHtmlFromNodes`, copy as HTML, …).
   *
   * Showing blocks to a model? Set {@link BlockIdHTMLConfig.handles} too.
   */
  export: boolean;
  /**
   * With {@link BlockIdHTMLConfig.export} on, write each block's handle in
   * {@link BLOCK_HANDLE_ATTRIBUTE} instead of its id in
   * {@link BLOCK_ID_ATTRIBUTE}: a short opaque name derived from a hash of
   * the id (see `$getBlockHandle`), for HTML shown to a model. Keep the
   * handles of the export (`$getBlockHandles()`, in the same read), and
   * resolve what the model answers with `$resolveBlockHandle(handle, {read})`,
   * so that a handle names the block the model was shown, never a block added
   * since. Import does not read handles, so a handle is never mistaken for an
   * id. Default: `false`. Optional, so that a whole `BlockIdHTMLConfig`
   * written for an earlier version still type-checks.
   *
   * ```ts
   * configExtension(BlockIdHTMLExtension, {handles: true});
   * // The HTML the model reads, and the handles it is shown, in one read.
   * const [html, shown] = editor.read(() => [
   *   $generateHtmlFromNodes(editor),
   *   $getBlockHandles(),
   * ]);
   * // <p data-block-handle="gTtF">Revenue grew 4% in Q3.</p>
   * // The model answers {block: 'gTtF', text: 'Revenue grew 6% in Q3.'}
   * editor.update(() => {
   *   const result = $resolveBlockHandle(op.block, {read: shown});
   *   if (result.status === 'found') {
   *     // In place, only the characters that differ (the Block IDs page has
   *     // this `$setBlockText`), rather than re-creating the block.
   *     $setBlockText(result.node, op.text);
   *   }
   * });
   * ```
   */
  handles?: boolean;
  /**
   * Read {@link BLOCK_ID_ATTRIBUTE} back when HTML is imported through
   * {@link DOMImportExtension}, onto the block that the element produced.
   * Imported ids are never trusted: an invalid one is ignored, and a valid
   * one goes through the uniqueness rule of {@link BlockIdExtension}, so
   * pasting HTML that carries ids already in the document gives the pasted
   * blocks fresh ids. An imported id is dropped from a block that is not
   * identified once it is inserted (a table cell, a nested list).
   */
  import: boolean;
}

function $isBlockForId(node: LexicalNode): boolean {
  return ($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline();
}

const BlockIdImportRule = defineImportRule({
  $import: (ctx, el, $next) => {
    const nodes = $next();
    const {init, output} = $getExtensionDependency(BlockIdHTMLExtension);
    if (!output.import.peek()) {
      return nodes;
    }
    const id = blockIdState.parse(el.getAttribute(BLOCK_ID_ATTRIBUTE));
    if (id !== undefined) {
      // The element produced this block (and possibly inline siblings or
      // hoisted children after it): the first block is the one it describes.
      for (const node of nodes) {
        if ($isBlockForId(node)) {
          if ($getBlockId(node) === null) {
            $setState(node, blockIdState, id);
            (init as Set<NodeKey>).add(node.getKey());
          }
          break;
        }
      }
    }
    return nodes;
  },
  match: sel.any().attr(BLOCK_ID_ATTRIBUTE, true),
  name: '@lexical/html/block-id',
});

/**
 * The nodes that elements carrying {@link BLOCK_WRAPPER_ID_ATTRIBUTE}
 * produced in an import, with that id: the block that ends up holding one of
 * them alone gets the id (see BlockWrapperIdResolveRule). Per import session
 * (an import run inside another has its own).
 */
const PendingWrapperIds = createImportState<{
  /** The waiting ids, by the key of the node they wait for. */
  readonly pending: Map<NodeKey, string>;
  /**
   * The ids still looked for, in the order they were found: the node's key
   * and the element that carried the id. An id is looked for by the
   * elements around that element up to its grandparent (the list around
   * the item around the nested list: where the importer makes the item that
   * wraps it), and dropped after.
   */
  readonly active: {key: NodeKey; el: Element}[];
} | null>('blockWrapperIds', () => null);

const BlockWrapperIdImportRule = defineImportRule({
  $import: (ctx, el, $next) => {
    const nodes = $next();
    const {output} = $getExtensionDependency(BlockIdHTMLExtension);
    if (!output.import.peek()) {
      return nodes;
    }
    const id = blockIdState.parse(el.getAttribute(BLOCK_WRAPPER_ID_ATTRIBUTE));
    const waiting = ctx.session.get(PendingWrapperIds);
    if (id !== undefined && waiting !== null) {
      for (const node of nodes) {
        if ($isBlockForId(node)) {
          waiting.pending.set(node.getKey(), id);
          waiting.active.push({el, key: node.getKey()});
          break;
        }
      }
    }
    return nodes;
  },
  match: sel.any().attr(BLOCK_WRAPPER_ID_ATTRIBUTE, true),
  name: '@lexical/html/block-wrapper-id',
});

/**
 * Around each element's import: of the wrapper ids found in its children or
 * grandchildren, each one's node, if its parent now holds it alone and is a
 * block without an id (the item the list importer wraps a nested list in,
 * when it makes the outer list), gives that parent the id, through the same
 * rules as an imported id. An id is looked at by three elements at most
 * (its own, its parent and its grandparent), so the cost is linear in the
 * ids.
 */
const BlockWrapperIdResolveRule = defineImportRule({
  $import: (ctx, el, $next) => {
    const waiting = ctx.session.get(PendingWrapperIds);
    const from = waiting === null ? 0 : waiting.active.length;
    const nodes = $next();
    if (waiting === null || waiting.active.length === from) {
      return nodes;
    }
    const {pending, active} = waiting;
    const {init} = $getExtensionDependency(BlockIdHTMLExtension);
    let kept = from;
    for (let k = from; k < active.length; k++) {
      const entry = active[k];
      const id = pending.get(entry.key);
      if (id === undefined) {
        continue;
      }
      const node = $getNodeByKey(entry.key);
      const holder = node === null ? null : node.getParent();
      if (
        holder !== null &&
        holder.getChildrenSize() === 1 &&
        !$isRootOrShadowRoot(holder) &&
        $isBlockForId(holder) &&
        $getBlockId(holder) === null
      ) {
        $setState(holder, blockIdState, id);
        (init as Set<NodeKey>).add(holder.getKey());
        pending.delete(entry.key);
      } else if (entry.el === el || entry.el.parentElement === el) {
        // Its parent, or its grandparent, looks again.
        active[kept++] = entry;
      } else {
        pending.delete(entry.key);
      }
    }
    active.length = kept;
    return nodes;
  },
  match: sel.any(),
  name: '@lexical/html/block-wrapper-id-resolve',
});

const BlockIdImportOverlay = defineOverlayRules([
  BlockIdImportRule,
  BlockWrapperIdImportRule,
]);
const BlockWrapperIdResolveOverlay = defineOverlayRules([
  BlockWrapperIdResolveRule,
]);

/**
 * Installs the import rule as a walk-wide overlay, so it wraps whichever rule
 * converts the element, whatever the order of the extensions that contribute
 * import rules.
 */
const $installBlockIdImportOverlay: DOMPreprocessFn = (dom, ctx, $next) => {
  // The resolver runs for every element, so only where the HTML carries a
  // wrapper id.
  const wrapped =
    'querySelector' in dom &&
    dom.querySelector(`[${BLOCK_WRAPPER_ID_ATTRIBUTE}]`) !== null;
  if (wrapped) {
    ctx.session.set(PendingWrapperIds, {active: [], pending: new Map()});
  }
  ctx.session.update(ImportOverlays, prev =>
    wrapped
      ? [...prev, BlockIdImportOverlay, BlockWrapperIdResolveOverlay]
      : [...prev, BlockIdImportOverlay],
  );
  $next();
};

/**
 * Opt-in HTML support for {@link BlockIdExtension}: exported HTML carries
 * each identified block's id in a `data-block-id` attribute, and HTML imported
 * through {@link DOMImportExtension} reads it back (through the uniqueness
 * rule, so ids in pasted HTML never clash with ids in the document).
 *
 * For HTML shown to a model, `handles: true` writes short handles in
 * `data-block-handle` instead (see {@link BlockIdHTMLConfig.handles}).
 *
 * This lives in `@lexical/html` rather than in {@link BlockIdExtension}
 * because `@lexical/html` depends on `@lexical/extension`. The legacy
 * `$generateNodesFromDOM` path (`importDOM`) does not read the attribute.
 *
 * @experimental
 */
export const BlockIdHTMLExtension = defineExtension({
  build: (editor, config) =>
    namedSignals({
      export: config.export,
      handles: config.handles === true,
      import: config.import,
    }),
  config: safeCast<BlockIdHTMLConfig>({
    export: true,
    handles: false,
    import: true,
  }),
  dependencies: [
    BlockIdExtension,
    configExtension(DOMRenderExtension, {
      overrides: [
        domOverride(
          '*',
          {
            $exportDOM(node, $next) {
              const output = $next();
              const html = $getExtensionOutput(BlockIdHTMLExtension);
              if (
                isHTMLElement(output.element) &&
                html.export.peek() &&
                $getExtensionOutput(BlockIdExtension).$isIdentifiedBlock(node)
              ) {
                if (html.handles.peek()) {
                  const handle = $getBlockHandle(node);
                  if (handle !== null) {
                    output.element.setAttribute(BLOCK_HANDLE_ATTRIBUTE, handle);
                  }
                } else {
                  const id = $getBlockId(node);
                  if (id !== null) {
                    output.element.setAttribute(BLOCK_ID_ATTRIBUTE, id);
                    const {after} = output;
                    if (after !== undefined) {
                      // Where the export removes the block's element and
                      // hands its children to another element (a list item
                      // that only wraps a nested list), the id goes on the
                      // first element it held (BLOCK_WRAPPER_ID_ATTRIBUTE).
                      return {
                        ...output,
                        after(generated) {
                          const first = isHTMLElement(generated)
                            ? generated.firstElementChild
                            : null;
                          const result = after(generated);
                          if (
                            isHTMLElement(generated) &&
                            generated.parentNode === null &&
                            result === generated &&
                            isHTMLElement(first) &&
                            first.parentNode !== generated &&
                            first.parentNode !== null
                          ) {
                            first.setAttribute(BLOCK_WRAPPER_ID_ATTRIBUTE, id);
                          }
                          return result;
                        },
                      };
                    }
                  }
                }
              }
              return output;
            },
          },
          {
            // Left out of export sessions while `export` is off, so that
            // nothing runs for each exported element.
            disabledForSession: (): boolean =>
              !$getExtensionOutput(BlockIdHTMLExtension).export.peek(),
          },
        ),
      ],
    }),
    configExtension(DOMImportExtension, {
      preprocess: [$installBlockIdImportOverlay],
    }),
  ],
  // The keys of the blocks that got an id from HTML in this update, opaque
  // outside this module (`unknown`, as in the Flow types).
  init: (): unknown => new Set<NodeKey>(),
  name: '@lexical/html/BlockIdHTML',
  register(editor, config, state) {
    const imported = state.getInitResult() as Set<NodeKey>;
    // Root transforms run after the other transforms of a pass, once the
    // imported blocks are inserted, so the predicate can see where they are.
    return editor.registerNodeTransform(RootNode, () => {
      if (imported.size === 0) {
        return;
      }
      const {$isIdentifiedBlock} = $getExtensionOutput(BlockIdExtension);
      for (const key of imported) {
        const node = $getNodeByKey(key);
        if (node !== null && node.isAttached() && !$isIdentifiedBlock(node)) {
          $setState(node, blockIdState, undefined);
        }
      }
      imported.clear();
    });
  },
});
