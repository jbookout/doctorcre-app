import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const narration = String.raw`nothing\s+needs?\s+your?\b|what\s+needs?\s+your?\b|needs?\s+you\b|(?:deals?|things?)\s+that\s+need\s+you\b|(?:one|1)\s+thing\s+is\s+broken\b|nothing\s+is\s+(?:stuck|waiting\s+on\s+you)\b|everything\s+is\s+clear\b`;
// Internal vocabulary retired from partner screens: say deal, the call recorder, checked.
const internal = String.raw`work\s+records?\b|(?:re)?check(?:ing)?\s+quill\b|quill\s+local\s+recorder\b|with\s+quill\b|checked\s+by\s+jev\b|jev\s+checks\b|reason\s+not\s+yet\s+classified\b`;
const homeJargon = String.raw`reply\s+delivery\b|sent\s+records\s+a\s+send\s+outcome\b|check\s+the\s+recorder\b|call\s+recording\s+runs\s+on\s+the\s+mac\b|automatic\s+email\s+filings\b|call\s+evidence\b|(?:overdue\s+local\s+(?:next\s+steps|deals))\b|next\s+date\s*/\s*date\b|label\s*:\s*['"]Next date['"]|class=['"][^'"]*home-item-type[^'"]*['"]>Date<`;
const banned = new RegExp(String.raw`\b(?:${narration}|${internal}|${homeJargon})`, 'i');
const extensions = new Set(['.html', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.css', '.svg']);

export async function checkUiCopy(paths) {
  const violations = [];
  async function check(path) {
    if ((await stat(path)).isDirectory()) {
      for (const entry of await readdir(path)) if (entry !== 'vendor') await check(join(path, entry));
    } else if (extensions.has(extname(path))) {
      const source = await readFile(path, 'utf8');
      if (basename(path) === 'today-moves.mjs') {
        const { MOVE_FIELDS, todayMove } = await import(pathToFileURL(resolve(path)).href);
        const sentinel = 'internal_value_123';
        for (const field of [...MOVE_FIELDS, 'unknown_internal_field']) for (const value of [sentinel, { internal_key:sentinel, id:'abc' }]) {
          const { action } = todayMove({ deal_name:'Example Deal', field, move_value:value, move_name:sentinel, actor:sentinel, recorded_at:null, verb:'internal-verb-name' });
          if (/internal|\b(?:[a-z]+_)+[a-z0-9]+\b|123|abc/i.test(action)) violations.push(`${path}: unsafe Today move copy for ${field}`);
        }
      }
      const match = banned.exec(source);
      if (match) violations.push(`${path}:${source.slice(0, match.index).split('\n').length}: ${match[0]}`);
    }
  }
  for (const path of paths) await check(path);
  if (violations.length) throw new Error(`UI copy must state facts:\n${violations.join('\n')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3) throw new Error('UI copy lint requires source paths');
  await checkUiCopy(process.argv.slice(2));
}
