import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const extensionUrl = new URL('../../extensions/sentry-triage/extension.mjs', import.meta.url).href
const attack = process.env.SENTRY_TRIAGE_ATTACK_CWD
const marker = process.env.SENTRY_TRIAGE_GIT_MARKER
const trusted = process.env.SENTRY_TRIAGE_TRUSTED_DIR
const which = process.env.SENTRY_TRIAGE_CASE

function plantedLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('PLANTED-'))
}

function readMarker() {
  try {
    return readFileSync(marker, 'utf8')
  } catch {
    return ''
  }
}

function writeBatch(name, body) {
  writeFileSync(join(attack, name), body.replace(/\n/g, '\r\n'), 'utf8')
}

function plant() {
  mkdirSync(attack, { recursive: true })
  const log = `echo PLANTED-${which.toUpperCase()} %*>>"%SENTRY_TRIAGE_GIT_MARKER%"\n`
  if (which === 'cmd' || which === 'open') {
    writeBatch('git.cmd', `@echo off\n${log}echo https://github.com/planted/repo.git\n`)
  } else if (which === 'bat') {
    writeBatch('git.bat', `@echo off\n${log}echo https://github.com/planted/repo.git\n`)
  } else if (which === 'exe') {
    copyFileSync(join(here, 'fixtures', 'planted-git.exe'), join(attack, 'git.exe'))
  } else if (which === 'nonzero') {
    writeBatch('git.cmd', `@echo off\n${log}exit /b 1\n`)
  } else if (which === 'hang') {
    writeBatch('git.cmd', `@echo off\n${log}:loop\ngoto loop\n`)
  } else {
    throw new Error(`unknown case ${which}`)
  }
}

const listen = http.Server.prototype.listen
http.Server.prototype.listen = function listenAndUnref(...args) {
  const server = listen.apply(this, args)
  this.unref()
  return server
}

plant()
process.env.PATH = trusted
process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
delete process.env.GITHUB_REPOSITORY
delete process.env.GITHUB_BASE_REF
delete process.env.GITHUB_SERVER_URL
delete process.env.NoDefaultCurrentDirectoryInExePath

const before = readMarker()
await import(extensionUrl)
const afterLoad = readMarker()
const loadLines = plantedLines(afterLoad.slice(before.length))

let openError = null
const canvases = globalThis.__sentryTriageCanvases || []
if (which !== 'hang') {
  if (!canvases[0] || typeof canvases[0].open !== 'function') {
    console.error('extension did not register a canvas open handler')
    process.exit(1)
  }
  try {
    await canvases[0].open({ instanceId: `case-${which}` })
  } catch (err) {
    openError = err instanceof Error ? err.message : String(err)
  }
}
const afterOpen = readMarker()
const openLines = plantedLines(afterOpen.slice(afterLoad.length))

const problems = []
if (loadLines.length) problems.push(`load ran planted git:\n${loadLines.join('\n')}`)
if (openLines.length) problems.push(`canvas open ran planted git:\n${openLines.join('\n')}`)
if (problems.length) {
  if (openError) problems.push(`canvas open also threw: ${openError}`)
  console.error(problems.join('\n'))
  process.exit(1)
}
process.exit(0)
