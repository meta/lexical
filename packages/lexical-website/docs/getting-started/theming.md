---
sidebar_position: 3
---

# Theming

Lexical tries to make theming straight-forward, by providing a way of passing a customizable theming object that maps CSS class names to the editor on creation. Here's an example of a plain-text theme:

```js
const exampleTheme = {
  paragraph: 'editor-paragraph',
};
```

In your CSS, you can then add something like:

```css
.editor-placeholder {
  color: #999;
  overflow: hidden;
  position: absolute;
  top: 15px;
  left: 15px;
  user-select: none;
  pointer-events: none;
}

.editor-paragraph {
  margin: 0 0 15px 0;
  position: relative;
}
```

Put the theme on your root extension. The same theme configuration works with
React and vanilla JavaScript:

```js
import {PlainTextExtension} from '@lexical/plain-text';
import {defineExtension} from 'lexical';

export const appExtension = defineExtension({
  name: 'MyEditor',
  namespace: 'MyEditor',
  dependencies: [PlainTextExtension],
  theme: exampleTheme,
});
```

In React, pass that stable extension to `LexicalExtensionComposer`. This example
places its own `ContentEditable`, so it disables the composer's default one:

```jsx
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {appExtension} from './appExtension';

export default function Editor() {
  return (
    <LexicalExtensionComposer extension={appExtension} contentEditable={null}>
      <div style={{position: 'relative'}}>
        <ContentEditable
          aria-label="Plain text editor"
          aria-placeholder="Enter some text..."
          placeholder={<div className="editor-placeholder">Enter some text...</div>}
        />
      </div>
    </LexicalExtensionComposer>
  );
}
```

In vanilla JavaScript, build the editor from the same extension and attach it to
your editable element:

```js
import {buildEditorFromExtensions} from '@lexical/extension';
import {appExtension} from './appExtension';

const editor = buildEditorFromExtensions(appExtension);
editor.setRootElement(document.getElementById('editor'));
// Call editor.dispose() when removing this editor permanently.
```

A theme supplies class names; it does not install features or include CSS. For
example, to use the heading and quote styles below, add `RichTextExtension` in
place of `PlainTextExtension`. Add the corresponding extensions for lists, links,
and code highlighting when you need those features.

## Merging extension themes

Every extension can supply a `theme`. Lexical recursively merges these themes in
dependency order: dependencies contribute first, and extensions that depend on
them can override individual entries. Your root extension can therefore customize
an extension's styles while keeping the rest of its theme, including nested
entries such as `text` and `heading`.

```js
const EmphasisExtension = defineExtension({
  name: 'Emphasis',
  theme: {
    text: {
      bold: 'emphasis-bold',
      italic: 'emphasis-italic',
    },
  },
});

const appExtension = defineExtension({
  name: 'MyEditor',
  dependencies: [PlainTextExtension, EmphasisExtension],
  theme: {
    paragraph: 'editor-paragraph',
    text: {bold: 'editor-bold'},
  },
});

// The merged theme is:
// {
//   paragraph: 'editor-paragraph',
//   text: {bold: 'editor-bold', italic: 'emphasis-italic'},
// }
```

When two themes set the same entry, the later value replaces the earlier one;
class-name strings are not concatenated. There is no need to spread a dependency's
theme into your own.

## Available theme entries

Many of the Lexical's core nodes also accept theming properties. Here's a more comprehensive theming object:

```js
const exampleTheme = {
  paragraph: 'editor-paragraph',
  quote: 'editor-quote',
  heading: {
    h1: 'editor-heading-h1',
    h2: 'editor-heading-h2',
    h3: 'editor-heading-h3',
    h4: 'editor-heading-h4',
    h5: 'editor-heading-h5',
    h6: 'editor-heading-h6',
  },
  list: {
    nested: {
      listitem: 'editor-nested-listitem',
    },
    ol: 'editor-list-ol',
    ul: 'editor-list-ul',
    listitem: 'editor-listItem',
    listitemChecked: 'editor-listItemChecked',
    listitemUnchecked: 'editor-listItemUnchecked',
  },
  hashtag: 'editor-hashtag',
  image: 'editor-image',
  link: 'editor-link',
  text: {
    bold: 'editor-textBold',
    code: 'editor-textCode',
    italic: 'editor-textItalic',
    strikethrough: 'editor-textStrikethrough',
    subscript: 'editor-textSubscript',
    superscript: 'editor-textSuperscript',
    underline: 'editor-textUnderline',
    underlineStrikethrough: 'editor-textUnderlineStrikethrough',
  },
  code: 'editor-code',
  codeHighlight: {
    atrule: 'editor-tokenAttr',
    attr: 'editor-tokenAttr',
    boolean: 'editor-tokenProperty',
    builtin: 'editor-tokenSelector',
    cdata: 'editor-tokenComment',
    char: 'editor-tokenSelector',
    class: 'editor-tokenFunction',
    'class-name': 'editor-tokenFunction',
    comment: 'editor-tokenComment',
    constant: 'editor-tokenProperty',
    deleted: 'editor-tokenProperty',
    doctype: 'editor-tokenComment',
    entity: 'editor-tokenOperator',
    function: 'editor-tokenFunction',
    important: 'editor-tokenVariable',
    inserted: 'editor-tokenSelector',
    keyword: 'editor-tokenAttr',
    namespace: 'editor-tokenVariable',
    number: 'editor-tokenProperty',
    operator: 'editor-tokenOperator',
    prolog: 'editor-tokenComment',
    property: 'editor-tokenProperty',
    punctuation: 'editor-tokenPunctuation',
    regex: 'editor-tokenVariable',
    selector: 'editor-tokenSelector',
    string: 'editor-tokenSelector',
    symbol: 'editor-tokenProperty',
    tag: 'editor-tokenProperty',
    url: 'editor-tokenOperator',
    variable: 'editor-tokenVariable',
  },
};
```
