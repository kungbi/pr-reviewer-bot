import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import { OrganizationReviewWiki } from '../types';

const REVIEW_WIKI_RELATIVE_DIRECTORY = path.join('docs', 'review-wiki');
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export interface LoadOrganizationReviewWikiInput {
  owner: string;
  wikiDirectory?: string;
}

/** Resolves the repository's versioned wiki directory in src and dist layouts. */
export function resolveOrganizationReviewWikiDirectory(moduleDir = __dirname): string {
  const candidates = [
    path.join(moduleDir, '../../../', REVIEW_WIKI_RELATIVE_DIRECTORY),
    path.join(moduleDir, '../../', REVIEW_WIKI_RELATIVE_DIRECTORY),
    path.join(process.cwd(), REVIEW_WIKI_RELATIVE_DIRECTORY),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export const DEFAULT_ORGANIZATION_REVIEW_WIKI_DIRECTORY = resolveOrganizationReviewWikiDirectory();

function parseOrganizationReviewWiki(filePath: string, owner: string): OrganizationReviewWiki | undefined {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    logger.warn(`[review-wiki] Ignoring page without required frontmatter: ${filePath}`);
    return undefined;
  }

  const declaredOwner = match[1].match(/^owner:\s*([^\r\n]+)\s*$/m)?.[1]?.trim();
  const content = match[2].trim();
  if (!declaredOwner || declaredOwner.toLowerCase() !== owner.toLowerCase() || !content) {
    logger.warn(`[review-wiki] Ignoring invalid or owner-mismatched page: ${filePath}`);
    return undefined;
  }

  return { owner, sourcePath: filePath, content };
}

/**
 * Loads the human-maintained, GitHub-versioned wiki page for one organization.
 * Runtime review-thread memory is intentionally separate and never writes here.
 */
export function loadOrganizationReviewWiki({
  owner,
  wikiDirectory = process.env.REVIEW_WIKI_DIRECTORY || DEFAULT_ORGANIZATION_REVIEW_WIKI_DIRECTORY,
}: LoadOrganizationReviewWikiInput): OrganizationReviewWiki | undefined {
  if (!GITHUB_OWNER_PATTERN.test(owner)) {
    logger.warn(`[review-wiki] Ignoring invalid GitHub organization owner: ${owner}`);
    return undefined;
  }

  const filePath = path.join(wikiDirectory, `${owner}.md`);
  if (!fs.existsSync(filePath)) return undefined;

  try {
    return parseOrganizationReviewWiki(filePath, owner);
  } catch (err) {
    logger.warn(`[review-wiki] Failed to load organization page ${filePath}: ${(err as Error).message}`);
    return undefined;
  }
}
