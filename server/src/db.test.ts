import { beforeEach, describe, expect, it } from "vitest";
import { inChunks, marks, type DB } from "./db.js";
import { toPostgresPlaceholders } from "./db-postgres.js";
import { countWhere, displayName, epoch, likeCI, localDay } from "./dialect.js";
import { backend, testDb } from "./test-db.js";

let db: DB;
beforeEach(async () => {
  db = await testDb();
});

const user = (email = "a@example.com", name: string | null = null) =>
  db.insert("INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)", email, "hash", name);

describe(`database layer (${backend})`, () => {
  it("runs against the backend this run was started for", () => {
    expect(db.dialect).toBe(backend === "sqlite" ? "sqlite" : "postgres");
  });

  it("hands back plain numbers for ids, counts and sums, and a missing row as undefined", async () => {
    const id = await user();
    expect(typeof id).toBe("number");
    const row = await db.get<{ n: unknown; s: unknown }>("SELECT COUNT(*) AS n, COALESCE(SUM(id), 0) AS s FROM users");
    expect(row).toEqual({ n: 1, s: id });
    expect(await db.get("SELECT * FROM users WHERE id = ?", 999)).toBeUndefined();
    expect(await db.all("SELECT * FROM users WHERE id = ?", 999)).toEqual([]);
  });

  it("reports how many rows a statement changed", async () => {
    await user("a@example.com");
    await user("b@example.com");
    expect((await db.run("UPDATE users SET name = ?", "x")).changes).toBe(2);
    expect((await db.run("UPDATE users SET name = ? WHERE email = ?", "y", "nobody")).changes).toBe(0);
    // ON CONFLICT DO NOTHING counts only rows that were actually inserted
    const uid = await user("c@example.com");
    expect((await db.run("INSERT INTO tags (user_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING", uid, "t")).changes).toBe(1);
    expect((await db.run("INSERT INTO tags (user_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING", uid, "t")).changes).toBe(0);
  });

  it("enforces constraints and foreign keys identically", async () => {
    await user("a@example.com");
    await expect(user("a@example.com")).rejects.toThrow(/unique|duplicate/i);
    await expect(db.insert("INSERT INTO tags (user_id, name) VALUES (?, ?)", 424242, "orphan")).rejects.toThrow(/foreign key|constraint/i);
    const uid = await user("b@example.com");
    await expect(db.insert("INSERT INTO tasks (user_id, title, priority) VALUES (?, ?, ?)", uid, "t", 9)).rejects.toThrow(/check|constraint/i);
  });

  it("cascades deletes", async () => {
    const uid = await user();
    const tid = await db.insert("INSERT INTO tasks (user_id, title) VALUES (?, ?)", uid, "t");
    await db.run("INSERT INTO checklist_items (task_id, text) VALUES (?, ?)", tid, "item");
    await db.run("DELETE FROM users WHERE id = ?", uid);
    expect(await db.get("SELECT COUNT(*) AS n FROM tasks")).toEqual({ n: 0 });
    expect(await db.get("SELECT COUNT(*) AS n FROM checklist_items")).toEqual({ n: 0 });
  });

  it("uses a consistent text format for default timestamps", async () => {
    const uid = await user();
    const tid = await db.insert("INSERT INTO tasks (user_id, title) VALUES (?, ?)", uid, "t");
    const task = (await db.get<{ created_at: string }>("SELECT created_at FROM tasks WHERE id = ?", tid))!;
    expect(task.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const cid = await db.insert("INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)", tid, uid, "hi");
    const comment = (await db.get<{ created_at: string }>("SELECT created_at FROM comments WHERE id = ?", cid))!;
    expect(comment.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(comment.created_at) - Date.now())).toBeLessThan(60_000); // really UTC "now"
  });

  describe("transactions", () => {
    it("commits everything together, or nothing", async () => {
      const uid = await user();
      await db.tx(async (t) => {
        await t.run("INSERT INTO tags (user_id, name) VALUES (?, ?)", uid, "kept");
        await t.run("INSERT INTO tags (user_id, name) VALUES (?, ?)", uid, "also kept");
      });
      await expect(
        db.tx(async (t) => {
          await t.run("INSERT INTO tags (user_id, name) VALUES (?, ?)", uid, "discarded");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await expect(
        db.tx(async (t) => {
          await t.run("INSERT INTO tags (user_id, name) VALUES (?, ?)", uid, "discarded too");
          await t.run("INSERT INTO tags (user_id, name) VALUES (?, ?)", uid, "kept"); // violates UNIQUE: aborts the whole thing
        }),
      ).rejects.toThrow();
      expect((await db.all<{ name: string }>("SELECT name FROM tags ORDER BY name")).map((r) => r.name)).toEqual(["also kept", "kept"]);
    });

    it("sees its own writes, and returns the callback's value", async () => {
      const uid = await user();
      const seen = await db.tx(async (t) => {
        await t.run("INSERT INTO tags (user_id, name) VALUES (?, ?)", uid, "mine");
        return (await t.get<{ n: number }>("SELECT COUNT(*) AS n FROM tags"))!.n;
      });
      expect(seen).toBe(1);
    });

    it("never lets other work see half a transaction", async () => {
      const uid = await user();
      const writer = db.tx(async (t) => {
        await t.run("INSERT INTO tags (user_id, name) VALUES (?, ?)", uid, "a");
        await Promise.resolve();
        await t.run("INSERT INTO tags (user_id, name) VALUES (?, ?)", uid, "b");
      });
      const reader = db.all("SELECT name FROM tags"); // started while the transaction is open
      const [, rows] = await Promise.all([writer, reader]);
      expect([0, 2]).toContain(rows.length);
    });

    it("keeps concurrent transactions separate", async () => {
      const uid = await user();
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          db
            .tx(async (t) => {
              await t.run("INSERT INTO tags (user_id, name) VALUES (?, ?)", uid, `t${n}`);
              if (n % 2 === 0) throw new Error(`rollback ${n}`);
              return n;
            })
            .catch((e: Error) => e.message),
        ),
      );
      expect(results).toEqual([1, "rollback 2", 3, "rollback 4", 5]);
      expect((await db.all<{ name: string }>("SELECT name FROM tags ORDER BY name")).map((r) => r.name)).toEqual(["t1", "t3", "t5"]);
    });
  });

  describe("SQL helpers give the same answer on both databases", () => {
    const one = async <T>(sql: string, ...params: unknown[]) => (await db.get<T>(sql, ...params))!;

    it("epoch(): seconds as a float", async () => {
      const r = await one<{ secs: unknown }>(
        `SELECT ${epoch(db.dialect, "'2026-03-04T10:30:00.000Z'")} - ${epoch(db.dialect, "'2026-03-04T10:00:00.000Z'")} AS secs`,
      );
      expect(r.secs).toBe(1800);
      expect(typeof r.secs).toBe("number");
    });

    it("localDay(): the calendar day on someone's clock", async () => {
      const day = async (offset: number) => (await one<{ d: string }>(`SELECT ${localDay(db.dialect, "'2026-03-04T23:30:00.000Z'")} AS d`, offset)).d;
      expect(await day(0)).toBe("2026-03-04");
      expect(await day(180)).toBe("2026-03-05"); // UTC+3
      expect(await day(-300)).toBe("2026-03-04"); // UTC-5
      expect(await day(-1439)).toBe("2026-03-03");
    });

    it("displayName(): chosen name, else the part of the email before the @", async () => {
      await user("gina.park@example.com", null);
      await user("b@example.com", "  ");
      await user("c@example.com", "Cara C.");
      const rows = await db.all<{ n: string }>(`SELECT ${displayName(db.dialect, "u")} AS n FROM users u ORDER BY u.id`);
      expect(rows.map((r) => r.n)).toEqual(["gina.park", "b", "Cara C."]);
    });

    it("countWhere() and likeCI()", async () => {
      const uid = await user();
      for (const [title, status] of [["Buy MILK", "done"], ["buy bread", "todo"], ["Walk", "done"]]) {
        await db.run("INSERT INTO tasks (user_id, title, status) VALUES (?, ?, ?)", uid, title, status);
      }
      expect(await one("SELECT " + countWhere("status = 'done'") + " AS n FROM tasks")).toEqual({ n: 2 });
      expect(await one("SELECT " + countWhere("status = 'nope'") + " AS n FROM tasks")).toEqual({ n: 0 });
      const found = await db.all<{ title: string }>(`SELECT title FROM tasks WHERE ${likeCI("title")} ORDER BY id`, "%BUY%");
      expect(found.map((r) => r.title)).toEqual(["Buy MILK", "buy bread"]);
    });
  });

  describe("recursive queries and typed parameters", () => {
    it("walks a task tree upward and downward with casted parameters", async () => {
      const uid = await user();
      const a = await db.insert("INSERT INTO tasks (user_id, title) VALUES (?, ?)", uid, "a");
      const b = await db.insert("INSERT INTO tasks (user_id, title, parent_id) VALUES (?, ?, ?)", uid, "b", a);
      const c = await db.insert("INSERT INTO tasks (user_id, title, parent_id) VALUES (?, ?, ?)", uid, "c", b);
      const ancestors = await db.all<{ id: number }>(
        `WITH RECURSIVE anc(id) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT t.parent_id FROM tasks t JOIN anc ON t.id = anc.id WHERE t.parent_id IS NOT NULL)
         SELECT id FROM anc ORDER BY id`,
        c,
      );
      expect(ancestors.map((r) => r.id)).toEqual([a, b, c]);
      const below = await db.all<{ root: number; total: number }>(
        `WITH RECURSIVE d(root, id) AS (SELECT parent_id, id FROM tasks WHERE parent_id IN (?) UNION ALL SELECT d.root, t.id FROM tasks t JOIN d ON t.parent_id = d.id)
         SELECT root, COUNT(*) AS total FROM d GROUP BY root`,
        a,
      );
      expect(below).toEqual([{ root: a, total: 2 }]);
    });
  });
});

describe("placeholder conversion", () => {
  it("numbers ? placeholders and leaves quoted text alone", () => {
    expect(toPostgresPlaceholders("SELECT * FROM t WHERE a = ? AND b IN (?, ?)")).toBe("SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)");
    expect(toPostgresPlaceholders("SELECT 'what?' AS q, ? AS x")).toBe("SELECT 'what?' AS q, $1 AS x");
    expect(toPostgresPlaceholders(`SELECT 'it''s ? fine', ?`)).toBe(`SELECT 'it''s ? fine', $1`);
    expect(toPostgresPlaceholders('SELECT "a?b", ?')).toBe('SELECT "a?b", $1');
    expect(toPostgresPlaceholders("SELECT 1")).toBe("SELECT 1");
  });
});

describe("IN-list helpers", () => {
  it("builds placeholders and splits long lists", async () => {
    expect(marks(3)).toBe("?,?,?");
    expect(marks(0)).toBe("");
    const seen: number[] = [];
    const out = await inChunks(Array.from({ length: 1000 }, (_, i) => i), async (m, ids) => {
      seen.push(ids.length);
      expect(m.split(",").length).toBe(ids.length);
      return ids as number[];
    });
    expect(seen).toEqual([400, 400, 200]);
    expect(out).toHaveLength(1000);
    expect(await inChunks([], async () => [1])).toEqual([]);
  });
});
