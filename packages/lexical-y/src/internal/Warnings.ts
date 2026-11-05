/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The warnings the binding passes to the editor's `onWarn`, as
// `LexicalWarning`s typed by their code (see YWarning).

import {LexicalWarning} from 'lexical';

/**
 * @experimental The document's layout is one this version cannot read or
 * write: read only. `data`: YUnsupportedLayoutData.
 */
export const UNSUPPORTED_LAYOUT_WARNING = '@lexical/y/unsupported-layout';
/**
 * @experimental The document has node types the editor cannot build, or
 * stored content its classes throw on: read only. `data`:
 * YUnknownNodeTypesData, or YUnreadableContentData.
 */
export const UNKNOWN_NODE_TYPES_WARNING = '@lexical/y/unknown-node-types';
/**
 * @experimental The document stores a node type in a way its class cannot be
 * stored: read only. `data`: YStorageMismatchData.
 */
export const STORAGE_MISMATCH_WARNING = '@lexical/y/storage-mismatch';
/**
 * @experimental The self-check (`selfCheck`, off by default) found the editor
 * and the document disagree. `data`: YSelfCheckData.
 */
export const SELF_CHECK_WARNING = '@lexical/y/self-check';
/**
 * @experimental A change could not be read: the editor was rebuilt from the
 * document. `data`: YRecoveredReadData.
 */
export const RECOVERED_READ_WARNING = '@lexical/y/recovered-read';
/**
 * @experimental A local change could not be written: the document was
 * rewritten from the editor. `data`: YRecoveredWriteData.
 */
export const RECOVERED_WRITE_WARNING = '@lexical/y/recovered-write';
/**
 * @experimental A class whose declarations make it a line, a format or a
 * group is stored as a nested node. Once per class and reason. `data`:
 * YNestedFallbackData.
 */
export const NESTED_FALLBACK_WARNING = '@lexical/y/nested-fallback';
/**
 * @experimental A node property or NodeState value is not plain JSON, so it
 * is not synchronized. Once per property. `data`: YUnsyncedValueData.
 */
export const UNSYNCED_VALUE_WARNING = '@lexical/y/unsynced-value';
/**
 * @experimental A node holds named slots where the document cannot store
 * them: not written, read only. `data`: YUnsupportedSlotsData.
 */
export const UNSUPPORTED_SLOTS_WARNING = '@lexical/y/unsupported-slots';
/**
 * @experimental The editor or the document is configured in a way the
 * binding cannot write with: nothing is written, read only. `data`:
 * YUnsupportedConfigData.
 */
export const UNSUPPORTED_CONFIG_WARNING = '@lexical/y/unsupported-config';
/**
 * @experimental A local update changed the editor while the binding is read
 * only: nothing is written, and what it changed is read again (once the
 * document cannot be read, the editor shows what it showed before the update
 * again), so the editor keeps showing the document. Reported once each time
 * the binding goes read only. `data`: YUnsupportedEditData.
 */
export const UNSUPPORTED_EDIT_WARNING = '@lexical/y/unsupported-edit';
/**
 * @experimental A client of a newer version of the app (a higher
 * `schemaVersion`) wrote to the document: read only. `data`:
 * YUnsupportedSchemaData.
 */
export const UNSUPPORTED_SCHEMA_WARNING = '@lexical/y/unsupported-schema';
/**
 * @experimental Development builds only: a local transaction that is not
 * the binding's (nor a Y.UndoManager's, nor a migration's) changed the Yjs
 * content under the binding's root. The encoding under the root is private
 * to the binding and unsupported for direct writes: change the document
 * through the editor (or editYState). Once per binding and origin; nothing
 * else happens (the binding reads the change as it reads a remote one).
 * A diagnostic, not a complete detector: it judges a transaction by its
 * origin and locality, and only once the binding has read its document
 * (not while it is pending), so a raw write made through a provider-like
 * remote update, or before the binding reads, is not reported. A
 * transaction the binding also wrote in (an editor edit, `initialize()` or
 * `binding.undo()` inside an app's `doc.transact`, which joins it) is not
 * checked either, so an app's raw write in that same transaction goes
 * unreported: it may miss a raw write, never report the binding's own.
 * `data`:
 * YRawYjsWriteData.
 */
