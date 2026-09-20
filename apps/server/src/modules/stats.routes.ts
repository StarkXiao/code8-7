import { Router } from 'express';
import { memberStatsQuerySchema } from '@froa/shared';
import { asyncHandler, send } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { queryOf, validateQuery } from '../middleware/validate';
import { assertWorkspaceRole } from '../services/access';
import { getMemberStats } from '../services/stats';

export const statsRouter: Router = Router();

statsRouter.use(requireAuth);

/**
 * 成员贡献/积压统计 + 滞留条目（含负责人与提醒状态）。
 * 任何成员都能看 —— 这页的意义就是让全家互相知道谁在扛活、哪里卡住了。
 */
statsRouter.get(
  '/workspaces/:workspaceId/member-stats',
  validateQuery(memberStatsQuerySchema),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'viewer');
    const { staleDays } = queryOf(req, memberStatsQuerySchema);

    send(res, await getMemberStats(workspaceId!, staleDays));
  }),
);
