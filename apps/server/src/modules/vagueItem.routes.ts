import { Router } from 'express';
import {
  askVagueItemSchema,
  answerVagueItemSchema,
  confirmVagueItemSchema,
  createVagueItemSchema,
  fallbackQuestion,
  markUnresolvableSchema,
  matchVaguePhrases,
  NUDGE_LEVEL_LABELS,
  NUDGE_MAX_LEVEL,
  reopenVagueItemSchema,
  renderQuestionTemplate,
  resolveVagueItemSchema,
  TERMINAL_VAGUE_STATUSES,
  updateVagueItemSchema,
  validateResolvedSpec,
  vagueItemQuerySchema,
  type ResolvedSpec,
  type VagueStatus,
} from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { asyncHandler, created, send, sendList } from '../lib/http';
import { newId } from '../lib/ids';
import { assertNotStale } from '../lib/concurrency';
import { parseJson, stringifyJson } from '../lib/json';
import { requireAuth } from '../middleware/auth';
import { queryOf, validateBody, validateQuery } from '../middleware/validate';
import {
  assertClipInRecipe,
  assertClipRole,
  assertIngredientInRecipe,
  assertRecipeRole,
  assertStepInRecipe,
  assertUsersInWorkspace,
  assertVagueItemRole,
  assertVersionInRecipe,
} from '../services/access';
import { logActivity } from '../services/activity';
import { notify } from '../services/notify';
import {
  getNudgeState,
  isInNudgeCooldown,
  NUDGE_ACTION,
  NUDGE_COOLDOWN_HOURS,
  nudgeTargetsForLevel,
} from '../services/stats';
import { emitToWorkspace } from '../realtime/hub';
import { toActivityDto, toAudioDto, toClipDto, toVagueItemDto } from '../services/serialize';
import { z } from 'zod';

export const vagueItemRouter: Router = Router();

vagueItemRouter.use(requireAuth);

/** 允许的状态迁移表：终态只有 verified / unresolvable */
const TRANSITIONS: Record<VagueStatus, VagueStatus[]> = {
  open: ['asked', 'answered', 'resolved', 'unresolvable'],
  asked: ['answered', 'resolved', 'unresolvable', 'open'],
  answered: ['resolved', 'unresolvable', 'asked', 'open'],
  resolved: ['verified', 'unresolvable', 'open'],
  verified: ['open'],
  unresolvable: ['open'],
};

function assertTransition(from: string, to: VagueStatus) {
  const allowed = TRANSITIONS[from as VagueStatus];
  if (!allowed || !allowed.includes(to)) {
    throw new ApiError(
      'VAGUE_INVALID_TRANSITION',
      `条目当前状态为「${from}」，不能直接变更为「${to}」`,
    );
  }
}

const suggestQuerySchema = z.object({ text: z.string().min(1).max(4000) });

/* ------------------------------------------------------------------ */
/* 规则建议（录音工作台用）                                            */
/* ------------------------------------------------------------------ */

/**
 * 对一段转写文本做模糊描述识别。
 * 规则只给建议，绝不自动落库 —— 是否生成待澄清条目由人决定。
 */
