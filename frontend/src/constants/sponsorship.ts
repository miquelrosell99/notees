/**
 * Sponsorship and support links for Notees.
 *
 * These URLs point to the official project sponsorship channels.
 * Replace the placeholder values below with the real links before release.
 */

/** Primary GitHub Sponsors profile URL */
export const GITHUB_SPONSORS_URL = 'https://github.com/sponsors/notees';

/** Ko-fi / Buy Me a Coffee one-time tip URL */
export const KO_FI_URL = 'https://ko-fi.com/notees';

/** Open Collective organization backing URL */
export const OPEN_COLLECTIVE_URL = 'https://opencollective.com/notees';

/** Contact email for sponsorship or invoicing inquiries */
export const SPONSORSHIP_EMAIL = 'sponsors@notees.app';

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
  {
    id: 'open-collective',
    name: 'Open Collective',
    description: 'Organization backing with invoicing support.',
    url: OPEN_COLLECTIVE_URL,
    icon: 'mdi mdi-account-group',
  },
];

/** The channel treated as the default/primary call to action */
export const PRIMARY_SPONSORSHIP_CHANNEL = SPONSORSHIP_CHANNELS[0];
