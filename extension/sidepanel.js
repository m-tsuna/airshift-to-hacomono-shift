// =============================================================
// sidepanel.js … サイドパネル（右側の窓）の画面
//   ① CSV を読む → ② hacomono の表を読み、人ごとの入れ方を選ぶ
//   → ③ 入れる内容を一覧にする → 「実行」で1件ずつ content.js に頼む
// =============================================================
"use strict";
const L = window.ShiftLogic;
const $ = (id) => document.getElementById(id);

// 画面の状態
const state = {
  csv: null,        // readAirshift の結果
  table: null,      // hacomono の表
  settings: {},     // 人ごとの入れ方（chrome.storage に覚える）
  codes: {},        // 名前 → スタッフコード（表で読んだときに覚える。1か月分の画面には番号が出ないため）
  plan: null,       // buildPlan の結果
  unchecked: new Set(), // 一覧でチェックを外したマス
  running: false,
  stopRequested: false,
};

// ---- メッセージ表示 -------------------------------------------
function showMsg(text, type = "info") {
  const el = $("msg");
  el.textContent = text || "";
  el.className = "msg " + type;
}

// ---- 覚えておく設定 -------------------------------------------
async function loadSettings() {
  try {
    const v = await chrome.storage.local.get("settings");
    state.settings = v.settings || {};
    const c = await chrome.storage.local.get("codes");
    state.codes = c.codes || {};
  } catch (e) { state.settings = {}; state.codes = {}; }
}
async function saveSettings() {
  try { await chrome.storage.local.set({ settings: state.settings, codes: state.codes }); } catch (e) { /* 覚えられなくても動く */ }
}

// ---- hacomono のタブとやり取り -----------------------------------
async function hacomonoTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/[^/]+\.hacomono\.jp\//.test(tab.url || "")) {
    throw new L.UserError("いま開いているタブが hacomono ではありません → hacomono の管理画面で『シフト』を開いてください");
  }
  return tab;
}
async function ask(msg) {
  const tab = await hacomonoTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    throw new L.UserError("hacomono のページとつながりません → hacomono のページを再読み込み（Windows は F5、Mac は ⌘R）してから、もう一度押してください");
  }
}

// ---- ① CSV を読む ---------------------------------------------
async function onFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    state.csv = L.readAirshift(text);
    const people = new Set(state.csv.rows.map((r) => r.name)).size;
    const months = state.csv.months.map((k) => k.slice(0, 4) + "年" + +k.slice(4) + "月").join("・");
    $("fileLabel").textContent = "✓ " + file.name + "\n" + months + "分・" + state.csv.rows.length + "件（" + people + "人）";
    showMsg("");
    await readTable();
  } catch (e) {
    state.csv = null;
    $("fileLabel").textContent = "ここを押してファイルを選ぶ（ドラッグでも可）";
    showMsg(e instanceof L.UserError ? e.message : "ファイルが読めませんでした：" + e.message, "error");
    render();
  }
}

// ---- ② hacomono の表を読む -------------------------------------
async function readTable() {
  try {
    const res = await ask({ type: "readTable" });
    if (!res || !res.ok) throw new L.UserError(res ? res.error : "表が読めませんでした");
    if (res.mode === "form") {
      // 1か月分の画面：番号が出ないので、表で覚えた番号を名前から探す（無ければ名前で覚える）
      for (const st of res.staff) st.code = state.codes[L.normName(st.name)] || "名前:" + L.normName(st.name);
    } else {
      for (const st of res.staff) state.codes[L.normName(st.name)] = st.code;
    }
    state.table = res;
    // 初めての人には、最初の入れ方を決めておく（CSV に名前があれば CSV）
    for (const st of res.staff) {
      const s = state.settings[st.code];
      if (!s) state.settings[st.code] = { source: L.defaultSource(st.name, state.csv) };
      else if (s.source === "none" && L.defaultSource(st.name, state.csv) === "csv" && !s.chosen) s.source = "csv";
    }
    await saveSettings();
    const ym = res.month.slice(0, 4) + "年" + +res.month.slice(4) + "月";
    $("tableInfo").textContent = res.mode === "form"
      ? "hacomono：" + ym + "・" + res.staff[0].name + " さんの1か月分の画面"
      : "hacomono：" + ym + "の表（" + res.staff.length + "人）";
  } catch (e) {
    state.table = null;
    $("tableInfo").textContent = "hacomono のシフトの画面を開いてください。";
    showMsg(e instanceof L.UserError ? e.message : "思わぬエラー：" + e.message, "error");
  }
  render();
}

