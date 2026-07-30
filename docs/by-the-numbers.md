# Hot Dogs by the Numbers — implementation plan

Status: **built 2026-07-30** (`numbers.js`, route `/numbers`, nav "By the
Numbers"). Design was resolved in a grilling session the same day; glossary
terms live in `CONTEXT.md` (Average Glizzy, Pace, Projected Year-End Total,
Milestone Ladder, Chestnut). As-built deltas from the plan are listed at the
bottom.

Reference data (prod backup pulled 2026-07-30): net 2,464 glizzies,
26 participants, Jan 1 – Jul 29. Pace (trailing 28 d) ≈ 7.6/day.
Projected year-end ≈ 3,640 (range 3,360 – 4,280).

## Locked decisions

- **Route `/numbers`**, nav label **"By the Numbers"** (`nav.js` key
  `numbers`), title "Hot Dogs by the Numbers".
- **Magazine scroll**: one stat per full-viewport section, scroll-triggered.
- **Truth only, no polling**: numbers are SSR'd from the live DB at request
  time; count-ups animate once per section on scroll-into-view. No fake
  ticking between events.
- **Viz stack**: GSAP + ScrollTrigger (CDN) for pinned/scrubbed scenes and
  count-ups; Chart.js (already sitewide) for the hero chart; hand-rolled SVG
  pictograms in the game's hand-drawn style. Tailwind CDN like every page.
- **Projection**: headline = Net Total + Pace × days remaining (Pacific).
  Range: low = trailing-14 pace, high = YTD average pace. All day math goes
  through `stats.js` Pacific helpers — never UTC dates.
- **Every stat scales off the Average Glizzy** (see CONTEXT.md): 57 g beef
  frank + 43 g white bun, 6 in / 15.24 cm.
- **Health stats are additive and collective-only.** Stated assumption: every
  glizzy was eaten on top of an otherwise unchanged diet. No per-user health
  numbers anywhere — real people, public page.
- **Milestone Ladders** span ~1,000 → ~15,000 glizzies (≈4× projected
  year-end) so comparisons upgrade themselves if pace doubles. Each section
  shows the last rung conquered + progress bar to the next.
- **"Show your work"** expander per section: formula, constants used (each
  with a linked source), and assumptions, in monospace.
- Plasma palette for data, `#ff6b35` accent, dark slate, Inter. Never
  red/green.

## Screens, in scroll order

Each screen: big count-up headline, SVG pictogram scene, ladder progress,
`▸ show your work` expander.

1. **The Count (hero)** — net total count-up; Chart.js cumulative area chart
   (plasma gradient) Jan 1 → today, then a dashed projection fan to Dec 31
   (shaded band = range, center line = headline projection). Pace shown as
   dogs/day. Formula panel explains all three projection models.
2. **The Tower** — total length stacked end-to-end. `n × 0.1524 m`.
   Pictogram: dog-stack next to to-scale building silhouettes that draw in.
   Ladder: football field incl. end zones 109.7 m (~720) → Eiffel Tower
   330 m (~2,165) → Empire State roof 381 m (~2,500) → ESB antenna tip
   443 m (~2,907) → Burj Khalifa 828 m (~5,433) → Golden Gate main span
   1,280 m (~8,399) → one mile 1,609 m (~10,558) → Daytona tri-oval lap
   4.02 km (~26,400, aspirational final rung).
3. **The Protein** — `n × protein_per_glizzy`. Compare: chicken breasts
   (54 g protein each) and person-years of the 50 g/day RDA. Pictogram:
   chicken-breast pile. Ladder rungs at 250/500/750/1,000 breasts.
4. **The Butter** — saturated fat. `n × satfat_per_glizzy ÷ 58 g` (sat fat
   in one 113 g stick). Pictogram: butter sticks stacking into a wall.
   Ladder: 100 → 250 → 500 → 1,000 sticks.
5. **The Salt** — sodium. `n × sodium_per_glizzy`, expressed as table salt
   (`× 2.5`) in 737 g Morton canisters, plus person-days of the FDA 2,300 mg
   limit. Ladder: canister counts.
6. **The Cardiologist's Note** — two stats, one somber-clinic-styled screen.
   Collective serum cholesterol: per-participant Keys-equation delta from
   each participant's *actual* dogs/day (sat-fat and dietary-cholesterol
   terms), summed across participants (~+100 mg/dL today). Average-participant
   CHD relative risk: Micha 2010 RR 1.42 per 50 g/day processed meat,
   linearly interpolated on mean g/day (~+21%). Panel states the additive
   assumption and the linear-interpolation caveat prominently.
