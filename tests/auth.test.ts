import { describe, expect, it } from "vitest";
import { classifyAuthentication, type AuthenticationSnapshot } from "../src/auth.js";

const base: AuthenticationSnapshot = {
  url: "https://app.mysecondteacher.com.np/",
  passwordVisible: false,
  subjectsVisible: false,
  authenticatedNavigationVisible: false,
  unauthenticatedMessageVisible: false,
};

describe("classifyAuthentication", () => {
  it("requires login for a login URL or visible password form", () => {
    expect(classifyAuthentication({ ...base, url: "https://app.mysecondteacher.com.np/login" })).toBe("login-required");
    expect(classifyAuthentication({ ...base, passwordVisible: true })).toBe("login-required");
  });

  it("recognizes authenticated navigation and application paths", () => {
    expect(classifyAuthentication({ ...base, subjectsVisible: true })).toBe("authenticated");
    expect(classifyAuthentication({ ...base, authenticatedNavigationVisible: true })).toBe("authenticated");
  });

  it("does not assume an application URL is authenticated before its redirect settles", () => {
    expect(classifyAuthentication(base)).toBe("unknown");
    expect(classifyAuthentication({
      ...base,
      url: "https://app.mysecondteacher.com.np/subjects/123/chapters/456",
    })).toBe("unknown");
  });
});
