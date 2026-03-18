type RollingEvent = {
  ts: number;
  key: string;
};

const MAX_ROLLING_EVENTS = 6000;
const ROLLING_WINDOW_MS = 5 * 60 * 1000;

const counters = new Map<string, number>();
const rollingEvents: RollingEvent[] = [];

const nowMs = () => Date.now();

const inc = (key: string, by = 1) => {
  const current = counters.get(key) ?? 0;
  counters.set(key, current + by);
};

const trimRolling = (now = nowMs()) => {
  while (rollingEvents.length > 0 && now - rollingEvents[0].ts > ROLLING_WINDOW_MS) {
    rollingEvents.shift();
  }
  if (rollingEvents.length > MAX_ROLLING_EVENTS) {
    rollingEvents.splice(0, rollingEvents.length - MAX_ROLLING_EVENTS);
  }
};

const pushRolling = (key: string) => {
  const ts = nowMs();
  rollingEvents.push({ ts, key });
  trimRolling(ts);
};

const track = (key: string) => {
  const normalized = String(key || "").trim();
  if (!normalized) return;
  inc(normalized, 1);
  pushRolling(normalized);
};

export const trackSocketConnected = () => {
  track("socket.connected");
};

export const trackSocketDisconnected = () => {
  track("socket.disconnected");
};

export const trackBindUserAttempt = () => {
  track("bind_user.attempt");
};

export const trackBindUserResult = (result: "ok" | "pending" | "invalid" | "error") => {
  track(`bind_user.${result}`);
};

export const trackChatEvent = (eventName: string) => {
  track(`event.${eventName}`);
};

export const trackChatAuthError = (eventName: string, code: string) => {
  const event = String(eventName || "unknown").trim() || "unknown";
  const authCode = String(code || "UNKNOWN").trim() || "UNKNOWN";
  track(`auth_error.${event}.${authCode}`);
};

export const trackChatRateLimited = (eventName: string) => {
  const event = String(eventName || "unknown").trim() || "unknown";
  track(`rate_limited.${event}`);
};

export const getChatRealtimeMetricsSnapshot = () => {
  const now = nowMs();
  trimRolling(now);

  const rollingCount = new Map<string, number>();
  for (const entry of rollingEvents) {
    const current = rollingCount.get(entry.key) ?? 0;
    rollingCount.set(entry.key, current + 1);
  }

  const sortDesc = (a: [string, number], b: [string, number]) => b[1] - a[1];
  const totals = Object.fromEntries([...counters.entries()].sort(sortDesc));
  const rollingTop = Object.fromEntries(
    [...rollingCount.entries()].sort(sortDesc).slice(0, 30)
  );

  return {
    timestamp_ms: now,
    rolling_window_ms: ROLLING_WINDOW_MS,
    totals,
    rolling_top: rollingTop,
    rolling_event_count: rollingEvents.length,
  };
};
