export function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

export function ok(name) {
  console.log(`${name} OK`);
}
