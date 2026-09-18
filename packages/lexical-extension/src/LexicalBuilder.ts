/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {LEXICAL_VERSION} from '@lexical/internal/version';
import {
  type AnyLexicalExtension,
  type AnyLexicalExtensionArgument,
  type AnyNormalizedLexicalExtensionArgument,
  createEditor,
  type CreateEditorArgs,
  type EditorThemeClasses,
  type HTMLConfig,
  type InitialEditorConfig,
  type KlassConstructor,
  type LexicalEditor,
  type LexicalEditorWithDispose,
  type LexicalExtensionConfig,
  type LexicalNode,
  mergeRegister,
} from 'lexical';

import {getNodeConfig} from './config';
import {deepThemeMergeInPlace} from './deepThemeMergeInPlace';
import {
  applyPermanentMark,
  applyTemporaryMark,
  ExtensionRep,
  isExactlyPermanentExtensionRepState,
  isExactlyUnmarkedExtensionRepState,
} from './ExtensionRep';
import {InitialStateExtension} from './InitialStateExtension';

/** @internal Use a well-known symbol for dev tools purposes */
export const builderSymbol = Symbol.for('@lexical/extension/LexicalBuilder');

type BuildCreateEditorArgs = Omit<CreateEditorArgs, 'onError' | 'onWarn'> &
  Pick<InitialEditorConfig, 'onError' | 'onWarn' | '$initialEditorState'>;

/**
 * Build a LexicalEditor by combining together one or more extensions, optionally
 * overriding some of their configuration.
 *
 * @param extensions - Extension arguments (extensions or extensions with config overrides)
 * @returns An editor handle
 *
 * @example
 * A single root extension with multiple dependencies
 *
 * ```ts
 * const editor = buildEditorFromExtensions(
 *   defineExtension({
 *     name: "[root]",
 *     dependencies: [
 *       RichTextExtension,
 *       configExtension(EmojiExtension, { emojiBaseUrl: "/assets/emoji" }),
 *     ],
 *     register: (editor: LexicalEditor) => {
 *       console.log("Editor Created");
 *       return () => console.log("Editor Disposed");
 *     },
 *   }),
 * );
 * ```
 *
 * @example
 * A very similar minimal configuration without the register hook
 *
 * ```ts
 * const editor = buildEditorFromExtensions(
 *   RichTextExtension,
 *   configExtension(EmojiExtension, { emojiBaseUrl: "/assets/emoji" }),
 * );
 * ```
 */
export function buildEditorFromExtensions(
  ...extensions: AnyLexicalExtensionArgument[]
): LexicalEditorWithDispose {
  return LexicalBuilder.fromExtensions(extensions).buildEditor();
}

/** @internal */
function noop() {
  /*empty*/
}

/** Throw the given Error */
function defaultOnError(err: Error) {
  throw err;
}

interface WithBuilder {
  [builderSymbol]?: LexicalBuilder | undefined;
}

/** @internal */
function maybeWithBuilder(editor: LexicalEditor): LexicalEditor & WithBuilder {
  return editor;
}

function normalizeExtensionArgument(
  arg: AnyLexicalExtensionArgument,
): AnyNormalizedLexicalExtensionArgument {
  return Array.isArray(arg) ? arg : [arg];
}

const PACKAGE_VERSION = LEXICAL_VERSION;

/** @internal */
export class LexicalBuilder {
  roots: readonly AnyNormalizedLexicalExtensionArgument[];
  extensionNameMap: Map<string, ExtensionRep<AnyLexicalExtension>>;
  outgoingConfigEdges: Map<
    string,
    Map<string, LexicalExtensionConfig<AnyLexicalExtension>[]>
  >;
  incomingEdges: Map<string, Set<string>>;
  conflicts: Map<string, string>;
  _sortedExtensionReps?: readonly ExtensionRep<AnyLexicalExtension>[];
  PACKAGE_VERSION: string;

  constructor(roots: AnyNormalizedLexicalExtensionArgument[]) {
    this.outgoingConfigEdges = new Map();
    this.incomingEdges = new Map();
    this.extensionNameMap = new Map();
    this.conflicts = new Map();
    this.PACKAGE_VERSION = PACKAGE_VERSION;
    this.roots = roots;
    for (const extension of roots) {
      this.addExtension(extension);
    }
  }

