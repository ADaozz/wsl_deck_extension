/** rg/grep/find exit 1 means "no matches", not a hard failure. */
export function isBenignCommandExitCode(command: string | undefined, exitCode: number): boolean {
	if (exitCode === 0) {
		return true;
	}
	if (exitCode !== 1 || !command?.trim()) {
		return false;
	}
	return /\b(rg|grep|git\s+grep|find)\b/.test(command);
}

export function toolCompletedOk(
	command: string | undefined,
	status: string | undefined,
	exitCode: number | undefined,
): boolean {
	if (status !== 'failed') {
		return true;
	}
	if (typeof exitCode === 'number') {
		return isBenignCommandExitCode(command, exitCode);
	}
	// Some providers mark search tools failed without surfacing exit code (rg → 1 = no matches).
	if (command?.trim() && /\b(rg|grep|git\s+grep|find)\b/.test(command)) {
		return true;
	}
	return false;
}