export const RAW_YJS_WRITE_WARNING = '@lexical/y/raw-yjs-write';

/**
 * Internal (not exported from the package): the codes of the
 * `LexicalWarning`s this version of the binding passes to the editor's
 * `onWarn`. It grows when a code is added, so it is not public: a public
 * closed union would break an exhaustive switch over it. Each code is
 * public (its constant); a code is never renamed, and never reused for
 * another condition.
 */
export type YKnownWarningCode =
  | typeof UNSUPPORTED_LAYOUT_WARNING
  | typeof UNKNOWN_NODE_TYPES_WARNING
  | typeof STORAGE_MISMATCH_WARNING
  | typeof SELF_CHECK_WARNING
  | typeof RECOVERED_READ_WARNING
  | typeof RECOVERED_WRITE_WARNING
  | typeof NESTED_FALLBACK_WARNING
  | typeof UNSYNCED_VALUE_WARNING
  | typeof UNSUPPORTED_SLOTS_WARNING
  | typeof UNSUPPORTED_CONFIG_WARNING
  | typeof UNSUPPORTED_EDIT_WARNING
  | typeof UNSUPPORTED_SCHEMA_WARNING
  | typeof RAW_YJS_WRITE_WARNING;

/**
 * @experimental A warning code: one this version reports (an editor
 * completes them) or one a later version adds. Open on purpose: handle the
 * codes you know, with `isYWarning(value, code)`, and keep a fallback for
 * the others.
 */
export type YWarningCode = YKnownWarningCode | (string & {});

/**
 * @experimental The `data` every code may carry besides its own variants: a
 * condition a later version reports under an existing code, `detailCode`
 * naming it (with optional `details`). Permanent: a switch over a code's
 * `reason` handles `'other'`, so a new condition never breaks it.
 */
export interface YOtherWarningData {
  readonly reason: 'other';
  readonly detailCode: string;
  readonly details?: unknown;
}

/**
 * @experimental `data` of an `UNSUPPORTED_LAYOUT_WARNING` (the binding is read
 * only). `supported`: the newest layout this version reads (it reads 1 to
 * `supported`).
 */
export type YUnsupportedLayoutData =
  /** The layout record names a newer layout, `found`. */
  | {
      readonly reason: 'newer';
      readonly found: number;
      readonly supported: number;
    }
  /** The record at `key` is not a layout record; `found` is its value. */
  | {
      readonly reason: 'malformed';
      readonly key: string;
      readonly found: unknown;
      readonly supported: number;
    }
  /**
   * The root has content but no layout record (`'missing'`), or the record
   * was removed while the binding was writing (`'removed'`).
   */
  | {readonly reason: 'missing' | 'removed'; readonly supported: number}
  /**
   * The root records layout `found`, older than `min`, the oldest this
   * version reads (MIN_LAYOUT): migrate the document (see
   * @lexical/y/migrate). A document below the floor is an expected state
   * for an app whose server migrates: handle this reason in `onWarn` (its
   * development default throws).
   */
  | {
      readonly reason: 'older';
      readonly found: number;
      readonly min: number;
      readonly supported: number;
      /**
       * What the app declared (`layoutUpgrade`): `'server'` (its server
       * upgrades such documents, so this one should have been migrated) or
       * `'read-only'` (none, or not declared). A later release may add
       * kinds.
       */
      readonly upgrade: 'server' | 'read-only' | (string & {});
    }
  /**
   * The root requires features this version does not support, `features`
   * (`lexical-y-require:<feature>`): shown, kept, never rewritten.
   */
  | {
      readonly reason: 'requires';
      readonly features: readonly string[];
      readonly supported: number;
    }
  /** Older layouts' roots, `roots`, hold content. */
  | {
      readonly reason: 'legacy-roots';
      readonly roots: readonly string[];
      readonly supported: number;
    };

/**
 * @experimental `data` of an `UNSUPPORTED_SCHEMA_WARNING` (the binding is read
 * only). `supported`: the binding's `schemaVersion`.
 */
