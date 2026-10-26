const tenantGuide = {
  label: 'CARR tenant representation guide',
  url: 'https://carr.us/blog/tenant-representation-everything-you-need-to-know/',
};
const tenantOnly = {
  label: 'CARR representation policy',
  url: 'https://carr.us/real-estate-resources/faqs/who-carr-doesnt-represent/',
};
const ethics = {
  label: 'NAR Code of Ethics, standards 1-5 and 1-13, Article 7',
  url: 'https://www.nar.realtor/about-nar/governing-documents/code-of-ethics/2026-code-of-ethics-standards-of-practice',
};

export const story = {
  title: 'Tenant representation',
  eyebrow: 'CARR / Healthcare real estate',
  connectionDurationMs: 1200,
  reviewNote: 'Review draft. Publication requires Joe\'s approval.',
  controls: { play: 'Play', pause: 'Pause', replay: 'Replay', progress: 'Story progress' },
  status: { ready: 'Ready to play', playing: 'Playing', paused: 'Paused', complete: 'Complete', reduced: 'Reduced motion. Read the full story below.' },
  scenes: [
    {
      durationMs: 8000,
      heading: 'Your practice needs space.',
      body: 'Your lease determines what that space costs. Look beyond the asking rent before you commit.',
      labels: ['Your practice', 'Your next lease'],
      sources: [tenantGuide],
    },
    {
      durationMs: 8000,
      heading: 'Who works for you?',
      body: 'The landlord\'s representative works for the landlord. When one brokerage represents both sides, its loyalties can conflict.',
      labels: ['Landlord', 'Your practice'],
      sources: [ethics],
    },
    {
      durationMs: 8000,
      heading: 'Follow the fee.',
      body: 'Without your own representative, the listing broker may keep the full commission. That does not guarantee you a lower rent.',
      labels: ['Listing broker', 'Full commission?'],
      sources: [tenantGuide],
    },
    {
      durationMs: 8000,
      heading: 'One side of the table.',
      body: 'CARR exclusively represents healthcare tenants and buyers. Who pays a broker and whom that broker represents are separate questions.',
      labels: ['Your practice', 'Your advocate'],
      sources: [tenantOnly, ethics],
    },
    {
      durationMs: 8000,
      heading: 'Compare the whole lease.',
      body: 'Rent, concessions, build-out and renewal terms all matter. Compare the full lease cost with an advocate for your practice. Savings are not guaranteed.',
      labels: ['Lease terms', 'Practice priorities'],
      sources: [tenantGuide],
    },
    {
      durationMs: 8000,
      heading: 'Before you sign, ask.',
      body: 'Whom do you represent? How are you paid? Broker compensation is negotiable. Ask for the representation and fee terms in writing.',
      labels: ['Clear representation', 'Written terms'],
      sources: [ethics],
    },
  ],
};
