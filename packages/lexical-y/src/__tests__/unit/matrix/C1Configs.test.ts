/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Contract C1 over the remaining configuration dimensions: marks
// (MarkStateExtension, a mark flavor of the app's own), batched updates, an
// IME composition open while changes arrive, `onError` that logs (with an
// update listener that throws), and a reader whose schemaVersion is newer
// than the writer's. In each, the bound editor makes local edits from the
// core op catalog and receives a peer's change; once settled it shows what
// a fresh readYState of its own document shows, and its derived fields
// match an editor without collab.

import {$addMarkID} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  type LexicalNode,
  TextNode,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {editYState, seedYState} from '../../../headless';
import {
  $appendShapes,
  bindFresh,
  type BindMode,
  type BoundEditor,
  CatalogCommentMarks,
  type CatalogConfig,
  catalogHeadlessConfig,
  configLabel,
  CORE_OPS,
  DEFAULT_CONFIG,
  firstDifference,
  freshSnapshot,
  NODE_SHAPES,
  type NodeShape,
  prng,
  shapeDocs,
  snapshot,
} from '../../catalog';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    c();
  }
});

const elide = (json: unknown) =>
  JSON.parse(JSON.stringify(json), (key, value) =>
    key === 'editorState' && value !== null && typeof value === 'object'
      ? '(nested editor)'
      : value,
  );

type Variant = {
  name: string;
  config: Partial<CatalogConfig>;
  /** The reader's schemaVersion (the writer's is 1). */
  schemaVersion?: number;
};

const VARIANTS: Variant[] = [
  {config: {marks: 'mark-state'}, name: 'MarkStateExtension'},
  {config: {marks: 'mark-flavor'}, name: 'a mark flavor'},
  {config: {updates: 'batched'}, name: 'batched updates'},
  {config: {composing: 'yes'}, name: 'IME composing'},
  {config: {onError: 'log'}, name: 'onError logs, a transform throws'},
  {config: {schemaVersion: 'newer'}, name: 'newer reader', schemaVersion: 2},
];

