import { Router } from "express";
import { z } from "zod";
import { withDb } from "../storage/sqlite.js";
import { plaidRouter } from "./plaid.js";

// ── Schema ──
const TransactionSchema = z.object({
  amount: z.number().positive(),
  description: z.string().min(1),
  category: z.string().min(1),
  date: z.string().optional(), // ISO date string, defaults to now
  type: z.enum(["expense", "income"]).default("expense"),
  notes: z.string().optional(),
});

const UpdateTransactionSchema = TransactionSchema.partial();

export type Transaction = {
  id: string;
  amount: number;
  description: string;
  category: string;
  date: string;
  type: "expense" | "income";
  notes?: string;
  createdAt: string;
};

// ── Init table ──
async function ensureTable() {
  await withDb((db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS finance_transactions (
        id TEXT PRIMARY KEY,
        amount REAL NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        date TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'expense',
        notes TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }, { persist: true });
}

// Initialize on import
ensureTable().catch((err) => console.error("[finance-tracker] table init failed:", err));

// ── Router ──
export const financeRouter = Router();

// List transactions (with optional filters)
financeRouter.get("/transactions", async (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  const month = req.query.month as string | undefined; // YYYY-MM
  const category = req.query.category as string | undefined;
  const type = req.query.type as string | undefined;

  try {
    const results = await withDb((db) => {
      let sql = `SELECT id, amount, description, category, date, type, notes, created_at as createdAt
        FROM finance_transactions WHERE 1=1`;
      const params: any[] = [];

      if (month) {
        sql += ` AND date LIKE ?`;
        params.push(`${month}%`);
      }
      if (category) {
        sql += ` AND LOWER(category) = LOWER(?)`;
        params.push(category);
      }
      if (type) {
        sql += ` AND type = ?`;
        params.push(type);
      }

      sql += ` ORDER BY date DESC, datetime(created_at) DESC LIMIT ?`;
      params.push(limit);

      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows: Transaction[] = [];
      while (stmt.step()) {
        const r = stmt.getAsObject();
        rows.push({
          id: r.id as string,
          amount: r.amount as number,
          description: r.description as string,
          category: r.category as string,
          date: r.date as string,
          type: r.type as "expense" | "income",
          notes: (r.notes as string) || undefined,
          createdAt: r.createdAt as string,
        });
      }
      stmt.free();
      return rows;
    });
    res.json({ status: "success", data: results });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// Add transaction
financeRouter.post("/transactions", async (req, res) => {
  const parse = TransactionSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ status: "error", details: parse.error.flatten() });

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const date = parse.data.date || new Date().toISOString().slice(0, 10);

  try {
    await withDb((db) => {
      const stmt = db.prepare(
        `INSERT INTO finance_transactions (id, amount, description, category, date, type, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      stmt.run([id, parse.data.amount, parse.data.description, parse.data.category, date, parse.data.type, parse.data.notes ?? null, createdAt]);
      stmt.free();
    }, { persist: true });
    res.json({ status: "success", data: { id, ...parse.data, date, createdAt } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// Update transaction
financeRouter.put("/transactions/:id", async (req, res) => {
  const parse = UpdateTransactionSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ status: "error", details: parse.error.flatten() });

  const fields = Object.entries(parse.data).filter(([, v]) => v !== undefined);
  if (!fields.length) return res.status(400).json({ status: "error", message: "No fields to update" });

  try {
    const setClauses = fields.map(([k]) => `${k} = ?`).join(", ");
    const values = fields.map(([, v]) => v);
    values.push(req.params.id);

    await withDb((db) => {
      const stmt = db.prepare(`UPDATE finance_transactions SET ${setClauses} WHERE id = ?`);
      stmt.run(values);
      stmt.free();
    }, { persist: true });
    res.json({ status: "success", data: { id: req.params.id, updated: true } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// Delete transaction
financeRouter.delete("/transactions/:id", async (req, res) => {
  try {
    await withDb((db) => {
      const stmt = db.prepare("DELETE FROM finance_transactions WHERE id = ?");
      stmt.run([req.params.id]);
      stmt.free();
    }, { persist: true });
    res.json({ status: "success", data: { id: req.params.id, deleted: true } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// Monthly summary
financeRouter.get("/summary", async (req, res) => {
  const month = req.query.month as string | undefined; // YYYY-MM
  try {
    const data = await withDb((db) => {
      // Category breakdown
      let catSql = `SELECT category, type, SUM(amount) as total, COUNT(*) as count
        FROM finance_transactions WHERE 1=1`;
      const catParams: any[] = [];
      if (month) { catSql += ` AND date LIKE ?`; catParams.push(`${month}%`); }
      catSql += ` GROUP BY category, type ORDER BY total DESC`;

      const catStmt = db.prepare(catSql);
      catStmt.bind(catParams);
      const categories: any[] = [];
      while (catStmt.step()) { categories.push(catStmt.getAsObject()); }
      catStmt.free();

      // Monthly totals
      let totSql = `SELECT
        COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) as totalExpenses,
        COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) as totalIncome,
        COUNT(*) as transactionCount
        FROM finance_transactions WHERE 1=1`;
      const totParams: any[] = [];
      if (month) { totSql += ` AND date LIKE ?`; totParams.push(`${month}%`); }

      const totStmt = db.prepare(totSql);
      totStmt.bind(totParams);
      totStmt.step();
      const totals = totStmt.getAsObject();
      totStmt.free();

      // Monthly trend (last 12 months)
      const trendStmt = db.prepare(`
        SELECT substr(date, 1, 7) as month,
          SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) as expenses,
          SUM(CASE WHEN type='income' THEN amount ELSE 0 END) as income
        FROM finance_transactions
        GROUP BY substr(date, 1, 7)
        ORDER BY month DESC LIMIT 12
      `);
      const trend: any[] = [];
      while (trendStmt.step()) { trend.push(trendStmt.getAsObject()); }
      trendStmt.free();

      return { totals, categories, trend: trend.reverse() };
    });
    res.json({ status: "success", data });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ── Plaid Integration ──
financeRouter.use("/plaid", plaidRouter);

// Categories list
financeRouter.get("/categories", async (_req, res) => {
  try {
    const categories = await withDb((db) => {
      const stmt = db.prepare("SELECT DISTINCT category FROM finance_transactions ORDER BY category");
      const results: string[] = [];
      while (stmt.step()) { results.push(stmt.getAsObject().category as string); }
      stmt.free();
      return results;
    });
    res.json({ status: "success", data: categories });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});
