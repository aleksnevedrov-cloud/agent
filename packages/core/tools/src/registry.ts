import { catalogGetProduct } from './catalog-get-product.ts';
import { catalogSearch } from './catalog-search.ts';
import { doorComponents } from './door-components.ts';
import { crmAddNote } from './crm-add-note.ts';
import { crmGetContext } from './crm-get-context.ts';
import { crmHandoff } from './crm-handoff.ts';
import { knowledgeSearch } from './knowledge-search.ts';
import { crmCreateTask } from './crm-create-task.ts';
import { memorySave } from './memory-save.ts';
import { priceCalculate } from './price-calculate.ts';
import { siteLeadSummary } from './site-lead-summary.ts';
import type { AgentTool } from './types.ts';

/** Инструменты фазы 1. Порядок фиксирован — он входит в кэшируемый префикс запроса к LLM. */
export const PHASE1_TOOLS: readonly AgentTool[] = [
  catalogSearch,
  catalogGetProduct,
  doorComponents,
  knowledgeSearch,
  crmGetContext,
  crmAddNote,
  crmHandoff,
];

export function toolByName(tools: readonly AgentTool[], name: string): AgentTool | undefined {
  return tools.find((t) => t.name === name);
}

/** Инструменты фазы 2: + расчёт, задачи, память. */
export const PHASE2_TOOLS: readonly AgentTool[] = [
  ...PHASE1_TOOLS,
  priceCalculate,
  crmCreateTask,
  memorySave,
];

/**
 * RFD-SITE-CHAT-AGENT: канал site — только каталог, база знаний, комплектующие, расчёт, сводка заявки и передача
 * менеджеру. Без чтения других сделок, почты и переписок Wazzup (crm_get_context, crm_add_note, память не даются).
 */
export const SITE_TOOLS: readonly AgentTool[] = [catalogSearch, catalogGetProduct, doorComponents, knowledgeSearch, priceCalculate, siteLeadSummary, crmHandoff];
