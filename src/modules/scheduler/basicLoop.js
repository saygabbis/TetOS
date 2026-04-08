export class BasicLoop {
  constructor({ inactiveMs = 120000, chance = 0.15 } = {}) {
    this.inactiveMs = inactiveMs;
    this.chance = chance;
    this.lastInteraction = Date.now();
  }

  touch() {
    this.lastInteraction = Date.now();
  }

  maybeNudge() {
    const now = Date.now();
    if (now - this.lastInteraction < this.inactiveMs) {
      return null;
    }

    if (Math.random() > this.chance) {
      return null;
    }

    const options = ["sumiu", "tá aí?", "hm", "oi?", "cadê você?"];
    return options[Math.floor(Math.random() * options.length)];
  }
}
