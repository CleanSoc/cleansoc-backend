export type PostKind = 'original' | 'reply' | 'repost';
export type MediaKind = 'photo' | 'video' | 'animated_gif';

export interface StoredMedia {
  type: MediaKind;
  url: string | null;
  previewUrl: string | null;
  altText: string | null;
  width: number | null;
  height: number | null;
  durationMs?: number | null;
  /** Used by the demo dataset to render a deterministic local placeholder. */
  gradient?: number;
}

export interface StoredPost {
  id: string;
  accountId: string;
  xPostId: string;
  kind: PostKind;
  text: string;
  lang: string | null;
  source: 'api' | 'archive';
  isQuote: boolean;
  inReplyToId: string | null;
  inReplyToUser: string | null;
  repostOfId: string | null;
  quoteOfId: string | null;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  quoteCount: number;
  impressionCount: number;
  engagement: number;
  hasMedia: boolean;
  mediaCount: number;
  mediaTypes: string;
  media: StoredMedia[];
  urls: string[];
  authorUsername: string | null;
  authorName: string | null;
  isPinned: boolean;
  isDeleted: boolean;
  deletedAt: string | null;
  archiveImportId: string | null;
  createdAt: string;
  createdTs: number;
}

export interface XPublicMetrics {
  retweet_count?: number;
  reply_count?: number;
  like_count?: number;
  quote_count?: number;
  impression_count?: number;
  bookmark_count?: number;
}

export interface XPost {
  id: string;
  text?: string;
  created_at?: string;
  author_id?: string;
  conversation_id?: string;
  lang?: string;
  public_metrics?: XPublicMetrics;
  attachments?: { media_keys?: string[]; poll_ids?: string[] };
  referenced_tweets?: Array<{ type: 'retweeted' | 'quoted' | 'replied_to'; id: string }>;
  in_reply_to_user_id?: string;
  entities?: {
    urls?: Array<{ expanded_url?: string; url?: string; display_url?: string }>;
    hashtags?: Array<{ tag: string }>;
    mentions?: Array<{ username: string }>;
  };
  possibly_sensitive?: boolean;
}

export interface XMedia {
  media_key: string;
  type: MediaKind;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  variants?: Array<{ bit_rate?: number; content_type?: string; url: string }>;
}

export interface XUser {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
}

export interface XIncludes {
  media?: XMedia[];
  users?: XUser[];
  tweets?: XPost[];
}

export type CategoryFilter = 'all' | 'posts' | 'replies' | 'reposts' | 'media' | 'quotes';
export type SortOption = 'newest' | 'oldest' | 'engagement' | 'engagement_asc';

export interface ActivityFilters {
  category: CategoryFilter;
  q: string;
  from: string | null;
  to: string | null;
  mediaType: 'any' | 'photo' | 'video' | 'animated_gif';
  minLikes: number | null;
  maxLikes: number | null;
  minEngagement: number | null;
  maxEngagement: number | null;
  source: 'any' | 'api' | 'archive';
  sort: SortOption;
  page: number;
  pageSize: number;
  includeDeleted: boolean;
}

export interface SessionUser {
  id: string;
  createdAt: string;
}

export interface AccountDTO {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isDemo: boolean;
  connectedAt: string;
  lastSyncedAt: string | null;
  lastSyncStatus: string;
  lastSyncError: string | null;
  lastSyncCount: number;
  hasWriteScope: boolean;
  scopes: string[];
  tokenExpiresAt: string | null;
  totalPosts: number;
  deletedPosts: number;
}

