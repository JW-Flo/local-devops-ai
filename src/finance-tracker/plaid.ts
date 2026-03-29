import { Router } from "express";
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} from "plaid";
import { withDb } from "../storage/sqlite.js";

// ── Plaid Client Setup ──
const plaidEnv = (process.env.PLAID_ENV || "sandbox") as keyof typeof PlaidEnvironments;
const configuration = new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
      "PLAID-SECRET": process.env.PLAID_SECRET || "",
    },
  },
});
const plaidClient = new PlaidApi(configuration);

// ── Persistent storage for access tokens + cursors ──
async function ensurePlaidTables() {
  await withDb((db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plaid_items (
        item_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        institution_name TEXT,
        cursor TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }, { persist: true });
}
ensurePlaidTables().catch(console.error);

// ── Category Mapping: Plaid → Local ──
const PLAID_CATEGORY_MAP: Record<string, string> = {
  INCOME: "Other",
  TRANSFER_IN: "Other",
  TRANSFER_OUT: "Other",
  LOAN_PAYMENTS: "Housing",
  BANK_FEES: "Other",
  ENTERTAINMENT: "Entertainment",
  FOOD_AND_DRINK: "Food & Dining",
  GENERAL_MERCHANDISE: "Shopping",
  HOME_IMPROVEMENT: "Housing",
  MEDICAL: "Healthcare",
  PERSONAL_CARE: "Personal Care",
  GENERAL_SERVICES: "Other",
  GOVERNMENT_AND_NON_PROFIT: "Other",
  TRANSPORTATION: "Transportation",
  TRAVEL: "Transportation",
  RENT_AND_UTILITIES: "Utilities",
  RECREATION: "Entertainment",
  EDUCATION: "Education",
};

function mapPlaidCategory(primary: string | null | undefined): string {
  if (!primary) return "Other";
  return PLAID_CATEGORY_MAP[primary] || "Other";
}

function mapPlaidType(amount: number): "expense" | "income" {
  // Plaid: positive = money leaving account (expense), negative = money coming in (income)
  return amount > 0 ? "expense" : "income";
}

// ── Router ──
export const plaidRouter = Router();

// 1. Create Link Token (frontend calls this to open Plaid Link)
plaidRouter.post("/link-token", async (_req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: "local-finance-user" },
      client_name: "Local Finance Tracker",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    res.json({ status: "success", data: { link_token: response.data.link_token } });
  } catch (err: any) {
    console.error("[plaid] link-token error:", err?.response?.data || err.message);
    res.status(500).json({ status: "error", message: err?.response?.data?.error_message || err.message });
  }
});

