// Reminder notifications for the desktop app. The page hands over the next two weeks; a 30-second
// check fires whatever is due (timers alone drift when the PC sleeps). Missed by up to 10 minutes
// (lid closed, PC asleep) still shows; older than that is dropped.
const CATCH_UP = 10 * 60_000;

function createReminders(show) {
  let list = [];
  const fired = new Set();
  const tick = () => {
    const now = Date.now();
    for (const r of list) {
      if (r.at > now || fired.has(r.key)) continue;
      fired.add(r.key);
      if (now - r.at <= CATCH_UP) show(r);
    }
  };
  const timer = setInterval(tick, 30_000);
  return {
    set(next) {
      list = (next || []).filter(r => r && r.key && Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
      tick();
    },
    next: () => list.find(r => r.at > Date.now() && !fired.has(r.key)) || null,
    stop: () => clearInterval(timer),
    tick,
  };
}

module.exports = { createReminders, CATCH_UP };
