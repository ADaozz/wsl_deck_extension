import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['dist/**', 'out/**', '.vscode-test/**', 'esbuild.js'],
	},
	...tseslint.configs.recommended,
	{
		files: ['src/**/*.ts', 'webview/**/*.ts', 'test/**/*.ts'],
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_' },
			],
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'@typescript-eslint/no-explicit-any': 'warn',
		},
	},
);
