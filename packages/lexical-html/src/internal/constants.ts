/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
export const DOMRenderExtensionName = '@lexical/html/DOM';
export const DOMRenderContextSymbol = Symbol.for(
  '@lexical/html/DOMExportContext',
);

export const DOMImportExtensionName = '@lexical/html/DOMImport';
export const DOMImportContextSymbol = Symbol.for(
  '@lexical/html/DOMImportContext',
);

export const ALWAYS_TRUE = () => true as const;