  static fromExtensions(
    extensions: AnyLexicalExtensionArgument[],
  ): LexicalBuilder {
    const roots = [normalizeExtensionArgument(InitialStateExtension)];
    for (const extension of extensions) {
      roots.push(normalizeExtensionArgument(extension));
    }
    return new LexicalBuilder(roots);
  }

  static maybeFromEditor(editor: LexicalEditor): undefined | LexicalBuilder {
    const builder = maybeWithBuilder(editor)[builderSymbol];
    if (builder) {
      // The dev tools variant of this will relax some of these invariants
      invariant(
        builder.PACKAGE_VERSION === PACKAGE_VERSION,
        'LexicalBuilder.fromEditor: The given editor was created with LexicalBuilder %s but this version is %s. A project should have exactly one copy of LexicalBuilder',
        builder.PACKAGE_VERSION,
        PACKAGE_VERSION,
      );
      invariant(
        builder instanceof LexicalBuilder,
        'LexicalBuilder.fromEditor: There are multiple copies of the same version of LexicalBuilder in your project, and this editor was created with another one. Your project, or one of its dependencies, has its package.json and/or bundler configured incorrectly.',
      );
    }
    return builder;
  }

  /** Look up the editor that was created by this LexicalBuilder or throw */
  static fromEditor(editor: LexicalEditor): LexicalBuilder {
    const builder = LexicalBuilder.maybeFromEditor(editor);
    invariant(
      builder !== undefined,
      'LexicalBuilder.fromEditor: The given editor was not created with LexicalBuilder',
    );
    return builder;
  }

  constructEditor(): LexicalEditor & WithBuilder {
    const {
      $initialEditorState: _$initialEditorState,
      onError,
      onWarn,
      ...editorConfig
    } = this.buildCreateEditorArgs();
    const editor = Object.assign(
      createEditor({
        ...editorConfig,
        ...(onError
          ? {
              onError: err => {
                onError(err, editor);
              },
            }
          : {}),
        ...(onWarn
          ? {
              onWarn: err => {
                onWarn(err, editor);
              },
            }
          : {}),
      }),
      {[builderSymbol]: this},
    );
    for (const extensionRep of this.sortedExtensionReps()) {
      extensionRep.build(editor);
    }
    return editor;
  }

  buildEditor(): LexicalEditorWithDispose {
    let disposeOnce = noop;
    function dispose() {
      try {
        disposeOnce();
      } finally {
        disposeOnce = noop;
      }
    }
    const editor: LexicalEditorWithDispose & WithBuilder = Object.assign(
      this.constructEditor(),
      {dispose, [Symbol.dispose]: dispose},
    );
    disposeOnce = mergeRegister(this.registerEditor(editor), () =>
      editor.setRootElement(null),
    );
    return editor;
  }

  hasExtensionByName(name: string): boolean {
    return this.extensionNameMap.has(name);
  }

  getExtensionRep<Extension extends AnyLexicalExtension>(
    extension: Extension,
  ): ExtensionRep<Extension> | undefined {
    const rep = this.extensionNameMap.get(extension.name);
    if (rep) {
      invariant(
        rep.extension === extension,
        'LexicalBuilder: A registered extension with name %s exists but does not match the given extension',
        extension.name,
      );
      return rep as ExtensionRep<Extension>;
    }
  }

  /**
   * @param configs - Ownership passes to the builder, which retains the array
   *   and may append to it. Callers must pass an array nobody else holds.
   */
  addEdge(
    fromExtensionName: string,
    toExtensionName: string,
    configs: LexicalExtensionConfig<AnyLexicalExtension>[],
  ) {
    const outgoing = this.outgoingConfigEdges.get(fromExtensionName);
    if (outgoing) {
      // An extension may reach the same dependency more than once (e.g. two
      // configExtension entries for it, or both a direct and a peer
      // dependency). Every config has to be kept in the order it was seen,
      // otherwise all but the last would be silently discarded instead of
      // merged.
      const existing = outgoing.get(toExtensionName);
      if (existing) {
        existing.push(...configs);
      } else {
        outgoing.set(toExtensionName, configs);
      }
    } else {
      this.outgoingConfigEdges.set(
        fromExtensionName,
        new Map([[toExtensionName, configs]]),
      );
    }
    const incoming = this.incomingEdges.get(toExtensionName);
    if (incoming) {
      incoming.add(fromExtensionName);
    } else {
      this.incomingEdges.set(toExtensionName, new Set([fromExtensionName]));
    }
  }

