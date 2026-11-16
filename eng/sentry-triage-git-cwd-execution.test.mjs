// These tests fail while extensions/sentry-triage/extension.mjs resolves git
// with execSync in the session checkout. They pass once that lookup cannot
// execute git.cmd, git.bat, or git.exe from the checkout and cannot wait
// forever for it. Run: node eng/sentry-triage-git-cwd-execution.test.mjs
// On Windows the file runs directly. Elsewhere set WINDOWS_NODE to a Windows
// node.exe (the extension requires Node >= 22) and have Wine on PATH.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const helperDir = join(here, 'sentry-triage-git-cwd')
const trustedExe = join(helperDir, 'fixtures', 'trusted-git.exe')
const thisFile = fileURLToPath(import.meta.url)

if (process.platform !== 'win32') {
  const nodeExe = process.env.WINDOWS_NODE
  if (!nodeExe) {
    console.error('Set WINDOWS_NODE to a Windows node.exe (v22.x) and run under Wine, or run this file on Windows.')
    process.exit(1)
  }
  const script = `Z:${resolve(thisFile).replaceAll('/', '\\')}`
  const stdoutPath = join(tmpdir(), 'sentry-triage-git-cwd-stdout.txt')
  const stderrPath = join(tmpdir(), 'sentry-triage-git-cwd-stderr.txt')
  const stdoutFd = openSync(stdoutPath, 'w')
  const stderrFd = openSync(stderrPath, 'w')
  // Wine's Node opens stdio with a console call that rejects pipes. Regular
  // files are handles it can use, so the Windows run writes here and we copy
  // the text back to this process.
  const result = spawnSync(process.env.WINE || 'wine', [nodeExe, '--test', '--test-concurrency=1', script], {
    stdio: ['ignore', stdoutFd, stderrFd],
    env: { ...process.env, WINEDEBUG: process.env.WINEDEBUG || '-all' },
  })
  closeSync(stdoutFd)
  closeSync(stderrFd)
  process.stdout.write(readFileSync(stdoutPath, 'utf8'))
  process.stderr.write(readFileSync(stderrPath, 'utf8'))
  process.exit(result.status ?? 1)
}

function windowsPath(value) {
  return value
}

function runCase(which, { timeout = 20000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sentry-triage-git-'))
  const attack = join(root, 'repo')
  const safe = join(root, 'safe')
  const trusted = join(root, 'trusted')
  const marker = join(root, 'marker.txt')
  const stdoutPath = join(root, 'stdout.txt')
  const stderrPath = join(root, 'stderr.txt')
  mkdirSync(attack)
  mkdirSync(safe)
  mkdirSync(trusted)
  copyFileSync(trustedExe, join(trusted, 'git.exe'))
  const stdoutFd = openSync(stdoutPath, 'w')
  const stderrFd = openSync(stderrPath, 'w')
  const env = { ...process.env }
  for (const key of ['GITHUB_REPOSITORY', 'GITHUB_BASE_REF', 'GITHUB_SERVER_URL', 'NoDefaultCurrentDirectoryInExePath']) {
    delete env[key]
  }
  env.SENTRY_TRIAGE_ATTACK_CWD = windowsPath(attack)
  env.SENTRY_TRIAGE_GIT_MARKER = windowsPath(marker)
  env.SENTRY_TRIAGE_TRUSTED_DIR = windowsPath(trusted)
  env.SENTRY_TRIAGE_CASE = which
  env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(join(helperDir, 'register-sdk-mock.mjs')).href,
    join(helperDir, 'run-case.mjs'),
  ], {
    cwd: safe,
    env,
    stdio: ['ignore', stdoutFd, stderrFd],
    timeout,
  })
  closeSync(stdoutFd)
  closeSync(stderrFd)
  result.stdout = readFileSync(stdoutPath, 'utf8')
  result.stderr = readFileSync(stderrPath, 'utf8')
  let markerText = ''
  try {
    markerText = readFileSync(marker, 'utf8')
  } catch {
    markerText = ''
  }
  return { root, result, markerText }
}

function assertNotPlanted(which, outcome) {
  const planted = outcome.markerText.split(/\r?\n/).filter((line) => line.startsWith('PLANTED-'))
  const detail = [
    `status=${outcome.result.status}`,
    `error=${outcome.result.error ? outcome.result.error.code || outcome.result.error.message : ''}`,
    `stdout=${outcome.result.stdout || ''}`,
    `stderr=${outcome.result.stderr || ''}`,
    `marker=${outcome.markerText}`,
  ].join('\n')
  assert.equal(outcome.result.error, undefined, `${which} did not finish\n${detail}`)
  assert.equal(outcome.result.status, 0, `${which} executed a git planted in the checkout\n${detail}`)
  assert.deepEqual(planted, [], `${which} wrote a planted-git marker\n${detail}`)
}

test('git.cmd in the opened repository is not executed on load or canvas open', () => {
  const outcome = runCase('cmd')
  try {
    assertNotPlanted('git.cmd', outcome)
  } finally {
    rmSync(outcome.root, { recursive: true, force: true })
  }
})

test('git.bat in the opened repository is not executed on load or canvas open', () => {
  const outcome = runCase('bat')
  try {
    assertNotPlanted('git.bat', outcome)
  } finally {
    rmSync(outcome.root, { recursive: true, force: true })
  }
})

test('git.exe in the opened repository is not executed on load or canvas open', () => {
  const outcome = runCase('exe')
  try {
    assertNotPlanted('git.exe', outcome)
  } finally {
    rmSync(outcome.root, { recursive: true, force: true })
  }
})

test('a planted git.cmd that exits nonzero still does not run before the remote check fails', () => {
  const outcome = runCase('nonzero')
  try {
    assertNotPlanted('git.cmd exiting nonzero', outcome)
  } finally {
    rmSync(outcome.root, { recursive: true, force: true })
  }
})

test('extension startup returns when the git command never exits', () => {
  const outcome = runCase('hang', { timeout: 15000 })
  try {
    assertNotPlanted('hanging git.cmd', outcome)
  } finally {
    rmSync(outcome.root, { recursive: true, force: true })
  }
})
