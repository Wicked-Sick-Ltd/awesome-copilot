const INTERNAL_ERROR_MESSAGE = "Unexpected server error.";

/**
 * Serialize data for an executable inline script without allowing the JSON to
 * terminate the script element or introduce JavaScript line separators.
 */
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Return a fixed client-facing message for unexpected exceptions. Keep the
 * original exception in server-side logs; never serialize it into a response.
 */
export function internalErrorMessage() {
  return INTERNAL_ERROR_MESSAGE;
}

/**
 * Build a safe response for extensions whose domain errors do not have a
 * dedicated public error type. Error codes and statuses are constrained while
 * exception messages and stack traces remain server-side only.
 */
export function publicErrorResponse(error, fallbackCode = "request_failed") {
  const hasPublicCode =
    typeof error?.code === "string" && /^[a-z0-9_]{1,64}$/.test(error.code);
  const code = hasPublicCode ? error.code : fallbackCode;
  const statusCode =
    Number.isInteger(error?.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode < 600
      ? error.statusCode
      : hasPublicCode
        ? 400
        : 500;

  return {
    statusCode,
    body: {
      code,
      message:
        statusCode >= 500 && !hasPublicCode
          ? INTERNAL_ERROR_MESSAGE
          : "Request rejected.",
    },
  };
}
