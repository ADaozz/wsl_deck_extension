/** True only for explicit ```bash fenced blocks — not inline code or other langs. */
export function isBashFenceLang(lang: string | undefined): boolean {
	const token = (lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	return token === 'bash';
}

/** Inline `` codespan run buttons stay disabled. */
export function isRunnableCommand(_text: string): boolean {
	return false;
}
