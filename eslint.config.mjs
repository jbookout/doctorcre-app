import babelParser from '@babel/eslint-parser';
import html from 'eslint-plugin-html';

const message = 'Use createPageBudget / createRequestBudget for bounded reads; use TanStack Query refetchInterval for React polling. Audited local callbacks need an inline reason.';

export default [
  { ignores: ['**/vendor/**', '**/*.generated.js', '**/*.d.{ts,mts,cts}'] },
  {
    files: ['{js,src,reports,tours,public-shell}/**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx,html}', '*.html'],
    plugins: { html },
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins: ['typescript', 'jsx'] } },
      },
    },
    rules: {
      'no-restricted-syntax': ['error',
        { selector: 'CallExpression[callee.name=/^(setInterval|setTimeout|requestAnimationFrame)$/]', message },
        { selector: 'CallExpression[callee.type="MemberExpression"][callee.computed=false][callee.property.name=/^(setInterval|setTimeout|requestAnimationFrame)$/]', message },
        { selector: 'CallExpression[callee.type="MemberExpression"][callee.computed=true][callee.property.value=/^(setInterval|setTimeout|requestAnimationFrame)$/]', message },
        { selector: 'NewExpression[callee.name=/^(EventSource|WebSocket)$/]', message },
        { selector: 'NewExpression[callee.type="MemberExpression"][callee.computed=false][callee.property.name=/^(EventSource|WebSocket)$/]', message },
        { selector: 'NewExpression[callee.type="MemberExpression"][callee.computed=true][callee.property.value=/^(EventSource|WebSocket)$/]', message },
        { selector: 'CallExpression:matches([callee.name="addEventListener"], [callee.property.name="addEventListener"], [callee.computed=true][callee.property.value="addEventListener"])[arguments.0.value=/^(focus|online|visibilitychange)$/]', message },
      ],
    },
  },
  {
    files: ['js/read-budget.mjs', 'js/request-budget.mjs'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
