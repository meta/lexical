# lexical-metro-headless

Integration fixture that bundles `@lexical/headless` and `lexical` with
[Metro](https://metrobundler.dev/), the React Native bundler, and executes the
bundles under Node.js.

It checks that the published ESM builds resolve and run through Metro's
package-exports resolution with Metro's defaults (which reach the `default`
fork module and bundle both the development and the production build), and
that the `resolveRequest` documented in the website FAQ ("Which module formats
are published?") leaves exactly one build in each bundle.

Run from the monorepo root with the other integration fixtures:

```
pnpm run test-integration
```
