/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

'use strict';

// Import with !!example-source?region=name!path/to/example.ts. The input file
// is a bundler dependency, so editing it also refreshes the documentation.
module.exports = function exampleSource(source) {
  const {region} = this.getOptions();
  const lines = source.split(/\r?\n/);
  const marker = /^\s*(?:\/\/|\/\*|<!--)\s*\[(\/?)docs:([a-z0-9-]+)\]/;
  const starts = [];
  const ends = [];
  for (const [index, line] of lines.entries()) {
    const match = marker.exec(line);
    if (match && match[2] === region) {
      (match[1] ? ends : starts).push(index);
    }
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    throw new Error(
      `Expected one complete [docs:${region}] region in ${this.resourcePath}`,
    );
  }
  const selected = lines
    .slice(starts[0] + 1, ends[0])
    .filter(line => !marker.test(line));
  const nonempty = selected.filter(line => line.trim());
  if (nonempty.length === 0) {
    throw new Error(`Empty [docs:${region}] region in ${this.resourcePath}`);
  }
  const indent = Math.min(
    ...nonempty.map(line => line.match(/^\s*/)[0].length),
  );
  const text = selected
    .map(line => line.slice(indent))
    .join('\n')
    .trim();
  return `export default ${JSON.stringify(text)};`;
};