vagueItemRouter.get(
  '/recipes/:recipeId/vague-items/suggest',
  validateQuery(suggestQuerySchema),
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    await assertRecipeRole(req.auth!.userId, recipeId!, 'viewer');
    const { text } = queryOf(req, suggestQuerySchema);

    const matches = matchVaguePhrases(text).map((match) => ({
      ...match,
      question: renderQuestionTemplate(match.question, match.matchedPattern),
    }));

    send(res, {
      matches,
      fallbackQuestionTemplate: fallbackQuestion('{这句话}'),
      count: matches.length,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* 列表与创建                                                          */
/* ------------------------------------------------------------------ */

vagueItemRouter.get(
  '/recipes/:recipeId/vague-items',
  validateQuery(vagueItemQuerySchema),
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    await assertRecipeRole(req.auth!.userId, recipeId!, 'viewer');
    const filters = queryOf(req, vagueItemQuerySchema);
    const { page, pageSize } = filters;
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const where = {
      recipeId: recipeId!,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.assigneeId ? { assigneeId: filters.assigneeId } : {}),
      ...(filters.search ? { rawPhrase: { contains: filters.search } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.vagueItem.findMany({
        where,
        include: {
          clip: { include: { audio: true } },
          answerClip: { include: { audio: true } },
          assignee: { select: { id: true, displayName: true, avatarUrl: true } },
          step: { select: { id: true, title: true, orderIndex: true } },
        },
        // 待办优先：越靠前越需要处理
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        skip,
        take,
      }),
      prisma.vagueItem.count({ where }),
    ]);

    const data = items.map((item) => ({
      ...toVagueItemDto(item),
      clip: item.clip ? toClipDto(item.clip) : null,
      clipAudio: item.clip ? toAudioDto(item.clip.audio) : null,
      answerClip: item.answerClip ? toClipDto(item.answerClip) : null,
      answerClipAudio: item.answerClip ? toAudioDto(item.answerClip.audio) : null,
      assignee: item.assignee,
      step: item.step,
    }));

    sendList(res, data, { total, page, pageSize });
  }),
);

vagueItemRouter.post(
  '/recipes/:recipeId/vague-items',
  validateBody(createVagueItemSchema),
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    const access = await assertRecipeRole(req.auth!.userId, recipeId!, 'contributor');

    const body = req.body as {
      category: string;
      rawPhrase: string;
      transcript?: string | null;
      clipId?: string | null;
      stepId?: string | null;
      versionId?: string | null;
      assigneeId?: string | null;
    };

    // 引用必须落在同一张食谱内，否则证据链会被挂到别的菜上
    if (body.clipId) await assertClipInRecipe(req.auth!.userId, body.clipId, recipeId!);
    if (body.stepId) await assertStepInRecipe(req.auth!.userId, body.stepId, recipeId!);
    if (body.versionId) await assertVersionInRecipe(body.versionId, recipeId!);
    if (body.assigneeId) {
      await assertUsersInWorkspace(access.workspaceId, [body.assigneeId]);
    }

    // 默认落到当前草稿版本，保证"整理结果"始终有归属
    let versionId = body.versionId ?? null;
    if (!versionId) {
      const draft = await prisma.recipeVersion.findFirst({
        where: { recipeId: recipeId!, status: 'draft' },
        select: { id: true },
      });
      versionId =
        draft?.id ??
        (
          await prisma.recipeVersion.findFirst({
            where: { recipeId: recipeId!, status: 'published' },
            select: { id: true },
          })
        )?.id ??
        null;
    }

    const item = await prisma.vagueItem.create({
      data: {
        id: newId(),
        recipeId: recipeId!,
        versionId,
        stepId: body.stepId ?? null,
        clipId: body.clipId ?? null,
        category: body.category,
        rawPhrase: body.rawPhrase,
        transcript: body.transcript ?? null,
        status: 'open',
        assigneeId: body.assigneeId ?? null,
        createdBy: req.auth!.userId,
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'vague_item.create',
      entityType: 'vague_item',
      entityId: item.id,
      after: { rawPhrase: item.rawPhrase, category: item.category },
    });

    emitToWorkspace(access.workspaceId, 'vague_item:new', { recipeId: recipeId!, itemId: item.id });
    created(res, toVagueItemDto(item));
  }),
);

/* ------------------------------------------------------------------ */
/* 详情                                                                */
/* ------------------------------------------------------------------ */

async function loadVagueItemDetail(itemId: string) {
  const item = await prisma.vagueItem.findUnique({
    where: { id: itemId },
    include: {
      clip: { include: { audio: true } },
      answerClip: { include: { audio: true } },
      assignee: { select: { id: true, displayName: true, avatarUrl: true } },
      step: { select: { id: true, title: true, orderIndex: true } },
    },
  });
  if (!item) throw notFound('待澄清条目');
  return item;
}

vagueItemRouter.get(
  '/vague-items/:itemId',
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    await assertVagueItemRole(req.auth!.userId, itemId!, 'viewer');

    const item = await loadVagueItemDetail(itemId!);
    send(res, {
      ...toVagueItemDto(item),
      clip: item.clip ? toClipDto(item.clip) : null,
      clipAudio: item.clip ? toAudioDto(item.clip.audio) : null,
      answerClip: item.answerClip ? toClipDto(item.answerClip) : null,
      answerClipAudio: item.answerClip ? toAudioDto(item.answerClip.audio) : null,
      assignee: item.assignee,
      step: item.step,
    });
  }),
);

