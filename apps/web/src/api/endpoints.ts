import type {
  ActivityLogDto,
  AudioAttachmentDto,
  AudioClipDto,
  AuthTokens,
  CommentDto,
  CommentTargetType,
  CreateCommentInput,
  CreateIngredientInput,
  CreateRecipeInput,
  CreateStepInput,
  CreateVagueItemInput,
  CreateVerificationInput,
  IngredientDto,
  KitchenReferenceDto,
  MemberStatsDto,
  NotificationDto,
  NudgeResultDto,
  RecipeCounters,
  RecipeDto,
  RecipeVersionDto,
  ResolvedSpec,
  StepDto,
  UserDto,
  VagueCategory,
  VagueItemDto,
  VagueStatus,
  VerificationRunDto,
  VersionDiffDto,
  WorkspaceDto,
  WorkspaceMemberDto,
  WorkspaceRole,
} from '@froa/shared';
import { api, tokenStore } from './client';

const unwrap = <T>(promise: Promise<{ data: { data: T } }>) => promise.then((r) => r.data.data);

/* ---------------- 鉴权 ---------------- */

export const authApi = {
  register: (input: { email: string; password: string; displayName: string }) =>
    unwrap<{ user: UserDto; tokens: AuthTokens }>(api.post('/auth/register', input)),
  login: (input: { email: string; password: string }) =>
    unwrap<{ user: UserDto; tokens: AuthTokens }>(api.post('/auth/login', input)),
  me: () => unwrap<UserDto>(api.get('/auth/me')),
  updateMe: (input: { displayName?: string; avatarUrl?: string | null }) =>
    unwrap<UserDto>(api.patch('/auth/me', input)),
};

/* ---------------- 家庭空间 ---------------- */

export const workspaceApi = {
  list: () => unwrap<WorkspaceDto[]>(api.get('/workspaces')),
  create: (name: string) => unwrap<WorkspaceDto>(api.post('/workspaces', { name })),
  join: (inviteCode: string) => unwrap<WorkspaceDto>(api.post('/workspaces/join', { inviteCode })),
  get: (workspaceId: string) => unwrap<WorkspaceDto>(api.get(`/workspaces/${workspaceId}`)),
  rotateInvite: (workspaceId: string) =>
    unwrap<{ inviteCode: string }>(api.post(`/workspaces/${workspaceId}/invite`)),
  members: (workspaceId: string) =>
    unwrap<WorkspaceMemberDto[]>(api.get(`/workspaces/${workspaceId}/members`)),
  updateRole: (workspaceId: string, userId: string, role: WorkspaceRole) =>
    unwrap<WorkspaceMemberDto>(api.patch(`/workspaces/${workspaceId}/members/${userId}`, { role })),
  removeMember: (workspaceId: string, userId: string) =>
    unwrap<{ removed: string }>(api.delete(`/workspaces/${workspaceId}/members/${userId}`)),
  references: (workspaceId: string) =>
    unwrap<KitchenReferenceDto[]>(api.get(`/workspaces/${workspaceId}/references`)),
  addReference: (
    workspaceId: string,
    input: { label: string; amountValue: number; amountUnit: string; note?: string | null },
  ) => unwrap<KitchenReferenceDto>(api.post(`/workspaces/${workspaceId}/references`, input)),
  removeReference: (workspaceId: string, referenceId: string) =>
    unwrap<{ removed: string }>(api.delete(`/workspaces/${workspaceId}/references/${referenceId}`)),
  activity: (workspaceId: string) =>
    api
      .get<{ data: ActivityLogDto[] }>(`/workspaces/${workspaceId}/activity`)
      .then((r) => r.data.data),
};

/* ---------------- 食谱 ---------------- */

export const recipeApi = {
  list: (workspaceId: string, params?: { status?: string; q?: string }) =>
    unwrap<RecipeDto[]>(api.get('/recipes', { params: { workspaceId, ...params } })),
  create: (input: CreateRecipeInput) => unwrap<RecipeDto>(api.post('/recipes', input)),
  get: (recipeId: string) =>
    unwrap<
      RecipeDto & {
        counters: RecipeCounters;
        myRole: WorkspaceRole;
        versions: { id: string; versionNo: number; status: string; title: string; publishedAt: string | null }[];
      }
    >(api.get(`/recipes/${recipeId}`)),
  update: (recipeId: string, input: Partial<CreateRecipeInput>) =>
    unwrap<RecipeDto>(api.patch(`/recipes/${recipeId}`, input)),
  archive: (recipeId: string) => unwrap<RecipeDto>(api.post(`/recipes/${recipeId}/archive`)),
};

/* ---------------- 版本 ---------------- */

