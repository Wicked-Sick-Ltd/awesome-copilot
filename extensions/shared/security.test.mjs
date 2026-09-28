import assert from "node:assert/strict";
import test from "node:test";

import {
  internalErrorMessage,
  jsonForScript,
  publicErrorResponse,
} from "./security.mjs";

test("jsonForScript neutralizes inline-script terminators and separators", () => {
  const serialized = jsonForScript("</script>\u2028\u2029");

  assert.equal(serialized, '"\\u003c/script\\u003e\\u2028\\u2029"');
  assert.doesNotMatch(serialized, /<\/script>/i);
});

test("unexpected exceptions produce a fixed public response", () => {
  const error = new Error("secret detail");
  error.stack = "secret stack";

  assert.deepEqual(publicErrorResponse(error), {
    statusCode: 500,
    body: {
      code: "request_failed",
      message: internalErrorMessage(),
    },
  });
});

test("coded domain errors retain constrained metadata without their message", () => {
  const error = new Error("private path");
  error.code = "invalid_path";
  error.statusCode = 422;

  assert.deepEqual(publicErrorResponse(error), {
    statusCode: 422,
    body: {
      code: "invalid_path",
      message: "Request rejected.",
    },
  });
});
