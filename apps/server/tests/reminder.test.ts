/**
 * 成员贡献 / 积压统计 + 滞留条目逐级提醒。
 *
 * 覆盖：
 * - 按成员统计贡献量（来自审计日志）与积压（负责人口径）；
 * - 滞留条目列表会标出负责人（被指派人 → 食谱创建者 → 空间所有者）；
 * - 逐级提醒 1 → 2 → 3，通知范围逐级扩大，到顶后拒绝再提醒；
 * - 条目一旦被处理，提醒级别归零重计；
 * - 已收口条目不允许提醒；旁观者不允许提醒；非成员看不到统计。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db/client';

const app = createApp();

const DAY_MS = 24 * 60 * 60 * 1000;

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

interface MemberStatsRow {
  userId: string;
  contributions: Record<string, number>;
  contributionTotal: number;
  backlog: { openItems: number; staleItems: number; oldestStaleDays: number };
}

async function fetchMemberStats(session: Session, wsId: string, staleDays?: number) {
  const response = await request(app)
    .get(`/api/workspaces/${wsId}/member-stats${staleDays ? `?staleDays=${staleDays}` : ''}`)
    .set(auth(session))
    .expect(200);
  const members = response.body.data.members as MemberStatsRow[];
  const byId = new Map(members.map((m) => [m.userId, m]));
  return { members, byId };
}

/** 提醒接口不动条目的 updatedAt，所以测试里直接把时钟拨回过去来制造"滞留" */
async function backdate(itemId: string, days: number) {
  await prisma.vagueItem.update({
    where: { id: itemId },
    data: { updatedAt: new Date(Date.now() - days * DAY_MS) },
  });
}

/** 把这条条目已有的提醒记录也拨回过去 —— 模拟"提醒发生在处理之前" */
async function backdateReminders(itemId: string, days: number) {
  await prisma.activityLog.updateMany({
    where: { entityType: 'vague_item', entityId: itemId, action: 'vague_item.remind' },
    data: { createdAt: new Date(Date.now() - days * DAY_MS) },
  });
}

async function reminderNotifications(session: Session) {
  const response = await request(app)
    .get('/api/notifications')
    .set(auth(session))
    .expect(200);
  return (response.body.data as { type: string; payload: { level?: number; itemId?: string } }[]).filter(
    (n) => n.type === 'reminder',
  );
}