  addExtension(arg: AnyLexicalExtensionArgument) {
    invariant(
      this._sortedExtensionReps === undefined,
      'LexicalBuilder: addExtension called after finalization',
    );
    const normalized = normalizeExtensionArgument(arg);
    const [extension] = normalized;
    invariant(
      typeof extension.name === 'string',
      'LexicalBuilder: extension name must be string, not %s',
      typeof extension.name,
    );
    let extensionRep = this.extensionNameMap.get(extension.name);
    invariant(
      extensionRep === undefined || extensionRep.extension === extension,
      'LexicalBuilder: Multiple extensions registered with name %s, names must be unique',
      extension.name,
    );
    if (!extensionRep) {
      extensionRep = new ExtensionRep(this, extension);
      this.extensionNameMap.set(extension.name, extensionRep);
      const hasConflict = this.conflicts.get(extension.name);
      if (typeof hasConflict === 'string') {
        invariant(
          false,
          'LexicalBuilder: extension %s conflicts with %s',
          extension.name,
          hasConflict,
        );
      }
      for (const name of extension.conflictsWith || []) {
        invariant(
          !this.extensionNameMap.has(name),
          'LexicalBuilder: extension %s conflicts with %s',
          extension.name,
          name,
        );
        this.conflicts.set(name, extension.name);
      }
      for (const dep of extension.dependencies || []) {
        const normDep = normalizeExtensionArgument(dep);
        this.addEdge(extension.name, normDep[0].name, normDep.slice(1));
        this.addExtension(normDep);
      }
      for (const [depName, config] of extension.peerDependencies || []) {
        this.addEdge(extension.name, depName, config ? [config] : []);
      }
    }
  }

  sortedExtensionReps(): readonly ExtensionRep<AnyLexicalExtension>[] {
    if (this._sortedExtensionReps) {
      return this._sortedExtensionReps;
    }
    // depth-first search based topological DAG sort
    // https://en.wikipedia.org/wiki/Topological_sorting
    const sortedExtensionReps: ExtensionRep<AnyLexicalExtension>[] = [];
    const visit = (
      rep: ExtensionRep<AnyLexicalExtension>,
      fromExtensionName?: string,
    ) => {
      let mark = rep.state;
      if (isExactlyPermanentExtensionRepState(mark)) {
        return;
      }
      const extensionName = rep.extension.name;
      invariant(
        isExactlyUnmarkedExtensionRepState(mark),
        'LexicalBuilder: Circular dependency detected for Extension %s from %s',
        extensionName,
        fromExtensionName || '[unknown]',
      );
      mark = applyTemporaryMark(mark);
      rep.state = mark;
      const outgoingConfigEdges = this.outgoingConfigEdges.get(extensionName);
      if (outgoingConfigEdges) {
        for (const toExtensionName of outgoingConfigEdges.keys()) {
          const toRep = this.extensionNameMap.get(toExtensionName);
          // may be undefined for an optional peer dependency
          if (toRep) {
            visit(toRep, extensionName);
          }
        }
      }
      mark = applyPermanentMark(mark);
      rep.state = mark;
      sortedExtensionReps.push(rep);
    };
    for (const rep of this.extensionNameMap.values()) {
      if (isExactlyUnmarkedExtensionRepState(rep.state)) {
        visit(rep);
      }
    }
    for (const rep of sortedExtensionReps) {
      for (const [toExtensionName, configs] of this.outgoingConfigEdges.get(
        rep.extension.name,
      ) || []) {
        if (configs.length > 0) {
          const toRep = this.extensionNameMap.get(toExtensionName);
          if (toRep) {
            for (const config of configs) {
              toRep.configs.add(config);
            }
          }
        }
      }
    }
    for (const [extension, ...configs] of this.roots) {
      if (configs.length > 0) {
        const toRep = this.extensionNameMap.get(extension.name);
        invariant(
          toRep !== undefined,
          'LexicalBuilder: Expecting existing ExtensionRep for %s',
          extension.name,
        );
        for (const config of configs) {
          toRep.configs.add(config);
        }
      }
    }
    this._sortedExtensionReps = sortedExtensionReps;
    return this._sortedExtensionReps;
  }

