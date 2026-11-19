// サイドパネル（sidepanel.html）の画面を、画面に出さない Chrome で開いて確かめる
//   - Chrome の拡張機能の機能（chrome.tabs・chrome.storage）は「にせもの」に差し替える
//   - hacomono とのやり取りも、にせもの（決まった表を返す・1件ずつ少し待って成功を返す）
//   確かめること：T4 止める／T5 エラーの表示／進み具合の表示／ボタンの状態
// 実行：node tests/sidepanel_ui.js
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PANEL_URL = "file://" + encodeURI(path.join(ROOT, "extension/sidepanel.html"));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const CSV_JAN = fs.readFileSync(path.join(ROOT, "samples/airshift_sample_202601.csv"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail = "") { ok ? pass++ : fail++; console.log((ok ? "✔ " : "✖ ") + name + (ok ? "" : "  → " + detail)); }

// にせものの hacomono の表（2026年1月・3人・全部「休」。1日と12日は祝日）
function fakeTable(month = "202601") {
  const days = [...Array(31).keys()].map((i) => ({ day: i + 1, holiday: i === 0 || i === 11 }));
  const cells = days.map(() => "休");
  return { ok: true, month, days, staff: [
    { code: "IN0001", name: "店長", cells: [...cells] },
    { code: "IN0002", name: "スタッフ A", cells: [...cells] },
    { code: "IN0003", name: "スタッフ B", cells: [...cells] },
  ] };
}

// ページより先に動かす「にせものの chrome」。動きは window.__fake で切り替える
const FAKE_CHROME = `
window.__fake = { url: "https://demo-admin.hacomono.jp/#/reservation/shifts/", table: null, delay: 50, fatalAt: 0, throwSend: false, applied: 0 };
const mem = {};
window.chrome = {
  storage: { local: { get: async (k) => ({ [k]: mem[k] }), set: async (o) => Object.assign(mem, o) } },
  tabs: {
    query: async () => [{ id: 1, url: window.__fake.url }],
    sendMessage: async (id, msg) => {
      const f = window.__fake;
      if (f.throwSend) throw new Error("Could not establish connection");
      if (msg.type === "readTable") return f.table || { ok: false, error: "hacomono のシフト表が開いていません → hacomono の管理画面で『シフト』を開いてから、もう一度押してください" };
      if (msg.type === "applyOne") {
        await new Promise((r) => setTimeout(r, f.delay));
        f.applied++;
        if (f.fatalAt && f.applied === f.fatalAt) return { ok: false, fatal: true, error: "シフト表が見つかりません。hacomono のログインが切れたかもしれません" };
        return { ok: true };
      }
    },
  },
};`;

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
async function cdp(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => (waiting[id] = r));
}
async function js(code) {
  const m = await cdp("Runtime.evaluate", { expression: code, awaitPromise: true, returnByValue: true });
  if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300));
  return m.result.result.value;
}
// サイドパネルを開き直す。setup でにせものの状態を決めてから、ページの最初の処理が動く
async function openPanel(setup = "") {
  const r = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_CHROME + ";" + setup });
  await cdp("Page.navigate", { url: PANEL_URL });
  await sleep(700);
  await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: r.result.identifier });
}
const text = (id) => js(`document.getElementById("${id}").textContent`);
const pickCsv = (csv, name = "シフトデータ.csv") =>
  js(`onFile(new File([${JSON.stringify(csv)}], ${JSON.stringify(name)})).then(() => "ok")`);
const TABLE = (month) => `window.__fake.table = ${JSON.stringify(fakeTable(month))};`;

