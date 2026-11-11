# Example source in documentation

Getting Started guides import runnable example code as strings and render it with Docusaurus `CodeBlock`. Edit the example source to update these blocks; do not copy the code into MDX.

Mark each fragment with a stable name and a comment identifying the guide that reads it:

```ts
// [docs:my-extension] Read directly by the Creating an Extension guide.
export const MyExtension = defineExtension({
  name: 'MyExtension',
});
// [/docs:my-extension]
```

Then import that region in the guide:

```mdx
import CodeBlock from '@theme/CodeBlock';
import MyExtensionSource from '!!example-source?region=my-extension!@site/../../examples/my-example/src/MyExtension.ts';

<CodeBlock language="ts" title="examples/my-example/src/MyExtension.ts">
  {MyExtensionSource}
</CodeBlock>
```

The local `example-source` loader is registered in `docusaurus.config.ts`. `!!` bypasses the normal source loaders so the example is displayed as text, not executed in the documentation page. The bundler tracks the imported file, so edits also refresh the documentation during development.

Use named markers, never line ranges. Formatting changes and unrelated insertions must not change which code the guide includes. Each imported region must have exactly one opening and one closing marker, in that order, and contain nonempty source. A missing, duplicated, reversed, or empty region fails the documentation build with the file path and region name.

Regions may be nested. All marker comments are removed from the displayed code, and common indentation is removed. CSS uses `/* [docs:name] */` and `/* [/docs:name] */`; HTML uses `<!-- [docs:name] -->` and `<!-- [/docs:name] -->`.

The loader tests run as part of `test-examples` in CI. Small illustrative snippets that explain an alternative usage may still be written in MDX; code taken from a runnable example should use this loader.
