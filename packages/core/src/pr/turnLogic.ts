import { participantsRepo } from "../db/repositories.js";

/**
 * Turn tracking is advisory/UI-only ("waiting on X" badge) and never
 * enforced by the API. The workflow allows either party to push to a
 * rejected branch next, and with more than two participants "whose turn"
 * is genuinely ambiguous — so this never blocks a push or an approval,
 * it only informs a badge in the UI.
 */
export function nextTurnAfterPush(repoId: string, pusherEmail: string | null): string | null {
  return participantsRepo.otherParty(repoId, pusherEmail);
}