(async () => {
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shift-ui-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", "about:blank"], { stdio: "ignore" });
try {
await connect();
await cdp("Page.enable");

// T5-1 hacomono 以外のタブ
await openPanel(`window.__fake.url = "https://www.google.com/";`);
check("T5 hacomono 以外のタブ → 「hacomono ではありません → …開いてください」", (await text("msg")).includes("hacomono ではありません →"), await text("msg"));

// T5-2 hacomono だがシフト表を開いていない
await openPanel();
check("T5 シフト表を開いていない → 「シフト表が開いていません → …」", (await text("msg")).includes("シフト表が開いていません →"), await text("msg"));
check("  このとき「実行」は押せない", await js(`document.getElementById("run").disabled`));

// T5-3 hacomono のページとつながらない（拡張機能を入れたあと、ページを再読み込みしていない）
await openPanel(`window.__fake.throwSend = true;`);
check("T5 ページとつながらない → 「再読み込み（Windows は F5、Mac は ⌘R）」", (await text("msg")).includes("Windows は F5"), await text("msg"));

// T5-4 Airシフト以外の CSV
await openPanel(TABLE("202601"));
await pickCsv("名前,金額\n山田,100\n", "家計簿.csv");
check("T5 Airシフト以外の CSV → 「シフトデータではないようです → …」", (await text("msg")).includes("Airシフトのシフトデータではないようです"), await text("msg"));
check("  このとき「実行」は押せない", await js(`document.getElementById("run").disabled`));

// T5-5 月が違う（hacomono は 12月、CSV は 1月）
await openPanel(TABLE("202612"));
await pickCsv(CSV_JAN);
check("T5 月が違う → 「hacomono は 12月、ファイルは 1月 です → …」", (await text("msg")).includes("hacomono は 12月、ファイルは 1月"), await text("msg"));
check("  このとき「実行」は押せない", await js(`document.getElementById("run").disabled`));

// ふつうに使う：CSV を選ぶ → 一覧 → 1件だけ試す
await openPanel(TABLE("202601"));
await pickCsv(CSV_JAN);
const summary = await text("summary");
const runLabel = await text("run");
const n = +(runLabel.match(/（(\d+)件）/) || [])[1];
check("CSV を選ぶと一覧の件数と「実行（N件）」が出る：" + summary + "／" + runLabel, /新しく入れる \d+件/.test(summary) && n > 0, runLabel);
check("  CSV のファイル名と件数が出る", (await text("fileLabel")).includes("2026年1月分"), await text("fileLabel"));
await js(`document.getElementById("tryOne").click(); "ok"`);
await sleep(500);
check("1件だけ試す → 1件だけ入り「確かめてから実行」と出る", (await js("window.__fake.applied")) === 1 && (await text("progress")).includes("入れた 1件") && (await text("result")).includes("確かめてから"), await text("progress"));

// 進み具合と T4「止める」
await openPanel(TABLE("202601") + `window.__fake.delay = 300;`);
await pickCsv(CSV_JAN);
await js(`document.getElementById("run").click(); "ok"`);
await sleep(1000);
const prog = await text("progress");
check("実行中は「N件中 X件完了…」が出る：" + prog.slice(0, 30), /\d+件中 \d+件完了…/.test(prog), prog);
check("  実行中は「止める」が出て、「実行」は押せない", !(await js(`document.getElementById("stop").hidden`)) && (await js(`document.getElementById("run").disabled`)));
await js(`document.getElementById("stop").click(); "ok"`);
await sleep(800);
const applied = await js("window.__fake.applied");
const after = await text("progress");
check("T4 止める → すぐ止まり、何件入ったかが出る：" + after, after.includes("途中で止めました") && after.includes("入れた " + applied + "件") && applied < n, "入った " + applied + "／全部 " + n);
check("  止めたあとは「止める」が消え、ボタンが戻る", (await js(`document.getElementById("stop").hidden`)) && !(await js(`document.getElementById("run").disabled`)));

// ログイン切れ（続けても失敗する種類のエラー）→ そこで止まり、理由が出る
await openPanel(TABLE("202601") + `window.__fake.fatalAt = 3;`);
await pickCsv(CSV_JAN);
await js(`document.getElementById("run").click(); "ok"`);
await sleep(1500);
check("ログイン切れ → 3件目で止まり「失敗 1件」と理由が出る", (await js("window.__fake.applied")) === 3 && (await text("progress")).includes("失敗 1件") && (await text("result")).includes("ログインが切れた"), await text("progress") + " / " + await text("result"));

console.log(`\n合格 ${pass}／不合格 ${fail}`);
} finally { chrome.kill(); }
process.exit(fail ? 1 : 0);
})();
