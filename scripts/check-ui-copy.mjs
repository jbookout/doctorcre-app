import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const narration = String.raw`nothing\s+needs?\s+your?\b|what\s+needs?\s+your?\b|needs?\s+you\b|(?:deals?|things?)\s+that\s+need\s+you\b|(?:one|1)\s+thing\s+is\s+broken\b|nothing\s+is\s+(?:stuck|waiting\s+on\s+you)\b|everything\s+is\s+clear\b`;
// Internal vocabulary retired from partner screens: say deal, the call recorder, checked.
const internal = String.raw`work\s+records?\b|(?:re)?check(?:ing)?\s+quill\b|quill\s+local\s+recorder\b|with\s+quill\b|checked\s+by\s+jev\b|jev\s+checks\b|reason\s+not\s+yet\s+classified\b`;
const banned = new RegExp(String.raw`\b(?:${narration}|${internal})`, 'i');
const extensions = new Set(['.html', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.css', '.svg']);

export async function checkUiCopy(paths) {
  const violations = [];
  async function check(path) {
    if ((await stat(path)).isDirectory()) {
      for (const entry of await readdir(path)) if (entry !== 'vendor') await check(join(path, entry));
    } else if (extensions.has(extname(path))) {
      const source = await readFile(path, 'utf8');
      if (basename(path) === 'today-moves.mjs') {
        const { todayMoveSentence } = await import(pathToFileURL(resolve(path)).href);
        for (const field of ['unknown_internal_field', 'phase', 'owner', 'status', 'client_id', 'document.sent_status']) {
          const sentinel = 'internal_value_123';
          const sentence = todayMoveSentence({ deal_name:'Example Deal', field, move_value:sentinel, recorded_at:null, verb:'internal-verb-name' });
          if (/internal[_-]|\b(?:[a-z]+_)+[a-z0-9]+\b|internal-verb-name|123/.test(sentence)) violations.push(`${path}: unsafe Today move copy`);
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
