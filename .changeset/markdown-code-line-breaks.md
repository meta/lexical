---
'@lexical/markdown': patch
'@lexical/mdast': patch
---

[fix] A code block imported from Markdown holds a `LineBreakNode` per line and a `TabNode` per tab, as one typed or pasted in the editor does, instead of one `TextNode` with `"\n"` in its text

Verify: A code block imported with `$convertFromMarkdownString` (`@lexical/markdown` or `@lexical/mdast`) has the same text content and exports the same Markdown as before, but its children are now `TextNode`, `LineBreakNode` and `TabNode` siblings, so its serialized JSON differs, its HTML export has a `<br>` per line where it had a line feed inside one `<span>`, and a `"\r"` directly before a line feed is dropped. Code that read the whole block from `codeNode.getFirstChild().getTextContent()` should read `codeNode.getTextContent()`. Editor states serialized by earlier versions load unchanged, with their single text node. An editor with a code highlighter (`@lexical/code-prism`, `@lexical/code-shiki`) already replaced that node with these on import, and is unaffected.