describe('成员贡献统计与滞留条目逐级提醒', () => {
  let organizer: Session; // 空间所有者、食谱创建者
  let elder: Session; // 贡献者，条目 A 的被指派人
  let aunt: Session; // 整理者（editor），用来验证二级提醒会叫到整理者
  let outsider: Session;
  let workspaceId = '';
  let inviteCode = '';
  let recipeId = '';
  let itemAssigned = ''; // 指派给外婆，滞留 5 天
  let itemUnassigned = ''; // 没人认领，滞留 10 天，负责人应落到食谱创建者头上
  let itemFresh = ''; // 刚创建，不算滞留

  beforeAll(async () => {
    organizer = await register('stats-organizer@test.dev', '整理者');
    elder = await register('stats-elder@test.dev', '外婆');
    aunt = await register('stats-aunt@test.dev', '大姨');
    outsider = await register('stats-outsider@test.dev', '路人');

    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(organizer))
      .send({ name: '统计测试厨房' })
      .expect(201);
    workspaceId = ws.body.data.id;
    inviteCode = ws.body.data.inviteCode;

    await request(app).post('/api/workspaces/join').set(auth(elder)).send({ inviteCode }).expect(201);
    await request(app).post('/api/workspaces/join').set(auth(aunt)).send({ inviteCode }).expect(201);
    // 大姨升级为整理者，二级提醒才会找到她
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${aunt.userId}`)
      .set(auth(organizer))
      .send({ role: 'editor' })
      .expect(200);

    const recipe = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId, title: '红烧肉' })
      .expect(201);
    recipeId = recipe.body.data.id;

    const makeItem = async (rawPhrase: string, assigneeId?: string) => {
      const response = await request(app)
        .post(`/api/recipes/${recipeId}/vague-items`)
        .set(auth(organizer))
        .send({ category: 'amount', rawPhrase, ...(assigneeId ? { assigneeId } : {}) })
        .expect(201);
      return response.body.data.id as string;
    };

    itemAssigned = await makeItem('放一点点糖', elder.userId);
    itemUnassigned = await makeItem('炒到差不多就行');
    itemFresh = await makeItem('加一丢丢盐');

    await backdate(itemAssigned, 5);
    await backdate(itemUnassigned, 10);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('按成员统计贡献量：谁提了条目、谁回答了，都记在各自头上', async () => {
    // 外婆回答一次，贡献里应该出现一条"回答追问"
    await request(app)
      .post(`/api/vague-items/${itemAssigned}/answer`)
      .set(auth(elder))
      .send({ answerText: '就是喝汤那种小勺，半勺' })
      .expect(200);
    // 回答完重新拨回滞留状态，不影响后续用例
    await backdate(itemAssigned, 5);

    const { members, byId } = await fetchMemberStats(organizer, workspaceId);
    expect(members).toHaveLength(3);

    // 整理者：提了 3 条待澄清 + 建了食谱（recipe.create 不计入口径）
    expect(byId.get(organizer.userId)?.contributions.itemsCreated).toBe(3);
    expect(byId.get(organizer.userId)?.contributionTotal).toBe(3);
    // 外婆：回答了 1 次追问
    expect(byId.get(elder.userId)?.contributions.answersGiven).toBe(1);
    // 大姨：还没动手，贡献为 0
    expect(byId.get(aunt.userId)?.contributionTotal).toBe(0);
  });

  it('按成员统计积压：条目算到负责人头上，滞留天数取最久一条', async () => {
    const { byId } = await fetchMemberStats(organizer, workspaceId, 3);

    // 外婆：1 条指派给她的，滞留 5 天
    expect(byId.get(elder.userId)?.backlog.openItems).toBe(1);
    expect(byId.get(elder.userId)?.backlog.staleItems).toBe(1);
    expect(byId.get(elder.userId)?.backlog.oldestStaleDays).toBe(5);
    // 整理者：没人认领的那条 + 刚创建的那条都落到食谱创建者头上；最久 10 天
    expect(byId.get(organizer.userId)?.backlog.openItems).toBe(2);
    expect(byId.get(organizer.userId)?.backlog.staleItems).toBe(1);
    expect(byId.get(organizer.userId)?.backlog.oldestStaleDays).toBe(10);
    // 大姨：无积压
    expect(byId.get(aunt.userId)?.backlog.openItems).toBe(0);
  });

  it('滞留条目列表标出负责人：被指派的归指派人，没指派的归食谱创建者', async () => {
    const response = await request(app)
      .get(`/api/workspaces/${workspaceId}/stale-items?days=3`)
      .set(auth(organizer))
      .expect(200);

    const items = response.body.data.items as {
      itemId: string;
      staleDays: number;
      reminderLevel: number;
      responsible: { userId: string; source: string };
    }[];

    // 刚创建的那条不该出现；结果按滞留时长降序
    expect(items.map((i) => i.itemId)).toEqual([itemUnassigned, itemAssigned]);

    const assigned = items.find((i) => i.itemId === itemAssigned)!;
    expect(assigned.responsible).toMatchObject({ userId: elder.userId, source: 'assignee' });
    expect(assigned.staleDays).toBe(5);
    expect(assigned.reminderLevel).toBe(0);

    const unassigned = items.find((i) => i.itemId === itemUnassigned)!;
    expect(unassigned.responsible).toMatchObject({ userId: organizer.userId, source: 'recipe_creator' });
    expect(unassigned.staleDays).toBe(10);
  });

  it('滞留阈值可调：days=7 时只剩最久的那一条', async () => {
    const response = await request(app)
      .get(`/api/workspaces/${workspaceId}/stale-items?days=7`)
      .set(auth(organizer))
      .expect(200);
    const items = response.body.data.items as { itemId: string }[];
    expect(items.map((i) => i.itemId)).toEqual([itemUnassigned]);
  });

  it('逐级提醒：1 级只找负责人，2 级叫上整理者，3 级全家知悉，到顶为止', async () => {
    // —— 第 1 级：只通知负责人（外婆）——
    const first = await request(app)
      .post(`/api/vague-items/${itemAssigned}/remind`)
      .set(auth(organizer))
      .expect(200);
    expect(first.body.data.level).toBe(1);
    expect(first.body.data.notifiedUserIds).toEqual([elder.userId]);
    expect(await reminderNotifications(elder)).toHaveLength(1);
    expect(await reminderNotifications(aunt)).toHaveLength(0);

    // —— 第 2 级：负责人 + 所有者 + 整理者；触发者本人不重复收 ——
    const second = await request(app)
      .post(`/api/vague-items/${itemAssigned}/remind`)
      .set(auth(organizer))
      .expect(200);
    expect(second.body.data.level).toBe(2);
    // notifiedUserIds 是真实会收到通知的人：触发者（组织者）已被排除
    expect(new Set(second.body.data.notifiedUserIds)).toEqual(new Set([elder.userId, aunt.userId]));
    expect(await reminderNotifications(elder)).toHaveLength(2);
    expect(await reminderNotifications(aunt)).toHaveLength(1);
    expect(await reminderNotifications(organizer)).toHaveLength(0); // 触发者被排除

    // —— 第 3 级：全家知悉。换大姨触发，组织者这次能收到 ——
    const third = await request(app)
      .post(`/api/vague-items/${itemAssigned}/remind`)
      .set(auth(aunt))
      .expect(200);
    expect(third.body.data.level).toBe(3);
    expect(await reminderNotifications(organizer)).toHaveLength(1);
    expect(await reminderNotifications(elder)).toHaveLength(3);

    // —— 到顶：第 4 次直接拒绝 ——
    await request(app).post(`/api/vague-items/${itemAssigned}/remind`).set(auth(aunt)).expect(400);

    // 列表里能看到的当前级别
    const stale = await request(app)
      .get(`/api/workspaces/${workspaceId}/stale-items?days=3`)
      .set(auth(organizer))
      .expect(200);
    const item = (stale.body.data.items as { itemId: string; reminderLevel: number }[]).find(
      (i) => i.itemId === itemAssigned,
    )!;
    expect(item.reminderLevel).toBe(3);
  });

  it('条目被处理后，提醒级别归零重计', async () => {
    // 外婆补充了转写 —— 条目有动静（updatedAt 前移），之前的 3 级提醒作废
    await request(app)
      .patch(`/api/vague-items/${itemAssigned}`)
      .set(auth(elder))
      .send({ transcript: '外婆又补充了一句：看颜色就行' })
      .expect(200);
    // 时间线摆成"提醒(8 天前) → 处理(6 天前)"：处理之后的条目重新滞留，但提醒已是老黄历
    await backdateReminders(itemAssigned, 8);
    await backdate(itemAssigned, 6);

    const stale = await request(app)
      .get(`/api/workspaces/${workspaceId}/stale-items?days=3`)
      .set(auth(organizer))
      .expect(200);
    const item = (stale.body.data.items as { itemId: string; reminderLevel: number }[]).find(
      (i) => i.itemId === itemAssigned,
    )!;
    expect(item.reminderLevel).toBe(0);

    // 再次提醒从 1 级重新开始
    const again = await request(app)
      .post(`/api/vague-items/${itemAssigned}/remind`)
      .set(auth(organizer))
      .expect(200);
    expect(again.body.data.level).toBe(1);
  });

  it('已收口的条目不允许再提醒', async () => {
    await request(app)
      .post(`/api/vague-items/${itemFresh}/mark-unresolvable`)
      .set(auth(organizer))
      .send({ note: '外婆说这条真的说不清了' })
      .expect(200);
    const response = await request(app)
      .post(`/api/vague-items/${itemFresh}/remind`)
      .set(auth(organizer))
      .expect(400);
    expect(response.body.error.message).toContain('不需要再提醒');
  });

  it('提醒本身不算"处理"：提醒过后条目仍然滞留、天数照算', async () => {
    const before = await request(app)
      .get(`/api/workspaces/${workspaceId}/stale-items?days=3`)
      .set(auth(organizer))
      .expect(200);
    const target = (before.body.data.items as { itemId: string; staleDays: number }[]).find(
      (i) => i.itemId === itemUnassigned,
    )!;

    await request(app)
      .post(`/api/vague-items/${itemUnassigned}/remind`)
      .set(auth(organizer))
      .expect(200);

    const after = await request(app)
      .get(`/api/workspaces/${workspaceId}/stale-items?days=3`)
      .set(auth(organizer))
      .expect(200);
    const same = (after.body.data.items as { itemId: string; staleDays: number }[]).find(
      (i) => i.itemId === itemUnassigned,
    )!;
    expect(same.staleDays).toBe(target.staleDays);
  });

  it('权限边界：旁观者不能提醒，非成员看不到统计', async () => {
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${elder.userId}`)
      .set(auth(organizer))
      .send({ role: 'viewer' })
      .expect(200);
    await request(app)
      .post(`/api/vague-items/${itemUnassigned}/remind`)
      .set(auth(elder))
      .expect(403);
    // 恢复，别影响其他用例
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${elder.userId}`)
      .set(auth(organizer))
      .send({ role: 'contributor' })
      .expect(200);

    await request(app).get(`/api/workspaces/${workspaceId}/member-stats`).set(auth(outsider)).expect(403);
    await request(app).get(`/api/workspaces/${workspaceId}/stale-items`).set(auth(outsider)).expect(403);
  });
});
