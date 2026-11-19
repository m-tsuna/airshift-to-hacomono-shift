"""docs/ の手順書（Markdown）を、印刷しやすい PDF にする。
使い方：python tools/make_pdf.py docs/11月22日のテスト手順.md
しくみ：Markdown → HTML（markdown ライブラリ）→ 画面に出さない Chrome で PDF に印刷
"""
import subprocess, sys, tempfile
from pathlib import Path
import markdown

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CSS = """
@page { size: A4; margin: 14mm 14mm; }
body { font-family: "Hiragino Sans", "Yu Gothic", sans-serif; font-size: 10.5pt; line-height: 1.45; color: #222; }
h1 { font-size: 17pt; border-bottom: 3px solid #2e7d32; padding-bottom: 4px; }
h2 { font-size: 13.5pt; background: #e8f5e9; padding: 4px 8px; margin-top: 10px; margin-bottom: 6px; break-after: avoid; }
li { margin: 2px 0; }
strong { color: #c62828; }
code { background: #f3f3f3; padding: 1px 4px; border-radius: 3px; font-size: 10pt; }
table { border-collapse: collapse; width: 100%; font-size: 10pt; }
th, td { border: 1px solid #bbb; padding: 4px 6px; vertical-align: top; }
th { background: #f5f5f5; }
img { max-width: 44%; border: 1px solid #ccc; margin: 6px 0; }
hr { border: none; border-top: 1px dashed #aaa; margin: 8px 0; }
table { break-inside: avoid; }
"""

def main():
    if len(sys.argv) < 2:
        sys.exit("使い方：python tools/make_pdf.py <Markdown のファイル>")
    src = Path(sys.argv[1])
    if not src.exists():
        sys.exit(f"ファイルがありません：{src}")
    body = markdown.markdown(src.read_text(encoding="utf-8"), extensions=["tables", "sane_lists"])
    base = src.parent.resolve().as_uri() + "/"  # 画像を Markdown と同じフォルダから読むため
    html = f'<!doctype html><html lang="ja"><meta charset="utf-8"><base href="{base}"><style>{CSS}</style><body>{body}</body></html>'
    out = src.with_suffix(".pdf")
    with tempfile.TemporaryDirectory() as tmp:
        h = Path(tmp) / "page.html"
        h.write_text(html, encoding="utf-8")
        subprocess.run([CHROME, "--headless=new", "--no-pdf-header-footer", f"--user-data-dir={tmp}/prof",
                        f"--print-to-pdf={out.resolve()}", h.as_uri()], check=True, capture_output=True, timeout=60)
    print(f"作りました：{out}")

if __name__ == "__main__":
    main()
