import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { TerminalRunFactsRegister } from '../../../terminal-run-facts'

/** SwapLabs fork (#69): the PTY lane's pointer delivery, reading the keys clients typed into it. */
export function typingAwarePointerDelivery<TWaiter extends OrchestrationMessageWaiter>(
  runtime: { readonly terminalRunFacts: TerminalRunFactsRegister },
  deps: Omit<PointerDeliveryDependencies<TWaiter>, 'readTypedInputSerial'>
): OrchestrationMailboxPointerDelivery<TWaiter> {
  return new OrchestrationMailboxPointerDelivery({
    ...deps,
    readTypedInputSerial: (ptyId) => runtime.terminalRunFacts.readTypedInput(ptyId)?.serial ?? null
  })
}
