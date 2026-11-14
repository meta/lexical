/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The byte-identity harness of @lexical/y (see
// src/__tests__/trace/byteTrace.setup.ts): the repository's Vitest
// configuration, with the tracer loaded after the unit project's own setup
// files. Not part of any default run: it is used only where this file is
// named with --config, and the tracer does nothing unless
// LEXICAL_Y_BYTE_TRACE names a directory to write to.
import base from '../../vitest.config.mts';

const config = base as unknown as {
  test: {projects: {test: {name: string; setupFiles: string[]}}[]};
};
for (const project of config.test.projects) {
  if (project.test.name === 'unit') {
    project.test.setupFiles = [
      ...project.test.setupFiles,
      './packages/lexical-y/src/__tests__/trace/byteTrace.setup.ts',
    ];
  }
}

export default base;
