/**
 * store.routes.js — PUBLIC online store (no login).
 * A catalog + cart page; checkout composes a WhatsApp order message.
 * Enabled per firm via Settings → Store. Uses the demo firm (single-tenant install).
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { getSetting } = require("../settings/settings.service");

async function firmRow() {
  return (await query("SELECT * FROM firms ORDER BY id LIMIT 1")).rows[0];
}
const setting = async (firmId, key, dflt) => await getSetting(firmId, key, dflt);

router.get("/catalog", async (req, res) => {
  const firm = await firmRow();
  if (!firm || await setting(firm.id, "store_enabled", "0") !== "1") return res.status(404).json({ success: false, message: "Store is not enabled" });
  const items = (await query(
    `SELECT i.id, i.name, i.unit, i.sale_price,
            COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id = i.id AND s.firm_id = i.firm_id), 0) AS on_hand,
            (SELECT name FROM item_categories c WHERE c.id = i.category_id) AS category
       FROM items i
      WHERE i.firm_id = ? AND i.is_active != 0 AND i.item_type = 'product'
      ORDER BY i.name`, [firm.id])).rows
    .map((i) => ({ id: i.id, name: i.name, unit: i.unit, price: i.sale_price, in_stock: i.on_hand > 0, category: i.category || "General" }));
  res.json({ success: true, data: { firm: { name: firm.name, phone: firm.phone || "" },
    whatsapp: await setting(firm.id, "store_whatsapp", ""), note: await setting(firm.id, "store_note", ""), items } });
});

/* server-rendered storefront */
router.get("/", async (req, res) => {
  const firm = await firmRow();
  if (!firm || await setting(firm.id, "store_enabled", "0") !== "1") {
    return res.status(404).send("<h3 style='font-family:sans-serif'>This store is not enabled.</h3>");
  }
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${firm.name} — Online Store</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@600;800&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--ink:#171D2E;--pri:#4338CA;--ok:#0E8A56;--line:#E3E6EF}
*{box-sizing:border-box;margin:0}body{font-family:Inter,sans-serif;background:#F5F6FA;color:#1A2033;padding-bottom:96px}
header{background:var(--ink);color:#fff;padding:18px 16px}
header h1{font-family:'Barlow Semi Condensed';font-size:22px}
header p{color:#AEB6D2;font-size:13px;margin-top:3px}
.wrap{max-width:720px;margin:0 auto;padding:14px}
.search{width:100%;padding:12px 14px;border:2px solid var(--pri);border-radius:11px;font-size:15px;margin-bottom:12px;outline:none}
.item{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:9px;display:flex;justify-content:space-between;align-items:center;gap:10px}
.item b{font-size:14.5px}
.item .meta{color:#6B7280;font-size:12px;margin-top:2px}
.price{font-family:'Barlow Semi Condensed';font-weight:800;font-size:16px;white-space:nowrap}
.qty{display:flex;align-items:center;gap:8px}
.qty button{width:32px;height:32px;border-radius:8px;border:1.5px solid var(--line);background:#fff;font-size:16px;cursor:pointer}
.qty span{min-width:20px;text-align:center;font-weight:600}
.oos{color:#C93A3A;font-size:12px;font-weight:600}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--ink);padding:12px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.bar .tot{color:#8CF5C3;font-family:'Barlow Semi Condensed';font-weight:800;font-size:18px}
.bar button{background:#25D366;color:#062015;font-family:'Barlow Semi Condensed';font-weight:800;font-size:15px;border:none;border-radius:11px;padding:12px 18px;cursor:pointer}
.cat{font-family:'Barlow Semi Condensed';font-weight:800;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6B7390;margin:14px 2px 8px}
</style></head><body>
<header><div class="wrap" style="padding:0">
  <h1>${firm.name}</h1><p id="note"></p>
</div></header>
<div class="wrap">
  <input class="search" id="q" placeholder="Search products…">
  <div id="list">Loading…</div>
</div>
<div class="bar" id="bar" style="display:none">
  <div><div style="color:#8A93B4;font-size:11px">YOUR ORDER</div><div class="tot" id="tot">Sh 0</div></div>
  <button onclick="checkout()">Order on WhatsApp ➤</button>
</div>
<script>
let DATA=null,cart={};
const fmt=n=>Math.round(n).toLocaleString('en-UG');
fetch('/store/catalog').then(r=>r.json()).then(j=>{DATA=j.data;document.getElementById('note').textContent=DATA.note||'';render()});
function render(){
  const q=(document.getElementById('q').value||'').toLowerCase();
  const items=DATA.items.filter(i=>i.name.toLowerCase().includes(q));
  const byCat={};items.forEach(i=>{(byCat[i.category]=byCat[i.category]||[]).push(i)});
  document.getElementById('list').innerHTML=Object.keys(byCat).sort().map(c=>
    '<div class="cat">'+c+'</div>'+byCat[c].map(i=>{
      const n=cart[i.id]||0;
      return '<div class="item"><div><b>'+i.name+'</b><div class="meta">Sh '+fmt(i.price)+' per '+i.unit+
        (i.in_stock?'':' · <span class="oos">out of stock</span>')+'</div></div>'+
        (i.in_stock?('<div class="qty"><button onclick="chg('+i.id+',-1)">−</button><span>'+n+'</span><button onclick="chg('+i.id+',1)">+</button></div>'):'')+
        '</div>';}).join('')).join('')||'<p style="color:#6B7280">No products match.</p>';
  bar();
}
document.getElementById('q').addEventListener('input',render);
function chg(id,d){cart[id]=Math.max(0,(cart[id]||0)+d);if(!cart[id])delete cart[id];render()}
function total(){return Object.entries(cart).reduce((a,[id,n])=>{const i=DATA.items.find(x=>x.id==id);return a+i.price*n},0)}
function bar(){const has=Object.keys(cart).length>0;document.getElementById('bar').style.display=has?'flex':'none';
  document.getElementById('tot').textContent='Sh '+fmt(total())}
function checkout(){
  const lines=Object.entries(cart).map(([id,n])=>{const i=DATA.items.find(x=>x.id==id);return '- '+i.name+' x '+n+' = Sh '+fmt(i.price*n)});
  const msg='Hello '+DATA.firm.name+', I would like to order:%0A'+lines.join('%0A')+'%0A%0ATotal: Sh '+fmt(total())+'%0A(sent from your online store)';
  const num=(DATA.whatsapp||DATA.firm.phone||'').replace(/[^0-9]/g,'').replace(/^0/,'256');
  window.open('https://wa.me/'+num+'?text='+msg,'_blank');
}
</script></body></html>`);
});

module.exports = router;
