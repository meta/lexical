# Paragraph review with NodeState

This example adds a `reviewed` flag to existing paragraph nodes. `DOMRenderExtension` renders and exports the flag as `data-reviewed="true"`; `DOMImportExtension` restores it from HTML. NodeState handles JSON serialization and cloning without a custom node class.

Run `npm install` and `npm run dev` to start the standalone example. From the Lexical repository, run `pnpm build` and `pnpm exec vite examples/node-state-review -c examples/node-state-review/vite.config.monorepo.ts` to use the local packages.

Place the cursor in a paragraph and choose **Toggle reviewed**. Use **Export HTML**, edit the HTML, then choose **Import HTML** to try the round trip. Expand **Editor state JSON** to see the stored data.
