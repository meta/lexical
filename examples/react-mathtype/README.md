# React MathType example

This example demonstrates a standalone WIRIS MathType integration for a
Lexical React editor. It keeps MathType as an example dependency and stores
formulas in a custom Lexical node instead of allowing MathType to mutate the
Lexical contenteditable directly.

The bridge is packaged as `MathTypeExtension`. It uses
`@wiris/mathtype-generic` to open the MathType/ChemType UI, converts the
generated MathML image into `MathTypeNode` state inside `editor.update`, and
reopens MathType when a formula node is double-clicked.

MathType stores formulas as MathML. The rendered formula image is kept in node
state for the demo, while DOM export emits the same `img.Wirisformula` shape
that MathType's parser expects.

## How the pieces fit together

`MathTypeExtension.build` owns the mutable bridge state — the MathType
integration instance and the node the open dialog is editing — for the
lifetime of one editor, and exposes two functions over it:

- `mountIntegration(target, toolbar)` creates the MathType integration and
  returns its teardown function. `MathTypeIntegrationComponent` calls it from
  an effect and renders the toolbar plus the offscreen element MathType uses
  to anchor its dialog.
- `editFormula(nodeKey, formula)` reopens MathType for an existing node. The
  `MathTypeNode` decorator reaches it with
  `useExtensionDependency(MathTypeExtension)`.

Using the extension's own output rather than a React context means the
extension does not have to override `ReactExtension`'s
`EditorChildrenComponent`, which is a single, last-one-wins slot: taking it
would silently break any other extension in the editor that needs it.

## Running

```bash
pnpm install
pnpm run dev
pnpm run build
pnpm run typecheck
```

MathType may require a WIRIS license or self-hosted services for production
use. See the MathType generic integration documentation for service
configuration details. Out of the box the integration calls WIRIS' hosted demo
services at `www.wiris.net`, so the editor needs network access to them to
render formulas.

`@wiris/mathtype-generic` is imported eagerly at module scope, because it
installs the `window.WirisPlugin` singleton that `MathTypeNode` needs in order
to render a formula on the first paint. That puts the whole MathType bundle in
the initial chunk, which is why `vite build` reports a chunk over 500 kB.