export type YUnsupportedSchemaData =
  /**
   * A client whose `schemaVersion` is `found`, higher than `supported`, wrote
   * to the document: the app is out of date (render your own banner, such as
   * one that asks to reload).
   */
  | {
      readonly reason: 'newer';
      readonly found: number;
      readonly supported: number;
    }
  /** The record at `key` is not a schema record; `found` is its value. */
  | {
      readonly reason: 'malformed';
      readonly key: string;
      readonly found: unknown;
      readonly supported: number;
    };

/** @experimental How the document stores a node type, or how a class would. */
export interface YStoredAs {
  readonly kind: 'line' | 'format' | 'group' | 'nested';
  /** A group's or format's identity: the fields it merges by. */
  readonly by?: readonly string[];
}

/**
 * @experimental `data` of a `STORAGE_MISMATCH_WARNING` (the binding is read
 * only), one per node type.
 */
export type YStorageMismatchData =
  /** The record at `key` for `type` is not a storage record. */
  | {
      readonly reason: 'malformed';
      readonly type: string;
      readonly key: string;
      readonly found: unknown;
    }
  /** The class of `type` cannot be stored as the document stores it. */
  | {
      readonly reason: 'declaration-changed';
      readonly type: string;
      readonly stored: YStoredAs;
      readonly declared: YStoredAs;
    };

/**
 * @experimental `data` of an `UNKNOWN_NODE_TYPES_WARNING` (the binding is read
 * only): types the editor does not register (`'unregistered'`), or slots the
 * document holds that are not a block node (`'malformed-slot'`: the slot's
 * key, or the type of the inline node in it).
 */
export interface YUnknownNodeTypesData {
  readonly reason: 'unregistered' | 'malformed-slot';
  readonly types: readonly string[];
}

/**
 * @experimental `data` of an `UNKNOWN_NODE_TYPES_WARNING` whose `reason` is
 * `'unreadable'` (the binding is read only): stored content the editor's
 * classes throw on when they read it (its importJSON or updateFromJSON, a
 * NodeState parse), of `types`, with the first `error` thrown. The editor
 * shows the rest of the document. `types` is empty, and the editor keeps
 * what it showed before and reads nothing more, where a read failed without
 * a class to name (it threw again on a fresh read of the document).
 */
export interface YUnreadableContentData {
  readonly reason: 'unreadable';
  readonly types: readonly string[];
  readonly error: unknown;
}

/**
 * @experimental `data` of an `UNSUPPORTED_SLOTS_WARNING` (the change is not
 * written and the binding is read only): `types` hold named slots on a node
 * stored as a line, a format or a group (`'stored-host'`), or on the root
 * (`'root'`).
 */
export interface YUnsupportedSlotsData {
  readonly reason: 'stored-host' | 'root';
  readonly types: readonly string[];
}

/**
 * @experimental `data` of an `UNSUPPORTED_CONFIG_WARNING` (nothing is written
 * and the binding is read only), one warning per reason.
 */
export type YUnsupportedConfigData =
  /**
   * `options` (`'<extension>.<option>'`) are set to a value the binding
   * cannot write with.
   */
  | {readonly reason: 'repair-transforms'; readonly options: readonly string[]}
  /**
   * The document runs Yjs's format cleanup (`doc.cleanupFormatting` is not
   * false): it was not made by `createYDoc`.
   */
  | {readonly reason: 'cleanup-formatting'}
  /**
   * No `layoutUpgrade` was declared (a config written without
   * createYCollabConfig, or plain JavaScript), and the document is below
   * MIN_LAYOUT: read only, as with `layoutUpgrade: null`. Sent with the
   * `'older'` layout warning.
   */
  | {readonly reason: 'missing-layout-upgrade'};

/**
 * @experimental `data` of an `UNSUPPORTED_EDIT_WARNING`: a local update
 * (code that edits the editor, which is not editable) changed content while
 * the binding is read only (`'read-only'`), or, while it is active, when the
 * document's layout record did not admit writes as the change was written
 * (inside an app's transaction that changed the record); not retried.
 */
export interface YUnsupportedEditData {
  readonly reason: 'read-only';
}

/**
 * @experimental `data` of a `SELF_CHECK_WARNING`: the self-check found the
 * editor and the document disagree after a local change (`'local'`) or a
 * remote one (`'remote'`, read again in full).
 */
