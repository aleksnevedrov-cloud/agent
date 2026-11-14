// Собирает docs/menu.html из .claude/skills/menu/SKILL.md: заголовки «## » — группы, таблицы — команды.
// Запуск: node scripts/build-menu.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, '.claude/skills/menu/SKILL.md'), 'utf8');
const body = source.replace(/^---\n[\s\S]*?\n---\n/, '');

const escape = (s) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Разбивает строку таблицы на ячейки, сохраняя `|` внутри обратных кавычек.
function splitRow(line) {
  const cells = [];
  let cur = '';
  let inCode = false;
  for (const ch of line.slice(1, line.endsWith('|') ? -1 : undefined)) {
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// Код в ячейке → отдельная кнопка «Копировать» на каждый фрагмент; остальное — текст.
function renderCell(text, copyable) {
  const parts = text.split(/(`[^`]+`)/);
  return parts
    .map((p) => {
      // В колонке с кнопками запятые между командами не нужны: каждая команда — отдельная строка.
      if (!p.startsWith('`')) return copyable && /^[\s,;]*$/.test(p) ? '' : escape(p);
      const code = p.slice(1, -1);
      return copyable
        ? `<button class="cmd" type="button" data-cmd="${escape(code)}" title="Скопировать"><code>${escape(code)}</code><span class="copy">Копировать</span></button>`
        : `<code>${escape(code)}</code>`;
    })
    .join('');
}

const groups = [];
let current = null;
let table = null;
for (const line of body.split('\n')) {
  if (line.startsWith('## ')) {
    current = { title: line.slice(3).trim(), rows: [], notes: [] };
    groups.push(current);
    table = null;
    continue;
  }
  if (!current) continue;
  if (line.startsWith('|')) {
    const cells = splitRow(line);
    if (cells.every((c) => /^-+$/.test(c))) continue;
    if (!table) {
      table = { header: cells };
      current.header = cells;
      continue;
    }
    current.rows.push(cells);
    continue;
  }
  table = null;
  if (line.trim()) current.notes.push(line.trim());
}

const shown = groups.filter((g) => g.rows.length || g.notes.length);
const sections = shown
  .map((g, i) => {
    const id = `g${i}`;
    const head = (g.header ?? []).map((h) => `<th>${escape(h)}</th>`).join('');
    const rows = g.rows
      .map(
        (r) =>
          `<tr>${r
            .map((c, j) => `<td>${renderCell(c, j !== 1)}</td>`)
            .join('')}</tr>`,
      )
      .join('\n');
    const notes = g.notes
      .filter((n) => !n.startsWith('Страница с кнопками'))
      .map((n) => `<p class="note">${renderCell(n, false)}</p>`)
      .join('\n');
    const table = g.rows.length
      ? `<table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table>`
      : '';
    return `<section id="${id}">\n<h2>${escape(g.title)}</h2>\n${table}\n${notes}\n</section>`;
  })
  .join('\n');

const nav = shown
  .map((g, i) => `<a href="#g${i}">${escape(g.title)}</a>`)
  .join('');

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Шпаргалка: навыки и команды — AI-агент продаж дверей</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1b1b1f; --muted:#6b6b73; --line:#e3e3e0; --accent:#245c9b; --ok:#1d7a46; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#15161a; --card:#1e2026; --ink:#ececf0; --muted:#9a9aa6; --line:#2d2f37; --accent:#7fb2ee; --ok:#5fcf8d; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  header { padding:28px 24px 12px; max-width:1100px; margin:0 auto; }
  h1 { margin:0 0 6px; font-size:22px; }
  header p { margin:0; color:var(--muted); }
  nav { display:flex; flex-wrap:wrap; gap:8px; padding:12px 24px 4px; max-width:1100px; margin:0 auto; }
  nav a { font-size:13px; padding:4px 10px; border:1px solid var(--line); border-radius:999px; color:var(--ink); text-decoration:none; background:var(--card); }
  nav a:hover { border-color:var(--accent); }
  main { max-width:1100px; margin:0 auto; padding:8px 24px 48px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin:16px 0; }
  h2 { margin:0 0 10px; font-size:17px; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-weight:600; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; padding:6px 8px; border-bottom:1px solid var(--line); }
  td { padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  td:nth-child(1) { width:28%; } td:nth-child(3) { width:34%; }
  code { font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:rgba(127,127,127,.12); padding:1px 5px; border-radius:4px; word-break:break-word; }
  td:nth-child(3) .cmd { display:flex; }
  .cmd { display:inline-flex; align-items:center; gap:8px; margin:2px 0; padding:0; border:0; background:none; color:inherit; text-align:left; cursor:pointer; font:inherit; max-width:100%; }
  .cmd code { border:1px solid var(--line); background:var(--bg); padding:4px 8px; }
  .cmd .copy { font-size:12px; color:var(--accent); white-space:nowrap; opacity:0; transition:opacity .15s; }
  .cmd:hover .copy, .cmd:focus-visible .copy { opacity:1; }
  .cmd.done .copy { color:var(--ok); opacity:1; }
  .cmd:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:4px; }
  .note { margin:10px 0 0; color:var(--muted); font-size:14px; }
  footer { max-width:1100px; margin:0 auto; padding:0 24px 32px; color:var(--muted); font-size:13px; }
  @media (max-width: 720px) { td:nth-child(1), td:nth-child(3) { width:auto; } thead { display:none; } tr { display:block; padding:8px 0; } td { display:block; border:0; padding:2px 0; } tr + tr { border-top:1px solid var(--line); } }
</style>
</head>
<body>
<header>
  <h1>Шпаргалка: навыки и команды</h1>
  <p>Нажмите на команду, чтобы скопировать. В сессии Claude Code та же справка открывается по <strong>/menu</strong>.</p>
</header>
<nav>${nav}</nav>
<main>
${sections}
</main>
<footer>Собрано из <code>.claude/skills/menu/SKILL.md</code> командой <code>node scripts/build-menu.mjs</code>. Правьте SKILL.md, затем пересоберите страницу.</footer>
<script>
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.cmd');
  if (!btn) return;
  const text = btn.dataset.cmd;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  const label = btn.querySelector('.copy');
  const prev = label.textContent;
  label.textContent = 'Скопировано';
  btn.classList.add('done');
  setTimeout(() => { label.textContent = prev; btn.classList.remove('done'); }, 1400);
});
</script>
</body>
</html>
`;

writeFileSync(join(root, 'docs/menu.html'), html);
console.log(`docs/menu.html: ${shown.length} групп, ${groups.reduce((n, g) => n + g.rows.length, 0)} команд`);