vagueItemRouter.patch(
  '/vague-items/:itemId',
  validateBody(updateVagueItemSchema),
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const access = await assertVagueItemRole(req.auth!.userId, itemId!, 'contributor');

    const before = await prisma.vagueItem.findUnique({ where: { id: itemId! } });
    if (!before) throw notFound('待澄清条目');

    const body = req.body as Record<string, unknown>;
    // 两个人同时编辑同一条时，后提交的人不应该静默覆盖先提交的人
    assertNotStale(before.updatedAt, body.expectedUpdatedAt as string | undefined, {
      current: toVagueItemDto(before),
    });

    if (body.stepId) await assertStepInRecipe(req.auth!.userId, body.stepId as string, access.recipeId);
    if (body.versionId) await assertVersionInRecipe(body.versionId as string, access.recipeId);
    if (body.clipId) await assertClipInRecipe(req.auth!.userId, body.clipId as string, access.recipeId);
    if (body.assigneeId) {
      await assertUsersInWorkspace(access.workspaceId, [body.assigneeId as string]);
    }

    const item = await prisma.vagueItem.update({
      where: { id: itemId! },
      data: {
        ...(body.category !== undefined ? { category: body.category as string } : {}),
        ...(body.rawPhrase !== undefined ? { rawPhrase: body.rawPhrase as string } : {}),
        ...(body.transcript !== undefined ? { transcript: body.transcript as string | null } : {}),
        ...(body.stepId !== undefined ? { stepId: body.stepId as string | null } : {}),
        ...(body.versionId !== undefined ? { versionId: body.versionId as string | null } : {}),
        ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId as string | null } : {}),
        ...(body.clipId !== undefined ? { clipId: body.clipId as string | null } : {}),
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'vague_item.update',
      entityType: 'vague_item',
      entityId: item.id,
      before: { category: before.category, rawPhrase: before.rawPhrase },
      after: { category: item.category, rawPhrase: item.rawPhrase },
    });

    emitToWorkspace(access.workspaceId, 'vague_item:updated', toVagueItemDto(item));
    send(res, toVagueItemDto(item));
  }),
);

/* ------------------------------------------------------------------ */
/* 追问                                                                */
/* ------------------------------------------------------------------ */

vagueItemRouter.post(
  '/vague-items/:itemId/ask',
  validateBody(askVagueItemSchema),
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const access = await assertVagueItemRole(req.auth!.userId, itemId!, 'contributor');
    assertTransition(access.status, 'asked');

    const { question, assigneeId } = req.body as { question: string; assigneeId?: string | null };
    const target = assigneeId ?? (await prisma.vagueItem.findUnique({ where: { id: itemId! } }))?.assigneeId;

    // 不能把追问推给空间外的人 —— 通知里带着这张食谱的原话
    if (target) await assertUsersInWorkspace(access.workspaceId, [target]);

    const item = await prisma.vagueItem.update({
      where: { id: itemId! },
      data: {
        status: 'asked',
        question,
        questionAskedAt: new Date(),
        ...(assigneeId !== undefined ? { assigneeId } : {}),
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'vague_item.ask',
      entityType: 'vague_item',
      entityId: item.id,
      after: { question, assigneeId: target ?? null },
    });

    if (target) {
      await notify({
        userIds: [target],
        type: 'assigned',
        payload: {
          recipeId: item.recipeId,
          itemId: item.id,
          rawPhrase: item.rawPhrase,
          question,
          message: `有人问你："${question}"（原话：${item.rawPhrase}）`,
        },
      });
    }

    emitToWorkspace(access.workspaceId, 'vague_item:updated', toVagueItemDto(item));
    send(res, toVagueItemDto(item));
  }),
);

