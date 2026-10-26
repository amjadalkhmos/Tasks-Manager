import cron from "node-cron";
import type { DB } from "./db.js";

/** Marks every open task whose reminder time has passed as fired. Returns the number fired. */
export function fireDueReminders(db: DB, now = new Date()): number {
  const info = db
    .prepare(
      `UPDATE tasks SET reminded_at = ?
       WHERE remind_at IS NOT NULL AND remind_at <= ? AND reminded_at IS NULL AND status != 'done'`,
    )
    .run(now.toISOString(), now.toISOString());
  return info.changes;
}

export function startReminderJob(db: DB) {
  return cron.schedule("* * * * *", () => fireDueReminders(db));
}