function $texts(): TextNode[] {
  const out: TextNode[] = [];
  const walk = (node: LexicalNode) => {
    if ($isTextNode(node) && node.isSimpleText()) {
      out.push(node);
    }
    if ('getChildren' in node) {
      (node as unknown as {getChildren(): LexicalNode[]})
        .getChildren()
        .forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

/** Marks a range of the first texts with `id`, per the config's flavor. */
function $markSome(config: CatalogConfig, id: string): void {
  const texts = $texts().filter(t => t.getTextContentSize() > 2);
  if (texts.length === 0 || config.marks === 'none') {
    return;
  }
  const first = texts[0];
  const last = texts[Math.min(2, texts.length - 1)];
  const s = $createRangeSelection();
  s.anchor.set(first.getKey(), 1, 'text');
  s.focus.set(last.getKey(), last.getTextContentSize() - 1, 'text');
  if (config.marks === 'mark-flavor') {
    $addMarkID(CatalogCommentMarks, id, s);
  } else {
    $addMarkID(id, s);
  }
}

async function runCell(
  variant: Variant,
  shapes: readonly NodeShape[],
  mode: BindMode,
  dom: 'headless' | 'jsdom',
  seedNumber: number,
): Promise<string[]> {
  const out: string[] = [];
  const config: CatalogConfig = {...DEFAULT_CONFIG, ...variant.config, dom};
  const seed = seedYState(catalogHeadlessConfig(config), () => {
    $appendShapes(shapes);
    $markSome(config, 'c1');
  });
  let thrown = false;
  const b: BoundEditor = bindFresh(
    seed,
    config,
    mode,
    config.onError === 'log'
      ? editor =>
          // A transform that throws once: Lexical reports it to onError
          // (errors thrown by update listeners reach the caller instead).
          editor.registerNodeTransform(TextNode, () => {
            if (!thrown) {
              thrown = true;
              throw new Error('an app transform throws once');
            }
          })
      : undefined,
    {schemaVersion: variant.schemaVersion},
  );
  cleanups.push(() => b.dispose());
  const check = (when: string) => {
    const state = Y.encodeStateAsUpdate(b.doc);
    const fresh = freshSnapshot(state, config, variant.schemaVersion ?? 1);
    const shown = snapshot(b.editor);
    const d = firstDifference(elide(shown.json), elide(fresh.json));
    if (d !== null) {
      out.push(`${when}: differs from a fresh readYState at ${d}`);
    }
    if (JSON.stringify(shown.numbering) !== JSON.stringify(fresh.numbering)) {
      out.push(
        `${when}: numbering ${JSON.stringify(shown.numbering)} != ${JSON.stringify(fresh.numbering)}`,
      );
    }
  };
  await new Promise(resolve => setTimeout(resolve, 0));
  check('after the read');
  const rand = prng(seedNumber);
  if (config.composing === 'yes') {
    b.editor.update(
      () => {
        const t = $texts()[0];
        if (t !== undefined) {
          const s = $createRangeSelection();
          s.anchor.set(t.getKey(), 0, 'text');
          s.focus.set(t.getKey(), 0, 'text');
          $setSelection(s);
          $setCompositionKey(t.getKey());
          t.spliceText(0, 0, 'ime');
        }
      },
      {discrete: true},
    );
  }
  // Local edits.
  for (let i = 0; i < 3; i++) {
    const op = CORE_OPS[Math.floor(rand() * CORE_OPS.length)];
    try {
      b.editor.update(
        () => {
          op.$run(rand);
          if (i === 0) {
            $markSome(config, 'c2');
          }
        },
        config.updates === 'batched' ? {} : {discrete: true},
      );
    } catch (error) {
      out.push(`local ${op.name} threw: ${String(error).slice(0, 160)}`);
    }
  }
  // A peer's change, from the state as stored before the local edits.
  const {update} = editYState(
    seed,
    catalogHeadlessConfig(config, {schemaVersion: 1}),
    () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('from a peer')),
      );
      const t = $texts()[1];
      if (t !== undefined) {
        t.spliceText(0, 0, 'peer ');
      }
    },
    {writer: null},
  );
  if (update !== null) {
    Y.applyUpdate(b.doc, update, 'provider');
  }
  if (config.composing === 'yes') {
    b.editor.update(() => $setCompositionKey(null), {discrete: true});
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  check('settled');
  const unexpected = b.errors.filter(
    e => !String(e).includes('an app transform throws once'),
  );
  out.push(...unexpected.map(e => `error: ${String(e).slice(0, 200)}`));
  const selfCheck = b.warnings.filter(
    w => w.includes('self-check') && !w.includes('.editorState.'),
  );
  out.push(...selfCheck.map(w => w.slice(0, 200)));
  if (b.binding.status !== 'active') {
    out.push(`binding ${b.binding.status}`);
  }
  return out;
}

const DOCS: NodeShape[][] = [
  [
    'card/declared-slot',
    'list/number-start-5',
    'paragraph/formatted-first-text',
    'mark/text',
    'link/text',
  ].map(n => NODE_SHAPES.find(s => s.name === n)!),
  ...shapeDocs(0, 16, 0xc0f),
];
const MODES: BindMode[] = ['binding', 'extension'];

describe('C1 over marks, batching, IME, onError and schema versions', () => {
  VARIANTS.forEach((variant, v) => {
    DOCS.forEach((shapes, i) => {
      for (const mode of MODES) {
        const dom = (i + v) % 2 === 0 ? 'jsdom' : 'headless';
        const config = {
          ...DEFAULT_CONFIG,
          ...variant.config,
          dom,
        } as CatalogConfig;
        test(`${variant.name}: ${shapes.map(s => s.name).join(' + ')} [${mode}, ${configLabel(config)}]`, async () => {
          expect(
            await runCell(variant, shapes, mode, dom, 100 * v + i),
          ).toEqual([]);
        });
      }
    });
  });
});
