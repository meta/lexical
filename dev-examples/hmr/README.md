# Lexical HMR Example

A minimal [Vite](https://vitejs.dev/) + React app that demonstrates
`HMRExtension` from `@lexical/extension`. Editor content, the editable flag, and undo/redo history (via
`HistoryExtension`) are preserved across hot module reloads.

## Running

From the repository root:

```sh
pnpm install
pnpm -C dev-examples/hmr dev
```

Then open the printed URL, type something, and edit `src/App.tsx`. The editor
state survives the reload.
