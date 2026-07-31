# The Ballpark is a night scene, because the UI was built against a dark canvas

GlizzyBrawl's Stage is **the Ballpark** — a night game seen from the outfield
wall. A day game was the more classic image and was turned down. The reason is
not art direction: it is that three separate parts of the Arena's UI were
written assuming the canvas behind them is dark, and none of them are art.

- The HUD draws white text straight onto the canvas with no plate behind it
  (`brawl-page.js`, `drawHud`): the fighter/spectator count, every Fighter's
  name and Percent above their head, and the KO banner at y=120.
- The blast zone is a dashed stroke at `rgba(148,163,184,0.10)` — a hairline
  that only exists because it sits on near-black.
- Every Fighter sprite carries a dark outline, chosen when the backdrop was a
  `#0b1220`→`#050a17` gradient.

A bright Stage doesn't degrade any of these gracefully; it deletes them. White
text on a blue sky is unreadable, a 10%-opacity light-grey line on a lit crowd
is invisible, and dark-outlined sprites on a bright field lose the outline that
separates them from it. Fixing that means text plates or outlines, a
re-coloured blast zone, and — worst — a decision about the roster's outlines
that would invalidate finished art for all four Fighters.

So the constraint is: **the Stage's upper band and its play band must stay dark
enough for white text and a hairline to read on them.** Night is how the
Ballpark satisfies that while still being a place.

## Considered Options

- **Day game, blue sky** — the honest classic ballpark, and the most legible
  "this is baseball" image. Rejected: it forces a HUD redesign, a blast-zone
  restyle, and reopens the roster's outline treatment. The Stage would be
  driving the UI instead of sitting behind it.
- **Dusk / golden hour** — a compromise, and genuinely pretty. Rejected as the
  worst of both: a warm mid-luminance sky is exactly where white text stops
  being reliable, and it fights `#ff6b35`, the brand accent the HUD and the
  placeholder surfaces already use.
- **Keep the abstract dark void** — no Stage art at all, which is where we
  started. Rejected because the Arena reads as a placeholder, and it always
  will while it has no place.
- **Night game under the lights** — chosen. Dark sky where the HUD lives, a
  crowd band and lit scoreboard behind the fight, light towers that motivate
  the rim-lighting on everything else.

## Consequences

- **Stage art is judged against a contrast floor, not by eye.**
  `scripts/brawl-stage-preview.mjs` composites each Fighter's `stand` sprite
  over the backdrop at all eight spawn points and requires a minimum mean
  luminance delta along the silhouette. The threshold is derived by measuring
  the *placeholder* Stage (`--baseline`), which is known-readable — if new art
  reads worse than a flat gradient, that is a finding, not a matter of taste.
  The check lives in the preview rather than in `npm test` because it is a
  property of *assets*, and assets change only when art is imported; the test
  file stays pure, with no canvas and no images, like the art seam beside it.
- **This constrains the crowd more than anything else.** A crowd is the one
  element sitting directly behind the fighting, so it is silhouettes rim-lit
  from above, never faces. That choice is downstream of this ADR, not
  independent of it.
- **The scoreboard's data slot is placed high** (above y≈200) and dark. When it
  eventually shows real numbers, lit text in the play band would be the single
  most likely way to fail the contrast gate.
- **A second Stage inherits the constraint, not the theme.** Nothing here
  requires baseball or night *specifically* — a future Stage could be a lit
  kitchen at midnight or the inside of a grill. What it cannot be is bright
  behind white HUD text. If someone genuinely wants a day Stage, the honest
  path is to fix the UI first (text plates, a re-coloured blast zone) and then
  build it; this ADR is a statement about the order of that work, not a ban.
- **The reverse is now cheap.** Because the Stage draws per-surface with the
  primitives as fallback, and placement lives in readable coordinates in
  `brawl-stage.js`, a Stage that fails the gate can be reverted one piece at a
  time rather than all at once.
