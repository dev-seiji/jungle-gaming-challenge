import type { EventContext } from '../domain/events';
import { FailureCode } from '../domain/failure-code';
import { decideAndApply, reject, result } from './process-wager-transaction';
import type { WagerStore } from './wager-store';

/**
 * Reprocessa transações PENDING_REFERENCE (REFUND/ROLLBACK que chegaram antes da referência).
 * Usa as MESMAS regras da entrada (decideAndApply); só muda o que fazer se a referência ainda faltar:
 * agenda nova tentativa com backoff ou, esgotado o limite, rejeita com REFERENCE_NOT_FOUND + evento.
 */
export class ResolvePendingReference {
  constructor(private readonly store: WagerStore) {}

  /** Processa UMA pendente vencida. Devolve false se não havia nenhuma. */
  async runOnce(now = new Date()): Promise<boolean> {
    return this.store.transaction(async (uow) => {
      // 1) Pega a pendente com SKIP LOCKED (outro worker não pega a mesma).
      const tx = await uow.claimDuePendingReference(now);
      if (!tx) return false;
      // 2) Trava a wallet: daqui em diante é o mesmo caminho serializado da entrada.
      const wallet = await uow.lockWallet(tx.walletId);
      const eventCtx: EventContext = { correlationId: tx.id, causationId: tx.id, occurredAt: now };
      const persist = async (t: typeof tx, balance?: Parameters<typeof uow.updateTransaction>[1]) =>
        uow.updateTransaction(t, balance);

      await decideAndApply(uow, tx, wallet, eventCtx, persist, async (w) => {
        if (tx.registerFailedReferenceAttempt(now) === 'exhausted') {
          return reject(uow, tx, FailureCode.ReferenceNotFound, w, eventCtx, persist);
        }
        uow.updateTransaction(tx, w.balance); // só agenda a próxima tentativa
        return result(tx, w.balance);
      });
      return true;
    });
  }
}
