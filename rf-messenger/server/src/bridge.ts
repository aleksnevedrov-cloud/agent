import { z } from 'zod';
import { AmojoError, type AmojoClient, type AmojoMessage, type AmojoMessageKind, type AmojoUser, type NewMessagePayload } from './amojo/client.ts';
import { chooseContact, exactPhoneMatches, phoneTail, phoneTail4 } from './amo/contact-match.ts';
import { AmoRestError, type AmoRest } from './amo/rest.ts';
import { CHAT_START_KINDS, KIND_TEXT, PACED_KINDS } from './channels.ts';
import { normalizePhone, PermanentSendError, type Connector, type InboundEvent } from './connectors/types.ts';
import type { ChatEvents } from './events.ts';
import type { FileStore } from './files.ts';
import { SEND_DEADLINE_MS, SEND_TIMEOUT_MS, type JobData, type JobQueue, type Pacer } from './queue.ts';
import { downloadFromAmo, type Resolver } from './safe-fetch.ts';
import type { Channel, Chat, Message, Store } from './store.ts';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface BridgeDeps {
  store: Store;
  files: FileStore;
  amojo: AmojoClient | null;
  queue: JobQueue;
  pacer: Pacer;
  /** Запущенный коннектор канала (есть только в процессе коннекторов). */
  connector: (channelId: number) => Connector | undefined;
  amoDomains: readonly string[];
  log: Logger;
  /** Пауза «печатает…» перед отправкой, мс. */
  typingMs?: number;
  fetch?: typeof fetch;
  resolve?: Resolver;
  /** Сколько ждать скачивания вложения из канала (по умолчанию 90 с). Дольше — сообщение уходит в amo без файла. */
  mediaTimeoutMs?: number;
  /** REST API amoCRM (OAuth интеграции): нужен для «Написать первым». */
  rest?: AmoRest | null;
  /** События для окна переписки (SSE). */
  events?: ChatEvents;
  /** Поиск контакта по номеру: таймаут (5 с) и срок кэша (10 мин). */
  contactLookupTimeoutMs?: number;
  contactCacheTtlMs?: number;
  /** MAX без номера в вебхуке: запрос номера у мессенджера не чаще раза в 10 минут на чат (ТЗ 22.11, п. 2.2). */
  phoneLookupRetryMs?: number;
  /** Поле контакта amoCRM с id собеседника MAX от Wazzup («MaxId_WZ»); пусто — поиск по полю выключен (п. 2.4). */
  maxIdField?: string;
  now?: () => number;
  /** Вся отправка одного сообщения в мессенджер (по умолчанию 20 с, п. 4.3). */
  sendTimeoutMs?: number;
  /** Срок жизни исходящего в очереди (по умолчанию 2 мин, п. 4.7). */
  sendDeadlineMs?: number;
}

/** Отправка из окна переписки в карточке: текст и/или файлы в существующий чат от имени сотрудника. */
export interface WindowSendInput {
  accountId: number;
  userId: number;
  chatId: number;
  text: string;
  replyToMessageId?: number | null;
  fileIds?: string[];
}

/** Вид сообщения по MIME загруженного файла. */
export function kindOfMime(mime: string, name = ''): Exclude<AmojoMessageKind, 'text'> {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return m === 'image/webp' && /sticker/i.test(name) ? 'sticker' : 'picture';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return /ogg|opus|webm/.test(m) ? 'voice' : 'audio';
  return 'file';
}

/** Ошибка «Написать первым», которую показываем менеджеру как есть. */
export class StartChatError extends Error {}

export interface StartChatInput {
  accountId: number;
  /** Сотрудник amoCRM, нажавший «Написать первым» (из токена виджета). */
  userId: number;
  channelId: number;
  contactId: number;
  /** WhatsApp, Telegram личный: номер клиента. */
  phone?: string;
  /** VK, MAX: существующий чат с клиентом, который уже писал сообществу или боту. */
  chatId?: number;
  text: string;
}

