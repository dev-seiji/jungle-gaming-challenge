// Códigos estáveis e legíveis por máquina: o provedor decide por eles se reenvia, corrige ou desiste.
// Todos são rejeições de negócio (terminais): reenviar o mesmo payload dá o mesmo resultado.
export enum FailureCode {
  /** walletId não existe. Gravada como REJECTED: reenvio com a mesma key devolve a mesma rejeição. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** A wallet existe mas é de outro jogador: bug ou fraude no provedor. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** BET maior que o saldo. Provedor pode tentar outra aposta menor. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK de WIN/REFUND deixaria o saldo negativo (o jogador já gastou o crédito). */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Referência não apareceu dentro do limite de tentativas. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência existe mas não foi aplicada (REJECTED/FAILED). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** REFUND que não aponta para BET, ou ROLLBACK que não aponta para BET/WIN/REFUND. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** Referência de outro provider, player, wallet ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Moeda da operação diferente da moeda da wallet ou da referência. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** Valor do REFUND/ROLLBACK diferente do valor da referência (reversão parcial fora de escopo). */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** A referência já foi revertida por esse mesmo tipo de operação. */
  AlreadyReversed = 'ALREADY_REVERSED',
}
