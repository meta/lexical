# `@lexical/headless`

[![See API Documentation](https://lexical.dev/img/see-api-documentation.svg)](https://lexical.dev/docs/api/modules/lexical_headless)

This package allows you to interact with Lexical in a headless environment (one that does not rely on DOM, e.g. for Node.js environment), and use its
main features like editor.update(), editor.registerNodeTransform(), editor.registerUpdateListener()
to create, update or traverse state.

Install `@lexical/headless`:

```
npm install --save @lexical/headless
```

```js
import { createHeadlessEditor } from '@lexical/headless';

const editor = createHeadlessEditor({
  nodes: [],
  onError: () => {},
});

editor.update(() => {
  $getRoot().append(
    $createParagraphNode().append(
      $createTextNode('Hello world')
    )
  )
});
```

An editor built from extensions does not need `createHeadlessEditor`: an
editor that is never given a root element already skips all DOM work. Add
`HeadlessExtension` to make that explicit. It marks the editor (and any nested
editors) as headless and makes `setRootElement` throw if it is given an
element, while extensions that register root or mutation listeners keep
working.

```js
import { buildEditorFromExtensions } from '@lexical/extension';
import { HeadlessExtension } from '@lexical/headless';
import { RichTextExtension } from '@lexical/rich-text';
import { defineExtension } from 'lexical';

const editor = buildEditorFromExtensions(
  defineExtension({
    name: '[root]',
    dependencies: [HeadlessExtension, RichTextExtension],
  }),
);
```

Lexical packages are published as ES modules. A CommonJS project can load them
with `require()` on Node.js 20.19 or later, but any dependency it shares with
Lexical (such as `yjs`) has to be loaded as an ES module as well, or the
project ends up with two copies of it; see
[Which module formats are published?](https://lexical.dev/docs/faq#which-module-formats-are-published-esm-commonjs-nodejs-react-native).

Any plugins that do not rely on DOM could also be used. Here's an example of how
you can convert lexical editor state to markdown on server:
```js
import { createHeadlessEditor } from '@lexical/headless';
import { $convertToMarkdownString, TRANSFORMERS } from '@lexical/markdown';

app.get('article/:id/markdown', async (req, res) => {
  const editor = createHeadlessEditor({
    nodes: [],
    onError: () => {},
  });

  const articleEditorStateJSON = await loadArticleBody(req.query.id);
  editor.setEditorState(editor.parseEditorState(articleEditorStateJSON));

  editor.update(() => {
    const markdown = $convertToMarkdownString(TRANSFORMERS);
    res.send(markdown);
  });
});

```
