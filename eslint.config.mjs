import babelParser from '@babel/eslint-parser';
import html from 'eslint-plugin-html';
import client from './scripts/client-lint-rules.mjs';

const message = 'Use createPageBudget / createRequestBudget for bounded reads; use TanStack Query refetchInterval for React polling. Audited sites need an inline reason naming the bound.';

export default [
  { ignores: ['**/vendor/**', '**/*.generated.js', '**/*.d.{ts,mts,cts}'] },
  {
    files: ['{js,src,reports,tours,public-shell}/**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx,html}', '*.html'],
    plugins: { html, client },
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins: ['typescript', 'jsx'] } },
      },
    },
    rules: {
      'client/no-scheduler-alias': 'error',
      'client/bounded-exemption': 'error',
      'no-restricted-syntax': ['error',
        { selector: 'VariableDeclarator:matches([init.name=/^(EventSource|WebSocket)$/], [init.property.name=/^(EventSource|WebSocket)$/], [init.property.value=/^(EventSource|WebSocket)$/])', message },
        { selector: 'ObjectPattern > Property:matches([key.name=/^(EventSource|WebSocket)$/], [key.value=/^(EventSource|WebSocket)$/])', message },
        { selector: ':matches(WhileStatement, DoWhileStatement, ForStatement, ForOfStatement[await=true], ForOfStatement:has(AwaitExpression), ForInStatement:has(AwaitExpression))', message },
        { selector: 'FunctionDeclaration[id.name=/^create(Page|Request)Budget$/]', message },
        { selector: ':matches(CallExpression, NewExpression):matches([callee.name=/^(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback|queueMicrotask|EventSource|WebSocket)$/], [callee.property.name=/^(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback|queueMicrotask|EventSource|WebSocket)$/], [callee.property.value=/^(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback|queueMicrotask|EventSource|WebSocket)$/])', message },
        { selector: ':matches(CallExpression, NewExpression):matches([callee.name=/retry|reconnect|refetchInterval/i], [callee.property.name=/retry|reconnect|refetchInterval/i], [callee.property.value=/retry|reconnect|refetchInterval/i])', message },
        { selector: 'Property:matches([key.name=/retry|reconnect|refetchInterval/i], [key.value=/retry|reconnect|refetchInterval/i])', message },
        { selector: 'CallExpression:matches([callee.name="addEventListener"], [callee.property.name="addEventListener"], [callee.property.value="addEventListener"]):not([arguments.0.type="Literal"][arguments.0.value!=/^(focus|online|visibilitychange|pageshow)$/])', message },
      ],
    },
  },
];
