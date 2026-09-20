import {
  MAX_REMINDER_LEVEL,
  TERMINAL_VAGUE_STATUSES,
  type ReminderLevel,
  type ResponsibleSource,
  type StaleItemDto,
} from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { logActivity } from './activity';
import { notify, workspaceMemberIds } from './notify';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 默认滞留阈值：超过 3 天没人碰就算积压 */
export const DEFAULT_STALE_DAYS = 3;

interface Responsible {
  userId: string;
  source: ResponsibleSource;
}

/**
 * 负责人判定：被指派人 → 食谱创建者 → 空间所有者。
 * 条目没人认领时不能没人兜底 —— 总有一个人会被点到名。
 */
export function responsibleFor(item: { assigneeId: string | null; recipe: { createdBy: string } }, ownerId: string): Responsible {
  if (item.assigneeId) return { userId: item.assigneeId, source: 'assignee' };
  if (item.recipe.createdBy) return { userId: item.recipe.createdBy, source: 'recipe_creator' };
  return { userId: ownerId, source: 'workspace_owner' };
}

/**
 * 当前提醒级别 = 条目上次有动静之后，被提醒过的次数（封顶 3 级）。
 *
 * 级别记在审计日志里（vague_item.remind），而不是条目表上：
 * 提醒本身不算"处理"，不能碰条目的 updatedAt —— 否则催一次反而让条目"变新鲜"，
 * 滞留天数就永远涨不上去。条目真正被人处理后 updatedAt 前移，级别自动归零重计。
 */
async function reminderLevels(
  items: { id: string; updatedAt: Date }[],
): Promise<Map<string, { level: number; lastRemindedAt: Date | null }>> {
  const result = new Map(items.map((item) => [item.id, { level: 0, lastRemindedAt: null as Date | null }]));
  if (!items.length) return result;

  const logs = await prisma.activityLog.findMany({
    where: {
      entityType: 'vague_item',
      entityId: { in: items.map((item) => item.id) },
      action: 'vague_item.remind',
    },
    select: { entityId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const updatedAtById = new Map(items.map((item) => [item.id, item.updatedAt]));
  for (const log of logs) {
    const updatedAt = updatedAtById.get(log.entityId);
    const entry = result.get(log.entityId);
    if (!updatedAt || !entry) continue;
    // 只数"最后一次处理之后"的提醒；处理过的条目重新从一级开始催
    if (log.createdAt <= updatedAt) continue;
    entry.level = Math.min(entry.level + 1, MAX_REMINDER_LEVEL);
    entry.lastRemindedAt = log.createdAt;
  }
  return result;
}

/** 空间里所有滞留条目（长时间没人处理、尚未收口），连同负责人与提醒级别 */
export async function listStaleItems(workspaceId: string, staleDays = DEFAULT_STALE_DAYS): Promise<StaleItemDto[]> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true },
  });
  if (!workspace) throw notFound('家庭空间');

  const cutoff = new Date(Date.now() - staleDays * DAY_MS);
  const items = await prisma.vagueItem.findMany({
    where: {
      recipe: { workspaceId },
      status: { notIn: [...TERMINAL_VAGUE_STATUSES] },
      updatedAt: { lt: cutoff },
    },
    include: {
      recipe: { select: { id: true, title: true, createdBy: true } },
      assignee: { select: { displayName: true } },
    },
    orderBy: { updatedAt: 'asc' },
  });

  const levels = await reminderLevels(items);
  const userIds = [
    ...new Set(items.map((item) => responsibleFor(item, workspace.ownerId).userId)),
  ];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true },
  });
  const nameOf = new Map(users.map((user) => [user.id, user.displayName]));

  const now = Date.now();
  return items.map((item) => {
    const responsible = responsibleFor(item, workspace.ownerId);
    const level = levels.get(item.id) ?? { level: 0, lastRemindedAt: null };
    return {
      itemId: item.id,
      recipeId: item.recipe.id,
      recipeTitle: item.recipe.title,
      rawPhrase: item.rawPhrase,
      category: item.category as StaleItemDto['category'],
      status: item.status as StaleItemDto['status'],
      staleDays: Math.floor((now - item.updatedAt.getTime()) / DAY_MS),
      updatedAt: item.updatedAt.toISOString(),
      responsible: {
        userId: responsible.userId,
        displayName: nameOf.get(responsible.userId) ?? '未知成员',
        source: responsible.source,
      },
      reminderLevel: level.level,
      lastRemindedAt: level.lastRemindedAt ? level.lastRemindedAt.toISOString() : null,
    };
  });
}

