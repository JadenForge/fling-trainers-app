export function createTrainerLaunchGuard(active = {}, isAlive = () => false) {
  const running = new Map(Object.entries(active || {}));
  const pending = new Set();

  const current = (slug) => {
    const record = running.get(slug);
    if (!record) return null;
    if (isAlive(record.pid)) return record;
    running.delete(slug);
    return null;
  };

  return {
    claim(slug) {
      const record = current(slug);
      if (record) return { ok: false, record };
      if (pending.has(slug)) return { ok: false, pending: true };
      pending.add(slug);
      return { ok: true };
    },
    started(slug, record) {
      pending.delete(slug);
      running.set(slug, record);
    },
    forget(slug) {
      pending.delete(slug);
      running.delete(slug);
    },
    release(slug) {
      pending.delete(slug);
    },
    snapshot() {
      for (const slug of running.keys()) current(slug);
      return Object.fromEntries(running);
    },
  };
}
