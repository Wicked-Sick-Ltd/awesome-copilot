import { statSync } from "node:fs";

// How Node starts the bare names "git" and "ssh" on Windows.
//
// Node.js 22.23.4 (libuv 1.51.0) passes execFile's file and cwd straight to
// uv_spawn (node/src/process_wrap.cc, options.file and options.cwd). uv_spawn
// then calls search_path with that cwd (libuv v1.51.0 src/win/process.c).
// For a name with no directory separator, search_path calls
// NeedCurrentDirectoryForExePathW(L"") and, when that returns TRUE, looks in
// the child cwd for name.com and then name.exe before it looks at PATH.
//
// NeedCurrentDirectoryForExePathW returns TRUE for a name that contains no
// backslash when NoDefaultCurrentDirectoryInExePath is absent. Wine's Windows
// tests (dlls/kernel32/tests/path.c, test_NeedCurrentDirectoryForExePathW)
// require that result for "cmd.exe" after the variable is deleted, and the
// Wine implementation of the API (dlls/kernelbase/file.c) matches it. Windows
// does not define that variable unless something sets it, so a default
// process searches the child cwd. This module always models that default:
// the variable is absent. A fix has to be safe in that configuration.

const exactNameFlag = 0;

export function windowsSpawnTarget(file, cwd, pathValue) {
	return searchPath(file, cwd, pathValue ?? "", {});
}

function needCurrentDirectoryForExePath(exeName, env) {
	if (exeName.includes("\\")) return true;
	return !Object.prototype.hasOwnProperty.call(env, "NoDefaultCurrentDirectoryInExePath");
}

function searchPath(file, cwd, pathValue, env) {
	if (file.length === 0 || file === ".") return null;
	let nameStart = file.length;
	while (nameStart > 0) {
		const character = file[nameStart - 1];
		if (character === "\\" || character === "/" || character === ":") break;
		nameStart -= 1;
	}
	const fileHasDir = nameStart !== 0;
	const fileName = file.slice(nameStart);
	const dot = fileName.indexOf(".");
	const nameHasExt = dot !== -1 && dot < fileName.length - 1;
	if (fileHasDir) {
		return pathSearchWalkExt(file.slice(0, nameStart), fileName, cwd, nameHasExt || exactNameFlag !== 0);
	}
	let result = null;
	if (needCurrentDirectoryForExePath("", env)) {
		result = pathSearchWalkExt("", file, cwd, nameHasExt);
	}
	let dirEnd = 0;
	let atStart = true;
	while (result === null) {
		if (dirEnd >= pathValue.length) break;
		if (!atStart || pathValue[0] === ";") dirEnd += 1;
		atStart = false;
		if (dirEnd >= pathValue.length) break;
		let dirStart = dirEnd;
		if (pathValue[dirStart] === "\"" || pathValue[dirStart] === "'") {
			const quote = pathValue[dirStart];
			const quoteEnd = pathValue.indexOf(quote, dirStart + 1);
			dirEnd = quoteEnd === -1 ? pathValue.length : quoteEnd;
		}
		const separator = pathValue.indexOf(";", dirEnd);
		dirEnd = separator === -1 ? pathValue.length : separator;
		if (dirEnd - dirStart === 0) continue;
		let dirPath = pathValue.slice(dirStart, dirEnd);
		if (dirPath.startsWith("\"") || dirPath.startsWith("'")) dirPath = dirPath.slice(1);
		if (dirPath.endsWith("\"") || dirPath.endsWith("'")) dirPath = dirPath.slice(0, -1);
		result = pathSearchWalkExt(dirPath, file, cwd, nameHasExt);
	}
	return result;
}

function pathSearchWalkExt(dir, name, cwd, nameHasExt) {
	if (nameHasExt) {
		const exact = searchPathJoinTest(dir, name, "", cwd);
		if (exact !== null) return exact;
	}
	const com = searchPathJoinTest(dir, name, "com", cwd);
	if (com !== null) return com;
	return searchPathJoinTest(dir, name, "exe", cwd);
}

function searchPathJoinTest(dir, name, ext, cwd) {
	let cwdUse = cwd;
	let dirUse = dir;
	if (dirUse.length > 2 && isSlash(dirUse[0]) && isSlash(dirUse[1])) {
		cwdUse = "";
	} else if (dirUse.length >= 1 && isSlash(dirUse[0])) {
		cwdUse = cwd.slice(0, 2);
	} else if (dirUse.length >= 2 && dirUse[1] === ":" && (dirUse.length < 3 || !isSlash(dirUse[2]))) {
		if (cwd.length < 2 || cwd.slice(0, 2).toLowerCase() !== dirUse.slice(0, 2).toLowerCase()) cwdUse = "";
		else dirUse = dirUse.slice(2);
	} else if (dirUse.length > 2 && dirUse[1] === ":") {
		cwdUse = "";
	}
	let result = cwdUse;
	if (cwdUse.length > 0 && !isSeparator(cwdUse.at(-1))) result += "\\";
	result += dirUse;
	if (dirUse.length > 0 && !isSeparator(result.at(-1))) result += "\\";
	result += name;
	if (ext.length > 0) {
		if (name.length > 0 && !name.endsWith(".")) result += ".";
		result += ext;
	}
	return existingLocalFile(result);
}

function existingLocalFile(windowsPath) {
	if (/^[A-Za-z]:/.test(windowsPath) || windowsPath.startsWith("\\\\")) return null;
	const local = windowsPath.replaceAll("\\", "/");
	try {
		return statSync(local).isFile() ? local : null;
	} catch {
		return null;
	}
}

function isSlash(character) {
	return character === "/" || character === "\\";
}

function isSeparator(character) {
	return character === "/" || character === "\\" || character === ":";
}
