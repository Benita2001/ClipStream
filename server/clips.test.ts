import { expect } from "chai";
import { extractTweetId } from "./clips";

describe("extractTweetId (pure)", () => {
  it("extracts the id from a twitter.com status URL", () => {
    expect(extractTweetId("https://twitter.com/someuser/status/1234567890123456789")).to.equal(
      "1234567890123456789"
    );
  });

  it("extracts the id from an x.com status URL", () => {
    expect(extractTweetId("https://x.com/someuser/status/1234567890123456789")).to.equal("1234567890123456789");
  });

  it("extracts the id with query params/trailing content", () => {
    expect(extractTweetId("https://x.com/someuser/status/1234567890123456789?s=20")).to.equal(
      "1234567890123456789"
    );
  });

  it("handles the /statuses/ plural form", () => {
    expect(extractTweetId("https://x.com/someuser/statuses/1234567890123456789")).to.equal(
      "1234567890123456789"
    );
  });

  it("returns null for a non-tweet URL", () => {
    expect(extractTweetId("https://example.com/not-a-tweet")).to.equal(null);
  });

  it("returns null for a profile URL with no status", () => {
    expect(extractTweetId("https://x.com/someuser")).to.equal(null);
  });
});
