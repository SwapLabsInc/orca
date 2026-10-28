/** A read failure whose message is safe to show: a short reason with no key, path or payload. */
export class TeamClaudeLeaderboardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamClaudeLeaderboardError'
  }
}
