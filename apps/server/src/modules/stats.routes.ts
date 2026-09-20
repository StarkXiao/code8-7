import { Router } from 'express';
import {
  CONTRIBUTION_KINDS,
  TERMINAL_VAGUE_STATUSES,
  type ContributionKind,
  type MemberStatsDto,
  type WorkspaceRole,
} from '@froa/shared';
import { z } from 'zod';
import { prisma } from '../db/client';
import { asyncHandler, send } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { queryOf, validateQuery } from '../middleware/validate';
import { assertVagueItemRole, assertWorkspaceRole } from '../services/access';
import {
  DAY_MS,
  DEFAULT_STALE_DAYS,
  listStaleItems,
  remindVagueItem,
  responsibleFor,
} from '../services/reminder';

export const statsRouter: Router = Router();

statsRouter.use(requireAuth);

const staleQuerySchema = z.object({
  staleDays: z.coerce.number().int().min(1).max(90).default(DEFAULT_STALE_DAYS),
});

const staleItemsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(DEFAULT_STALE_DAYS),
});

/** ActivityLog 的 action → 贡献口径。答复人只记在日志里，所以统计必须从这里出 */
const ACTION_TO_KIND: Record<string, ContributionKind> = {
  'audio.upload': 'recordings',
  'audio.clip.create': 'clips',
  'vague_item.create': 'itemsCreated',
  'vague_item.ask': 'questionsAsked',
  'vague_item.answer': 'answersGiven',
  'vague_item.resolve': 'specsResolved',
  'vague_item.confirm': 'specsResolved',
  'verification.create': 'verifications',
  'comment.create': 'comments',
  'version.publish': 'publishes',
};

/* ------------------------------------------------------------------ */
/* 按成员统计贡献量与积压                                               */
/* ------------------------------------------------------------------ */

statsRouter.get(
  '/workspaces/:workspaceId/member-stats',
  validateQuery(staleQuerySchema),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    const membership = await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'viewer');
    const { staleDays } = queryOf(req, staleQuerySchema);

    const [members, activityGroups, openItems] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { workspaceId: workspaceId! },
        include: { user: { select: { displayName: true, avatarUrl: true } } },
        orderBy: { joinedAt: 'asc' },
      }),
      prisma.activityLog.groupBy({
        by: ['actorId', 'action'],
        where: { workspaceId: workspaceId! },
        _count: { _all: true },
      }),
      // 积压的负责人口径与滞留列表一致：被指派人 → 食谱创建者 → 空间所有者
      prisma.vagueItem.findMany({
        where: {
          recipe: { workspaceId: workspaceId! },
          status: { notIn: [...TERMINAL_VAGUE_STATUSES] },
        },
        select: {
          assigneeId: true,
          updatedAt: true,
          recipe: { select: { createdBy: true } },
        },
      }),
    ]);

    const cutoff = Date.now() - staleDays * DAY_MS;
    const stats: MemberStatsDto[] = members.map((member) => {
      const contributions = Object.fromEntries(
        CONTRIBUTION_KINDS.map((kind) => [kind, 0]),
      ) as Record<ContributionKind, number>;
      for (const group of activityGroups) {
        if (group.actorId !== member.userId) continue;
        const kind = ACTION_TO_KIND[group.action];
        if (kind) contributions[kind] += group._count._all;
      }

      const mine = openItems.filter(
        (item) => responsibleFor(item, membership.ownerId).userId === member.userId,
      );
      const stale = mine.filter((item) => item.updatedAt.getTime() < cutoff);

      return {
        userId: member.userId,
        displayName: member.user.displayName,
        avatarUrl: member.user.avatarUrl,
        role: member.role as WorkspaceRole,
        contributions,
        contributionTotal: Object.values(contributions).reduce((sum, n) => sum + n, 0),
        backlog: {
          openItems: mine.length,
          staleItems: stale.length,
          oldestStaleDays: stale.length
            ? Math.max(...stale.map((item) => Math.floor((Date.now() - item.updatedAt.getTime()) / DAY_MS)))
            : 0,
        },
      };
    });

    send(res, { staleDays, members: stats });
  }),
);

/* ------------------------------------------------------------------ */
/* 滞留条目：长时间没人处理，标出负责人                                   */
/* ------------------------------------------------------------------ */

statsRouter.get(
  '/workspaces/:workspaceId/stale-items',
  validateQuery(staleItemsQuerySchema),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'viewer');
    const { days } = queryOf(req, staleItemsQuerySchema);

    send(res, { staleDays: days, items: await listStaleItems(workspaceId!, days) });
  }),
);

/* ------------------------------------------------------------------ */
/* 逐级提醒                                                             */
/* ------------------------------------------------------------------ */

statsRouter.post(
  '/vague-items/:itemId/remind',
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    // 提醒会打扰到别人，旁观者（viewer）不允许触发
    await assertVagueItemRole(req.auth!.userId, itemId!, 'contributor');
    send(res, await remindVagueItem(itemId!, req.auth!.userId));
  }),
);
