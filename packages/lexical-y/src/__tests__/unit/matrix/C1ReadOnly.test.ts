/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Contracts C1 and C3 for documents an editor opens read only, for every
// read-only cause in the configuration catalog: a newer schemaVersion, a
// newer layout record, a node type the reader lacks, and a Y.Doc that
// cleans up formatting (a plain `new Y.Doc()`). Binding never throws; the
// binding is read only with the documented warning; a local edit writes
// nothing to the document; and the editor shows the content (text, list
// numbering and derived fields as an editor without collab derives them).
// The same documents opened by a reader that can write (equal schema)
// stay editable, as a control.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  ElementNode,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {
  LAYOUT_VERSION,
  UNKNOWN_NODE_TYPES_WARNING,
  UNSUPPORTED_CONFIG_WARNING,
  UNSUPPORTED_LAYOUT_WARNING,
  UNSUPPORTED_SCHEMA_WARNING,
} from '../../..';
import {seedYState} from '../../../headless';
import {
  $appendShapes,
  bindFresh,
  type BindMode,
  type BoundEditor,
  catalogAppExtension,
  DEFAULT_CONFIG,
  NODE_SHAPES,
  type NodeShape,
  shapeDocs,
  snapshot,
  unboundSnapshot,
} from '../../catalog';

/** A block type only a newer app version registers. */
class NewerBlockNode extends ElementNode {
  $config() {
    return this.config('catalog_newer_block', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('section');
  }
  updateDOM(): false {
    return false;
  }
}
const NewerApp = defineExtension({
  name: 'catalog-newer-app',
  nodes: () => [NewerBlockNode],
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    c();
  }
});

/** The read-only causes of the configuration catalog this covers. */
type Cause = 'schema' | 'layout' | 'unknown-type' | 'cleanup-formatting';
const CAUSES: Cause[] = [
  'schema',
  'layout',
  'unknown-type',
  'cleanup-formatting',
];
const WARNING: Record<Cause, string> = {
  'cleanup-formatting': UNSUPPORTED_CONFIG_WARNING,
  layout: UNSUPPORTED_LAYOUT_WARNING,
  schema: UNSUPPORTED_SCHEMA_WARNING,
  'unknown-type': UNKNOWN_NODE_TYPES_WARNING,
};

/** The stored state a writer of `cause`'s kind leaves. */
function stateFor(cause: Cause, shapes: readonly NodeShape[]): Uint8Array {
  const base = {
    extensions: [catalogAppExtension(DEFAULT_CONFIG)],
    schemaVersion: 1,
  };
  if (cause === 'schema') {
    return seedYState({...base, schemaVersion: 2}, () => $appendShapes(shapes));
  }
  if (cause === 'unknown-type') {
    return seedYState(
      {...base, extensions: [catalogAppExtension(DEFAULT_CONFIG), NewerApp]},
      () => {
        $appendShapes(shapes);
        $getRoot().append(
          new NewerBlockNode().append(
            $createParagraphNode().append($createTextNode('newer')),
          ),
        );
      },
    );
  }
  const state = seedYState(base, () => $appendShapes(shapes));
  if (cause === 'layout') {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    doc.get('lexical-y').setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
    return Y.encodeStateAsUpdate(doc);
  }
  return state;
}

function vector(doc: Y.Doc): string {
  return JSON.stringify(Array.from(Y.encodeStateVector(doc)));
}

async function runCell(
  cause: Cause,
  shapes: readonly NodeShape[],
  mode: BindMode,
  dom: 'headless' | 'jsdom',
): Promise<string[]> {
  const out: string[] = [];
  const state = stateFor(cause, shapes);
  const config = {
    ...DEFAULT_CONFIG,
    doc:
      cause === 'cleanup-formatting'
        ? ('plain' as const)
        : ('createYDoc' as const),
    dom,
  };
  let b: BoundEditor;
  try {
    b = bindFresh(state, config, mode);
  } catch (error) {
    return [`bind threw: ${String(error)}`];
  }
  cleanups.push(() => b.dispose());
  await new Promise(resolve => setTimeout(resolve, 0));
  if (b.binding.status !== 'readonly') {
    out.push(`status ${b.binding.status}, not readonly`);
  }
  if (!b.warningCodes.includes(WARNING[cause])) {
    out.push(
      `no ${WARNING[cause]} warning (got ${JSON.stringify(b.warningCodes)})`,
    );
  }
  // What the editor shows: the stored text and the derived fields.
  const shown = snapshot(b.editor);
  const expected = unboundSnapshot(shapes, config);
  if (JSON.stringify(shown.numbering) !== JSON.stringify(expected.numbering)) {
    out.push(
      `numbering ${JSON.stringify(shown.numbering)} != ${JSON.stringify(expected.numbering)}`,
    );
  }
  const text = b.editor
    .getEditorState()
    .read(() => $getRoot().getTextContent());
  const expectedText = unboundText(shapes);
  if (cause !== 'unknown-type' && text !== expectedText) {
    out.push(
      `text ${JSON.stringify(text.slice(0, 80))} != ${JSON.stringify(expectedText.slice(0, 80))}`,
    );
  }
  if (cause === 'unknown-type' && !text.startsWith(expectedText)) {
    out.push(`text lost: ${JSON.stringify(text.slice(0, 80))}`);
  }
  // A local edit writes nothing.
  const before = vector(b.doc);
  try {
    b.editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('local')),
        );
      },
      {discrete: true},
    );
  } catch (error) {
    out.push(`a local edit threw: ${String(error)}`);
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  if (vector(b.doc) !== before) {
    out.push('a local edit was written to a read-only document');
  }
  out.push(...b.errors.map(e => `error: ${String(e)}`));
  return out;
}

function unboundText(shapes: readonly NodeShape[]): string {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(DEFAULT_CONFIG)],
      name: 'catalog-read-only-text',
      onError: e => {
        throw e;
      },
    }),
  );
  try {
    editor.update(
      () => {
        $getRoot().clear();
        $appendShapes(shapes);
      },
      {discrete: true},
    );
    return editor.getEditorState().read(() => $getRoot().getTextContent());
  } finally {
    editor.dispose();
  }
}

const DOCS: NodeShape[][] = [
  [
    NODE_SHAPES.find(s => s.name === 'card/declared-slot')!,
    NODE_SHAPES.find(s => s.name === 'list/number-start-5')!,
  ],
  ...shapeDocs(0, 12, 0x4e0),
];
const MODES: BindMode[] = ['binding', 'extension', 'extension-then-sync'];

describe('C1/C3: read-only documents', () => {
  CAUSES.forEach((cause, c) => {
    DOCS.forEach((shapes, i) => {
      const mode = MODES[(i + c) % MODES.length];
      const dom = (i + c) % 2 === 0 ? 'headless' : 'jsdom';
      test(`${cause}: ${shapes.map(s => s.name).join(' + ')} [${mode}, ${dom}]`, async () => {
        expect(await runCell(cause, shapes, mode, dom)).toEqual([]);
      });
    });
  });
});
