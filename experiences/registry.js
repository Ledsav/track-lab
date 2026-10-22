/* =============================================================================
   Experience registry: the hub renders one card per entry, in this order.
   `node scripts/new-experience.mjs <slug> "<Title>"` appends a new entry here.

   slug     folder name under experiences/ (also the URL: /experiences/<slug>/)
   title    card heading
   blurb    one or two sentences
   tracker  what it tracks: 'hands' | 'face' | 'pose' | …
   tags     short labels shown on the card
   cover    { glyph, colors:[…] }  big character + gradient stops for the card art
   added    YYYY-MM-DD
   ============================================================================= */
export const experiences = [
  {
    slug: 'cursed-hands',
    title: 'Cursed Hands',
    blurb: 'Jujutsu Kaisen hand seals. Cross your fingers to open Unlimited Void, charge Blue and Red, flick out Hollow Purple.',
    tracker: 'hands',
    tags: ['gestures', 'webaudio', 'vfx'],
    cover: { glyph: '呪', colors: ['#2846ff', '#c21f2a', '#8232e6'] },
    added: '2026-10-22',
  },
];
