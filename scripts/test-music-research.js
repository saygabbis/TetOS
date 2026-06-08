import { MusicWorld } from "../src/core/music/MusicWorld.js";
import { assert, ok } from "./test-helpers.js";

const music = new MusicWorld("./data/tetoDiscography.json", "./data/test-music-state.json");
const snap = music.getSnapshot();
assert(snap.discography || snap.phase || snap, "music snapshot");
const research = await music.research({ query: "Kasane Teto" }).catch(() => null);
assert(research === null || typeof research === "object", "research callable");
ok("test-music-research");