export interface YSelfCheckData {
  readonly reason: 'local' | 'remote';
  readonly problems: readonly string[];
}

/**
 * @experimental `data` of a `RECOVERED_READ_WARNING`: a remote change
 * (`'remote-change'`) or a read of the binding's own (`'reread'`) threw
 * `error`, and the editor was rebuilt from the document.
 */
export interface YRecoveredReadData {
  readonly reason: 'remote-change' | 'reread';
  readonly error: unknown;
}

/**
 * @experimental `data` of a `RECOVERED_WRITE_WARNING`: writing a local change
 * threw `error`, and the document was rewritten from the editor.
 */
export interface YRecoveredWriteData {
  readonly reason: 'local-change';
  readonly error: unknown;
}

/**
 * @experimental Why a class `type` whose declarations make it a line, a
 * format or a group is stored as a nested node.
 */
export type YNestedFallbackReason =
  /** It overrides `method`, so its merge rule is not its declaration. */
  | 'merge-override'
  /** It holds inline content and declares slots. */
  | 'inline-slots'
  /** It holds inline content and its serialization is not schema-complete. */
  | 'inline-incomplete-schema'
  /** Its type contains ":", which a format's key cannot hold. */
  | 'type-name'
  /** It merges adjacent siblings and is not schema-complete. */
  | 'merge-incomplete-schema'
  /** It merges adjacent siblings and declares slots. */
  | 'merge-slots'
  /** Not all its children are stored as lines. */
  | 'group-children'
  /** It merges by NodeState (a group merges by schema fields only). */
  | 'group-state-merge'
  /** It is a group and is not schema-complete, or declares slots. */
  | 'group-incomplete-schema'
  /** Its instances have `properties` outside its `$config()` schema. */
  | 'undeclared-properties';

/** @experimental `data` of a `NESTED_FALLBACK_WARNING`. */
export type YNestedFallbackData =
  | {
      readonly reason: 'merge-override';
      readonly type: string;
      readonly method: string;
    }
  | {
      readonly reason: 'undeclared-properties';
      readonly type: string;
      readonly properties: readonly string[];
    }
  | {
      readonly reason: Exclude<
        YNestedFallbackReason,
        'merge-override' | 'undeclared-properties'
      >;
      readonly type: string;
    };

/**
 * @experimental `data` of a `RAW_YJS_WRITE_WARNING` (development builds).
 */
export interface YRawYjsWriteData {
  readonly reason: 'raw-write';
  /** The binding's root, by its name in the document (`'lexical-y'`). */
  readonly root: string;
  /**
   * What the transaction changed first under the root: a text format
   * (`'format'`, `key` its name), a node attribute (`'attribute'`, `key`
   * its name) or other content (`'content'`, `key` null).
   */
  readonly kind: 'format' | 'attribute' | 'content';
  readonly key: string | null;
  /** The transaction origin's constructor name (`'null'` for none). */
  readonly origin: string;
}

/**
 * @experimental `data` of an `UNSYNCED_VALUE_WARNING`: `property`
 * (`'<type>.<field>'` or `'NodeState <key>'`) holds a value that is not plain
 * JSON, so it is not synchronized.
 */
export interface YUnsyncedValueData {
  readonly reason: 'not-json';
  readonly property: string;
}

/** The `data` of each code. */
interface YWarningDataByCode {
  [UNSUPPORTED_LAYOUT_WARNING]: YUnsupportedLayoutData;
  [UNKNOWN_NODE_TYPES_WARNING]: YUnknownNodeTypesData | YUnreadableContentData;
  [STORAGE_MISMATCH_WARNING]: YStorageMismatchData;
  [SELF_CHECK_WARNING]: YSelfCheckData;
  [RECOVERED_READ_WARNING]: YRecoveredReadData;
  [RECOVERED_WRITE_WARNING]: YRecoveredWriteData;
  [NESTED_FALLBACK_WARNING]: YNestedFallbackData;
  [UNSYNCED_VALUE_WARNING]: YUnsyncedValueData;
  [RAW_YJS_WRITE_WARNING]: YRawYjsWriteData;
  [UNSUPPORTED_SLOTS_WARNING]: YUnsupportedSlotsData;
  [UNSUPPORTED_CONFIG_WARNING]: YUnsupportedConfigData;
  [UNSUPPORTED_EDIT_WARNING]: YUnsupportedEditData;
  [UNSUPPORTED_SCHEMA_WARNING]: YUnsupportedSchemaData;
}

