export class Scheduler {
  constructor() {
    this.jobs = [];
  }

  schedule({ name, intervalMs, handler }) {
    this.jobs.push({ name, intervalMs, handler, active: false });
  }

  list() {
    return this.jobs.map(({ name, intervalMs, active }) => ({
      name,
      intervalMs,
      active
    }));
  }
}
