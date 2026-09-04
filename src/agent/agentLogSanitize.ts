/**
 * Normalize CLI stderr/stdout lines for Agent Log (wsl.exe pipes may deliver UTF-16 LE as mojibake).
 */
export function sanitizeAgentLogLine(line: string): string {
	if (!line) {
		return line;
	}
	const decoded = tryDecodeUtf16LeLine(line);
	return escapeControlChars(decoded ?? line);
}

function tryDecodeUtf16LeLine(line: string): string | undefined {
	const buf = Buffer.from(line, 'latin1');
	if (buf.length < 4) {
		return undefined;
	}
	let utf16Like = 0;
	let pairs = 0;
	for (let i = 1; i < buf.length; i += 2) {
		pairs++;
		if (buf[i] === 0 && buf[i - 1] >= 0x20 && buf[i - 1] <= 0x7e) {
			utf16Like++;
		}
	}
	// A couple of Unicode code units can also have a zero low byte. Require a
	// meaningful share of alternating ASCII/NUL pairs before decoding the whole
	// line, otherwise large normal UTF-8 JSON payloads become false positives.
	if (utf16Like < 2 || pairs === 0 || utf16Like / pairs < 0.2) {
		return undefined;
	}
	const text = buf.toString('utf16le').replace(/\0/g, '');
	return text.trim() ? text : undefined;
}

function escapeControlChars(line: string): string {
	let out = '';
	for (let i = 0; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (code === 9 || code === 10 || code === 13 || code >= 32) {
			out += line[i];
		} else {
			out += `\\x${code.toString(16).padStart(2, '0')}`;
		}
	}
	return out;
}