/**
 * @experimental The `data` of the warnings with code `C`: its variants (and
 * YOtherWarningData) for a code this version knows, `unknown` for another.
 */
export type YWarningData<C extends string = string> =
  C extends YKnownWarningCode
    ? YWarningDataByCode[C] | YOtherWarningData
    : unknown;

/** The `data` this version emits under code `C` (never `'other'`). */
export type YEmittedWarningData<C extends YKnownWarningCode> =
  YWarningDataByCode[C];

/**
 * @experimental A warning the binding passes to the editor's `onWarn`: a
 * `LexicalWarning` whose `code` decides the type of its `data`.
 * `YWarning` (any code) is open: its `data` is `unknown` until narrowed.
 * Narrow it with `isYWarning(value, code)`, which gives `YWarning<code>`,
 * then switch over `data.reason`, `'other'` included.
 */
export type YWarning<C extends string = YWarningCode> = LexicalWarning & {
  readonly code: C;
  readonly data: YWarningData<C>;
};

/**
 * Internal (not exported, for the same reason as YKnownWarningCode): the
 * warnings this version reports, one member per code.
 */
export type YKnownWarning = {
  [C in YKnownWarningCode]: YWarning<C>;
}[YKnownWarningCode];

const CODES: ReadonlySet<string> = new Set<YKnownWarningCode>([
  UNSUPPORTED_LAYOUT_WARNING,
  UNKNOWN_NODE_TYPES_WARNING,
  STORAGE_MISMATCH_WARNING,
  SELF_CHECK_WARNING,
  RECOVERED_READ_WARNING,
  RECOVERED_WRITE_WARNING,
  NESTED_FALLBACK_WARNING,
  UNSYNCED_VALUE_WARNING,
  UNSUPPORTED_SLOTS_WARNING,
  UNSUPPORTED_CONFIG_WARNING,
  UNSUPPORTED_EDIT_WARNING,
  UNSUPPORTED_SCHEMA_WARNING,
  RAW_YJS_WRITE_WARNING,
]);

/**
 * @experimental Whether `value` (what the editor's `onWarn` receives) is a
 * warning of the binding's: with `code`, one with that code, its `data`
 * typed by it; without, any of its codes (an open YWarning).
 */
export function isYWarning<C extends YKnownWarningCode>(
  value: unknown,
  code: C,
): value is YWarning<C>;
export function isYWarning(value: unknown): value is YWarning;
export function isYWarning(value: unknown, code?: unknown): boolean {
  if (!(value instanceof LexicalWarning) || !CODES.has(value.code)) {
    return false;
  }
  // A code that is not a string (an array method's index) is no code.
  return typeof code !== 'string' || value.code === code;
}

/** A warning found outside a binding's own state (class derivation, values). */
type WarningNote = {
  [C in YKnownWarningCode]: {
    readonly code: C;
    readonly message: string;
    readonly data: YEmittedWarningData<C>;
  };
}[YKnownWarningCode];

const noted = new Set<string>();
const notes: WarningNote[] = [];

/**
 * Note a warning about a class or a value, once per message in the process
 * (what is found about a class is cached with it, so it is found once): every
 * binding reports it once (see `notesSince`).
 */
export function noteOnce<C extends YKnownWarningCode>(
  code: C,
  message: string,
  data: YEmittedWarningData<C>,
): void {
  if (!noted.has(message)) {
    noted.add(message);
    notes.push({code, data, message} as WarningNote);
  }
}

/**
 * The notes made since a binding last took them (`seen` of them, oldest
 * first), and the new count. The list only grows by distinct messages, so it
 * stays as small as the set of classes and properties warned about.
 */
export function notesSince(
  seen: number,
): [notes: readonly WarningNote[], seen: number] {
  return [notes.slice(seen), notes.length];
}
