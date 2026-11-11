/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalBuilder} from '../LexicalBuilder';

import invariant from '@lexical/internal/invariant';
import {
  type AnyLexicalExtension,
  type ExtensionBuildState,
  type ExtensionInitState,
  type ExtensionRegisterState,
  type InitialEditorConfig,
  type LexicalEditor,
  type LexicalExtensionConfig,
  type LexicalExtensionDependency,
  type LexicalExtensionInit,
  type LexicalExtensionOutput,
  shallowMergeConfig,
} from 'lexical';

export const ExtensionRepStateIds = {
  /* eslint-disable sort-keys-fix/sort-keys-fix */
  unmarked: 0,
  temporary: 1,
  permanent: 2,
  configured: 3,
  initialized: 4,
  built: 5,
  registered: 6,
  afterRegistration: 7,
  /* eslint-enable sort-keys-fix/sort-keys-fix */
} as const;
interface UnmarkedState {
  id: (typeof ExtensionRepStateIds)['unmarked'];
}
interface TemporaryState {
  id: (typeof ExtensionRepStateIds)['temporary'];
}
interface PermanentState {
  id: (typeof ExtensionRepStateIds)['permanent'];
}
interface ConfiguredState<Extension extends AnyLexicalExtension> {
  id: (typeof ExtensionRepStateIds)['configured'];
  config: LexicalExtensionConfig<Extension>;
  registerState: ExtensionInitState;
}
interface InitializedState<Extension extends AnyLexicalExtension> extends Omit<
  ConfiguredState<Extension>,
  'id' | 'registerState'
> {
  id: (typeof ExtensionRepStateIds)['initialized'];
  initResult: LexicalExtensionInit<Extension>;
  registerState: ExtensionBuildState<LexicalExtensionInit<Extension>>;
}
interface BuiltState<Extension extends AnyLexicalExtension> extends Omit<
  ConfiguredState<Extension>,
  'id' | 'registerState'
> {
  id: (typeof ExtensionRepStateIds)['built'];
  initResult: LexicalExtensionInit<Extension>;
  output: LexicalExtensionOutput<Extension>;
  registerState: ExtensionRegisterState<
    LexicalExtensionInit<Extension>,
    LexicalExtensionOutput<Extension>
  >;
}
interface RegisteredState<Extension extends AnyLexicalExtension> extends Omit<
  BuiltState<Extension>,
  'id'
> {
  id: (typeof ExtensionRepStateIds)['registered'];
}
interface AfterRegistrationState<
  Extension extends AnyLexicalExtension,
> extends Omit<RegisteredState<Extension>, 'id'> {
  id: (typeof ExtensionRepStateIds)['afterRegistration'];
}

export type ExtensionRepState<Extension extends AnyLexicalExtension> =
  | UnmarkedState
  | TemporaryState
  | PermanentState
  | ConfiguredState<Extension>
  | InitializedState<Extension>
  | BuiltState<Extension>
  | RegisteredState<Extension>
  | AfterRegistrationState<Extension>;

export function isExactlyUnmarkedExtensionRepState<
  Extension extends AnyLexicalExtension,
>(state: ExtensionRepState<Extension>): state is UnmarkedState {
  return state.id === ExtensionRepStateIds.unmarked;
}
function isExactlyTemporaryExtensionRepState<
  Extension extends AnyLexicalExtension,
>(state: ExtensionRepState<Extension>): state is TemporaryState {
  return state.id === ExtensionRepStateIds.temporary;
}
export function isExactlyPermanentExtensionRepState<
  Extension extends AnyLexicalExtension,
>(state: ExtensionRepState<Extension>): state is PermanentState {
  return state.id === ExtensionRepStateIds.permanent;
}
function isConfiguredExtensionRepState<Extension extends AnyLexicalExtension>(
  state: ExtensionRepState<Extension>,
): state is
  | ConfiguredState<Extension>
  | InitializedState<Extension>
  | BuiltState<Extension>
  | RegisteredState<Extension>
  | AfterRegistrationState<Extension> {
  return state.id >= ExtensionRepStateIds.configured;
}
function isInitializedExtensionRepState<Extension extends AnyLexicalExtension>(
  state: ExtensionRepState<Extension>,
): state is
  | InitializedState<Extension>
  | BuiltState<Extension>
  | RegisteredState<Extension>
  | AfterRegistrationState<Extension> {
  return state.id >= ExtensionRepStateIds.initialized;
}

