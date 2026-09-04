import { marked, Renderer } from 'marked';
import { isBashFenceLang } from '../src/ui/runCommandHeuristic';

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function runButton(command: string): string {
	return `<button type="button" class="run-cmd" data-run-cmd="${encodeURIComponent(command)}" title="Run in WSLDeck WSL" aria-label="Run command">▶</button>`;
}

function createRenderer(): Renderer {
	const renderer = new Renderer();

	renderer.codespan = (text: string) => {
		return `<code class="md-codespan">${escapeHtml(text)}</code>`;
	};

	renderer.code = (code: string, infostring: string | undefined, _escaped: boolean) => {
		const body = code.replace(/\n$/, '');
		const lang = (infostring || '').trim().split(/\s+/)[0] || '';
		const langClass = lang ? ` language-${escapeHtml(lang)}` : '';
		const toolbar =
			isBashFenceLang(infostring) && body.trim()
				? `<div class="md-code-toolbar">${runButton(body)}</div>`
				: '';
		return `<pre class="md-code-block"><code class="md-code${langClass}">${escapeHtml(body)}</code>${toolbar}</pre>\n`;
	};

	renderer.link = (href: string, title: string | null | undefined, text: string) => {
		const safeHref = href && /^(https?:|vscode:|mailto:)/i.test(href) ? href : '#';
		const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
		return `<a href="${escapeHtml(safeHref)}"${titleAttr} rel="noreferrer">${text}</a>`;
	};

	return renderer;
}

marked.setOptions({
	gfm: true,
	breaks: true,
	renderer: createRenderer(),
});

/** Render agent markdown to safe-ish HTML (custom renderer escapes text nodes). */
export function renderMarkdown(source: string): string {
	const text = source ?? '';
	if (!text.trim()) {
		return '';
	}
	try {
		return marked.parse(text) as string;
	} catch {
		return `<p>${escapeHtml(text)}</p>`;
	}
}
