import { TrustIntimacySystem } from "../src/core/social/TrustIntimacySystem.js";

const trust = new TrustIntimacySystem("./data/trustBonds.json");
trust.recordInteraction({ userId: "u1", channelScope: "direct", message: "te conto um segredo", isVulnerable: true });
const bond = trust.getBond("u1", "direct");
console.assert(bond.trust >= 0.45, "bond exists");
console.log("test-trust-intimacy OK", bond);
