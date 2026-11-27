/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Values stored under a covered name (layout 3), by how a reader takes them:
//
// - RESERVED_END_SHAPES: arrays of a shape layout 3 does not write (not
//   `[d]`, `[client, clock]` or `[]`). An array is an end; one of these names
//   nothing, so it reads as a clearer, and no write of the binding rewrites,
//   re-points or deletes it. They stand for a later layout's ends and a raw
//   writer's arrays.
// - ARRAY_SHAPED_VALUES: objects that look like arrays (keyed by array
//   indices, typed arrays). Every value that is not an array is a value, these
//   included: a wrapper whose class declares a field named `0` stores one
//   (NumericFieldWrapperNode below), and a raw writer can store any of them.
//
// Each entry is a make function: a typed array is not JSON, and a test may
// store one value per document.

import {
  $create,
  ElementNode,
  type LexicalNode,
  nodeSchema,
  numberValue,
  withField,
} from 'lexical';

export const RESERVED_END_SHAPES: readonly [
  label: string,
  make: () => unknown,
][] = [
  // Another length.
  ['three integers', () => [1, 2, 3]],
  ['four integers', () => [1, 2, 3, 4]],
  // An element that is not such an integer.
  ['a fraction', () => [1.5]],
  ['a zero distance', () => [0]],
  ['a negative distance', () => [-1]],
  ['an unsafe integer', () => [2 ** 53]],
  ['a negative client', () => [-1, 2]],
  ['a fractional clock', () => [1, 2.5]],
  ['a string', () => ['a']],
  ['a digit string', () => ['3']],
  ['a boolean', () => [true]],
  ['a null element', () => [null]],
  ['an integer and a string', () => [1, 'x']],
  ['an object element', () => [{}]],
  // Nested arrays.
  ['a nested end', () => [[1]]],
  ['a nested pair', () => [[1, 2]]],
  ['a nested empty array', () => [[]]],
  ['a nested end and an integer', () => [[3], 4]],
];

export const ARRAY_SHAPED_VALUES: readonly [
  label: string,
  make: () => unknown,
][] = [
  ['an index-keyed object', () => ({0: 3})],
  ['an index-keyed pair', () => ({0: 1, 1: 2})],
  ['an index-keyed object with a length', () => ({0: 3, length: 1})],
  ['an index-keyed object holding an array', () => ({0: [1]})],
  ['an index-keyed object and a field', () => ({0: 3, label: 'v'})],
  ['a typed array', () => new Uint8Array([3])],
  ['a typed array of words', () => new Int32Array([1, 2])],
  // A binary update keeps a Uint8Array's bytes, not its other properties.
  [
    'a typed array with a field',
    () => Object.assign(new Uint8Array([3]), {label: 'v'}),
  ],
  [
    'a typed array with a json field',
    () => Object.assign(new Uint8Array([3]), {json: '"v"'}),
  ],
];

/**
 * Whether `v` is one of layout 3's own shapes for an end or a null-run
 * opener: `[d]` (a positive safe integer), `[client, clock]` (non-negative
 * safe integers) or `[]`.
 */
export function isWireShape(v: unknown): boolean {
  if (!Array.isArray(v)) {
    return false;
  }
  const count = (x: unknown, min: number) =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= min;
  return (
    v.length === 0 ||
    (v.length === 1 && count(v[0], 1)) ||
    (v.length === 2 && count(v[0], 0) && count(v[1], 0))
  );
}

/** Whether `v` has a reserved shape: an array that is not a wire shape. */
export function isReservedShape(v: unknown): boolean {
  return Array.isArray(v) && !isWireShape(v);
}

const numericFieldWrapperSchema = nodeSchema<NumericFieldWrapperNode>()({
  '0': withField(numberValue(), {field: '__zero'}),
});

/**
 * An inline wrapper (stored as a format, `w:numeric_field_wrapper`) whose
 * class declares a JSON field named `0`: its stored value is an object keyed
 * by an array index, `{"0": 3}`, a value like any other.
 */
export class NumericFieldWrapperNode extends ElementNode {
  __zero: number = 3;
  $config() {
    return this.config('numeric_field_wrapper', {
      children: 'inline',
      extends: ElementNode,
      inline: true,
      json: numericFieldWrapperSchema,
      mergeAdjacent: {by: ['0']},
    });
  }
  isInline(): true {
    return true;
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): false {
    return false;
  }
}

export const $createNumericFieldWrapper = (
  ...children: LexicalNode[]
): NumericFieldWrapperNode =>
  $create(NumericFieldWrapperNode).append(...children);
