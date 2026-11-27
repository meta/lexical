# Application node identity

This example demonstrates one application-owned policy for persistent external
node IDs using NodeState and released Lexical APIs. It is not a built-in Lexical
identity feature or a general recommendation for application addressing.

Run from this directory after `pnpm install`:

```bash
pnpm install
pnpm run dev
```

Open the printed URL. Edit, save/load, duplicate the first paragraph, or use
the browser's copy/cut/paste commands and inspect the serialized IDs.
Saving keeps a snapshot in memory, not across browser reloads.

[`src/identity.ts`](src/identity.ts) contains the policy; `src/main.ts` supplies
the editor and a random 128-bit ID allocator using `crypto.getRandomValues()`.
Integrating applications must allocate nonempty IDs unique across their identity
domain, including saved documents. Register the policy before creating content
and use `loadApplicationDocument` when restoring it.

The application-owned `$isAddressable` predicate selects non-root ElementNodes,
including custom elements and slots. TextNodes remain mergeable. Adapt that
predicate to your addressing needs; the policy has no dependency on the demo UI.
Save/load preserves IDs; new addressable nodes created by `$copyNode` or paste
receive fresh IDs, including after cut. Only `externalId` is cleared on paste.

The policy uses an O(N) RootNode scan and public, experimental `$dfsWithSlots`.
The exact application boundaries are described below.

## Policy boundaries

- Every newly inserted addressable node gets fresh identity, including after cut/paste. This is an application
	policy, not a distinction encoded in the structured clipboard payload.
- The receiver controls cross-editor behavior. Structured transfer requires
	compatible namespaces and node types; an editor without this policy can
	preserve source IDs.
- The application must know its identity StateConfigs. Unknown third-party
	state is not inferred to be identity. Custom import paths bypassing the
	insertion command require equivalent handling.
- This example covers children and named slots using public, **experimental**
	`$dfsWithSlots`. Stable children-only `$dfs` cannot cover slots. Embedded
	independent editors and references need application-specific handling.
- The RootNode transform scans the document in O(N) after dirty updates,
	including ordinary text edits. Per-class transforms can reduce that work
	when an application knows every relevant node class; they do not inherit
	automatically to arbitrary custom nodes.
- Applications must choose their addressing granularity and split/merge policy;
	this example does not repair existing collisions or provide collaborative
	identity reconciliation.

Run the focused tests from the repository root:

```sh
pnpm run test-unit examples/node-state-identity/src/__tests__/unit/identity.test.ts
```
