export interface AccountConfig {
  key: string;
  displayName?: string;
  userEmail?: string;
  clientIdRef: string;
  clientSecretRef: string;
  refreshTokenRef: string;
  allowedCompanies?: string[];
}

export interface LocationConfig {
  key: string;
  displayName: string;
  googleAccountId: string;
  locationId: string;
  accountKey: string;
  targetCompanyId: string;
  targetProjectId?: string;
}

export interface InstanceConfig {
  accounts?: AccountConfig[];
  locations?: LocationConfig[];
  allowReplies?: boolean;
  gmailAccountKey?: string;
}

export const STAR_NUMBERS: Record<string, number> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
};

export interface GbpReview {
  name: string;
  reviewId: string;
  reviewer: { displayName: string; isAnonymous: boolean };
  starRating: string;
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: { comment: string; updateTime: string };
}

export interface GbpListReviewsResponse {
  reviews?: GbpReview[];
  averageRating?: number;
  totalReviewCount?: number;
  nextPageToken?: string;
}
