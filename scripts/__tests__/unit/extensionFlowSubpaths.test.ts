/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {parse} from 'hermes-parser';
import * as fs from 'node:fs';
import {Project} from 'ts-morph';
import {describe, expect, it} from 'vitest';

import {packagesManager} from '../../shared/packagesManager';
import npmToWwwName from '../../www/npmToWwwName';

const pkg = packagesManager.getPackageByNpmName('@lexical/extension');
const project = new Project({tsConfigFilePath: './tsconfig.json'});

function flowExports(filename: string) {
  const names = new Set<string>();
  const ast = parse(fs.readFileSync(filename, 'utf8'), {flow: 'all'});
  for (const node of ast.body) {
    if (
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'DeclareExportDeclaration'
    ) {
      const decl = node.declaration;
      if (decl && 'id' in decl && decl.id) names.add(decl.id.name);
      for (const spec of node.specifiers || []) names.add(spec.exported.name);
    }
  }
  return {ast, names};
}

describe('extension Flow subpaths', () => {
  for (const {name, sourceFileName} of pkg.getExportedNpmModuleEntries()) {
    // The first test starts the TypeScript checker: about 2.5 s alone, over
    // vitest's default 5 s limit when the whole suite runs.
    it(`declares all exports of ${name}`, {timeout: 30_000}, () => {
      const source = project.addSourceFileAtPath(
        pkg.resolve('src', sourceFileName),
      );
      const expected = source
        .getExportSymbols()
        .map(symbol => symbol.getName())
        .sort();
      const {ast, names} = flowExports(
        pkg.resolve('flow', `${npmToWwwName(name)}.js.flow`),
      );
      for (const node of ast.body) {
        if (!node.source || !node.specifiers) continue;
        const dependency = node.source.value;
        if (
          dependency !== 'lexical' &&
          !dependency.startsWith('@lexical/extension/')
        )
          continue;
        const owner =
          dependency === 'lexical'
            ? packagesManager.getPackageByNpmName('lexical')
            : pkg;
        const importedNames = flowExports(
          owner.resolve('flow', `${npmToWwwName(dependency)}.js.flow`),
        ).names;
        for (const spec of node.specifiers) {
          expect(importedNames, `${name} imports from ${dependency}`).toContain(
            (spec.imported || spec.local).name,
          );
        }
      }
      expect([...names].sort()).toEqual(expected);
      if (name === '@lexical/extension') {
        expect(
          ast.body.every(
            node => node.type === 'ExportNamedDeclaration' && node.source,
          ),
        ).toBe(true);
      }
    });
  }
});
