export interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: DiscordField[];
  timestamp: string;
  footer: { text: string };
  url?: string;
}

export interface NotificationData {
  owner?: string;
  repo?: string;
  repoOwner?: string;
  repoName?: string;
  prNumber: number;
  prTitle: string;
  prUrl?: string;
  prAuthor?: string | null;
  prHeadBranch?: string | null;
  prBaseBranch?: string | null;
  issuesFound?: string[];
  action?: string;
  commenter?: string;
  commentId?: string | number;
}