  registerEditor(editor: LexicalEditor): () => void {
    const extensionReps = this.sortedExtensionReps();
    const controller = new AbortController();
    const cleanups: (() => void)[] = [() => controller.abort()];
    const signal = controller.signal;
    for (const extensionRep of extensionReps) {
      const cleanup = extensionRep.register(editor, signal);
      if (cleanup) {
        cleanups.push(cleanup);
      }
    }
    for (const extensionRep of extensionReps) {
      const cleanup = extensionRep.afterRegistration(editor);
      if (cleanup) {
        cleanups.push(cleanup);
      }
    }
    return mergeRegister(...cleanups);
  }

  buildCreateEditorArgs(): BuildCreateEditorArgs {
    const config: BuildCreateEditorArgs = {};
    const nodes = new Set<NonNullable<CreateEditorArgs['nodes']>[number]>();
    const replacedNodes = new Map<
      KlassConstructor<typeof LexicalNode>,
      ExtensionRep<AnyLexicalExtension>
    >();
    const htmlExport: NonNullable<HTMLConfig['export']> = new Map();
    const htmlImport: NonNullable<HTMLConfig['import']> = {};
    const theme: EditorThemeClasses = {};
    const extensionReps = this.sortedExtensionReps();
    for (const extensionRep of extensionReps) {
      const {extension} = extensionRep;
      if (extension.onError !== undefined) {
        config.onError = extension.onError;
      }
      if (extension.onWarn !== undefined) {
        config.onWarn = extension.onWarn;
      }
      if (extension.disableEvents !== undefined) {
        config.disableEvents = extension.disableEvents;
      }
      if (extension.parentEditor !== undefined) {
        config.parentEditor = extension.parentEditor;
      }
      if (extension.editable !== undefined) {
        config.editable = extension.editable;
      }
      if (extension.namespace !== undefined) {
        config.namespace = extension.namespace;
      }
      if (extension.$initialEditorState !== undefined) {
        config.$initialEditorState = extension.$initialEditorState;
      }
      if (extension.nodes) {
        for (const node of getNodeConfig(extension)) {
          if (typeof node !== 'function') {
            const conflictExtension = replacedNodes.get(node.replace);
            if (conflictExtension) {
              invariant(
                false,
                'LexicalBuilder: Extension %s can not register replacement for node %s because %s already did',
                extension.name,
                node.replace.name,
                conflictExtension.extension.name,
              );
            }
            replacedNodes.set(node.replace, extensionRep);
          }
          nodes.add(node);
        }
      }
      if (extension.html) {
        if (extension.html.export) {
          for (const [k, v] of extension.html.export.entries()) {
            htmlExport.set(k, v);
          }
        }
        if (extension.html.import) {
          Object.assign(htmlImport, extension.html.import);
        }
      }
      if (extension.theme) {
        deepThemeMergeInPlace(theme, extension.theme);
      }
    }
    if (Object.keys(theme).length > 0) {
      config.theme = theme;
    }
    if (nodes.size) {
      config.nodes = [...nodes];
    }
    const hasImport = Object.keys(htmlImport).length > 0;
    const hasExport = htmlExport.size > 0;
    if (hasImport || hasExport) {
      config.html = {};
      if (hasImport) {
        config.html.import = htmlImport;
      }
      if (hasExport) {
        config.html.export = htmlExport;
      }
    }
    for (const extensionRep of extensionReps) {
      extensionRep.init(config);
    }
    if (!config.onError) {
      config.onError = defaultOnError;
    }
    return config;
  }
}
