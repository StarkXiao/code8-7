/**
 * 成员统计 + 滞留条目逐级提醒 的接口测试。
 *
 * 覆盖：
 * - 按成员统计贡献量（录音/条目/答复/评论）与积压（待答复、其中滞留）；
 * - 滞留条目标出负责人（被指派人优先，否则提出人）；
 * - 逐级提醒：L1 负责人 → L2 负责人+整理者 → L3 全家，之后封顶；
 * - 提醒冷却、终态不可提醒、自己催自己时自动升级、非成员被拒。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db/client';

const app = createApp();
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

interface Session {
  token: string;
  userId: string;
}

async function register(email: string, displayName: string): Promise<Session> {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'froa12345', displayName })
    .expect(201);
  return {
    token: response.body.data.tokens.accessToken as string,
    userId: response.body.data.user.id as string,
  };
}

const auth = (session: Session) => ({ Authorization: `Bearer ${session.token}` });

/** 把条目的 updatedAt 直接改到过去（Prisma 的 @updatedAt 会覆盖常规 update，只能走 SQL） */
async function ageVagueItem(itemId: string, days: number) {
  const past = new Date(Date.now() - days * DAY_MS).toISOString();
  await prisma.$executeRaw`UPDATE VagueItem SET updatedAt = ${past} WHERE id = ${itemId}`;
}

/** 把某条目全部提醒日志的时间改到过去，模拟"冷却期已过" */
async function ageNudgeLogs(itemId: string, hours: number) {
  await prisma.activityLog.updateMany({
    where: { action: 'vague_item.nudge', entityId: itemId },
    data: { createdAt: new Date(Date.now() - hours * HOUR_MS) },
  });
}

async function createItem(
  session: Session,
  recipeId: string,
  rawPhrase: string,
  assigneeId?: string,
): Promise<string> {
  const response = await request(app)
    .post(`/api/recipes/${recipeId}/vague-items`)
    .set(auth(session))
    .send({ category: 'amount', rawPhrase, ...(assigneeId ? { assigneeId } : {}) })
    .expect(201);
  return response.body.data.id as string;
}

