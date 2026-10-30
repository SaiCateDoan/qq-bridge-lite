// 二代仿真（reserved2）运行链路的组装点：人物库、群事件、跨群、owner 托付、群规。
//
// bridge.js 只负责接线（在消息入口、事件流、控制台路由里调用这里的函数），
// 业务规则都在 src/social/* 与 src/lib/* 里，便于离线测试。
//
// 状态文件（都在 state/ 下，随 state ACL 一起收紧，不入库）：
//   state/social/people.json     人物库（含各群名片、成员关系、分层记忆）
//
// 已移除（只保留二代仿真一条链路）：模式/权限控制器、审批登记表、TOTP、owner 管理命令。
import fs from 'node:fs';
import path from 'node:path';
import { createPeopleRegistry, normalizeQQ, normalizeGroupId } from './social/people.js';
import { buildPersonView, renderPeopleBlock } from './social/memory-policy.js';

// bridge.js 只 import 这一个模块（测试夹具按名字注入绑定，入口越少越不容易漂移）。
export { normalizeMemberNotice, processMemberEvent, joinWakeInstruction } from './social/group-events.js';
export { checkCrossGroup, queryPresence, queryActivity } from './social/cross-group.js';
export { createReconnectWatchdog } from './lib/ws-watchdog.mjs';
export { describeAgentError, agentErrorUserText, isConfigError } from './lib/agent-errors.mjs';
export { redactCredentials } from './lib/redact.mjs';

function fmt(t) {
  if (!t) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * @param {object} deps
 * @param {object} deps.cfg                  桥接的内存配置对象（热更新时同一个引用）
 * @param {string} deps.stateDir
 * @param {(...a:any[])=>void} deps.log
 * @param {() => number} [deps.now]
 */
export function createBridgeExtensions({ cfg, stateDir, log, now = Date.now }) {
  const logLine = (m) => log(m);
  const people = createPeopleRegistry({
    file: path.join(stateDir, 'social', 'people.json'),
    log: logLine,
    now,
    dedupeWindowMs: Number(cfg.continuity?.dedupeWindowMs) || 10 * 60 * 1000,
  });
  try { people.load(); } catch (error) { log(`⚠️ 人物库加载失败：${error?.message ?? error}（本次运行不记录人物）`); }

  const continuity = () => cfg.continuity ?? {};
  const continuityEnabled = () => cfg.continuity?.enabled !== false;
  const isOwnerPrivateKey = (key) => !!normalizeQQ(cfg.ownerQQ) && key === `private:${normalizeQQ(cfg.ownerQQ)}`;

  function groupRecordable(groupId) {
    return cfg.continuity?.groups?.[String(groupId)]?.recordable !== false;
  }

  /** 消息入口调用：记录「看到此人发言」。返回 people.observeMessage 的结果或 null。 */
  function observeMessage({ kind, id, event, directedAtSelf }) {
    if (!continuityEnabled()) return null;
    if (kind === 'group' && !groupRecordable(id)) return null;
    try {
      return people.observeMessage({
        kind,
        groupId: kind === 'group' ? id : null,
        userId: event?.user_id ?? event?.sender?.user_id,
        card: kind === 'group' ? (event?.sender?.card ?? '') : '',
        nickname: event?.sender?.nickname ?? '',
        directedAtSelf: !!directedAtSelf,
      });
    } catch (error) {
      log(`人物库记录失败：${error?.message ?? error}`);
      return null;
    }
  }

  /** 唤醒提示词的「在场人物」小节（按需注入：只含本轮消息里出现的人）。 */
  function peopleBlockFor(key, userIds) {
    if (!continuityEnabled() || cfg.continuity?.injectPeople === false) return '';
    const m = /^group:(\d+)$/.exec(key);
    if (m && !groupRecordable(m[1])) return '';
    const seen = new Set();
    const persons = [];
    for (const uid of userIds) {
      const qq = normalizeQQ(uid);
      if (!qq || seen.has(qq) || qq === normalizeQQ(cfg.ownerQQ) && key.startsWith('private:')) continue;
      seen.add(qq);
      const p = people.getPerson(qq);
      if (p) persons.push(p);
    }
    return renderPeopleBlock(persons, key, continuity(), {
      maxPeople: Number(cfg.continuity?.injectMaxPeople) || 8,
      maxChars: Number(cfg.continuity?.injectMaxChars) || 1500,
      now: now(),
    });
  }

  /** AI 工具用：当前会话可见的某人视图（已按可见性过滤）。 */
  function personViewFor(key, userId) {
    const p = people.getPerson(userId);
    if (!p) return null;
    const m = /^group:(\d+)$/.exec(key);
    if (m && !groupRecordable(m[1])) return null;
    const v = buildPersonView(p, key, continuity(), { now: now(), maxNotes: 10 });
    if (!v) return null;
    const { text, ...rest } = v;
    return rest;
  }

  return {
    people,
    continuity,
    continuityEnabled,
    isOwnerPrivateKey,
    groupRecordable,
    observeMessage,
    peopleBlockFor,
    personViewFor,
    normalizeQQ,
    normalizeGroupId,
  };
}

export { resolveDshBaseUrl, dshBaseUrlCandidates, detectDshDesktop } from './lib/dsh-endpoint.mjs';
export { isNapCatVersionInfo, looksLikePathOnlyError, stickerTempBase, writeTempSticker, findFavByMd5, napcatAddOk } from './social/sticker-collect.js';
export { GROUP_RULE_LIMITS, validateOwnerGroupAccess, normalizeRules, addRule, removeRule, rulesPromptBlock, peekView, groupRuleResultText, groupRuleNoticeText } from './social/group-rules.js';
export { OWNER_RELAY_DEFAULTS, ownerRelayConfig, validateOwnerRelay, createOwnerRelayLimiter, createOwnerRelayStore, ownerRelayPromptBlock, ownerRelayResultText, ownerRelayNoticeText } from './social/owner-relay.js';
export { qqBackendFromVersionInfo, qqBackendLabel } from './lib/qq-backend-label.js';
export { classifyDshError, createDshHealth } from './lib/dsh-health.js';
