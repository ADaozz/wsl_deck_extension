import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureDeckScaffold } from '../state/workspaceDeckStore';

/** Stable id for a main workspace path (short hash). */
export function repoIdFromMainCwd(mainCwd: string): string {
	const normalized = path.resolve(mainCwd).replace(/\\/g, '/');
	return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function sanitizeSessionId(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

function defaultShadowRoot(): string {
	return path.join(os.homedir(), '.local', 'share', 'wsldeck-extension');
}

/**
 * Shadow directory for one session — kept OUTSIDE the workspace folder so VS Code
 * does not treat worktree files as Main Workspace edits / Diff spam.
 *
 * Default: `~/.local/share/wsldeck-extension/workspaces/<repoId>/<sessionId>`
 * Override: `wsldeck.shadow.root`
 *
 * UI state (resumes.json, change cards) stays in `<main>/.WSLDeck/`.
 */
export function shadowSessionDir(mainCwd: string, sessionId: string): string {
	const configured = vscode.workspace
		.getConfiguration('wsldeck')
		.get<string>('shadow.root', '')
		.trim();
	const root = configured || defaultShadowRoot();
	return path.join(root, 'workspaces', repoIdFromMainCwd(mainCwd), sanitizeSessionId(sessionId));
}

export function ensureShadowParent(mainCwd: string, sessionId: string): string {
	// Still ensure .WSLDeck scaffold exists for resumes/ui; shadows live elsewhere.
	try {
		ensureDeckScaffold(mainCwd);
	} catch {
		// ignore if main not writable
	}
	const dir = shadowSessionDir(mainCwd, sessionId);
	ensureDir(path.dirname(dir));
	return dir;
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}
