/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The configuration catalog: every dimension of how an app sets up an editor
// and a document that changes what the binding, block ids and handles do.
// Each dimension lists every value; a matrix test runs a contract over the
// product of the dimensions that apply to it (see `configProduct`), and
// every value of every dimension at least once.

export const CONFIG_DIMENSIONS = {
  /** BlockIdExtension in the editor: enabled, `disabled: true`, or absent. */
  blockIds: ['enabled', 'disabled', 'absent'],
  /** How the editor is bound: none (no collab), a YBinding, YCollabExtension. */
  bound: ['unbound', 'binding', 'extension'],

  /** An IME composition open in the editor while changes arrive. */
  composing: ['no', 'yes'],

  /** The Y.Doc: `createYDoc()` (cleanup off), or a plain `new Y.Doc()`. */
  doc: ['createYDoc', 'plain'],

  /** Where the editor runs: headless (`readYState` etc.), jsdom with a root. */
  dom: ['headless', 'jsdom'],

  /** How the editor is built: createEditor with nodes, or from extensions. */
  editor: ['nodes', 'extensions'],

  /** BlockIdHTMLExtension's export option (`'handle'` where handles exist). */
  htmlExport: ['absent', 'false', 'true', 'handle'],

  /** Comments: none, MarkNode, MarkStateExtension, a defineMarkExtension flavor. */
  marks: ['none', 'mark-node', 'mark-state', 'mark-flavor'],

  /** `onError` of the editor: rethrow, or log and go on. */
  onError: ['rethrow', 'log'],

  /** What turns the binding read only (or nothing). */
  readOnly: [
    'none',
    'schema',
    'layout',
    'unknown-type',
    'cleanup-formatting',
    'frozen',
  ],

  /** The reader's `schemaVersion` against the writer's. */
  schemaVersion: ['equal', 'older', 'newer'],

  /** How updates are made: one discrete update each, or batched. */
  updates: ['discrete', 'batched'],
} as const;

export type ConfigDimension = keyof typeof CONFIG_DIMENSIONS;
export type CatalogConfig = {
  -readonly [K in ConfigDimension]: (typeof CONFIG_DIMENSIONS)[K][number];
};

/** What every dimension is unless a cell says otherwise. */
export const DEFAULT_CONFIG: CatalogConfig = {
  blockIds: 'absent',
  bound: 'binding',
  composing: 'no',
  doc: 'createYDoc',
  dom: 'headless',
  editor: 'extensions',
  htmlExport: 'absent',
  marks: 'none',
  onError: 'rethrow',
  readOnly: 'none',
  schemaVersion: 'equal',
  updates: 'discrete',
};

/**
 * The configurations over `dimensions` (the others at their default): the
 * full product, or with `limit`, a fixed sample of it that still holds every
 * value of every dimension at least once (each value first, then the rest of
 * the product in a fixed order).
 */
export function configProduct(
  dimensions: readonly ConfigDimension[],
  options: {
    limit?: number;
    base?: Partial<CatalogConfig>;
    /** Leaves out the configurations this returns false for. */
    filter?: (config: CatalogConfig) => boolean;
  } = {},
): CatalogConfig[] {
  const base: CatalogConfig = {...DEFAULT_CONFIG, ...options.base};
  let all: CatalogConfig[] = [base];
  for (const dim of dimensions) {
    const next: CatalogConfig[] = [];
    for (const config of all) {
      for (const value of CONFIG_DIMENSIONS[dim]) {
        next.push({...config, [dim]: value});
      }
    }
    all = next;
  }
  const filter = options.filter;
  if (filter !== undefined) {
    all = all.filter(filter);
  }
  const limit = options.limit;
  if (limit === undefined || all.length <= limit) {
    return all;
  }
  const picked = new Set<CatalogConfig>();
  for (const dim of dimensions) {
    for (const value of CONFIG_DIMENSIONS[dim]) {
      const first = all.find(c => c[dim] === value);
      if (first !== undefined) {
        picked.add(first);
      }
    }
  }
  const stride = Math.max(1, Math.floor(all.length / limit));
  for (let i = 0; i < all.length && picked.size < limit; i += stride) {
    picked.add(all[i]);
  }
  return [...picked];
}

/** A short label of `config`: only the dimensions off their default. */
export function configLabel(config: CatalogConfig): string {
  const parts = (Object.keys(config) as ConfigDimension[])
    .filter(dim => config[dim] !== DEFAULT_CONFIG[dim])
    .map(dim => `${dim}=${config[dim]}`);
  return parts.length === 0 ? 'default' : parts.join(',');
}