function isBuiltExtensionRepState<Extension extends AnyLexicalExtension>(
  state: ExtensionRepState<Extension>,
): state is
  | BuiltState<Extension>
  | RegisteredState<Extension>
  | AfterRegistrationState<Extension> {
  return state.id >= ExtensionRepStateIds.built;
}
function isAfterRegistrationState<Extension extends AnyLexicalExtension>(
  state: ExtensionRepState<Extension>,
): state is AfterRegistrationState<Extension> {
  return state.id >= ExtensionRepStateIds.afterRegistration;
}
export function applyTemporaryMark<Extension extends AnyLexicalExtension>(
  state: ExtensionRepState<Extension>,
): TemporaryState {
  invariant(
    isExactlyUnmarkedExtensionRepState(state),
    'LexicalBuilder: Can not apply a temporary mark from state id %s (expected %s unmarked)',
    String(state.id),
    String(ExtensionRepStateIds.unmarked),
  );
  return Object.assign(state, {id: ExtensionRepStateIds.temporary});
}
export function applyPermanentMark<Extension extends AnyLexicalExtension>(
  state: ExtensionRepState<Extension>,
): PermanentState {
  invariant(
    isExactlyTemporaryExtensionRepState(state),
    'LexicalBuilder: Can not apply a permanent mark from state id %s (expected %s temporary)',
    String(state.id),
    String(ExtensionRepStateIds.temporary),
  );
  return Object.assign(state, {id: ExtensionRepStateIds.permanent});
}
export function applyConfiguredState<Extension extends AnyLexicalExtension>(
  state: PermanentState,
  config: LexicalExtensionConfig<Extension>,
  registerState: ExtensionInitState,
): ConfiguredState<Extension> {
  return Object.assign(state, {
    config,
    id: ExtensionRepStateIds.configured,
    registerState,
  });
}
export function applyInitializedState<Extension extends AnyLexicalExtension>(
  state: ConfiguredState<Extension>,
  initResult: LexicalExtensionInit<Extension>,
  registerState: ExtensionBuildState<LexicalExtensionInit<Extension>>,
): InitializedState<Extension> {
  return Object.assign(state, {
    id: ExtensionRepStateIds.initialized,
    initResult,
    registerState,
  });
}
export function applyBuiltState<Extension extends AnyLexicalExtension>(
  state: InitializedState<Extension>,
  output: LexicalExtensionOutput<Extension>,
  registerState: ExtensionRegisterState<
    LexicalExtensionInit<Extension>,
    LexicalExtensionOutput<Extension>
  >,
): BuiltState<Extension> {
  return Object.assign(state, {
    id: ExtensionRepStateIds.built,
    output,
    registerState,
  });
}
export function applyRegisteredState<Extension extends AnyLexicalExtension>(
  state: BuiltState<Extension>,
) {
  return Object.assign(state, {
    id: ExtensionRepStateIds.registered,
  });
}
export function applyAfterRegistrationState<
  Extension extends AnyLexicalExtension,
>(state: RegisteredState<Extension>): AfterRegistrationState<Extension> {
  return Object.assign(state, {id: ExtensionRepStateIds.afterRegistration});
}

export function rollbackToBuiltState<Extension extends AnyLexicalExtension>(
  state: AfterRegistrationState<Extension>,
): BuiltState<Extension> {
  return Object.assign(state, {id: ExtensionRepStateIds.built});
}

const emptySet: ReadonlySet<string> = new Set();

/**
 * @internal
 */
export class ExtensionRep<Extension extends AnyLexicalExtension> {
  builder: LexicalBuilder;
  configs: Set<Partial<LexicalExtensionConfig<Extension>>>;
  _dependency?: LexicalExtensionDependency<Extension>;
  _peerNameSet?: Set<string>;
  extension: Extension;
  state: ExtensionRepState<Extension>;
  _signal?: AbortSignal;