export const versionApi = {
  list: (recipeId: string) =>
    unwrap<
      (RecipeVersionDto & { counts: { steps: number; ingredients: number; verifications: number } })[]
    >(api.get(`/recipes/${recipeId}/versions`)),
  fork: (recipeId: string, input: { fromVersionId?: string; title?: string; summary?: string | null }) =>
    unwrap<RecipeVersionDto>(api.post(`/recipes/${recipeId}/versions`, input)),
  get: (versionId: string) =>
    unwrap<RecipeVersionDto & { creator: { id: string; displayName: string; avatarUrl: string | null } | null }>(
      api.get(`/versions/${versionId}`),
    ),
  update: (
    versionId: string,
    input: { title?: string; summary?: string | null; expectedUpdatedAt?: string },
  ) =>
    unwrap<RecipeVersionDto>(api.patch(`/versions/${versionId}`, input)),
  submit: (versionId: string) => unwrap<RecipeVersionDto>(api.post(`/versions/${versionId}/submit`)),
  reopen: (versionId: string) => unwrap<RecipeVersionDto>(api.post(`/versions/${versionId}/reopen`)),
  publish: (versionId: string, input: { changeNote: string; force?: boolean }) =>
    unwrap<RecipeVersionDto>(api.post(`/versions/${versionId}/publish`, input)),
  diff: (versionId: string, against?: string) =>
    unwrap<VersionDiffDto>(api.get(`/versions/${versionId}/diff`, { params: { against } })),
  /**
   * 导出走的是浏览器的 <a href> 直接下载，没法带 Authorization 头，
   * 所以必须像音频流一样把令牌放进查询参数（服务端两种方式都支持）。
   */
  exportUrl: (versionId: string, format: 'md' | 'json' = 'md') => {
    const token = tokenStore.access;
    const query = `format=${format}${token ? `&access_token=${encodeURIComponent(token)}` : ''}`;
    return `/api/versions/${versionId}/export?${query}`;
  },
  steps: (versionId: string) => unwrap<StepDto[]>(api.get(`/versions/${versionId}/steps`)),
  createStep: (versionId: string, input: CreateStepInput) =>
    unwrap<StepDto>(api.post(`/versions/${versionId}/steps`, input)),
  reorderSteps: (versionId: string, orderedIds: string[]) =>
    unwrap<StepDto[]>(api.post(`/versions/${versionId}/steps/reorder`, { orderedIds })),
  updateStep: (stepId: string, input: Partial<CreateStepInput> & { expectedUpdatedAt?: string }) =>
    unwrap<StepDto>(api.patch(`/steps/${stepId}`, input)),
  deleteStep: (stepId: string) => unwrap<{ removed: string }>(api.delete(`/steps/${stepId}`)),
  ingredients: (versionId: string) =>
    unwrap<IngredientDto[]>(api.get(`/versions/${versionId}/ingredients`)),
  createIngredient: (versionId: string, input: CreateIngredientInput) =>
    unwrap<IngredientDto>(api.post(`/versions/${versionId}/ingredients`, input)),
  updateIngredient: (
    ingredientId: string,
    input: Partial<CreateIngredientInput> & { expectedUpdatedAt?: string },
  ) =>
    unwrap<IngredientDto>(api.patch(`/ingredients/${ingredientId}`, input)),
  deleteIngredient: (ingredientId: string) =>
    unwrap<{ removed: string }>(api.delete(`/ingredients/${ingredientId}`)),
};

/* ---------------- 音频 ---------------- */

export const audioApi = {
  list: (params: { recipeId?: string; kind?: string; transcriptStatus?: string }) =>
    unwrap<AudioAttachmentDto[]>(api.get('/audio', { params })),
  get: (audioId: string) => unwrap<AudioAttachmentDto>(api.get(`/audio/${audioId}`)),
  upload: (input: {
    file: Blob;
    filename: string;
    recipeId: string;
    kind: string;
    durationMs: number;
    peaks: number[] | null;
  }) => {
    const form = new FormData();
    form.append('file', input.file, input.filename);
    form.append('recipeId', input.recipeId);
    form.append('kind', input.kind);
    form.append('durationMs', String(Math.round(input.durationMs)));
    if (input.peaks?.length) form.append('peaks', JSON.stringify(input.peaks));
    return unwrap<AudioAttachmentDto>(
      api.post('/audio', form, { headers: { 'Content-Type': 'multipart/form-data' } }),
    );
  },
  transcribe: (audioId: string) =>
    unwrap<{
      audio: AudioAttachmentDto;
      provider: string;
      segments: { startMs: number; endMs: number; text: string }[];
      needsManualInput: boolean;
      hint?: string;
    }>(api.post(`/audio/${audioId}/transcribe`)),
  updateTranscript: (audioId: string, transcript: string, transcriptStatus?: string) =>
    unwrap<AudioAttachmentDto>(api.patch(`/audio/${audioId}/transcript`, { transcript, transcriptStatus })),
  createClip: (audioId: string, input: { startMs: number; endMs: number; label?: string | null }) =>
    unwrap<AudioClipDto>(api.post(`/audio/${audioId}/clips`, input)),
  remove: (audioId: string) => unwrap<{ removed: string }>(api.delete(`/audio/${audioId}`)),
  /** <audio> 标签无法自定义请求头，因此通过查询参数携带令牌 */
  streamUrl: (audioId: string, accessToken: string | null) =>
    `/api/audio/${audioId}/stream${accessToken ? `?access_token=${encodeURIComponent(accessToken)}` : ''}`,
};

