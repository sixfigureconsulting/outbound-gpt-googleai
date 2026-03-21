export type Platform = 'linkedin' | 'facebook' | 'instagram';

export interface Lead {
  name: string;
  profileUrl: string;
  headline?: string;      // LinkedIn job title / bio
  location?: string;
  followerCount?: string;
  connectionDegree?: string; // LinkedIn 1st / 2nd / 3rd
  engagementType: 'commenter' | 'reactor' | 'post_author';
  commentText?: string;
  platform: Platform;
  scrapedAt: string;      // ISO timestamp
  sourcePostUrl: string;
}

export interface ScrapeResult {
  platform: Platform;
  postUrl: string;
  postAuthor?: Lead;
  leads: Lead[];
  scrapedAt: string;
  errors: string[];
}

export interface ScraperConfig {
  headless: boolean;
  maxLeads: number;
  credentials: PlatformCredentials;
}

export interface PlatformCredentials {
  linkedin?: { email: string; password: string };
  facebook?: { email: string; password: string };
  instagram?: { username: string; password: string };
}
