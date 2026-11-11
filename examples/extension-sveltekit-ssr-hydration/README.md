# Svelte 5 + Lexical Extension Demo

This example demonstrates how you can use Lexical Extension signals
reactively with a `$` prefix because they comply with the Svelte Store API.

This example shows how you might do SSR to prerender the editor's HTML
and hydrate it client-side directly from the prerendered HTML (so you're not
sending the content twice). Note that this only works well when your importDOM
is lossless relative to the createDOM output.

It's also a rudimentary demo for how you can support Vite HMR to preserve
the editor's state during reloads (great for tweaking html/styles/etc.)

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main/examples/extension-sveltekit-ssr-hydration?file=src%2Froutes%2F%2Bpage.svelte)