// ---- 画面を描き直す -------------------------------------------
function render() {
  renderStaff();
  state.plan = null;
  $("planBox").innerHTML = "";
  if (!state.table) { $("summary").textContent = "①と②が済むと、ここに出ます。"; updateButtons(); return; }
  try {
    state.plan = L.buildPlan(state.table, state.csv, state.settings);
  } catch (e) {
    showMsg(e instanceof L.UserError ? e.message : "思わぬエラー：" + e.message, "error");
    $("summary").textContent = "";
    updateButtons();
    return;
  }
  const c = state.plan.counts;
  $("summary").textContent =
    "新しく入れる " + c.new + "件／時間を変える " + c.change + "件／同じ " + c.same + "件／要確認 " + c.check + "件";
  const tbl = document.createElement("table");
  const label = { new: "新規", change: "変更", same: "同じ", check: "要確認" };
  for (const it of state.plan.items) {
    if (it.kind === "same") continue; // 同じものは件数だけ
    const key = itemKey(it);
    const tr = document.createElement("tr");
    const can = it.kind === "new" || it.kind === "change";
    const cb = can ? '<input type="checkbox" data-key="' + key + '"' + (state.unchecked.has(key) ? "" : " checked") + ">" : "";
    const after = it.want ? it.want.start + "-" + it.want.end : "休み";
    const what = it.kind === "new" ? after + (it.breakBlock ? "<br><span class='sub'>休憩 " + it.breakBlock.start + "-" + it.breakBlock.end + "</span>" : "")
      : it.kind === "change" ? it.current + " → " + after
      : "hacomono は " + it.current + "、" + (it.source === "csv" ? "CSV" : "決まり") + "では " + after + "<br><span class='sub'>手で確かめてください</span>";
    tr.innerHTML = "<td>" + cb + "</td><td>" + it.m + "/" + it.d + "(" + it.weekdayName + ")" + (it.holiday ? "祝" : "") +
      "</td><td>" + escapeHtml(it.name) + "</td><td>" + what + "</td><td><span class='kind k-" + it.kind + "'>" + label[it.kind] + "</span></td>";
    tbl.appendChild(tr);
  }
  $("planBox").appendChild(tbl);
  tbl.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) state.unchecked.delete(cb.dataset.key); else state.unchecked.add(cb.dataset.key);
    updateButtons();
  }));
  updateButtons();
}

function renderStaff() {
  const box = $("staffList");
  box.innerHTML = "";
  if (!state.table) return;
  for (const st of state.table.staff) {
    const s = state.settings[st.code];
    const div = document.createElement("div");
    div.className = "staff";
    const csvHas = L.defaultSource(st.name, state.csv) === "csv";
    div.innerHTML = "<b>" + escapeHtml(st.name) + "</b> " + (st.code.startsWith("名前:") ? "" : "<span class='sub'>[" + escapeHtml(st.code) + "]</span>") + "<br>" +
      "<select>" +
      "<option value='csv'>Airシフトの CSV から" + (state.csv && !csvHas ? "（CSV にいません）" : "") + "</option>" +
      "<option value='weekly'>曜日の決まりで</option>" +
      "<option value='none'>入れない</option></select>";
    const sel = div.querySelector("select");
    sel.value = s.source;
    sel.addEventListener("change", async () => {
      s.source = sel.value; s.chosen = true;
      if (s.source === "weekly" && !s.weekly) { s.weekly = JSON.parse(JSON.stringify(L.DEFAULT_WEEKLY)); s.holidayOff = true; }
      await saveSettings(); render();
    });
    if (s.source === "weekly") div.appendChild(weeklyEditor(s));
    box.appendChild(div);
  }
}

// 曜日の決まりを直す表（月〜日）
function weeklyEditor(s) {
  if (!s.weekly) { s.weekly = JSON.parse(JSON.stringify(L.DEFAULT_WEEKLY)); s.holidayOff = true; }
  const det = document.createElement("details");
  det.innerHTML = "<summary>曜日の決まりを見る・直す</summary>";
  const tbl = document.createElement("table");
  tbl.className = "weekly";
  tbl.innerHTML = "<tr><th></th><th>出勤</th><th>時間</th><th>休憩</th></tr>";
  for (const wd of [1, 2, 3, 4, 5, 6, 0]) {
    const w = s.weekly[wd];
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>" + L.WEEKDAY_NAMES[wd] + "</td><td><input type='checkbox' class='on'" + (w ? " checked" : "") + "></td>" +
      "<td><input type='time' class='st' value='" + (w ? w.start : "") + "'><br><input type='time' class='en' value='" + (w ? w.end : "") + "'></td>" +
      "<td><input type='time' class='bs' value='" + (w && w.breakStart || "") + "'><br><input type='time' class='be' value='" + (w && w.breakEnd || "") + "'></td>";
    tr.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", async () => {
      const on = tr.querySelector(".on").checked;
      const st = tr.querySelector(".st").value, en = tr.querySelector(".en").value;
      s.weekly[wd] = on && st && en ? { start: st, end: en, breakStart: tr.querySelector(".bs").value, breakEnd: tr.querySelector(".be").value } : null;
      await saveSettings(); render();
    }));
    tbl.appendChild(tr);
  }
  det.appendChild(tbl);
  const hol = document.createElement("label");
  hol.innerHTML = "<input type='checkbox'" + (s.holidayOff !== false ? " checked" : "") + "> 祝日は休み";
  hol.querySelector("input").addEventListener("change", async (e) => { s.holidayOff = e.target.checked; await saveSettings(); render(); });
  det.appendChild(hol);
  return det;
}

