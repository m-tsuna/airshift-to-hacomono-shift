// =============================================================
// logic.js … 計算だけをする部分（画面やページの操作はしない）
//   - Airシフトの CSV を読んで「誰が・何日・何時〜何時」の一覧にする
//   - hacomono の表と見比べて、マスごとに「新規・変更・同じ・要確認」を決める
// サイドパネル（ブラウザ）と単体テスト（Node.js）の両方から使う
// =============================================================
(function (root) {
  "use strict";

  // ---- 設定 ---------------------------------------------------
  // Airシフトの CSV の見出しの名前（列の順番ではなく名前で探す）
  const CSV_COLUMNS = {
    date: "日にち",
    start: "開始時間",
    end: "終了時間",
    lastName: "氏名-姓",
    firstName: "氏名-名",
  };
  // hacomono の表で、休みのマスに出る文字
  const OFF_TEXT = "休";
  // 曜日の決まりで入れるとき、休憩として入れる予定ブロックの名前
  const BREAK_NAME = "休憩";
  // 曜日の決まりの、最初に入っている値（あとからサイドパネルで直せる）
  // 0=日 1=月 … 6=土。null は休み
  const DEFAULT_WEEKLY = {
    0: null,
    1: null,
    2: { start: "13:00", end: "22:00", breakStart: "17:00", breakEnd: "18:00" },
    3: { start: "11:00", end: "17:00", breakStart: "13:00", breakEnd: "14:00" },
    4: { start: "13:00", end: "22:00", breakStart: "17:00", breakEnd: "18:00" },
    5: { start: "13:00", end: "22:00", breakStart: "17:00", breakEnd: "18:00" },
    6: { start: "11:00", end: "20:00", breakStart: "15:00", breakEnd: "16:00" },
  };
  const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];
  // 祝日（振替休日・国民の休日を含む）。hacomono の画面に祝日の印が無いときにも休みにするため
  // （2027/1/1 は hacomono に印が無かった）。2028年の分は 2027年の終わりごろに足す
  const JP_HOLIDAYS = new Set([
    // 2026年
    "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29",
    "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11",
    "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
    // 2027年
    "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22",
    "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05", "2027-07-19", "2027-08-11",
    "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23",
  ]);
  // その年の祝日が一覧に入っているか（無い年は、サイドパネルで知らせる）
  function hasHolidayList(y) {
    return [...JP_HOLIDAYS].some((k) => k.startsWith(y + "-"));
  }
  function isHoliday(y, m, d) {
    return JP_HOLIDAYS.has(y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0"));
  }

  // 利用者に見せるエラー（何が起きたか → どうすればよいか）
  class UserError extends Error {}

  // ---- CSV を読む ---------------------------------------------
  // CSV の文字を、行×列の配列にする（"" で囲まれた値や、値の中のカンマにも対応）
  function parseCsv(text) {
    text = text.replace(/^﻿/, ""); // 先頭の BOM（文字コードの印）を消す
    const rows = [];
    let row = [], cell = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else cell += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((v) => v.trim() !== ""));
  }

  // 「9:00」→「09:00」にそろえる。時刻でなければ null
  function normTime(s) {
    const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return m[1].padStart(2, "0") + ":" + m[2];
  }

  // 名前の空白（半角・全角）を消して、見比べやすくする
  function normName(s) {
    return String(s || "").replace(/[\s　]/g, "");
  }

  // Airシフトの CSV を読んで、シフトの一覧にする
  // 返す形：{ rows: [{ y, m, d, start, end, name }], months: ["202611"] }
  function readAirshift(text) {
    const table = parseCsv(text);
    if (table.length === 0) {
      throw new UserError("ファイルが空です → Airシフトで CSV をダウンロードし直してください");
    }
    const header = table[0].map((h) => h.trim());
    const idx = {};
    for (const [key, name] of Object.entries(CSV_COLUMNS)) {
      idx[key] = header.indexOf(name);
      if (idx[key] < 0) {
        throw new UserError(
          "Airシフトのシフトデータではないようです（「" + name + "」の列がありません）→ Airシフトの『シフトデータ』の CSV を選んでください"
        );
      }
    }
    const rows = [];
    for (let i = 1; i < table.length; i++) {
      const r = table[i];
      const dm = String(r[idx.date] || "").trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
      const start = normTime(r[idx.start]);
      const end = normTime(r[idx.end]);
      if (!dm || !start || !end) {
        throw new UserError(
          (i + 1) + "行目の日にち・時間が読めません → Airシフトでダウンロードした CSV をそのまま使ってください（Excel で保存し直すと形が変わることがあります）"
        );
      }
      rows.push({
        y: +dm[1], m: +dm[2], d: +dm[3], start, end,
        name: normName((r[idx.lastName] || "") + (r[idx.firstName] || "")),
      });
    }
    const months = [...new Set(rows.map((x) => monthKey(x.y, x.m)))].sort();
    return { rows, months };
  }

  function monthKey(y, m) {
    return String(y) + String(m).padStart(2, "0");
  }

  // ---- hacomono のマスを読む ----------------------------------
  // マスの文字（「休」「10:00-19:00」）を読む
  function parseCell(text) {
    const t = String(text || "").replace(/\s/g, "");
    if (t === OFF_TEXT) return { off: true };
    const m = t.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (m) return { start: normTime(m[1]), end: normTime(m[2]) };
    return { unknown: true }; // 時間帯が2つある・見たことのない形
  }

  // ---- 入れる内容を決める ---------------------------------------
  // table   : hacomono の表（content.js の readTable の結果）
  //           { month: "202611", days: [{ day, holiday }], staff: [{ code, name, cells: [text] }] }
  // csv     : readAirshift の結果（無くてもよい：曜日の決まりだけで入れるとき）
  // settings: { [スタッフコード]: { source: "csv" | "weekly" | "none", weekly, holidayOff } }
  // 返す形  : { items: [...], counts: {...} }
  function buildPlan(table, csv, settings) {
    const y = +table.month.slice(0, 4);
    const m = +table.month.slice(4, 6);
    const items = [];
    for (const st of table.staff) {
      const conf = settings[st.code] || { source: "none" };
      if (conf.source === "none") continue;
      if (conf.source === "csv" && !csv) continue;
      // CSV から、この人のシフトを日付ごとに取り出す
      const csvByDay = {};
      if (conf.source === "csv") {
        if (!csv.months.includes(table.month)) {
          throw new UserError(
            "hacomono は " + m + "月、ファイルは " + csv.months.map((k) => +k.slice(4) + "月").join("・") +
            " です → hacomono の表を CSV と同じ月にしてください"
          );
        }
        for (const r of csv.rows) {
          if (r.name === normName(st.name) && r.y === y && r.m === m) csvByDay[r.d] = r;
        }
      }
      table.days.forEach((dayInfo, i) => {
        const d = dayInfo.day;
        const weekday = new Date(y, m - 1, d).getDay();
        // hacomono の印か、上の祝日の一覧のどちらかに当たれば祝日
        const holiday = !!dayInfo.holiday || isHoliday(y, m, d);
        let want = null, breakBlock = null;
        if (conf.source === "csv") {
          const r = csvByDay[d];
          if (r) want = { start: r.start, end: r.end };
        } else if (conf.source === "weekly") {
          const w = (conf.weekly || DEFAULT_WEEKLY)[weekday];
          const holidayOff = conf.holidayOff !== false;
          if (w && !(holiday && holidayOff)) {
            want = { start: normTime(w.start), end: normTime(w.end) };
            if (normTime(w.breakStart) && normTime(w.breakEnd)) {
              breakBlock = { start: normTime(w.breakStart), end: normTime(w.breakEnd), name: BREAK_NAME };
            }
          }
        }
        const cur = parseCell(st.cells[i]);
        let kind;
        if (cur.unknown) kind = want ? "check" : null;
        else if (cur.off) kind = want ? "new" : null;
        else if (!want) kind = "check";
        else if (cur.start === want.start && cur.end === want.end) kind = "same";
        else kind = "change";
        if (!kind) return; // 休みのままでよいマスは一覧に出さない
        items.push({
          code: st.code, name: st.name, source: conf.source,
          y, m, d, weekday, weekdayName: WEEKDAY_NAMES[weekday], holiday,
          dateStr: y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0"),
          current: String(st.cells[i] || "").trim(),
          want,
          // 休憩は、新しく入れるマスにだけ入れる（手で入れた予定ブロックを消さないため）
          breakBlock: kind === "new" ? breakBlock : null,
          kind,
        });
      });
    }
    const counts = { new: 0, change: 0, same: 0, check: 0 };
    for (const it of items) counts[it.kind]++;
    return { items, counts };
  }

  // hacomono の人に、最初に選んでおく入れ方（CSV に同じ名前があれば CSV）
  function defaultSource(staffName, csv) {
    if (csv && csv.rows.some((r) => r.name === normName(staffName))) return "csv";
    return "none";
  }

  const api = {
    UserError, parseCsv, normTime, normName, readAirshift, parseCell, buildPlan, defaultSource,
    monthKey, isHoliday, hasHolidayList, DEFAULT_WEEKLY, WEEKDAY_NAMES, BREAK_NAME,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ShiftLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