// 2. Exchange public token for access token (after user completes Link)
plaidRouter.post("/exchange", async (req, res) => {
  const { public_token, institution } = req.body;
  if (!public_token) return res.status(400).json({ status: "error", message: "public_token required" });

  try {
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = response.data;

    // Store access token
    await withDb((db) => {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO plaid_items (item_id, access_token, institution_name, created_at)
         VALUES (?, ?, ?, ?)`
      );
      stmt.run([item_id, access_token, institution?.name || "Unknown", new Date().toISOString()]);
      stmt.free();
    }, { persist: true });

    console.log(`[plaid] linked item ${item_id} (${institution?.name || "Unknown"})`);
    res.json({ status: "success", data: { item_id, institution: institution?.name } });
  } catch (err: any) {
    console.error("[plaid] exchange error:", err?.response?.data || err.message);
    res.status(500).json({ status: "error", message: err?.response?.data?.error_message || err.message });
  }
});

// 3. Sync transactions from all linked items
plaidRouter.post("/sync", async (_req, res) => {
  try {
    // Get all linked items
    const items = await withDb((db) => {
      const stmt = db.prepare("SELECT item_id, access_token, cursor FROM plaid_items");
      const rows: any[] = [];
      while (stmt.step()) { rows.push(stmt.getAsObject()); }
      stmt.free();
      return rows;
    });

    if (!items.length) {
      return res.json({ status: "success", data: { synced: 0, message: "No linked accounts. Connect a bank first." } });
    }

    let totalAdded = 0;
    let totalModified = 0;
    let totalRemoved = 0;

    for (const item of items) {
      let hasMore = true;
      let cursor = item.cursor || undefined;

      while (hasMore) {
        const response = await plaidClient.transactionsSync({
          access_token: item.access_token,
          cursor,
        });
        const { added, modified, removed, next_cursor, has_more } = response.data;

        // Insert new transactions
        for (const tx of added) {
          const category = mapPlaidCategory(tx.personal_finance_category?.primary);
          const type = mapPlaidType(tx.amount);
          const amount = Math.abs(tx.amount);

          await withDb((db) => {
            // Use plaid transaction_id as our id to avoid dupes
            const stmt = db.prepare(
              `INSERT OR IGNORE INTO finance_transactions (id, amount, description, category, date, type, notes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            stmt.run([
              `plaid-${tx.transaction_id}`,
              amount,
              tx.merchant_name || tx.name || "Unknown",
              category,
              tx.date,
              type,
              tx.personal_finance_category?.primary || null,
              new Date().toISOString(),
            ]);
            stmt.free();
          }, { persist: true });
        }

        // Update modified transactions
        for (const tx of modified) {
          const category = mapPlaidCategory(tx.personal_finance_category?.primary);
          const type = mapPlaidType(tx.amount);
          const amount = Math.abs(tx.amount);

          await withDb((db) => {
            const stmt = db.prepare(
              `UPDATE finance_transactions SET amount=?, description=?, category=?, date=?, type=?, notes=?
               WHERE id=?`
            );
            stmt.run([amount, tx.merchant_name || tx.name, category, tx.date, type,
              tx.personal_finance_category?.primary || null, `plaid-${tx.transaction_id}`]);
            stmt.free();
          }, { persist: true });
        }

        // Remove deleted transactions
        for (const tx of removed) {
          await withDb((db) => {
            const stmt = db.prepare("DELETE FROM finance_transactions WHERE id=?");
            stmt.run([`plaid-${tx.transaction_id}`]);
            stmt.free();
          }, { persist: true });
        }

        totalAdded += added.length;
        totalModified += modified.length;
        totalRemoved += removed.length;
        cursor = next_cursor;
        hasMore = has_more;
      }

      // Persist cursor for incremental sync
      await withDb((db) => {
        const stmt = db.prepare("UPDATE plaid_items SET cursor=? WHERE item_id=?");
        stmt.run([cursor, item.item_id]);
        stmt.free();
      }, { persist: true });
    }

    console.log(`[plaid] sync complete: +${totalAdded} ~${totalModified} -${totalRemoved}`);
    res.json({ status: "success", data: { added: totalAdded, modified: totalModified, removed: totalRemoved } });
  } catch (err: any) {
    console.error("[plaid] sync error:", err?.response?.data || err.message);
    res.status(500).json({ status: "error", message: err?.response?.data?.error_message || err.message });
  }
});

