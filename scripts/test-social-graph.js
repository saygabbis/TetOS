import { SocialGraph } from "../src/core/social/SocialGraph.js";
import { assert, ok } from "./test-helpers.js";

const journal = [];
const social = new SocialGraph("./data/socialGraph.json", {
  journalAppend: (e) => journal.push(e)
});
social.tick({ emotion: { mood: "playful", social: 0.7 }, availability: "awake" });
const snap = social.getSnapshot();
assert(snap.relations || snap.contacts || snap, "social snapshot");
ok("test-social-graph");
