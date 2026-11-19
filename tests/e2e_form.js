// 練習用の「1か月分の画面」（mock/hacomono_form.html）を、画面に出さない Chrome で開き、
// content.js で本当に入れて確かめる。本物の hacomono は使わない。保存ボタンは押さない
// 実行：node tests/e2e_form.js
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const L = require("../extension/logic.js");

const ROOT = path.join(__dirname, "..");
const MOCK_URL = "file://" + encodeURI(path.join(ROOT, "mock/hacomono_form.html"));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail = "") { ok ? pass++ : fail++; console.log((ok ? "✔ " : "✖ ") + name + (ok ? "" : "  " + detail)); }

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
// 人を選んで画面を開き直し、content.js を入れる
async function open(code, preset) {
  await js("location.href = " + JSON.stringify(MOCK_URL + "?staff=" + code) + "; 'ok'");
  await sleep(700);
  await js(fs.readFileSync(path.join(ROOT, "extension/content.js"), "utf8"));
  if (preset) { await js("(() => { const m = window.__mock.model; " + preset + "; window.__mock.render(); return 'ok'; })()"); await sleep(200); }
}
const read = async (code) => {
  const t = JSON.parse(await js("JSON.stringify(window.__shiftFiller.readTable())"));
  if (t.ok) t.staff[0].code = code; // サイドパネルと同じく、番号は名前から当てる
  return t;
};
async function applyAll(plan) {
  const errors = [];
  for (const it of plan.items.filter((i) => i.kind === "new" || i.kind === "change")) {
    const r = await js("window.__shiftFiller.applyOne(" + JSON.stringify(it) + ")");
    if (!r || !r.ok) errors.push(it.d + "日：" + (r ? r.error : "返事なし"));
  }
  return errors;
}

