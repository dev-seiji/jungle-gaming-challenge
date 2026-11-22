// Entrada fora do contrato (formato do valor, moeda, campo obrigatório). Vira HTTP 400.
export class InvalidInputError extends Error {
  override name = 'InvalidInputError';
}

// Operação entre moedas diferentes. Vira rejeição CURRENCY_MISMATCH.
export class CurrencyMismatchError extends Error {
  override name = 'CurrencyMismatchError';
}

// Débito deixaria o saldo negativo. O caso de uso decide o failureCode:
// INSUFFICIENT_FUNDS (aposta) ou REVERSAL_WOULD_OVERDRAW (reversão).
export class InsufficientBalanceError extends Error {
  override name = 'InsufficientBalanceError';
}

// Tentativa de mudar algo que já está em estado terminal: é bug no código, não regra de negócio.
export class InvalidTransactionStateError extends Error {
  override name = 'InvalidTransactionStateError';
}
