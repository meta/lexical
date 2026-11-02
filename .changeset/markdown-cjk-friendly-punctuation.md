---
'@lexical/markdown': patch
'@lexical/mdast': patch
---

[feature] Read emphasis beside CJK punctuation as CJK writers mean it, with a `punctuation` mode for Markdown import and export

CommonMark doesn't let `**` open or close between a letter and punctuation, so `**你好。**世界` reads with literal asterisks. Import in both packages now follows the [CommonMark CJK-friendly amendment](https://github.com/tats-u/markdown-cjk-friendly) by default, as `markdown-it-cjk-friendly` and `micromark-extension-cjk-friendly` do: Markdown reads as CommonMark reads it except beside Chinese, Japanese and Korean characters and punctuation, where `*`, `_` and `~~` markers open and close as their writer meant. Export still writes, by default, Markdown that strict CommonMark and GFM readers read the same way, with a character reference where a marker needs one (`**你好。**&#19990;界`).

`@lexical/markdown`'s `$convertFromMarkdownString`, `$generateNodesFromMarkdownString`, `$convertToMarkdownString` and `$convertSelectionToMarkdownString` take an options object in place of the `shouldPreserveNewLines` argument (`MarkdownImportOptions` and `MarkdownExportOptions`, which also hold `shouldPreserveNewLines` and, for import, `shouldMergeAdjacentLines`). Its `punctuation` option is `'cjk-friendly'` (the import default) or `'strict-commonmark'` (the export default). `@lexical/mdast`'s `MdastExtension` takes the same modes as `importPunctuation` and `exportPunctuation`. With `'cjk-friendly'`, export writes such CJK text as typed (`**你好。**世界`), for readers that follow the amendment. `@lexical/mdast` now writes references beside `~~` as it does beside `**`, so that strikethrough beside punctuation reads back with a strict import too.

Verify: Markdown such as `**你好。**世界` or `中文**「强调」**` imports as bold in both packages, as it did in `@lexical/markdown` before it followed CommonMark's Unicode punctuation; pass `punctuation: 'strict-commonmark'` (or `importPunctuation`) to read it as CommonMark does. `@lexical/mdast` export of strikethrough that starts or ends with punctuation beside a letter now holds character references (`~~你好。~~&#x4E16;界`), so check export snapshots.
