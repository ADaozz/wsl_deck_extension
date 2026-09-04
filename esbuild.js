const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
	bundle: true,
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	logLevel: 'info',
};

async function main() {
	const extensionCtx = await esbuild.context({
		...common,
		entryPoints: ['src/extension.ts'],
		format: 'cjs',
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode', '@cursor/sdk'],
	});

	const webviewCtx = await esbuild.context({
		...common,
		entryPoints: ['webview/index.ts'],
		format: 'iife',
		platform: 'browser',
		outfile: 'dist/webview.js',
		target: ['es2022'],
	});

	if (watch) {
		await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
	} else {
		await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
		await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
