/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

import fs from 'fs-extra';
import path from 'node:path';

import npmToWwwName from '../www/npmToWwwName.mjs';

/**
 * @typedef {Object} ModuleBuildDefinition
 * @property {string} outputFileName
 * @property {string} sourceFileName
 * @property {undefined | string} [browserSourceFileName]
 */

/**
 * @typedef {Object} PackageBuildDefinition
 * @property {Array<ModuleBuildDefinition>} modules
 * @property {string} name
 * @property {string} outputPath
 * @property {string} packageName
 * @property {string} sourcePath
 */

/**
 * @typedef {Object} ModuleExportEntry
 * @property {string} name
 * @property {string} sourceFileName
 * @property {undefined | string} [browserSourceFileName]
 */

/**
 * The conditions of one entry in a published package's exports map. Only ESM
 * is published, so there is no `import`/`require` split: every condition
 * resolves to a `.js` ES module (every public package is a `"type": "module"`
 * package) or, for `types`, a `.d.ts`.
 *
 * @typedef {Record<'types' | 'development' | 'production' | 'default', string> & Record<`types@${string}`, string>} ExportConditions
 * @typedef {ExportConditions & { source?: string; browser?: ExportConditions }} NpmModuleExports
 * @typedef {readonly [string, NpmModuleExports]} NpmModuleExportEntry
 */

/**
 *
 * @param {string} wwwName
 * @returns {string} An easier to read name ('Lexical' -> 'Lexical Core', 'LexicalRichText' -> 'Lexical Rich Text')
 */
function readableName(wwwName) {
  return wwwName === 'Lexical'
    ? 'Lexical Core'
    : wwwName.replace(/([A-Z])/g, ' $1').trim();
}

/**
 * Metadata abstraction for a package.json file
 */
export class PackageMetadata {
  /** @type {string} the path to the package.json file */
  packageJsonPath;
  /** @type {Record<string, any>} the parsed package.json */
  packageJson;

  /**
   * @param {string} packageJsonPath the path to the package.json file
   */
  constructor(packageJsonPath) {
    this.packageJsonPath = packageJsonPath;
    this.packageJson = fs.readJsonSync(packageJsonPath);
  }

  /**
   * @param {...string} paths to resolve in this package's directory
   * @returns {string} Resolve a path in this package's directory
   */
  resolve(...paths) {
    return path.resolve(path.dirname(this.packageJsonPath), ...paths);
  }

  /**
   * @returns {string} the directory name of the package, e.g. 'lexical-rich-text'
   */
  getDirectoryName() {
    return path.basename(path.dirname(this.packageJsonPath));
  }

  /**
   * @returns {string} the npm name of the package, e.g. '@lexical/rich-text'
   */
  getNpmName() {
    return this.packageJson.name;
  }

  /**
   * @returns {boolean} whether the package is marked private (not published to npm)
   */
  isPrivate() {
    return !!this.packageJson.private;
  }

  /**
   * Get an array of (fully qualified) exported module names and their
   * corresponding export map. Ignores the backwards compatibility '.js'
   * exports and replaces /^.[/]?/ with the npm name of the package.
   *
   * E.g. [['lexical', {...}]] or [['@lexical/react/LexicalComposer', {...}]
   *
   * @returns {Array<NpmModuleExportEntry>}
   */
  getNormalizedNpmModuleExportEntries() {
    // It doesn't make much sense to do this for private modules
    if (this.isPrivate()) {
      throw new Error('This should only be called on public packages');
    }
    // All our packages should have exports if update-version has been run
    if (!this.packageJson.exports) {
      throw new Error(
        'This package should have exports, try `pnpm run update-version` first',
      );
    }
    /** @type {Array<NpmModuleExportEntry>} */
    const entries = [];
    for (const [key, value] of Object.entries(this.packageJson.exports)) {
      if (key.endsWith('.js')) {
        continue;
      }
      entries.push([`${this.getNpmName()}${key.replace(/^./, '')}`, value]);
    }
    return entries.sort((a, b) => a[0].localeCompare(b[0]));
  }

