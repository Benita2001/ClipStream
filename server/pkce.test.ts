import { expect } from "chai";
import * as crypto from "crypto";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "./pkce";

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("PKCE helpers", () => {
  it("generates a base64url code verifier with no padding or unsafe characters", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).to.match(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).to.be.greaterThan(32);
  });

  it("generates a different verifier on each call", () => {
    expect(generateCodeVerifier()).to.not.equal(generateCodeVerifier());
  });

  it("computes the code challenge as base64url(sha256(verifier)), per RFC 7636 S256", () => {
    const verifier = generateCodeVerifier();
    const expected = base64url(crypto.createHash("sha256").update(verifier).digest());
    expect(generateCodeChallenge(verifier)).to.equal(expected);
  });

  it("produces a stable challenge for the same verifier", () => {
    const verifier = "fixed-test-verifier-value";
    expect(generateCodeChallenge(verifier)).to.equal(generateCodeChallenge(verifier));
  });

  it("generates a base64url state token", () => {
    const state = generateState();
    expect(state).to.match(/^[A-Za-z0-9_-]+$/);
  });
});