/** Сообщение без задачи to-amo дольше этого срока считается зависшим и ставится в очередь заново. */
export const STUCK_INBOUND_AFTER_SEC = 300;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${Math.round(ms / 1000)} с`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const KINDS = new Set<AmojoMessageKind>(['text', 'picture', 'file', 'video', 'voice', 'audio', 'sticker']);

/** Вебхук amo (hook_api_version v2) об исходящем сообщении менеджера или Salesbot. */
const hookSchema = z.object({
  message: z.object({
    conversation: z.object({ client_id: z.string().optional(), id: z.string().optional() }),
    // Кто написал из amo: id сотрудника (или бота) в API чатов и его имя.
    sender: z.object({ id: z.string().min(1).max(100), name: z.string().max(200).optional() }).passthrough().optional(),
    message: z.object({
      id: z.string(),
      type: z.string(),
      text: z.string().optional().default(''),
      media: z.string().optional().default(''),
      file_name: z.string().optional().default(''),
      file_size: z.coerce.number().optional().default(0),
      reply_to: z.object({ message: z.object({ id: z.string().optional() }).passthrough() }).optional(),
    }),
  }),
});

export type HookResult = 'queued' | 'duplicate' | 'unknown_chat' | 'ignored';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ourMsgid = (id: number) => `rfm-m${id}`;

/** Мост: события каналов ↔ API чатов amoCRM. */
export class Bridge {
  constructor(private readonly d: BridgeDeps) {}

  /** Очередь по чату: передача в amo для одного чата идёт строго по одному (ответ клиента не обгонит привязку). */
  private readonly chatLocks = new Map<number, Promise<unknown>>();
  private perChat<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.chatLocks.get(chatId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.chatLocks.set(chatId, settled);
    void settled.then(() => {
      if (this.chatLocks.get(chatId) === settled) this.chatLocks.delete(chatId);
    });
    return run;
  }

  /** Кэш поиска контакта по номеру: аккаунт + последние 10 цифр → id контакта или null, 10 минут. */
  private readonly contactCache = new Map<string, { contactId: number | null; at: number }>();

  /**
   * Новый чат без привязки в amoCRM: до первого сообщения ищем контакт по номеру собеседника и привязываем чат к нему,
   * чтобы amo не завёл дубль контакта и заявку в неразобранном. Возвращает, что сделано (для журнала и тестов).
   */
  /** Последний запрос номера у мессенджера по чату (мс) — повтор не чаще phoneLookupRetryMs. */
  private readonly phoneLookupAt = new Map<number, number>();

  /**
   * RFD-MESSENGER (22.11.2026): личный чат MAX по номеру без номера в вебхуке и без привязки — до первого сообщения
   * в amo спросить номер у GREEN-API (getContactInfo → getChats). Номер есть → в chats.contact.phone, дальше обычная
   * привязка по номеру. Ошибка или таймаут — сообщение не теряется, в журнал предупреждение; повтор по чату не чаще
   * раза в 10 минут. Группы, чаты с привязкой («Написать») и другие каналы — без изменений.
   */
  async resolveUnknownPhone(chat: Chat): Promise<'skipped' | 'found' | 'none' | 'failed'> {
    if (chat.amojoChatId || chat.isGroup || chat.contact.phone) return 'skipped';
    const channel = await this.d.store.channelById(chat.channelId);
    if (!channel || channel.kind !== 'max_phone') return 'skipped';
    const connector = this.d.connector(chat.channelId);
    if (!connector?.lookupPhone) return 'skipped';
    const now = (this.d.now ?? Date.now)();
    const last = this.phoneLookupAt.get(chat.id);
    if (last !== undefined && now - last < (this.d.phoneLookupRetryMs ?? 600_000)) return 'skipped';
    this.phoneLookupAt.set(chat.id, now);
    let phone: string | null;
    try {
      phone = await withTimeout(connector.lookupPhone(chat.externalChatId), this.d.contactLookupTimeoutMs ?? 5000, 'запрос номера у мессенджера');
    } catch (err) {
      this.d.log.warn({ chatId: chat.id, channel: channel.kind, err: (err as Error).message }, 'номер собеседника MAX не получен — сообщение уйдёт без привязки');
      return 'failed';
    }
    if (!phone) {
      this.d.log.info({ chatId: chat.id, channel: channel.kind, result: 'номера нет' }, 'номер собеседника MAX: мессенджер номер не отдал');
      return 'none';
    }
    chat.contact = { ...chat.contact, phone };
    await this.d.store.mergeChatContact(chat.id, { phone });
    this.d.log.info({ chatId: chat.id, channel: channel.kind, result: 'номер получен', phone: phoneTail4(phone) }, 'номер собеседника MAX получен у GREEN-API');
    return 'found';
  }

  /**
   * П. 2.4: номера нет → контакт по полю Wazzup с id собеседника (точное совпадение с chatId). Только для MAX по номеру
   * и только если поле задано (MAX_ID_FIELD) — после диагностики п. 2.3.
   */
  private async linkNewChatByMaxId(chat: Chat, conn: { scopeId: string }): Promise<'skipped' | 'none' | 'linked' | 'failed'> {
    const field = this.d.maxIdField;
    if (!field || chat.amojoChatId || chat.isGroup || chat.contact.phone || !this.d.rest || !this.d.amojo) return 'skipped';
    const channel = await this.d.store.channelById(chat.channelId);
    if (!channel || channel.kind !== 'max_phone') return 'skipped';
    let choice: ReturnType<typeof chooseContact>;
    try {
      const candidates = await withTimeout(this.d.rest.contactsByField(chat.accountId, field, chat.externalChatId), this.d.contactLookupTimeoutMs ?? 5000, `поиск контакта по полю ${field}`);
      choice = chooseContact(candidates);
    } catch (err) {
      this.d.log.warn({ chatId: chat.id, channel: channel.kind, field, err: (err as Error).message }, 'поиск контакта по полю не выполнен — сообщение уйдёт без привязки');
      return 'failed';
    }
    if (!choice) {
      this.d.log.info({ chatId: chat.id, channel: channel.kind, field, result: 'не найден' }, 'контакт по полю с id собеседника MAX не найден');
      return 'none';
    }
    return this.attachChatToContact(chat, conn, choice.contact.id, `найден по ${field}: ${choice.reason}`, { field });
  }

  /** Чат API чатов amo → привязка к контакту; ошибка (в т. ч. 409 «уже привязан») — в журнал, сообщение уйдёт как есть. */
  private async attachChatToContact(chat: Chat, conn: { scopeId: string }, contactId: number, reason: string, extra: Record<string, unknown>): Promise<'linked' | 'failed'> {
    if (!this.d.amojo || !this.d.rest) return 'failed';
    try {
      const { chatId: amojoChatId } = await this.d.amojo.createChat(conn.scopeId, chat.conversationId, this.clientUser(chat));
      await this.d.store.setAmojoChatId(chat.id, amojoChatId);
      chat.amojoChatId = amojoChatId;
      await this.d.rest.linkChat(chat.accountId, amojoChatId, contactId);
      this.d.log.info({ chatId: chat.id, contactId, reason, ...extra }, 'чат привязан к контакту amoCRM');
      await this.markMaxContact(chat, contactId);
      return 'linked';
    } catch (err) {
      this.d.log.warn({ chatId: chat.id, contactId, err: (err as Error).message, status: err instanceof AmoRestError ? err.status : undefined, ...extra }, 'привязка чата к контакту не выполнена — сообщение уйдёт без привязки');
      return 'failed';
    }
  }

  /**
   * RFD-MESSENGER 23.11: чат MAX по номеру привязан к контакту → id собеседника MAX записать в поле контакта
   * (MAX_ID_FIELD, то же «MaxId_WZ», что у Wazzup). Тогда клиент со скрытым номером найдётся по полю и в будущем.
   * Только личные чаты MAX по номеру; ошибка не мешает переписке — в журнал.
   */
  async markMaxContact(chat: Chat, contactId: number): Promise<'set' | 'same' | 'nofield' | 'skipped' | 'failed'> {
    const field = this.d.maxIdField;
    if (!field || chat.isGroup || !this.d.rest || !/^\d+$/.test(chat.externalChatId)) return 'skipped';
    const channel = await this.d.store.channelById(chat.channelId);
    if (!channel || channel.kind !== 'max_phone') return 'skipped';
    try {
      const r = await this.d.rest.setContactField(chat.accountId, contactId, field, chat.externalChatId);
      if (r === 'set') this.d.log.info({ chatId: chat.id, contactId, field }, 'контакт помечен id собеседника MAX');
      if (r === 'nofield') this.d.log.warn({ field }, 'поля для id собеседника MAX нет в контактах amoCRM');
      return r;
    } catch (err) {
      this.d.log.warn({ chatId: chat.id, contactId, field, err: (err as Error).message }, 'контакт не помечен id собеседника MAX');
      return 'failed';
    }
  }

  /**
   * Окно переписки, «Перенести в сделку»: чат (обычно дубль из неразобранного) — к основному контакту указанной сделки.
   * Дальше переписка идёт в эту сделку; клиент MAX помечается id собеседника. Дубль-сделку менеджер закрывает сам.
   */
  async moveChatToLead(input: { accountId: number; chatId: number; leadId: number }): Promise<{ contactId: number; contactName: string; marked: boolean }> {
    const chat = await this.d.store.chatById(input.chatId);
    if (!chat || chat.accountId !== input.accountId) throw new StartChatError('Чат не найден');
    if (chat.isGroup) throw new StartChatError('Групповой чат нельзя перенести в сделку');
    if (!this.d.rest || !this.d.amojo) throw new StartChatError('Нет доступа к amoCRM: интеграция не авторизована');
    const conn = await this.d.store.getConnection(input.accountId);
    if (!conn) throw new StartChatError('Канал чатов amoCRM не подключён к аккаунту');
    const contacts = await this.d.rest.leadContacts(input.accountId, input.leadId);
    const contact = contacts[0];
    if (!contact) throw new StartChatError(`У сделки ${input.leadId} нет контакта — добавьте контакт в сделку`);
    const { chatId: amojoChatId } = await this.d.amojo.createChat(conn.scopeId, chat.conversationId, this.clientUser(chat));
    if (chat.amojoChatId !== amojoChatId) await this.d.store.setAmojoChatId(chat.id, amojoChatId);
    chat.amojoChatId = amojoChatId;
    await this.d.rest.relinkChat(input.accountId, amojoChatId, contact.id);
    this.d.log.info({ chatId: chat.id, contactId: contact.id, leadId: input.leadId }, 'чат перенесён к контакту сделки вручную');
    const marked = (await this.markMaxContact(chat, contact.id)) !== 'failed';
    return { contactId: contact.id, contactName: contact.name, marked };
  }

  async linkNewChatToContact(chat: Chat, conn: { scopeId: string }): Promise<'skipped' | 'none' | 'linked' | 'failed'> {
    if (chat.amojoChatId || chat.isGroup) return 'skipped';
    const phone = chat.contact.phone;
    const tail = phone ? phoneTail(phone) : null;
    if (!phone || !tail) return this.linkNewChatByMaxId(chat, conn);
    if (!this.d.rest || !this.d.amojo) return 'skipped';
    const now = (this.d.now ?? Date.now)();
    const key = `${chat.accountId}:${tail}`;
    const cached = this.contactCache.get(key);
    let contactId: number | null;
    let reason = 'из кэша';
    try {
      if (cached && now - cached.at < (this.d.contactCacheTtlMs ?? 600_000)) {
        contactId = cached.contactId;
      } else {
        const candidates = await withTimeout(this.d.rest.contactsByPhone(chat.accountId, phone), this.d.contactLookupTimeoutMs ?? 5000, 'поиск контакта');
        const choice = chooseContact(exactPhoneMatches(candidates, phone));
        contactId = choice?.contact.id ?? null;
        reason = choice?.reason ?? 'контакт не найден';
        this.contactCache.set(key, { contactId, at: now });
      }
    } catch (err) {
      this.d.log.warn({ chatId: chat.id, phone: phoneTail4(phone), err: (err as Error).message }, 'поиск контакта по номеру не выполнен — сообщение уйдёт без привязки');
      return 'failed';
    }
    if (!contactId) return 'none';
    try {
      const { chatId: amojoChatId } = await this.d.amojo.createChat(conn.scopeId, chat.conversationId, this.clientUser(chat));
      await this.d.store.setAmojoChatId(chat.id, amojoChatId);
      chat.amojoChatId = amojoChatId;
      await this.d.rest.linkChat(chat.accountId, amojoChatId, contactId);
      this.d.log.info({ chatId: chat.id, contactId, phone: phoneTail4(phone), reason }, 'чат привязан к контакту amoCRM по номеру');
      await this.markMaxContact(chat, contactId);
      return 'linked';
    } catch (err) {
      // 409 — чат уже привязан к другому контакту в amo: оставляем как есть.
      this.d.log.warn({ chatId: chat.id, contactId, err: (err as Error).message, status: err instanceof AmoRestError ? err.status : undefined }, 'привязка чата к контакту не выполнена — сообщение уйдёт без привязки');
      return 'failed';
    }
  }

  // ---------- Канал → amoCRM ----------

  /** Событие коннектора: сохранить (с защитой от повторов), скачать вложение, поставить в очередь в amo. */
  async onInbound(channel: Channel, connector: Connector, ev: InboundEvent): Promise<void> {
    const chat = await this.d.store.upsertChat(channel, {
      externalChatId: ev.externalChatId,
      isGroup: ev.isGroup,
      title: ev.chatTitle,
      contact: ev.contact,
    });
    const msg = await this.d.store.insertFromChannel({
      chat,
      source: ev.fromMe ? 'phone' : 'client',
      kind: ev.attachment?.kind ?? 'text',
      text: ev.text,
      author: ev.author,
      externalId: ev.externalMessageId,
      replyToExternalId: ev.replyToExternalId,
    });
    if (!msg) return; // повтор события
    // Первое сообщение нового чата: подгрузить историю из мессенджера (WhatsApp, Telegram личный, MAX по номеру).
    if ((chat as Chat & { inserted?: boolean }).inserted && connector.history) {
      await this.d.queue.add('history', { messageId: 0, chatId: chat.id }, { jobId: `history-${chat.id}-first` }).catch(() => undefined);
    }
    if (ev.attachment) {
      // Тяжёлое — в отдельную очередь (п. 4.6): текст уходит в amo сразу, файл догоняет отдельным сообщением.
      // Без текста сообщение ждёт файл: иначе в amo пришла бы пустая заглушка.
      await this.d.queue.add('media', { messageId: msg.id, channelId: channel.id, attachment: ev.attachment }, { jobId: `media-${msg.id}` });
      if (ev.text.trim()) await this.d.queue.add('to-amo', { messageId: msg.id }, { jobId: `to-amo-${msg.id}` });
    } else {
      await this.d.queue.add('to-amo', { messageId: msg.id }, { jobId: `to-amo-${msg.id}` });
    }
    await this.d.events?.publish(chat.accountId, { type: 'message', chatId: chat.id, messageId: msg.id });
    // Правило счётчиков: входящее — красный +1; ответ с телефона — закрывает неотвеченные.
    await this.noteCounters(chat, ev.fromMe ? { by: 'reply', messageId: msg.id } : null, msg.createdAt);
  }

  /**
   * Задача media: скачать вложение входящего и поставить передачу в amo. Если текст уже ушёл — файл идёт
   * вторым сообщением (to-amo-media); если нет — обычным to-amo. После последней неудачи сообщение
   * уходит без файла, как «[Вложение не получено]».
   */
  async fetchInboundMedia(data: JobData, lastAttempt: boolean): Promise<void> {
    const msg = await this.d.store.messageById(data.messageId);
    if (!msg || msg.fileId || !data.attachment) return;
    const chat = await this.d.store.chatById(msg.chatId);
    const channel = chat ? await this.d.store.channelById(chat.channelId) : null;
    const connector = channel ? this.d.connector(channel.id) : undefined;
    const followUp = async () => {
      if (msg.amojoMsgid) await this.d.queue.add('to-amo-media', { messageId: msg.id }, { jobId: `to-amo-media-${msg.id}` });
      else await this.d.queue.add('to-amo', { messageId: msg.id }, { jobId: `to-amo-${msg.id}` });
    };
    try {
      if (!chat || !channel || !connector) throw new Error('Коннектор канала не запущен');
      const { data: bytes, mime } = await withTimeout(connector.download(data.attachment.ref, this.d.files.maxBytes), this.d.mediaTimeoutMs ?? 90_000, 'скачивание вложения');
      const file = await this.d.files.save({ accountId: channel.accountId, channelId: channel.id, data: bytes, name: data.attachment.name, mime: data.attachment.mime ?? mime });
      await this.d.store.setMessageFile(msg.id, file.id);
      this.d.log.info({ channelId: channel.id, messageId: msg.id, kind: data.attachment.kind, bytes: bytes.length }, 'вложение скачано');
      await followUp();
      await this.d.events?.publish(chat.accountId, { type: 'message', chatId: chat.id, messageId: msg.id });
    } catch (err) {
      this.d.log.warn({ channelId: channel?.id ?? data.channelId, messageId: msg.id, kind: data.attachment.kind, attempt: lastAttempt ? 'последняя' : 'повтор', err: (err as Error).message }, 'вложение не скачано');
      if (!lastAttempt) throw err;
      // Файла не будет: текст (если ещё не ушёл) передаём с пометкой; если текст уже в amo — ничего не добавляем.
      if (!msg.amojoMsgid) await this.d.queue.add('to-amo', { messageId: msg.id }, { jobId: `to-amo-${msg.id}` });
    }
  }

  /** Задача to-amo-media: файл входящего, скачанный после передачи текста, — отдельным сообщением в amo. */
  deliverMediaToAmo(messageId: number): Promise<void> {
    return this.d.store.messageById(messageId).then((msg) => (msg ? this.perChat(msg.chatId, () => this.deliverMediaToAmoNow(messageId)) : undefined));
  }

  private async deliverMediaToAmoNow(messageId: number): Promise<void> {
    const msg = await this.d.store.messageById(messageId);
    if (!msg || msg.source === 'amo' || !msg.amojoMsgid || msg.amojoMediaMsgid || !msg.fileId || msg.kind === 'text') return;
    const chat = await this.d.store.chatById(msg.chatId);
    if (!chat) return;
    const conn = await this.d.store.getConnection(chat.accountId);
    if (!conn || !this.d.amojo) throw new Error('Канал чатов amoCRM не подключён к аккаунту');
    const file = await this.d.store.fileById(msg.fileId);
    if (!file) return;
    const { sender, receiver, silent } = this.amoParties(msg, chat, conn.amoOperatorRef);
    const r = await this.d.amojo.sendMessage(conn.scopeId, {
      timestamp: Math.floor(msg.createdAt.getTime() / 1000),
      msec_timestamp: msg.createdAt.getTime(),
      msgid: `${ourMsgid(msg.id)}-media`,
      conversation_id: chat.conversationId,
      sender,
      ...(receiver ? { receiver } : {}),
      message: { type: msg.kind, media: this.d.files.signedUrl(file), file_name: file.name, file_size: file.size },
      silent,
    });
    await this.d.store.markMediaSynced(msg.id, r.msgid);
  }

  /**
   * Стороны сообщения в amo: от клиента — отправитель клиент; с телефона или из окна — отправитель сотрудник
   * (ref_id), получатель клиент, без уведомления. amo принимает исходящее только от своего пользователя.
   */
  private amoParties(msg: Message, chat: Chat, accountOperatorRef: string | null): { sender: NewMessagePayload['sender']; receiver: AmojoUser | null; silent: boolean } {
    const client = this.clientUser(chat);
    if (msg.source !== 'phone') return { sender: client, receiver: null, silent: false };
    const ref = chat.amoOperatorRef ?? accountOperatorRef;
    if (!ref) throw new Error('Сообщение с телефона: неизвестен сотрудник amoCRM — он определится, когда менеджер напишет клиенту из amoCRM');
    return { sender: { ref_id: ref }, receiver: client, silent: true };
  }

  /** Обновить счётчики «неотвеченных» и разослать их в окна. null — входящее от клиента. */
  private async noteCounters(chat: Chat, answer: { by: 'reply' | 'button'; messageId?: number | null; userId?: number | null } | null, at: Date = new Date()): Promise<Chat | null> {
    const updated = answer ? await this.d.store.noteAnswered(chat.id, answer.by, { messageId: answer.messageId ?? null, userId: answer.userId ?? null, at }) : await this.d.store.noteInbound(chat.id, at);
    if (updated) await this.d.events?.publish(chat.accountId, { type: 'counters', chatId: chat.id, unanswered: updated.unanswered, answered: updated.answered, lastAt: updated.lastMessageAt.toISOString() });
    return updated;
  }

  /** Кнопка «Отвечать не нужно»: неотвеченные закрываются без ответа; кто и когда — в БД и в журнал. */
  async noReply(accountId: number, chatId: number, userId: number): Promise<{ answered: number } | null> {
    const chat = await this.d.store.chatOfAccount(accountId, chatId);
    if (!chat) return null;
    const updated = await this.noteCounters(chat, { by: 'button', userId });
    this.d.log.info({ chatId, userId, closed: updated?.answered ?? 0, closedBy: 'button' }, 'нажата «Отвечать не нужно»');
    return { answered: updated?.answered ?? chat.answered };
  }

  /** Мессенджер сообщил, что наше сообщение доставлено или прочитано. */
  async onDelivery(channel: Channel, externalChatId: string, externalMessageId: string, status: 'delivered' | 'read'): Promise<void> {
    const chat = await this.d.store.chatByExternal(channel.id, externalChatId);
    if (!chat) return;
    const msg = await this.d.store.setStatusByExternal(chat.id, externalMessageId, status);
    if (!msg) return;
    await this.d.events?.publish(chat.accountId, { type: 'status', chatId: chat.id, messageId: msg.id, status });
    if (status === 'read' && msg.source === 'amo') {
      const conn = await this.d.store.getConnection(chat.accountId);
      if (conn && this.d.amojo && msg.amojoMsgid) await this.d.amojo.deliveryStatus(conn.scopeId, msg.amojoMsgid, 2).catch(() => undefined);
    }
  }

  /** Собеседник прочитал наши сообщения до maxMessageId (Telegram). */
  async onReadUpTo(channel: Channel, peerKey: string, maxMessageId: number): Promise<void> {
    const chat = await this.d.store.chatByPeerKey(channel.id, peerKey);
    if (!chat) return;
    const read = await this.d.store.markReadUpTo(chat.id, maxMessageId);
    if (!read.length) return;
    const conn = read.some((m) => m.source === 'amo' && m.amojoMsgid) ? await this.d.store.getConnection(chat.accountId) : null;
    for (const msg of read) {
      await this.d.events?.publish(chat.accountId, { type: 'status', chatId: chat.id, messageId: msg.id, status: 'read' });
      if (conn && this.d.amojo && msg.source === 'amo' && msg.amojoMsgid) await this.d.amojo.deliveryStatus(conn.scopeId, msg.amojoMsgid, 2).catch(() => undefined);
    }
  }

  /** Мессенджер сообщил, что наше сообщение не доставлено: статус «ошибка» в окне и в amoCRM. */
  async onSendFailed(channel: Channel, externalChatId: string, externalMessageId: string, reason: string): Promise<void> {
    const chat = await this.d.store.chatByExternal(channel.id, externalChatId);
    if (!chat) return;
    const msg = await this.d.store.failByExternal(chat.id, externalMessageId, reason);
    if (!msg) return;
    await this.reportStatus(chat, msg, -1, reason);
    await this.d.events?.publish(chat.accountId, { type: 'status', chatId: chat.id, messageId: msg.id, status: 'failed', error: reason });
  }

  /**
   * История переписки из мессенджера в нашу БД (последние 100 или старше самого старого известного).
   * В окне видна вся история; в ленту amoCRM не передаётся (from_history).
   */
  async importHistory(chatId: number, limit = 100): Promise<number> {
    const chat = await this.d.store.chatById(chatId);
    if (!chat) return 0;
    const channel = await this.d.store.channelById(chat.channelId);
    const connector = channel ? this.d.connector(channel.id) : undefined;
    if (!channel || !connector?.history) throw new Error('История недоступна для этого канала');
    const oldest = await this.d.store.oldestExternalMessage(chatId);
    const before = oldest?.externalId ? { externalMessageId: oldest.externalId, timestamp: Math.floor(oldest.createdAt.getTime() / 1000), fromMe: oldest.direction === 'out' } : null;
    const list = await withTimeout(connector.history(chat.externalChatId, limit, before), 60_000, 'история');
    let count = 0;
    for (const ev of list) {
      const msg = await this.d.store.insertFromChannel({
        chat,
        source: ev.fromMe ? 'phone' : 'client',
        kind: ev.attachment?.kind ?? 'text',
        text: ev.text,
        author: ev.author,
        externalId: ev.externalMessageId,
        replyToExternalId: ev.replyToExternalId,
        fromHistory: true,
        createdAt: new Date(ev.timestamp * 1000),
      });
      if (!msg) continue;
      count++;
      if (ev.attachment) {
        try {
          const { data, mime } = await withTimeout(connector.download(ev.attachment.ref, this.d.files.maxBytes), this.d.mediaTimeoutMs ?? 90_000, 'скачивание вложения');
          const file = await this.d.files.save({ accountId: channel.accountId, channelId: channel.id, data, name: ev.attachment.name, mime: ev.attachment.mime ?? mime });
          await this.d.store.setMessageFile(msg.id, file.id);
        } catch (err) {
          this.d.log.warn({ channelId: channel.id, messageId: msg.id, err: (err as Error).message }, 'вложение истории не скачано');
        }
      }
    }
    await this.d.events?.publish(chat.accountId, { type: 'history', chatId: chat.id, count });
    return count;
  }

  /**
   * Отправка из окна переписки или раздела (п. 4.1): сообщение сохраняется как «в очереди», ставится в очередь
   * канала и сразу возвращается в окно; клиенту его отправит процесс коннекторов (deliverToChannel), результат
   * придёт по SSE. В amoCRM уходит после отправки — как исходящее от этого сотрудника. Работает в процессе api.
   */
  async queueFromWindow(input: WindowSendInput): Promise<{ messageIds: number[] }> {
    const text = input.text.trim();
    const fileIds = input.fileIds ?? [];
    if (!text && !fileIds.length) throw new StartChatError('Пустое сообщение');
    const chat = await this.d.store.chatOfAccount(input.accountId, input.chatId);
    if (!chat) throw new StartChatError('Чат не найден');
    const channel = await this.d.store.channelById(chat.channelId);
    if (!channel) throw new StartChatError('Канал удалён');
    if (channel.status !== 'connected') throw new StartChatError(`${KIND_TEXT[channel.kind]} сейчас не подключён — проверьте канал в настройках виджета`);
    const quoted = input.replyToMessageId ? await this.d.store.messageById(input.replyToMessageId) : null;
    const replyToMessageId = quoted && quoted.chatId === chat.id ? quoted.id : null;
    let senderName: string | null = null;
    if (this.d.rest) {
      // Имя и amojo-ссылка сотрудника: не дольше 1,5 с, иначе отправляем без них (окно не должно ждать amo).
      const rest = this.d.rest;
      senderName = await withTimeout(rest.userName(input.accountId, input.userId), 1500, 'имя сотрудника').catch(() => null);
      const ref = await withTimeout(rest.userAmojoId(input.accountId, input.userId), 1500, 'ссылка сотрудника').catch(() => null);
      if (ref) await this.d.store.rememberAmoOperator(input.accountId, chat.id, ref);
    }
    const parts: { text: string; fileId: string | null; kind: AmojoMessageKind }[] = [];
    for (const fileId of fileIds.slice(0, 10)) {
      const rec = await this.d.store.fileById(fileId);
      if (!rec || rec.accountId !== input.accountId) throw new StartChatError('Файл не найден');
      parts.push({ text: parts.length === 0 ? text : '', fileId: rec.id, kind: kindOfMime(rec.mime, rec.name) });
    }
    if (!parts.length) parts.push({ text, fileId: null, kind: 'text' });
    const ids: number[] = [];
    const deadline = (this.d.now?.() ?? Date.now()) + (this.d.sendDeadlineMs ?? SEND_DEADLINE_MS);
    for (const part of parts) {
      const msg = await this.d.store.insertOutboundPending({
        chat,
        kind: part.kind,
        text: part.text,
        fileId: part.fileId,
        replyToMessageId: ids.length ? null : replyToMessageId,
        senderName,
        senderUserId: input.userId,
      });
      ids.push(msg.id);
      await this.d.queue.add('to-channel', { messageId: msg.id, channelId: channel.id, deadline }, { jobId: `to-channel-${msg.id}` });
      await this.d.events?.publish(chat.accountId, { type: 'message', chatId: chat.id, messageId: msg.id });
    }
    // Ответ из окна (карточка или раздел «Rf Messenger») закрывает неотвеченные.
    await this.noteCounters(chat, { by: 'reply', messageId: ids.at(-1) ?? null, userId: input.userId });
    return { messageIds: ids };
  }

  /** Повтор недоставленного сообщения из amoCRM (кнопка «Повторить» в окне). */
  async retryMessage(accountId: number, messageId: number): Promise<boolean> {
    const msg = await this.d.store.messageById(messageId);
    if (!msg || msg.accountId !== accountId || msg.direction !== 'out' || msg.source === 'client' || msg.status !== 'failed') return false;
    const chat = await this.d.store.chatById(msg.chatId);
    if (!chat) return false;
    await this.d.store.requeueMessage(msg.id);
    const now = this.d.now?.() ?? Date.now();
    await this.d.queue.add('to-channel', { messageId: msg.id, channelId: chat.channelId, deadline: now + (this.d.sendDeadlineMs ?? SEND_DEADLINE_MS) }, { jobId: `to-channel-${msg.id}-retry-${now}` });
    await this.d.events?.publish(accountId, { type: 'status', chatId: msg.chatId, messageId: msg.id, status: 'queued' });
    return true;
  }

  /**
   * Подбирает входящие, которые сохранены, но не переданы в amo и остались без задачи
   * (процесс перезапустился между сохранением и постановкой в очередь). Повтор безопасен:
   * jobId тот же, а deliverToAmo не отправляет уже переданное.
   */
  async requeueStuckInbound(olderThanSec: number = STUCK_INBOUND_AFTER_SEC): Promise<number> {
    const ids = await this.d.store.stuckInboundIds(olderThanSec);
    for (const id of ids) await this.d.queue.add('to-amo', { messageId: id }, { jobId: `to-amo-${id}` });
    if (ids.length) this.d.log.warn({ count: ids.length }, 'входящие без передачи в amo поставлены в очередь заново');
    return ids.length;
  }

  private clientUser(chat: Chat): AmojoUser {
    return {
      id: `${chat.conversationId}-c`,
      name: chat.title.slice(0, 100),
      ...(chat.contact.phone ? { profile: { phone: chat.contact.phone } } : {}),
      ...(chat.contact.link ? { profile_link: chat.contact.link } : {}),
    };
  }

  private async amoMessage(msg: Message, chat: Chat): Promise<AmojoMessage> {
    const text = chat.isGroup && msg.author ? `${msg.author.name}: ${msg.text}` : msg.text;
    let message: AmojoMessage;
    const file = msg.fileId ? await this.d.store.fileById(msg.fileId) : null;
    if (msg.kind !== 'text' && file) {
      message = { type: msg.kind, media: this.d.files.signedUrl(file), file_name: file.name, file_size: file.size, ...(text ? { text } : {}) };
    } else if (msg.kind !== 'text' && text && !msg.sentAt && msg.direction === 'in' && (this.d.now?.() ?? Date.now()) - msg.createdAt.getTime() < (this.d.mediaTimeoutMs ?? 90_000) * 2 + 30_000) {
      // Текст уходит сразу, файл ещё скачивается и придёт отдельным сообщением (to-amo-media).
      message = { type: 'text', text };
    } else if (msg.kind !== 'text') {
      message = { type: 'text', text: `[Вложение не получено]${text ? ` ${text}` : ''}` };
    } else {
      message = { type: 'text', text };
    }
    if (msg.replyToMessageId) {
      const quoted = await this.d.store.messageById(msg.replyToMessageId);
      if (quoted?.source === 'amo' && quoted.amojoMsgid) message.reply_to = { message: { id: quoted.amojoMsgid } };
      else if (quoted?.amojoMsgid) message.reply_to = { message: { msgid: ourMsgid(quoted.id) } };
    }
    return message;
  }

  /** Задача to-amo. Повторный запуск безопасен: уже переданное сообщение не отправляется снова. По одному чату — строго по очереди. */
  deliverToAmo(messageId: number): Promise<void> {
    return this.d.store.messageById(messageId).then((msg) => (msg ? this.perChat(msg.chatId, () => this.deliverToAmoNow(messageId)) : undefined));
  }

  private async deliverToAmoNow(messageId: number): Promise<void> {
    const msg = await this.d.store.messageById(messageId);
    if (!msg || msg.source === 'amo' || msg.amojoMsgid) return;
    const chat = await this.d.store.chatById(msg.chatId);
    if (!chat) return;
    const conn = await this.d.store.getConnection(chat.accountId);
    if (!conn || !this.d.amojo) throw new Error('Канал чатов amoCRM не подключён к аккаунту');
    // Новый чат: номер неизвестен (MAX) → спросить у мессенджера; затем привязка к контакту по номеру, потом сообщение.
    await this.resolveUnknownPhone(chat);
    await this.linkNewChatToContact(chat, conn);
    // Сообщение с телефона менеджера — исходящее: отправитель — сотрудник amoCRM (ref_id), получатель — клиент.
    // amo принимает исходящее, только если отправитель — его пользователь: без ref_id ответ 400
    // «receiver: exactly one origin user must be provided». Сотрудника узнаём из вебхука amo (onAmoHook).
    const { sender, receiver, silent } = this.amoParties(msg, chat, conn.amoOperatorRef);
    const ts = Math.floor(msg.createdAt.getTime() / 1000);
    const payload: NewMessagePayload = {
      timestamp: ts,
      msec_timestamp: msg.createdAt.getTime(),
      msgid: ourMsgid(msg.id),
      conversation_id: chat.conversationId,
      sender,
      ...(receiver ? { receiver } : {}),
      message: await this.amoMessage(msg, chat),
      silent,
    };
    let r;
    try {
      r = await this.d.amojo.sendMessage(conn.scopeId, payload);
    } catch (err) {
      // 403 — канал отключён на стороне amo (например, интеграцию переустановили).
      // Сбрасываем подключение, чтобы виджет снова показал кнопку «Подключить к amoCRM».
      if (err instanceof AmojoError && err.status === 403) {
        await this.d.store.deleteConnection(chat.accountId);
        this.d.log.warn({ accountId: chat.accountId }, 'amo вернул 403: канал чатов отключён от аккаунта, нужно подключить заново');
      }
      throw err;
    }
    await this.d.store.markSynced(msg.id, r.msgid);
    if (r.chatId) await this.d.store.setAmojoChatId(chat.id, r.chatId);
  }

  // ---------- Написать первым ----------

  /**
   * Новая переписка по инициативе менеджера: чат в мессенджере по номеру → чат API чатов amo →
   * привязка к контакту → первое сообщение клиенту → то же сообщение в amo как исходящее от сотрудника.
   * Выполняется в процессе коннекторов (нужен запущенный коннектор канала).
   */
  async startChat(input: StartChatInput): Promise<{ chatId: number; messageId: number }> {
    const text = input.text.trim();
    if (!text) throw new StartChatError('Введите текст первого сообщения');
    const channel = await this.d.store.channelOfAccount(input.accountId, input.channelId);
    if (!channel) throw new StartChatError('Канал не найден');
    const connector = this.d.connector(channel.id);
    if (!connector) throw new StartChatError('Канал сейчас не запущен — проверьте его в настройках виджета');
    if (channel.status !== 'connected') throw new StartChatError('Канал сейчас не подключён — проверьте его в настройках виджета');
    const conn = await this.d.store.getConnection(input.accountId);
    if (!conn || !this.d.amojo) throw new StartChatError('Канал чатов amoCRM не подключён к аккаунту');
    if (!this.d.rest) throw new StartChatError('Нет доступа к amoCRM: интеграция не авторизована');

    let chat: Chat | null;
    if (input.chatId) {
      // VK и MAX: написать можно только тому, кто уже писал сообществу или боту, — чат выбран из существующих.
      if (!CHAT_START_KINDS.has(channel.kind)) throw new StartChatError('Через этот канал можно написать только по номеру телефона');
      chat = await this.d.store.chatById(input.chatId);
      if (!chat || chat.accountId !== input.accountId || chat.channelId !== channel.id || chat.isGroup) throw new StartChatError('Чат не найден');
    } else {
      if (!connector.resolvePhone) throw new StartChatError('Через этот канал нельзя написать первым по номеру');
      const phone = normalizePhone(input.phone ?? '');
      if (!phone) throw new StartChatError('Некорректный номер телефона');
      // Чат с этим номером уже был (клиент писал раньше) — продолжаем его, а не заводим второй.
      chat = await this.d.store.chatByPhone(channel.id, phone);
      if (!chat) {
        const peer = await connector.resolvePhone(phone);
        if (!peer) throw new StartChatError(`Номер ${phone} не найден в мессенджере или скрыт настройками приватности`);
        const contact = await this.d.rest.contact(input.accountId, input.contactId);
        chat = await this.d.store.upsertChat(channel, { externalChatId: peer.externalChatId, isGroup: false, title: peer.title ?? contact.name, contact: { phone } });
      }
    }

    const { chatId: amojoChatId } = await this.d.amojo.createChat(conn.scopeId, chat.conversationId, this.clientUser(chat));
    await this.d.store.setAmojoChatId(chat.id, amojoChatId);
    await this.d.rest.linkChat(input.accountId, amojoChatId, input.contactId);
    await this.markMaxContact(chat, input.contactId);
    const ref = await this.d.rest.userAmojoId(input.accountId, input.userId);
    if (ref) await this.d.store.rememberAmoOperator(input.accountId, chat.id, ref);

    const sent = await connector.send({ externalChatId: chat.externalChatId, text, file: null, replyToExternalId: null });
    const msg = await this.d.store.insertFromChannel({
      chat,
      source: 'phone',
      kind: 'text',
      text,
      author: null,
      externalId: sent.externalMessageId,
      replyToExternalId: null,
    });
    if (!msg) throw new Error('Сообщение уже было сохранено');
    try {
      await this.deliverToAmo(msg.id);
    } catch (err) {
      // Клиенту уже ушло: в amo догонит очередь.
      this.d.log.warn({ messageId: msg.id, err: (err as Error).message }, 'первое сообщение не передано в amo сразу');
      await this.d.queue.add('to-amo', { messageId: msg.id }, { jobId: `to-amo-${msg.id}` });
    }
    // Новый чат из «Написать»: подгрузить прежнюю переписку из мессенджера, как для чата, начатого клиентом.
    if ((chat as Chat & { inserted?: boolean }).inserted && connector.history) {
      await this.d.queue.add('history', { messageId: 0, chatId: chat.id }, { jobId: `history-${chat.id}-first` }).catch(() => undefined);
    }
    return { chatId: chat.id, messageId: msg.id };
  }

  // ---------- amoCRM → канал ----------

  /** Вебхук amo (подпись уже проверена, accountId найден по scope_id). */
  async onAmoHook(accountId: number, body: unknown): Promise<HookResult> {
    const parsed = hookSchema.safeParse(body);
    if (!parsed.success) return 'ignored';
    const { conversation, sender, message: m } = parsed.data.message;
    if (!conversation.client_id) return 'unknown_chat';
    const chat = await this.d.store.chatByConversation(accountId, conversation.client_id);
    if (!chat) return 'unknown_chat';
    if (sender && sender.id !== chat.amoOperatorRef) {
      const firstForAccount = await this.d.store.rememberAmoOperator(accountId, chat.id, sender.id);
      // Сообщения с телефона, отклонённые amo без сотрудника, — заново в очередь (отдельный jobId: прежние задачи уже упали).
      if (firstForAccount) {
        for (const id of await this.d.store.pendingPhoneIds(accountId)) {
          await this.d.queue.add('to-amo', { messageId: id }, { jobId: `to-amo-${id}-op` });
        }
      }
    }
    const kind = (KINDS.has(m.type as AmojoMessageKind) ? m.type : 'text') as AmojoMessageKind;
    const media = kind !== 'text' && m.media ? { url: m.media, name: m.file_name || 'file', size: m.file_size } : null;
    const msg = await this.d.store.insertFromAmo({
      chat,
      kind: media ? kind : 'text',
      text: m.text,
      media,
      amojoMsgid: m.id,
      replyToAmojoMsgid: m.reply_to?.message.id ?? null,
      senderName: sender?.name ?? null,
    });
    if (!msg) return 'duplicate';
    const channel = await this.d.store.channelById(chat.channelId);
    // Пауза «как человек» — только для личных аккаунтов (п. 4.5); боты и сообщества отвечают сразу.
    const delay = channel && PACED_KINDS.has(channel.kind) ? await this.d.pacer.reserve(chat.id) : 0;
    const deadline = (this.d.now?.() ?? Date.now()) + delay + (this.d.sendDeadlineMs ?? SEND_DEADLINE_MS);
    await this.d.queue.add('to-channel', { messageId: msg.id, channelId: chat.channelId, deadline }, { jobId: `to-channel-${msg.id}`, delay });
    await this.d.events?.publish(accountId, { type: 'message', chatId: chat.id, messageId: msg.id });
    // Ответ из чата amoCRM (менеджер или Salesbot) закрывает неотвеченные.
    await this.noteCounters(chat, { by: 'reply', messageId: msg.id });
    return 'queued';
  }

  private async reportStatus(chat: Chat, msg: Message, status: 1 | -1, error?: string): Promise<void> {
    const conn = await this.d.store.getConnection(chat.accountId);
    if (!conn || !this.d.amojo || !msg.amojoMsgid) return;
    await this.d.amojo.deliveryStatus(conn.scopeId, msg.amojoMsgid, status, error).catch((err: Error) => {
      this.d.log.warn({ messageId: msg.id, err: err.message }, 'статус доставки не передан в amo');
    });
  }

  private async fail(chat: Chat, msg: Message, error: string): Promise<void> {
    await this.d.store.markFailed(msg.id, error);
    await this.reportStatus(chat, msg, -1, error);
    await this.d.events?.publish(chat.accountId, { type: 'status', chatId: chat.id, messageId: msg.id, status: 'failed', error });
  }

  /**
   * Задача to-channel: исходящее из amoCRM или из окна/раздела — клиенту. lastAttempt — последняя попытка очереди:
   * при ошибке сообщение помечается недоставленным. Срок (deadline) и таймаут отправки — п. 4.3 и 4.7.
   */
  async deliverToChannel(messageId: number, lastAttempt: boolean, deadline: number | null = null): Promise<void> {
    const msg = await this.d.store.messageById(messageId);
    if (!msg || msg.direction !== 'out' || msg.status !== 'queued') return;
    const chat = await this.d.store.chatById(msg.chatId);
    if (!chat) return;
    const channel = await this.d.store.channelById(chat.channelId);
    if (!channel) return this.fail(chat, msg, 'Канал отключён');
    const kindText = KIND_TEXT[channel.kind] ?? channel.kind;
    const now = this.d.now?.() ?? Date.now();
    if (deadline && now > deadline) {
      this.d.log.warn({ messageId: msg.id, channelId: channel.id, waitedSec: Math.round((now - msg.createdAt.getTime()) / 1000) }, 'сообщение не доставлено: вышел срок ожидания');
      return this.fail(chat, msg, `${kindText}: сообщение не удалось отправить за ${Math.round((this.d.sendDeadlineMs ?? SEND_DEADLINE_MS) / 60_000)} мин`);
    }
    try {
      const connector = this.d.connector(channel.id);
      if (!connector) throw new Error(`${kindText}: канал сейчас не запущен`);
      let file = null;
      if (msg.source === 'amo' && msg.media) {
        const { data, mime } = await downloadFromAmo(msg.media.url, {
          allowedDomains: this.d.amoDomains,
          maxBytes: this.d.files.maxBytes,
          ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
          ...(this.d.resolve ? { resolve: this.d.resolve } : {}),
        });
        const rec = msg.fileId
          ? await this.d.store.fileById(msg.fileId)
          : await this.d.files.save({ accountId: chat.accountId, channelId: channel.id, data, name: msg.media.name, mime });
        if (rec && !msg.fileId) await this.d.store.setMessageFile(msg.id, rec.id);
        file = { data, name: rec?.name ?? msg.media.name, mime, kind: msg.kind === 'text' ? ('file' as const) : msg.kind };
      } else if (msg.fileId) {
        // Из окна: файл уже у нас.
        const rec = await this.d.store.fileById(msg.fileId);
        if (!rec) throw new PermanentSendError('Файл не найден');
        file = { data: await this.d.files.read(rec.id), name: rec.name, mime: rec.mime, kind: msg.kind === 'text' ? ('file' as const) : msg.kind };
      }
      const quoted = msg.replyToMessageId ? await this.d.store.messageById(msg.replyToMessageId) : null;
      if (PACED_KINDS.has(channel.kind)) {
        await connector.typing(chat.externalChatId).catch(() => undefined);
        if (this.d.typingMs) await sleep(this.d.typingMs);
      }
      const sent = await withTimeout(
        connector.send({ externalChatId: chat.externalChatId, text: msg.text, file, replyToExternalId: quoted?.externalId ?? null, idempotencyKey: ourMsgid(msg.id) }),
        this.d.sendTimeoutMs ?? SEND_TIMEOUT_MS,
        `${kindText} не ответил`,
      );
      const updated = await this.d.store.markSent(msg.id, sent.externalMessageId);
      // Журнал времени «принято → отправлено» (п. 4.10): без текста и номера.
      this.d.log.info({ messageId: msg.id, channelId: channel.id, kind: channel.kind, source: msg.source, ms: (updated?.sentAt ?? new Date()).getTime() - msg.createdAt.getTime() }, 'исходящее отправлено');
      if (msg.source === 'amo') await this.reportStatus(chat, msg, 1);
      await this.d.events?.publish(chat.accountId, { type: 'status', chatId: chat.id, messageId: msg.id, status: 'sent' });
      if (msg.source === 'phone') {
        // Из окна: теперь то же сообщение — в ленту amoCRM как исходящее сотрудника.
        try {
          await this.deliverToAmo(msg.id);
        } catch (err) {
          this.d.log.warn({ messageId: msg.id, err: (err as Error).message }, 'сообщение из окна не передано в amo сразу');
          await this.d.queue.add('to-amo', { messageId: msg.id }, { jobId: `to-amo-${msg.id}` });
        }
      }
    } catch (err) {
      const raw = (err as Error).message;
      const text = raw.startsWith(kindText) ? raw : `${kindText}: ${raw}`;
      if (err instanceof PermanentSendError || lastAttempt) {
        this.d.log.warn({ messageId: msg.id, channelId: channel.id, err: raw }, 'сообщение не доставлено');
        return this.fail(chat, msg, text);
      }
      this.d.log.warn({ messageId: msg.id, channelId: channel.id, err: raw }, 'отправка не удалась, будет повтор');
      throw new Error(text);
    }
  }
}
