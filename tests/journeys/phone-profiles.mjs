import { devices } from 'playwright';

export const journeyProfiles = [
  { name: 'chromium', viewport: { width: 1440, height: 960 } },
  { name: 'iphone', ...devices['iPhone SE'] },
  { name: 'small-android', ...devices['Galaxy S9+'] },
];

