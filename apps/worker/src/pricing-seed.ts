/* eslint-disable no-console -- консольная утилита: вывод для заказчика */
import { writeFile } from 'node:fs/promises';
import { loadEnv } from '@core/shared';
import { exportRulesXlsx, PricingRepo, RF_DVERI_SERVICES, withPresetServices } from '@retail/pricing';
import { buildCallsDeps } from './calls-deps.ts';

/**
 * RFD-AI-AGENT-RASCHET, п. 5: услуги РФ-Двери (монтаж, врезка, замер и т. д., источник rf-dveri.ru/ustanovka_dverej/)
 * в «Правила цен» аккаунта. Услуги с теми же кодами заменяются, остальные услуги, комплектующие и размеры остаются;
 * запись идёт через PricingRepo.save — с записью в аудит настроек, как сохранение из виджета.
 *
 *   docker compose exec worker node apps/worker/dist/pricing-seed.js --account 28528549 [--user <id пользователя amo>] [--dry-run]
 *   docker compose exec worker node apps/worker/dist/pricing-seed.js --xlsx /data/uslugi.xlsx   # файл для импорта на вкладке «Правила цен»
 */
const args = parseArgs(process.argv.slice(2));

if (typeof args.xlsx === 'string') {
  const { emptyRules } = await import('@retail/pricing');
  await writeFile(args.xlsx, await exportRulesXlsx(withPresetServices(emptyRules())));
  console.log(`Книга с ${RF_DVERI_SERVICES.length} услугами записана: ${args.xlsx}. Импорт — вкладка «Правила цен» → «Импорт XLSX» (комплектующие в файле пустые: при импорте они заменят текущие — проверьте).`);
  process.exit(0);
}

const accountId = Number(args.account);
if (!Number.isInteger(accountId) || accountId <= 0) fail('укажите --account <id аккаунта amo> или --xlsx <путь>');
const userId = args.user ? Number(args.user) : 0;
const dryRun = args['dry-run'] === true;

const env = loadEnv();
const { deps, db, close } = buildCallsDeps(env);
try {
  const account = await deps.accounts.get(accountId);
  if (!account || account.uninstalledAt) fail(`аккаунт ${accountId} не подключён`);
  const repo = new PricingRepo(db);
  const before = await repo.get(accountId);
  const after = withPresetServices(before.rules);
  const replaced = before.rules.services.filter((s) => RF_DVERI_SERVICES.some((p) => p.code === s.code)).length;
  console.log(`Аккаунт ${accountId}: было услуг ${before.rules.services.length} (из них заменяется ${replaced}), комплектующих ${before.rules.components.length}; станет услуг ${after.services.length}.`);
  for (const s of RF_DVERI_SERVICES) console.log(`  ${s.code.padEnd(24)} ${s.unit.padEnd(8)} ${String(s.price).padStart(6)} ₽${s.basePrice ? ` + база ${s.basePrice} ₽` : ''}${s.freeFromDoors ? ` · бесплатно от ${s.freeFromDoors} дверей` : ''}  ${s.name}`);
  if (dryRun) console.log('Проверка без записи (--dry-run): ничего не изменено.');
  else {
    const { version } = await repo.save(accountId, userId, after);
    console.log(`Записано: версия правил ${version}, запись в аудите настроек (пользователь ${userId || 'не указан'}). Проверить: виджет → «Правила цен».`);
  }
} finally {
  await close();
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

function fail(msg: string): never {
  console.error(`Ошибка: ${msg}`);
  process.exit(1);
}