describe('成员统计与滞留条目逐级提醒', () => {
  let organizer: Session; // owner
  let elder: Session; // contributor
  let third: Session; // contributor
  let outsider: Session;
  let workspaceId = '';
  let recipeId = '';
  let itemAnswered = ''; // 已答复（新鲜，不滞留）
  let itemStaleByCreator = ''; // elder 提出、无人指派 → 负责人是提出人
  let itemStaleByAssignee = ''; // organizer 提出、指派给 elder → 负责人是被指派人

  beforeAll(async () => {
    organizer = await register('stats-organizer@e2e.test', '整理者');
    elder = await register('stats-elder@e2e.test', '外婆');
    third = await register('stats-third@e2e.test', '表哥');
    outsider = await register('stats-outsider@e2e.test', '路人');

    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(organizer))
      .send({ name: '统计测试厨房' })
      .expect(201);
    workspaceId = ws.body.data.id;
    for (const member of [elder, third]) {
      await request(app)
        .post('/api/workspaces/join')
        .set(auth(member))
        .send({ inviteCode: ws.body.data.inviteCode })
        .expect(201);
    }

    const recipe = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId, title: '红烧肉' })
      .expect(201);
    recipeId = recipe.body.data.id;

    // organizer 的贡献：1 段录音 + 2 个条目 + 1 条评论
    await request(app)
      .post('/api/audio')
      .set(auth(organizer))
      .field('recipeId', recipeId)
      .field('kind', 'recipe_voice')
      .field('durationMs', '1000')
      .attach('file', Buffer.from('RIFF....WAVEfmt '), { filename: 'v.wav', contentType: 'audio/wav' })
      .expect(201);

    itemAnswered = await createItem(organizer, recipeId, '放一点点糖', elder.userId);
    itemStaleByAssignee = await createItem(organizer, recipeId, '炒到变色', elder.userId);
    itemStaleByCreator = await createItem(elder, recipeId, '揉到不粘手');

    // elder 的贡献：1 个条目 + 1 次答复
    await request(app)
      .post(`/api/vague-items/${itemAnswered}/answer`)
      .set(auth(elder))
      .send({ answerText: '大概三克' })
      .expect(200);

    await request(app)
      .post('/api/comments')
      .set(auth(organizer))
      .send({ targetType: 'recipe', targetId: recipeId, body: '我周末来整理' })
      .expect(201);

    // 两条条目 5 天没人碰 → 滞留；已答复那条保持新鲜
    await ageVagueItem(itemStaleByAssignee, 5);
    await ageVagueItem(itemStaleByCreator, 5);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. 按成员统计贡献量与积压', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/member-stats`)
      .set(auth(organizer))
      .expect(200);

    expect(res.body.data.staleDays).toBe(3);
    const members = res.body.data.members;
    expect(members).toHaveLength(3);

    const org = members.find((m: { userId: string }) => m.userId === organizer.userId);
    expect(org.contributions.audioUploaded).toBe(1);
    expect(org.contributions.itemsCreated).toBe(2);
    expect(org.contributions.commentsPosted).toBe(1);
    expect(org.contributions.total).toBe(4);
    expect(org.backlog.toAnswer).toBe(0);

    const grandma = members.find((m: { userId: string }) => m.userId === elder.userId);
    expect(grandma.contributions.itemsCreated).toBe(1);
    expect(grandma.contributions.answersGiven).toBe(1);
    // 外婆头上还挂着一条没答复的（itemStaleByAssignee），且已滞留
    expect(grandma.backlog.toAnswer).toBe(1);
    expect(grandma.backlog.staleToAnswer).toBe(1);
  });

  it('2. 滞留条目标出负责人：被指派人优先，否则是提出人', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/member-stats`)
      .set(auth(organizer))
      .expect(200);

    const staleItems = res.body.data.staleItems;
    const ids = staleItems.map((item: { id: string }) => item.id);
    expect(ids).toContain(itemStaleByAssignee);
    expect(ids).toContain(itemStaleByCreator);
    // 已答复且刚更新过的条目不算滞留
    expect(ids).not.toContain(itemAnswered);

    const byAssignee = staleItems.find((item: { id: string }) => item.id === itemStaleByAssignee);
    expect(byAssignee.owner.id).toBe(elder.userId);
    expect(byAssignee.ownerKind).toBe('assignee');
    expect(byAssignee.staleDays).toBeGreaterThanOrEqual(5);
    expect(byAssignee.recipeTitle).toBe('红烧肉');
    expect(byAssignee.nudgeCount).toBe(0);
    expect(byAssignee.canNudge).toBe(true);
    expect(byAssignee.nextNudgeLevel).toBe(1);

    const byCreator = staleItems.find((item: { id: string }) => item.id === itemStaleByCreator);
    expect(byCreator.owner.id).toBe(elder.userId);
    expect(byCreator.ownerKind).toBe('creator');

    // 阈值调大后，5 天的条目就不再算滞留
    const strict = await request(app)
      .get(`/api/workspaces/${workspaceId}/member-stats?staleDays=10`)
      .set(auth(organizer))
      .expect(200);
    expect(strict.body.data.staleItems).toHaveLength(0);
  });

  it('3. 第一次提醒只通知负责人（L1）', async () => {
    const res = await request(app)
      .post(`/api/vague-items/${itemStaleByAssignee}/nudge`)
      .set(auth(third))
      .expect(200);

    expect(res.body.data.level).toBe(1);
    expect(res.body.data.notifiedUserIds).toEqual([elder.userId]);

    const notifications = await request(app)
      .get('/api/notifications')
      .set(auth(elder))
      .expect(200);
    const nudge = notifications.body.data.find(
      (n: { type: string; payload: { itemId?: string } | null }) =>
        n.type === 'nudge' && n.payload?.itemId === itemStaleByAssignee,
    );
    expect(nudge).toBeTruthy();
    expect(nudge.payload.level).toBe(1);
    expect(nudge.payload.message).toContain('炒到变色');
  });

  it('4. 冷却期内重复提醒被拒（429）', async () => {
    const res = await request(app)
      .post(`/api/vague-items/${itemStaleByAssignee}/nudge`)
      .set(auth(third))
      .expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('5. 冷却过后再提醒升级为 L2（负责人 + 整理者）', async () => {
    await ageNudgeLogs(itemStaleByAssignee, 21);

    const res = await request(app)
      .post(`/api/vague-items/${itemStaleByAssignee}/nudge`)
      .set(auth(third))
      .expect(200);

    expect(res.body.data.level).toBe(2);
    // 负责人外婆 + 空间 owner；操作者表哥自己被排除
    expect(res.body.data.notifiedUserIds.sort()).toEqual([elder.userId, organizer.userId].sort());
  });

  it('6. 第三次提醒全家（L3），之后封顶不再升', async () => {
    await ageNudgeLogs(itemStaleByAssignee, 21);
    const third1 = await request(app)
      .post(`/api/vague-items/${itemStaleByAssignee}/nudge`)
      .set(auth(third))
      .expect(200);
    expect(third1.body.data.level).toBe(3);
    expect(third1.body.data.notifiedUserIds.sort()).toEqual(
      [elder.userId, organizer.userId].sort(),
    );

    await ageNudgeLogs(itemStaleByAssignee, 21);
    const fourth = await request(app)
      .post(`/api/vague-items/${itemStaleByAssignee}/nudge`)
      .set(auth(third))
      .expect(200);
    expect(fourth.body.data.level).toBe(3);
  });

  it('7. 自己催自己负责的条目时自动升级到下一级', async () => {
    // itemStaleByCreator 的负责人就是外婆自己；L1 只剩她自己 → 自动升 L2 提醒整理者
    const res = await request(app)
      .post(`/api/vague-items/${itemStaleByCreator}/nudge`)
      .set(auth(elder))
      .expect(200);

    expect(res.body.data.level).toBe(2);
    expect(res.body.data.notifiedUserIds).toEqual([organizer.userId]);
  });

  it('8. 提醒历史会反映在统计里', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/member-stats`)
      .set(auth(organizer))
      .expect(200);

    const item = res.body.data.staleItems.find(
      (entry: { id: string }) => entry.id === itemStaleByAssignee,
    );
    expect(item.nudgeCount).toBe(4);
    expect(item.lastNudgedAt).toBeTruthy();
    // 最后一次提醒是"现在"发出的，仍在冷却期
    expect(item.canNudge).toBe(false);
    expect(item.nextNudgeLevel).toBe(3);
  });

  it('9. 终态条目不能再提醒', async () => {
    await request(app)
      .post(`/api/vague-items/${itemAnswered}/mark-unresolvable`)
      .set(auth(organizer))
      .send({ note: '外婆说这条真的说不清了' })
      .expect(200);

    await request(app)
      .post(`/api/vague-items/${itemAnswered}/nudge`)
      .set(auth(third))
      .expect(409);
  });

  it('10. 非成员看不了统计、也催不了条目', async () => {
    await request(app)
      .get(`/api/workspaces/${workspaceId}/member-stats`)
      .set(auth(outsider))
      .expect(403);

    await request(app)
      .post(`/api/vague-items/${itemStaleByAssignee}/nudge`)
      .set(auth(outsider))
      .expect(403);
  });
});
