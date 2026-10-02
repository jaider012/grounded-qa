import type { ChunkInput } from './chunking.js';

export const CATERING_SOURCE = 'Bonaire Bites Catering Menu';

export interface CateringSection {
  title: string;
  body: string;
}

export const CATERING_SECTIONS: readonly CateringSection[] = [
  {
    title: 'Packages',
    body: 'We offer three catering packages: Casual (serves up to 20, $350), Classic (serves up to 40, $650), and Celebration (serves up to 75, $1,200). All packages include setup and cleanup.',
  },
  {
    title: 'Lead time',
    body: "Catering orders require at least 5 business days' notice. Orders placed with less notice are accommodated only if kitchen capacity allows, and may carry a 15% rush fee.",
  },
  {
    title: 'Dietary notes',
    body: 'All three catering packages can be made gluten-free on request at no extra charge. Vegan catering is available only for the Classic and Celebration packages.',
  },
  {
    title: 'Delivery',
    body: 'Catering delivery is included within our normal 5-kilometer delivery radius. Outside that radius, delivery is available for an additional $30 flat fee, regardless of order size.',
  },
];

/**
 * Builds one retrieval chunk per catering menu section. Every section is
 * prefixed with its title (the same "Title: body" format the FAQ uses),
 * which also helps retrieval.
 */
export function cateringChunks(): ChunkInput[] {
  return CATERING_SECTIONS.map(({ title, body }) => ({
    location: title,
    text: `${title}: ${body}`,
  }));
}
