/* =============================================================================
   Experience registry: the hub renders one card per entry, in this order.
   `node scripts/new-experience.mjs <slug> "<Title>"` appends a new entry here.

   slug     folder name under experiences/ (also the URL: /experiences/<slug>/)
   title    card heading
   blurb    one or two sentences
   tracker  what it tracks: 'hands' | 'face' | 'pose' | …
   tags     short labels shown on the card
   cover    { glyph, colors:[…], logo? }  card art: gradient stops + logo (brand/<slug>/mark.svg), glyph as fallback
   added    YYYY-MM-DD
   ============================================================================= */
export const experiences = [
  {
    slug: 'cursed-hands',
    title: 'Cursed Hands',
    blurb: 'Jujutsu Kaisen hand seals with Japanese call-outs. Open Unlimited Void, flick Blue, Red and Hollow Purple, then survive waves of cursed spirits.',
    tracker: 'hands + face',
    tags: ['gestures', 'game', 'voice', 'face filters'],
    cover: { glyph: '呪', colors: ['#2846ff', '#c21f2a', '#8232e6'], logo: 'brand/cursed-hands/mark.svg' },
    added: '2026-10-22',
  },
  {
    slug: 'frame-it',
    title: 'Frame It',
    blurb: 'An instant camera made of your fingers. Hold your hands like a camera to see the world through another lens, then press a finger like a shutter to print a polaroid.',
    tracker: 'hands',
    tags: ['camera', 'gestures', 'polaroid', 'lenses'],
    cover: { glyph: '◰', colors: ['#e8a33a', '#d2402a', '#2b2622'], logo: 'brand/frame-it/mark.svg' },
    added: '2026-10-22',
  },
];