vagueItemRouter.post(
  '/vague-items/:itemId/answer',
  validateBody(answerVagueItemSchema),
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const access = await assertVagueItemRole(req.auth!.userId, itemId!, 'contributor');
    assertTransition(access.status, 'answered');

    const { answerText, answerClipId } = req.body as {
      answerText?: string | null;
      answerClipId?: string | null;
    };

    // 语音答复必须来自同一张食谱，否则会把别的菜的原声挂到这条结论上
    if (answerClipId) await assertClipInRecipe(req.auth!.userId, answerClipId, access.recipeId);

    const item = await prisma.vagueItem.update({
      where: { id: itemId! },
      data: {
        status: 'answered',
        answerText: answerText ?? null,
        answerClipId: answerClipId ?? null,
        answerAt: new Date(),
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'vague_item.answer',
      entityType: 'vague_item',
      entityId: item.id,
      after: { answerText: item.answerText, hasVoice: Boolean(answerClipId) },
    });

    await notify({
      userIds: [access.createdBy, item.assigneeId ?? ''].filter(Boolean),
      type: 'answered',
      excludeUserId: req.auth!.userId,
      payload: {
        recipeId: item.recipeId,
        itemId: item.id,
        rawPhrase: item.rawPhrase,
        message: `「${item.rawPhrase}」已有人回答，可以去整理成可复做结论了`,
      },
    });

    emitToWorkspace(access.workspaceId, 'vague_item:updated', toVagueItemDto(item));
    send(res, toVagueItemDto(item));
  }),
);

/* ------------------------------------------------------------------ */
/* 归纳为可复做规格                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把答复归纳成结构化结论。
 *
 * 这是整个产品最核心的一次写入：
 * - 规格必须通过 validateResolvedSpec（不同分类有不同必填项）；
 * - 证据必须能追溯到原声片段或答复人；
 * - 可选地，把结论同步写进某条用量或某个步骤。
 */
vagueItemRouter.post(
  '/vague-items/:itemId/resolve',
  validateBody(resolveVagueItemSchema),
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const access = await assertVagueItemRole(req.auth!.userId, itemId!, 'editor');
    assertTransition(access.status, 'resolved');

    const { resolvedSpec, applyToIngredientId, applyToStepId } = req.body as {
      resolvedSpec: ResolvedSpec;
      applyToIngredientId?: string | null;
      applyToStepId?: string | null;
    };

    const existing = await prisma.vagueItem.findUnique({ where: { id: itemId! } });
    if (!existing) throw notFound('待澄清条目');

    // 写回目标必须属于同一张食谱。
    // 不校验的话，只要拿到别的家庭空间里任意一条用量/步骤的 id，
    // 就能借"整理结论"这一步改掉别人的数据（跨空间越权写入）。
    if (applyToIngredientId) {
      await assertIngredientInRecipe(req.auth!.userId, applyToIngredientId, access.recipeId);
    }
    if (applyToStepId) {
      await assertStepInRecipe(req.auth!.userId, applyToStepId, access.recipeId);
    }

    // 证据缺省补齐：优先用条目自身的原声片段与答复人
    const spec: ResolvedSpec = {
      ...resolvedSpec,
      evidence: {
        clipId: resolvedSpec.evidence?.clipId ?? existing.clipId ?? null,
        answeredBy: resolvedSpec.evidence?.answeredBy ?? null,
        answeredAt: resolvedSpec.evidence?.answeredAt ?? existing.answerAt?.toISOString() ?? null,
      },
    };

    const issues = validateResolvedSpec(spec);
    if (issues.length) {
      throw new ApiError('SPEC_INCOMPLETE', '可复做规格填写不完整', issues);
    }

    const item = await prisma.$transaction(async (tx) => {
      if (applyToIngredientId) {
        const ingredient = await tx.ingredient.findUnique({ where: { id: applyToIngredientId } });
        if (!ingredient) throw notFound('用量');
        await tx.ingredient.update({
          where: { id: applyToIngredientId },
          data: {
            amountValue: typeof spec.value === 'number' ? spec.value : null,
            amountUnit: spec.unit ?? ingredient.amountUnit,
            amountMin: spec.range?.min ?? null,
            amountMax: spec.range?.max ?? null,
            isVague: true,
            vagueItemId: itemId!,
            note: spec.reference ?? ingredient.note,
          },
        });
      }

      if (applyToStepId) {
        const step = await tx.step.findUnique({ where: { id: applyToStepId } });
        if (!step) throw notFound('步骤');
        await tx.step.update({
          where: { id: applyToStepId },
          data: {
            ...(spec.type === 'heat'
              ? { sensoryCues: stringifyJson([...(parseJson<string[]>(step.sensoryCues, []) ?? []), spec.criterion ?? ''].filter(Boolean)) }
              : {}),
            ...(spec.type === 'time' && spec.range
              ? {
                  durationSecondsMin: Math.round(spec.range.min * 60),
                  durationSecondsMax: Math.round(spec.range.max * 60),
                }
              : {}),
            ...(spec.type === 'time' && typeof spec.value === 'number' && !spec.range
              ? { durationSecondsMin: Math.round(spec.value * 60), durationSecondsMax: Math.round(spec.value * 60) }
              : {}),
          },
        });
      }

      return tx.vagueItem.update({
        where: { id: itemId! },
        data: {
          status: 'resolved',
          resolvedSpec: stringifyJson(spec),
          confidence: spec.confidence,
          resolvedBy: req.auth!.userId,
          resolvedAt: new Date(),
        },
      });
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'vague_item.resolve',
      entityType: 'vague_item',
      entityId: item.id,
      before: { resolvedSpec: existing.resolvedSpec },
      after: { resolvedSpec: spec, confidence: spec.confidence },
    });

    emitToWorkspace(access.workspaceId, 'vague_item:updated', toVagueItemDto(item));
    send(res, toVagueItemDto(item));
  }),
);

