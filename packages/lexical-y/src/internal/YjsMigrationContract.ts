/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// What the migration runner and the server entry use of @y/y beyond the
// core's contract (YjsContract): checked by those entries alone, so the
// core neither ships nor runs this part of the probe.

import {
  applyUpdate,
  type ContentAny,
  ContentDeleted,
  createID,
  createIdSet,
  decodeUpdate,
  diffUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVectorFromUpdate,
  type GC,
  type IdSet,
  intersectUpdateWithContentIds,
  Item,
  Node as YNode,
  Skip,
} from '@y/y';

import {SUPPORTED_YJS_VERSION} from './SupportedYjs';
import {
  assertSupportedYjs,
  isBoolean,
  isFunction,
  isNumber,
  isObject,
  isSet,
  YUnsupportedYjsError,
} from './YjsContract';

/**
 * The @y/y exports the runner and the server import beyond the core's
 * (YJS_EXPORTS).
 */
export const MIGRATION_YJS_EXPORTS = [
  'ContentDeleted',
  'diffUpdate',
  'encodeStateVectorFromUpdate',
  'intersectUpdateWithContentIds',
] as const;

type StructStore = Doc['store'];
type AbstractContent = Item['content'];
type ContentIds = Parameters<typeof intersectUpdateWithContentIds>[1];

/**
 * The members the runner and the server read beyond the core's
 * (yjsMembers), by the name of the @y/y type that declares them.
 *
 * @__NO_SIDE_EFFECTS__
 */
export function migrationYjsMembers() {
  return {
    AbstractContent: {
      copy: (c: AbstractContent) => isFunction(c.copy),
      getRef: (c: AbstractContent) => isFunction(c.getRef),
    },
    ContentAny: {
      arr: (c: ContentAny) => Array.isArray(c.arr),
    },
    ContentIds: {
      deletes: (c: ContentIds) => isObject(c.deletes),
      inserts: (c: ContentIds) => isObject(c.inserts),
    },
    Doc: {
      gc: (d: Doc) => isBoolean(d.gc),
    },
    GC: {
      length: (g: GC) => isNumber(g.length),
    },
    IdSet: {
      isEmpty: (s: IdSet) => isFunction(s.isEmpty),
    },
    Skip: {
      length: (k: Skip) => isNumber(k.length),
    },
    StructStore: {
      pendingDs: (s: StructStore) => isSet(s.pendingDs),
      pendingStructs: (s: StructStore) => isSet(s.pendingStructs),
      skips: (s: StructStore) => isObject(s.skips),
    },
  };
}

/** The exports this probe calls. */
function migrationYjsExports() {
  return {
    ContentDeleted,
    Doc,
    Item,
    Node: YNode,
    Skip,
    applyUpdate,
    createID,
    createIdSet,
    decodeUpdate,
    diffUpdate,
    encodeStateAsUpdate,
    encodeStateVectorFromUpdate,
    intersectUpdateWithContentIds,
  };
}

export type MigrationYjsExports = ReturnType<typeof migrationYjsExports>;

const PROBE_GUID = '@lexical/y/yjs-migration-probe';

/**
 * Probe `y` against the runner's and server's part of the contract: the
 * list of what is missing or changed, empty when it matches. Writes only to
 * scratch documents of its own.
 */
export function probeMigrationYjs(
  y: MigrationYjsExports = migrationYjsExports(),
): string[] {
  const found: string[] = [];
  const exportsOf = y as unknown as Record<string, unknown>;
  for (const name of MIGRATION_YJS_EXPORTS) {
    if (typeof exportsOf[name] !== 'function') {
      found.push(name);
    }
  }
  if (found.length > 0) {
    return found;
  }
  const members = migrationYjsMembers() as unknown as Record<
    string,
    Record<string, (value: object) => boolean>
  >;
  const sample = (kind: string, value: unknown) => {
    // A kind whose members the core's contract checks (none listed here).
    const checks = members[kind];
    if (checks === undefined) {
      return;
    }
    if (typeof value !== 'object' || value === null) {
      found.push(`${kind} (none to check)`);
      return;
    }
    for (const [member, check] of Object.entries(checks)) {
      let ok = false;
      try {
        ok = check(value);
      } catch {
        // A getter that throws is a changed member too.
      }
      if (!ok) {
        found.push(`${kind}#${member}`);
      }
    }
  };
  try {
    // A garbage collected document: the items of a deleted node leave a GC
    // struct.
    const doc = new y.Doc({guid: PROBE_GUID});
    sample('Doc', doc);
    sample('StructStore', doc.store);
    const root = doc.get('probe');
    const node = new y.Node('n');
    doc.transact(() => root.insert(0, [node]));
    doc.transact(() => node.insert(0, 'ab'));
    doc.transact(() => root.delete(0, 1));
    const structs = doc.store.clients.get(doc.clientID) || [];
    sample(
      'GC',
      structs.find(s => !(s instanceof y.Item)),
    );
    // The kind codes the runner compares content by: a string and an
    // "any" item differ.
    const text = new y.Doc({guid: PROBE_GUID});
    const t = text.get('probe');
    text.transact(() => {
      t.insert(0, 'a');
      t.insert(1, [1]);
    });
    const first = t._start;
    sample('AbstractContent', first === null ? null : first.content);
    if (
      first === null ||
      first.right === null ||
      first.content.getRef() === first.right.content.getRef()
    ) {
      found.push('AbstractContent#getRef does not tell content kinds apart');
    }
    text.destroy();
    const ids = y.createIdSet();
    sample('IdSet', ids);
    sample('Skip', new y.Skip(y.createID(1, 0), 1));
    // The pattern intersectUpdateWithContentIds reads (the runner passes
    // one): an empty one keeps no struct of a document with some.
    const pattern = {deletes: y.createIdSet(), inserts: y.createIdSet()};
    sample('ContentIds', pattern);
    const update = y.encodeStateAsUpdate(doc);
    if (
      y.decodeUpdate(y.intersectUpdateWithContentIds(update, pattern)).structs
        .length !== 0
    ) {
      found.push('intersectUpdateWithContentIds ignores ContentIds#inserts');
    }
    // A diff against the document's own state vector holds no struct.
    if (
      y.decodeUpdate(
        y.diffUpdate(update, y.encodeStateVectorFromUpdate(update)),
      ).structs.length !== 0
    ) {
      found.push('diffUpdate or encodeStateVectorFromUpdate changed');
    }
    const copy = new y.Doc({guid: PROBE_GUID});
    y.applyUpdate(copy, update);
    copy.destroy();
    doc.destroy();
  } catch (error) {
    found.push(
      `probe threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return found;
}

/** What the check found, once per module; undefined until it ran. */
let verdict: readonly string[] | undefined;

/**
 * Throw a YUnsupportedYjsError unless the @y/y the app loaded provides the
 * core's contract and the runner's and server's part of it. Probes once per
 * module; later calls reuse the verdict.
 */
export function assertSupportedMigrationYjs(): void {
  assertSupportedYjs();
  if (verdict === undefined) {
    verdict = Object.freeze(probeMigrationYjs());
  }
  if (verdict.length > 0) {
    throw new YUnsupportedYjsError({
      found: verdict.slice(),
      reason: 'changed-internals',
      supported: SUPPORTED_YJS_VERSION,
    });
  }
}
