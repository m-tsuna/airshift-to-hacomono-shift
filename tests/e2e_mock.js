// 練習用ページ（mock/hacomono.html）を、画面に出さない Chrome（ヘッドレス）で開き、
// content.js で本当に入力して確かめる。本物の hacomono は使わない
// 実行：node tests/e2e_mock.js
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const L = require("../extension/logic.js");

const ROOT = path.join(__dirname, "..");
const MOCK_URL = "file://" + encodeURI(path.join(ROOT, "mock/hacomono.html"));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail = "") { ok ? pass++ : fail++; console.log((ok ? "✔ " : "✖ ") + name + (ok ? "" : "  " + detail)); }

// Chrome の「外から操作する口」（DevTools Protocol）を使って、ページで JavaScript を動かす
let ws, nextId = 1;
const waiting = {};
async function connect() {
  for (let k = 0; k < 50; k++) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + PORT + "/json")).json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener("open", r));
        ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; } });
        return;
      }
    } catch (e) { /* まだ起動中 */ }
    await sleep(200);
  }
  throw new Error("Chrome につながりません");
}
async function js(code) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: code, awaitPromise: true, returnByValue: true } }));
  const m = await new Promise((r) => (waiting[id] = r));
  if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300));
  return m.result.result.value;
}

(async () => {
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shift-e2e-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", MOCK_URL], { stdio: "ignore" });
try {
await connect();
await sleep(800);
// 1. 練習用ページを開いて content.js を入れる
check("練習用ページが開いた", (await js("document.title")).includes("練習用"));
await js(fs.readFileSync(path.join(ROOT, "extension/content.js"), "utf8"));

// 2. テストのために、最初から入っているマスを作る
const csv = L.readAirshift(fs.readFileSync(path.join(ROOT, "samples/airshift_sample_202601.csv"), "utf8"));
const aDays = csv.rows.filter((r) => r.name === "スタッフA");
const bDays = csv.rows.filter((r) => r.name === "スタッフB");
const bOff = [...Array(30).keys()].map((i) => i + 1).find((d) => !bDays.some((r) => r.d === d));
await js(`
  const s = window.__mock.shifts;
  // A：1件目は CSV と同じ時間、2件目は違う時間
  Object.assign(s.IN0002[${aDays[0].d}], { off:false, start:"${aDays[0].start}", end:"${aDays[0].end}" });
  Object.assign(s.IN0002[${aDays[1].d}], { off:false, start:"06:00", end:"07:00" });
  // B：CSV では休みの日に時間が入っている
  Object.assign(s.IN0003[${bOff}], { off:false, start:"10:00", end:"19:00" });
  // 店長：7日（水）は時間がずれていて、手で入れた予定ブロックがある
  Object.assign(s.IN0001[7], { off:false, start:"11:00", end:"16:00", blocks:[{start:"14:00",end:"15:00",name:"休憩"},{start:"13:00",end:"13:30",name:"数値管理"}] });
  window.__mock.render(); "ok"`);
await sleep(300);

// 3. 表を読む
const table = JSON.parse(await js("JSON.stringify(window.__shiftFiller.readTable())"));
check("表が読める（2026年1月・3人・31日・祝日2日）", table.ok && table.month === "202601" && table.staff.length === 3 && table.days.length === 31 && table.days.filter((d) => d.holiday).length === 2, JSON.stringify(table).slice(0, 200));

// 4. 入れる内容を決める
const settings = { IN0001: { source: "weekly", weekly: L.DEFAULT_WEEKLY, holidayOff: true }, IN0002: { source: "csv" }, IN0003: { source: "csv" } };
const plan = L.buildPlan(table, csv, settings);
console.log("  一覧：", JSON.stringify(plan.counts));
check("A の同じマスは「同じ」", plan.items.find((i) => i.code === "IN0002" && i.d === aDays[0].d).kind === "same");
check("A の違うマスは「変更」", plan.items.find((i) => i.code === "IN0002" && i.d === aDays[1].d).kind === "change");
check("B の CSV で休みのマスは「要確認」", plan.items.find((i) => i.code === "IN0003" && i.d === bOff).kind === "check");
check("店長の1日（木・元日）は入れない", !plan.items.some((i) => i.code === "IN0001" && i.d === 1));

// 5. 新規・変更を1件ずつ入れる
const todo = plan.items.filter((i) => i.kind === "new" || i.kind === "change");
const t0 = Date.now();
const errors = [];
for (const it of todo) {
  const r = await js("window.__shiftFiller.applyOne(" + JSON.stringify(it) + ")");
  if (!r || !r.ok) errors.push(it.code + " " + it.d + "日：" + (r ? r.error : "返事なし"));
}
const sec = (Date.now() - t0) / 1000;
check("T2 " + todo.length + "件すべて成功（" + sec.toFixed(0) + "秒、1件 " + (sec / todo.length).toFixed(1) + "秒）", errors.length === 0, errors.join(" / "));

// 6. 結果を、練習用ページの中のデータと照らし合わせる
const shifts = JSON.parse(await js("JSON.stringify(window.__mock.shifts)"));
let mismatch = [];
for (const it of plan.items) {
  const v = shifts[it.code][it.d];
  if (it.kind === "new" || it.kind === "change" || it.kind === "same") {
    if (v.off || v.start !== it.want.start || v.end !== it.want.end) mismatch.push(it.code + " " + it.d);
  }
}
check("T2 入れたマスの時間がすべて CSV／決まりと一致", mismatch.length === 0, mismatch.join(","));
check("T3 要確認のマスは変わっていない", shifts.IN0003[bOff].start === "10:00" && shifts.IN0003[bOff].end === "19:00");
const wed7 = shifts.IN0001[7];
check("T3 店長7日：時間だけ直り、手で入れた予定ブロック2つは残る", wed7.start === "11:00" && wed7.end === "17:00" && wed7.blocks.length === 2 && wed7.blocks[1].name === "数値管理", JSON.stringify(wed7));
const wed14 = shifts.IN0001[14];
check("店長14日（水・新規）：休憩 13:00-14:00 が入る", wed14.blocks.length === 1 && wed14.blocks[0].start === "13:00" && wed14.blocks[0].end === "14:00" && wed14.blocks[0].name === "休憩", JSON.stringify(wed14));
const aNew = shifts.IN0002[aDays[2].d];
check("CSV の人には予定ブロックを入れない", aNew.blocks.length === 0);
// 休みのままのマス（どの一覧にも出ないマス）が変わっていないか
let touched = 0;
for (const code of Object.keys(shifts)) for (const d of Object.keys(shifts[code])) {
  if (!plan.items.some((i) => i.code === code && i.d === +d) && !shifts[code][d].off) touched++;
}
check("休みのままのマスは触っていない", touched === 0, touched + "件");

// 7. もう一度表を読むと、全部「同じ」になる（2回目に流しても何もしない）
await sleep(600);
const plan2 = L.buildPlan(JSON.parse(await js("JSON.stringify(window.__shiftFiller.readTable())")), csv, settings);
check("2回目は新規・変更が0件（" + JSON.stringify(plan2.counts) + "）", plan2.counts.new === 0 && plan2.counts.change === 0);

console.log(`\n合格 ${pass}／不合格 ${fail}`);
} finally { chrome.kill(); }
process.exit(fail ? 1 : 0);
})();
