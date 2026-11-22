import { InvalidInputError } from '../domain/errors';
import { type EventContext, WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { payloadHash } from '../domain/payload-hash';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import type { WagerStore } from './wager-store';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class CreateWallet {
  constructor(private readonly store: WagerStore) {}

  async execute(command: CreateWalletCommand, ctx: { correlationId: string }): Promise<WalletView> {
    if (typeof command?.playerId !== 'string' || command.playerId.trim() === '') {
      throw new InvalidInputError('playerId is required');
    }
    const initialBalance = Money.from(command.initialBalance);
    const at = new Date();
    const walletId = Bun.randomUUIDv7();

    // Saldo inicial > 0 nasce de uma transação OPENING com lançamento CREDIT: toda alteração de saldo tem ledger.
    const opening = initialBalance.isPositive()
      ? WagerTransaction.opening({
          walletId,
          playerId: command.playerId,
          money: initialBalance,
          payloadHash: payloadHash({ playerId: command.playerId, initialBalance: initialBalance.toJSON() }),
          createdAt: at,
        })
      : undefined;
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      openingTransactionId: opening?.id,
      at,
    });

    // Wallet + OPENING + ledger + eventos: tudo na mesma transação SQL.
    return this.store.transaction(async (uow) => {
      await uow.addWallet(wallet);
      if (opening && openingEntry) {
        opening.markProcessed(undefined, at);
        await uow.addTransaction(opening, wallet.balance);
        uow.addLedgerEntry(openingEntry);
        const eventCtx: EventContext = { correlationId: ctx.correlationId, occurredAt: at };
        uow.addOutbox(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, wallet, eventCtx)));
        uow.addOutbox(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, eventCtx)));
      }
      return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
    });
  }
}
