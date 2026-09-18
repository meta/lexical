/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {Orientation, PageSetup, PageSize} from './types';

import {
  $getRoot,
  $getState,
  $setState,
  createState,
  type NodeStateVersion,
  type StateValueOrUpdater,
} from 'lexical';

import {DEFAULT_PAGE_SETUP, PAGE_SIZES} from './constants';

export function marginsIsEqual(
  a: PageSetup['margins'],
  b: PageSetup['margins'],
) {
  return (
    a.bottom === b.bottom &&
    a.left === b.left &&
    a.right === b.right &&
    a.top === b.top
  );
}

function parsePageSize(v: unknown): PageSize {
  if (typeof v === 'string' && v in PAGE_SIZES) {
    return v as PageSize;
  }
  return DEFAULT_PAGE_SETUP.pageSize;
}
function parseOrientation(v: unknown): Orientation {
  return v === 'landscape' || v === 'portrait'
    ? v
    : DEFAULT_PAGE_SETUP.orientation;
}
function parseMargins(v: unknown): PageSetup['margins'] {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const defaults = structuredClone(DEFAULT_PAGE_SETUP.margins);
    const o = v as Record<string, unknown>;
    for (const k of ['top', 'right', 'bottom', 'left'] as const) {
      if (typeof o[k] === 'number') {
        defaults[k] = o[k];
      }
    }
    return defaults;
  }
  return DEFAULT_PAGE_SETUP.margins;
}

export const pageSetupState = createState('pageSetup', {
  isEqual: (a: null | PageSetup, b: null | PageSetup) =>
    a === b ||
    (a != null &&
      b != null &&
      a.orientation === b.orientation &&
      a.pageSize === b.pageSize &&
      (a.margins === b.margins || marginsIsEqual(a.margins, b.margins))),
  parse: v => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj: {[k in string]?: unknown} = v;
      return {
        margins: parseMargins(obj.margins),
        orientation: parseOrientation(obj.orientation),
        pageSize: parsePageSize(obj.pageSize),
      };
    }
    return null;
  },
});

export function $getPageSetup(version?: NodeStateVersion): null | PageSetup {
  return $getState($getRoot(), pageSetupState, version);
}

export function $setPageSetup(
  pageSetup: StateValueOrUpdater<typeof pageSetupState>,
): void {
  $setState($getRoot(), pageSetupState, pageSetup);
}
