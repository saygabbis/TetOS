import "dotenv/config";
import { createRuntime } from "../src/app/createRuntime.js";
import { isUserRecentlyActive, linkedUserIds, touchUserActivity } from "../src/core/channels/userActivity.js";
import { assert, ok } from "./test-helpers.js";

const runtime = createRuntime();
const lid = "157947506229421";
const phone = runtime.defaults.learningTargetUserId || "5516988137617";

const linked = linkedUserIds(runtime, lid);
assert(linked.includes(phone), "LID links to learning target phone");

touchUserActivity(runtime, lid);
assert(isUserRecentlyActive(runtime, phone, 600000), "phone marked active when LID chats");
assert(isUserRecentlyActive(runtime, lid, 600000), "LID marked active");

ok("test-user-activity");
