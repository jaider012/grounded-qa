import type { ChunkInput } from './chunking.js';

export const FAQ_SOURCE = 'Bonaire Bites FAQ';

export interface FaqSection {
  title: string;
  body: string;
}

export const FAQ_SECTIONS: readonly FaqSection[] = [
  {
    title: 'About',
    body: 'Bonaire Bites is a small chain of three casual restaurants located in Kralendijk, Bonaire, specializing in fresh seafood and local Caribbean fusion cuisine. We were founded in 2019 by chef Elena Martinez.',
  },
  {
    title: 'Hours',
    body: 'All three locations are open Tuesday through Sunday, 11:00 AM to 9:00 PM. We are closed on Mondays for staff training and kitchen deep-cleaning.',
  },
  {
    title: 'Reservations',
    body: 'Reservations are accepted for parties of 6 or more, up to 30 days in advance, by phone only — we do not currently accept online reservations. Parties of 5 or fewer are seated on a walk-in basis.',
  },
  {
    title: 'Dietary accommodations',
    body: 'We offer a dedicated gluten-free menu at all locations. Vegan options are available at our Kaya Grandi and Sabana Blas locations, but not yet at our smallest location, the Playa Lechi outpost.',
  },
  {
    title: 'Loyalty program',
    body: 'Our "Bites Club" loyalty program gives members one stamp per visit; 10 stamps earns a free entrée. Stamps do not expire, but they are not transferable between members.',
  },
  {
    title: 'Delivery',
    body: 'We deliver within a 5-kilometer radius of each location through our own driver network — we do not currently partner with third-party delivery apps. Delivery orders have a minimum of $25 and take approximately 40–50 minutes.',
  },
  {
    title: 'Private events',
    body: 'Only the Kaya Grandi location has a private event space, which seats up to 40 people and requires a minimum spend of $800 to book.',
  },
];

/**
 * Builds one retrieval chunk per FAQ section. The About section is used
 * as-is; every other section is prefixed with its title (mirroring the
 * FAQ's own "**Hours:** ..." format), which also helps retrieval.
 */
export function faqChunks(): ChunkInput[] {
  return FAQ_SECTIONS.map(({ title, body }) => ({
    location: title,
    text: title === 'About' ? body : `${title}: ${body}`,
  }));
}
