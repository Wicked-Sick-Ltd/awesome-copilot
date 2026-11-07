import assert from "node:assert/strict";
import test from "node:test";

import { isPartnerCenterUrl } from "./partner-center-url.mjs";

test("partner center urls match the hostname exactly or as a subdomain", () => {
  for (const url of [
    "https://partner.microsoft.com/dashboard",
    "https://partner.microsoft.com/",
    "http://storedeveloper.microsoft.com/path?q=1",
    "https://www.partner.microsoft.com/en-US/dashboard",
    "https://foo.storedeveloper.microsoft.com/x",
    "https://PARTNER.MICROSOFT.COM/dashboard",
    "https://user:secret@partner.microsoft.com/dashboard",
    "https://partner.microsoft.com:443/dashboard",
  ]) {
    assert.equal(isPartnerCenterUrl(url), true, url);
  }
});

test("partner center urls reject lookalikes and host text outside the hostname", () => {
  for (const url of [
    "https://evil.example/?next=https://partner.microsoft.com",
    "https://evil.example/partner.microsoft.com",
    "https://partner.microsoft.com.evil.example/",
    "https://notpartner.microsoft.com/",
    "https://storedeveloper.microsoft.com.evil.example/",
    "https://evil.example/#partner.microsoft.com",
    "not a url",
    "",
  ]) {
    assert.equal(isPartnerCenterUrl(url), false, url);
  }
});