(async () => {
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shift-form-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", MOCK_URL], { stdio: "ignore" });
try {
await connect();
await sleep(800);
const csv = L.readAirshift(fs.readFileSync(path.join(ROOT, "samples/airshift_sample_202601.csv"), "utf8"));
const weekly = { source: "weekly", weekly: L.DEFAULT_WEEKLY, holidayOff: true };

// ---- 店長（曜日の決まり）----
await open("IN0001", `
  Object.assign(m[7], { off:false, start:"11:00", end:"16:00", blocks:[{start:"14:00",end:"15:00",name:"休憩"},{start:"13:00",end:"13:30",name:"数値管理"}] });
  Object.assign(m[14], { off:true, blocks:[{start:"12:00",end:"12:10",name:"終了後インターバル"}] })`);
let t = await read("IN0001");
check("1か月分の画面として読める（2026年1月・31日・1人）", t.ok && t.mode === "form" && t.month === "202601" && t.days.length === 31 && t.staff[0].name === "テスト 店長", JSON.stringify(t).slice(0, 200));
let plan = L.buildPlan(t, null, { IN0001: weekly });
check("店長の1日（木・元日）は、画面に祝日の印が無くても入れない", !plan.items.some((i) => i.d === 1));
const t0 = Date.now();
let errors = await applyAll(plan);
const n = plan.items.filter((i) => i.kind === "new" || i.kind === "change").length;
check("店長 " + n + "件すべて画面に入った（" + ((Date.now() - t0) / 1000).toFixed(1) + "秒）", errors.length === 0, errors.join(" / "));
let model = JSON.parse(await js("JSON.stringify(window.__mock.model)"));
const bad = plan.items.filter((i) => i.want && (model[i.d].off || model[i.d].start !== i.want.start || model[i.d].end !== i.want.end));
check("入れた日の時間がすべて決まりと一致", bad.length === 0, bad.map((i) => i.d).join(","));
check("7日（変更）：時間だけ直り、予定ブロック2つはそのまま", model[7].end === "17:00" && model[7].blocks.length === 2 && model[7].blocks[1].name === "数値管理", JSON.stringify(model[7]));
check("21日（水・新規）：休憩 13:00-14:00 が入る", JSON.stringify(model[21].blocks) === JSON.stringify([{ start: "13:00", end: "14:00", name: "休憩" }]), JSON.stringify(model[21]));
check("14日（予定ブロックが先にある新規）：元のブロックを残して休憩を足す", model[14].blocks.length === 2 && model[14].blocks[0].name === "終了後インターバル" && model[14].blocks[1].name === "休憩" && model[14].blocks[1].start === "13:00", JSON.stringify(model[14]));
check("休みの日（月・日・元日）は休日のまま", model[1].off && model[4].off && model[5].off);
check("「保存する」は押していない", (await js("window.__mock.saveCount")) === 0);
plan = L.buildPlan(await read("IN0001"), null, { IN0001: weekly });
check("読み直すと新規・変更が0件（" + JSON.stringify(plan.counts) + "）", plan.counts.new === 0 && plan.counts.change === 0);

// ---- スタッフA（CSV）：同じ日・違う日がある ----
const aDays = csv.rows.filter((r) => r.name === "スタッフA");
await open("IN0002", `
  Object.assign(m[${aDays[0].d}], { off:false, start:"${aDays[0].start}", end:"${aDays[0].end}" });
  Object.assign(m[${aDays[1].d}], { off:false, start:"06:00", end:"07:00" })`);
plan = L.buildPlan(await read("IN0002"), csv, { IN0002: { source: "csv" } });
check("A：同じ日は「同じ」、違う日は「変更」", plan.items.find((i) => i.d === aDays[0].d).kind === "same" && plan.items.find((i) => i.d === aDays[1].d).kind === "change");
errors = await applyAll(plan);
model = JSON.parse(await js("JSON.stringify(window.__mock.model)"));
const badA = aDays.filter((r) => model[r.d].off || model[r.d].start !== r.start || model[r.d].end !== r.end);
check("A：CSV の " + aDays.length + "日すべて一致", errors.length === 0 && badA.length === 0, errors.concat(badA.map((r) => r.d)).join(","));
check("A：CSV の人には予定ブロックを入れない", Object.values(model).every((v) => v.blocks.length === 0));

// ---- スタッフB（CSV）：CSV では休みの日に時間がある ----
const bDays = csv.rows.filter((r) => r.name === "スタッフB");
const bOff = [...Array(31).keys()].map((i) => i + 1).find((d) => !bDays.some((r) => r.d === d));
await open("IN0003", `Object.assign(m[${bOff}], { off:false, start:"10:00", end:"19:00" })`);
plan = L.buildPlan(await read("IN0003"), csv, { IN0003: { source: "csv" } });
check("B：CSV で休みの日は「要確認」", plan.items.find((i) => i.d === bOff).kind === "check");
errors = await applyAll(plan);
model = JSON.parse(await js("JSON.stringify(window.__mock.model)"));
check("B：要確認の日は変わっていない", errors.length === 0 && model[bOff].start === "10:00" && model[bOff].end === "19:00", errors.join(","));

// ---- 画面のスタッフが違うとき ----
const wrong = { ...plan.items.find((i) => i.kind === "new") , name: "スタッフ A" };
const r = await js("window.__shiftFiller.applyOne(" + JSON.stringify(wrong) + ")");
check("画面の人と違う人の分は入れずに止める", !r.ok && r.fatal && r.error.includes("ではなくなりました"), JSON.stringify(r));

// ---- レビューで見つかった守り（まだ何も入れていない画面で試す）----
await open("IN0003");
const newItem = plan.items.find((i) => i.kind === "new");
// 時間帯が2つある日：チェックを外す前に止め、何も変えない
await js(`(() => { const p = document.querySelector('[data-day="${newItem.d}"]').children[1]; const x = document.createElement("input"); x.type = "time"; p.appendChild(x); const y = document.createElement("input"); y.type = "time"; p.appendChild(y); return "ok"; })()`);
let r2 = await js("window.__shiftFiller.applyOne(" + JSON.stringify(newItem) + ")");
model = JSON.parse(await js("JSON.stringify(window.__mock.model)"));
check("時間帯が2つある日は、休日のチェックも外さずに止める", !r2.ok && r2.error.includes("何も変えていません") && model[newItem.d].off === true, JSON.stringify(r2) + JSON.stringify(model[newItem.d]));
// 一覧を作ったあとに画面の種類が変わった（表のつもりの頼みが1か月分の画面に来た／その逆）
r2 = await js("window.__shiftFiller.applyOne(" + JSON.stringify({ ...newItem, mode: "table" }) + ")");
check("画面の種類が一覧を作ったときと違えば止める", !r2.ok && r2.fatal && r2.error.includes("画面が変わりました"), JSON.stringify(r2));
// 画面の月が変わった
await js(`document.querySelector(".period-form").value = "202602"; "ok"`);
r2 = await js("window.__shiftFiller.applyOne(" + JSON.stringify({ ...newItem, mode: "form" }) + ")");
model = JSON.parse(await js("JSON.stringify(window.__mock.model)"));
check("画面の月が変わったら、入れずに止める", !r2.ok && r2.fatal && r2.error.includes("ではなくなりました") && model[newItem.d].off === true, JSON.stringify(r2));

console.log(`\n合格 ${pass}／不合格 ${fail}`);
} finally { chrome.kill(); }
process.exit(fail ? 1 : 0);
})();
