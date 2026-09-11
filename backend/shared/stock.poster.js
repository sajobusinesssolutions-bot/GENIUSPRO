/**
 * stock.poster.js — inventory ledger (the second poster, mirroring the GL).
 *
 * Every sale posts 'out', every purchase posts 'in'. On-hand in item_stock is a
 * cache; the truth is sum(in) - sum(out) in stock_movements. Service items
 * (is_inventory = 0) are skipped — the same way the accounting poster skips
 * control accounts (blueprint §5.7).
 *
 * Always called inside the caller's open transaction.
 */
async function postMovement(conn, { firmId, itemId, batchNo = "", expiryDate = null, direction, quantity, unitCost = 0, sourceModule, sourceId, userId }) {
  const { rows } = await conn.query("SELECT is_inventory FROM items WHERE id = ? AND firm_id = ?", [itemId, firmId]);
  if (!rows.length || !rows[0].is_inventory) return; // skip services / unknown items

  await conn.query(
    `INSERT INTO stock_movements
       (firm_id, item_id, batch_no, direction, quantity, unit_cost, source_module, source_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [firmId, itemId, batchNo, direction, quantity, unitCost, sourceModule, sourceId, userId || null]
  );

  // Upsert the cached on-hand for this (item, batch).
  const delta = direction === "in" ? quantity : -quantity;
  const existing = (await conn.query(
    "SELECT id, quantity, avg_cost FROM item_stock WHERE firm_id = ? AND item_id = ? AND batch_no = ?",
    [firmId, itemId, batchNo]
  )).rows[0];

  if (existing) {
    // Receipts move the weighted-average cost; issues leave it alone.
    if (direction === "in" && unitCost > 0) {
      const oldQty = Number(existing.quantity) || 0;
      const oldAvg = Number(existing.avg_cost) || 0;
      const newQty = oldQty + quantity;
      const newAvg = newQty > 0 ? +(((Math.max(oldQty, 0) * oldAvg) + (quantity * unitCost)) / (Math.max(oldQty, 0) + quantity)).toFixed(4) : unitCost;
      await conn.query("UPDATE item_stock SET quantity = quantity + ?, avg_cost = ? WHERE id = ?", [delta, newAvg, existing.id]);
    } else {
      await conn.query("UPDATE item_stock SET quantity = quantity + ? WHERE id = ?", [delta, existing.id]);
    }
    if (expiryDate) await conn.query("UPDATE item_stock SET expiry_date = ? WHERE id = ?", [expiryDate, existing.id]);
  } else {
    await conn.query(
      "INSERT INTO item_stock (firm_id, item_id, batch_no, quantity, avg_cost, expiry_date) VALUES (?,?,?,?,?,?)",
      [firmId, itemId, batchNo, delta, unitCost, expiryDate]
    );
  }
}

/**
 * FEFO out: deduct across this item's batches, earliest expiry first
 * (batches without an expiry go last). Falls back to the default '' batch.
 */
async function postOutFEFO(conn, { firmId, itemId, quantity, sourceModule, sourceId, userId }) {
  let remaining = Number(quantity) || 0;
  let cost = 0;                                   // what the goods actually cost us
  const batches = (await conn.query(
    `SELECT batch_no, quantity, avg_cost, expiry_date FROM item_stock
      WHERE firm_id = ? AND item_id = ? AND quantity > 0
      ORDER BY (expiry_date IS NULL), expiry_date, id`,
    [firmId, itemId]
  )).rows;
  const fallback = async () => {
    const r = (await conn.query("SELECT purchase_price FROM items WHERE id = ?", [itemId])).rows[0];
    return Number(r && r.purchase_price) || 0;
  };
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, b.quantity);
    const unit = Number(b.avg_cost) || await fallback();
    await postMovement(conn, { firmId, itemId, batchNo: b.batch_no, direction: "out", quantity: take, unitCost: unit, sourceModule, sourceId, userId });
    cost += take * unit;
    remaining = +(remaining - take).toFixed(4);
  }
  // Oversell (stock can go negative by design): value it at the item's cost price.
  if (remaining > 0) {
    const unit = await fallback();
    await postMovement(conn, { firmId, itemId, batchNo: "", direction: "out", quantity: remaining, unitCost: unit, sourceModule, sourceId, userId });
    cost += remaining * unit;
  }
  return +cost.toFixed(2);
}

/** Convenience: post all lines of a document in one direction. */
async function postDocument(conn, { firmId, lines, direction, sourceModule, sourceId, userId }) {
  const costByItem = {};                          // item_id -> cost of goods that left
  let totalCost = 0;
  for (const ln of lines) {
    if (!ln.item_id) continue;
    const qty = Number(ln.quantity) || 0;
    if (direction === "out") {
      let c;
      if (!ln.batch_no) {
        // Sales/debit notes without an explicit batch: first-expiry-first-out.
        c = await postOutFEFO(conn, { firmId, itemId: ln.item_id, quantity: qty, sourceModule, sourceId, userId });
      } else {
        const b = (await conn.query("SELECT avg_cost FROM item_stock WHERE firm_id=? AND item_id=? AND batch_no=?",
                             [firmId, ln.item_id, ln.batch_no])).rows[0];
        const it = (await conn.query("SELECT purchase_price FROM items WHERE id=?", [ln.item_id])).rows[0];
        const unit = Number(b && b.avg_cost) || Number(it && it.purchase_price) || 0;
        await postMovement(conn, { firmId, itemId: ln.item_id, batchNo: ln.batch_no, expiryDate: ln.expiry_date || null,
                             direction, quantity: qty, unitCost: unit, sourceModule, sourceId, userId });
        c = +(qty * unit).toFixed(2);
      }
      costByItem[ln.item_id] = +((costByItem[ln.item_id] || 0) + c).toFixed(2);
      totalCost = +(totalCost + c).toFixed(2);
    } else {
      // Receipts are valued at what we paid.
      const unit = Number(ln.unit_cost != null ? ln.unit_cost : ln.rate) || 0;
      await postMovement(conn, {
        firmId, itemId: ln.item_id, batchNo: ln.batch_no || "", expiryDate: ln.expiry_date || null,
        direction, quantity: qty, unitCost: unit, sourceModule, sourceId, userId,
      });
      costByItem[ln.item_id] = +((costByItem[ln.item_id] || 0) + qty * unit).toFixed(2);
      totalCost = +(totalCost + qty * unit).toFixed(2);
    }
  }
  return { totalCost, costByItem };
}

module.exports = { postMovement, postDocument, postOutFEFO };
