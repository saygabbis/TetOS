import { describe, expect, it } from "vitest";
import { getSessionTokenFromEnv } from "../../src/infra/api/auth/sessionAuth.js";

describe("uiGateway auth", () => {
  it("expõe token de sessão padrão em dev", () => {
    expect(getSessionTokenFromEnv()).toBeTruthy();
  });
});
