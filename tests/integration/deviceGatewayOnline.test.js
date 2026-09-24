import { describe, expect, it } from "vitest";
import { DeviceGateway } from "../../src/integrations/automate/deviceGateway.js";

describe("DeviceGateway.isDeviceConnected", () => {
  it("retorna false sem sessão ativa", () => {
    const uiBus = { on() {}, publish() {} };
    const gateway = new DeviceGateway({ deviceRegistry: {}, uiBus });
    expect(gateway.isDeviceConnected("default-device")).toBe(false);
  });
});