7. **The Wheat** — bun acreage. `n × flour_per_bun ÷ extraction ÷ yield`.
   ~2,500 sq ft today. Pictogram: wheat field overlaying a court diagram.
   Ladder: parking space 160 sq ft (~155) → two-car garage 440 (~430) →
   tennis doubles court 2,808 (~2,780) → basketball court 4,700 (~4,650) →
   NHL rink 17,000 (~16,800) → acre 43,560 (aspirational).
8. **The Receipt** — money. `n × price_per_glizzy` (≈ $0.95; the ~$1-per-dog
   coincidence is the panel's punchline). Counterfactual ladder: AirPods Pro
   $249 → PS5 Pro $699 → 77" OLED $2,500 → used jet ski $5,000 → semester of
   in-state tuition $8,000 → 2012 Miata $10,000 → Nathan's franchise
   deposit-tier rung ~$15,000.
9. **The Treadmill** — burn-it-off. `n × kcal_per_glizzy`; marathons
   (÷2,600 kcal) and miles walked (÷80 kcal/mi). Walking-route ladder:
   Appalachian Trail 2,197 mi (~571) → LA→NYC 2,790 mi (~725) → Pan-American
   Highway 19,000 mi (~4,935) → around the equator 24,901 mi (~6,470).
10. **The Chestnut** — `n ÷ 76`. Chestnuts consumed (32.4 today) and how long
    Joey would need at contest pace (`Chestnuts × 10 min` ≈ 5 h 24 m).
    Milestone = next whole Chestnut.
11. **The Planet** — water + carbon, deadpan not preachy. Water:
    `beef_kg × 15,415 L + wheat_kg × 1,827 L` ≈ 2.3 M L today; Olympic pools
    (2.5 M L) ladder — and the ChatGPT comparison: equivalent to between
    ~77 M queries (UC Riverside ~30 mL/query) and ~7.2 B queries (OpenAI's
    claimed 0.32 mL/query); show the range, cite both, let the discrepancy be
    the joke. CO₂: `beef_kg × 25 kg CO₂e` ≈ 3.5 t ≈ ~8,800 mi driven
    (400 g/mi). Panel notes hot-dog beef is largely trimmings/cull dairy
    cattle, hence a footprint below the all-beef median.

## Constants table

All constants live in `numbers.js` (`SRC` + the `GLIZZY` object and friends)
with a citation each — nothing hard-coded inline in formulas or markup.
Values below were **verified against their sources during the 2026-07-30
build** (USDA values via the FDC API).

| Constant | Verified value | Source |
|---|---|---|
| Frank mass / bun mass / length | 57 g / 43 g / 15.24 cm | 8-per-lb pack math; NHDSC (length) |
| Per glizzy: kcal, protein, sat fat, sodium, dietary cholesterol | 299.5 kcal, 10.9 g, 6.9 g, 705 mg, 33 mg | USDA FDC 173862 (beef frankfurter, per 100 g: 315 kcal / 11.7 / 11.5 / 865 / 58) × 0.57 + FDC 172796 (plain roll: 279 / 9.77 / 0.842 / 494 / 0) × 0.43 |
| Chicken breast protein | 54 g/breast | USDA FDC, cooked boneless breast |
| Butter stick sat fat | 58 g/113 g stick | USDA FDC, butter salted |
| Salt from sodium | ×2.5; Morton canister 737 g | chemistry; Morton 26 oz |
| Keys equation | ΔChol = 1.35(2ΔS−ΔP) + 1.5ΔZ | Keys, Anderson & Grande 1965 |
| Processed-meat CHD risk | RR 1.42 per 50 g/day | Micha et al., Circulation 2010 |
| Flour per bun / extraction / wheat yield | ~25 g / 75 % / 3.5 t/ha | recipe share; milling std; USDA NASS |
| Price per glizzy | $0.99 ($0.66 frank + $0.33 bun) | BLS series APU0000705111, which ended Apr 2022 at $5.22/lb (the panel jokes about this); bun 8-pack ≈ $2.64 |
| kcal per marathon / per mile walked | 2,600 / 80 | 155 lb runner/walker, ACSM-style estimates |
| Chestnut | 76 dogs / 10 min | Nathan's 2021 world record |
| Beef water footprint / wheat | 15,415 L/kg / 1,827 L/kg | Mekonnen & Hoekstra 2011 |
| ChatGPT water per query | 0.32 mL and ~30 mL (range) | Altman blog 2025; Li et al. (UC Riverside) 2023 |
| Beef CO₂e | ~25 kg/kg (trimmings/dairy-herd) | Poore & Nemecek 2018, dairy-herd beef |
| Car emissions | 400 g CO₂/mi | EPA average passenger vehicle |
| Building/route dimensions | as listed per ladder | encyclopedic; cite per rung |

## Data plumbing

- **`numbers.js`** (new): `CONSTANTS`, `LADDERS`, `computeNumbers()` →
  `{ netTotal, pace, projection: {low, mid, high}, cumulativeSeries,
  perStat: {value, ladder: {conquered, next, progress}, work: {...}} }`,
  and `renderNumbersPage()` returning the SSR'd HTML with the payload
  embedded as JSON for the animations. Per-participant dogs/day for the
  cardiology screen is computed server-side and only aggregates leave the
  server.
- Prepared statements join the existing ones in `database.js`; day
  bucketing via `stats.js` (`toPacificDateKey`, `parseUtcTimestamp`).
- Route mounted alongside the others in `dashboard.js`; nav entry appended
  in `nav.js` LINKS (`/numbers`, "By the Numbers", `numbers`). No new API
  endpoint — no polling, so the SSR payload is the only consumer.

## Animation & fallbacks

- GSAP + ScrollTrigger from cdnjs, pinned to exact versions.
- `gsap.matchMedia()`: full pinned/scrubbed scenes only on `(min-width:
  768px) and (prefers-reduced-motion: no-preference)`; otherwise sections
  are plain stacked blocks with IntersectionObserver-style fade + count-up
  (GSAP still drives the count-up; no scroll pinning on phones).
- Count-ups: `gsap.to` with `snap` on `textContent`, `fmtCompact`-style
  formatting for big numbers.
- Sticky nav stays opaque (no backdrop-blur — see CLAUDE.md); pinned
  sections must account for the 57 px header (`top-14` convention).

## As built (2026-07-30) — deltas from the plan

- **No pinned GSAP scenes.** Pinning fights the sticky header and is fragile
  on phones, so every section uses play-once reveals (fade/slide + count-up +
  staggered pictogram pop-ins) on `scrollTrigger: top 62%`; the one scrubbed
  effect is the Tower's glizzy column growing with scroll on ≥768px. Sections
  are `min-height: 92vh`, so the scroll rhythm still reads magazine-style.
- **Pictograms are emoji unit-grids** (🍗🧈🧂🏃🏆🌾), not hand-drawn SVG, with
  the per-tile unit auto-picked (1/2/5/10/…) to keep grids ≤ ~90 tiles at any
  future total; the last tile clips to the fraction. Custom SVG where it
  earns its keep: the Tower scene (our stack vs. the last-conquered / next /
  next-next ladder rungs, auto-scaling forever), the Olympic-pool fill, and a
  self-drawing EKG for the cardiology section.
- **Graceful degradation:** the page SSRs all final values; the script exits
  before hiding anything when `prefers-reduced-motion` is set **or GSAP
  failed to load**, so the worst case is a static page with correct numbers.
- **Chart specifics:** single-series line (no legend), projection carried by
  dash + shaded band + direct end-labels ("today: N", "~N by Dec 31"); month
  ticks thin to every other month below 520px chart width.

Verification performed: all twelve sections screenshotted at 1440px and
390px in animated + reduced-motion modes (puppeteer + system chromium) — no
console errors, no element wider than the viewport (measured via
`getBoundingClientRect`, not `scrollWidth`); every stat hand-checked against
its formula on the fresh prod snapshot (net 2,464 → 376 m, 505 breasts,
294 butter sticks, 5.9 salt canisters, +110 mg/dL collective, +22% CHD,
2,629 sq ft, $2,439, 284 marathons, 32.4 Chestnuts, 0.93 pools, 3.5 t CO₂e).
Ladders all have a next rung past 15,000 glizzies. Not committed — owner
deploys manually.
