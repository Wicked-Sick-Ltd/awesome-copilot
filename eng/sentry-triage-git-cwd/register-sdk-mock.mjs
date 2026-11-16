import { registerHooks } from 'node:module'

const mockUrl = new URL('./sdk-mock.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@github/copilot-sdk/extension') {
      return { url: mockUrl, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
