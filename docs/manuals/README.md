# Machine & controller manuals (中文原版 说明书)

Source documents for the **KL-90010-T** and the Weihong stack it runs. These are **Weihong's own
Chinese manuals**, scraped to text so the toolchain can cite sections (`§7.4.7`, `§5.1`) and so a
re-check doesn't need a browser.

`docs/machine-kl90010t.md` establishes that `KL-90010-T` is a **private-label code** painted on
8 Star's machine — it appears nowhere in Weihong's catalogue. So no manual is titled `KL-90010-T`;
what exists are the manuals for the machine **class**. The label encodes the envelope (900 mm OD,
13.5 m, 5-axis bevel), and the capability set (H-beam to 800 × 300, heavy tube through a 1,000 mm
bore, ±45° bevel, Tekla `.nc1` in) sits across the **TU7500M / FA30A** family.

## What's here

| File | Document | Pages | For |
|---|---|---|---|
| `weihong-tu7500m-zh-r1.md` | V15 激光管材切割控制系统 用户手册（TU7500）R1, 2026-01-09 | 304 | **Closest to the machine.** 四卡盘 heavy tube: 回原点, 标定切割头/管材中心, 卡盘工艺, 随动控制, 图层工艺, 排样, 三卡盘 / 零尾料 |
| `weihong-fa30a-zh-r20260430.md` | NcStudio V15 激光型材切割控制系统 用户手册（FA30A）R20260430 | 141 | **5-axis section side**: H-beam/型钢, 摆头机构基准校正, 摆长结构测量, 三线打标, 摆放偏差, 切割偏移补偿, 焦点控制, 轴校准 |
| `weihong-tu7000m-zh-r1.md` | NcStudio V15 激光管材切割控制系统 用户手册（TU7000 切割头移动机型）R1, 2025-06-05 | 325 | Three-chuck **moving-head** variant — use when a machine detail looks like the head travels rather than the workpiece |
| `weihong-wisecam-tube-zh-r3.md` | WiseCAM-Tube 管切独立套料版软件用户手册（管切、钢构、坡口三合一）R3, 2024-07-11 | 205 | **The CAM side** — the nesting/export half of the job (§5.1 import, §7.4.6–7.4.8 旋转/镜像截面, §12 `.ncep`/`.ncexa`). Unblocks the citations already made in `docs/ncep-format.md`, `docs/ncep-export-strategy.md`, `docs/wisecam-formats.md` |

Fast lookups:

- Import formats / Tekla `.nc1`: WiseCAM §5.1 · TU7500M §4.2.1
- Section rotation / mirror: WiseCAM §7.4.7–7.4.8
- Bevel (V/Y/斜贯): WiseCAM §7.3 · FA30A §4.3
- Chuck / heavy-tube handling: TU7500M §4.2.7, §7
- Head geometry (摆长, 旋转中心): FA30A §5.2, §5.4
- Focus: TU7500M §6.5 · FA30A §5.10
- Export `.ncep` / `.ncexa`: WiseCAM §12

## Not scraped

| Document | Pages | Why |
|---|---|---|
| NcStudio V15 激光管材切割控制系统用户手册（TU3200M）R4 | — | 专业切管双卡盘 — lighter class than this machine |
| NcStudio V15 激光平面坡口控制系统用户手册（LS20A）R20260519 | — | plane bevel, not tube/profile |
| 双卡高功率系统（TU6000M） | — | **no document attached** in the catalogue (no current, no history) — not an extraction failure |

Catalogue index: <https://www.weihong.com.cn/services/documents> (激光加工类 → 激光管切 / 五轴切割).

## Reading these files

Text only — screenshots and figure callouts are **not** carried across (inline toolbar icons show up
as gaps inside step text). `<!-- p.N -->` markers are **PDF page numbers**, not the manual's printed
page numbers: the printed folio runs behind the PDF page (FA30A §5.7 is printed 110 but sits on
`p.116`). Cite the section number, and use the marker to find it.

## Re-scraping

```sh
curl -sSL -O '<url>'
node tools/manual-to-md.mjs -i <manual>.pdf -o docs/manuals/<name>.md \
  --title "…" --issuer "上海维宏电子科技股份有限公司 · 激光加工产品部" \
  --version "…" --source '<url>'
```

The converter strips the repeated Weihong running header and folio, keeps `-layout` text so tables
stay column-aligned in the source, and stamps the PDF's SHA-256 so a silent upstream revision is
detectable. Requires poppler's `pdftotext`. Scanned OEM manuals will need an OCR path
(`pdftoppm` → `tesseract -l chi_sim`, via `brew install tesseract-lang`); not implemented yet.

**Attribution:** these are © Shanghai Weihong Electronic Technology Co., Ltd. documents, kept here as
internal reference for the machine we own — not redistributable. Cite the source URL, not this copy,
in anything leaving the shop.
