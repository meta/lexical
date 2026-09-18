/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The compiler's passes, all of them. A build that wants one of them can
// import it on its own — `@lexical/compiler/PureAnnotations` — and skip
// loading the rest.
export * from './PureAnnotations';
