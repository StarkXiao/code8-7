import {
  NUDGE_MAX_LEVEL,
  TERMINAL_VAGUE_STATUSES,
  type MemberContributionDto,
  type MemberStatsDto,
  type StaleItemDto,
  type VagueStatus,
  type WorkspaceRole,
} from '@froa/shared';
import { prisma } from '../db/client';

/**
 * 成员贡献统计与滞留条目。
 *
 * 口径约定：
 * - 贡献量 = 行为次数，来自审计日志（ActivityLog），只统计本空间内的动作；
 * - 积压 = 当前还挂在 TA 头上、等 TA 答复的条目（业务表现状）；
 * - 滞留 = 非终态条目，且 updatedAt 超过阈值没人碰。
 *   提醒（nudge）本身不更新条目的 updatedAt —— 催一下不算"处理了"。
 */

export const NUDGE_ACTION = 'vague_item.nudge';
export const DEFAULT_STALE_DAYS = 3;
export const MAX_STALE_DAYS = 30;
/** 同一条目两次提醒之间的最小间隔，避免连环催 */
export const NUDGE_COOLDOWN_HOURS = 20;
/** 单次返回的滞留条目上限，积压特别多的空间也不会一次拉爆 */
export const STALE_ITEMS_LIMIT = 100;

const DAY_MS = 24 * 3600 * 1000;
const NUDGE_COOLDOWN_MS = NUDGE_COOLDOWN_HOURS * 3600 * 1000;

/** 计入贡献量的行为（ActivityLog.action → DTO 字段） */
const CONTRIBUTION_ACTIONS = {
  audioUploaded: 'audio.upload',
  itemsCreated: 'vague_item.create',
  answersGiven: 'vague_item.answer',
  itemsResolved: 'vague_item.resolve',
  verificationsDone: 'verification.create',
  commentsPosted: 'comment.create',
} as const;

/** 还挂在条目头上、等答复的状态 */
const AWAITING_ANSWER_STATUSES: VagueStatus[] = ['open', 'asked'];

