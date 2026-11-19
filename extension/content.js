// =============================================================
// content.js … hacomono のページの中で動く部分（コンテンツスクリプト）
//   - シフト表を読む（readTable）
//   - 1マス分、窓を開いて時間を入れて保存する（applyOne）
// サイドパネルからの頼み（メッセージ）を受けて動く
// =============================================================
(function () {
  "use strict";

  // ---- 設定：hacomono の画面の作り（画面が変わったらここを直す） ----
  const SEL = {
    table: "table.m_table",              // シフト表
    month: "input.period-form",          // 表示中の年月（例「202611」）
    cell: "td.item",                     // スタッフのマス
    staffLink: "th a",                   // スタッフ名（「[IN0119]」＋名前）
    holidayClass: "holiday",             // 祝日の日付に付く印
    group: (label) => '[role="group"][aria-label="' + label + '"]', // 窓の中の欄
    submit: 'button[type="submit"]',     // 「保存する」
  };
  const WAIT = {
    afterAction: 300,   // 1つ操作するごとの間（ミリ秒）
    betweenCells: 800,  // マスとマスの間。hacomono に負担をかけないため
    timeout: 10000,     // 窓が開く・閉じるのを待つ最長時間
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 条件がそろうまで待つ（そろわなければ null）
  async function waitFor(fn, timeout = WAIT.timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  }

  // ---- シフト表を読む ------------------------------------------
  function readTable() {
    const table = document.querySelector(SEL.table);
    const monthInput = document.querySelector(SEL.month);
    if (!table || !monthInput) {
      return { ok: false, error: "hacomono のシフト表が開いていません → hacomono の管理画面で『シフト』を開いてから、もう一度押してください" };
    }
    const rows = [...table.querySelectorAll("tr")];
    // 1行目：日付の見出し（「1日 (日)」）
    const days = [...rows[0].querySelectorAll("th")].slice(1).map((th) => ({
      day: parseInt(th.textContent, 10),
      holiday: th.classList.contains(SEL.holidayClass),
    }));
    const staff = [];
    for (const tr of rows) {
      const a = tr.querySelector(SEL.staffLink);
      const cells = tr.querySelectorAll(SEL.cell);
      if (!a || cells.length === 0) continue; // 営業時間・人数の行は飛ばす
      const text = a.innerText || a.textContent;
      const m = text.match(/\[([^\]]+)\]\s*([\s\S]*)/);
      if (!m) continue;
      staff.push({
        code: m[1].trim(),
        name: m[2].trim(),
        cells: [...cells].map((td) => td.textContent.trim()),
      });
    }
    return { ok: true, month: monthInput.value.trim(), days, staff };
  }

  // 表の中の、ある人・ある日のマスを探す
  function findCell(code, day) {
    const table = document.querySelector(SEL.table);
    if (!table) return null;
    const rows = [...table.querySelectorAll("tr")];
    const days = [...rows[0].querySelectorAll("th")].slice(1).map((th) => parseInt(th.textContent, 10));
    const col = days.indexOf(day);
    for (const tr of rows) {
      const a = tr.querySelector(SEL.staffLink);
      if (a && a.textContent.includes("[" + code + "]")) {
        return tr.querySelectorAll(SEL.cell)[col] || null;
      }
    }
    return null;
  }

  // 入力欄に値を入れる（画面の仕組み（Vue）が気づくように、入力の合図も送る）
  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function modalGroup(label) {
    return document.querySelector(SEL.group(label));
  }

  // 窓を閉じる（保存しない）
  async function closeModal() {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "閉じる");
    if (btn) btn.click();
    await waitFor(() => !modalGroup("日付"), 3000);
  }

  // ---- 1マス分を入れる -----------------------------------------
  // item: logic.js の buildPlan が作った1件
  async function applyOne(item) {
    if (modalGroup("日付")) await closeModal(); // 前の窓が残っていたら閉じる
    const td = findCell(item.code, item.d);
    if (!td) {
      if (!document.querySelector(SEL.table)) {
        return { ok: false, fatal: true, error: "シフト表が見つかりません。hacomono のログインが切れたかもしれません → ログインし直してシフト表を開き、『実行』を押してください（済んだマスは『同じ』になるので飛ばされます）" };
      }
      return { ok: false, error: item.d + "日のマスが見つかりません" };
    }
    // 1. マスを押して窓を開く
    (td.querySelector("div") || td).click();
    const dateGroup = await waitFor(() => modalGroup("日付"));
    if (!dateGroup) return { ok: false, fatal: true, error: "マスを押しても窓が開きません。hacomono の画面が変わったかもしれません → 作った人に連絡してください" };
    await sleep(WAIT.afterAction);

    // 2. 違うマスを開いていないか確かめる（日付と人）
    const dateVal = dateGroup.querySelector("input") && dateGroup.querySelector("input").value;
    const staffGroup = modalGroup("スタッフ");
    if (dateVal !== item.dateStr || (staffGroup && !staffGroup.textContent.includes("[" + item.code + "]"))) {
      await closeModal();
      return { ok: false, error: "開いた窓が " + item.dateStr + " のものではありませんでした（" + dateVal + "）。何も変えずに閉じました" };
    }

    // 3. 「休日」のチェックを外す
    const shift = modalGroup("シフト設定");
    const holiday = shift && shift.querySelector('input[type="checkbox"]');
    if (!holiday) { await closeModal(); return { ok: false, fatal: true, error: "「休日」のチェックが見つかりません。hacomono の画面が変わったかもしれません → 作った人に連絡してください" }; }
    if (holiday.checked) {
      holiday.click();
      await sleep(WAIT.afterAction);
    }

    // 4. 開始・終了時間を入れる
    // チェックを外すと窓の中身が作り直されることがあるので、欄は毎回探し直す
    const times = await waitFor(() => {
      const g = modalGroup("シフト設定");
      const t = g ? [...g.querySelectorAll('input[type="time"]')] : [];
      return t.length >= 2 && !t[0].disabled && !t[1].disabled ? t : null;
    }, 3000);
    if (!times) { await closeModal(); return { ok: false, fatal: true, error: "時間の欄が使えません。hacomono の画面が変わったかもしれません → 作った人に連絡してください" }; }
    if (times.length > 2) { await closeModal(); return { ok: false, error: "この日は時間帯が2つ以上あるので、手で直してください（何も変えずに閉じました）" }; }
    setValue(times[0], item.want.start);
    setValue(times[1], item.want.end);
    await sleep(WAIT.afterAction);

    // 5. 休憩（新しく入れるマスで、曜日の決まりの人だけ）
    if (item.breakBlock) {
      let block = modalGroup("予定ブロック設定");
      const addBtn = block && [...block.querySelectorAll("button")].find((b) => b.textContent.includes("予定ブロックを追加"));
      if (addBtn) { addBtn.click(); await sleep(WAIT.afterAction); }
      block = modalGroup("予定ブロック設定"); // 押したあとに作り直されるので探し直す
      const bt = block ? [...block.querySelectorAll('input[type="time"]')] : [];
      const nameInputs = block ? block.querySelectorAll('input[type="text"]') : [];
      if (bt.length >= 2 && nameInputs.length >= 1) {
        setValue(bt[bt.length - 2], item.breakBlock.start);
        setValue(bt[bt.length - 1], item.breakBlock.end);
        const nameInput = nameInputs[nameInputs.length - 1];
        setValue(nameInput, item.breakBlock.name);
        nameInput.dispatchEvent(new Event("blur"));
        await sleep(WAIT.afterAction);
      } else {
        await closeModal();
        return { ok: false, error: "休憩の欄が見つかりませんでした（何も変えずに閉じました）→ この日は手で入れてください" };
      }
    }

    // 6. 保存する
    const submit = document.querySelector(SEL.submit);
    if (!submit) { await closeModal(); return { ok: false, fatal: true, error: "「保存する」ボタンが見つかりません → 作った人に連絡してください" }; }
    submit.click();
    const closed = await waitFor(() => !modalGroup("日付"));
    if (!closed) {
      // 窓が閉じない＝hacomono がエラーを出した。窓の中の赤い文字などを拾って見せる
      const box = modalGroup("日付").closest("form") || document.body;
      const msg = [...box.querySelectorAll(".error, .danger, .m_alert, .invalid-feedback")]
        .map((e) => e.textContent.trim()).filter((t) => t && t !== "必須").join(" ");
      await closeModal();
      return { ok: false, error: "保存できませんでした" + (msg ? "（hacomono：" + msg + "）" : "") + " → この日は手で確かめてください" };
    }

    // 7. 表のマスが CSV の時間になったか読み返す
    const want = item.want.start + "-" + item.want.end;
    const norm = (s) => s.replace(/\s/g, "").replace(/(^|-)(\d):/g, "$10$2:");
    const ok = await waitFor(() => {
      const c = findCell(item.code, item.d);
      return c && norm(c.textContent) === want;
    }, 5000);
    await sleep(WAIT.betweenCells);
    if (!ok) {
      const c = findCell(item.code, item.d);
      return { ok: false, error: "保存しましたが、表のマスが「" + (c ? c.textContent.trim() : "?") + "」のままです → 表を開き直して確かめてください" };
    }
    return { ok: true };
  }

  // ---- サイドパネルからの頼みを受ける ----------------------------
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === "ping") { sendResponse({ ok: true }); return; }
      if (msg.type === "readTable") { sendResponse(readTable()); return; }
      if (msg.type === "applyOne") {
        applyOne(msg.item).then(sendResponse, (e) => sendResponse({ ok: false, error: "思わぬエラー：" + e.message }));
        return true; // 返事をあとで送る合図
      }
    });
  }
  // テスト用（Safari の練習用ページで、拡張機能なしに呼べるように）
  window.__shiftFiller = { readTable, applyOne };
})();
