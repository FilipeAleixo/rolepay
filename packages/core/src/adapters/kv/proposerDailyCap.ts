import type { RawCriteriaProposal, RawMessageProposal } from '../../domain/proposal/raw.js'
import { err } from '../../domain/result.js'
import type { Clock } from '../../ports/clock.js'
import type { KeyValueStore } from '../../ports/keyValueStore.js'
import type { CriteriaProposalRequest, MessageProposalRequest, ProposerFailure, Proposed, RunProposer } from '../../ports/runProposer.js'

/** A day's slots outlive the day, then the recovery sweep removes them. */
const SLOT_TTL_SECONDS = 2 * 86_400

/**
 * A RunProposer that lets at most `cap` model calls through per UTC day, across every community on
 * this server, so a public server cannot run up the API bill (ROLEPAY_AI_DAILY_CAP). Each call takes
 * a numbered slot for the day with the store's atomic create-if-absent: the count survives a restart,
 * and two calls at once never take the same slot. Past the cap it answers `could_not_propose`
 * (`daily_cap`) without calling the model. Calls the model failed count too: they are billed.
 */
export class DailyCappedProposer implements RunProposer {
  /** Where to start looking for a free slot today; only saves store calls, the slots decide. */
  private hint = { day: '', next: 0 }

  constructor(
    private readonly inner: RunProposer,
    private readonly opts: { cap: number; kv: KeyValueStore; clock: Clock },
  ) {}

  get model() {
    return this.inner.model
  }

  async fromMessages(request: MessageProposalRequest): Promise<Proposed<RawMessageProposal>> {
    return (await this.takeSlot()) ? this.inner.fromMessages(request) : this.capped()
  }

  async fromCriteria(request: CriteriaProposalRequest): Promise<Proposed<RawCriteriaProposal>> {
    return (await this.takeSlot()) ? this.inner.fromCriteria(request) : this.capped()
  }

  private async takeSlot(): Promise<boolean> {
    const day = this.opts.clock.now().toISOString().slice(0, 10)
    if (this.hint.day !== day) this.hint = { day, next: 0 }
    for (let n = this.hint.next; n < this.opts.cap; n++) {
      if (await this.opts.kv.create(`ai-daily-cap:${day}:${n}`, true, { ttl: SLOT_TTL_SECONDS })) {
        if (this.hint.day === day) this.hint.next = Math.max(this.hint.next, n + 1)
        return true
      }
    }
    if (this.hint.day === day) this.hint.next = this.opts.cap
    return false
  }

  private capped() {
    return err<ProposerFailure>({ code: 'could_not_propose', reason: 'daily_cap', detail: `daily cap of ${this.opts.cap} model calls reached`, usage: null })
  }
}