function itemKey(it) { return it.code + "_" + it.d; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function selectedItems() {
  if (!state.plan) return [];
  return state.plan.items.filter((it) => (it.kind === "new" || it.kind === "change") && !state.unchecked.has(itemKey(it)));
}
function isForm() { return !!(state.table && state.table.mode === "form"); }
function updateButtons() {
  const n = selectedItems().length;
  $("run").disabled = state.running || n === 0;
  $("tryOne").disabled = state.running || n === 0;
  // 1か月分の画面は保存を人が押すので、「1件だけ試す」は要らない
  $("tryOne").hidden = isForm();
  const word = isForm() ? "画面に入れる" : "実行";
  $("run").textContent = n ? word + "（" + n + "件）" : word;
  $("reload").disabled = state.running;
  $("stop").hidden = !state.running;
}

// ---- 実行 -----------------------------------------------------
async function run(onlyOne) {
  const items = selectedItems().slice(0, onlyOne ? 1 : undefined);
  if (!items.length) return;
  state.running = true; state.stopRequested = false; updateButtons();
  showMsg(""); $("result").innerHTML = "";
  const form = isForm();
  let done = 0, newCount = 0, changeCount = 0;
  const failed = [];
  try {
    for (const it of items) {
      if (state.stopRequested) break;
      $("progress").textContent = items.length + "件中 " + done + "件完了…（" + it.m + "/" + it.d + " " + it.name + "）";
      const res = await ask({ type: "applyOne", item: it });
      done++;
      if (res && res.ok) { if (it.kind === "new") newCount++; else changeCount++; }
      else {
        failed.push({ it, error: res ? res.error : "返事がありません" });
        if (res && res.fatal) break; // 画面が変わった・ログイン切れ：続けても失敗するので止める
      }
    }
  } catch (e) {
    showMsg(e instanceof L.UserError ? e.message : "思わぬエラー：" + e.message, "error");
  }
  state.running = false;
  const stopped = state.stopRequested ? "（途中で止めました）" : "";
  $("progress").textContent = (onlyOne ? "1件だけ試しました" : form ? "画面に入れました" : "終わりました") + stopped +
    "：入れた " + newCount + "件／変えた " + changeCount + "件／失敗 " + failed.length + "件";
  const saveNote = form && newCount + changeCount > 0
    ? "<div class='msg info'><b>まだ hacomono には保存されていません。</b>\nhacomono の画面で中身を見て、合っていれば右下の「保存する」を押してください。</div>" : "";
  if (failed.length) {
    $("result").innerHTML = "<div class='msg error'>" + failed.map((f) =>
      f.it.m + "/" + f.it.d + " " + escapeHtml(f.it.name) + "：" + escapeHtml(f.error)).join("\n") + "</div>" + saveNote;
  } else if (form) {
    $("result").innerHTML = saveNote;
  } else if (onlyOne) {
    $("result").innerHTML = "<div class='msg info'>hacomono の表で、そのマスが合っているか確かめてから「実行」を押してください。</div>";
  }
  await readTable(); // 表を読み直して、一覧を新しくする
}

// ---- ボタンなどのつなぎ ----------------------------------------
$("file").addEventListener("change", (e) => onFile(e.target.files[0]));
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); onFile(e.dataTransfer.files[0]); });
$("reload").addEventListener("click", () => { showMsg(""); readTable(); });
$("run").addEventListener("click", () => run(false));
$("tryOne").addEventListener("click", () => run(true));
$("stop").addEventListener("click", () => { state.stopRequested = true; $("progress").textContent += "　止めています…"; });

(async function start() {
  await loadSettings();
  await readTable();
})();
