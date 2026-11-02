/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Editors and documents for a catalog configuration (see configs.ts): the
// app extension that registers every catalog node, seeding a document with
// shapes, binding a fresh editor to it the ways an app does, and snapshots
// of what an editor shows (JSON, derived fields, list numbering) to compare.

import {
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$isListItemNode, $isListNode, ListExtension} from '@lexical/list';
import {defineMarkExtension, MarkStateExtension} from '@lexical/mark';
import {TableExtension} from '@lexical/table';
import * as Y from '@y/y';
import {
  $getEditor,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  type AnyLexicalExtensionArgument,
  configExtension,
  defineExtension,
  getDeclaredNodeStructure,
  type LexicalEditor,
  type LexicalNode,
  type SerializedEditorState,
} from 'lexical';

import {PagesExtension} from '../../../../lexical-playground/src/plugins/PagesExtension/PagesExtension';
import {YBinding, YCollabExtension, type YDoc} from '../..';
import {
  createYDoc,
  type HeadlessYConfig,
  readYState,
  seedYState,
} from '../../headless';
import {type CatalogConfig, DEFAULT_CONFIG} from './configs';
import {$appendShapes, CATALOG_NODES, type NodeShape} from './nodes';

/** A mark flavor of an app's own (comments under `commentIds`). */
export const CatalogCommentMarks = defineMarkExtension({
  name: '@catalog/CommentMarks',
  stateKey: 'commentIds',
});

/**
 * The app: every catalog node, list numbering, tables, and block ids and
 * marks per config.
 */
export function catalogAppExtension(
  config: Pick<CatalogConfig, 'blockIds'> &
    Partial<Pick<CatalogConfig, 'marks'>> = DEFAULT_CONFIG,
): AnyLexicalExtensionArgument {
  const dependencies: AnyLexicalExtensionArgument[] = [
    ListExtension,
    // Table transforms (row padding, merge normalization), as apps with
    // tables register them; without a horizontal scroll wrapper, which
    // needs a theme class the catalog does not define.
    configExtension(TableExtension, {hasHorizontalScroll: false}),
    // Page nodes read its config when they render; disabled, it does not
    // paginate the document.
    configExtension(PagesExtension, {disabled: true}),
  ];
  if (config.marks === 'mark-state') {
    dependencies.push(MarkStateExtension);
  } else if (config.marks === 'mark-flavor') {
    dependencies.push(CatalogCommentMarks);
  }
  if (config.blockIds === 'enabled') {
    dependencies.push(BlockIdExtension);
  } else if (config.blockIds === 'disabled') {
    dependencies.push(configExtension(BlockIdExtension, {disabled: true}));
  }
  return defineExtension({
    dependencies,
    name: `catalog-app-${config.blockIds}-${config.marks || 'none'}`,
    nodes: () => [...CATALOG_NODES],
  });
}

/** The headless config of the same app. */
export function catalogHeadlessConfig(
  config: Pick<CatalogConfig, 'blockIds'> &
    Partial<Pick<CatalogConfig, 'marks'>> = DEFAULT_CONFIG,
  extra: Partial<HeadlessYConfig> = {},
): HeadlessYConfig {
  return {
    extensions: [catalogAppExtension(config)],
    schemaVersion: 1,
    ...extra,
  };
}

/** A stored state holding `shapes`, written headless (as a server does). */
export function seedShapes(
  shapes: readonly NodeShape[],
  config: Pick<CatalogConfig, 'blockIds'> &
    Partial<Pick<CatalogConfig, 'marks'>> = DEFAULT_CONFIG,
): Uint8Array {
  return seedYState(catalogHeadlessConfig(config), () => $appendShapes(shapes));
}

export type BindMode = 'binding' | 'extension' | 'extension-then-sync';

export interface BoundEditor {
  readonly editor: LexicalEditor;
  readonly binding: YBinding;
  readonly doc: Y.Doc;
  readonly root: HTMLElement | null;
  readonly warnings: string[];
  /** The `code` of every typed warning (`@lexical/y/...`), in order. */
  readonly warningCodes: string[];
  readonly errors: unknown[];
  dispose(): void;
}

/**
 * An editor freshly bound to a document holding `state`, as an app binds
 * one: a YBinding it starts and initializes (`binding`), YCollabExtension on
 * a synced document (`extension`), or on one the provider syncs after the
 * editor is built (`extension-then-sync`). With `dom: 'jsdom'` the editor
 * has a root element (mounted before binding, so the read renders). Nothing
 * is awaited: read it right away.
 */