/** 每一级提醒要通知到的人：1 级负责人 → 2 级加整理者 → 3 级全家 */
async function escalationTargets(
  level: ReminderLevel,
  workspaceId: string,
  ownerId: string,
  responsibleId: string,
): Promise<string[]> {
  if (level === 1) return [responsibleId];

  if (level === 2) {
    const organizers = await prisma.workspaceMember.findMany({
      where: { workspaceId, role: { in: ['owner', 'editor'] } },
      select: { userId: true },
    });
    return [...new Set([responsibleId, ownerId, ...organizers.map((m) => m.userId)])];
  }

  return workspaceMemberIds(workspaceId);
}

export interface RemindResult {
  itemId: string;
  level: ReminderLevel;
  notifiedUserIds: string[];
}

/**
 * 对一条滞留条目执行"下一级"提醒。
 * 级别由审计日志里已有的提醒次数推出，调用方不需要（也不能）指定级别 ——
 * 这样无论谁点、点几次，升级路径都只有一条：1 → 2 → 3。
 */
export async function remindVagueItem(itemId: string, actorId: string): Promise<RemindResult> {
  const item = await prisma.vagueItem.findUnique({
    where: { id: itemId },
    include: {
      recipe: { select: { id: true, title: true, createdBy: true, workspaceId: true, workspace: { select: { ownerId: true, name: true } } } },
    },
  });
  if (!item) throw notFound('待澄清条目');
  if ((TERMINAL_VAGUE_STATUSES as readonly string[]).includes(item.status)) {
    throw new ApiError('VALIDATION_FAILED', '这条已经收口（已验证 / 口语留白），不需要再提醒');
  }

  const staleDays = Math.floor((Date.now() - item.updatedAt.getTime()) / DAY_MS);
  const workspaceId = item.recipe.workspaceId;
  const ownerId = item.recipe.workspace.ownerId;
  const responsible = responsibleFor(item, ownerId);

  const levels = await reminderLevels([{ id: item.id, updatedAt: item.updatedAt }]);
  const current = levels.get(item.id)?.level ?? 0;
  if (current >= MAX_REMINDER_LEVEL) {
    throw new ApiError('VALIDATION_FAILED', '已经提醒到最高级别（全家知悉），直接在家庭群里说一声吧');
  }
  const level = (current + 1) as ReminderLevel;

  const targets = await escalationTargets(level, workspaceId, ownerId, responsible.userId);
  // notify 内部会排除触发者；返回值与日志都用真实会收到通知的人，不夸大
  const recipients = targets.filter((id) => id !== actorId);
  await notify({
    userIds: targets,
    type: 'reminder',
    excludeUserId: actorId,
    payload: {
      recipeId: item.recipeId,
      itemId: item.id,
      rawPhrase: item.rawPhrase,
      recipeTitle: item.recipe.title,
      level,
      staleDays,
      message: `「${item.rawPhrase}」（${item.recipe.title}）已经 ${staleDays} 天没人处理了，帮忙推进一下？`,
    },
  });

  await logActivity({
    workspaceId,
    actorId,
    action: 'vague_item.remind',
    entityType: 'vague_item',
    entityId: item.id,
    after: { level, staleDays, notifiedUserIds: recipients },
  });

  return { itemId: item.id, level, notifiedUserIds: recipients };
}
