/**
 * 全局状态枚举全集。
 *
 * 说明：SQLite 不支持数据库级 enum，因此所有枚举在数据库中以 TEXT 存储，
 * 由本文件的 const 数组 + Zod schema 在应用层做唯一真相约束。
 * 该文件同时被服务端与前端引用，保证两侧取值集合永不漂移。
 */

export const WORKSPACE_ROLES = ['owner', 'editor', 'contributor', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const RECIPE_STATUSES = ['active', 'archived'] as const;
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];

/** 草稿 -> 评审中 -> 已发布 -> 已归档；复做失败可回到待澄清（条目级） */
export const VERSION_STATUSES = ['draft', 'in_review', 'published', 'archived'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/** 模糊描述的分类：火候 / 手感 / 用量 / 时间 / 其他 */
export const VAGUE_CATEGORIES = ['heat', 'feel', 'amount', 'time', 'other'] as const;
export type VagueCategory = (typeof VAGUE_CATEGORIES)[number];

/**
 * 待澄清条目的生命周期。
 * 终态只有两个：verified（已验证）、unresolvable（口语留白）。
 */
export const VAGUE_STATUSES = [
  'open',
  'asked',
  'answered',
  'resolved',
  'verified',
  'unresolvable',
] as const;
export type VagueStatus = (typeof VAGUE_STATUSES)[number];

export const TERMINAL_VAGUE_STATUSES: readonly VagueStatus[] = ['verified', 'unresolvable'];

export const CONFIDENCE_LEVELS = ['confirmed', 'estimated', 'assumed'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const AUDIO_KINDS = [
  'recipe_voice',
  'answer_voice',
  'verification_voice',
  'note_voice',
] as const;
export type AudioKind = (typeof AUDIO_KINDS)[number];

export const TRANSCRIPT_STATUSES = ['none', 'pending', 'done', 'failed'] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

export const VERIFICATION_RESULTS = ['success', 'partial', 'fail'] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const NOTIFICATION_TYPES = [
  'mentioned',
  'assigned',
  'answered',
  'published',
  'verification_requested',
  'verification_passed',
  'verification_failed',
  'reminder',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * 滞留条目的逐级提醒级别：
 * 1 级提醒负责人本人；2 级追加空间里的整理者；3 级知会全部家庭成员。
 */
export const REMINDER_LEVELS = [1, 2, 3] as const;
export type ReminderLevel = (typeof REMINDER_LEVELS)[number];
export const MAX_REMINDER_LEVEL: ReminderLevel = 3;

export const COMMENT_TARGET_TYPES = [
  'recipe',
  'version',
  'step',
  'vague_item',
  'verification',
] as const;
export type CommentTargetType = (typeof COMMENT_TARGET_TYPES)[number];

export const HEAT_LEVELS = ['low', 'medium_low', 'medium', 'medium_high', 'high'] as const;
export type HeatLevel = (typeof HEAT_LEVELS)[number];

/** 音频上传白名单 */
export const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/x-m4a',
] as const;

export const ERROR_CODES = {
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_TOKEN_INVALID: 401,
  AUTH_MISSING_TOKEN: 401,
  AUTH_EMAIL_TAKEN: 409,
  AUTH_FORBIDDEN: 403,
  WORKSPACE_NOT_MEMBER: 403,
  WORKSPACE_INVALID_INVITE: 404,
  RESOURCE_NOT_FOUND: 404,
  EDIT_CONFLICT: 409,
  VERSION_NOT_EDITABLE: 409,
  VERSION_DUPLICATE_DRAFT: 409,
  VERSION_INVALID_TRANSITION: 409,
  SPEC_INCOMPLETE: 422,
  SPEC_ASSUMED_UNCONFIRMED: 422,
  CHANGE_NOTE_REQUIRED: 422,
  DEVIATION_REQUIRED: 422,
  VAGUE_INVALID_TRANSITION: 409,
  AUDIO_NOT_FOUND: 404,
  UPLOAD_TYPE_NOT_ALLOWED: 415,
  UPLOAD_TOO_LARGE: 413,
  ASR_UNAVAILABLE: 503,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** 中文文案，前端可直接展示 */
export const VAGUE_CATEGORY_LABELS: Record<VagueCategory, string> = {
  heat: '火候',
  feel: '手感',
  amount: '用量',
  time: '时间',
  other: '其他',
};

export const VAGUE_STATUS_LABELS: Record<VagueStatus, string> = {
  open: '待澄清',
  asked: '追问中',
  answered: '已答复',
  resolved: '已规格化',
  verified: '已验证',
  unresolvable: '口语留白',
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  confirmed: '已确认',
  estimated: '推算',
  assumed: '暂定',
};

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: '所有者',
  editor: '整理者',
  contributor: '贡献者',
  viewer: '旁观者',
};

export const VERSION_STATUS_LABELS: Record<VersionStatus, string> = {
  draft: '草稿',
  in_review: '评审中',
  published: '已发布',
  archived: '已归档',
};

export const HEAT_LEVEL_LABELS: Record<HeatLevel, string> = {
  low: '小火',
  medium_low: '中小火',
  medium: '中火',
  medium_high: '中大火',
  high: '大火',
};

export const REMINDER_LEVEL_LABELS: Record<ReminderLevel, string> = {
  1: '提醒负责人',
  2: '请整理者协助',
  3: '全家知悉',
};

/** 滞留条目负责人的来源：被指派的人 → 食谱创建者 → 空间所有者 */
export const RESPONSIBLE_SOURCES = ['assignee', 'recipe_creator', 'workspace_owner'] as const;
export type ResponsibleSource = (typeof RESPONSIBLE_SOURCES)[number];

export const RESPONSIBLE_SOURCE_LABELS: Record<ResponsibleSource, string> = {
  assignee: '被指派人',
  recipe_creator: '食谱创建者',
  workspace_owner: '空间所有者',
};

/** 成员贡献统计的口径：key 与 ActivityLog 的 action 对应（见服务端 stats 模块） */
export const CONTRIBUTION_KINDS = [
  'recordings',
  'clips',
  'itemsCreated',
  'questionsAsked',
  'answersGiven',
  'specsResolved',
  'verifications',
  'comments',
  'publishes',
] as const;
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

export const CONTRIBUTION_KIND_LABELS: Record<ContributionKind, string> = {
  recordings: '上传语音',
  clips: '框选片段',
  itemsCreated: '提出待澄清',
  questionsAsked: '发起追问',
  answersGiven: '回答追问',
  specsResolved: '归纳规格',
  verifications: '复做验证',
  comments: '评论',
  publishes: '发布版本',
};
