export default {
  id: 'invoices',
  files: [
    'invoices.html',
    'css/invoice-tracker.css',
    'js/invoice-tracker.js',
    'js/invoice-tracker-model.js',
    'js/invoice-tracker-fixture.js',
    'test/invoice-tracker.test.mjs',
    'test/invoice-tracker-browser.test.mjs',
  ],
  navigation: [{ label: 'Invoices', href: '/invoices', group: 'Workspace', order: 6.5 }],
  activeRoutes: {},
  sections: [],
};
