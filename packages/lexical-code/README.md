# `@lexical/code`

[![See API Documentation](https://lexical.dev/img/see-api-documentation.svg)](https://lexical.dev/docs/api/modules/lexical_code)

This package contains the functionality for the code blocks for Lexical. It is a
thin re-export of `@lexical/code-core` and contains no syntax highlighting.

Code highlighting lives in its own packages: depend directly on
`@lexical/code-shiki` or `@lexical/code-prism` for that. The deprecated prism
re-exports that this package used to forward from `@lexical/code-prism` have
been removed; import them from `@lexical/code-prism` instead.
