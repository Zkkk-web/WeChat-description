import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function fileWechatSubscriptionStore(path) {
  return {
    async load() {
      try {
        return normalizeStore(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if (error?.code === "ENOENT") return emptyStore();
        throw error;
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(normalizeStore(state), null, 2)}\n`, "utf8");
    },
  };
}

export async function listWechatSubscriptions(config, deps = {}) {
  const state = await subscriptionStore(config, deps).load();
  return flattenStore(state, deps.chatId);
}

export async function addWechatSubscription(config, account, deps = {}) {
  const chatId = normalizeChatId(deps.chatId ?? config.feishuChatId);
  if (!chatId || !account.fakeid) return null;

  const store = subscriptionStore(config, deps);
  const state = normalizeStore(await store.load());
  const group = state.groups[chatId] ?? { accounts: {} };
  group.accounts[account.fakeid] = normalizeAccount(account, chatId);
  state.groups[chatId] = group;
  await store.save(state);
  return group.accounts[account.fakeid];
}

export async function removeWechatSubscription(config, fakeid, deps = {}) {
  const store = subscriptionStore(config, deps);
  const state = normalizeStore(await store.load());
  const chatId = normalizeChatId(deps.chatId ?? config.feishuChatId);
  const targets = chatId ? [chatId] : Object.keys(state.groups);
  let removed = 0;

  for (const target of targets) {
    if (state.groups[target]?.accounts?.[fakeid]) {
      delete state.groups[target].accounts[fakeid];
      removed += 1;
    }
  }

  await store.save(state);
  return removed;
}

export function flattenStore(state, chatId = "") {
  const normalized = normalizeStore(state);
  const groups = normalizeChatId(chatId) ? { [chatId]: normalized.groups[chatId] } : normalized.groups;
  return Object.entries(groups)
    .flatMap(([groupChatId, group]) =>
      Object.values(group?.accounts ?? {}).map((account) => normalizeAccount(account, groupChatId)),
    )
    .filter((account) => account.fakeid);
}

function subscriptionStore(config, deps = {}) {
  const store = deps.subscriptionStore ?? config.subscriptionStore;
  if (store) return store;
  if (!config.subscriptionStatePath) return memoryWechatSubscriptionStore();
  return fileWechatSubscriptionStore(config.subscriptionStatePath);
}

function memoryWechatSubscriptionStore() {
  let state = emptyStore();
  return {
    async load() {
      return state;
    },
    async save(next) {
      state = normalizeStore(next);
    },
  };
}

function normalizeStore(state) {
  const groups = {};
  for (const [chatId, group] of Object.entries(state?.groups ?? {})) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) continue;
    groups[normalizedChatId] = {
      accounts: Object.fromEntries(
        Object.values(group?.accounts ?? {})
          .map((account) => normalizeAccount(account, normalizedChatId))
          .filter((account) => account.fakeid)
          .map((account) => [account.fakeid, account]),
      ),
    };
  }
  return { version: 1, groups };
}

function emptyStore() {
  return { version: 1, groups: {} };
}

function normalizeAccount(account, chatId) {
  return {
    fakeid: String(account?.fakeid ?? "").trim(),
    nickname: String(account?.nickname ?? "").trim(),
    alias: String(account?.alias ?? "").trim(),
    description: String(account?.description ?? account?.signature ?? account?.desc ?? "").trim(),
    headImg: String(account?.headImg ?? account?.head_img ?? "").trim(),
    chatId: normalizeChatId(account?.chatId ?? chatId),
    subscribedAt: account?.subscribedAt ?? new Date().toISOString(),
  };
}

function normalizeChatId(value) {
  return String(value ?? "").trim();
}
