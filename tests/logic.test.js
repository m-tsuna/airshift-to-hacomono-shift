// logic.js の単体テスト。実行：node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../extension/logic.js");

const SAMPLE = fs.readFileSync(path.join(__dirname, "../samples/airshift_sample_anonymized.csv"), "utf8");

// 練習用の hacomono の表（2026年11月、30日。3日と23日が祝日）
function fakeTable(cellsByCode) {
  const days = [];
  for (let d = 1; d <= 30; d++) days.push({ day: d, holiday: d === 3 || d === 23 });
  return {
    month: "202611",
    days,
    staff: Object.entries(cellsByCode).map(([code, v]) => ({ code, name: v.name, cells: v.cells })),
  };
}
const allOff = () => Array(30).fill("休");

test("T1 練習用 CSV を読める（59件・5人・11月）", () => {
  const csv = L.readAirshift(SAMPLE);
  assert.equal(csv.rows.length, 59);
  assert.deepEqual(csv.months, ["202611"]);
  assert.equal(new Set(csv.rows.map((r) => r.name)).size, 5);
  const a = csv.rows.filter((r) => r.name === "スタッフA");
  assert.equal(a.length, 17);
  // 時間は「09:00」の形にそろう
  for (const r of csv.rows) assert.match(r.start + r.end, /^\d\d:\d\d\d\d:\d\d$/);
});

test("1日目の行が CSV の通りに読める", () => {
  const csv = L.readAirshift(SAMPLE);
  const first = csv.rows[0];
  assert.deepEqual({ y: first.y, m: first.m, d: first.d, start: first.start, end: first.end }, { y: 2026, m: 11, d: 1, start: "10:00", end: "19:00" });
});

test("Airシフト以外の CSV はエラー", () => {
  assert.throws(() => L.readAirshift("名前,金額\nりんご,100\n"), L.UserError);
  assert.throws(() => L.readAirshift(""), /ファイルが空/);
});

test("時刻と名前をそろえる", () => {
  assert.equal(L.normTime("9:00"), "09:00");
  assert.equal(L.normTime("あ"), null);
  assert.equal(L.normName("山田　 太郎"), "山田太郎");
});

test("マスの文字を読む", () => {
  assert.deepEqual(L.parseCell("休"), { off: true });
  assert.deepEqual(L.parseCell(" 9:00-19:00 "), { start: "09:00", end: "19:00" });
  assert.deepEqual(L.parseCell("10:00-12:00 13:00-19:00"), { unknown: true });
});

test("CSV の人：全部休みの表に入れると、全部「新規」で時間が CSV と一致", () => {
  const csv = L.readAirshift(SAMPLE);
  const table = fakeTable({ IN0002: { name: "スタッフ A", cells: allOff() } });
  const plan = L.buildPlan(table, csv, { IN0002: { source: "csv" } });
  assert.equal(plan.counts.new, 17);
  for (const it of plan.items) {
    const r = csv.rows.find((x) => x.name === "スタッフA" && x.d === it.d);
    assert.deepEqual(it.want, { start: r.start, end: r.end });
    assert.equal(it.breakBlock, null); // CSV の人には休憩を入れない
  }
});

test("T3 同じ・違う・CSV では休み、を見分ける", () => {
  const csv = L.readAirshift(SAMPLE);
  const aDays = csv.rows.filter((r) => r.name === "スタッフA");
  const cells = allOff();
  // 1件目：同じ時間、2件目：違う時間、CSV で休みの日：時間あり
  cells[aDays[0].d - 1] = aDays[0].start + "-" + aDays[0].end;
  cells[aDays[1].d - 1] = "06:00-07:00";
  const offDay = [...Array(30).keys()].map((i) => i + 1).find((d) => !aDays.some((r) => r.d === d));
  cells[offDay - 1] = "10:00-19:00";
  const plan = L.buildPlan(fakeTable({ X: { name: "スタッフA", cells } }), csv, { X: { source: "csv" } });
  const kindOf = (d) => plan.items.find((it) => it.d === d).kind;
  assert.equal(kindOf(aDays[0].d), "same");
  assert.equal(kindOf(aDays[1].d), "change");
  assert.equal(kindOf(offDay), "check");
  assert.equal(plan.counts.new, 15);
});

test("曜日の決まり：11月は火木金13-22・水11-17・土11-20、祝日（3日）は休み、休憩付き", () => {
  const plan = L.buildPlan(fakeTable({ IN0119: { name: "ご主人", cells: allOff() } }), null, {
    IN0119: { source: "weekly", weekly: L.DEFAULT_WEEKLY, holidayOff: true },
  });
  // 11月：火4回（3日は祝日なので3回）・水4・木4・金4・土4 = 19
  assert.equal(plan.counts.new, 19);
  assert.ok(!plan.items.some((it) => it.d === 3));
  const wed = plan.items.find((it) => it.d === 4);
  assert.deepEqual(wed.want, { start: "11:00", end: "17:00" });
  assert.deepEqual(wed.breakBlock, { start: "13:00", end: "14:00", name: "休憩" });
  const sat = plan.items.find((it) => it.d === 7);
  assert.deepEqual(sat.breakBlock, { start: "15:00", end: "16:00", name: "休憩" });
});

test("曜日の決まり：時間を直すマスには休憩を入れない", () => {
  const cells = allOff();
  cells[3] = "11:00-16:00"; // 4日（水）
  const plan = L.buildPlan(fakeTable({ K: { name: "x", cells } }), null, { K: { source: "weekly" } });
  const wed = plan.items.find((it) => it.d === 4);
  assert.equal(wed.kind, "change");
  assert.equal(wed.breakBlock, null);
});

test("月が違う CSV はエラー", () => {
  const csv = L.readAirshift(SAMPLE);
  const t = fakeTable({ X: { name: "スタッフA", cells: allOff() } });
  t.month = "202612";
  assert.throws(() => L.buildPlan(t, csv, { X: { source: "csv" } }), /hacomono は 12月、ファイルは 11月/);
});

test("最初の入れ方：CSV に名前があれば csv、無ければ none", () => {
  const csv = L.readAirshift(SAMPLE);
  assert.equal(L.defaultSource("スタッフ B", csv), "csv");
  assert.equal(L.defaultSource("だれか", csv), "none");
});

test("祝日：hacomono に印が無くても、祝日の一覧に当たれば曜日の決まりの人は休み（2027/1/1）", () => {
  const days = [];
  for (let d = 1; d <= 31; d++) days.push({ day: d, holiday: false }); // 印なし（1か月分の画面と同じ）
  const t = { month: "202701", days, staff: [{ code: "K", name: "x", cells: days.map(() => "休") }] };
  const plan = L.buildPlan(t, null, { K: { source: "weekly" } });
  assert.ok(!plan.items.some((it) => it.d === 1), "1/1（金・元日）は入れない");
  assert.ok(!plan.items.some((it) => it.d === 11), "1/11（月・成人の日）は月曜で休み");
  assert.equal(plan.items.find((it) => it.d === 2).want.start, "11:00"); // 1/2（土）は入る
  assert.ok(L.isHoliday(2027, 3, 22) && !L.isHoliday(2027, 1, 2));
  assert.ok(L.hasHolidayList(2027) && !L.hasHolidayList(2028));
});
