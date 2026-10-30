// Host scheduling only. The organizer owns persistent candidates, transactions
// and the shared learning budget. This timer never sends QQ messages.
export class MemoryOrganizerRuntime {
  constructor({ organizer, admit, isIdle = () => true, shared = () => false, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, quietMs = 60000, intervalMs = 30000,
    onReport = () => {} }) {
    this.organizer = organizer; this.admit = admit; this.isIdle = isIdle; this.shared = shared;
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.quietMs = quietMs; this.intervalMs = intervalMs; this.onReport = onReport;
    this.arrivals = new Map(); this.firstQueued = new Map(); this.busy = false; this.stopped = false; this.timer = null;
    this.abort = null;
  }
  start() { if (!this.stopped && !this.timer) this.schedule(this.quietMs); }
  schedule(delay) {
    if (this.stopped) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.tick().catch(() => {}).finally(() => this.schedule(this.intervalMs));
    }, delay);
    this.timer?.unref?.();
  }
  onArchive(key, record) {
    if (this.stopped || !record?.id || record.pending || !this.admit(key)) return;
    const result = this.organizer.enqueue({ key, sourceId: record.id });
    if (result?.queued) {
      this.arrivals.set(key, this.now());
      if (!this.firstQueued.has(key)) this.firstQueued.set(key, this.now());
    }
    return result;
  }
  hasPending() { return this.organizer.pendingKeys().some(key => this.admit(key)); }
  async tick() {
    if (this.stopped || this.busy || !this.isIdle()) return { status: 'busy' };
    const key = this.organizer.pendingKeys().find(key => this.admit(key)
      && (this.now() - (this.arrivals.get(key) || 0) >= this.quietMs
        || this.now() - (this.firstQueued.get(key) || this.now()) >= 300000));
    return key ? this.run(key) : { status: 'idle' };
  }
  async run(key, { force = false } = {}) {
    if (this.stopped || this.busy || !this.isIdle() || !this.admit(key)) return { status: 'busy_or_denied' };
    this.busy = true; this.abort = new AbortController();
    try {
      const result = await this.organizer.run(key, { force, shared: this.shared(key), signal: this.abort.signal });
      if (!this.organizer.pendingKeys().includes(key)) { this.arrivals.delete(key); this.firstQueued.delete(key); }
      try { this.onReport(result); } catch {}
      return result;
    } finally { this.busy = false; this.abort = null; }
  }
  status() { return { running: this.busy, enabled: !this.stopped, quietMs: this.quietMs, ...this.organizer.status() }; }
  stop() {
    this.stopped = true; this.abort?.abort();
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}
