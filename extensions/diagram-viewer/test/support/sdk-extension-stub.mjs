// Stand-in for @github/copilot-sdk/extension so the Diagram Explorer module can
// reach its listening server. The shipped SDK (1.0.0-beta.9) does not register
// process unhandledRejection or uncaughtException handlers; this stub must not
// either. The Copilot CLI forks the extension with an empty execArgv, so the
// child keeps Node's default rejection behavior.

export function createCanvas(options) {
  return options;
}

export async function joinSession() {
  return {
    send() {},
  };
}
