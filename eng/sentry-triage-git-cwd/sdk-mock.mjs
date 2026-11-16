const canvases = []

export async function joinSession() {
  return {
    abort() {},
    rpc: {
      metadata: {
        async snapshot() {
          return { workingDirectory: process.env.SENTRY_TRIAGE_ATTACK_CWD }
        },
      },
      model: {
        async list() {
          return { list: [] }
        },
      },
    },
  }
}

export function createCanvas(definition) {
  canvases.push(definition)
  globalThis.__sentryTriageCanvases = canvases
  return definition
}
