import { describe, expect, it } from "vitest";
import { dmJidForLocalId, isBogusLidJid, resolveNudgeRemoteJid } from "../../src/core/channels/userActivity.js";
import { repairProfileContamination } from "../../src/core/channels/botIdentity.js";

const defaults = { learningTargetUserId: "5516988137617", ownerWaJids: ["157947506229421@lid"], botWaPhone: "6283879987068" };
const runtimeWith = (profiles = {}) => ({
  defaults,
  longTerm: { data: { profiles }, getProfile: (id) => profiles[id] ?? { facts: {} }, persist() {} }
});

describe("JID de PV para iniciativa/lembretes", () => {
  it("telefone nunca vira @lid (bug: dm-<tel> → <tel>@lid)", () => {
    expect(isBogusLidJid("5516988137617@lid")).toBe(true);
    expect(isBogusLidJid("157947506229421@lid")).toBe(false);
    expect(dmJidForLocalId("dm-5511900000001")).toBe("5511900000001@s.whatsapp.net");
    expect(dmJidForLocalId("dm-190546341540031")).toBe("190546341540031@lid");
  });

  it("todos os ids da dona apontam para o JID configurado", () => {
    const rt = runtimeWith();
    for (const id of ["dm-5516988137617", "5516988137617", "dm-157947506229421", "157947506229421"]) {
      expect(resolveNudgeRemoteJid(rt, id)).toBe("157947506229421@lid");
    }
  });

  it("usa a última sessão de PV vista quando existe", () => {
    const rt = runtimeWith({ "dm-190546341540031": { facts: { lastDmSessionId: "wa-dm:190546341540031@lid" } } });
    expect(resolveNudgeRemoteJid(rt, "dm-190546341540031")).toBe("190546341540031@lid");
  });

  it("reparo corrige perfil da dona contaminado com telefone como LID", () => {
    const profiles = {
      "dm-5516988137617": { facts: { waLid: "5516988137617", waPhone: "5516988137617", waRemoteJid: "5516988137617@lid" } },
      "5511900000001": { facts: { waLid: "5511900000001", waRemoteJid: "5511900000001@lid" } }
    };
    repairProfileContamination(runtimeWith(profiles));
    expect(profiles["dm-5516988137617"].facts).toMatchObject({ waLid: "157947506229421", waRemoteJid: "157947506229421@lid", waPhone: "5516988137617" });
    expect(profiles["5511900000001"].facts.waLid).toBeUndefined();
    expect(profiles["5511900000001"].facts.waPhone).toBe("5511900000001");
    expect(profiles["5511900000001"].facts.waRemoteJid).toBe("5511900000001@s.whatsapp.net");
  });
});
