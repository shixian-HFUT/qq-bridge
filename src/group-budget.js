// Admission is rebuilt from real reservations; restarting cannot refill a bucket.
const HOUR = 3600000;
export function directedGroupWake(reason) {
  return /^(?:atMention|nameMention|keyword|question|poke|speaker)(?::|$)/.test(String(reason));
}

export function groupBudgetPolicy(config = {}) {
  const hourly = Number(config.maxSendPerHour) || 0;
  // 0 = 不设上限：ambient 也必须一起放开，否则“0 = 不限”会被悄悄限成 24/小时。
  const unlimited = !(hourly > 0);
  const ambientHourly = unlimited ? 0 : Math.max(1, Math.round(hourly * 0.6));
  return { hourly, ambientHourly,
    ambientTenMinutes: ambientHourly > 0 ? Math.max(1, Math.round(ambientHourly / 6)) : 0,
    burst: hourly > 0 ? Math.max(4, Math.round(hourly / 10)) : 0,
    ambientBurst: ambientHourly > 0 ? Math.max(2, Math.ceil(ambientHourly / 12)) : 0 };
}

function recentTimes(times, now) {
  return (times || []).filter(t => Number.isFinite(t) && t > now - HOUR).sort((a, b) => a - b);
}

function tokenBalance(times, capacity, perHour, now) {
  let balance = capacity, previous = now - HOUR;
  for (const time of times) {
    balance = Math.min(capacity, balance + Math.max(0, time - previous) * perHour / HOUR);
    // Keep old hourly charges without adding debt for legacy bursts.
    balance = Math.max(0, balance - 1);
    previous = Math.max(previous, time);
  }
  return Math.min(capacity, balance + Math.max(0, now - previous) * perHour / HOUR);
}

function admission(now, count, priority) {
  let remaining = Infinity, retryAt = now;
  return {
    window(times, ms, cap) {
      if (!(cap > 0)) return;
      const active = times.filter(t => t > now - ms);
      remaining = Math.min(remaining, Math.max(0, cap - active.length));
      if (active.length + count > cap) retryAt = Math.max(retryAt,
        count > cap ? now + ms : active[active.length + count - cap - 1] + ms);
    },
    bucket(times, capacity, perHour, reserve = 0) {
      if (!(perHour > 0)) return;
      const balance = tokenBalance(times, capacity, perHour, now);
      const usable = Math.max(0, Math.floor(balance - reserve + 1e-9));
      remaining = Math.min(remaining, usable);
      if (usable < count) retryAt = Math.max(retryAt, count + reserve > capacity
        ? now + HOUR : now + Math.ceil((count + reserve - balance) * HOUR / perHour));
    },
    result() {
      return { ok: remaining >= count, remaining: Number.isFinite(remaining) ? remaining : null,
        retryAt: remaining >= count ? null : retryAt, priority };
    }
  };
}

export function groupSendBudget(key, st, config = {}, count = 1, now = Date.now(), reason = st?.lastWakeReason) {
  const times = recentTimes(st?.sendTimes, now), directed = directedGroupWake(reason);
  const budget = admission(now, count, directed ? 'direct' : 'ambient');
  const { hourly, ambientHourly, ambientTenMinutes, burst, ambientBurst } = groupBudgetPolicy(config);
  budget.window(times, 60000, Number(config.maxSendPerMinute) || 0);
  budget.window(times, HOUR, hourly);
  if (String(key).startsWith('group:')) {
    // Small bursts scale with the hourly allowance; reserve two for direct replies.
    budget.bucket(times, burst, hourly, directed ? 0 : 2);
    if (!directed) {
      budget.window(times, 600000, ambientTenMinutes);
      budget.window(times, HOUR, ambientHourly);
      budget.bucket(times, ambientBurst, ambientHourly);
    }
  }
  return budget.result();
}

export function groupWakeBudget(st, config = {}, now = Date.now(), reason = st?.lastWakeReason) {
  const times = recentTimes(st?.wakeTimes, now), directed = directedGroupWake(reason);
  const budget = admission(now, 1, directed ? 'direct' : 'ambient');
  const hourly = Number(config.maxWakePerHour) || 0;
  budget.window(times, 60000, Number(config.maxWakePerMinute) || 0);
  budget.window(times, HOUR, hourly);
  // Pace unsolicited participation. Explicit calls can use the available
  // hourly allowance immediately, while the same minute/hour caps still apply.
  if (!directed) budget.bucket(times, 2, hourly);
  return budget.result();
}

export function quotaFailure(budget) {
  return { ok: false, code: 'SEND_RATE_LIMIT', error: '发送频率超限，本轮结束；等待本地调度，不要重试或补发。',
    unknown: false, retryable: false, sent: 0, remaining: budget.remaining, retryAt: budget.retryAt, priority: budget.priority };
}