/**
 * 重新确认一条已规格化的结论。
 *
 * 存在的场景：复做出现偏差时系统会把既有结论降级为"暂定"，
 * 以避免带着可疑结论继续发布。整理者逐条复核后，
 * 认为某条其实没问题，就调用这里把它确认回 confirmed。
 */
vagueItemRouter.post(
  '/vague-items/:itemId/confirm',
  validateBody(confirmVagueItemSchema),
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const access = await assertVagueItemRole(req.auth!.userId, itemId!, 'editor');

    if (access.status !== 'resolved') {
      throw new ApiError(
        'VAGUE_INVALID_TRANSITION',
        `只有"已规格化"的条目才能重新确认，当前状态为「${access.status}」`,
      );
    }

    const before = await prisma.vagueItem.findUnique({ where: { id: itemId! } });
    if (!before) throw notFound('待澄清条目');

    const { note } = req.body as { note?: string | null };
    const item = await prisma.vagueItem.update({
      where: { id: itemId! },
      data: {
        confidence: 'confirmed',
        resolvedBy: req.auth!.userId,
        resolvedAt: new Date(),
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'vague_item.confirm',
      entityType: 'vague_item',
      entityId: item.id,
      before: { confidence: before.confidence },
      after: { confidence: 'confirmed', note: note ?? null },
    });

    emitToWorkspace(access.workspaceId, 'vague_item:updated', toVagueItemDto(item));
    send(res, toVagueItemDto(item));
  }),
);

vagueItemRouter.post(
  '/vague-items/:itemId/mark-unresolvable',
  validateBody(markUnresolvableSchema),
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const access = await assertVagueItemRole(req.auth!.userId, itemId!, 'editor');
    assertTransition(access.status, 'unresolvable');

    const { note } = req.body as { note: string };
    const item = await prisma.vagueItem.update({
      where: { id: itemId! },
      data: {
        status: 'unresolvable',
        unresolvableNote: note,
        resolvedBy: req.auth!.userId,
        resolvedAt: new Date(),
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'vague_item.mark_unresolvable',
      entityType: 'vague_item',
      entityId: item.id,
      after: { note },
    });

    emitToWorkspace(access.workspaceId, 'vague_item:updated', toVagueItemDto(item));
    send(res, toVagueItemDto(item));
  }),
);

vagueItemRouter.post(
  '/vague-items/:itemId/reopen',
  validateBody(reopenVagueItemSchema),
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const access = await assertVagueItemRole(req.auth!.userId, itemId!, 'editor');

    const { reason } = req.body as { reason: string };
    const item = await prisma.vagueItem.update({
      where: { id: itemId! },
      data: { status: 'open', resolvedSpec: null, confidence: null, resolvedAt: null },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'vague_item.reopen',
      entityType: 'vague_item',
      entityId: item.id,
      before: { status: access.status },
      after: { status: 'open', reason },
    });

    emitToWorkspace(access.workspaceId, 'vague_item:updated', toVagueItemDto(item));
    send(res, toVagueItemDto(item));
  }),
);

/* ------------------------------------------------------------------ */
/* 逐级提醒（催促滞留条目）                                              */
/* ------------------------------------------------------------------ */

