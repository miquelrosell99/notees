/**
 * Sponsorship and support links for Notees.
 *
 * These URLs point to the official project sponsorship channels.
 */

/** Primary GitHub Sponsors profile URL */
export const GITHUB_SPONSORS_URL = 'https://github.com/sponsors/miquelrosell99';

/** Ko-fi / Buy Me a Coffee one-time tip URL */
export const KO_FI_URL = 'https://ko-fi.com/miquelrosell';

/** Contact email for sponsorship or invoicing inquiries.
 * Replace with a real project email before enabling public sponsorship flows. */
export const SPONSORSHIP_EMAIL = 'sponsorship@notees.local';

export interface SponsorshipChannel {
  id: string;
  name: string;
  description: string;
  url: string;
  icon: string;
}

export const SPONSORSHIP_CHANNELS: SponsorshipChannel[] = [
  {
    id: 'github-sponsors',
    name: 'GitHub Sponsors',
    description: 'Recurring support with public recognition.',
    url: GITHUB_SPONSORS_URL,
    icon: 'mdi mdi-github',
  },
  {
    id: 'ko-fi',
    name: 'Ko-fi',
    description: 'One-time tip for users who prefer not to subscribe.',
    url: KO_FI_URL,
    icon: 'mdi mdi-coffee',
  },
];

/** The channel treated as the default/primary call to action */
export const PRIMARY_SPONSORSHIP_CHANNEL = SPONSORSHIP_CHANNELS[0];
