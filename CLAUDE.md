# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要
ジムの店長（本人のご主人）が、月1回 Airシフトで作ったトレーナー3人のシフトを hacomono（ジムの予約管理システム）のシフト表へ打ち直す作業（30〜40分）を、自動にする Chrome 拡張機能（講座 5-2-2「他者が使うツール①」）。サイドパネルで CSV を選んで「実行」を押すだけにする。決めたことと理由は `要件定義書.md`、経緯と記事の材料は `作業記録.md`（GitHub に載せない）。

## 使う技術
- JavaScript／Chrome 拡張機能（Manifest V3）：サイドパネル（画面）＋コンテンツスクリプト（hacomono のページを操作）＋ `chrome.storage`（チェックや曜日の設定を覚える）
- ライブラリなし。単体テストは Node.js の `node:test`（`/usr/local/bin/node`）
- 外への通信はしない。権限は `https://*.hacomono.jp/*` と sidePanel・storage だけ（店の名前が入った URL をコードに書かない）

## 動かし方（コマンド）
- `node --test "tests/*.test.js"` 単体テスト（logic.js）。1つだけなら `--test-name-pattern="名前"` を足す（Node 24 では `tests/` とフォルダだけ渡すと失敗する）
- `node tests/e2e_mock.js` 画面に出さない Chrome（DevTools Protocol）で `mock/hacomono.html` を開き、content.js で50件入力して照らし合わせる（約2分）
- `node tests/e2e_form.js` 同じく `mock/hacomono_form.html`（1か月分の画面の練習用）で、3人分を入れて照らし合わせる（約45秒）
- `node tests/sidepanel_ui.js` サイドパネルの画面（chrome の機能をにせものに差し替え。止める・エラー表示・進み具合の16項目）
- Chrome で `chrome://extensions` →「デベロッパーモード」→「パッケージ化されていない拡張機能を読み込む」で `extension/` を選ぶ。直したら拡張機能の画面で更新ボタン
- 本物の hacomono は触らずに、`mock/`（本物の作りに似せた練習用ページ）でテストする
- 本人の Mac の Safari で hacomono が開いているときは、`osascript -e 'tell application "Safari" to do JavaScript "…" in current tab of front window'` で読める（Safari の「Apple Events からの JavaScript を許可」が要る）。**読むだけ。書き込みはご主人の OK があるときだけ**

## データの流れ
- 入力①：Airシフトの CSV（UTF-8 BOM付き、1行＝1人の1日。列は見出し名で探す：日にち `2026/11/1`、開始時間、終了時間、氏名-姓、氏名-名。休みの日は行が無い。休憩の列は使わない）
- 入力②：ご主人の分は CSV に出ない（Airシフトで「確定」を押していない）ので、曜日ごとの勤務時間・休憩を設定に持つ。月 休／火木金 13:00-22:00（休憩 17-18）／水 11:00-17:00（休憩 13-14）／土 11:00-20:00（休憩 15-16）／日・祝 休
- hacomono のシフト表：`table.m_table`。1行目が日付（`th` に「1日 (日)」、祝日は class `holiday`）、5行目からスタッフ（`th a` に「[IN0119]」＋名前）。マスは `td.item`、休みは `td.item.unactive` で「休」。表示中の月は `input.period-form` の値（`202611`）
- マスを押すと「スタッフシフト設定」の窓：欄は `[role=group][aria-label="日付" / "シフト設定" / "予定ブロック設定"]`。「休日」チェックを外すと `input[type=time]` 2つが使える。保存は `button[type=submit]`（「保存する」）
- **1か月分の画面**（ご主人がいつも使う。表の右下「スタッフシフトを追加」→人を選ぶ／表の名前を押す、どちらも同じ作り）：行 `.d_shift_table` の先頭 `span`「1日 (金)」、次の div に時間2つと「休日」チェック、右の `.grow_1` が予定ブロック（無い日は「予定ブロックを追加」ボタン、名前は `input[type=text]`）。人の名前は `[aria-label="スタッフ"] .label`（番号は出ない → サイドパネルが表で覚えた番号を名前から当てる）。祝日の印は無い。**拡張機能は欄に入れるだけで、「保存する」はご主人が見てから押す**
- 新しい月は、人を追加して保存するまで表に行が無い（2027年1月で確認）。祝日は hacomono の印＋ logic.js の祝日一覧（2026〜2027年。2027/1/1 は hacomono に印が無かった）
- CSV の人と hacomono の人は、名前の空白を除いてつなぐ（11月で2人とも30日一致を確認済み）

## 守るルール
- マスごとに：休→出勤は入れる（ご主人だけ予定ブロック「休憩」も入れる）／時間が違う→開始・終了だけ直し、**予定ブロックには触らない**／同じ→何もしない／CSV で休み→変えずに「要確認」
- 名前はコードに書かない。`private/`（実名入りの保存ページ）、ダウンロードフォルダの元 CSV、実名入りのスクショは GitHub に載せない。調べるときは日本語を＊に伏せて表示する
- `samples/airshift_sample_anonymized.csv` は名前をスタッフA〜E にした練習用（テスト・GitHub 用）
- 設定（待ち時間・ボタンの探し方・曜日の決まり）はファイルの先頭にまとめる。hacomono の画面が変わったら直す場所を一つにするため

## 見た目のルール
- サイドパネルは上から「① CSV を選ぶ → ② 入れる人 → ③ 一覧（新規・変更・同じ・要確認）→ 1件だけ試す／実行」。説明を読まずに使えること
- 進み具合は「45件中12件完了…」、エラーは「何が起きたか → どうすればよいか」

## 進捗（2026-11-22 夜）
- main：1か月分の画面に入れる版（保存は人）＋祝日一覧＋人を選ぶと自動で読み直す（v1.1.0）。PR #1 をマージ済み。GitHub https://github.com/m-tsuna/airshift-to-hacomono-shift
- 11/22 ご主人のテスト：1月分が上手く入った。店長とトレーナーで流れが違う所（読み直す）で手間取った → 自動で読み直すように直した
- この Mac の Chrome のコピー（`~/Downloads/シフト自動入力`）・ZIP（`dist/`）も v1.1.0。**直したらコピーにも写して更新ボタン**
- 次：職場の Windows PC に ZIP で入れる（渡し方は未定）→ 12/18〜19 の1月分の本番＝試運転 → 振り返り（役立ったか・分かりにくい所）→ 記事
- これからの直しは Feature Branch → PR → /code-review → 本人の OK → マージ
