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
    blurb: 'Jujutsu Kaisen hand seals with Japanese call-outs. Open Unlimited Void, flick Blue, Red and Hollow Purple, then survive waves of cursed spirits.',
    tracker: 'hands',
    tags: ['gestures', 'game', 'voice', 'vfx'],
    cover: { glyph: '呪', colors: ['#2846ff', '#c21f2a', '#8232e6'] },
    added: '2026-10-22',
  },
];