export function bindFresh(
  state: Uint8Array,
  config: Pick<CatalogConfig, 'blockIds' | 'dom' | 'doc' | 'onError'> &
    Partial<Pick<CatalogConfig, 'marks'>>,
  mode: BindMode,
  /**
   * Runs on the editor before the binding's first read (an app's own
   * listeners and transforms); its return value runs on dispose.
   */
  prepare?: (editor: LexicalEditor) => void | (() => void),
  options: {
    schemaVersion?: number;
    extraNodes?: AnyLexicalExtensionArgument[];
  } = {},
): BoundEditor {
  const schemaVersion = options.schemaVersion ?? 1;
  // A plain `new Y.Doc()` (format cleanup on) is a configuration the
  // binding must refuse with a warning; the types only admit `createYDoc`.
  const doc: YDoc =
    config.doc === 'plain'
      ? (new Y.Doc() as unknown as YDoc)
      : createYDoc(null, {gc: false});
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const cleanups: (() => void)[] = [];
  const onError = (error: Error) => {
    errors.push(error);
    if (config.onError === 'rethrow') {
      throw error;
    }
  };
  const warningCodes: string[] = [];
  const onWarn = (warning: Error) => {
    warnings.push(String(warning));
    const code = (warning as {code?: unknown}).code;
    if (typeof code === 'string') {
      warningCodes.push(code);
    }
  };
  let root: HTMLElement | null = null;
  const mount = (editor: LexicalEditor) => {
    if (config.dom !== 'jsdom') {
      return;
    }
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    editor.setRootElement(root);
    const mounted = root;
    cleanups.push(() => {
      editor.setRootElement(null);
      mounted.remove();
    });
  };
  if (mode !== 'extension-then-sync') {
    Y.applyUpdate(doc, state, 'load');
  }
  let editor: LexicalEditor;
  let binding: YBinding;
  const prepared: AnyLexicalExtensionArgument[] =
    prepare === undefined
      ? []
      : [
          defineExtension({
            name: 'catalog-prepare',
            register: (e: LexicalEditor) => prepare(e) || (() => {}),
          }),
        ];
  if (mode === 'binding') {
    const built = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          catalogAppExtension(config),
          ...(options.extraNodes || []),
          ...prepared,
        ],
        name: 'catalog-host',
        onError,
        onWarn,
      }),
    );
    cleanups.push(() => built.dispose());
    editor = built;
    mount(editor);
    binding = new YBinding(editor, doc, {schemaVersion, selfCheck: true});
    cleanups.push(binding.start());
    binding.initialize();
  } else {
    const built = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          catalogAppExtension(config),
          ...(options.extraNodes || []),
          ...prepared,
          configExtension(YCollabExtension, {
            doc,
            schemaVersion,
            selfCheck: true,
            synced: mode === 'extension',
          }),
        ],
        name: 'catalog-client',
        onError,
        onWarn,
      }),
    );
    cleanups.push(() => built.dispose());
    editor = built;
    mount(editor);
    binding = getExtensionDependencyFromEditor(editor, YCollabExtension).output
      .binding;
    if (mode === 'extension-then-sync') {
      Y.applyUpdate(doc, state, 'provider');
      binding.initialize();
    }
  }
  return {
    binding,
    dispose: () => {
      for (const cleanup of cleanups.splice(0).reverse()) {
        cleanup();
      }
    },
    doc,
    editor,
    errors,
    get root() {
      return root;
    },
    warningCodes,
    warnings,
  };
}

/**
 * The fields every node's class declares derived (a list item's `value` and
 * `indent`), in document order, a host's slots before its children.
 */
export function $derivedFields(): unknown[] {
  const out: unknown[] = [];
  const walk = (node: LexicalNode) => {
    const {derived} = getDeclaredNodeStructure(
      node.constructor as typeof LexicalNode,
    );
    if (derived.size > 0) {
      const json = node.exportJSON() as unknown as Record<string, unknown>;
      const fields: Record<string, unknown> = {type: node.getType()};
      for (const name of [...derived].sort()) {
        fields[name] = json[name];
      }
      out.push(fields);
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

/** List numbering: every list's start and every item's value, in order. */
export function $numbering(): {starts: number[]; values: number[]} {
  const starts: number[] = [];
  const values: number[] = [];
  const walk = (node: LexicalNode) => {
    if ($isListNode(node)) {
      starts.push(node.getStart());
    }
    if ($isListItemNode(node)) {
      values.push(node.getValue());
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
  return {starts, values};
}

export interface Snapshot {
  readonly json: SerializedEditorState;
  readonly derived: unknown[];
  readonly numbering: {starts: number[]; values: number[]};
}

export function $snapshot(): Snapshot {
  return {
    derived: $derivedFields(),
    json: $getEditor().getEditorState().toJSON(),
    numbering: $numbering(),
  };
}

/** What an editor shows now. */
export function snapshot(editor: LexicalEditor): Snapshot {
  return editor.getEditorState().read($snapshot, {editor});
}

/** What a fresh headless reader of `state` shows. */
export function freshSnapshot(
  state: Uint8Array,
  config: Pick<CatalogConfig, 'blockIds'> &
    Partial<Pick<CatalogConfig, 'marks'>> = DEFAULT_CONFIG,
  schemaVersion = 1,
): Snapshot {
  return readYState(
    state,
    catalogHeadlessConfig(config, {schemaVersion}),
    $snapshot,
  );
}

/** The `<li value>` of every rendered list item, in order. */
export function renderedValues(root: HTMLElement | null): number[] | null {
  return root === null
    ? null
    : Array.from(root.querySelectorAll('li')).map(li => li.value);
}

/** What an editor without collab derives for `shapes`. */
export function unboundSnapshot(
  shapes: readonly NodeShape[],
  config: Pick<CatalogConfig, 'blockIds'> &
    Partial<Pick<CatalogConfig, 'marks'>> = DEFAULT_CONFIG,
): Snapshot {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(config)],
      name: 'catalog-plain',
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
    return snapshot(editor);
  } finally {
    editor.dispose();
  }
}

/**
 * The first place where `a` and `b` differ, as `path: a != b` (values cut
 * short), or null when they are equal.
 */
export function firstDifference(
  a: unknown,
  b: unknown,
  path = '',
): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    return null;
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const key of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      const found = firstDifference(ao[key], bo[key], `${path}/${key}`);
      if (found !== null) {
        return found;
      }
    }
  }
  const cut = (v: unknown) => {
    const text = JSON.stringify(v);
    return text === undefined ? 'undefined' : text.slice(0, 160);
  };
  return `${path || '/'}: ${cut(a)} != ${cut(b)}`;
}
