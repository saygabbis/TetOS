import { MediaLearningHub } from "../src/core/media/MediaLearningHub.js";
import { assert, ok } from "./test-helpers.js";

const hub = new MediaLearningHub("./data/test-media-learning.json");
const learned = hub.learnFromMedia({ type: "sticker", hash: "test-hash", caption: "coração" }, { userId: "u1" });
assert(learned?.type === "sticker" || learned?.learnedAt, "media learned");
assert(hub.data.mediaTypes.sticker >= 1, "sticker count incremented");
ok("test-media-learning");