  constructor(builder: LexicalBuilder, extension: Extension) {
    this.builder = builder;
    this.extension = extension;
    this.configs = new Set();
    this.state = {id: ExtensionRepStateIds.unmarked};
  }

  mergeConfigs(): LexicalExtensionConfig<Extension> {
    let config: LexicalExtensionConfig<Extension> = this.extension.config || {};
    const mergeConfig = this.extension.mergeConfig
      ? this.extension.mergeConfig.bind(this.extension)
      : shallowMergeConfig;
    for (const cfg of this.configs) {
      config = mergeConfig(config, cfg);
    }

    return config;
  }

  init(editorConfig: InitialEditorConfig) {
    const initialState = this.state;
    invariant(
      isExactlyPermanentExtensionRepState(initialState),
      'ExtensionRep: Can not configure from state id %s',
      String(initialState.id),
    );
    const initState: ExtensionInitState = {
      getDependency: this.getInitDependency.bind(this),
      getDirectDependentNames: this.getDirectDependentNames.bind(this),
      getPeer: this.getInitPeer.bind(this),
      getPeerNameSet: this.getPeerNameSet.bind(this),
    };
    const buildState: ExtensionBuildState<LexicalExtensionInit<Extension>> = {
      ...initState,
      getDependency: this.getDependency.bind(this),
      getInitResult: this.getInitResult.bind(this),
      getPeer: this.getPeer.bind(this),
    };
    const state = applyConfiguredState(
      initialState,
      this.mergeConfigs(),
      initState,
    );
    this.state = state;
    let initResult: LexicalExtensionInit<Extension> | undefined;
    if (this.extension.init) {
      initResult = this.extension.init(
        editorConfig,
        state.config,
        initState,
      ) as LexicalExtensionInit<Extension>;
    }

    this.state = applyInitializedState(state, initResult!, buildState);
  }

  build(editor: LexicalEditor) {
    const state = this.state;
    invariant(
      state.id === ExtensionRepStateIds.initialized,
      'ExtensionRep: register called in state id %s (expected %s initialized)',
      String(state.id),
      String(ExtensionRepStateIds.built),
    );
    let output: undefined | LexicalExtensionOutput<Extension>;
    if (this.extension.build) {
      output = this.extension.build(editor, state.config, state.registerState);
    }
    const registerState: ExtensionRegisterState<
      LexicalExtensionInit<Extension>,
      LexicalExtensionOutput<Extension>
    > = {
      ...state.registerState,
      getOutput: () => output!,
      getSignal: this.getSignal.bind(this),
    };
    this.state = applyBuiltState(state, output!, registerState);
  }

  register(
    editor: LexicalEditor,
    signal: AbortSignal,
  ): undefined | (() => void) {
    this._signal = signal;
    const state = this.state;
    invariant(
      state.id === ExtensionRepStateIds.built,
      'ExtensionRep: register called in state id %s (expected %s built)',
      String(state.id),
      String(ExtensionRepStateIds.built),
    );
    const cleanup =
      this.extension.register &&
      this.extension.register(editor, state.config, state.registerState);
    this.state = applyRegisteredState(state);
    return () => {
      const afterRegistrationState = this.state;
      invariant(
        afterRegistrationState.id === ExtensionRepStateIds.afterRegistration,
        'ExtensionRep: rollbackToBuiltState called in state id %s (expected %s afterRegistration)',
        String(state.id),
        String(ExtensionRepStateIds.afterRegistration),
      );
      this.state = rollbackToBuiltState(afterRegistrationState);
      if (cleanup) {
        cleanup();
      }
    };
  }

  afterRegistration(editor: LexicalEditor): undefined | (() => void) {
    const state = this.state;
    invariant(
      state.id === ExtensionRepStateIds.registered,
      'ExtensionRep: afterRegistration called in state id %s (expected %s registered)',
      String(state.id),
      String(ExtensionRepStateIds.registered),
    );
    let rval: undefined | (() => void);
    if (this.extension.afterRegistration) {
      rval = this.extension.afterRegistration(
        editor,
        state.config,
        state.registerState,
      );
    }
    this.state = applyAfterRegistrationState(state);
    return rval;
  }