  /**
   * @returns {Array<string>} the npm module names that this package exports
   */
  getExportedNpmModuleNames() {
    return this.getNormalizedNpmModuleExportEntries().map(([name]) => name);
  }

  /**
   * The entries of npm module names to their .tsx? source files
   *
   * @returns {Array<ModuleExportEntry>}
   */
  getExportedNpmModuleEntries() {
    const npmName = this.getNpmName();
    return this.getExportedNpmModuleNames().map(name => {
      const outputFileName = npmToWwwName(name);
      const sourceBaseNames =
        name === npmName
          ? ['index']
          : [name.replace(/^.*\//, ''), outputFileName];
      const sourceCandidates = sourceBaseNames.flatMap(sourceBaseName =>
        ['.ts', '.tsx'].map(ext => sourceBaseName + ext),
      );
      const sourceFileName = sourceCandidates.find(fn =>
        fs.existsSync(this.resolve('src', fn)),
      );
      if (!sourceFileName) {
        throw new Error(
          `Could not find source file for ${name} at packages/${this.getDirectoryName()}/src/${
            sourceCandidates[0]
          }?`,
        );
      }
      const browserSourceFileName = [
        sourceFileName.replace(/(\.tsx?)$/, '.browser$1'),
      ].find(fn => fs.existsSync(this.resolve('src', fn)));
      return {browserSourceFileName, name, sourceFileName};
    });
  }

  /**
   * The map of import module names to their .tsx? source files
   * (for private modules such as shared)
   *
   * @returns {Array<ModuleExportEntry>}
   */
  getPrivateModuleEntries() {
    const npmName = this.getNpmName();
    const entries = [];
    for (const sourceFileName of fs.readdirSync(this.resolve('src'))) {
      const m = /^([^.]+)\.tsx?$/.exec(sourceFileName);
      if (m) {
        entries.push({
          name: m[1] === 'index' ? npmName : `${npmName}/${m[1]}`,
          sourceFileName,
        });
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * @returns {PackageBuildDefinition}
   */
  getPackageBuildDefinition(opts = {consolidateBrowserSource: false}) {
    const npmName = this.getNpmName();
    return {
      modules: this.getExportedNpmModuleEntries().flatMap(
        ({name, sourceFileName, browserSourceFileName}) => [
          {
            browserSourceFileName,
            outputFileName: npmToWwwName(name),
            sourceFileName,
          },
          ...(browserSourceFileName && !opts.consolidateBrowserSource
            ? [
                {
                  outputFileName: `${npmToWwwName(name)}.browser`,
                  sourceFileName: browserSourceFileName,
                },
              ]
            : []),
        ],
      ),
      name: readableName(npmToWwwName(npmName)),
      outputPath: this.resolve('dist/'),
      packageName: this.getDirectoryName(),
      sourcePath: this.resolve('src/'),
    };
  }

  /**
   * Replace the dependency map at `packageJson[key]` in-place with
   * deps sorted lexically by key. If deps was empty, it will be removed.
   * If `overrideDeps` is specified, it will replace the existing dependencies
   * at that key with that record.
   *
   * @param {'dependencies'|'peerDependencies'|'devDependencies'|'lexicalUnreleasedDependencies'} key
   * @param {Record<string, string>} [overrideDeps]
   * @returns {this}
   */
  sortDependencies(key, overrideDeps) {
    const deps = overrideDeps ?? this.packageJson[key];
    if (deps) {
      const entries = Object.entries(deps);
      if (entries.length === 0) {
        delete this.packageJson[key];
      } else {
        this.packageJson[key] = Object.fromEntries(
          entries.sort(([a], [b]) => a.localeCompare(b)),
        );
      }
    }
    return this;
  }

  /**
   * Writes this.packageJson back to this.packageJsonPath
   */
  writeSync() {
    fs.writeJsonSync(this.packageJsonPath, this.packageJson, {spaces: 2});
  }
}
