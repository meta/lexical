/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

export const PIXEL_VALUE_REG_EXP = /^(\d+(?:\.\d+)?)px$/;

// .PlaygroundEditorTheme__tableCell width value from
// packages/lexical-playground/src/themes/PlaygroundEditorTheme.css
export const COLUMN_WIDTH = 75;

// How far (in CSS pixels) a pointer may travel from where it went down and
// still count as a tap rather than a drag. Touch contacts jitter by a few
// pixels while the finger is lifted, so a tap that lands near a cell border
// is otherwise reported as a move into the neighbouring cell (#8538).
export const TAP_SLOP = 10;
