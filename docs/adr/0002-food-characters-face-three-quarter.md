# GlizzyBrawl's food Fighters face three-quarter, not in profile

`docs/glizzybrawl-art-brief.md` used to require "side view, facing right" for
every Fighter sprite, on the reasoning that a sidescroller mirrors for facing
and a 3/4 view mirrors badly. That rule was written for Kenney's borrowed human
bodies, and it is wrong for the characters that replaced them: the Arena's
Fighters now face **south-east** — a 3/4 view, turned toward the camera.

The reason is that **a food character has no readable profile.** A person in
profile still reads as a person: nose, chin, one eye, arms and legs at the
sides. The Glizzy in profile is a featureless orange lump — no face, no visible
arms, one leg hidden behind the other. Every generated side view had this
problem, and it isn't a generation failure to iterate away; it's the geometry
of a sausage in a bun. The face is the entire reason these sprites work at
64px, and a profile deletes it.

## Considered Options

- **Side view, facing right** — the previous rule, and what the first PixelLab
  rotation was generated for. Rejected on sight: the east and west rotations
  are unrecognisable as the character.
- **Straight-on south (front-facing)** — keeps the face at its most legible.
  Rejected because the body never turns, so every attack has to be sold by the
  pose alone, and there is no visual answer to "which way am I facing".
- **South-east 3/4** — chosen. Keeps the face, both arms, both legs and the
  mustard stripe, and carries an unambiguous direction for attacks to extend
  into.

## Consequences

- **The mirroring objection turned out not to bite.** The stated risk was that
  a flipped 3/4 view reads as a different character. At 64px with flat shading
  and a near-symmetric character it does not; the mirrored roster was played
  and judged fine. Generating a real south-west set is deferred, not rejected —
  the art is one `animate_character` call per animation group with
  `directions: ["south-west"]`, but the renderer would need to select a set
  instead of calling `scale(-1, 1)`, and the importer would need a facing in
  the filename. Do not start that work on aesthetic grounds alone; play the
  mirrored version first.
- **Both facings would double the frames per Fighter**, 10 to 20, and the
  filename scheme (`<fighter>_<pose>.png`) has no room for a facing today.
- **This applies to every remaining Fighter.** Ketchup, The Grill and Corn Dog
  are a bottle, a kettle and a battered sausage on a stick — all of them lose
  more in profile than a person would. Do not re-derive this per character.
- The rule that replaced it is narrower than "always use 3/4": *if the
  character's identity lives on one face of it, don't turn that face away.* A
  future Fighter with genuine bilateral structure could still be drawn in
  profile.