export async function getMemberStats(workspaceId: string, staleDays: number): Promise<MemberStatsDto> {
  const now = Date.now();
  const staleThresholdMs = now - staleDays * DAY_MS;

  const [members, contributionLogs, awaitingAnswerRows, nonTerminalRows] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
      orderBy: { joinedAt: 'asc' },
    }),
    // 贡献量：一次 groupBy 拿到所有成员 × 行为的计数
    prisma.activityLog.groupBy({
      by: ['actorId', 'action'],
      where: { workspaceId, action: { in: Object.values(CONTRIBUTION_ACTIONS) } },
      _count: { _all: true },
    }),
    // 积压：指派给 TA 且还在等答复的条目。
    // 注意：滞留判断在内存里做，不走 Prisma 的 DateTime 过滤 ——
    // 当前版本在 SQLite 上 DateTime 范围比较的序列化与存储格式不一致，结果不可靠。
    prisma.vagueItem.findMany({
      where: {
        recipe: { workspaceId },
        status: { in: AWAITING_ANSWER_STATUSES },
        assigneeId: { not: null },
      },
      select: { assigneeId: true, updatedAt: true },
    }),
    // 滞留条目的候选集：全部非终态条目，时间在内存里筛
    prisma.vagueItem.findMany({
      where: {
        recipe: { workspaceId },
        status: { notIn: [...TERMINAL_VAGUE_STATUSES] },
      },
      include: {
        recipe: { select: { title: true } },
        assignee: { select: { id: true, displayName: true } },
        creator: { select: { id: true, displayName: true } },
      },
      orderBy: { updatedAt: 'asc' },
    }),
  ]);

  // 滞留 = 超过阈值没人碰（提醒不写 updatedAt，催一下不算"处理了"）
  const staleItemRows = nonTerminalRows
    .filter((item) => item.updatedAt.getTime() < staleThresholdMs)
    .slice(0, STALE_ITEMS_LIMIT);

  // 每条滞留条目的提醒历史（次数 + 最近一次时间）
  const nudgeGroups = staleItemRows.length
    ? await prisma.activityLog.groupBy({
        by: ['entityId'],
        where: {
          workspaceId,
          action: NUDGE_ACTION,
          entityId: { in: staleItemRows.map((item) => item.id) },
        },
        _count: { _all: true },
        _max: { createdAt: true },
      })
    : [];
  const nudgeByItem = new Map(
    nudgeGroups.map((group) => [
      group.entityId,
      { count: group._count._all, lastNudgedAt: group._max.createdAt },
    ]),
  );

  const contributionByUser = new Map<string, Map<string, number>>();
  for (const log of contributionLogs) {
    let byAction = contributionByUser.get(log.actorId);
    if (!byAction) {
      byAction = new Map();
      contributionByUser.set(log.actorId, byAction);
    }
    byAction.set(log.action, log._count._all);
  }

  const backlogByUser = new Map<string, number>();
  const staleBacklogByUser = new Map<string, number>();
  for (const row of awaitingAnswerRows) {
    if (!row.assigneeId) continue;
    backlogByUser.set(row.assigneeId, (backlogByUser.get(row.assigneeId) ?? 0) + 1);
    if (row.updatedAt.getTime() < staleThresholdMs) {
      staleBacklogByUser.set(row.assigneeId, (staleBacklogByUser.get(row.assigneeId) ?? 0) + 1);
    }
  }

  const membersDto: MemberContributionDto[] = members
    .map((member) => {
      const byAction = contributionByUser.get(member.userId);
      const contributions = Object.fromEntries(
        Object.entries(CONTRIBUTION_ACTIONS).map(([field, action]) => [
          field,
          byAction?.get(action) ?? 0,
        ]),
      ) as unknown as MemberContributionDto['contributions'];
      contributions.total = Object.values(contributions).reduce((sum, n) => sum + n, 0);

      return {
        userId: member.userId,
        displayName: member.user.displayName,
        avatarUrl: member.user.avatarUrl,
        role: member.role as WorkspaceRole,
        contributions,
        backlog: {
          toAnswer: backlogByUser.get(member.userId) ?? 0,
          staleToAnswer: staleBacklogByUser.get(member.userId) ?? 0,
        },
      };
    })
    // 积压最久的排前面：先看滞留积压，再看总积压，最后看贡献
    .sort(
      (a, b) =>
        b.backlog.staleToAnswer - a.backlog.staleToAnswer ||
        b.backlog.toAnswer - a.backlog.toAnswer ||
        b.contributions.total - a.contributions.total,
    );

  const staleItems: StaleItemDto[] = staleItemRows.map((item) => {
    const nudge = nudgeByItem.get(item.id);
    const nudgeCount = nudge?.count ?? 0;
    const lastNudgedAt = nudge?.lastNudgedAt ?? null;
    const owner = item.assignee ?? item.creator;

    return {
      id: item.id,
      recipeId: item.recipeId,
      recipeTitle: item.recipe.title,
      rawPhrase: item.rawPhrase,
      category: item.category as StaleItemDto['category'],
      status: item.status as VagueStatus,
      staleDays: Math.floor((now - item.updatedAt.getTime()) / DAY_MS),
      owner: owner ? { id: owner.id, displayName: owner.displayName } : null,
      ownerKind: item.assignee ? 'assignee' : 'creator',
      nudgeCount,
      lastNudgedAt: lastNudgedAt?.toISOString() ?? null,
      canNudge: !lastNudgedAt || now - lastNudgedAt.getTime() >= NUDGE_COOLDOWN_MS,
      nextNudgeLevel: Math.min(nudgeCount + 1, NUDGE_MAX_LEVEL),
    };
  });

  return {
    staleDays,
    nudgeCooldownHours: NUDGE_COOLDOWN_HOURS,
    members: membersDto,
    staleItems,
  };
}

/** 某条条目的提醒历史：被催过几次、最近一次是什么时候 */
export async function getNudgeState(
  itemId: string,
): Promise<{ count: number; lastNudgedAt: Date | null }> {
  const groups = await prisma.activityLog.groupBy({
    by: ['entityId'],
    where: { action: NUDGE_ACTION, entityId: itemId },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const group = groups[0];
  return {
    count: group?._count._all ?? 0,
    lastNudgedAt: group?._max.createdAt ?? null,
  };
}

export function isInNudgeCooldown(lastNudgedAt: Date | null, now = Date.now()): boolean {
  return Boolean(lastNudgedAt && now - lastNudgedAt.getTime() < NUDGE_COOLDOWN_MS);
}

/**
 * 某一级别应该提醒谁。
 * 级别越高范围越大：负责人 → 负责人+整理者 → 全体家庭成员。
 */
export async function nudgeTargetsForLevel(
  level: number,
  ownerId: string,
  workspaceId: string,
): Promise<string[]> {
  if (level >= NUDGE_MAX_LEVEL) {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { userId: true },
    });
    return members.map((member) => member.userId);
  }
  if (level === 2) {
    const organizers = await prisma.workspaceMember.findMany({
      where: { workspaceId, role: { in: ['owner', 'editor'] } },
      select: { userId: true },
    });
    return [ownerId, ...organizers.map((member) => member.userId)];
  }
  return [ownerId];
}