  getSignal(): AbortSignal {
    invariant(
      this._signal !== undefined,
      'ExtensionRep.getSignal() called before register',
    );
    return this._signal;
  }

  getInitResult(): LexicalExtensionInit<Extension> {
    invariant(
      this.extension.init !== undefined,
      'ExtensionRep: getInitResult() called for Extension %s that does not define init',
      this.extension.name,
    );
    const state = this.state;
    invariant(
      isInitializedExtensionRepState(state),
      'ExtensionRep: getInitResult() called for ExtensionRep in state id %s < %s (initialized)',
      String(state.id),
      String(ExtensionRepStateIds.initialized),
    );

    return state.initResult;
  }

  getInitPeer<PeerExtension extends AnyLexicalExtension = never>(
    name: PeerExtension['name'],
  ):
    | undefined
    | Omit<LexicalExtensionDependency<PeerExtension>, 'output' | 'init'> {
    const rep = this.builder.extensionNameMap.get(name);
    return rep ? rep.getExtensionInitDependency() : undefined;
  }

  getExtensionInitDependency(): Omit<
    LexicalExtensionDependency<Extension>,
    'output' | 'init'
  > {
    const state = this.state;
    invariant(
      isConfiguredExtensionRepState(state),
      'ExtensionRep: getExtensionInitDependency called in state id %s (expected >= %s configured)',
      String(state.id),
      String(ExtensionRepStateIds.configured),
    );
    return {config: state.config};
  }

  getPeer<PeerExtension extends AnyLexicalExtension = never>(
    name: PeerExtension['name'],
  ): undefined | LexicalExtensionDependency<PeerExtension> {
    const rep = this.builder.extensionNameMap.get(name);
    return rep
      ? (rep.getExtensionDependency() as LexicalExtensionDependency<PeerExtension>)
      : undefined;
  }

  getInitDependency<Dependency extends AnyLexicalExtension>(
    dep: Dependency,
  ): Omit<LexicalExtensionDependency<Dependency>, 'output' | 'init'> {
    const rep = this.builder.getExtensionRep(dep);
    invariant(
      rep !== undefined,
      'LexicalExtensionBuilder: Extension %s missing dependency extension %s to be in registry',
      this.extension.name,
      dep.name,
    );
    return rep.getExtensionInitDependency();
  }

  getDependency<Dependency extends AnyLexicalExtension>(
    dep: Dependency,
  ): LexicalExtensionDependency<Dependency> {
    const rep = this.builder.getExtensionRep(dep);
    invariant(
      rep !== undefined,
      'LexicalExtensionBuilder: Extension %s missing dependency extension %s to be in registry',
      this.extension.name,
      dep.name,
    );
    return rep.getExtensionDependency();
  }

  getState(): AfterRegistrationState<Extension> {
    const state = this.state;
    invariant(
      isAfterRegistrationState(state),
      'ExtensionRep getState called in state id %s (expected %s afterRegistration)',
      String(state.id),
      String(ExtensionRepStateIds.afterRegistration),
    );
    return state;
  }

  getDirectDependentNames(): ReadonlySet<string> {
    return this.builder.incomingEdges.get(this.extension.name) || emptySet;
  }

  getPeerNameSet(): ReadonlySet<string> {
    let s = this._peerNameSet;
    if (!s) {
      s = new Set(
        (this.extension.peerDependencies || []).map(([name]) => name),
      );
      this._peerNameSet = s;
    }
    return s;
  }

  getExtensionDependency(): LexicalExtensionDependency<Extension> {
    if (!this._dependency) {
      const state = this.state;
      invariant(
        isBuiltExtensionRepState(state),
        'Extension %s used as a dependency before build',
        this.extension.name,
      );
      this._dependency = {
        config: state.config,
        init: state.initResult,
        output: state.output,
      };
    }
    return this._dependency;
  }
}
