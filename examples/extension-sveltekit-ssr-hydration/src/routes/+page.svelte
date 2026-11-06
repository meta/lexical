<script lang="ts">
	// Use * imports to reference lexical $functions from a .svelte
	// file without renaming
	import * as buildEditor from '$lib/buildEditor';
	import { browser } from '$app/environment';
	import * as extension from '@lexical/extension';

	let editorRef: HTMLElement;
	let initialState = browser ? null : buildEditor.$initialEditorStateServer;
	const editor = buildEditor.buildEditor(initialState, browser ? import.meta.hot : undefined);
	// preact signals comply with the svelte store API so we can use these reactively with $ prefixes
	// from a .svelte file
	const stateSignal = extension.getExtensionDependencyFromEditor(
		editor,
		extension.EditorStateExtension
	).output;
	const editableSignal = extension.getExtensionDependencyFromEditor(
		editor,
		extension.WatchEditableExtension
	).output;
	$effect(() => {
		if (browser && editorRef) {
			buildEditor.hydrate(editor, editorRef);
			editor.setRootElement(editorRef);
		}
	});
	// Only compute this on the client
	let exportJson = $derived(browser ? JSON.stringify($stateSignal.toJSON(true), null, 2) : '');
</script>

<svelte:head>
	<title>Lexical Extension + Svelte + Tailwind</title>
</svelte:head>

<header class="m-4">
	<h1 class="my-4 text-xl font-bold">Lexical Extension + Svelte + Tailwind</h1>
</header>
<main class="m-4">
	<div class="relative container mx-auto">
		<button
			class="mb-2 cursor-pointer border-0 bg-indigo-700 px-6 py-2.5 text-sm font-medium tracking-wider text-white outline-0 hover:bg-indigo-800"
			onclick={() => {
				editor.setEditable(!$editableSignal);
			}}>Toggle Editable {$editableSignal ? 'OFF' : 'ON'}</button
		>
		<div
			class="relative container mx-auto border border-solid p-4"
			role="textbox"
			data-lexical-editor="true"
			bind:this={editorRef}
			contenteditable={$editableSignal}
		>
			<!-- eslint-disable-next-line svelte/no-unused-svelte-ignore -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags --><!-- svelte-ignore hydration_html_changed -->
			{@html browser ? '<!-- server hydrated -->' : buildEditor.prerenderHtml(editor)}
		</div>
	</div>
	<pre class="max-w-xl">{exportJson}</pre>
</main>
