/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Contracts C2 and C1 for HTML with block ids, over every node shape and
// BlockIdHTMLExtension's export option (absent, off, on): exporting HTML
// never throws; with export on, every identified block's id is written
// (`data-block-id`) exactly once, and with it off or absent none is;
// importing the exported HTML into a fresh editor never throws, and with
// export on every written id comes back on exactly one imported block.

import {
  $getBlockId,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$generateHtmlFromNodes, DOMImportExtension} from '@lexical/html';
import {BlockIdHTMLExtension} from '@lexical/html/BlockIdHTMLExtension';
import {
  $getEditor,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  type AnyLexicalExtensionArgument,
  configExtension,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$appendShapes, catalogAppExtension, NODE_SHAPES} from '../../catalog';

type Export = 'absent' | 'off' | 'on';
const EXPORTS: Export[] = ['absent', 'off', 'on'];

function build(exp: Export) {
  const deps: AnyLexicalExtensionArgument[] = [
    catalogAppExtension({blockIds: 'enabled'}),
    DOMImportExtension,
  ];
  if (exp !== 'absent') {
    deps.push(configExtension(BlockIdHTMLExtension, {export: exp === 'on'}));
  }
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: deps,
      name: `catalog-html-${exp}`,
      onError: e => {
        throw e;
      },
    }),
  );
}

/**
 * Hosts whose HTML export leaves their slots out: the blocks in those slots
 * have no element to carry an id. The downstream component stand-in exports
 * only its own element.
 */
const SLOTS_NOT_EXPORTED = new Set(['catalog_downstream_component']);

/** Every block id in the document, and those HTML export can write. */
function $ids(): {all: string[]; exportable: string[]} {
  const all: string[] = [];
  const exportable: string[] = [];
  const walk = (node: LexicalNode, omitted: boolean) => {
    const id = $getBlockId(node);
    if (id !== null) {
      all.push(id);
      if (!omitted) {
        exportable.push(id);
      }
    }
    for (const name of $getSlotNames(node)) {
      const slot = $getSlot(node, name);
      if (slot !== null) {
        walk(slot, omitted || SLOTS_NOT_EXPORTED.has(node.getType()));
      }
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        walk(child, omitted);
      }
    }
  };
  walk($getRoot(), false);
  return {all, exportable};
}

/** Each block that carries an id, as [id, type], holders of one id apart. */
function $blockTypes(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (node: LexicalNode) => {
    const id = $getBlockId(node);
    if (id !== null) {
      out.push([id, node.getType()]);
    }
    for (const name of $getSlotNames(node)) {
      const slot = $getSlot(node, name);
      if (slot !== null) {
        walk(slot);
      }
    }
    if ($isElementNode(node)) {
      node.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

describe('C1/C2: HTML export and import with block ids, every shape', () => {
  for (const shape of NODE_SHAPES) {
    for (const exp of EXPORTS) {
      // A page exports no element of its own (only its content is written),
      // so its id is not written (the Block IDs page says so, #9606). A list
      // item that only wraps a nested list has its id on the nested list's
      // element (data-block-wrapper-id).
      const failsUntilFixed =
        exp === 'on' && ['page/content'].includes(shape.name);
      (failsUntilFixed ? test.fails : test)(
        `${shape.name}, export ${exp}`,
        () => {
          const problems: string[] = [];
          const editor = build(exp);
          try {
            editor.update(() => $appendShapes([shape]), {discrete: true});
            editor.update(() => {}, {discrete: true});
            const ids = editor.read($ids);
            let html = '';
            try {
              html = editor.read(() => $generateHtmlFromNodes(editor));
            } catch (error) {
              problems.push(`export threw: ${String(error).slice(0, 200)}`);
            }
            const written = Array.from(
              html.matchAll(/data-block-(?:wrapper-)?id="([^"]*)"/g),
              m => m[1],
            );
            if (exp === 'on') {
              // Every id export can write, exactly once, and no other.
              const counts = new Map<string, number>();
              for (const id of written) {
                counts.set(id, (counts.get(id) ?? 0) + 1);
              }
              for (const id of ids.exportable) {
                if (counts.get(id) !== 1) {
                  problems.push(
                    `id ${id} written ${counts.get(id) ?? 0} times`,
                  );
                }
              }
              for (const id of written) {
                if (!ids.exportable.includes(id)) {
                  problems.push(`wrote ${id}, which no exportable block has`);
                }
              }
            } else if (written.length > 0) {
              problems.push(`export ${exp} wrote ids ${written.join(',')}`);
            }
            // Import into a fresh editor of the same app.
            const reader = build(exp);
            try {
              const dom = new DOMParser().parseFromString(html, 'text/html');
              reader.update(
                () => {
                  $getRoot().append(
                    ...getExtensionDependencyFromEditor(
                      $getEditor(),
                      DOMImportExtension,
                    ).output.$generateNodesFromDOM(dom),
                  );
                },
                {discrete: true},
              );
              reader.update(() => {}, {discrete: true});
              if (exp === 'on') {
                // The fresh editor had no ids: every written id comes back on
                // exactly one imported block, where import makes a block of
                // that type (it makes none for nodes without an importer,
                // such as the playground's containers and decorators).
                const typeOf = new Map(editor.read($blockTypes));
                const imported = reader.read($blockTypes);
                const madeTypes = new Set(imported.map(([, type]) => type));
                for (const id of written) {
                  const type = typeOf.get(id) ?? '';
                  if (!madeTypes.has(type)) {
                    continue;
                  }
                  const holders = imported.filter(([x]) => x === id);
                  if (holders.length !== 1 || holders[0][1] !== type) {
                    problems.push(
                      `imported ${type} id ${id} on ${holders.length} blocks (${holders.map(([, held]) => held).join(',') || 'none'})`,
                    );
                  }
                }
              }
            } catch (error) {
              problems.push(`import threw: ${String(error).slice(0, 200)}`);
            } finally {
              reader.dispose();
            }
          } finally {
            editor.dispose();
          }
          expect(problems).toEqual([]);
        },
      );
    }
  }
});
