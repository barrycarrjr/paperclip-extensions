/**
 * The suggested reply for a review, and the line that says who is posting.
 *
 * Both are pure: no config read, no database, no params object. The page
 * shows the suggestion as a starting point ("Start from the suggested
 * reply"); it is never posted without a person or an agent choosing it.
 *
 * Two things this fixes from the version that lived in worker.ts:
 *
 * - It takes the star rating as the number the reviews table stores (1..5).
 *   The old function expected Google's 'ONE'..'FIVE' strings, so a stored
 *   row, whose rating is an integer, would have mapped to 0 and every review
 *   from the table would have received the low-rating apology.
 * - The low-rating template no longer splices the first 60 characters of the
 *   customer's complaint into the reply. Quoting the complaint back, cut off
 *   mid-word, read badly, and it put the customer's own words into a public
 *   post they did not write. It also carried an em-dash, which is now a comma.
 */

export interface PostsAsLocation {
  displayName: string;
}

export interface PostsAsAccount {
  key: string;
  displayName?: string;
  userEmail?: string;
}

export function buildDraftReply(
  businessName: string,
  reviewerName: string,
  starRating: number,
  reviewText?: string | undefined,
): string {
  // reviewText is accepted so callers keep one signature, but it is not
  // quoted back; see the note at the top of the file.
  void reviewText;
  const n = Number.isFinite(starRating) ? Math.round(starRating) : 0;
  if (n >= 4) {
    return `Thank you so much for the kind words, ${reviewerName}! We're thrilled you had a great experience at ${businessName}. We look forward to serving you again!`;
  }
  if (n === 3) {
    return `Thank you for your feedback, ${reviewerName}. We're glad you chose ${businessName} and appreciate you sharing your thoughts. We're always working to improve, and your input helps us do that. We'd love the chance to exceed your expectations next time.`;
  }
  // Low rating, or one we could not read: the careful template. Getting the
  // rating wrong in this direction is an apology to a happy customer, which
  // is odd but harmless; the other direction thanks an unhappy one.
  return `Thank you for letting us know about your experience, ${reviewerName}. We take all feedback seriously, and we'd like to make this right. Please reach out to us directly so we can address your concerns. We value your business and hope to restore your confidence in ${businessName}.`;
}

/**
 * The account label shown to a person: the Google address when the settings
 * carry it, else the account's display name, else its key. Never blank, so
 * the sentence above the reply box always names something real.
 */
export function accountLabel(account: PostsAsAccount): string {
  return account.userEmail?.trim() || account.displayName?.trim() || account.key;
}

/**
 * The one line above the reply box saying where the reply will go. It is
 * computed here from the plugin's settings and is not editable on the page:
 * the page can only choose a review, never a location or an account.
 */
export function postsAs(location: PostsAsLocation, account: PostsAsAccount): string {
  return `Posts as: ${location.displayName}, using the Google account ${accountLabel(account)}`;
}
