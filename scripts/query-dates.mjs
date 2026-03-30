import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';
const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync('D:/ai-knowledge/databases/market-agent.db'));
const r = db.exec(`
  SELECT json_extract(payload,'$.target_date') as td,
         json_extract(payload,'$.city') as city,
         COUNT(*) as cnt,
         AVG(json_extract(payload,'$.edge')) as avg_edge,
         SUM(CASE WHEN json_extract(payload,'$.recommended_contracts') > 0 THEN 1 ELSE 0 END) as tradeable
  FROM events
  WHERE event_type='mispricing_detected'
  GROUP BY td, city
  ORDER BY td
`);
if (r.length) {
  console.log('Date       | City    | Signals | Tradeable | AvgEdge');
  console.log('-----------|---------|---------|-----------|--------');
  r[0].values.forEach(v => {
    console.log(`${v[0]} | ${String(v[1]).padEnd(7)} | ${String(v[2]).padStart(7)} | ${String(v[3]).padStart(9)} | $${Number(v[4] || 0).toFixed(3)}`);
  });
}

// Also check date range of all events
const r2 = db.exec(`SELECT MIN(timestamp_ms), MAX(timestamp_ms), COUNT(*) FROM events`);
if (r2.length) {
  const [minTs, maxTs, total] = r2[0].values[0];
  console.log(`\nEvent range: ${new Date(Number(minTs)).toISOString()} to ${new Date(Number(maxTs)).toISOString()}`);
  console.log(`Total events: ${total}`);
}
db.close();