/**
 * 对一条没人处理的条目发出提醒，级别随次数逐级升高：
 * 第 1 次只提醒负责人，第 2 次加上能下结论的整理者，第 3 次提醒全体家庭成员。
 *
 * 只写通知与审计日志，不改条目本身 —— 催一下不算"处理了"，
 * 条目的滞留计时（updatedAt）不该因此被重置。
 */
vagueItemRouter.post(
  '/vague-items/:itemId/nudge',
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const access = await assertVagueItemRole(req.auth!.userId, itemId!, 'viewer');

    if ((TERMINAL_VAGUE_STATUSES as readonly string[]).includes(access.status)) {
      throw new ApiError('VAGUE_INVALID_TRANSITION', '这条条目已经收口，不需要再提醒');
    }

    const item = await prisma.vagueItem.findUnique({ where: { id: itemId! } });
    if (!item) throw notFound('待澄清条目');

    const { count, lastNudgedAt } = await getNudgeState(itemId!);
    if (isInNudgeCooldown(lastNudgedAt)) {
      throw new ApiError(
        'RATE_LIMITED',
        `这条条目刚提醒过，${NUDGE_COOLDOWN_HOURS} 小时内不要重复催，给家人一点消化时间`,
      );
    }

    // 负责人：被指派人优先，否则是提出人
    const ownerId = item.assigneeId ?? item.createdBy;

    // 逐级扩大提醒范围；如果某一级的目标只剩操作者自己（比如自己催自己负责的条目），
    // 就继续往上升一级，保证"逐级提醒家庭成员"不落空
    let level = Math.min(count + 1, NUDGE_MAX_LEVEL);
    let targetIds: string[] = [];
    while (level <= NUDGE_MAX_LEVEL) {
      targetIds = [...new Set(await nudgeTargetsForLevel(level, ownerId, access.workspaceId))].filter(
        (id) => id !== req.auth!.userId,
      );
      if (targetIds.length || level === NUDGE_MAX_LEVEL) break;
      level += 1;
    }

    const staleDays = Math.max(0, Math.floor((Date.now() - item.updatedAt.getTime()) / (24 * 3600 * 1000)));

    if (targetIds.length) {
      await notify({
        userIds: targetIds,
        type: 'nudge',
        payload: {
          recipeId: item.recipeId,
          itemId: item.id,
          rawPhrase: item.rawPhrase,
          level,
          levelLabel: NUDGE_LEVEL_LABELS[level],
          staleDays,
          message: `「${item.rawPhrase}」已经 ${staleDays} 天没人处理了，帮忙推进一下`,
        },
      });
    }

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: NUDGE_ACTION,
      entityType: 'vague_item',
      entityId: item.id,
      after: { level, targetUserIds: targetIds, staleDays },
    });

    send(res, {
      itemId: item.id,
      level,
      notifiedUserIds: targetIds,
      cooldownHours: NUDGE_COOLDOWN_HOURS,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* 变更历史                                                            */
/* ------------------------------------------------------------------ */

vagueItemRouter.get(
  '/vague-items/:itemId/history',
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    await assertVagueItemRole(req.auth!.userId, itemId!, 'viewer');

    const logs = await prisma.activityLog.findMany({
      where: { entityType: 'vague_item', entityId: itemId! },
      include: { actor: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });

    send(res, logs.map(toActivityDto));
  }),
);

/* ------------------------------------------------------------------ */
/* 供前端展示的"今日待办"                                              */
/* ------------------------------------------------------------------ */

vagueItemRouter.get(
  '/recipes/:recipeId/vague-items/summary',
  asyncHandler(async (req, res) => {
    const { recipeId } = req.params;
    await assertRecipeRole(req.auth!.userId, recipeId!, 'viewer');

    const groups = await prisma.vagueItem.groupBy({
      by: ['status'],
      where: { recipeId: recipeId! },
      _count: { _all: true },
    });

    const byStatus: Record<string, number> = {};
    for (const group of groups) byStatus[group.status] = group._count._all;

    send(res, {
      byStatus,
      todo: {
        toAsk: byStatus.open ?? 0,
        toResolve: (byStatus.answered ?? 0) + (byStatus.asked ?? 0),
        toVerify: byStatus.resolved ?? 0,
      },
    });
  }),
);
