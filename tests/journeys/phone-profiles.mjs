import { devices } from 'playwright';

// 320px (two phones), 390px and an iPad: every touch profile runs every journey.
// Two of them prefer reduced motion, so its fallback is audited on every screen.
export const journeyProfiles = [
  { name: 'chromium', viewport: { width: 1440, height: 960 } },
  { name: 'iphone', ...devices['iPhone SE'] },
  { name: 'small-android', ...devices['Galaxy S9+'], reducedMotion: 'reduce' },
  { name: 'phone-390', ...devices['iPhone 13'], reducedMotion: 'reduce' },
  { name: 'ipad', ...devices['iPad Mini'] },
];