// 4. List connected accounts
plaidRouter.get("/accounts", async (_req, res) => {
  try {
    const items = await withDb((db) => {
      const stmt = db.prepare("SELECT item_id, institution_name, created_at FROM plaid_items ORDER BY created_at DESC");
      const rows: any[] = [];
      while (stmt.step()) { rows.push(stmt.getAsObject()); }
      stmt.free();
      return rows;
    });
    res.json({ status: "success", data: items });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// 5. Remove a linked account
plaidRouter.delete("/accounts/:itemId", async (req, res) => {
  try {
    const item = await withDb((db) => {
      const stmt = db.prepare("SELECT access_token FROM plaid_items WHERE item_id=?");
      stmt.bind([req.params.itemId]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      return row;
    });

    if (item?.access_token) {
      try { await plaidClient.itemRemove({ access_token: item.access_token as string }); }
      catch { /* best effort */ }
    }

    await withDb((db) => {
      const stmt = db.prepare("DELETE FROM plaid_items WHERE item_id=?");
      stmt.run([req.params.itemId]);
      stmt.free();
    }, { persist: true });

    // Also remove plaid-sourced transactions for this item
    // (we'd need to track item_id per transaction for precise removal — skip for now)

    res.json({ status: "success", data: { removed: true } });
  } catch (err) {
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});


// 6. Webhook receiver (for when gateway is exposed via tunnel)
plaidRouter.post("/webhook", async (req, res) => {
  const { webhook_type, webhook_code } = req.body;
  console.log(`[plaid] webhook: ${webhook_type}/${webhook_code}`);

  if (webhook_type === "TRANSACTIONS") {
    if (["SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"].includes(webhook_code)) {
      // Trigger sync for the affected item
      console.log("[plaid] webhook triggered transaction sync");
      // Fire-and-forget sync
      syncAllItems().catch((err) => console.error("[plaid] webhook sync error:", err));
    }
  }
  res.json({ status: "received" });
});

// Exported sync function for cron and webhook use
export async function syncAllItems(): Promise<{ added: number; modified: number; removed: number }> {
  const items = await withDb((db) => {
    const stmt = db.prepare("SELECT item_id, access_token, cursor FROM plaid_items");
    const rows: any[] = [];
    while (stmt.step()) { rows.push(stmt.getAsObject()); }
    stmt.free();
    return rows;
  });

  if (!items.length) return { added: 0, modified: 0, removed: 0 };

  let totalAdded = 0, totalModified = 0, totalRemoved = 0;

  for (const item of items) {
    let hasMore = true;
    let cursor = item.cursor || undefined;

    while (hasMore) {
      const response = await plaidClient.transactionsSync({
        access_token: item.access_token,
        cursor,
      });
      const { added, modified, removed, next_cursor, has_more } = response.data;

      for (const tx of added) {
        const category = mapPlaidCategory(tx.personal_finance_category?.primary);
        const type = mapPlaidType(tx.amount);
        await withDb((db) => {
          const stmt = db.prepare(
            `INSERT OR IGNORE INTO finance_transactions (id, amount, description, category, date, type, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          );
          stmt.run([`plaid-${tx.transaction_id}`, Math.abs(tx.amount), tx.merchant_name || tx.name || "Unknown",
            category, tx.date, type, tx.personal_finance_category?.primary || null, new Date().toISOString()]);
          stmt.free();
        }, { persist: true });
      }

      for (const tx of modified) {
        const category = mapPlaidCategory(tx.personal_finance_category?.primary);
        const type = mapPlaidType(tx.amount);
        await withDb((db) => {
          const stmt = db.prepare(`UPDATE finance_transactions SET amount=?, description=?, category=?, date=?, type=?, notes=? WHERE id=?`);
          stmt.run([Math.abs(tx.amount), tx.merchant_name || tx.name, category, tx.date, type,
            tx.personal_finance_category?.primary || null, `plaid-${tx.transaction_id}`]);
          stmt.free();
        }, { persist: true });
      }

      for (const tx of removed) {
        await withDb((db) => {
          const stmt = db.prepare("DELETE FROM finance_transactions WHERE id=?");
          stmt.run([`plaid-${tx.transaction_id}`]);
          stmt.free();
        }, { persist: true });
      }

      totalAdded += added.length;
      totalModified += modified.length;
      totalRemoved += removed.length;
      cursor = next_cursor;
      hasMore = has_more;
    }

    await withDb((db) => {
      const stmt = db.prepare("UPDATE plaid_items SET cursor=? WHERE item_id=?");
      stmt.run([cursor, item.item_id]);
      stmt.free();
    }, { persist: true });
  }

  console.log(`[plaid] sync complete: +${totalAdded} ~${totalModified} -${totalRemoved}`);
  return { added: totalAdded, modified: totalModified, removed: totalRemoved };
}
