import cron from "node-cron";
import type { Queryable } from "./db.js";

/** Marks every open task whose reminder time has passed as fired. Returns the number fired. */
export async function fireDueReminders(db: Queryable, now = new Date()): Promise<number> {
  const info = await db.run(
    `UPDATE tasks SET reminded_at = ?
     WHERE remind_at IS NOT NULL AND remind_at <= ? AND reminded_at IS NULL AND status != 'done'`,
    now.toISOString(),
    now.toISOString(),
  );
  return info.changes;
}

/**
 * Checks every minute. Safe with several server instances sharing one database: marking a reminder as fired is a single
 * conditional UPDATE, so each reminder fires once however many instances run this.
 */
export function startReminderJob(db: Queryable) {
  return cron.schedule("* * * * *", () => {
    fireDueReminders(db).catch((e) => console.error("Reminder check failed:", e instanceof Error ? e.message : e));
  });
}
