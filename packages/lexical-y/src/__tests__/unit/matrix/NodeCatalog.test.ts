/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Keeps the node catalog complete: every LexicalNode subclass exported by
// `lexical` and the `@lexical/*` packages, every class in the playground's
// node list and every node class declared in the playground's sources is
// built by some shape of the catalog, or listed in NODE_EXCLUSIONS with a
// reason. A package or the playground that adds a node class fails this
// test until the catalog has a shape for it.

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $isLexicalNode,
  type Klass,
  type LexicalNode,
} from 'lexical';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import PlaygroundNodes from '../../../../../lexical-playground/src/nodes/PlaygroundNodes';
import {
  $appendShapes,
  CATALOG_NODES,
  NODE_EXCLUSIONS,
  NODE_SHAPES,
} from '../../catalog';

const REPO = path.resolve(__dirname, '../../../../../..');

/** Entry points that hold no runtime node classes, or do not load here. */
const ENTRY_EXCLUSIONS: ReadonlyMap<RegExp, string> = new Map([
  [/^@lexical\/eslint-plugin/, 'lint rules, no runtime'],
  [/^@lexical\/compiler/, 'build tooling, no runtime nodes'],
  [/^@lexical\/internal\//, 'error helpers, no nodes'],
  [/^@lexical\/devtools-core$/, 'devtools UI, no nodes'],
]);

/** Every public entry point, from the test tsconfig's path aliases. */
function entryPoints(): string[] {
  const {compilerOptions} = JSON.parse(
    fs.readFileSync(path.join(REPO, 'tsconfig.test.json'), 'utf8'),
  );
  return Object.keys(compilerOptions.paths as Record<string, string[]>).filter(
    name =>
      !name.includes('*') &&
      !name.endsWith('/src') &&
      !name.includes('__tests__') &&
      ![...ENTRY_EXCLUSIONS.keys()].some(re => re.test(name)),
  );
}

function isNodeClass(value: unknown): value is Klass<LexicalNode> {
  return (
    typeof value === 'function' &&
    // A subclass: its prototype is a LexicalNode (`lexical` exports the
    // base class as a type only).
    $isLexicalNode(value.prototype)
  );
}

/** The name a class is listed under in NODE_EXCLUSIONS. */
function exclusionName(klass: Klass<LexicalNode>, entry: string): string {
  return entry.startsWith('@lexical/react/')
    ? `${klass.name}@react`
    : klass.name;
}

const covered = new Set<Klass<LexicalNode>>(
  NODE_SHAPES.flatMap(s => s.classes),
);

describe('the node catalog', () => {
  test('every exported LexicalNode subclass has a shape or an exclusion', async () => {
    const missing: string[] = [];
    const seen = new Set<Klass<LexicalNode>>();
    for (const entry of entryPoints()) {
      const mod: Record<string, unknown> = await import(
        /* @vite-ignore */ entry
      );
      for (const value of Object.values(mod)) {
        if (!isNodeClass(value) || seen.has(value)) {
          continue;
        }
        seen.add(value);
        if (
          !covered.has(value) &&
          !NODE_EXCLUSIONS.has(exclusionName(value, entry))
        ) {
          missing.push(`${value.name} (${entry})`);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(20);
    expect(missing).toEqual([]);
    // Loading every entry point takes seconds on a loaded machine.
  }, 30000);

  test("every class of the playground's node list has a shape", () => {
    const missing = PlaygroundNodes.filter(k => !covered.has(k)).map(
      k => k.name,
    );
    expect(missing).toEqual([]);
  });

  test("every node class declared in the playground's sources has a shape", () => {
    // Classes its extensions register outside the node list (ruby, pages)
    // count too: found from the sources, by what they extend.
    const declared = new Map<string, string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') {
            walk(file);
          }
        } else if (/\.tsx?$/.test(entry.name)) {
          const source = fs.readFileSync(file, 'utf8');
          for (const m of source.matchAll(
            /\bclass\s+(\w+)\s+extends\s+(\w+)/g,
          )) {
            declared.set(m[1], m[2]);
          }
        }
      }
    };
    walk(path.join(REPO, 'packages/lexical-playground/src'));
    const nodeNames = new Set([
      'LexicalNode',
      'TextNode',
      'ElementNode',
      'DecoratorNode',
      'DecoratorBlockNode',
      'DecoratorTextNode',
      'BaseHorizontalRuleNode',
      ...CATALOG_NODES.map(k => k.name),
    ]);
    // Classes that extend a node class, to a fixed point.
    for (let grew = true; grew; ) {
      grew = false;
      for (const [name, base] of declared) {
        if (nodeNames.has(base) && !nodeNames.has(name)) {
          nodeNames.add(name);
          grew = true;
        }
      }
    }
    const coveredNames = new Set([...covered].map(k => k.name));
    const missing = [...declared.keys()].filter(
      name =>
        nodeNames.has(name) &&
        !coveredNames.has(name) &&
        !NODE_EXCLUSIONS.has(name),
    );
    expect(missing).toEqual([]);
  });

  test('every class a shape builds is registered by CATALOG_NODES', () => {
    const registered = new Set(CATALOG_NODES);
    const abstract = new Set(['DecoratorBlockNode', 'DecoratorTextNode']);
    const missing = [...covered]
      .filter(k => !registered.has(k) && !abstract.has(k.name))
      .filter(
        k =>
          !['TextNode', 'TabNode', 'LineBreakNode', 'ParagraphNode'].includes(
            k.name,
          ),
      )
      .map(k => k.name);
    expect(missing).toEqual([]);
  });

  test("a shape's tags say what it builds (lists, slots, tables)", () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        name: 'catalog-tags',
        nodes: () => [...CATALOG_NODES],
        onError: e => {
          throw e;
        },
      }),
    );
    const wrong: string[] = [];
    try {
      for (const shape of NODE_SHAPES) {
        editor.update(
          () => {
            $getRoot().clear();
            $appendShapes([shape]);
          },
          {discrete: true},
        );
        const found = editor.getEditorState().read(() => {
          const types = new Set<string>();
          let slots = false;
          const visit = (node: LexicalNode) => {
            types.add(node.getType());
            for (const name of $getSlotNames(node)) {
              slots = true;
              const slot = $getSlot(node, name);
              if (slot !== null) {
                visit(slot);
              }
            }
            if ($isElementNode(node)) {
              node.getChildren().forEach(visit);
            }
          };
          visit($getRoot());
          return {
            derived: types.has('listitem'),
            slots,
            table: types.has('table'),
          };
        });
        for (const [tag, has] of [
          ['derived', found.derived],
          ['list', found.derived],
          ['slots', found.slots],
          ['table', found.table],
        ] as const) {
          if (shape.tags.includes(tag) !== has) {
            wrong.push(
              `${shape.name}: ${has ? 'missing' : 'extra'} tag ${tag}`,
            );
          }
        }
      }
    } finally {
      editor.dispose();
    }
    expect(wrong).toEqual([]);
  });

  test('shape names are unique', () => {
    const names = NODE_SHAPES.map(s => s.name);
    expect(names.length).toBe(new Set(names).size);
  });

  test('every shape builds, and holds the classes it names', () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        name: 'catalog-completeness',
        nodes: () => [...CATALOG_NODES],
        onError: e => {
          throw e;
        },
      }),
    );
    try {
      for (const shape of NODE_SHAPES) {
        editor.update(
          () => {
            $getRoot().clear();
            $appendShapes([shape]);
          },
          {discrete: true},
        );
        const types = editor.getEditorState().read(() => {
          const found = new Set<string>();
          const visit = (node: LexicalNode) => {
            found.add(node.getType());
            if ('getChildren' in node) {
              (node as unknown as {getChildren(): LexicalNode[]})
                .getChildren()
                .forEach(visit);
            }
          };
          visit($getRoot());
          return found;
        });
        for (const klass of shape.classes) {
          if (
            ['DecoratorBlockNode', 'DecoratorTextNode'].includes(klass.name)
          ) {
            continue;
          }
          expect(
            types.has(klass.getType()) ||
              // Slot values are not children (they ride a separate map).
              shape.kind === 'slot-host',
            `${shape.name} holds a ${klass.getType()}`,
          ).toBe(true);
        }
      }
    } finally {
      editor.dispose();
    }
  });
});
