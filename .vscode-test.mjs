/** @type {import('@vscode/test-cli').TestConfig} */
export default {
	files: 'out/test/**/*.test.js',
	mocha: {
		ui: 'tdd',
		timeout: 20_000,
	},
};