/* ---------------- 待澄清条目 ---------------- */

export const vagueItemApi = {
  list: (
    recipeId: string,
    params?: {
      status?: VagueStatus;
      category?: VagueCategory;
      assigneeId?: string;
      search?: string;
      page?: number;
      pageSize?: number;
    },
  ) => unwrap<VagueItemDto[]>(api.get(`/recipes/${recipeId}/vague-items`, { params })),
  summary: (recipeId: string) =>
    unwrap<{ byStatus: Record<string, number>; todo: { toAsk: number; toResolve: number; toVerify: number } }>(
      api.get(`/recipes/${recipeId}/vague-items/summary`),
    ),
  suggest: (recipeId: string, text: string) =>
    unwrap<{
      matches: {
        ruleId: string;
        category: VagueCategory;
        matchedPattern: string;
        suggestion: string;
        question: string;
        defaultConfidence: 'estimated' | 'assumed';
      }[];
      count: number;
    }>(api.get(`/recipes/${recipeId}/vague-items/suggest`, { params: { text } })),
  create: (recipeId: string, input: CreateVagueItemInput) =>
    unwrap<VagueItemDto>(api.post(`/recipes/${recipeId}/vague-items`, input)),
  get: (itemId: string) => unwrap<VagueItemDto>(api.get(`/vague-items/${itemId}`)),
  update: (itemId: string, input: Record<string, unknown>) =>
    unwrap<VagueItemDto>(api.patch(`/vague-items/${itemId}`, input)),
  ask: (itemId: string, input: { question: string; assigneeId?: string | null }) =>
    unwrap<VagueItemDto>(api.post(`/vague-items/${itemId}/ask`, input)),
  answer: (itemId: string, input: { answerText?: string | null; answerClipId?: string | null }) =>
    unwrap<VagueItemDto>(api.post(`/vague-items/${itemId}/answer`, input)),
  resolve: (
    itemId: string,
    input: { resolvedSpec: ResolvedSpec; applyToIngredientId?: string | null; applyToStepId?: string | null },
  ) => unwrap<VagueItemDto>(api.post(`/vague-items/${itemId}/resolve`, input)),
  confirm: (itemId: string, note?: string) =>
    unwrap<VagueItemDto>(api.post(`/vague-items/${itemId}/confirm`, { note })),
  markUnresolvable: (itemId: string, note: string) =>
    unwrap<VagueItemDto>(api.post(`/vague-items/${itemId}/mark-unresolvable`, { note })),
  reopen: (itemId: string, reason: string) =>
    unwrap<VagueItemDto>(api.post(`/vague-items/${itemId}/reopen`, { reason })),
  nudge: (itemId: string) => unwrap<NudgeResultDto>(api.post(`/vague-items/${itemId}/nudge`)),
  history: (itemId: string) => unwrap<ActivityLogDto[]>(api.get(`/vague-items/${itemId}/history`)),
};

/* ---------------- 成员统计 ---------------- */

export const statsApi = {
  memberStats: (workspaceId: string, staleDays?: number) =>
    unwrap<MemberStatsDto>(api.get(`/workspaces/${workspaceId}/member-stats`, { params: { staleDays } })),
};

/* ---------------- 评论 / 验证 / 通知 ---------------- */

export const commentApi = {
  list: (targetType: CommentTargetType, targetId: string) =>
    unwrap<CommentDto[]>(api.get('/comments', { params: { targetType, targetId } })),
  create: (input: CreateCommentInput) => unwrap<CommentDto>(api.post('/comments', input)),
  resolve: (commentId: string) => unwrap<CommentDto>(api.patch(`/comments/${commentId}/resolve`)),
};

export const verificationApi = {
  list: (recipeId: string) =>
    unwrap<VerificationRunDto[]>(api.get(`/recipes/${recipeId}/verifications`)),
  create: (recipeId: string, input: CreateVerificationInput) =>
    unwrap<VerificationRunDto>(api.post(`/recipes/${recipeId}/verifications`, input)),
};

export const notificationApi = {
  list: (params?: { unread?: boolean }) =>
    unwrap<NotificationDto[]>(api.get('/notifications', { params: { unread: params?.unread } })),
  markRead: (input: { ids?: string[]; all?: boolean }) =>
    unwrap<{ updated: number }>(api.post('/notifications/read', input)),
};
